import type { JobView, Panel, Store } from '../db/store.js';
import { isAirbornePhase, type AirlineFlight, type LiveFeed } from '../fshub/liveFeed.js';
import { normalizeFlightNumber } from '../jobs/types.js';
import { silentLogger, type Logger } from '../util/log.js';

/** When an airline's flight that is in the air is expected to land, as FsHub's live feed says. */
export interface FlightEta {
  panelId: number;
  jobId: number;
  /** The flight's ID on the panel (the one pilots type). */
  code: string;
  /** Which leg of the flight is being flown (1 for a flight of one leg). */
  legNo: number;
  legs: number;
  dep: string;
  arr: string;
  /** The callsign it is flying under. */
  callsign: string;
  /** The landing time the panel shows: it only moves when the estimate has moved by a few minutes, so the panel is not redrawn every minute. */
  etaAt: number;
  /** The newest estimate, for someone who asks. */
  liveEtaAt: number;
}

/** The feed is asked at most this often for one airline. */
const POLL_MS = 55_000;
/** An estimate is only moved on the panel when it has changed by this much... */
const MOVE_BY_MS = 3 * 60_000;
/** ...and at most this often (a flight coming in often gets its estimate nudged a minute at a time). */
const MOVE_EVERY_MS = 5 * 60_000;
/** A flight the feed stops showing for this many looks in a row is taken off. */
const MISSES_TO_DROP = 2;
/** What was read is not trusted after this long without a good read. */
const STALE_MS = 4 * 60_000;
/** The estimate the feed gives is believed within these bounds, in minutes. */
const MAX_ETA_MIN = 24 * 60;
/** A landing this far outside a flight's window still counts as that flight (people are early and late). */
const EARLY_MS = 3 * 3_600_000;
const LATE_MS = 6 * 3_600_000;

/**
 * The letters an airline's callsigns start with (`SKY` for `SKY290`), which is also what FsHub's live feed lists its flights under. A panel
 * has no setting for it; it is the airline's short name when the panel has one, otherwise the prefix of its flight IDs (`SKY-001`).
 */
export function callsignCode(panel: Pick<Panel, 'airlineAbbr' | 'prefix'>): string {
  return (panel.airlineAbbr?.trim() || panel.prefix).trim().toUpperCase();
}

/**
 * Whether this live flight is one of the airline's own that the bot may follow. An airline's flights are flown under its own callsign (its
 * abbreviation and a number, like `SKY290`) with a flight plan filed, and the aircraft has to be in the air with an estimate that is
 * believable. Anything else a pilot of the airline is flying (another callsign, no plan) is not one of its flights and is ignored.
 */
export function isOwnFlight(f: AirlineFlight, abbr: string): boolean {
  const code = abbr.trim().toUpperCase();
  const call = f.callsign;
  if (!code || !call || !call.startsWith(code) || !/^\d/.test(call.slice(code.length))) return false;
  if (!f.dep || !f.arr) return false;
  if (f.onGround === true || !isAirbornePhase(f.phase)) return false;
  return f.etaMinutes !== null && f.etaMinutes >= 0 && f.etaMinutes <= MAX_ETA_MIN;
}

interface Match {
  view: JobView;
  legNo: number;
}

/**
 * Which of a panel's open flights a live flight is: one with a leg between the same two airports as the flight plan. When several are,
 * the one whose number is the callsign wins, then the one whose landing window the landing falls in, and among those the one a pilot
 * who holds it (by FsHub ID) is flying. When that still leaves more than one, it is not guessed: null.
 */
