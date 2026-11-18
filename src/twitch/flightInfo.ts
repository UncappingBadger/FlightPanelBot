import type { FsHubFlight } from '../fshub/client.js';
import type { LiveDetail } from '../fshub/liveFeed.js';

/**
 * What a viewer can be told about the streamer's flying: the flight in the air right now (from FsHub's public live feed), and the last one
 * that landed (from FsHub's record of it, which has the landing rate). Both are asked for only when somebody in chat asks, and remembered
 * for a short while so a busy chat does not become a busy FsHub.
 */
export interface FlightSource {
  /** The flight in progress, or null when the streamer is not flying. Throws when the live feed cannot be read. */
  live(): Promise<LiveDetail | null>;
  /** The last flight that landed, or null when there is none, or no FsHub token to read it with. Throws when FsHub cannot be read. */
  lastFlight(): Promise<FsHubFlight | null>;
}

export interface StreamerFlightDeps {
  feed: { pilotDetail(pilotId: number): Promise<LiveDetail | null> };
  fshub: { pilotRecentFlights(pilotId: number, limit?: number): Promise<FsHubFlight[]>; account(): Promise<{ id: number }> } | null;
  /** The streamer's FsHub pilot number; without it, the owner of the FsHub token. */
  pilotId?: number | undefined;
  now?: () => number;
  liveTtlMs?: number;
  lastTtlMs?: number;
}

export class StreamerFlights implements FlightSource {
  private readonly now: () => number;
  private readonly liveTtl: number;
  private readonly lastTtl: number;
  private pilot: number | null;
  private liveCache: { at: number; value: LiveDetail | null } | null = null;
  private lastCache: { at: number; value: FsHubFlight | null } | null = null;

  constructor(private readonly d: StreamerFlightDeps) {
    this.now = d.now ?? Date.now;
    this.liveTtl = d.liveTtlMs ?? 20_000;
    this.lastTtl = d.lastTtlMs ?? 90_000;
    this.pilot = d.pilotId ?? null;
  }

  private async pilotId(): Promise<number | null> {
    if (this.pilot !== null) return this.pilot;
    if (!this.d.fshub) return null;
    this.pilot = (await this.d.fshub.account()).id;
    return this.pilot;
  }

  async live(): Promise<LiveDetail | null> {
    if (this.liveCache && this.now() - this.liveCache.at < this.liveTtl) return this.liveCache.value;
    const id = await this.pilotId();
    if (id === null) return null;
    const value = await this.d.feed.pilotDetail(id);
    this.liveCache = { at: this.now(), value };
    return value;
  }

  async lastFlight(): Promise<FsHubFlight | null> {
    if (this.lastCache && this.now() - this.lastCache.at < this.lastTtl) return this.lastCache.value;
    if (!this.d.fshub) return null;
    const id = await this.pilotId();
    if (id === null) return null;
    const flights = await this.d.fshub.pilotRecentFlights(id, 5);
    const value = flights[0] ?? null;
    this.lastCache = { at: this.now(), value };
    return value;
  }
}

/* ------------------------------------------------------------------ saying it */

/** Common aircraft by their ICAO type code, for the name a viewer knows. Anything else is shown by its code. */
export const AIRCRAFT_NAMES: Readonly<Record<string, string>> = {
  A20N: 'Airbus A320neo', A21N: 'Airbus A321neo', A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320', A321: 'Airbus A321',
  A332: 'Airbus A330-200', A333: 'Airbus A330-300', A339: 'Airbus A330-900', A343: 'Airbus A340-300', A346: 'Airbus A340-600',
  A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  B712: 'Boeing 717', B734: 'Boeing 737-400', B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900',
  B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B744: 'Boeing 747-400', B748: 'Boeing 747-8', B752: 'Boeing 757-200', B753: 'Boeing 757-300',
  B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B77W: 'Boeing 777-300ER',
  B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10', MD11: 'McDonnell Douglas MD-11', MD82: 'McDonnell Douglas MD-82',
  CRJ2: 'Bombardier CRJ-200', CRJ7: 'Bombardier CRJ-700', CRJ9: 'Bombardier CRJ-900', E170: 'Embraer E170', E175: 'Embraer E175', E190: 'Embraer E190', E195: 'Embraer E195',
  DH8D: 'Dash 8 Q400', AT72: 'ATR 72', AT76: 'ATR 72-600', C172: 'Cessna 172', C208: 'Cessna Caravan', PC12: 'Pilatus PC-12', TBM9: 'TBM 930', B350: 'King Air 350',
};

/** "an A320" reads better than "a A320". */
export const withArticle = (name: string): string => `${/^(?:[AEIO]|[FHLMNRSX][A-Z0-9]{1,5}\b|8|11|18)/.test(name) ? 'an' : 'a'} ${name}`;

export function aircraftName(icao: string | null, fshubName: string | null = null): string | null {
  if (icao && AIRCRAFT_NAMES[icao]) return AIRCRAFT_NAMES[icao] as string;
  return fshubName || icao || null;
}

const route = (dep: string | null, arr: string | null): string | null => (dep && arr ? `${dep} → ${arr}` : arr ? `to ${arr}` : dep ? `from ${dep}` : null);

/** "2h 05m", "45 min". */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 2) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

const PHASES: Record<string, string> = {
  calculating: 'getting ready',
  awaiting_departure: 'at the gate',
  taxiing_to_runway: 'taxiing to the runway',
  take_off: 'taking off',
  climbing: 'climbing',
  level_flight: 'in level flight',
  cruise: 'cruising',
  descending: 'descending',
  on_approach: 'on approach',
  approach: 'on approach',
  landed: 'just landed',
  taxiing_to_gate: 'taxiing to the gate',
  arrived: 'at the gate',
};
export const phaseText = (phase: string | null): string | null => (phase ? PHASES[phase] ?? phase.replace(/_/g, ' ') : null);

