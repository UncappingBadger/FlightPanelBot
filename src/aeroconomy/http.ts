import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

export const AEROCONOMY_API = 'https://aeroconomy.com/api/v1';

const TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 4_000_000;

/** Aeroconomy could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class AeroconomyError extends Error {
  constructor(
    message: string,
    /** The HTTP status Aeroconomy answered with, when this is about an answer (403 is "not yours to see"); null otherwise. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AeroconomyError';
  }
}

export interface AeroHttpOptions {
  fetchFn?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
  baseUrl?: string;
  /** The least time between two requests. Tests set it to 0. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * The one way the bot talks to Aeroconomy: plain GETs of JSON, to one fixed address, one request at a time, slowly (Aeroconomy limits how
 * fast it can be asked), waiting out a 429, never following a redirect (so a credential can never be sent anywhere else), and never
 * reading more than a few megabytes. A request carries a bearer token only when the caller hands it one for that request.
 */
export abstract class AeroHttp {
  protected readonly fetchFn: typeof fetch;
  protected readonly log: Logger;
  private readonly userAgent: string;
  private readonly base: string;
  private readonly gapMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  protected readonly now: () => number;
  private lastAt = 0;

  protected constructor(opts: AeroHttpOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.log = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
    this.base = (opts.baseUrl ?? AEROCONOMY_API).replace(/\/+$/, '');
    this.gapMs = opts.gapMs ?? 2500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** The JSON at a path, or null for a 404. Anything else that is not a good answer throws. Waits its turn, and out a 429. */
  protected async fetchJson(path: string, bearer?: string): Promise<unknown | null> {
    for (let attempt = 1; ; attempt++) {
      const wait = this.lastAt + this.gapMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastAt = this.now();

      let res: Response;
      try {
        res = await this.fetchFn(`${this.base}${path}`, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'application/json', 'user-agent': this.userAgent, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw new AeroconomyError(`Aeroconomy could not be reached (${e instanceof Error ? e.name : 'error'}).`);
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const asked = Number(res.headers.get('retry-after'));
        const seconds = Math.min(60, Number.isFinite(asked) && asked > 0 ? asked : 20 * attempt);
        if (attempt >= 3) throw new AeroconomyError('Aeroconomy asked me to slow down, and still did after waiting.');
        this.log.debug(`Aeroconomy said slow down; waiting ${seconds} seconds`);
        await this.sleep(seconds * 1000);
        this.lastAt = this.now();
        continue;
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new AeroconomyError(
          res.status === 401
            ? 'Aeroconomy did not accept the FsHub token, so I could not read the airline\'s aircraft.'
            : "Aeroconomy won't show that to the account the FsHub token belongs to.",
          res.status,
        );
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new AeroconomyError(`Aeroconomy answered ${res.status}.`, res.status);
      }
      const text = await readTextCapped(res, MAX_BODY_BYTES);
      if (text === null) throw new AeroconomyError('Aeroconomy sent far more than expected.');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new AeroconomyError('Aeroconomy did not send JSON.');
      }
    }
  }
}
