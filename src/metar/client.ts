import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * Current weather reports (METARs) from VATSIM's public METAR API (https://vatsim.dev/api/metar-api/get-metar), which needs no
 * account or key. It is read-only and only ever sent an airport code: nothing about a pilot, a server or an airline.
 *
 * `GET https://metar.vatsim.net/<ICAO>` answers plain text, one METAR to a line, each starting with its airport's code, or an
 * empty answer when it has no report for that code. (A code of three characters or fewer is a wildcard there, and `all` is every
 * airport, so only a full four-character code is ever asked for.) It tells caches to keep an answer for ten minutes, and so does
 * this.
 */
export const VATSIM_METAR_API = 'https://metar.vatsim.net';

/** How long an answer is remembered: what the API itself asks of caches (Cache-Control: max-age=600). */
export const METAR_TTL_MS = 10 * 60_000;
const MAX_CACHE = 300;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 20_000;
/** A real METAR is a few hundred characters at most; anything much longer is not one. */
const MAX_REPORT_CHARS = 800;

/** VATSIM could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class MetarError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'bad-response',
    message: string,
  ) {
    super(message);
    this.name = 'MetarError';
  }
}

/**
 * A four-character airport code (ICAO), letters and digits, upper-cased; null for anything else. The API treats three characters
 * or fewer as "every airport starting with these", which is never what someone asking about one airport means, so it is not allowed.
 */
export function normalizeStation(input: string): string | null {
  const code = input.trim().toUpperCase();
  return /^[A-Z0-9]{4}$/.test(code) ? code : null;
}

/**
 * The report for `station` out of what the API sent: the line that starts with that code, cleaned (one line, no control
 * characters, single spaces), or null when there is none.
 */
export function pickReport(body: string, station: string): string | null {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (line.split(' ')[0]?.toUpperCase() !== station) continue;
    if (line.length > MAX_REPORT_CHARS) throw new MetarError('bad-response', 'VATSIM sent a weather report I could not read.');
    return line;
  }
  return null;
}

export interface MetarClientOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  baseUrl?: string;
  /** Sent as the User-Agent so VATSIM can tell this app from a browser. Carries nothing about the user. */
  userAgent?: string;
}

/** Asks VATSIM for METARs, remembering answers for ten minutes so a busy server cannot flood it. */
export class MetarClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly base: string;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { at: number; report: string | null }>();
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(opts: MetarClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.base = (opts.baseUrl ?? VATSIM_METAR_API).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
  }

  /**
   * The current METAR for an airport, as a line starting with its code (`EGLL 161350Z 26008KT ...`), or null if VATSIM has none
   * for it. `station` must already be a valid code (see `normalizeStation`), so nothing a person types is put into the address
   * unchecked.
   */
  report(station: string): Promise<string | null> {
    if (normalizeStation(station) !== station) return Promise.reject(new Error(`Not an airport code: ${station}`));
    const cached = this.cache.get(station);
    if (cached && this.now() - cached.at < METAR_TTL_MS) return Promise.resolve(cached.report);
    const running = this.inFlight.get(station);
    if (running) return running;
    const p = this.fetchReport(station)
      .then((report) => {
        if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
        this.cache.set(station, { at: this.now(), report });
        return report;
      })
      .finally(() => {
        this.inFlight.delete(station);
      });
    this.inFlight.set(station, p);
    return p;
  }

  private async fetchReport(station: string): Promise<string | null> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/${station}`, {
        headers: { accept: 'text/plain', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      this.log.debug(`VATSIM METAR ${station} failed: ${e instanceof Error ? e.message : e}`);
      throw new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      this.log.debug(`VATSIM METAR ${station} answered HTTP ${res.status}`);
      throw new MetarError('unavailable', res.status === 429 ? "VATSIM's weather service is busy right now. Try again in a minute." : `VATSIM's weather service is having trouble right now (HTTP ${res.status}).`);
    }
    const body = await readTextCapped(res, MAX_BODY_BYTES).catch(() => '');
    if (body === null) throw new MetarError('bad-response', 'VATSIM sent far more than I expected.');
    return pickReport(body, station);
  }
}
