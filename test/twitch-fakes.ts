import type { SocketLike, Timers } from '../src/twitch/eventsub.js';

/* A pretend Twitch for the tests: its web addresses, its WebSocket, and a clock that only moves when told to. */

export const CLIENT = 'abcdefghij0123456789abcdefghij';

export interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Twitch's HTTP side. Everything that was asked is in `seen`; what it answers is set through the fields. */
export class FakeTwitchHttp {
  seen: Seen[] = [];
  /** Access tokens Twitch accepts, and whose they are. */
  valid = new Map<string, { login: string; userId: string; scopes: string[]; expiresIn: number }>();
  /** Refresh tokens Twitch accepts, and what each one is exchanged for. */
  refresh = new Map<string, { access: string; refresh: string }>();
  users: Record<string, { id: string; login: string; display_name: string }> = {};
  /** How the device flow goes. */
  approved: { access: string; refresh: string; scope: string[] } | null = null;
  deviceStatus = 200;
  deviceVerificationUri = 'https://www.twitch.tv/activate?public=true';
  tokenError: { status: number; message: string } | null = null;
  /** The next chat messages' fate. */
  sendResult: { sent: boolean; code?: string } = { sent: true };
  sendStatus = 200;
  subscribeStatus = 202;
  down = false;
  /** When set, a token handed out by a refresh is one Twitch then does not accept (to see what a second 401 does). */
  rejectRefreshed = false;
  /** Sent messages, in order. */
  chat: Array<{ broadcaster_id: string; sender_id: string; message: string; reply_parent_message_id?: string }> = [];
  subscriptions: Array<Record<string, unknown>> = [];
  revoked: string[] = [];
  sent = 0;
  /** How long (ms) each chat message takes to be accepted, one entry per message sent, to see whether replies go out in order. */
  chatDelays: number[] = [];

  fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError('fetch failed');
    const url = String((input as { url?: string }).url ?? input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw = typeof init?.body === 'string' ? init.body : null;
    let body: Record<string, unknown> | null = null;
    if (raw) {
      body = headers['content-type']?.includes('json') ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(raw));
    }
    this.seen.push({ method, url, headers, body });
    const u = new URL(url);

    if (u.host === 'id.twitch.tv') {
      if (u.pathname === '/oauth2/device') {
        if (this.deviceStatus !== 200) return json(this.deviceStatus, { status: this.deviceStatus, message: 'invalid client' });
        return json(200, { device_code: 'dev-code-1', user_code: 'ABCD-EFGH', verification_uri: this.deviceVerificationUri, expires_in: 1800, interval: 5 });
      }
      if (u.pathname === '/oauth2/token') {
        if (this.tokenError) return json(this.tokenError.status, { status: this.tokenError.status, message: this.tokenError.message });
        if (body?.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
          if (!this.approved) return json(400, { status: 400, message: 'authorization_pending' });
          const a = this.approved;
          this.valid.set(a.access, { login: 'kevinbot', userId: '555', scopes: a.scope, expiresIn: 14400 });
          return json(200, { access_token: a.access, refresh_token: a.refresh, expires_in: 14400, scope: a.scope, token_type: 'bearer' });
        }
        if (body?.grant_type === 'refresh_token') {
          const next = this.refresh.get(String(body.refresh_token));
          if (!next) return json(400, { status: 400, message: 'Invalid refresh token' });
          this.refresh.delete(String(body.refresh_token)); // a refresh token works once
          const info = [...this.valid.values()][0] ?? { login: 'kevinbot', userId: '555', scopes: ['user:read:chat', 'user:write:chat'], expiresIn: 14400 };
          if (!this.rejectRefreshed) this.valid.set(next.access, info);
          this.refresh.set(next.refresh, { access: `${next.access}+`, refresh: `${next.refresh}+` });
          return json(200, { access_token: next.access, refresh_token: next.refresh, expires_in: 14400, scope: info.scopes, token_type: 'bearer' });
        }
      }
      if (u.pathname === '/oauth2/validate') {
        const token = (headers.authorization ?? '').replace(/^(OAuth|Bearer) /, '');
        const info = this.valid.get(token);
        if (!info) return json(401, { status: 401, message: 'invalid access token' });
        return json(200, { client_id: CLIENT, login: info.login, user_id: info.userId, scopes: info.scopes, expires_in: info.expiresIn });
      }
      if (u.pathname === '/oauth2/revoke') {
        this.revoked.push(String(body?.token));
        return new Response(null, { status: 200 });
      }
    }

