import { FsHubClient, FsHubError } from '../fshub/client.js';
import { normalizeToken } from './settings.js';

/** The result of asking a service whether a token works. `unknown` means we couldn't tell (offline, say). */
export type TokenCheck =
  | { status: 'ok'; name?: string; id?: string }
  | { status: 'rejected'; message: string }
  | { status: 'unknown'; message: string };

const TIMEOUT_MS = 12_000;

/** Ask Discord who a bot token belongs to. A wrong token is rejected; no network is "unknown". */
export async function checkDiscordToken(token: string, fetchFn: typeof fetch = fetch): Promise<TokenCheck> {
  try {
    const res = await fetchFn('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bot ${normalizeToken(token)}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) return { status: 'rejected', message: 'Discord says that token is not valid. Press Reset Token on the Bot tab and copy the new one.' };
    if (!res.ok) return { status: 'unknown', message: `Discord answered with an error (HTTP ${res.status}).` };
    const body = (await res.json().catch(() => null)) as { id?: unknown; username?: unknown } | null;
    return { status: 'ok', id: typeof body?.id === 'string' ? body.id : undefined, name: typeof body?.username === 'string' ? body.username : undefined };
  } catch {
    return { status: 'unknown', message: "I couldn't reach Discord to check the token." };
  }
}

/** Ask FsHub whose token this is. A token FsHub does not accept is rejected; no network is "unknown". */
export async function checkFsHubToken(token: string, fetchFn: typeof fetch = fetch): Promise<TokenCheck> {
  try {
    const account = await new FsHubClient({ token, fetchFn }).account();
    return { status: 'ok', name: account.name, id: String(account.id) };
  } catch (e) {
    if (e instanceof FsHubError && (e.kind === 'rejected' || e.kind === 'no-access')) {
      return { status: 'rejected', message: "FsHub says that token is not valid. Make a new one at fshub.io/settings/integrations and paste that." };
    }
    return { status: 'unknown', message: e instanceof FsHubError ? `${e.message} I saved the token anyway.` : "I couldn't reach FsHub to check the token. I saved it anyway." };
  }
}
