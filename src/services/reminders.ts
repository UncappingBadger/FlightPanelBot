import type { JobView, Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { JobService } from './jobs.js';

/** A flight with no pilot is announced this long before it starts. */
export const REMINDER_LEAD_MS = 24 * 3_600_000;
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
 * Watches for flights that still have no pilot 24 hours before they start and announces each one
 * once, in a single message per panel. Knows nothing about Discord: `deliver` does the posting.
 *
 * A flight is announced again only if it gets a pilot and later loses them, so nobody is nagged
 * about the same flight over and over.
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

  /** The flights on this panel that need announcing right now, soonest first. */
  due(panel: Panel): Reminder[] {
    const now = this.now();
    const out: Reminder[] = [];
    for (const view of this.jobs.open(panel.id)) {
      const startsAt = startOf(view);
      if (startsAt === null || view.job.remindedAt !== null) continue;
      if (startsAt - REMINDER_LEAD_MS > now) continue; // more than a day away
      if (view.job.deadline !== null && view.job.deadline <= now) continue; // too late to ask
      const openLegs = openLegsOf(view);
      if (openLegs.length > 0) out.push({ view, openLegs, startsAt });
    }
    return out.sort((a, b) => a.startsAt - b.startsAt || a.view.job.id - b.view.job.id);
  }

  /**
   * One pass over every panel: forget the announcement for flights that have since found a pilot,
   * then announce the ones that need it. Returns how many messages went out.
   */
  async run(): Promise<number> {
    const now = this.now();
    let sent = 0;
    for (const panel of this.store.listAllPanels()) {
      if (panel.reminderMode === 'off') continue;

      // A flight that has a pilot again may be announced afresh if it loses them.
      for (const view of this.jobs.open(panel.id)) {
        if (view.job.remindedAt !== null && openLegsOf(view).length === 0) this.store.updateJob(view.job.id, { remindedAt: null });
      }

      const failed = this.failedAt.get(panel.id);
      if (failed !== undefined && now - failed < RETRY_AFTER_FAILURE_MS) continue;
      const due = this.due(panel);
      if (due.length === 0) continue;

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
      for (const r of due) this.store.updateJob(r.view.job.id, { remindedAt: now });
      this.log.info(`Asked for pilots for ${due.length} flight(s) on ${panel.airlineName}`);
      sent++;
    }
    return sent;
  }
}
