import { Client, Events, GatewayIntentBits, Partials, Routes } from 'discord.js';
import { AeroDaqClient } from './aerodaq/client.js';
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
import { JobEvents } from './services/events.js';
import { JobService } from './services/jobs.js';
import { SourceRefresher } from './services/refresh.js';
import { ReminderService } from './services/reminders.js';
import { Scheduler } from './services/scheduler.js';
import { SheetWriteBack } from './services/writeback.js';
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

  const store = new Store(openDatabase(config.databasePath));
  const events = new JobEvents(log);
  const jobs = new JobService(store, events, { logger: log });

  // Aeroconomy publishes no job API, so a panel's flights come from the schedule sheet an admin links
  // with `/setup sheet` (re-read every hour), or from admin file imports. Demo mode also has a
  // fictional source for panels with neither.
  const demoSource = new DemoJobSource();
  const refresher = new SourceRefresher(store, jobs, sourceSelector({ fallback: DEMO ? demoSource : null }), log);
  const panels = new PanelService(store, jobs, log);
  // AeroDAQ's in-game market and fuel prices: public and read-only. It is only asked when someone uses /fuel or a server has a market board.
  const aerodaq = new AeroDaqClient({ logger: log, userAgent: `FlightPanelBot/${process.env.FPB_VERSION ?? 'dev'}` });
  const market = new MarketService(store, aerodaq, log);
  // A flight with no pilot a day before it starts is announced in the panel's channel.
  const reminders = new ReminderService(store, jobs, async (panel, due) => (await panels.remind(panel, due)) === 'sent', { logger: log });
  const scheduler = new Scheduler(jobs, refresher, { logger: log, reminders, markets: market, cleanup: { run: () => panels.cleanReminders() } });

  // Optional: with a Google service account, pilots' names and completions are written to a linked sheet.
  // Demo mode never writes to a real sheet unless asked to, since its pilots and flights are made up.
  let writeback: SheetWriteBack | null = null;
  if (config.googleServiceAccountFile) {
    if (DEMO && process.env.AEROBOT_DEMO_WRITEBACK !== '1') {
      log.info('Demo mode: not writing to Google Sheets (set AEROBOT_DEMO_WRITEBACK=1 to allow it, ideally against a copy of the sheet).');
    } else {
      const account = loadServiceAccount(config.googleServiceAccountFile);
      writeback = new SheetWriteBack(new SheetsApi(tokenProvider(account)), account.email, { logger: log });
      log.info(`Google Sheets write-back is available. Sheets must be shared with ${account.email} as an Editor.`);
    }
  }

  const ctx: BotContext = { config, store, jobs, panels, refresher, aerodaq, market, writeback, log, now: Date.now, fetchFn: fetch };

  // Slash commands, buttons and the DM conversation need no privileged intents.
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // DM channels arrive as partials
  });
  panels.attach(client);
  market.attach(client);
  new Notifier(client, panels, log).subscribe(events);
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
      // Bring every panel up to date after a restart, then start background work.
      for (const p of store.listAllPanels()) panels.schedule(p.id);
      scheduler.start();
      void (async () => {
        for (const g of c.guilds.cache.values()) await registerFor(g.id, g.name).catch((e) => log.warn('Command registration failed', e));
      })();
      resolve();
    });
  });

  const stop = async () => {
    scheduler.stop();
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
