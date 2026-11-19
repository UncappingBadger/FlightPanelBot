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
  for (const id of flightIds.slice(0, max)) {
    try {
      // FsHub lists an airline's flights from just after a cursor, oldest first, so the flight just before this one's ID gives this one.
      const page = await fshub.airlineFlights(airlineId, id - 1, 1);
      const nm = page.flights.find((f) => f.id === id)?.distanceNm;
      if (typeof nm === 'number') out.set(id, nm);
    } catch (e) {
      log.debug(`FsHub gave no distance for flight ${id}: ${e instanceof Error ? e.message : String(e)}`);
      if (e instanceof FsHubError && e.kind === 'rate-limited') break;
    }
  }
  return out;
}
