import type { Job } from '../db/store.js';
import type { SourceJob } from '../jobs/types.js';

/**
 * Which flight on the panel a schedule row is, for rows that have the same route and day. A row's key is its route and day, with `#2`, `#3`
 * and so on for later rows of the same two, so re-ordering, adding or deleting one of them moves the keys along. Left to the keys alone, a
 * pilot's reservation would then stay behind on another flight, with another flight number.
 */

/**
 * A schedule sheet's key; the first group is its route and day. Keys of other sources do not match, and are left as they are. A flight set
 * aside because no row was it (`#gone-12`) is still of its route and day, so it is found again when its row can be read once more.
 */
const SHEET_KEY = /^([A-Z0-9]{3,4}-[A-Z0-9]{3,4}(?:\+[A-Z0-9]{3,4}-[A-Z0-9]{3,4})*@\d{4}-\d{2}-\d{2})(?:#(?:\d+|gone-\d+))?$/;
const routeDayOf = (key: string): string | null => SHEET_KEY.exec(key)?.[1] ?? null;

/** A flight number without the day that a number flown on several days carries (`SKY330-17NOV`). */
export const plainNumber = (code: string): string => code.replace(/-\d{2}[A-Z]{3}$/, '');

export interface KnownFlight {
  job: Job;
  /** The names written against it: the sheet's own, and the ones the bot wrote for its holders. */
  names: string[];
}

/** How surely this row is that flight. 0: nothing says so. The flight number says it best, then the pilot's name, then what the flight is, then the key. */
function score(row: SourceJob, known: KnownFlight): number {
  const names = known.names.map((n) => n.trim().toLowerCase());
  let points = 0;
  if (row.flightNumber && plainNumber(row.flightNumber) === plainNumber(known.job.code)) points += 16;
  if (row.legs.some((l) => l.heldBy && names.includes(l.heldBy.trim().toLowerCase()))) points += 8;
  if (row.aircraft === known.job.aircraft && row.availableFrom === known.job.availableFrom && row.deadline === known.job.deadline) points += 4;
  if (row.key === known.job.sourceKey) points += 2;
  return points;
}

/**
 * The flights whose key has to change so that each is found by the row it is on now: `jobId` to its new key. A flight no row is, whose key a
 * row now belongs to, is given a key no row has, so that it is closed as gone and not taken for that row. A flight in `unread` is on a row
 * that cannot be read just now: only a row with its number or its pilot's name is taken for it, never one that is merely alike.
 */
export function movedKeys(rows: SourceJob[], known: KnownFlight[], unread: ReadonlySet<number> = new Set()): Map<number, string> {
  const rowsBy = new Map<string, SourceJob[]>();
  for (const r of rows) {
    const day = routeDayOf(r.key);
    if (day) rowsBy.set(day, [...(rowsBy.get(day) ?? []), r]);
  }
  const knownBy = new Map<string, KnownFlight[]>();
  for (const k of known) {
    const day = routeDayOf(k.job.sourceKey);
    if (day && rowsBy.has(day)) knownBy.set(day, [...(knownBy.get(day) ?? []), k]);
  }

  const moves = new Map<number, string>();
  for (const [day, flights] of knownBy) {
    const here = rowsBy.get(day) as SourceJob[];
    // A flight that was taken off the panel gets a row only when no flight still on it wants that row: left to the points alone, a deleted
    // flight (which still remembers its pilot's name and its old place) could take a live flight's row from it. Its own flight number on
    // the row is the exception, since that says outright that it is back. Then best first, then the sheet's order.
    const ghost = (p: { flight: KnownFlight; points: number }) => Number(p.flight.job.status === 'removed' && p.points < 16);
    const pairs = here
      .flatMap((row, i) => flights.map((flight) => ({ row, i, flight, points: score(row, flight) })))
      .filter((p) => p.points > 0 && (p.points >= 8 || !unread.has(p.flight.job.id)))
      .sort((a, b) => ghost(a) - ghost(b) || b.points - a.points || Number(a.flight.job.status === 'removed') - Number(b.flight.job.status === 'removed') || a.i - b.i || a.flight.job.id - b.flight.job.id);
    const rowOf = new Map<number, string>();
    const taken = new Set<string>();
    for (const p of pairs) {
      if (rowOf.has(p.flight.job.id) || taken.has(p.row.key)) continue;
      rowOf.set(p.flight.job.id, p.row.key);
      taken.add(p.row.key);
    }
    for (const { job } of flights) {
      const key = rowOf.get(job.id);
      if (key !== undefined) {
        if (key !== job.sourceKey) moves.set(job.id, key);
      } else if (here.some((r) => r.key === job.sourceKey) || unread.has(job.id)) {
        // So is one whose row cannot be read just now: it is not to be counted among, or written to, the rows that can.
        const gone = `${day}#gone-${job.id}`;
        if (job.sourceKey !== gone) moves.set(job.id, gone);
      }
    }
  }
  return moves;
}
