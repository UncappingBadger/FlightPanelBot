import type { FlightMonitor, Store } from '../db/store.js';
import { isFlying, type AirlineFlight, type LiveFeed } from '../fshub/liveFeed.js';
import { silentLogger, type Logger } from '../util/log.js';
import { appNow } from '../util/clock.js';

/**
 * Tells a person, in a private message, when a flight they asked about (`/monitor SKY330`) is about ten minutes from landing, and when it has landed.
 *
 * The flight is looked for in FsHub's public live feed under its airline's code (the letters of the flight number), once a minute, one request for each
 * airline however many people are watching its flights. Nothing about the person is sent. A flight is found by its callsign, which for an airline's
 * flight is its flight number. It is watched until it lands, drops out of the feed, or has not been seen at all for a day.
 */

/** Told this long (at most) before landing, by the feed's own estimate. */
export const NEAR_MINUTES = 10;
/** One person can watch this many flights at once. */
export const MAX_MONITORS = 5;
/** A flight that is never seen in the air is given up on after this long. */
export const WAIT_FOR_FLIGHT_MS = 24 * 3_600_000;
/** A flight seen in the air is given this long from then (a long flight, and some time to land). */
const AIRBORNE_FOR_MS = 20 * 3_600_000;
/** A flight seen in the air that the feed then does not show this many looks in a row is taken as gone. */
const MISSES_TO_END = 2;
/** After landing the feed shows these phases for a while. */
const LANDED_PHASES = new Set(['landed', 'taxiing_to_gate', 'arrived']);

/** A flight number as people write it (`sky 330`, `SKY-330`) in the one form the live feed uses (`SKY330`), and its airline's code; null if it is not one. */
export function parseFlightNumber(raw: string): { flightNo: string; airline: string } | null {
  const t = raw.trim().toUpperCase().replace(/[\s_-]+/g, '');
  const m = /^([A-Z]{2,6})\d{1,5}[A-Z]?$/.exec(t);
  return m ? { flightNo: t, airline: m[1] as string } : null;
}

/** What the live feed shows of a flight right now. */
export interface LiveNow {
  phase: string | null;
  airborne: boolean;
  dep: string | null;
  arr: string | null;
  etaMinutes: number | null;
}

export type AddResult =
  | { kind: 'invalid' }
  | { kind: 'limit' }
  | { kind: 'already'; monitor: FlightMonitor }
  /** `live` is how the flight stands right now, or null when it is not in the feed (or the feed could not be asked). */
  | { kind: 'added'; monitor: FlightMonitor; live: LiveNow | null };

export const nearText = (m: Pick<FlightMonitor, 'flightNo' | 'arr'>, minutes: number | null): string =>
  `🛬 **${m.flightNo}** is about **${minutes === null || minutes <= 1 ? 'a minute' : `${Math.round(minutes)} minutes`}** from landing${m.arr ? ` at **${m.arr}**` : ''} (FsHub's estimate).`;
export const landedText = (m: Pick<FlightMonitor, 'flightNo' | 'dep' | 'arr'>): string => `✅ **${m.flightNo}** has landed${m.arr ? ` at **${m.arr}**` : ''}${m.dep && m.arr ? ` (${m.dep} → ${m.arr})` : ''}.`;
export const droppedText = (m: Pick<FlightMonitor, 'flightNo'>): string =>
  `⚠️ **${m.flightNo}** is no longer in FsHub's live feed, so I've stopped watching it. It most likely landed, or its pilot disconnected.`;
export const gaveUpText = (m: Pick<FlightMonitor, 'flightNo'>): string =>
  `I never saw **${m.flightNo}** in the air within ${WAIT_FOR_FLIGHT_MS / 3_600_000} hours, so I've stopped watching it. Send me \`/monitor ${m.flightNo}\` to start again.`;

export interface FlightMonitorsDeps {
  store: Store;
  feed: Pick<LiveFeed, 'airlineFlights'>;
  /** Sends a private message; false if it could not be delivered. */
  send: (discordId: string, content: string) => Promise<boolean>;
  logger?: Logger;
  now?: () => number;
}

const liveOf = (f: AirlineFlight): LiveNow => ({ phase: f.phase, airborne: isFlying(f.phase, f.onGround), dep: f.dep, arr: f.arr, etaMinutes: f.etaMinutes });

/** The flight with this callsign: the one in the air when two share it. */
function pick(flights: AirlineFlight[], flightNo: string): AirlineFlight | null {
  const same = flights.filter((f) => f.callsign === flightNo || f.flightNo === flightNo);
  return same.find((f) => liveOf(f).airborne) ?? same[0] ?? null;
}

export class FlightMonitors {
  private readonly now: () => number;
  private readonly log: Logger;
  private running = false;
  private current: Promise<void> = Promise.resolve();

  constructor(private readonly d: FlightMonitorsDeps) {
    this.now = d.now ?? appNow;
    this.log = d.logger ?? silentLogger;
  }

  list(discordId: string): FlightMonitor[] {
    return this.d.store.listFlightMonitors(discordId);
  }

