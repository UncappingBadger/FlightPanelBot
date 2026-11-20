import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * Current weather reports (METARs) from VATSIM's public METAR API (https://vatsim.dev/api/metar-api/get-metar), which needs no
 * account or key. It is read-only and only ever sent airport codes: nothing about a pilot, a server or an airline.
 *
 * `GET https://metar.vatsim.net/<ICAO>[,<ICAO>...]` answers plain text, one METAR to a line, each starting with its airport's code; an
 * airport it has no report for is simply not in the answer. The codes of any number of airports go in ONE request, comma-separated,
 * which is how it is asked: the service sits behind a rate limit that answers 429 with a `Retry-After` (a board that asked for each
 * of its dozens of airports separately was refused at once), so one request is made for everything wanted, and nothing at all is
 * asked while it has said to wait. (A code of three characters or fewer is a wildcard there, and `all` is every airport, so only full
 * four-character codes are ever asked for.) It tells caches to keep an answer for ten minutes, and so does this.
 */
export const VATSIM_METAR_API = 'https://metar.vatsim.net';

/** How long an answer is remembered: what the API itself asks of caches (Cache-Control: max-age=600). */
export const METAR_TTL_MS = 10 * 60_000;
const MAX_CACHE = 300;
const TIMEOUT_MS = 10_000;
/** The most airports in one request (a board has at most this many), which keeps the address short and the answer a few dozen kilobytes. */
export const MAX_AIRPORTS_PER_REQUEST = 50;
const MAX_BODY_BYTES = 120_000;
/** A real METAR is a few hundred characters at most; anything much longer is not one. */
const MAX_REPORT_CHARS = 800;
/** When VATSIM says it is busy without saying for how long, wait this long; and never wait longer than the ceiling, however long it asks. */
const DEFAULT_WAIT_MS = 60_000;
const MAX_WAIT_MS = 15 * 60_000;

/** VATSIM could not be asked, or answered in a way that makes no sense. `message` is safe to show. */
export class MetarError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'bad-response',
    message: string,
    /** When VATSIM said it was busy: how long it asked to be left alone, in milliseconds. */
    readonly retryAfterMs: number | null = null,
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

/** What `Retry-After` asks for, in milliseconds (seconds, or a date), within sensible bounds; the default when it says nothing usable. */
export function waitFromRetryAfter(header: string | null, now: number): number {
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(MAX_WAIT_MS, Math.ceil(seconds * 1000));
    const at = Date.parse(header);
    if (Number.isFinite(at) && at > now) return Math.min(MAX_WAIT_MS, at - now);
  }
  return DEFAULT_WAIT_MS;
}

const busyText = (waitMs: number): string => {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return `VATSIM's weather service is busy right now. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
};

export interface MetarClientOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  baseUrl?: string;
  /** Sent as the User-Agent so VATSIM can tell this app from a browser. Carries nothing about the user. */
  userAgent?: string;
}

/** What is known of an airport: its report, none (VATSIM has no report for it), or a report that could not be read. */
export type StationReport = string | null | MetarError;

/** Asks VATSIM for METARs, remembering answers for ten minutes so a busy server cannot flood it, and leaving it alone when it asks to be. */
export class MetarClient {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly base: string;
  private readonly userAgent: string;
  private readonly cache = new Map<string, { at: number; report: StationReport }>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** VATSIM asked to be left alone until then (epoch ms); nothing is requested before. */
  private blockedUntil = 0;

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
   * unchecked. An answer is reused for ten minutes unless `maxAgeMs` asks for a younger one.
   */
  async report(station: string, maxAgeMs: number = METAR_TTL_MS): Promise<string | null> {
    const r = (await this.reports([station], maxAgeMs)).get(station) ?? null;
    if (r instanceof MetarError) throw r;
    return r;
  }

  /**
   * The reports for several airports at once, in as few requests as possible: those not remembered (or older than `maxAgeMs`, which a board that
   * redraws every ten minutes sets a little under ten minutes, so the answer it reuses is never from its own last redraw) are asked for together,
   * in one request. An airport VATSIM has no report for is null; one whose report could not be read is the error. Throws a `MetarError` (kind
   * `unavailable`) when VATSIM could not be asked, or has asked to be left alone, in which case it is not asked.
   */
  async reports(stations: string[], maxAgeMs: number = METAR_TTL_MS): Promise<Map<string, StationReport>> {
    const unique = [...new Set(stations)];
    for (const s of unique) if (normalizeStation(s) !== s) throw new Error(`Not an airport code: ${s}`);
    const wanted: string[] = [];
    const waits: Array<Promise<void>> = [];
    for (const s of unique) {
      const cached = this.cache.get(s);
      if (cached && this.now() - cached.at < maxAgeMs) continue;
      const running = this.inFlight.get(s);
      if (running) waits.push(running);
      else wanted.push(s);
    }
    for (let i = 0; i < wanted.length; i += MAX_AIRPORTS_PER_REQUEST) {
      const chunk = wanted.slice(i, i + MAX_AIRPORTS_PER_REQUEST);
      const p = this.fetchBatch(chunk).finally(() => {
        for (const s of chunk) this.inFlight.delete(s);
      });
      for (const s of chunk) this.inFlight.set(s, p);
      await p;
    }
    await Promise.all(waits);
    const out = new Map<string, StationReport>();
    for (const s of unique) out.set(s, this.cache.get(s)?.report ?? null);
    return out;
  }

  private remember(station: string, report: StationReport): void {
    if (this.cache.size >= MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(station, { at: this.now(), report });
  }

  private async fetchBatch(stations: string[]): Promise<void> {
    const now = this.now();
    if (now < this.blockedUntil) throw new MetarError('unavailable', busyText(this.blockedUntil - now), this.blockedUntil - now);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/${stations.join(',')}`, {
        headers: { accept: 'text/plain', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      this.log.debug(`VATSIM METAR (${stations.length} airport${stations.length === 1 ? '' : 's'}) failed: ${e instanceof Error ? e.message : e}`);
      throw new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      for (const s of stations) this.remember(s, null);
      return;
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const wait = waitFromRetryAfter(res.headers.get('retry-after'), now);
      this.blockedUntil = now + wait;
      this.log.warn(`VATSIM's weather service says it is busy (HTTP 429): not asking again for ${Math.ceil(wait / 1000)} seconds`);
      throw new MetarError('unavailable', busyText(wait), wait);
    }
    if (!res.ok) {
      this.log.debug(`VATSIM METAR answered HTTP ${res.status}`);
      await res.body?.cancel().catch(() => undefined);
      throw new MetarError('unavailable', `VATSIM's weather service is having trouble right now (HTTP ${res.status}).`);
    }
    this.blockedUntil = 0;
    const body = await readTextCapped(res, MAX_BODY_BYTES).catch(() => '');
    if (body === null) throw new MetarError('bad-response', 'VATSIM sent far more than I expected.');
    for (const s of stations) {
      try {
        this.remember(s, pickReport(body, s));
      } catch (e) {
        if (!(e instanceof MetarError)) throw e;
        this.remember(s, e);
      }
    }
  }
}
