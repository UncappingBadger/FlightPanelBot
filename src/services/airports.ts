import type { AirportCoord, Store } from '../db/store.js';
import { parseCsv } from '../jobs/import.js';
import { readTextCapped } from '../util/http.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * Where airports are, for working out a distance. The positions come from OurAirports (https://ourairports.com), whose data is
 * released into the public domain; the bot downloads its airport list once and keeps the positions of the airports its flights
 * use. Nothing about a pilot, a server or an airline is ever sent: it is a plain download of a public file.
 */
export const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

const MAX_BYTES = 40_000_000;
const TIMEOUT_MS = 90_000;
/** Having read the list, do not read it again for airports it turned out not to have until this long has passed. */
const RECHECK_MS = 12 * 3_600_000;
/** After a failed download, wait this long. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

const KV_FETCHED = 'airports.fetched_at';
const KV_FAILED = 'airports.failed_at';

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
   * The positions of these airports (by ICAO code), those the bot could find. An airport it does not know is read from the
   * downloaded list when the list has not been read lately, and left out when it has (so an airport that is not in the list
   * does not make the bot download it again every minute).
   */
  async coords(codes: string[]): Promise<Map<string, AirportCoord>> {
    const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z0-9]{2,5}$/.test(c)))];
    let known = this.store.getAirportCoords(wanted);
    const missing = wanted.filter((c) => !known.has(c));
    if (missing.length === 0 || !this.mayRead()) return known;
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

  private mayRead(): boolean {
    const now = this.now();
    const failed = Number(this.store.getKv(KV_FAILED) ?? 0);
    if (failed > 0 && now - failed < RETRY_AFTER_FAILURE_MS) return false;
    const fetched = Number(this.store.getKv(KV_FETCHED) ?? 0);
    return !(fetched > 0 && now - fetched < RECHECK_MS);
  }

  private async load(missing: string[]): Promise<void> {
    const res = await this.fetchFn(this.url, {
      headers: { 'user-agent': this.userAgent, accept: 'text/csv,*/*' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readTextCapped(res, MAX_BYTES);
    if (text === null) throw new Error('the list is larger than expected');
    const found = pickAirports(text, new Set(missing));
    if (found === null) throw new Error('the list is not in the expected format');
    this.store.saveAirportCoords(found);
    this.store.setKv(KV_FETCHED, String(this.now()));
    this.store.setKv(KV_FAILED, '0');
    this.log.info(`Read the airport list: found ${found.length} of ${missing.length} airport(s) wanted`);
  }
}

/** The wanted airports out of an OurAirports `airports.csv`, or null if the file is not that. */
export function pickAirports(csv: string, wanted: Set<string>): Array<{ code: string; lat: number; lon: number; name: string | null }> | null {
  const rows = parseCsv(csv);
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header) return null;
  const col = (name: string) => header.indexOf(name);
  const [iIdent, iType, iName, iLat, iLon, iGps, iIcao] = ['ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'gps_code', 'icao_code'].map(col) as [number, number, number, number, number, number, number];
  if (iIdent < 0 || iLat < 0 || iLon < 0) return null;

  // An airport is wanted by its ident, or its ICAO or GPS code; a code that is also another airport's other code goes to the one whose own ident it is.
  const best = new Map<string, { exact: boolean; lat: number; lon: number; name: string | null }>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as string[];
    if ((row[iType] ?? '') === 'closed') continue;
    const lat = Number(row[iLat]);
    const lon = Number(row[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || row[iLat] === '' || row[iLon] === '') continue;
    const ident = (row[iIdent] ?? '').trim().toUpperCase();
    const keys = new Set([ident, (iIcao >= 0 ? row[iIcao] ?? '' : '').trim().toUpperCase(), (iGps >= 0 ? row[iGps] ?? '' : '').trim().toUpperCase()]);
    for (const key of keys) {
      if (!key || !wanted.has(key)) continue;
      const exact = key === ident;
      const cur = best.get(key);
      if (cur && (cur.exact || !exact)) continue;
      best.set(key, { exact, lat, lon, name: iName >= 0 ? (row[iName] ?? '').trim().slice(0, 80) || null : null });
    }
  }
  return [...best.entries()].map(([code, v]) => ({ code, lat: v.lat, lon: v.lon, name: v.name }));
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
