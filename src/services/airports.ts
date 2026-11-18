import type { AirportCoord, Store } from '../db/store.js';
import { parseCsv } from '../jobs/import.js';
import { readTextCapped } from '../util/http.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * Where airports are, for working out a distance. The positions come from OurAirports (https://ourairports.com), whose data is
 * released into the public domain. The bot downloads its airport list and keeps the position of every airport in it that has a code a
 * flight could use (about 35,000, a few megabytes in the bot's own database), so once the list has been read no airport has to be looked
 * up one at a time, and one part of the bot reading the list can never leave another part short of the airports it wanted. Nothing about a
 * pilot, a server or an airline is ever sent: it is a plain download of a public file.
 */
export const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

const MAX_BYTES = 40_000_000;
const TIMEOUT_MS = 90_000;
/** Having read the list in full, do not read it again for an airport it turned out not to have until this long has passed. */
const RECHECK_MS = 12 * 3_600_000;
/** The list is never read twice within this long. */
const MIN_GAP_MS = 10 * 60_000;
/** After a failed download, wait this long. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

const KV_FETCHED = 'airports.fetched_at';
const KV_FAILED = 'airports.failed_at';
/** When the list was last read in full (every airport kept). A read made by an earlier version kept only the airports asked about, and does not count. */
const KV_FULL = 'airports.full_at';

/** The kinds of airport kept whatever was asked; an airport of another kind (a heliport, a seaplane base) is kept when somebody asks for it by its code. */
const KEPT_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);
const CODE = /^[A-Z0-9]{2,5}$/;

export interface AirportDirectoryOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  logger?: Logger;
  userAgent?: string;
  url?: string;
}

