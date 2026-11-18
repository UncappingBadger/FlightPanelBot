import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FsHubClient } from '../fshub/client.js';
import type { LiveFeed } from '../fshub/liveFeed.js';
import { DEBUG_BUILD } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import { ChatBot } from './chatBot.js';
import { EventSubClient, type EventSubState, type SocketFactory, type Timers } from './eventsub.js';
import { StreamerFlights, type FlightSource } from './flightInfo.js';
import { TwitchApi, TwitchApiError, type TwitchUser } from './helix.js';
import { CHAT_SCOPES, TwitchAuthError } from './oauth.js';
import { readTokens, TokenManager } from './tokens.js';

/**
 * Puts the Twitch pieces together inside the running bot: the saved sign-in, the chat connection, and the part that decides what to say.
 * Nothing starts unless the host has both connected a Twitch account and named a channel, and a problem anywhere (no network, the sign-in
 * taken back, a channel that does not exist) is a line in the log and a status on the setup page, never a reason for the Discord bot to stop.
 */

export type TwitchState =
  /** Not set up (no Twitch account connected, or no channel chosen). */
  | 'off'
  | 'starting'
  | 'running'
  /** The sign-in is no longer accepted, or lacks a permission: connect again on the setup page. */
  | 'needs-connect'
  /** There is no Twitch channel with the chosen name. */
  | 'bad-channel'
  /** Twitch could not be reached; trying again. */
  | 'retrying'
  | 'failed';

export interface TwitchStatus {
  state: TwitchState;
  detail: string;
  /** The Twitch account the bot speaks as, and the channel it is in. */
  login: string | null;
  channel: string | null;
  at: number;
}

export interface BridgeOptions {
  tokensFile: string;
  /** Where the current status is written, for the setup page to show. */
  statusFile?: string | undefined;
  channel: string;
  commands: boolean;
  banter: boolean;
  /** The streamer's FsHub pilot number; without it, the owner of the FsHub token. */
  pilotId?: number | undefined;
  feed: Pick<LiveFeed, 'pilotDetail'>;
  fshub: Pick<FsHubClient, 'pilotRecentFlights' | 'account'> | null;
  logger?: Logger;
  fetchFn?: typeof fetch;
  socketFactory?: SocketFactory;
  now?: () => number;
  random?: () => number;
  timers?: Timers;
  /** For tests: the flight data, in place of the live feed and FsHub. */
  source?: FlightSource;
  /**
   * A test build only: the bot may use the channel's own account, and answers what that account types, so one person can try everything alone.
   * A release (the default) needs an account of its own for the bot, and will not join a chat as the channel's own account.
   */
  ownAccount?: boolean;
  /** How often the sign-in is checked with Twitch (it asks for every hour). */
  validateEveryMs?: number;
}

const HOUR_MS = 3_600_000;
/** A failure to reach Twitch at start-up is tried again after these waits, then every five minutes. */
const START_RETRY_MS = [30_000, 60_000, 120_000, 300_000];

export class TwitchBridge {
  private readonly log: Logger;
  private readonly now: () => number;
  private current: TwitchStatus;
  private events: EventSubClient | null = null;
  private manager: TokenManager | null = null;
  private brain: ChatBot | null = null;
  private api: TwitchApi | null = null;
  private broadcaster: TwitchUser | null = null;
  private selfId = '';
  private stopped = true;
  private attempt = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private validateTimer: NodeJS.Timeout | null = null;
  private queue: Promise<void> = Promise.resolve();
  private forbidden = 0;

  private readonly ownAccount: boolean;

  constructor(private readonly o: BridgeOptions) {
    this.ownAccount = o.ownAccount ?? DEBUG_BUILD;
    this.log = o.logger ?? silentLogger;
    this.now = o.now ?? Date.now;
    this.current = { state: 'off', detail: 'Not set up.', login: null, channel: o.channel || null, at: this.now() };
  }

  status(): TwitchStatus {
    return this.current;
  }

