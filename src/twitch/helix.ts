import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * The few Twitch API calls the bot makes (https://dev.twitch.tv/docs/api/reference/): find a channel by its name, send a chat message, and
 * subscribe to a chat. Everything goes to api.twitch.tv with the bot's own sign-in, with a 401 answered by one refresh and one retry.
 */
export const TWITCH_API = 'https://api.twitch.tv/helix';

const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 200_000;
/** Twitch refuses a chat message longer than this many characters. */
export const MAX_MESSAGE_CHARS = 500;

export type TwitchApiKind = 'unauthorized' | 'forbidden' | 'rate-limited' | 'unavailable' | 'bad-request' | 'bad-response';

export class TwitchApiError extends Error {
  constructor(
    readonly kind: TwitchApiKind,
    message: string,
    /** For `rate-limited`: how long Twitch said to wait. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TwitchApiError';
  }
}

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
}

export interface SendResult {
  sent: boolean;
  messageId: string | null;
  /** Why Twitch did not send it (`msg_duplicate`, `slow_mode`, `automod_held`, ...), when it did not. */
  dropCode: string | null;
}

/** What the API needs of the sign-in. */
export interface TokenSource {
  clientId: string;
  accessToken(): Promise<string>;
  refreshNow(): Promise<string>;
}

export interface TwitchApiOptions {
  tokens: TokenSource;
  fetchFn?: typeof fetch;
  logger?: Logger;
  base?: string;
  now?: () => number;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class TwitchApi {
  private readonly tokens: TokenSource;
  private readonly fetchFn: typeof fetch;
  private readonly log: Logger;
  private readonly base: string;
  private readonly now: () => number;

  constructor(opts: TwitchApiOptions) {
    this.tokens = opts.tokens;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger ?? silentLogger;
    this.base = (opts.base ?? TWITCH_API).replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
  }

  /** A channel's account by its login name, or null when there is no such account. */
  async userByLogin(login: string): Promise<TwitchUser | null> {
    const name = login.trim().replace(/^#/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(name)) return null;
    const { json } = await this.call('GET', `/users?login=${encodeURIComponent(name)}`);
    const first = obj((Array.isArray(obj(json).data) ? (obj(json).data as unknown[])[0] : undefined) ?? {});
    const id = str(first.id);
    if (!/^\d{1,20}$/.test(id)) return null;
    return { id, login: str(first.login).toLowerCase() || name, displayName: str(first.display_name) || str(first.login) || name };
  }

  /** Send a message to a channel's chat as the signed-in account, as a reply to one message if `replyTo` is given. */
  async sendMessage(broadcasterId: string, senderId: string, message: string, replyTo?: string): Promise<SendResult> {
    const text = message.slice(0, MAX_MESSAGE_CHARS);
    const body: Record<string, string> = { broadcaster_id: broadcasterId, sender_id: senderId, message: text };
    if (replyTo) body.reply_parent_message_id = replyTo;
    const { json } = await this.call('POST', '/chat/messages', body);
    const first = obj((Array.isArray(obj(json).data) ? (obj(json).data as unknown[])[0] : undefined) ?? {});
    const sent = first.is_sent === true;
    return { sent, messageId: str(first.message_id) || null, dropCode: sent ? null : str(obj(first.drop_reason).code) || 'unknown' };
  }

  /** Ask for the chat messages of a channel, over the WebSocket session `sessionId` (it has to be asked within 10 seconds of connecting). */
  async subscribeChat(sessionId: string, broadcasterId: string, userId: string): Promise<void> {
    await this.call('POST', '/eventsub/subscriptions', {
      type: 'channel.chat.message',
      version: '1',
      condition: { broadcaster_user_id: broadcasterId, user_id: userId },
      transport: { method: 'websocket', session_id: sessionId },
    });
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<{ status: number; json: unknown }> {
    const token = await this.tokens.accessToken();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'client-id': this.tokens.clientId, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new TwitchApiError('unavailable', "I couldn't reach Twitch right now.");
    }
    const text = await readTextCapped(res, MAX_BODY_CHARS).catch(() => null);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* judged by the status */
    }
    if (res.ok) return { status: res.status, json };

    const why = str(obj(json).message);
    if (res.status === 401 && !retried) {
      this.log.debug('Twitch said the access token is no good; refreshing it once');
      await this.tokens.refreshNow();
      return this.call(method, path, body, true);
    }
    if (res.status === 401) throw new TwitchApiError('unauthorized', 'Twitch does not accept the sign-in.');
    if (res.status === 403) throw new TwitchApiError('forbidden', why || 'Twitch will not let the bot do that here.');
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const waitMs = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - this.now()) : 30_000;
      throw new TwitchApiError('rate-limited', 'Twitch asked the bot to slow down.', Math.min(waitMs, 120_000));
    }
    if (res.status === 400 || res.status === 422 || res.status === 409) throw new TwitchApiError('bad-request', why || `Twitch refused the request (${res.status}).`);
    throw new TwitchApiError('unavailable', `Twitch is having trouble (HTTP ${res.status}).`);
  }
}