export class AirportDirectory {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly userAgent: string;
  private readonly url: string;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    opts: AirportDirectoryOptions = {},
  ) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.userAgent = opts.userAgent ?? 'FlightPanelBot';
    this.url = opts.url ?? AIRPORTS_URL;
  }

  /**
   * The positions of these airports (by ICAO code), those the bot could find. An airport it does not know is read from the downloaded
   * list, and the whole list is kept when it is read, so everything is known after one read, whoever asked. A code that is not in the
   * list is not looked for again until half a day after the last read, so one that is not an airport does not make the bot download it
   * again every minute. The list is never read twice within ten minutes.
   */
  async coords(codes: string[]): Promise<Map<string, AirportCoord>> {
    const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => CODE.test(c)))];
    let known = this.store.getAirportCoords(wanted);
    const missing = wanted.filter((c) => !known.has(c));
    if (missing.length === 0) return known;
    const decision = this.mayRead();
    if (DEBUG_BUILD) dbg(this.log, `airports: no position for ${missing.length} of ${wanted.length} wanted (${missing.slice(0, 20).join(' ')}${missing.length > 20 ? ' ...' : ''}): ${decision.read ? 'reading the public list' : 'not reading the list'} because ${decision.why}`);
    if (!decision.read) return known;
    try {
      this.loading ??= this.load(missing).finally(() => {
        this.loading = null;
      });
      await this.loading;
    } catch (e) {
      this.store.setKv(KV_FAILED, String(this.now()));
      this.log.warn(`Could not read the airport list (${e instanceof Error ? e.message : e}); flight times from distances are unavailable for now`);
      return known;
    }
    known = this.store.getAirportCoords(wanted);
    return known;
  }

  private mayRead(): { read: boolean; why: string } {
    const now = this.now();
    const failed = Number(this.store.getKv(KV_FAILED) ?? 0);
    if (failed > 0 && now - failed < RETRY_AFTER_FAILURE_MS) return { read: false, why: `the last download failed ${Math.round((now - failed) / 60_000)} minute(s) ago and it waits an hour` };
    const fetched = Number(this.store.getKv(KV_FETCHED) ?? 0);
    if (!(fetched > 0)) return { read: true, why: 'the list has never been read' };
    const age = now - fetched;
    if (age < MIN_GAP_MS) return { read: false, why: `the list was read ${Math.round(age / 1000)} second(s) ago and is never read twice within ${MIN_GAP_MS / 60_000} minutes` };
    const full = Number(this.store.getKv(KV_FULL) ?? 0);
    if (!(full > 0)) return { read: true, why: 'an earlier version read the list only for the airports asked about, so it is read for all of them now' };
    if (now - full >= RECHECK_MS) return { read: true, why: `the list was last read in full ${Math.round((now - full) / 3_600_000)} hour(s) ago, so airports it did not have are looked for again` };
    return { read: false, why: `the list was read in full ${Math.round((now - full) / 60_000)} minute(s) ago and these are not in it (it looks again after ${RECHECK_MS / 3_600_000} hours)` };
  }

  private async load(missing: string[]): Promise<void> {
    const res = await this.fetchFn(this.url, {
      headers: { 'user-agent': this.userAgent, accept: 'text/csv,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readTextCapped(res, MAX_BYTES);
    if (text === null) throw new Error('the list is larger than expected');
    const everything = pickEveryAirport(text);
    if (everything === null) throw new Error('the list is not in the expected format');
    // An airport of another kind that somebody asked for by its code is kept too.
    const byCode = new Map(everything.map((a) => [a.code, a]));
    for (const a of pickAirports(text, new Set(missing)) ?? []) byCode.set(a.code, a);
    this.store.saveAirportCoords([...byCode.values()]);
    this.store.setKv(KV_FULL, String(this.now()));
    this.store.setKv(KV_FETCHED, String(this.now()));
    this.store.setKv(KV_FAILED, '0');
    this.log.info(`Read the airport list: found ${missing.filter((c) => byCode.has(c)).length} of ${missing.length} airport(s) wanted (${byCode.size} airports kept in all)`);
  }
}

type Picked = Array<{ code: string; lat: number; lon: number; name: string | null }>;

/**
 * The airports of an OurAirports `airports.csv` whose code (its ident, or its ICAO or GPS code) `accept` takes, or null if the file is not that.
 * A code that is also another airport's other code goes to the one whose own ident it is. A closed airport, and one with no position, is left out.
 */
function readAirports(csv: string, accept: (code: string, type: string) => boolean): Picked | null {
  const rows = parseCsv(csv);
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header) return null;
  const col = (name: string) => header.indexOf(name);
  const [iIdent, iType, iName, iLat, iLon, iGps, iIcao] = ['ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'gps_code', 'icao_code'].map(col) as [number, number, number, number, number, number, number];
  if (iIdent < 0 || iLat < 0 || iLon < 0) return null;

  const best = new Map<string, { exact: boolean; lat: number; lon: number; name: string | null }>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as string[];
    const type = row[iType] ?? '';
    if (type === 'closed') continue;
    const lat = Number(row[iLat]);
    const lon = Number(row[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || row[iLat] === '' || row[iLon] === '') continue;
    const ident = (row[iIdent] ?? '').trim().toUpperCase();
    const keys = new Set([ident, (iIcao >= 0 ? row[iIcao] ?? '' : '').trim().toUpperCase(), (iGps >= 0 ? row[iGps] ?? '' : '').trim().toUpperCase()]);
    for (const key of keys) {
      if (!key || !accept(key, type)) continue;
      const exact = key === ident;
      const cur = best.get(key);
      if (cur && (cur.exact || !exact)) continue;
      best.set(key, { exact, lat, lon, name: iName >= 0 ? (row[iName] ?? '').trim().slice(0, 80) || null : null });
    }
  }
  return [...best.entries()].map(([code, v]) => ({ code, lat: v.lat, lon: v.lon, name: v.name }));
}

/** The wanted airports out of an OurAirports `airports.csv`, of any kind that is open, or null if the file is not that. */
export function pickAirports(csv: string, wanted: Set<string>): Picked | null {
  return readAirports(csv, (code) => wanted.has(code));
}

/** Every airport of a kind a flight could use (large, medium and small airports) out of an OurAirports `airports.csv`, or null if the file is not that. */
export function pickEveryAirport(csv: string): Picked | null {
  return readAirports(csv, (code, type) => CODE.test(code) && KEPT_TYPES.has(type));
}

const EARTH_RADIUS_NM = 3440.065;

/** The great-circle distance between two positions, in nautical miles. */
export function greatCircleNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