const thousands = (n: number): string => Math.round(n).toLocaleString('en-US');

/** "FL370" above the transition altitude, feet below it. */
const height = (ft: number | null): string | null => (ft === null ? null : ft >= 18_000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${thousands(ft)} ft`);

const lastFlightLine = (last: FsHubFlight, now: number): string => {
  const name = aircraftName(last.aircraftIcao, last.aircraftName);
  return `${last.dep} → ${last.arr}${name ? ` in ${withArticle(name)}` : ''}, landed ${ago(now - last.arrivedAt)}`;
};

/** `!flight`: where the streamer is going, in what, and how it is going. */
export function flightText(live: LiveDetail | null, last: FsHubFlight | null, now: number): string {
  if (!live) return last ? `Nobody's flying right now. The last flight was ${lastFlightLine(last, now)}.` : "Nobody's flying right now.";
  const r = route(live.dep, live.arr);
  const name = aircraftName(live.aircraftIcao);
  const bits = [
    `✈️ ${r ?? 'On a flight'}${live.callsign ? ` (${live.callsign})` : ''}${name ? ` in ${withArticle(name)}` : ''}`,
    // FsHub's tracker says "calculating" until it has worked the phase out, which can be well into the flight: not "getting ready" at flight level.
    live.airborne && live.phase === 'calculating' ? 'in the air' : phaseText(live.phase),
    live.airborne ? [height(live.altitudeFt), live.speedKts !== null ? `${thousands(live.speedKts)} kts` : null].filter(Boolean).join(', ') || null : null,
    live.progressPct !== null && live.airborne ? `${Math.round(live.progressPct)}% of the way` : null,
    live.etaMinutes !== null && live.airborne && live.etaMinutes >= 0 ? `about ${duration(live.etaMinutes)} to go` : null,
  ].filter(Boolean);
  return `${bits.join(' · ')}.`;
}

/** `!distance`: how far there is to go, or how far the last flight went. */
export function distanceText(live: LiveDetail | null, last: FsHubFlight | null): string {
  if (live && live.airborne && live.distanceToGoNm !== null) {
    const total = live.progressPct !== null && live.progressPct < 99 && live.progressPct >= 0 ? live.distanceToGoNm / (1 - live.progressPct / 100) : null;
    const done = total !== null ? ` of about ${thousands(total)} nm (${Math.round(live.progressPct as number)}% done)` : '';
    return `📏 ${thousands(live.distanceToGoNm)} nm still to go${done}.`;
  }
  if (live && live.distanceToGoNm !== null) return `📏 ${thousands(live.distanceToGoNm)} nm to the destination, and we're not in the air yet.`;
  if (last && last.distanceNm != null) return `📏 Nothing in the air right now. The last flight (${last.dep} → ${last.arr}) was ${thousands(last.distanceNm)} nm.`;
  return "📏 No flight in the air right now, so there's nothing to measure.";
}

/** How a landing was, in a word, kindly: only a very hard one is not praised. */
export function landingWord(fpm: number): string {
  const rate = Math.abs(fpm);
  if (rate <= 100) return 'butter 🧈';
  if (rate <= 200) return 'smooth as silk';
  if (rate <= 350) return 'a nice one';
  if (rate <= 500) return 'perfectly respectable';
  if (rate <= 600) return 'a firm one';
  if (rate <= 800) return 'a proper thump';
  if (rate <= 1000) return 'the runway felt that';
  return 'the runway is filing a complaint';
}

/** `!landing`: the last landing rate, and a word on it. */
export function landingText(live: LiveDetail | null, last: FsHubFlight | null, now: number): string {
  if (!last) return live ? "🛬 Haven't seen a landing yet." : "🛬 No landing on record that I can see.";
  const lead = live && live.airborne ? 'Not landed yet, but the last landing' : 'The last landing';
  if (last.landingRate == null) return `🛬 ${lead} (${last.dep} → ${last.arr}, ${ago(now - last.arrivedAt)}) has no landing rate recorded.`;
  return `🛬 ${lead} at ${last.arr}, ${ago(now - last.arrivedAt)}: ${thousands(Math.abs(last.landingRate))} fpm. ${landingWord(last.landingRate).replace(/^./, (c) => c.toUpperCase())}.`;
}

/** `!aircraft`. */
export function aircraftText(live: LiveDetail | null, last: FsHubFlight | null): string {
  if (live) {
    const name = aircraftName(live.aircraftIcao);
    return name ? `🛩️ Flying ${withArticle(name)}${live.aircraftIcao && AIRCRAFT_NAMES[live.aircraftIcao] ? ` (${live.aircraftIcao})` : ''}.` : "🛩️ I can't tell what aircraft that is.";
  }
  const name = last ? aircraftName(last.aircraftIcao, last.aircraftName) : null;
  return name ? `🛩️ Not flying right now. The last one was ${withArticle(name)}.` : "🛩️ Not flying right now.";
}

/** `!eta`. */
export function etaText(live: LiveDetail | null, now: number): string {
  if (live && live.airborne && live.etaMinutes !== null && live.etaMinutes >= 0) {
    const at = new Date(now + live.etaMinutes * 60_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}Z`;
    return `🕐 About ${duration(live.etaMinutes)} to go${live.arr ? ` to ${live.arr}` : ''}, landing around ${hhmm}.`;
  }
  return live ? "🕐 Not in the air yet, so there's no landing time to give." : "🕐 Nobody's flying right now.";
}