export function matchFlight(f: AirlineFlight, views: JobView[], now: number): Match | null {
  if (!f.dep || !f.arr) return null;
  const [dep, arr] = [f.dep.toUpperCase(), f.arr.toUpperCase()];
  const route: Match[] = [];
  for (const view of views) {
    if (view.job.completedAt !== null) continue;
    const leg = view.legs.find((l) => l.dep.toUpperCase() === dep && l.arr.toUpperCase() === arr);
    if (leg) route.push({ view, legNo: leg.legNo });
  }
  if (route.length <= 1) return route[0] ?? null;

  // The callsign being the flight's number settles it: either as the flight's whole ID, or with the day on the end (`SKY330-17NOV`),
  // in which case the days that share the number are still told apart below.
  const number = f.callsign === null ? null : normalizeFlightNumber(f.callsign);
  const numbered = route.filter((m) => number !== null && (m.view.job.code === number || (m.view.job.code.startsWith(`${number}-`) && /^\d{2}[A-Z]{3}$/.test(m.view.job.code.slice(number.length + 1)))));
  if (numbered.length === 1) return numbered[0] as Match;
  if (numbered.length > 1) route.splice(0, route.length, ...numbered);

  const landing = now + (f.etaMinutes ?? 0) * 60_000;
  const fits = (m: Match) => (m.view.job.availableFrom === null || landing >= m.view.job.availableFrom - EARLY_MS) && (m.view.job.deadline === null || landing <= m.view.job.deadline + LATE_MS);
  const flownByHolder = (m: Match) => f.pilotId !== null && m.view.legs.some((l) => l.holder?.fshubId === f.pilotId);

  const inWindow = route.filter(fits);
  const pool = inWindow.length > 0 ? inWindow : route;
  if (pool.length === 1) return pool[0] as Match;
  const theirs = pool.filter(flownByHolder);
  return theirs.length === 1 ? (theirs[0] as Match) : null;
}

interface Entry {
  eta: FlightEta;
  /** When the time shown on the panel last moved. */
  changedAt: number;
  /** How many looks in a row have not shown the flight. */
  misses: number;
}

export interface FlightEtasDeps {
  store: Store;
  feed: Pick<LiveFeed, 'airlineFlights'>;
  /** Asked to redraw a panel when what it shows about landing times changes. */
  panels: { schedule(panelId: number): void };
  logger?: Logger;
  now?: () => number;
}

/**
 * Follows an airline's flights that are in the air, using FsHub's public live feed, to say when each is expected to land: on the panel's
 * card for the flight, and to anyone who asks (`/eta`). It is asked once a minute for each airline, in a single request.
 *
 * Only flights the airline itself flies are used: callsign of the airline and a flight plan (see `isOwnFlight`), whose airports are a leg of
 * a flight on the panel. Nothing is kept on disk; after a restart the estimates come back with the first read.
 */
export class FlightEtas {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly shown = new Map<number, Map<number, Entry>>();
  private readonly lastRead = new Map<string, { at: number; ok: boolean; goodAt: number | null }>();

  constructor(private readonly d: FlightEtasDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.logger ?? silentLogger;
  }

  /** The landing times shown for a panel's flights, by flight (job) ID. */
  forPanel(panelId: number): ReadonlyMap<number, FlightEta> {
    const out = new Map<number, FlightEta>();
    for (const [jobId, e] of this.shown.get(panelId) ?? []) out.set(jobId, e.eta);
    return out;
  }

  /** Every flight of a panel in the air that has an estimate, soonest landing first. */
  airborne(panelId: number): FlightEta[] {
    return [...(this.shown.get(panelId)?.values() ?? [])].map((e) => e.eta).sort((a, b) => a.liveEtaAt - b.liveEtaAt || a.code.localeCompare(b.code));
  }

  /** One pass: ask the feed for each airline that is due, and match what it says to the panels' flights. */
  async run(): Promise<void> {
    const now = this.now();
    const byAirline = new Map<string, Panel[]>();
    const active = new Set<number>();
    for (const panel of this.d.store.listAllPanels()) {
      const abbr = callsignCode(panel);
      if (!panel.liveTracking || !abbr) continue;
      active.add(panel.id);
      byAirline.set(abbr, [...(byAirline.get(abbr) ?? []), panel]);
    }
    // A panel that no longer follows flights (switched off, or its airline code removed) loses what it showed.
    for (const panelId of [...this.shown.keys()]) {
      if (active.has(panelId)) continue;
      this.shown.delete(panelId);
      this.d.panels.schedule(panelId);
    }

    for (const [abbr, panels] of byAirline) {
      const seen = this.lastRead.get(abbr);
      if (seen && now - seen.at < POLL_MS) continue;
      let flights: AirlineFlight[];
      try {
        flights = await this.d.feed.airlineFlights(abbr);
      } catch (e) {
        this.log.debug(`Live feed (${abbr}): ${e instanceof Error ? e.message : e}`);
        this.lastRead.set(abbr, { at: now, ok: false, goodAt: seen?.goodAt ?? null });
        // What was read goes stale by itself: after a while without a good read the panels stop showing it.
        if (seen?.goodAt == null || now - seen.goodAt > STALE_MS) for (const p of panels) this.clear(p.id);
        continue;
      }
      this.lastRead.set(abbr, { at: now, ok: true, goodAt: now });
      const own = flights.filter((f) => isOwnFlight(f, abbr));
      for (const panel of panels) this.apply(panel, own, now);
    }
  }

