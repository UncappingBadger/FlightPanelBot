import { silentLogger, type Logger } from '../util/log.js';
import { TwitchApiError, type TwitchApi } from './helix.js';

/**
 * Reads one channel's chat over Twitch's EventSub WebSocket (the way Twitch recommends; IRC is the old one):
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 *
 * Connect, wait for the welcome (which names the session), subscribe to the channel's chat messages within ten seconds, then listen. Twitch
 * sends a keepalive when it is quiet; if neither a message nor a keepalive arrives in time the connection is taken as lost and made again.
 * Twitch can also ask for a move to another address, which is done without a gap. Messages missed while the connection was down are not replayed.
 */
export const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

/** The part of a WebSocket this uses (Node has one built in; a test supplies its own). */
export interface SocketLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url) => {
  const W = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket;
  if (!W) throw new Error('This version of Node.js has no WebSocket.');
  return new W(url);
};

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

/** One message somebody sent in the channel's chat. */
export interface ChatEvent {
  messageId: string;
  chatterId: string;
  chatterLogin: string;
  chatterName: string;
  text: string;
  /** The badge sets the chatter has (`broadcaster`, `moderator`, `vip`, `subscriber`, ...). */
  badges: string[];
  /** Set when the message is a reply: the person who wrote the message it answers. */
  replyToUserId: string | null;
  replyToLogin: string | null;
  /** `text` for an ordinary message. */
  messageType: string;
}

export type EventSubState = 'stopped' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface EventSubOptions {
  api: Pick<TwitchApi, 'subscribeChat'>;
  broadcasterId: string;
  /** The bot's own Twitch user ID. */
  userId: string;
  onChat: (event: ChatEvent) => void;
  onState?: (state: EventSubState, detail?: string) => void;
  socketFactory?: SocketFactory;
  logger?: Logger;
  url?: string;
  timers?: Timers;
  random?: () => number;
}

/** How long to wait before trying again after a failed or lost connection, in order, then for ever the last one. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** The keepalive Twitch is asked for, in seconds (10 to 600), and the grace allowed on top of what it says. */
const KEEPALIVE_SECONDS = 20;
const KEEPALIVE_GRACE_MS = 8_000;
const SEEN_LIMIT = 200;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function chatEventOf(raw: unknown): ChatEvent | null {
  const e = obj(raw);
  const messageId = str(e.message_id);
  const chatterId = str(e.chatter_user_id);
  const text = str(obj(e.message).text);
  if (!messageId || !chatterId || !text) return null;
  const reply = obj(e.reply);
  return {
    messageId,
    chatterId,
    chatterLogin: str(e.chatter_user_login).toLowerCase(),
    chatterName: str(e.chatter_user_name) || str(e.chatter_user_login),
    text,
    badges: Array.isArray(e.badges) ? e.badges.map((b) => str(obj(b).set_id)).filter(Boolean) : [],
    replyToUserId: str(reply.parent_user_id) || null,
    replyToLogin: str(reply.parent_user_login).toLowerCase() || null,
    messageType: str(e.message_type) || 'text',
  };
}

export class EventSubClient {
  private readonly factory: SocketFactory;
  private readonly log: Logger;
  private readonly timers: Timers;
  private readonly random: () => number;
  private readonly url: string;
  private active: SocketLike | null = null;
  /** A socket opened because Twitch asked for a move: it takes over when its welcome arrives. */
  private pending: SocketLike | null = null;
  private stopping = true;
  private attempt = 0;
  private watchdog: unknown = null;
  private retry: unknown = null;
  private keepaliveMs = (KEEPALIVE_SECONDS * 1000) + KEEPALIVE_GRACE_MS;
  private readonly seen = new Set<string>();
  private currentState: EventSubState = 'stopped';

  constructor(private readonly opts: EventSubOptions) {
    this.factory = opts.socketFactory ?? defaultSocketFactory;
    this.log = opts.logger ?? silentLogger;
    this.timers = opts.timers ?? realTimers;
    this.random = opts.random ?? Math.random;
    this.url = opts.url ?? EVENTSUB_URL;
  }

  get state(): EventSubState {
    return this.currentState;
  }

  start(): void {
    if (!this.stopping) return;
    this.stopping = false;
    this.attempt = 0;
    this.setState('connecting');
    this.open(`${this.url}?keepalive_timeout_seconds=${KEEPALIVE_SECONDS}`, false);
  }

  stop(): void {
    this.stopping = true;
    this.clearTimers();
    for (const s of [this.active, this.pending]) this.closeQuietly(s);
    this.active = null;
    this.pending = null;
    this.setState('stopped');
  }

  private setState(state: EventSubState, detail?: string): void {
    this.currentState = state;
    this.opts.onState?.(state, detail);
  }

  private clearTimers(): void {
    if (this.watchdog !== null) this.timers.clear(this.watchdog);
    if (this.retry !== null) this.timers.clear(this.retry);
    this.watchdog = null;
    this.retry = null;
  }