  private set(state: TwitchState, detail: string, login: string | null = this.current.login): void {
    this.current = { state, detail, login, channel: this.o.channel || null, at: this.now() };
    const file = this.o.statusFile;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(this.current)}\n`, 'utf8');
    } catch {
      /* the setup page just shows less */
    }
  }

  /** Start if there is something to start. Never throws. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.retryTimer = this.validateTimer = null;
    this.events?.stop();
    this.events = null;
    this.set('off', 'Stopped.');
  }

  private retryLater(why: string): void {
    if (this.stopped) return;
    const wait = START_RETRY_MS[Math.min(this.attempt, START_RETRY_MS.length - 1)] as number;
    this.attempt++;
    this.set('retrying', `${why} Trying again in ${Math.round(wait / 1000)} s.`);
    this.log.info(`Twitch chat: ${why} Trying again in ${Math.round(wait / 1000)} s`);
    this.retryTimer = setTimeout(() => void this.connect(), wait);
    this.retryTimer.unref?.();
  }

  private lost(why: string): void {
    this.events?.stop();
    this.events = null;
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.validateTimer = null;
    this.set('needs-connect', why);
    this.log.warn(`Twitch chat: ${why}`);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const tokens = readTokens(this.o.tokensFile);
    if (!tokens) return this.set('off', 'No Twitch account is connected.', null);
    if (!this.o.channel) return this.set('off', 'No Twitch channel is chosen.', tokens.login);
    this.set('starting', 'Starting…', tokens.login);

    const manager = new TokenManager({ file: this.o.tokensFile, ...(this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {}), now: this.now, logger: this.log, onLost: (why) => this.lost(why) }, tokens);
    this.manager = manager;
    try {
      const info = await manager.validate();
      if (info === null) return this.lost('Twitch no longer accepts the saved sign-in. Connect to Twitch again on the setup page.');
      const missing = CHAT_SCOPES.filter((s) => !info.scopes.includes(s));
      if (missing.length > 0) return this.lost(`The Twitch sign-in lacks permission to ${missing.includes('user:write:chat') ? 'send' : 'read'} chat. Connect to Twitch again on the setup page.`);
      this.selfId = info.userId;
      if (!this.ownAccount && info.login === this.o.channel.toLowerCase()) {
        const why = "The bot needs a Twitch account of its own: connect a separate account for it (and make that account a moderator of the channel), not the channel's own account.";
        this.set('needs-connect', why, info.login);
        this.log.warn(`Twitch chat: ${why}`);
        return;
      }

      const api = new TwitchApi({ tokens: manager, ...(this.o.fetchFn ? { fetchFn: this.o.fetchFn } : {}), logger: this.log, now: this.now });
      this.api = api;
      const broadcaster = await api.userByLogin(this.o.channel);
      if (!broadcaster) {
        this.set('bad-channel', `There is no Twitch channel called "${this.o.channel}".`, info.login);
        this.log.warn(`Twitch chat: there is no Twitch channel called "${this.o.channel}"`);
        return;
      }
      this.broadcaster = broadcaster;

      this.brain = new ChatBot({
        botLogin: info.login,
        botUserId: info.userId,
        source: this.o.source ?? new StreamerFlights({ feed: this.o.feed, fshub: this.o.fshub, pilotId: this.o.pilotId, now: this.now }),
        commands: this.o.commands,
        banter: this.o.banter,
        answerOwnAccount: this.ownAccount,
        now: this.now,
        ...(this.o.random ? { random: this.o.random } : {}),
        logger: this.log,
      });
      this.events = new EventSubClient({
        api,
        broadcasterId: broadcaster.id,
        userId: info.userId,
        onChat: (ev) => void this.onChat(ev),
        onState: (s, d) => this.onEventState(s, d, info.login),
        ...(this.o.socketFactory ? { socketFactory: this.o.socketFactory } : {}),
        ...(this.o.timers ? { timers: this.o.timers } : {}),
        ...(this.o.random ? { random: this.o.random } : {}),
        logger: this.log,
      });
      this.events.start();
      this.attempt = 0;
      this.validateTimer ??= setInterval(() => void this.revalidate(), this.o.validateEveryMs ?? HOUR_MS);
      this.validateTimer.unref?.();
    } catch (e) {
      if (e instanceof TwitchAuthError && e.kind === 'invalid') return this.lost(e.message);
      if (e instanceof TwitchApiError && e.kind === 'unauthorized') return this.lost('Twitch no longer accepts the saved sign-in. Connect to Twitch again on the setup page.');
      this.retryLater(e instanceof Error && (e instanceof TwitchAuthError || e instanceof TwitchApiError) ? e.message : "Something went wrong reaching Twitch.");
    }
  }

  private onEventState(state: EventSubState, detail: string | undefined, login: string): void {
    if (state === 'connected') this.set('running', `In ${this.o.channel}'s chat.`, login);
    else if (state === 'reconnecting') this.set('retrying', `${detail ?? 'The chat connection dropped.'} Reconnecting.`, login);
    else if (state === 'failed') {
      const needs = /sign-in|access was taken/i.test(detail ?? '');
      this.set(needs ? 'needs-connect' : 'failed', detail ?? 'The chat connection stopped.', login);
    }
  }

  private async revalidate(): Promise<void> {
    try {
      if ((await this.manager?.validate()) === null) this.lost('Twitch no longer accepts the saved sign-in. Connect to Twitch again on the setup page.');
    } catch (e) {
      this.log.debug(`Twitch: could not check the sign-in this time: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async onChat(ev: Parameters<ChatBot['respond']>[0]): Promise<void> {
    const brain = this.brain;
    if (!brain || this.stopped) return;
    let reply;
    try {
      reply = await brain.respond(ev);
    } catch (e) {
      this.log.warn('Twitch chat: could not work out a reply', e);
      return;
    }
    if (!reply) return;
    // One message at a time, in order.
    this.queue = this.queue.then(() => this.send(reply.text, reply.replyTo)).catch(() => undefined);
  }

  private async send(text: string, replyTo: string): Promise<void> {
    const api = this.api;
    const channel = this.broadcaster;
    if (!api || !channel || this.stopped) return;
    try {
      const result = await api.sendMessage(channel.id, this.selfId, text, replyTo);
      this.forbidden = 0;
      if (!result.sent) this.log.debug(`Twitch did not send a reply (${result.dropCode})`);
    } catch (e) {
      if (e instanceof TwitchApiError && e.kind === 'forbidden') {
        // Not allowed to talk here (banned, timed out, or the channel limits who may chat): said once, then not over and over.
        if (this.forbidden++ === 0) this.log.warn(`Twitch chat: the bot is not allowed to send messages in ${this.o.channel}'s chat (${e.message})`);
      } else {
        this.log.debug(`Twitch: could not send a reply: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
