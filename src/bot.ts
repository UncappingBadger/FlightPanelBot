import { dirname, join } from 'node:path';
import { Client, Events, GatewayIntentBits, Partials, Routes } from 'discord.js';
import { AeroDaqClient } from './aerodaq/client.js';
import { MetarClient } from './metar/client.js';
import type { Config } from './config.js';
import { openDatabase } from './db/db.js';
import { Store } from './db/store.js';
import { commandsFingerprint, forgetGuildCommands, registerGuildCommands, type CommandRegistration } from './discord/commandRegistration.js';
import { commands } from './discord/commands/index.js';
import type { BotContext } from './discord/context.js';
import { Notifier } from './discord/notifier.js';
import { MarketService } from './discord/market.js';
import { PanelService } from './discord/panel.js';
import { registerInteractionRouter } from './discord/router.js';
import { DEMO } from './discord/ui.js';
import { loadServiceAccount, tokenProvider } from './google/serviceAccount.js';
import { SheetsApi } from './google/sheetsApi.js';
import { DemoJobSource } from './jobs/demo.js';
import { sourceSelector } from './jobs/sheet.js';
import { FsHubClient } from './fshub/client.js';
import { LiveFeed } from './fshub/liveFeed.js';
import { TwitchBridge } from './twitch/bridge.js';
import { AirportDirectory } from './services/airports.js';
import { DistanceFiller } from './services/distanceFill.js';
import { AutoCompleter } from './services/autoComplete.js';
import { DailyNote } from './services/dailyNote.js';
import { DepartureWarnings } from './services/departureWarnings.js';
import { JobEvents } from './services/events.js';
import { FlightTimes } from './services/flightTime.js';
import { FsHubSync } from './services/fshubSync.js';
import { HardLandings } from './services/hardLanding.js';
import { JobService } from './services/jobs.js';
import { AeroconomyAccountClient } from './aeroconomy/account.js';
import { AeroconomyClient } from './aeroconomy/client.js';
import { AirlineProfits } from './services/airlineProfits.js';
import { AeroNumbers } from './services/aeroNumbers.js';
import { HourlySlot } from './services/hourlySlot.js';
import { FlightEtas } from './services/flightEtas.js';
import { LiveTracker } from './services/liveTracker.js';
import { DEBUG_SHEET_INTERVAL_MS, SourceRefresher } from './services/refresh.js';
import { ReminderService } from './services/reminders.js';
import { Scheduler } from './services/scheduler.js';
import { SheetWriteBack } from './services/writeback.js';
import { DEBUG_BUILD, dbg } from './util/debugBuild.js';
import { LocalSheet, localSheetFetch } from './google/localSheet.js';
import { createLogger, type Logger } from './util/log.js';

/** A Discord server the bot is in. */
export interface ServerInfo {
  id: string;
  name: string;
  /** Whether the bot's slash commands are set up there. */
  commands: CommandRegistration | 'pending';
}

export interface StartOptions {
  log?: Logger;
  /**
   * Give every server the bot is in (and each one it joins later) its slash commands, so nobody has
   * to run a separate script. Off for development, which registers them with `npm run deploy-commands`.
   */
  registerCommands?: boolean;
  /** Called whenever the list of servers, or what we know about them, changes. */
  onServers?: (servers: ServerInfo[]) => void;
  /** How long to wait for Discord to finish connecting after logging in. */
  readyTimeoutMs?: number;
}

export interface BotHandle {
  /** The bot's name as Discord shows it, e.g. `Flight Panel#1234`. */
  readonly userTag: string;
  readonly userId: string;
  servers(): ServerInfo[];
  /** Stop cleanly: no more background work, disconnect from Discord, close the database. */
  stop(): Promise<void>;
}

/**
 * Start the bot and resolve once it is connected to Discord. Rejects, having cleaned up, if the login
 * fails (for example a wrong token). Nothing here touches `process`, so a host app can start and stop it.
 */