    if (u.host === 'api.twitch.tv') {
      const token = (headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.valid.has(token)) return json(401, { status: 401, message: 'Invalid OAuth token' });
      if (u.pathname === '/helix/users') {
        const found = this.users[u.searchParams.get('login') ?? ''];
        return json(200, { data: found ? [found] : [] });
      }
      if (u.pathname === '/helix/chat/messages') {
        this.sent++;
        if (this.sendStatus !== 200) return json(this.sendStatus, { status: this.sendStatus, message: this.sendStatus === 403 ? 'The sender is not permitted to send chat messages to the broadcaster\'s chat room.' : 'nope' }, this.sendStatus === 429 ? { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 20) } : {});
        const delay = this.chatDelays.shift() ?? 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        this.chat.push(body as never);
        return json(200, { data: [this.sendResult.sent ? { message_id: `m${this.chat.length}`, is_sent: true, drop_reason: null } : { message_id: '', is_sent: false, drop_reason: { code: this.sendResult.code ?? 'msg_duplicate', message: 'dropped' } }] });
      }
      if (u.pathname === '/helix/eventsub/subscriptions') {
        if (this.subscribeStatus !== 202) return json(this.subscribeStatus, { status: this.subscribeStatus, message: 'subscription missing proper authorization' });
        this.subscriptions.push(body as never);
        return json(202, { data: [{ id: 'sub1', status: 'enabled' }] });
      }
    }
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;
}

/** A WebSocket that does what the test says. */
export class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  /** Twitch sends this. */
  emit(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** The connection drops. */
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

export const sockets = () => {
  const made: FakeSocket[] = [];
  return { made, factory: (url: string): FakeSocket => (made.push(new FakeSocket(url)), made[made.length - 1] as FakeSocket) };
};

/** A clock and timers that move only when told to. */
export class FakeTimers implements Timers {
  now = 0;
  private next = 1;
  private list = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.list.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.list.delete(handle as number);
  }
  get pending(): number {
    return this.list.size;
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.list.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.list.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = end;
  }
}

/* What Twitch sends over the WebSocket. */
const meta = (type: string, id = `msg-${Math.random().toString(36).slice(2)}`) => ({ message_id: id, message_type: type, message_timestamp: '2026-11-18T12:00:00Z' });
export const welcome = (sessionId = 'sess-1', keepalive = 20) => ({ metadata: meta('session_welcome'), payload: { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: keepalive, reconnect_url: null } } });
export const keepalive = () => ({ metadata: meta('session_keepalive'), payload: {} });
export const reconnectTo = (url: string) => ({ metadata: meta('session_reconnect'), payload: { session: { id: 'sess-1', status: 'reconnecting', reconnect_url: url } } });
export const revocation = (status = 'authorization_revoked') => ({ metadata: meta('revocation'), payload: { subscription: { type: 'channel.chat.message', status } } });
export const chatMessage = (over: { id?: string; user?: string; userId?: string; name?: string; text: string; badges?: string[]; replyTo?: { id: string; login: string } }, messageId?: string) => ({
  metadata: meta('notification', messageId),
  payload: {
    subscription: { type: 'channel.chat.message' },
    event: {
      broadcaster_user_id: '100',
      chatter_user_id: over.userId ?? '900',
      chatter_user_login: over.user ?? 'viewer1',
      chatter_user_name: over.name ?? 'Viewer1',
      message_id: over.id ?? `chat-${Math.random().toString(36).slice(2)}`,
      message: { text: over.text, fragments: [] },
      message_type: 'text',
      badges: (over.badges ?? []).map((b) => ({ set_id: b, id: '1', info: '' })),
      reply: over.replyTo ? { parent_message_id: 'p1', parent_user_id: over.replyTo.id, parent_user_login: over.replyTo.login } : null,
    },
  },
});
