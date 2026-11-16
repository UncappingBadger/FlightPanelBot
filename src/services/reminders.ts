import type { JobView, Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { JobService } from './jobs.js';

export const DAY_MS = 86_400_000;
/** The first moment of the UTC day that `ms` falls in. UTC (Zulu) because every flight time here is Zulu, whatever timezone the host's PC is set to. */
export function startOfUtcDay(ms: number): number {
  return ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

/** The "pilots needed" announcement is deleted this long before midnight UTC (23:59), so the old one is gone before the new one is posted. */
export const CLEANUP_BEFORE_MIDNIGHT_MS = 60_000;
/**
 * A list that was not posted at midnight (the bot was off) is still posted if the bot comes back before this long into the day (22:00 UTC); after
 * that it would be gone almost as soon as it appeared, so that day is let go.
 */
export const CATCH_UP_UNTIL_MS = 22 * 3_600_000;
/** After a failed announcement (the bot can't write in the channel), wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60 * 60_000;

/** A flight that still needs a pilot, and which of its legs are unclaimed. */
export interface Reminder {
  view: JobView;
  /** Leg numbers with nobody on them. All of them for a flight nobody has taken. */
  openLegs: number[];
  /** When the flight starts: the opening of its window, or its deadline if it has no start. */
  startsAt: number;
}

/** Sends the announcement to the panel's channel. Returns true if it went out. */
export type DeliverReminder = (panel: Panel, due: Reminder[]) => Promise<boolean>;

/** When a flight starts, for reminder purposes. Null if the source gave it no times at all. */
export function startOf(view: JobView): number | null {
  return view.job.availableFrom ?? view.job.deadline;
}

/** Legs nobody has: no Discord reservation and no pilot named in the airline's own schedule. */
export function openLegsOf(view: JobView): number[] {
  return view.legs.filter((l) => !l.holder && !l.sheetHolder).map((l) => l.legNo);
}

/**
 * Once a day, at midnight UTC, lists the flights that start that day and still have no pilot, in a single message per panel,
 * whenever each of them opens and however far off it was a moment ago. Nothing else is posted for them that day: a flight
 * that loses its pilot later is not announced (the pilot who gave it back is asked to spread the word instead, in a DM).
 * Knows nothing about Discord: `deliver` does the posting.
 *
 * Which day a flight belongs to is the UTC day its window opens (its deadline, for a flight with no start). The day a panel was last
 * dealt with is kept in the database (`remindedDay`), so a restart does not repeat the list and a bot that was off at midnight still posts it,
 * if it is back before 22:00. A panel's first pass counts that day as done without posting, so adding a panel, or installing this version,
 * never sends a list at some odd hour.
 */
export class ReminderService {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly failedAt = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly jobs: JobService,
    private readonly deliver: DeliverReminder,
    opts: { now?: () => number; logger?: Logger } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
  }

  /** The flights on this panel that start today (UTC) and still have nobody on some leg, soonest first. */
  due(panel: Panel): Reminder[] {
    const now = this.now();
    const dayStart = startOfUtcDay(now);
    const out: Reminder[] = [];
    for (const view of this.jobs.open(panel.id)) {
      const startsAt = startOf(view);
      if (startsAt === null || startsAt < dayStart || startsAt >= dayStart + DAY_MS) continue; // not a flight of today
      if (view.job.deadline !== null && view.job.deadline <= now) continue; // too late to ask
      const openLegs = openLegsOf(view);
      if (openLegs.length > 0) out.push({ view, openLegs, startsAt });
    }
    return out.sort((a, b) => a.startsAt - b.startsAt || a.view.job.id - b.view.job.id);
  }

  /** One pass over every panel: post today's list where it has not been posted yet. Returns how many messages went out. */
  async run(): Promise<number> {
    const now = this.now();
    const dayStart = startOfUtcDay(now);
    const day = dayStart / DAY_MS;
    let sent = 0;
    for (const panel of this.store.listAllPanels()) {
      // Today is done for a panel that has nothing to say or is not to say it: reminders off (turning them on later waits for the next
      // midnight), or a panel the bot has not dealt with before (new, or this is the first start with the daily list).
      if (panel.reminderMode === 'off' || panel.remindedDay === null) {
        if (panel.remindedDay !== day) this.store.updatePanel(panel.id, { remindedDay: day });
        continue;
      }
      if (panel.remindedDay >= day) continue; // already dealt with today
      if (now - dayStart > CATCH_UP_UNTIL_MS) {
        this.store.updatePanel(panel.id, { remindedDay: day }); // too late in the day to be worth posting
        continue;
      }
      const failed = this.failedAt.get(panel.id);
      if (failed !== undefined && now - failed < RETRY_AFTER_FAILURE_MS) continue;

      const due = this.due(panel);
      if (due.length === 0) {
        this.store.updatePanel(panel.id, { remindedDay: day });
        continue;
      }
      let ok = false;
      try {
        ok = await this.deliver(panel, due);
      } catch (e) {
        this.log.warn(`Could not announce unstaffed flights for ${panel.airlineName}`, e);
      }
      if (!ok) {
        this.failedAt.set(panel.id, now);
        continue;
      }
      this.failedAt.delete(panel.id);
      this.store.updatePanel(panel.id, { remindedDay: day });
      this.log.info(`Listed ${due.length} flight(s) without a pilot for today on ${panel.airlineName}`);
      sent++;
    }
    return sent;
  }
}
