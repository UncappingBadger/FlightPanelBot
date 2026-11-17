import { randomInt } from 'node:crypto';

export const HOUR_MS = 3_600_000;

/** The minutes past the hour a new install may pick: not the top of the hour, where a lot of other things happen, nor the very end of it. */
const FIRST_MINUTE = 3;
const LAST_MINUTE = 56;
const MINUTE_KEY = 'hourly.minute';

/**
 * The one moment each hour at which all the bot's hourly checks (reading the schedule sheets, the FsHub rosters, completing flown flights, and
 * the longer ones that are a whole number of hours) happen together, instead of each running an hour after its own last run and drifting
 * apart. A check is due when it has not yet been done since the slot began, so a restart (or a manual refresh) does not move it, and one
 * that was missed while the bot was off is done as soon as it is back.
 *
 * The minute is fixed for an install and different between installs (picked at random the first time), so every copy of the bot does not
 * ask FsHub, Google and Aeroconomy at the same instant of the hour.
 */
export class HourlySlot {
  readonly minute: number;
  private readonly offsetMs: number;

  constructor(minute = 0) {
    this.minute = Number.isInteger(minute) && minute >= 0 && minute < 60 ? minute : 0;
    this.offsetMs = this.minute * 60_000;
  }

  /** When the slot that `now` is in began (UTC): the latest moment at or before `now` that is this many minutes past an hour. */
  start(now: number): number {
    return Math.floor((now - this.offsetMs) / HOUR_MS) * HOUR_MS + this.offsetMs;
  }

  /** When the next slot begins. */
  next(now: number): number {
    return this.start(now) + HOUR_MS;
  }

  /** Whether something last done at `lastAt` (null: never) has not been done in the slot `now` is in. */
  due(lastAt: number | null, now: number): boolean {
    return lastAt === null || lastAt < this.start(now);
  }

  /** How many whole slots lie between the slot `lastAt` was in and the one `now` is in. */
  slotsSince(lastAt: number, now: number): number {
    return Math.round((this.start(now) - this.start(lastAt)) / HOUR_MS);
  }

  /** The slot for this install: the minute saved in its database, else one picked at random and saved. */
  static forInstall(store: { getKv(key: string): string | null; setKv(key: string, value: string): void }, pick: () => number = () => randomInt(FIRST_MINUTE, LAST_MINUTE + 1)): HourlySlot {
    const raw = store.getKv(MINUTE_KEY);
    if (raw !== null && /^\d{1,2}$/.test(raw) && Number(raw) < 60) return new HourlySlot(Number(raw));
    const minute = pick();
    store.setKv(MINUTE_KEY, String(minute));
    return new HourlySlot(minute);
  }
}
