import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** The only two things the bot needs from a Google service account key file. */
export interface ServiceAccount {
  /** The account's address. A sheet owner shares the sheet with this to let the bot edit it. */
  email: string;
  privateKey: string;
}

/** Where Google issues access tokens. Fixed here, never taken from the key file. */
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/**
 * Read a service account key from its JSON text. `label` says where it came from, for the error
 * message. Throws a plain-English Error that never repeats the key's contents.
 */
export function parseServiceAccount(raw: string, label: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${label} isn't valid JSON. It should be the key file downloaded from Google Cloud.`);
  }
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const email = o.client_email;
  const key = o.private_key;
  if (typeof email !== 'string' || !email.includes('@') || typeof key !== 'string' || !key.includes('PRIVATE KEY')) {
    throw new Error(`${label} doesn't look like a service account key: it needs client_email and private_key.`);
  }
  return { email, privateKey: key };
}

/** Read a service account key (the JSON file Google lets you download). Throws a plain-English Error if it can't be used. */
export function loadServiceAccount(path: string): ServiceAccount {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_FILE points at "${path}", but I can't read that file.`);
  }
  return parseServiceAccount(raw, `GOOGLE_SERVICE_ACCOUNT_FILE ("${path}")`);
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

/** A signed request for an access token (RFC 7523), valid for an hour. */
export function signJwt(account: ServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: account.email, scope: SHEETS_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(account.privateKey);
  return `${header}.${claims}.${b64url(signature)}`;
}

export type TokenProvider = () => Promise<string>;

/** Thrown when Google refuses to give the bot an access token. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

/**
 * Hands out access tokens, asking Google for a new one only when the last is about to expire. Calls
 * made at the same moment share one request.
 */
export function tokenProvider(account: ServiceAccount, fetchFn: typeof fetch = fetch, now: () => number = Date.now): TokenProvider {
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const fetchToken = async (): Promise<string> => {
    let res: Response;
    try {
      res = await fetchFn(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(account, now()) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GoogleAuthError("I couldn't reach Google to sign in.");
    }
    if (!res.ok) throw new GoogleAuthError(`Google refused the service account's sign-in (HTTP ${res.status}). Is the key still valid?`);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== 'string') throw new GoogleAuthError('Google answered the sign-in with something I did not understand.');
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    cached = { token: body.access_token, expiresAt: now() + lifetime * 1000 };
    return body.access_token;
  };

  return async () => {
    if (cached && cached.expiresAt - now() > 60_000) return cached.token;
    inflight ??= fetchToken().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
