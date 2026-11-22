import { FsHubError, type FsHubApi } from '../fshub/client.js';
import { silentLogger, type Logger } from '../util/log.js';

/**
 * How far FsHub says each of these flights was flown, in nautical miles. A flight FsHub gave no distance for (or could not be asked
 * about) is simply absent from the answer. At most `max` are asked, and asking stops if FsHub says it is busy.
 *
 * The pay of a flight that lost money depends on this distance (`pilotPay`), so it is FsHub's own figure and never a guess.
 */
export async function fshubDistances(fshub: Pick<FsHubApi, 'airlineFlights'>, airlineId: number, flightIds: number[], max: number, log: Logger = silentLogger): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const [id, facts] of await fshubFlightFacts(fshub, airlineId, flightIds, max, log)) if (facts.distanceNm !== null) out.set(id, facts.distanceNm);
  return out;
}

/** What FsHub recorded of one flight that pay depends on: how far it was flown, and the vertical speed at touchdown (negative for a descent). Each is null when FsHub gave none. */
export interface FlightFacts {
  distanceNm: number | null;
  landingRate: number | null;
}

/**
 * What FsHub says of each of these flights, in one request each: its distance (a flight that lost money is paid by it) and its landing rate (a
 * hard landing cuts the pay when the airline has safety pay on). A flight is in the answer when FsHub was asked and listed it, even if it gave
 * neither figure; a flight FsHub could not be asked about (an error, the limit, or FsHub being busy) is absent, which is not the same thing:
 * the one is "FsHub has no reading", the other is "not known yet".
 */
export async function fshubFlightFacts(fshub: Pick<FsHubApi, 'airlineFlights'>, airlineId: number, flightIds: number[], max: number, log: Logger = silentLogger): Promise<Map<number, FlightFacts>> {
  const out = new Map<number, FlightFacts>();
  for (const id of flightIds.slice(0, max)) {
    try {
      // FsHub lists an airline's flights from just after a cursor, oldest first, so the flight just before this one's ID gives this one.
      const page = await fshub.airlineFlights(airlineId, id - 1, 1);
      const f = page.flights.find((x) => x.id === id);
      if (f) out.set(id, { distanceNm: typeof f.distanceNm === 'number' ? f.distanceNm : null, landingRate: typeof f.landingRate === 'number' ? f.landingRate : null });
    } catch (e) {
      log.debug(`FsHub gave nothing for flight ${id}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof FsHubError && e.kind === 'rate-limited') break;
    }
  }
  return out;
}
