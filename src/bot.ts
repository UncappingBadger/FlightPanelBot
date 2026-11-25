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
import { WeatherBoardService } from './discord/weatherBoard.js';
import { AeroconomyBankingClient } from './aeroconomy/banking.js';
import { BankingService } from './services/banking.js';
import { FlightMonitors } from './services/flightMonitor.js';
import { SecretBox } from './services/secretBox.js';
import { PayrollDaily } from './discord/payrollUi.js';
import { PAYROLL_OFF_FLAG, payrollEnabled } from './features.js';
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
import { FlightNumberFiller } from './services/flightNumberFill.js';
import { AutoCompleter } from './services/autoComplete.js';
import { DailyNote } from './services/dailyNote.js';
import { DepartureWarnings } from './services/departureWarnings.js';
import { JobEvents } from './services/events.js';
import { FlightTimes } from './services/flightTime.js';
import { FsHubSync } from './services/fshubSync.js';
import { HardLandings } from './services/hardLanding.js';
import { HARD_LANDINGS_CSV, managerRoles, managersLookup, tellDoubts } from './services/safetyReport.js';
import { JobService } from './services/jobs.js';
import { AeroconomyAccountClient } from './aeroconomy/account.js';
import { AeroconomyClient } from './aeroconomy/client.js';
import { AirlineProfits } from './services/airlineProfits.js';
import { AeroconomyGateway, NotConnectedGateway } from './services/payGateway.js';
import { AeroconomyPaymentsClient } from './aeroconomy/payments.js';
import { Payroll } from './services/payrollService.js';
import { AeroNumbers } from './services/aeroNumbers.js';
import { HourlySlot } from './services/hourlySlot.js';
import { FlightEtas } from './services/flightEtas.js';
import { LiveTracker } from './services/liveTracker.js';
import { DEBUG_SHEET_INTERVAL_MS, SourceRefresher } from './services/refresh.js';
import { ReminderService } from './services/reminders.js';
import { Scheduler } from './services/scheduler.js';
import { SheetWriteBack } from './services/writeback.js';
import { BackupSheetCheck, backupSheetCleaner } from './services/backupSheet.js';
import { DEBUG_BUILD, dbg } from './util/debugBuild.js';
import { LocalSheet, localSheetFetch } from './google/localSheet.js';
import { createLogger, type Logger } from './util/log.js';
import { TEST_BUILD, TIME_SCALE, appNow } from './util/clock.js';
import { PerfMonitor, fileMb } from './testbuild/perfMonitor.js';
import { TEST_SHEET_ID, TEST_SHEET_URL, TestSheetFeeder } from './testbuild/testSheet.js';

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
  if (TEST_BUILD) {
    // The test build asks nobody but Discord for anything: no Google, FsHub, Aeroconomy account, Twitch or daily note, whatever the settings say.
    config = { ...config, fshubToken: undefined, googleServiceAccountFile: undefined, twitch: undefined, dailyNote: undefined };
    log.warn(`TEST BUILD: the bot's clock runs ${TIME_SCALE} times faster (a day is ${(24 * 60 / TIME_SCALE).toFixed(1)} minutes, an hour ${(3600 / TIME_SCALE).toFixed(1)} seconds), every sheet is a made-up one in a local file (Google is never asked), and FsHub, Aeroconomy accounts, Twitch and the daily note are off. Link the made-up sheet with /setup sheet link:${TEST_SHEET_URL} (any sheet link gets made-up flights).`);
  }

  // The diagnostic build keeps its sheets in local files here, and never writes to Google.
  const debugSheets = join(dirname(config.databasePath), 'debug-sheets');
  // The test build's made-up schedules, and what keeps them changing while it runs (see src/testbuild).
  const feeder = TEST_BUILD ? new TestSheetFeeder(debugSheets, appNow, { logger: log }) : null;
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
  if (DEBUG_BUILD && !TEST_BUILD) dbg(log, `DEBUG BUILD: a linked sheet is read every ${DEBUG_SHEET_INTERVAL_MS / 60_000} minutes (within a minute after that: the scheduler ticks once a minute), not once an hour, so the Distance fill can be watched; the other hourly checks are unchanged`);
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
  // The same sheet's empty Flight Number cells get the flights' numbers written in, once the numbers are read (set up with the write-back, below).
  let flightNumbers: FlightNumberFiller | null = null;
  const refresher: SourceRefresher = new SourceRefresher(store, jobs, sourceSelector({ fallback: DEMO ? demoSource : null, ...(DEBUG_BUILD ? { fetchFn: localSheetFetch(debugSheets, fetch, log, feeder?.make) } : {}) }), log, appNow, (panel, list, fetched) => (distances ? distances.enrich(panel, aeroNumbers.enrich(panel, list), fetched) : aeroNumbers.enrich(panel, list)), slot, async (panel, fetched) => {
    await Promise.all([distances?.run(panel, fetched), flightNumbers?.run(panel, fetched)]);
  });
  const panels = new PanelService(store, jobs, log);
  // AeroDAQ's in-game market and fuel prices: public and read-only. It is only asked when someone uses /fuel or a server has a market board.
  const aerodaq = new AeroDaqClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  const market = new MarketService(store, aerodaq, log);
  // VATSIM's public METAR service: only asked when someone sends the bot `metar <airport>` in a DM, and only ever sent the airport code.
  const metar = new MetarClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  // A server's weather board (`/setup weather`) asks the same service, once every ten minutes, for the airports it shows.
  const weather = new WeatherBoardService(store, metar, log);
  // A flight with no pilot a day before it starts is announced in the panel's channel.
  const reminders = new ReminderService(store, jobs, async (panel, due) => (await panels.remind(panel, due)) === 'sent', { logger: log });
  // Optional: with a FsHub token, typed pilot IDs are checked, and a panel linked to its airline's FsHub roster
  // learns who is who by itself. Nothing is asked of FsHub without one.
  const fshub = config.fshubToken ? new FsHubClient({ token: config.fshubToken, logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` }) : null;
  // A pilot FsHub shows landing very hard gets a light-hearted message (they can switch it off). It only needs FsHub's flights, so it rides on that read.
  let notifier: Notifier | null = null;
  const managersOf = managersLookup(store, async (guildId, roleIds) => (await notifier?.managerIds(guildId, roleIds)) ?? []);
  const hardLandings = new HardLandings(store, async (discordId, content) => (await notifier?.dm(discordId, content)) === true, {
    logger: log,
    managers: managersOf,
    nameOf: async (discordId) => (await notifier?.nameOf(discordId)) ?? null,
    // The CSV of penalty landings sits in the data folder, beside the database (none for an in-memory one, which is for tests and demos).
    csvFile: config.databasePath === ':memory:' ? null : join(dirname(config.databasePath), HARD_LANDINGS_CSV),
  });
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
    ? new AutoCompleter({ store, jobs, sync: fshubSync, writeback, logger: log, slot, onCompleted: async (discordId, done) => void (await notifier?.autoCompleted(discordId, done)), onReplaced: async (done) => void (await notifier?.backupTookOver(done)) })
    : null;
  panels.fshubEnabled = fshub !== null;
  // A pilot is warned shortly before the latest take-off that still makes a flight's window. How long the flight takes comes from the
  // airline's own FsHub flights of the route when there are some, and from the distance between the airports (their positions read
  // from the public OurAirports list) otherwise.
  const airports = new AirportDirectory(store, { logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  distances = new DistanceFiller({ writeback, airports, positions: (codes) => store.getAirportCoords(codes), getPanel: (id) => store.getPanel(id), logger: log });
  flightNumbers = new FlightNumberFiller({ writeback, numbers: aeroNumbers, logger: log });
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
  // Private messages a person asks for in a DM: `/monitor` (a flight about to land, and landed, from the same live feed) and `/banking` (money going into or out of
  // the Aeroconomy accounts they choose, read with their own token, which is kept sealed in a key file beside the database and deleted when they turn it off).
  const sendDm = async (discordId: string, content: string) => (await notifier?.dm(discordId, content)) === true;
  const monitors = new FlightMonitors({ store, feed: liveFeed, send: sendDm, logger: log });
  let box: SecretBox;
  try {
    box = config.databasePath === ':memory:' ? SecretBox.inMemory() : SecretBox.fromFile(join(dirname(config.databasePath), 'banking.key'));
  } catch (e) {
    // Without a key file that can be kept, tokens could not be opened after a restart: they are kept only while the program runs, and people are asked again.
    log.warn('Could not keep a key file for pilots\' Aeroconomy tokens; they will only be remembered until the bot restarts', e);
    box = SecretBox.inMemory();
  }
  const banking = new BankingService({ store, client: new AeroconomyBankingClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` }), box, send: sendDm, logger: log });
  let twitch: TwitchBridge | null = null;
  panels.etas = etas;
  const departures = new DepartureWarnings(store, jobs, new FlightTimes(store, airports), async (discordId, content) => (await notifier?.dm(discordId, content)) === true, { logger: log, live });
  // A short note once a day to one person, when a host has named them (nothing is sent otherwise).
  let airlineSeen: { at: number; name: string | null } | null = null;
  const airlineOf = async (userId: string): Promise<string | null> => {
    if (airlineSeen && appNow() - airlineSeen.at < 6 * 3_600_000) return airlineSeen.name;
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
    airlineSeen = { at: appNow(), name };
    return name;
  };
  const dailyNote = config.dailyNote
    ? new DailyNote({ store, target: config.dailyNote, send: async (userId, content) => (await notifier?.dm(userId, content)) === true, reachable: async (userId) => (await notifier?.sharesServerWith(userId)) !== false, airlineName: () => airlineOf(config.dailyNote!.userId), logger: log })
    : null;
  // Paying pilots: the list of what is due is made from the airline's sheet, checked by an admin, and paid through Aeroconomy when they press Pay. It is on
  // unless the person running the bot switched it off (src/features.ts). The money is sent with the saved FsHub token, which Aeroconomy accepts as its
  // API key; without one nothing can be paid, and the bot says so.
  const payroll = payrollEnabled()
    ? (() => {
        const token = config.fshubToken;
        const userAgent = `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}`;
        const bank = new AeroconomyBankingClient({ logger: log, userAgent });
        return new Payroll({
          store,
          gateway: token ? new AeroconomyGateway(new AeroconomyPaymentsClient(token, { logger: log, userAgent })) : new NotConnectedGateway(),
          accounts: token ? () => bank.accounts(token) : null,
          writeback,
          fshub,
          logger: log,
        });
      })()
    : null;
  if (payroll) log.info(payroll.gateway.connected ? 'Paying pilots is available: an admin sets it up with /payroll settings, and nothing is paid until they press Pay.' : 'Paying pilots is available, but there is no FsHub token, so nothing can be paid.');
  else log.info(`Paying pilots is switched off (${PAYROLL_OFF_FLAG}).`);
  let payrollDaily: PayrollDaily | null = null;
  // The test build times every step the scheduler takes, and says how the bot is doing once a minute (see src/testbuild/perfMonitor.ts).
  const perf = TEST_BUILD
    ? new PerfMonitor(log, appNow, {
        extra: () => `database ${fileMb(config.databasePath)} MB (+ ${fileMb(`${config.databasePath}-wal`)} MB journal), ${store.listAllPanels().length} panel(s), ${store.listAllPanels().reduce((n, p) => n + store.listJobs(p.id, 'open').length, 0)} open flight(s) | panels so far: ${panels.totals.redraws} redraws = ${panels.totals.edited} edits + ${panels.totals.sent} posts in ${(panels.totals.ms / 1000).toFixed(0)} s${panels.totals.edited + panels.totals.sent > 0 ? ` (${(panels.totals.ms / (panels.totals.edited + panels.totals.sent) / 1000).toFixed(2)} s a message)` : ''}`,
      })
    : null;
  const timed = <T extends { run(): unknown }>(name: string, service: T): T => (perf ? perf.wrap(name, service) : service);
  const scheduler = new Scheduler(jobs, refresher, {
    logger: log,
    ...(TEST_BUILD ? { tickMs: 2_000 } : {}),
    ...(payroll ? { payroll: timed('daily pay list', { run: async () => void (await payrollDaily?.run()) }) } : {}),
    reminders: timed('midnight list', reminders),
    markets: timed('market boards', market),
    weather: timed('weather boards', weather),
    banking: timed('payment messages', banking),
    monitors: timed('flight monitors', monitors),
    panels,
    cleanup: timed('announcement cleanup', { run: () => panels.cleanReminders() }),
    live: timed('live tracking', live),
    etas: timed('landing times', etas),
    numbers: timed('Aeroconomy numbers', aeroNumbers),
    departures: timed('departure warnings', departures),
    ...(writeback ? { backups: timed('backup pilots', new BackupSheetCheck({ store, writeback, logger: log })) } : {}),
    ...(dailyNote ? { daily: timed('daily note', dailyNote) } : {}),
    ...(fshubSync ? { fshub: timed('FsHub sync', fshubSync) } : {}),
    ...(autoComplete ? { autoComplete: timed('auto-complete', autoComplete) } : {}),
  });
  if (perf) {
    const realTick = scheduler.tick.bind(scheduler);
    scheduler.tick = () => perf.time('whole pass', realTick);
    const realRefreshDue = refresher.refreshDue.bind(refresher);
    refresher.refreshDue = () => perf.time('sheet reads', realRefreshDue);
    const realRedraw = panels.refresh.bind(panels);
    panels.refresh = (id, o) => perf.time('panel redraw', () => realRedraw(id, o));
  }

  // `/setup profit`: reads the airline's aircraft logbooks on Aeroconomy with the host's FsHub token, which Aeroconomy accepts too. It is only
  // ever used when an admin runs that command (nothing is read, and nothing is written, by itself), and only for reading.
  const profits = config.fshubToken
    ? new AirlineProfits({ store, account: new AeroconomyAccountClient(config.fshubToken, { logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` }), publicClient: aeroPublic, ...(fshub ? { fshub } : {}), onHeld: (panel, held) => tellDoubts({ store, send: async (discordId, content) => (await notifier?.dm(discordId, content)) === true, managers: managersOf, now: appNow, log }, panel, held), logger: log })
    : null;

  const ctx: BotContext = { config, store, jobs, panels, refresher, aerodaq, market, metar, weather, banking, monitors, writeback, fshub, fshubSync, autoComplete, dailyNote, etas, numbers: aeroNumbers, slot, profits, payroll, managerCheck: async (panel) => (await notifier?.managerCheck(panel.guildId, managerRoles(store, panel))) ?? { ids: [], found: 0, readable: true }, log, now: appNow, fetchFn: fetch };

  // Slash commands, buttons and the DM conversation need no privileged intents.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // DM channels arrive as partials
  });
  panels.attach(client);
  market.attach(client);
  weather.attach(client);
  notifier = new Notifier(client, panels, log);
  notifier.subscribe(events);
  events.subscribe(backupSheetCleaner({ store, writeback, logger: log }));
  registerInteractionRouter(client, ctx);
  if (payroll) payrollDaily = new PayrollDaily(ctx, client);

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
      if (perf && feeder) {
        perf.start();
        // The made-up sheets keep changing, as real ones do: once an hour of the faster clock. A panel with no sheet is given the made-up one.
        const every = Math.max(1_000, Math.round(3_600_000 / TIME_SCALE));
        const timer = setInterval(() => {
          try {
            for (const p of store.listAllPanels()) {
              if (!p.sheetId && !store.listJobs(p.id, 'open').length) {
                store.updatePanel(p.id, { sheetId: TEST_SHEET_ID, sheetGid: null });
                log.info(`[test] the ${p.airlineName} panel had no sheet: it now reads the made-up one (${TEST_SHEET_URL})`);
              }
              if (p.sheetId) feeder.adopt({ id: p.sheetId, gid: p.sheetGid });
            }
            feeder.feed();
          } catch (e) {
            log.warn('[test] the sheet feed failed', e);
          }
        }, every);
        timer.unref?.();
        stopTest = () => {
          clearInterval(timer);
          perf.stop();
        };
      }
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

  let stopTest: () => void = () => undefined;
  const stop = async () => {
    stopTest();
    twitch?.stop();
    scheduler.stop();
    // Nothing new starts from here: no new reads or redraws, and the slow Aeroconomy read stops at its next step.
    aeroNumbers.stop();
    panels.stop();
    // The FsHub lane, any redraw and any write to a sheet may be mid-request; give them a moment to finish rather than closing the database under
    // them (a sheet write cut off half way is a reservation the sheet never heard of). The host waits about eight seconds for the bot, so this stays under that.
    const GRACE_MS = 5_000;
    await Promise.race([Promise.all([scheduler.idle(), aeroNumbers.idle(), panels.drain(GRACE_MS), writeback?.idle()]), new Promise<void>((r) => setTimeout(r, GRACE_MS).unref?.())]);
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