  private clear(panelId: number): void {
    if ((this.shown.get(panelId)?.size ?? 0) === 0) return;
    this.shown.delete(panelId);
    this.d.panels.schedule(panelId);
  }

  private apply(panel: Panel, own: AirlineFlight[], now: number): void {
    const views = this.d.store.listOpenJobViews(panel.id);
    // Each live flight to its flight on the panel; two live flights that want the same one are settled by who holds it, else neither is used.
    const wanted = new Map<number, Array<{ flight: AirlineFlight; match: Match }>>();
    for (const flight of own) {
      const match = matchFlight(flight, views, now);
      if (match) wanted.set(match.view.job.id, [...(wanted.get(match.view.job.id) ?? []), { flight, match }]);
    }
    const chosen = new Map<number, { flight: AirlineFlight; match: Match }>();
    for (const [jobId, list] of wanted) {
      if (list.length === 1) {
        chosen.set(jobId, list[0] as (typeof list)[number]);
        continue;
      }
      const theirs = list.filter(({ flight, match }) => flight.pilotId !== null && match.view.legs.some((l) => l.holder?.fshubId === flight.pilotId));
      if (theirs.length === 1) chosen.set(jobId, theirs[0] as (typeof theirs)[number]);
      else this.log.debug(`Live feed: ${list.length} flights in the air could each be ${match0(list)}, so none is used`);
    }

    const current = this.shown.get(panel.id) ?? new Map<number, Entry>();
    let changed = false;

    for (const [jobId, { flight, match }] of chosen) {
      const liveEtaAt = Math.round((now + (flight.etaMinutes ?? 0) * 60_000) / 60_000) * 60_000;
      const have = current.get(jobId);
      const leg = match.view.legs.find((l) => l.legNo === match.legNo);
      const base = {
        panelId: panel.id,
        jobId,
        code: match.view.job.code,
        legNo: match.legNo,
        legs: match.view.legs.length,
        dep: leg?.dep.toUpperCase() ?? (flight.dep as string),
        arr: leg?.arr.toUpperCase() ?? (flight.arr as string),
        callsign: flight.callsign as string,
        liveEtaAt,
      };
      if (!have) {
        current.set(jobId, { eta: { ...base, etaAt: liveEtaAt }, changedAt: now, misses: 0 });
        changed = true;
        continue;
      }
      have.misses = 0;
      const moved = Math.abs(liveEtaAt - have.eta.etaAt) >= MOVE_BY_MS && now - have.changedAt >= MOVE_EVERY_MS;
      const differentLeg = have.eta.legNo !== match.legNo || have.eta.callsign !== base.callsign;
      if (moved || differentLeg) {
        have.eta = { ...base, etaAt: liveEtaAt };
        have.changedAt = now;
        changed = true;
      } else {
        have.eta = { ...have.eta, liveEtaAt };
      }
    }

    // A flight the feed has stopped showing (landed, or gone from the feed) is taken off after a second look.
    for (const [jobId, entry] of current) {
      if (chosen.has(jobId)) continue;
      entry.misses++;
      if (entry.misses >= MISSES_TO_DROP) {
        current.delete(jobId);
        changed = true;
      }
    }

    if (current.size === 0) this.shown.delete(panel.id);
    else this.shown.set(panel.id, current);
    if (changed) this.d.panels.schedule(panel.id);
  }
}

const match0 = (list: Array<{ match: Match }>): string => (list[0] ? list[0].match.view.job.code : 'the same flight');