  /** Start watching a flight for a person. A flight number that is not one, or a sixth flight, is refused; one already watched is left as it is. */
  async add(discordId: string, raw: string): Promise<AddResult> {
    const parsed = parseFlightNumber(raw);
    if (!parsed) return { kind: 'invalid' };
    const mine = this.list(discordId);
    const have = mine.find((m) => m.flightNo === parsed.flightNo);
    if (have) return { kind: 'already', monitor: have };
    if (mine.length >= MAX_MONITORS) return { kind: 'limit' };
    const now = this.now();
    const monitor = this.d.store.addFlightMonitor({ discordId, flightNo: parsed.flightNo, airline: parsed.airline, now, expiresAt: now + WAIT_FOR_FLIGHT_MS });
    if (!monitor) return { kind: 'already', monitor: this.list(discordId).find((m) => m.flightNo === parsed.flightNo) as FlightMonitor };
    let live: LiveNow | null = null;
    try {
      const f = pick(await this.d.feed.airlineFlights(parsed.airline), parsed.flightNo);
      live = f ? liveOf(f) : null;
    } catch (e) {
      this.log.debug(`Live feed (${parsed.airline}): ${e instanceof Error ? e.message : e}`);
    }
    return { kind: 'added', monitor, live };
  }

  /** Stop watching a flight (by number) for a person, or all of theirs with `'all'`. Returns how many were stopped. */
  stop(discordId: string, what: string): number {
    if (what.trim().toLowerCase() === 'all') return this.d.store.deleteFlightMonitors(discordId);
    const parsed = parseFlightNumber(what);
    return parsed ? this.d.store.deleteFlightMonitors(discordId, parsed.flightNo) : 0;
  }

  /** Look at every flight being watched: one request for each airline. Overlapping runs are skipped. */
  run(): Promise<void> {
    if (this.running) return this.current;
    this.running = true;
    this.current = (async () => {
      try {
        const byAirline = new Map<string, FlightMonitor[]>();
        for (const m of this.d.store.listFlightMonitors()) byAirline.set(m.airline, [...(byAirline.get(m.airline) ?? []), m]);
        for (const [airline, group] of byAirline) {
          let flights: AirlineFlight[] | null = null;
          try {
            flights = await this.d.feed.airlineFlights(airline);
          } catch (e) {
            this.log.debug(`Live feed (${airline}): ${e instanceof Error ? e.message : e}`);
          }
          for (const m of group) await this.look(m, flights).catch((e) => this.log.warn('Watching a flight failed', e));
        }
      } finally {
        this.running = false;
      }
    })();
    return this.current;
  }

  idle(): Promise<void> {
    return this.current;
  }

  /** What the feed shows of one watched flight (null: the feed could not be asked, which tells nothing), and what is to be said about it. */
  private async look(m: FlightMonitor, flights: AirlineFlight[] | null): Promise<void> {
    const now = this.now();
    const f = flights === null ? null : pick(flights, m.flightNo);

    if (f) {
      const live = liveOf(f);
      const here = { ...m, dep: f.dep ?? m.dep, arr: f.arr ?? m.arr };
      if (live.airborne) {
        const patch = { state: 'airborne' as const, lastSeenAt: now, misses: 0, dep: here.dep, arr: here.arr, ...(m.state === 'airborne' ? {} : { expiresAt: Math.max(m.expiresAt, now + AIRBORNE_FOR_MS) }) };
        if (!m.nearSent && live.etaMinutes !== null && live.etaMinutes >= 0 && live.etaMinutes <= NEAR_MINUTES) {
          // Only once it has been told: a message that could not be delivered is tried again at the next look.
          if (await this.d.send(m.discordId, nearText(here, live.etaMinutes))) this.d.store.updateFlightMonitor(m.id, { ...patch, nearSent: true });
          else this.d.store.updateFlightMonitor(m.id, patch);
        } else this.d.store.updateFlightMonitor(m.id, patch);
        return;
      }
      // On the ground: landed if the feed says so, or if it was in the air and is now on the ground. (Before departure it is neither: it is waited for.)
      if (LANDED_PHASES.has(f.phase ?? '') || (m.state === 'airborne' && f.onGround === true)) {
        if (await this.d.send(m.discordId, landedText(here))) this.d.store.deleteFlightMonitor(m.id);
        return;
      }
      this.d.store.updateFlightMonitor(m.id, { lastSeenAt: now, dep: here.dep, arr: here.arr });
      return;
    }

    if (flights !== null && m.state === 'airborne') {
      const misses = m.misses + 1;
      if (misses >= MISSES_TO_END) {
        if (await this.d.send(m.discordId, droppedText(m))) this.d.store.deleteFlightMonitor(m.id);
        else this.d.store.updateFlightMonitor(m.id, { misses });
      } else this.d.store.updateFlightMonitor(m.id, { misses });
      return;
    }

    if (m.expiresAt <= now) {
      await this.d.send(m.discordId, gaveUpText(m));
      this.d.store.deleteFlightMonitor(m.id);
    }
  }
}
