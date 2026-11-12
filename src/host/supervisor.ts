import { mkdirSync } from 'node:fs';
import { startBot as realStartBot, type BotHandle, type ServerInfo, type StartOptions } from '../bot.js';
import type { Config } from '../config.js';
import type { Logger } from '../util/log.js';
import { inviteUrl } from './invite.js';
import type { HostPaths } from './paths.js';
import { clientIdFromToken, googleKeyInfo, loadSettings, missingSettings, toConfig } from './settings.js';
import type { HostState, Phase } from './status.js';

export interface SupervisorOptions {
  paths: HostPaths;
  log: Logger;
  version: string;
  /** Called every time the state changes. */
  onState: (state: HostState) => void;
  /** Replaceable in tests. */
  startBot?: (config: Config, opts: StartOptions) => Promise<BotHandle>;
  now?: () => number;
  /** How long to wait before each retry when Discord can't be reached; the last one repeats. */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS = [15_000, 30_000, 60_000, 120_000, 300_000];

/** What went wrong at start-up, in words a host can act on, and whether trying again could help. */
export function explainStartFailure(e: unknown): { message: string; retry: boolean } {
  const text = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'TokenInvalid' || /invalid token|incorrect login/i.test(text)) {
    return { message: "Discord rejected the bot token. On the Developer Portal's Bot tab press Reset Token, then paste the new token here and save.", retry: false };
  }
  if (code === 'DisallowedIntents' || /disallowed intents/i.test(text)) {
    return { message: 'Discord refused the connection because of the bot\'s intent settings. Leave all three "Privileged Gateway Intents" switched off on the Bot tab.', retry: false };
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|took too long|getaddrinfo|socket hang up/i.test(`${code ?? ''} ${text}`)) {
    return { message: "I can't reach Discord right now. I'll keep trying by myself.", retry: true };
  }
  return { message: text.length > 300 ? `${text.slice(0, 300)}…` : text, retry: false };
}

/**
 * Runs the bot for a host: starts it from the saved settings, reports what state it is in, restarts
 * it when the settings change, and keeps trying when Discord can't be reached.
 */
export class Supervisor {
  private bot: BotHandle | null = null;
  private generation = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private phase: Phase = 'stopped';
  private message = 'Not started.';
  private botName: string | null = null;
  private servers: ServerInfo[] = [];
  private readonly startBot: NonNullable<SupervisorOptions['startBot']>;
  private readonly now: () => number;
  private updatedAt: number;

  constructor(private readonly o: SupervisorOptions) {
    this.startBot = o.startBot ?? realStartBot;
    this.now = o.now ?? Date.now;
    this.updatedAt = this.now();
  }

  state(): HostState {
    const settings = loadSettings(this.o.paths);
    const clientId = clientIdFromToken(settings.discordToken);
    return {
      phase: this.phase,
      message: this.message,
      botName: this.botName,
      inviteUrl: clientId ? inviteUrl(clientId) : null,
      servers: this.servers,
      configured: { discordToken: settings.discordToken !== '', google: googleKeyInfo(this.o.paths), fshub: settings.fshubAccessToken !== '' },
      version: this.o.version,
      updatedAt: this.updatedAt,
    };
  }

  private set(phase: Phase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.updatedAt = this.now();
    this.o.onState(this.state());
  }

  /** Start, or start again, from the saved settings. */
  async start(): Promise<void> {
    const generation = ++this.generation;
    this.clearRetry();
    await this.disconnect();
    if (generation !== this.generation) return;

    const settings = loadSettings(this.o.paths);
    const missing = missingSettings(settings);
    if (missing.length > 0) {
      this.botName = null;
      this.servers = [];
      this.set('needs-setup', `Needs setup: ${missing.join(' and ')}.`);
      return;
    }

    this.set('starting', 'Connecting to Discord…');
    try {
      mkdirSync(this.o.paths.dataDir, { recursive: true });
      const bot = await this.startBot(toConfig(this.o.paths, settings), {
        log: this.o.log,
        registerCommands: true,
        onServers: (servers) => {
          if (generation !== this.generation) return;
          this.servers = servers;
          this.o.onState(this.state());
        },
      });
      if (generation !== this.generation) {
        await bot.stop().catch(() => undefined);
        return;
      }
      this.bot = bot;
      this.botName = bot.userTag;
      this.servers = bot.servers();
      this.retries = 0;
      this.set('online', `Online as ${bot.userTag}.`);
    } catch (e) {
      if (generation !== this.generation) return;
      const why = explainStartFailure(e);
      this.o.log.error(`Could not start the bot: ${e instanceof Error ? e.message : e}`);
      this.botName = null;
      this.servers = [];
      if (why.retry) {
        const delays = this.o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
        const delay = delays[Math.min(this.retries, delays.length - 1)] as number;
        this.retries++;
        this.set('retrying', why.message);
        this.retryTimer = setTimeout(() => void this.start(), delay);
        this.retryTimer.unref?.();
      } else {
        this.set('error', why.message);
      }
    }
  }

  /** Stop and start again (after the settings changed, or because the host asked). */
  restart(): Promise<void> {
    this.retries = 0;
    return this.start();
  }

  async stop(): Promise<void> {
    this.generation++;
    this.clearRetry();
    await this.disconnect();
    this.servers = [];
    this.set('stopped', 'Stopped.');
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private async disconnect(): Promise<void> {
    const bot = this.bot;
    this.bot = null;
    if (bot) await bot.stop().catch((e) => this.o.log.warn('Error while stopping the bot', e));
  }
}
