import { readTextCapped } from '../util/http.js';

/**
 * Twitch sign-in, for an app that runs on somebody's own computer: the device code flow. The app shows a short code, the person types it at
 * Twitch's own page and says yes, and the app is handed a token. No password and no pasted token ever goes through the app, and the person
 * can take the access back at any time in their Twitch settings (Connections). It needs only the app's public Client ID, no secret.
 * https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
 *
 * Only plain requests to id.twitch.tv are made here, and nothing about anyone is sent but the Client ID, the scopes asked for, and the codes
 * and tokens Twitch itself handed out.
 */
export const TWITCH_ID = 'https://id.twitch.tv';

/** What the bot asks to be allowed: to read the chat it is in, and to write to it. Nothing else. */
export const CHAT_SCOPES = ['user:read:chat', 'user:write:chat'] as const;

const TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 100_000;

export type TwitchAuthKind =
  /** The person said no. */
  | 'denied'
  /** The code ran out, or was already used. */
  | 'expired'
  /** The refresh token or the Client ID is not accepted: the person has to connect again. */
  | 'invalid'
  /** Twitch could not be reached, or is having trouble: worth trying again. */
  | 'unavailable'
  | 'bad-response';

/** Sign-in failed. `message` is safe to show. */
export class TwitchAuthError extends Error {
  constructor(
    readonly kind: TwitchAuthKind,
    message: string,
  ) {
    super(message);
    this.name = 'TwitchAuthError';
  }
}

export interface DeviceCode {
  deviceCode: string;
  /** What the person types. */
  userCode: string;
  /** Where they type it. */
  verificationUri: string;
  expiresInSec: number;
  /** How many seconds to leave between asking whether they have finished. */
  intervalSec: number;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scopes: string[];
}

export interface TokenInfo {
  clientId: string;
  login: string;
  userId: string;
  scopes: string[];
  expiresInSec: number;
}

type Fetch = typeof fetch;

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function post(url: string, form: Record<string, string>, fetchFn: Fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new TwitchAuthError('unavailable', "I couldn't reach Twitch right now.");
  }
  const text = await readTextCapped(res, MAX_BODY_CHARS).catch(() => null);
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    /* judged by the status below */
  }
  return { status: res.status, json };
}

/** Step one: ask Twitch for a code for the person to type. */
export async function startDeviceFlow(clientId: string, scopes: readonly string[], fetchFn: Fetch = fetch): Promise<DeviceCode> {
  const { status, json } = await post(`${TWITCH_ID}/oauth2/device`, { client_id: clientId, scopes: scopes.join(' ') }, fetchFn);
  if (status >= 500) throw new TwitchAuthError('unavailable', 'Twitch is having trouble right now.');
  if (status !== 200) throw new TwitchAuthError('invalid', "Twitch didn't accept this app's Client ID. Check it, and that the Twitch application is of the Public type.");
  const deviceCode = str(json.device_code);
  const userCode = str(json.user_code);
  const verificationUri = str(json.verification_uri);
  // The address is shown and opened, so only a plain Twitch address is accepted.
  if (!deviceCode || !userCode || !/^https:\/\/([a-z0-9-]+\.)?twitch\.tv(\/|$)/i.test(verificationUri)) throw new TwitchAuthError('bad-response', 'Twitch sent a sign-in code I could not use.');
  return { deviceCode, userCode, verificationUri, expiresInSec: positive(json.expires_in, 1800), intervalSec: Math.max(1, positive(json.interval, 5)) };
}

function tokenSetOf(json: Record<string, unknown>): TokenSet {
  const accessToken = str(json.access_token);
  const refreshToken = str(json.refresh_token);
  if (!accessToken || !refreshToken) throw new TwitchAuthError('bad-response', 'Twitch sent a sign-in I could not read.');
  const scopes = Array.isArray(json.scope) ? json.scope.filter((s): s is string => typeof s === 'string') : [];
  return { accessToken, refreshToken, expiresInSec: positive(json.expires_in, 14_400), scopes };
}

/**
 * Step two, asked every `interval` seconds: has the person finished? `null` means not yet. Throws `denied` if they said no and `expired`
 * if the code ran out or was used.
 */
export async function pollDeviceFlow(clientId: string, scopes: readonly string[], deviceCode: string, fetchFn: Fetch = fetch): Promise<TokenSet | null> {
  const { status, json } = await post(
    `${TWITCH_ID}/oauth2/token`,
    { client_id: clientId, scopes: scopes.join(' '), device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' },
    fetchFn,
  );
  if (status === 200) return tokenSetOf(json);
  const why = `${str(json.message)} ${str(json.error)}`.toLowerCase();
  if (status >= 500) throw new TwitchAuthError('unavailable', 'Twitch is having trouble right now.');
  if (why.includes('authorization_pending') || why.includes('slow_down')) return null;
  if (why.includes('access_denied') || why.includes('denied')) throw new TwitchAuthError('denied', 'Twitch said the sign-in was refused.');
  if (why.includes('expired') || why.includes('invalid device code') || why.includes('device_code')) throw new TwitchAuthError('expired', 'That sign-in code ran out. Start again.');
  throw new TwitchAuthError('invalid', "Twitch didn't accept the sign-in. Start again.");
}

/**
 * A new access token from a refresh token. A refresh token works once: the answer holds the next one, which has to be kept. Throws
 * `invalid` when Twitch no longer accepts it (the person disconnected the app, changed their password, or it went unused for 30 days),
 * and the person has to connect again.
 */
export async function refreshTokens(clientId: string, refreshToken: string, fetchFn: Fetch = fetch): Promise<TokenSet> {
  const { status, json } = await post(`${TWITCH_ID}/oauth2/token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }, fetchFn);
  if (status === 200) return tokenSetOf(json);
  if (status >= 500 || status === 429) throw new TwitchAuthError('unavailable', 'Twitch is having trouble right now.');
  throw new TwitchAuthError('invalid', 'Twitch no longer accepts the saved sign-in. Connect to Twitch again on the setup page.');
}

/** Tell Twitch the access is no longer wanted (Disconnect). Best effort: the saved sign-in is deleted whether or not this reaches Twitch. */
export async function revokeToken(clientId: string, token: string, fetchFn: Fetch = fetch): Promise<void> {
  try {
    await post(`${TWITCH_ID}/oauth2/revoke`, { client_id: clientId, token }, fetchFn);
  } catch {
    /* nothing more to do */
  }
}

/** Who a token belongs to and what it may do, or null when Twitch does not accept it (401). Twitch asks apps to do this at start and every hour. */
export async function validateToken(accessToken: string, fetchFn: Fetch = fetch): Promise<TokenInfo | null> {
  let res: Response;
  try {
    res = await fetchFn(`${TWITCH_ID}/oauth2/validate`, { headers: { authorization: `OAuth ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
  } catch {
    throw new TwitchAuthError('unavailable', "I couldn't reach Twitch right now.");
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new TwitchAuthError('unavailable', 'Twitch is having trouble right now.');
  }
  const text = await readTextCapped(res, MAX_BODY_CHARS).catch(() => null);
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    throw new TwitchAuthError('bad-response', 'Twitch sent an answer I could not read.');
  }
  const userId = str(json.user_id);
  const login = str(json.login);
  if (!userId || !login) throw new TwitchAuthError('bad-response', 'That token does not belong to a Twitch user.');
  return {
    clientId: str(json.client_id),
    login: login.toLowerCase(),
    userId,
    scopes: Array.isArray(json.scopes) ? json.scopes.filter((s): s is string => typeof s === 'string') : [],
    expiresInSec: positive(json.expires_in, 0),
  };
}
