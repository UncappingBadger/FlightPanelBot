import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { silentLogger, type Logger } from '../util/log.js';
import { refreshTokens, TwitchAuthError, validateToken, type TokenInfo } from './oauth.js';

/**
 * The Twitch sign-in the host chose to give the bot, kept in a file of its own on this computer (like the Google key), never in the log
 * and never sent back to the setup page. Deleting the file, or pressing Disconnect, takes the bot out of Twitch.
 */
export interface TwitchTokens {
  /** The Client ID the sign-in was made with (refreshing needs the same one). */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token runs out, epoch ms. */
  expiresAt: number;
  /** The Twitch account the bot speaks as. */
  userId: string;
  login: string;
  scopes: string[];
}

const Schema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite(),
  userId: z.string().regex(/^\d{1,20}$/),
  login: z.string().min(1).max(40),
  scopes: z.array(z.string()).default([]),
});

export function readTokens(file: string): TwitchTokens | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = Schema.safeParse(JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeTokens(file: string, tokens: TwitchTokens): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(tokens, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, file);
}

export function removeTokens(file: string): void {
  rmSync(file, { force: true });
}

/** Refresh this long before an access token runs out, so a call never goes out with one that is about to. */
const REFRESH_EARLY_MS = 120_000;

export interface TokenManagerOptions {
  file: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  /** Called once if Twitch stops accepting the sign-in: the person has to connect again. */
  onLost?: (why: string) => void;
}

/**
 * Keeps the access token fresh. Only one refresh is ever in flight (a refresh token works once, so two at the same time would lose the
 * sign-in), and the new refresh token is saved before anything uses it. The bot process is the only one that does this.
 */
export class TokenManager {
  private tokens: TwitchTokens;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private inflight: Promise<string> | null = null;
  private lost = false;

  constructor(private readonly opts: TokenManagerOptions, initial: TwitchTokens) {
    this.tokens = initial;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
  }

  get clientId(): string {
    return this.tokens.clientId;
  }
  get userId(): string {
    return this.tokens.userId;
  }
  get login(): string {
    return this.tokens.login;
  }
  get hasLost(): boolean {
    return this.lost;
  }

  /** An access token that is good for at least a couple of minutes, refreshing first if it is not. */
  async accessToken(): Promise<string> {
    if (this.lost) throw new TwitchAuthError('invalid', 'The Twitch sign-in is no longer accepted.');
    if (this.tokens.expiresAt - this.now() > REFRESH_EARLY_MS) return this.tokens.accessToken;
    return this.refreshNow();
  }

  /** Get a new access token now (Twitch said 401, or it is about to run out). */
  refreshNow(): Promise<string> {
    if (this.lost) return Promise.reject(new TwitchAuthError('invalid', 'The Twitch sign-in is no longer accepted.'));
    this.inflight ??= this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<string> {
    try {
      const set = await refreshTokens(this.tokens.clientId, this.tokens.refreshToken, this.fetchFn);
      this.tokens = {
        ...this.tokens,
        accessToken: set.accessToken,
        refreshToken: set.refreshToken,
        expiresAt: this.now() + set.expiresInSec * 1000,
        scopes: set.scopes.length > 0 ? set.scopes : this.tokens.scopes,
      };
      writeTokens(this.opts.file, this.tokens);
      this.log.debug('Refreshed the Twitch sign-in');
      return this.tokens.accessToken;
    } catch (e) {
      if (e instanceof TwitchAuthError && e.kind === 'invalid') this.markLost(e.message);
      throw e;
    }
  }

  /** Only ever reached from the one refresh that is in flight, and once lost nothing refreshes again, so it is said once. */
  private markLost(why: string): void {
    this.lost = true;
    this.opts.onLost?.(why);
  }

  /** Twitch asks apps to check their token when they start and every hour: false, and the sign-in is lost, if it is not accepted any more. */
  async validate(): Promise<TokenInfo | null> {
    const token = await this.accessToken();
    const info = await validateToken(token, this.fetchFn);
    if (info === null) {
      // Perhaps only the access token ran out: the refresh token gets one try, and it is the one that says whether the sign-in is gone.
      const fresh = await this.refreshNow();
      return validateToken(fresh, this.fetchFn);
    }
    return info;
  }
}