export async function startBot(config: Config, opts: StartOptions = {}): Promise<BotHandle> {
  const log = opts.log ?? createLogger(config.logLevel);

  // The diagnostic build keeps its sheets in local files here, and never writes to Google.
  const debugSheets = join(dirname(config.databasePath), 'debug-sheets');
  const store = new Store(openDatabase(config.databasePath));
  if (DEBUG_BUILD) store.enableAudit(log); // every reservation row that appears, changes or goes is logged, with who did it
  const events = new JobEvents(log);
  const jobs = new JobService(store, events, { logger: log });

  // Aeroconomy publishes no job API, so a panel's flights come from the schedule sheet an admin links
  // with `/setup sheet` (re-read every hour), or from admin file imports. Demo mode also has a
  // fictional source for panels with neither.
  // All the hourly checks (the schedule sheets, the FsHub rosters, completing flown flights, and the six-hourly read of Aeroconomy) happen
  // together, at one fixed minute of each hour that is picked for this install the first time it runs, instead of each an hour after its own last run.
  const slot = HourlySlot.forInstall(store);
  log.info(`The hourly checks run together at ${String(slot.minute).padStart(2, '0')} minutes past each hour (UTC)`);
  if (DEBUG_BUILD) dbg(log, `DEBUG BUILD: a linked sheet is read every ${DEBUG_SHEET_INTERVAL_MS / 60_000} minutes (within a minute after that: the scheduler ticks once a minute), not once an hour, so the Distance fill can be watched; the other hourly checks are unchanged`);
  const demoSource = new DemoJobSource();
  // A flight whose row has no flight number can take Aeroconomy's own number for it (read from Aeroconomy's public contracts, no account
  // needed), for a panel that has it switched on (`/setup flight-numbers`) and is linked to its airline's FsHub number. The numbers are
  // read slowly in the background, and applied by the same refresh that reads the sheet.
  const aeroPublic = new AeroconomyClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  const aeroNumbers = new AeroNumbers({
    store,
    client: aeroPublic,
    apply: async (panel) => {
      if (refresher.hasSource(panel)) await refresher.refresh(panel);
    },
    logger: log,
    slot,
  });
  // A schedule sheet with a Distance column gets the distance of each flight filled in as the schedule is read (set up once the sheet
  // write-back and the airport positions exist, below).
  let distances: DistanceFiller | null = null;
  const refresher: SourceRefresher = new SourceRefresher(store, jobs, sourceSelector({ fallback: DEMO ? demoSource : null, ...(DEBUG_BUILD ? { fetchFn: localSheetFetch(debugSheets, fetch, log) } : {}) }), log, Date.now, (panel, list, fetched) => (distances ? distances.enrich(panel, aeroNumbers.enrich(panel, list), fetched) : aeroNumbers.enrich(panel, list)), slot, (panel, fetched) => distances?.run(panel, fetched));
  const panels = new PanelService(store, jobs, log);
  // AeroDAQ's in-game market and fuel prices: public and read-only. It is only asked when someone uses /fuel or a server has a market board.
  const aerodaq = new AeroDaqClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  const market = new MarketService(store, aerodaq, log);
  // VATSIM's public METAR service: only asked when someone sends the bot `metar <airport>` in a DM, and only ever sent the airport code.
  const metar = new MetarClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  // A flight with no pilot a day before it starts is announced in the panel's channel.
  const reminders = new ReminderService(store, jobs, async (panel, due) => (await panels.remind(panel, due)) === 'sent', { logger: log });
  // Optional: with a FsHub token, typed pilot IDs are checked, and a panel linked to its airline's FsHub roster
  // learns who is who by itself. Nothing is asked of FsHub without one.
  const fshub = config.fshubToken ? new FsHubClient({ token: config.fshubToken, logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` }) : null;
  // A pilot FsHub shows landing very hard gets a light-hearted message (they can switch it off). It only needs FsHub's flights, so it rides on that read.
  let notifier: Notifier | null = null;
  const hardLandings = new HardLandings(store, async (discordId, content) => (await notifier?.dm(discordId, content)) === true, { logger: log });
  const fshubSync = fshub ? new FsHubSync(store, fshub, panels, { logger: log, completed: (panelId) => jobs.completed(panelId), onFlights: (panel, flights) => hardLandings.check(panel, flights), slot }) : null;
  // Optional: with a Google service account, pilots' names and completions are written to a linked sheet.
  // Demo mode never writes to a real sheet unless asked to, since its pilots and flights are made up.
  let writeback: SheetWriteBack | null = null;
  if (DEBUG_BUILD) {
    // The diagnostic build has no write access to anything of Google's: its sheet is a local file (see src/google/localSheet.ts).
    writeback = new SheetWriteBack(new LocalSheet(debugSheets, log), 'the local debug sheet', { logger: log });
    log.info(`DEBUG BUILD: nothing is written to Google, and the Google key is not used. The schedule is read from, and written to, a local copy in ${debugSheets}`);
  } else if (config.googleServiceAccountFile) {
    if (DEMO && process.env.AEROBOT_DEMO_WRITEBACK !== '1') {
      log.info('Demo mode: not writing to Google Sheets (set AEROBOT_DEMO_WRITEBACK=1 to allow it, ideally against a copy of the sheet).');
    } else {
      const account = loadServiceAccount(config.googleServiceAccountFile);
      writeback = new SheetWriteBack(new SheetsApi(tokenProvider(account)), account.email, { logger: log });
      log.info(`Google Sheets write-back is available. Sheets must be shared with ${account.email} as an Editor.`);
    }
  }

  // With FsHub, flights it shows flown are completed by themselves once an hour (the pilot is told in a DM).
  const autoComplete = fshubSync
    ? new AutoCompleter({ store, jobs, sync: fshubSync, writeback, logger: log, slot, onCompleted: async (discordId, done) => void (await notifier?.autoCompleted(discordId, done)) })
    : null;
  panels.fshubEnabled = fshub !== null;
  // A pilot is warned shortly before the latest take-off that still makes a flight's window. How long the flight takes comes from the
  // airline's own FsHub flights of the route when there are some, and from the distance between the airports (their positions read
  // from the public OurAirports list) otherwise.
  const airports = new AirportDirectory(store, { logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  distances = new DistanceFiller({ writeback, airports, positions: (codes) => store.getAirportCoords(codes), getPanel: (id) => store.getPanel(id), logger: log });
  // FsHub's public live feed (no token): who is flying now, so a warning skips a pilot already in the air, and a flight is looked for in
  // FsHub's own record the minute its pilot lands (it is only completed when FsHub shows it flown).
  const liveFeed = new LiveFeed({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  const live = new LiveTracker({
    store,
    feed: liveFeed,
    complete: autoComplete ? (panel, scope) => autoComplete.runPanel(panel, scope) : null,
    logger: log,
  });
  // The same feed says when each of the airline's flights in the air is expected to land: on the flight's card, and for `/eta`.
  const etas = new FlightEtas({ store, feed: liveFeed, panels, logger: log });
  let twitch: TwitchBridge | null = null;
  panels.etas = etas;
  const departures = new DepartureWarnings(store, jobs, new FlightTimes(store, airports), async (discordId, content) => (await notifier?.dm(discordId, content)) === true, { logger: log, live });
  // A short note once a day to one person, when a host has named them (nothing is sent otherwise).
  let airlineSeen: { at: number; name: string | null } | null = null;
  const airlineOf = async (userId: string): Promise<string | null> => {
    if (airlineSeen && Date.now() - airlineSeen.at < 6 * 3_600_000) return airlineSeen.name;
    let name: string | null = null;
    for (const panel of store.listAllPanels()) {
      try {
        const guild = await client.guilds.fetch(panel.guildId);
        await guild.members.fetch(userId);
        name = panel.airlineName;
        break;
      } catch {
        /* not in this server */
      }
    }
    airlineSeen = { at: Date.now(), name };
    return name;
  };
  const dailyNote = config.dailyNote
    ? new DailyNote({ store, target: config.dailyNote, send: async (userId, content) => (await notifier?.dm(userId, content)) === true, reachable: async (userId) => (await notifier?.sharesServerWith(userId)) !== false, airlineName: () => airlineOf(config.dailyNote!.userId), logger: log })
    : null;
  const scheduler = new Scheduler(jobs, refresher, {
    logger: log,
    reminders,
    markets: market,
    panels,
    cleanup: { run: () => panels.cleanReminders() },
    live,
    etas,
    numbers: aeroNumbers,
    departures,
    ...(dailyNote ? { daily: dailyNote } : {}),
    ...(fshubSync ? { fshub: fshubSync } : {}),
    ...(autoComplete ? { autoComplete } : {}),
  });

  // `/setup profit`: reads the airline's aircraft logbooks on Aeroconomy with the host's FsHub token, which Aeroconomy accepts too. It is only
  // ever used when an admin runs that command (nothing is read, and nothing is written, by itself), and only for reading.
  const profits = config.fshubToken
    ? new AirlineProfits({ store, account: new AeroconomyAccountClient(config.fshubToken, { logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` }), publicClient: aeroPublic, ...(fshub ? { fshub } : {}), logger: log })
    : null;

  const ctx: BotContext = { config, store, jobs, panels, refresher, aerodaq, market, metar, writeback, fshub, fshubSync, autoComplete, dailyNote, etas, numbers: aeroNumbers, slot, profits, log, now: Date.now, fetchFn: fetch };

  // Slash commands, buttons and the DM conversation need no privileged intents.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // DM channels arrive as partials
  });
  panels.attach(client);
  market.attach(client);
  notifier = new Notifier(client, panels, log);
  notifier.subscribe(events);
  registerInteractionRouter(client, ctx);

  const servers = new Map<string, ServerInfo>();
  const publish = () => opts.onServers?.([...servers.values()]);
  const body = commands.map((c) => c.data.toJSON());
  log.debug(`Slash command set ${commandsFingerprint(body)}`);

  const registerFor = async (guildId: string, name: string) => {
    if (!opts.registerCommands) {
      servers.set(guildId, { id: guildId, name, commands: 'unchanged' });
      publish();
      return;
    }
    servers.set(guildId, { id: guildId, name, commands: 'pending' });
    publish();
    const result = await registerGuildCommands(
      { put: (id, b) => client.rest.put(Routes.applicationGuildCommands(client.application!.id, id), { body: b }) },
      store,
      guildId,
      body,
      log,
    );
    servers.set(guildId, { id: guildId, name, commands: result });
    publish();
  };

  client.on(Events.Error, (e) => log.error('Discord client error', e));
  if (DEBUG_BUILD) {
    client.on(Events.ShardDisconnect, (ev, id) => dbg(log, `gateway: shard ${id} disconnected (code ${ev.code})`));
    client.on(Events.ShardReconnecting, (id) => dbg(log, `gateway: shard ${id} reconnecting`));
    client.on(Events.ShardResume, (id, replayed) => dbg(log, `gateway: shard ${id} resumed (${replayed} events replayed)`));
    client.on(Events.ShardError, (e, id) => dbg(log, `gateway: shard ${id} error: ${e.message}`));
    client.on(Events.Invalidated, () => dbg(log, 'gateway: the session was invalidated'));
    client.on(Events.GuildRoleDelete, (role) => dbg(log, `role deleted in guild ${role.guild.id}: ${role.id} (${role.name}); ${store.listRefreshRoles(role.guild.id).includes(role.id) ? 'it WAS one of the /setup refresh roles' : 'not a refresh role'}`));
  }
  client.on(Events.GuildCreate, (guild) => {
    log.info(`Added to server "${guild.name}"`);
    void registerFor(guild.id, guild.name).catch((e) => log.warn('Command registration failed', e));
  });
  client.on(Events.GuildDelete, (guild) => {
    log.info(`Removed from server ${guild.id}`);
    servers.delete(guild.id);
    forgetGuildCommands(store, guild.id);
    publish();
  });

  const ready = new Promise<void>((resolve) => {
    client.once(Events.ClientReady, (c) => {
      log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
      if (DEBUG_BUILD) {
        // What this installation is set up as, so the log can be read without asking. No tokens, keys or sheet IDs.
        const all = store.listAllPanels();
        dbg(log, `startup: ${all.length} panel(s), ${[...c.guilds.cache.values()].map((g) => `${g.name} (${g.id}, ${g.memberCount} members)`).join('; ')}`);
        for (const p of all) {
          const open = store.listOpenJobViews(p.id);
          const held = open.reduce((n, v) => n + v.legs.filter((l) => l.holder).length, 0);
          dbg(log, `startup: panel ${p.id} "${p.airlineName}" guild ${p.guildId} channel ${p.channelId} sheet=${p.sheetId ? 'linked' : 'none'} write-back=${p.writeback} window=${p.showDays}d required-role=${p.requiredRoleId ?? 'none'} open flights=${open.length} legs held in Discord=${held} last refresh=${p.lastRefreshAt === null ? 'never' : new Date(p.lastRefreshAt).toISOString()}${p.lastRefreshError ? ` last error="${p.lastRefreshError}"` : ''}`);
        }
        for (const g of c.guilds.cache.values()) dbg(log, `startup: guild ${g.id} /setup refresh roles = [${store.listRefreshRoles(g.id).join(',')}]`);
      }
      // Bring every panel up to date after a restart, then start background work.
      for (const p of store.listAllPanels()) panels.schedule(p.id);
      scheduler.start();
      // Optional: the host connected a Twitch account and chose a channel, so the bot answers its chat about the streamer's flight.
      if (config.twitch) {
        twitch = new TwitchBridge({
          tokensFile: config.twitch.tokensFile,
          statusFile: config.twitch.statusFile,
          channel: config.twitch.channel,
          commands: config.twitch.commands,
          banter: config.twitch.banter,
          pilotId: config.twitch.pilotId,
          feed: liveFeed,
          fshub,
          logger: log,
        });
        void twitch.start();
      }
      void (async () => {
        for (const g of c.guilds.cache.values()) await registerFor(g.id, g.name).catch((e) => log.warn('Command registration failed', e));
      })();
      resolve();
    });
  });

  const stop = async () => {
    twitch?.stop();
    scheduler.stop();
    // The FsHub lane may be mid-request; give it a moment to finish rather than closing the database under it.
    await Promise.race([scheduler.idle(), new Promise<void>((r) => setTimeout(r, 3_000).unref?.())]);
    panels.stop();
    await client.destroy();
    store.close();
  };

  try {
    await client.login(config.discordToken);
    const timeout = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('Discord took too long to finish connecting.')), opts.readyTimeoutMs ?? 60_000);
      t.unref?.();
    });
    await Promise.race([ready, timeout]);
  } catch (e) {
    await stop().catch(() => undefined);
    throw e;
  }

  return {
    userTag: client.user!.tag,
    userId: client.user!.id,
    servers: () => [...servers.values()],
    stop,
  };
}