  private closeQuietly(socket: SocketLike | null): void {
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, 'bye');
    } catch {
      /* already closed */
    }
  }

  private open(url: string, continuation: boolean): void {
    let socket: SocketLike;
    try {
      socket = this.factory(url);
    } catch (e) {
      this.fail(e instanceof Error ? e.message : 'The WebSocket could not be opened.');
      return;
    }
    if (continuation) this.pending = socket;
    else this.active = socket;
    socket.onmessage = (ev) => this.onMessage(socket, ev.data);
    socket.onerror = () => this.log.debug('The Twitch chat connection reported an error');
    socket.onclose = (ev) => this.onClose(socket, ev.code);
    // A connection that never says anything (not even the welcome) is given up on after the same wait as a quiet one.
    if (!continuation) this.armWatchdog();
  }

  private onClose(socket: SocketLike, code?: number): void {
    if (this.stopping) return;
    if (socket === this.pending) {
      this.pending = null;
      return;
    }
    if (socket !== this.active) return;
    this.log.debug(`The Twitch chat connection closed (${code ?? 'no code'})`);
    this.active = null;
    this.scheduleRetry('the connection closed');
  }

  private scheduleRetry(why: string): void {
    if (this.stopping) return;
    if (this.watchdog !== null) this.timers.clear(this.watchdog);
    this.watchdog = null;
    const base = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] as number;
    const wait = Math.round(base * (0.75 + this.random() * 0.5));
    this.attempt++;
    this.setState('reconnecting', why);
    this.log.info(`Twitch chat: ${why}; trying again in ${Math.round(wait / 1000)} s`);
    this.retry = this.timers.set(() => {
      this.retry = null;
      if (this.stopping) return;
      this.open(`${this.url}?keepalive_timeout_seconds=${KEEPALIVE_SECONDS}`, false);
    }, wait);
  }

  private fail(why: string): void {
    this.stopping = true;
    this.clearTimers();
    for (const s of [this.active, this.pending]) this.closeQuietly(s);
    this.active = null;
    this.pending = null;
    this.log.warn(`Twitch chat stopped: ${why}`);
    this.setState('failed', why);
  }

  private armWatchdog(): void {
    if (this.watchdog !== null) this.timers.clear(this.watchdog);
    this.watchdog = this.timers.set(() => {
      this.watchdog = null;
      if (this.stopping) return;
      this.log.debug('Nothing from Twitch chat for too long; reconnecting');
      const dead = this.active;
      this.active = null;
      this.closeQuietly(dead);
      this.scheduleRetry('Twitch went quiet');
    }, this.keepaliveMs);
  }

  private onMessage(socket: SocketLike, data: unknown): void {
    if (this.stopping) return;
    if (socket !== this.active && socket !== this.pending) return;
    let msg: Record<string, unknown>;
    try {
      msg = obj(JSON.parse(typeof data === 'string' ? data : String(data)));
    } catch {
      return;
    }
    const meta = obj(msg.metadata);
    const payload = obj(msg.payload);
    const type = str(meta.message_type);
    if (socket === this.active) this.armWatchdog();

    switch (type) {
      case 'session_welcome': {
        const session = obj(payload.session);
        const secs = Number(session.keepalive_timeout_seconds);
        if (Number.isFinite(secs) && secs > 0) this.keepaliveMs = secs * 1000 + KEEPALIVE_GRACE_MS;
        if (socket === this.pending) {
          // A move Twitch asked for: the new connection carries the same subscription, so there is nothing to ask again.
          const old = this.active;
          this.active = socket;
          this.pending = null;
          this.closeQuietly(old);
          this.armWatchdog();
          this.log.debug('Moved to the connection Twitch asked for');
          return;
        }
        const sessionId = str(session.id);
        if (!sessionId) {
          this.fail('Twitch sent a welcome without a session.');
          return;
        }
        void this.subscribe(socket, sessionId);
        return;
      }
      case 'notification': {
        const id = str(meta.message_id);
        if (id) {
          if (this.seen.has(id)) return;
          this.seen.add(id);
          if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
        }
        if (str(obj(payload.subscription).type) !== 'channel.chat.message') return;
        const event = chatEventOf(payload.event);
        if (event) this.opts.onChat(event);
        return;
      }
      case 'session_reconnect': {
        const url = str(obj(payload.session).reconnect_url);
        if (!/^wss:\/\/[a-z0-9.-]+\.twitch\.tv\//i.test(url)) {
          this.log.warn('Twitch asked for a move to an address that is not its own; ignoring it');
          return;
        }
        this.closeQuietly(this.pending);
        this.open(url, true);
        return;
      }
      case 'revocation': {
        const status = str(obj(payload.subscription).status);
        this.fail(status === 'authorization_revoked' ? 'Twitch says the access was taken back.' : `Twitch ended the chat subscription (${status || 'revoked'}).`);
        return;
      }
      default:
        return; // session_keepalive and anything new: the watchdog is already reset
    }
  }

  private async subscribe(socket: SocketLike, sessionId: string): Promise<void> {
    try {
      await this.opts.api.subscribeChat(sessionId, this.opts.broadcasterId, this.opts.userId);
    } catch (e) {
      if (this.stopping || socket !== this.active) return;
      if (e instanceof TwitchApiError && (e.kind === 'unauthorized' || e.kind === 'forbidden' || e.kind === 'bad-request')) {
        this.fail(
          e.kind === 'forbidden'
            ? "Twitch won't let the bot read this chat (it may be banned or timed out there)."
            : e.kind === 'unauthorized'
              ? 'Twitch does not accept the sign-in. Connect to Twitch again on the setup page.'
              : `Twitch refused the chat subscription: ${e.message}`,
        );
        return;
      }
      this.log.debug(`Could not subscribe to the chat: ${e instanceof Error ? e.message : String(e)}`);
      this.active = null;
      this.closeQuietly(socket);
      this.scheduleRetry('could not subscribe to the chat');
      return;
    }
    if (this.stopping || socket !== this.active) return;
    this.attempt = 0;
    this.setState('connected');
    this.log.info('Twitch chat: connected');
  }
}
