import type { Panel, RouteTime, Store } from '../db/store.js';
import { isCompatible } from './aircraftAliases.js';
import { greatCircleNm, type AirportDirectory } from './airports.js';
import { speedFor, speedKindOf } from './aircraftSpeeds.js';

/**
 * How long a flight between two airports takes, from the best source the bot has, and where the figure came from:
 *
 * 1. LEARNED: how long the airline's own pilots took on that route, read from the FsHub flights the bot keeps (the median of
 *    the flights in the same aircraft, or the same kind of aircraft). Real flights on this route, so it is the better figure.
 * 2. DISTANCE: the straight-line distance between the airports, a little extra for the route, and a typical speed for the
 *    aircraft's kind. An estimate, and said to be one.
 *
 * With neither (an airport whose position is not known and no flight of the route seen) there is no figure, and the bot
 * says nothing rather than guess.
 */

/** Fewest flights a learned time is taken from: one flight, however real, may be an odd one. */
export const MIN_LEARNED_FLIGHTS = 2;
/** A little over the straight line for the way a flight is routed. */
export const ROUTE_FACTOR = 1.05;

export interface FlightTime {
  minutes: number;
  source: 'learned' | 'distance';
  /** Where the figure came from, in words that follow "Flight time used: 2 h 5 min,": "typical of 6 flights ..." */
  basis: string;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The usual time of a route from flights seen on it: those in this aircraft (or one FsHub counts as the same), or when there
 * are not enough of those, in the same kind of aircraft. With no aircraft asked for, every flight counts.
 */
export function learnedTime(times: RouteTime[], aircraft: string | null): { minutes: number; count: number; scope: 'type' | 'kind' | 'any' } | null {
  const want = aircraft?.trim().toUpperCase() || null;
  const enough = (list: RouteTime[]) => list.length >= MIN_LEARNED_FLIGHTS;
  if (want) {
    const sameType = times.filter((t) => t.aircraftIcao !== null && (t.aircraftIcao === want || isCompatible(want, t.aircraftIcao)));
    if (enough(sameType)) return { minutes: Math.round(median(sameType.map((t) => t.minutes))), count: sameType.length, scope: 'type' };
    const kind = speedKindOf(want);
    if (kind !== null) {
      const sameKind = times.filter((t) => speedKindOf(t.aircraftIcao) === kind);
      if (enough(sameKind)) return { minutes: Math.round(median(sameKind.map((t) => t.minutes))), count: sameKind.length, scope: 'kind' };
    }
    return null;
  }
  return enough(times) ? { minutes: Math.round(median(times.map((t) => t.minutes))), count: times.length, scope: 'any' } : null;
}

/** The time a flight of this length takes at the typical speed of the aircraft, with what that was worked out from. */
export function distanceTime(nm: number, aircraft: string | null): FlightTime {
  const speed = speedFor(aircraft);
  const minutes = Math.max(1, Math.round(((nm * ROUTE_FACTOR) / speed.kt) * 60 + speed.allowanceMin));
  const type = speed.known ? `${speed.label} (${speed.kt} kt)` : `${speed.label} (${speed.kt} kt), because the aircraft type is not one the bot has a speed for`;
  return {
    minutes,
    source: 'distance',
    basis: `estimated from the ${Math.round(nm).toLocaleString('en-US')} nm between the airports (plus ${Math.round((ROUTE_FACTOR - 1) * 100)}% for the route) at the typical speed of ${type}, with ${speed.allowanceMin} minutes added for the climb and the approach`,
  };
}

export class FlightTimes {
  constructor(
    private readonly store: Store,
    private readonly airports: Pick<AirportDirectory, 'coords'>,
  ) {}

  /** The time for one leg, or null when neither a flight of the route nor the airports' positions are known. */
  async forLeg(panel: Panel, dep: string, arr: string, aircraft: string | null): Promise<FlightTime | null> {
    const from = dep.trim().toUpperCase();
    const to = arr.trim().toUpperCase();
    // A job that names its aircraft in words ("Airbus A320") rather than by type code says nothing the bot can match flights to.
    const type = /^[A-Za-z0-9]{3,4}$/.test(aircraft?.trim() ?? '') ? (aircraft as string).trim().toUpperCase() : null;
    aircraft = type;
    const learned = learnedTime(this.store.listRouteTimes(panel.id, from, to), aircraft);
    if (learned) {
      const what = learned.scope === 'type' ? `, in the ${aircraft?.toUpperCase()}` : learned.scope === 'kind' ? `, in ${speedFor(aircraft).label}` : '';
      return {
        minutes: learned.minutes,
        source: 'learned',
        basis: `the middle time of the ${learned.count} flights of this route by your airline's pilots on FsHub${what}`,
      };
    }
    const found = await this.airports.coords([from, to]);
    const a = found.get(from);
    const b = found.get(to);
    if (!a || !b) return null;
    return distanceTime(greatCircleNm(a, b), aircraft);
  }
}
