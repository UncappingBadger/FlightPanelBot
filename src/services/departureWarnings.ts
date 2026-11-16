import type { JobView, Panel, Store } from '../db/store.js';
import { durationText, mention, plainText, routeText, truncate, ts } from '../util/format.js';
import { silentLogger, type Logger } from '../util/log.js';
import { confirmationsFor } from './flightMatch.js';
import type { FlightTime, FlightTimes } from './flightTime.js';
import type { JobService } from './jobs.js';
import type { LiveStatus, LiveTracker } from './liveTracker.js';
import { NOTICE_HINT } from './notices.js';

/** How many minutes before the latest take-off a pilot is warned, when the server has not chosen. */
export const DEPART_WARNING_DEFAULT_MINUTES = 30;
export const DEPART_WARNING_MIN_MINUTES = 5;
export const DEPART_WARNING_MAX_MINUTES = 180;

/** After a warning could not be delivered (closed DMs), try again after this long. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** Flight times learned from FsHub are kept this long. */
const ROUTE_TIME_KEEP_MS = 180 * 86_400_000;
const PRUNE_EVERY_MS = 24 * 3_600_000;

const MINUTE = 60_000;
/** The longest a flight (all its legs) is taken to last, so a deadline further off than this plus the warning time is not looked at yet. */
const MAX_FLIGHT_MS = 48 * 3_600_000;

/** One leg still to fly and how long it takes. */
export interface LegTime {
  legNo: number;
  dep: string;
  arr: string;
  time: FlightTime;
}

/** When a person has to take off, and what that was worked out from. */
export interface DeparturePlan {
  view: JobView;
  deadline: number;
  /** The latest take-off (epoch ms) that still lands inside the window, flying every leg from here on one after the other. */
  latest: number;
  legs: LegTime[];
  totalMinutes: number;
}

/** Sends one person a private message. Returns true if it went out. */
export type SendDm = (discordId: string, content: string) => Promise<boolean>;

type Target = { discordId: string; kind: 'pilot' | 'backup'; fromLeg: number; flownBy: string[] };

/**
 * Warns the pilot of a flight, and its backup, shortly before the latest moment they could take off and still land inside the
 * flight's window: the window's end less how long the flight takes. How long it takes comes from FsHub flights of the same route
 * where there are some, and from the distance between the airports otherwise (see flightTime.ts), and the warning says which.
 *
 * Where FsHub's live feed says a pilot is already in the air on this flight (or on one with no flight plan filed), they are not warned.
 * Without the feed it cannot see a pilot who is flying (FsHub shows a flight only once it has landed), so the warning says to ignore
 * it in that case. A flight whose legs FsHub already shows flown is counted from the first leg still to fly. Each person is warned once
 * per flight, and not at all once the latest take-off has passed. A flight whose time cannot be worked out (an airport with no
 * known position and no flight of that route seen) is not warned about: the bot does not guess.
 */
export class DepartureWarnings {
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly failedAt = new Map<string, number>();
  private lastPrune = 0;
  private readonly live: Pick<LiveTracker, 'statusOf'> | null;

  constructor(
    private readonly store: Store,
    private readonly jobs: JobService,
    private readonly times: Pick<FlightTimes, 'forLeg'>,
    private readonly send: SendDm,
    opts: { now?: () => number; logger?: Logger; live?: Pick<LiveTracker, 'statusOf'> } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
    this.live = opts.live ?? null;
  }

  /**
   * What the live feed says about the people this warning is about: whether one of them is in the air on this flight now, and
   * whether every one of them is known not to be. (Someone with no flight plan filed counts as flying this flight if they are in the air.)
   */
  private seen(ids: string[], plan: DeparturePlan): { flying: boolean; grounded: boolean } {
    const statuses = ids.map((id) => this.live?.statusOf(id) ?? null);
    const flying = statuses.some((s) => s !== null && s.state === 'airborne' && flyingThis(s, plan));
    const grounded = statuses.length > 0 && statuses.every((s) => s !== null && s.state !== 'airborne');
    return { flying, grounded };
  }

  /** Who may need warning about this flight, and from which leg each of them is flying on. */
  private targets(panel: Panel, view: JobView, now: number): Target[] {
    const done = confirmationsFor(this.store, panel, [view], now).get(view.job.id);
    const remaining = view.legs.filter((l) => !done?.has(l.legNo)).sort((a, b) => a.legNo - b.legNo);
    if (remaining.length === 0) return [];
    const out = new Map<string, Target>();
    for (const leg of remaining) {
      if (leg.holder && !out.has(leg.holder.discordId)) out.set(leg.holder.discordId, { discordId: leg.holder.discordId, kind: 'pilot', fromLeg: leg.legNo, flownBy: [] });
    }
    const flyers = [...new Set(remaining.filter((l) => l.holder).map((l) => l.holder!.discordId))];
    const backup = view.backup;
    if (backup && !out.has(backup.discordId) && flyers.length > 0) {
      out.set(backup.discordId, { discordId: backup.discordId, kind: 'backup', fromLeg: (remaining[0] as { legNo: number }).legNo, flownBy: flyers });
    }
    return [...out.values()];
  }

  /**
   * The latest take-off for the flight from this leg on, or null when the flight has no end to its window or the time of a leg
   * cannot be worked out.
   */
  async plan(panel: Panel, view: JobView, fromLeg: number, now: number): Promise<DeparturePlan | null> {
    const deadline = view.job.deadline;
    if (deadline === null) return null;
    const done = confirmationsFor(this.store, panel, [view], now).get(view.job.id);
    const legs: LegTime[] = [];
    for (const leg of [...view.legs].sort((a, b) => a.legNo - b.legNo)) {
      if (leg.legNo < fromLeg || done?.has(leg.legNo)) continue;
      const time = await this.times.forLeg(panel, leg.dep, leg.arr, view.job.aircraft);
      if (!time) return null;
      legs.push({ legNo: leg.legNo, dep: leg.dep, arr: leg.arr, time });
    }
    if (legs.length === 0) return null;
    const totalMinutes = legs.reduce((sum, l) => sum + l.time.minutes, 0);
    return { view, deadline, latest: deadline - totalMinutes * MINUTE, legs, totalMinutes };
  }

  /** One pass over every panel. Returns how many warnings went out. */
  async run(): Promise<number> {
    const now = this.now();
    if (now - this.lastPrune > PRUNE_EVERY_MS) {
      this.lastPrune = now;
      this.store.pruneRouteTimes(now - ROUTE_TIME_KEEP_MS);
    }
    let sent = 0;
    for (const panel of this.store.listAllPanels()) {
      if (panel.departWarningMinutes <= 0) continue;
      const lead = panel.departWarningMinutes * MINUTE;
      for (const view of this.jobs.open(panel.id)) {
        const job = view.job;
        if (job.completedAt !== null || job.deadline === null || job.deadline <= now) continue;
        if (job.deadline - now > MAX_FLIGHT_MS + lead) continue; // no flight takes this long, so the time to warn is a long way off
        const pending = this.targets(panel, view, now).filter((t) => {
          // Someone who has turned these warnings off is left alone, and not marked as warned: if they turn them back on before the
          // latest take-off, they are still warned in time.
          if (!this.store.wantsNotice(t.discordId, 'takeoff')) return false;
          if (this.store.wasWarned(job.id, t.discordId)) return false;
          const failed = this.failedAt.get(`${job.id}:${t.discordId}`);
          return failed === undefined || now - failed >= RETRY_AFTER_FAILURE_MS;
        });
        if (pending.length === 0) continue;

        const plans = new Map<number, DeparturePlan | null>();
        for (const target of pending) {
          if (!plans.has(target.fromLeg)) plans.set(target.fromLeg, await this.plan(panel, view, target.fromLeg, now));
          const plan = plans.get(target.fromLeg);
          if (!plan || now >= plan.latest || now < plan.latest - lead) continue;

          const seen = this.seen(target.kind === 'pilot' ? [target.discordId] : target.flownBy, plan);
          if (seen.flying) continue; // already in the air on it: nothing to warn about
          const content = target.kind === 'pilot' ? pilotWarning(panel, plan, seen.grounded) : backupWarning(panel, plan, target.flownBy, seen.grounded);
          let ok = false;
          try {
            ok = await this.send(target.discordId, content);
          } catch (e) {
            this.log.debug(`Could not send a departure warning to ${target.discordId}`, e);
          }
          if (!ok) {
            this.failedAt.set(`${job.id}:${target.discordId}`, now);
            continue;
          }
          this.failedAt.delete(`${job.id}:${target.discordId}`);
          this.store.markWarned(job.id, target.discordId, now);
          this.log.info(`Warned a ${target.kind} that ${job.code} must take off by ${new Date(plan.latest).toISOString()}`);
          sent++;
        }
      }
    }
    return sent;
  }
}

/** Whether a pilot in the air is flying this flight: yes unless they filed a plan for different airports. */
function flyingThis(status: LiveStatus, plan: DeparturePlan): boolean {
  if (!status.dep || !status.arr) return true;
  return plan.legs.some((l) => l.dep.toUpperCase() === status.dep && l.arr.toUpperCase() === status.arr);
}

/** The flight times, and where each came from. */
function timeLines(plan: DeparturePlan): string {
  const [only] = plan.legs;
  if (plan.legs.length === 1 && only) return `Flight time used: **${durationText(only.time.minutes)}**, ${only.time.basis}.`;
  return [
    'Flight times used:',
    ...plan.legs.map((l) => `• ${l.dep} → ${l.arr}: **${durationText(l.time.minutes)}**, ${l.time.basis}`),
    `Together **${durationText(plan.totalMinutes)}**, not counting time on the ground between legs.`,
  ].join('\n');
}

function headline(panel: Panel, plan: DeparturePlan): string {
  const airline = plainText(truncate(panel.airlineName, 60));
  const route = routeText(plan.legs.map((l) => ({ dep: l.dep, arr: l.arr })));
  return `⏰ **${airline}**: **${plan.view.job.code}** (${route})`;
}

/** What the pilot of a flight is told. */
export function pilotWarning(panel: Panel, plan: DeparturePlan, notInAir = false): string {
  return [
    `${headline(panel, plan)}: to land inside its window you need to take off by **${ts(plan.latest, 't')}** (${ts(plan.latest, 'R')}).`,
    `It has to be down by ${ts(plan.deadline, 'f')}. ${timeLines(plan)}`,
    notInAir
      ? "This is only a heads-up. FsHub's live feed doesn't show you in the air right now. If you can't fly it any more, give it back from **My flights** on the panel so someone else can."
      : "This is only a heads-up. If you have already taken off, ignore it: I only see a flight once FsHub shows it landed. If you can't fly it any more, give it back from **My flights** on the panel so someone else can.",
    NOTICE_HINT,
  ].join('\n');
}

/** What the backup pilot of a flight is told. */
export function backupWarning(panel: Panel, plan: DeparturePlan, flownBy: string[], notInAir = false): string {
  const who = flownBy.length > 0 ? `, flown by ${flownBy.map(mention).join(' and ')}` : '';
  return [
    `${headline(panel, plan)}${who}: you are down as its backup, and to land inside its window it has to take off by **${ts(plan.latest, 't')}** (${ts(plan.latest, 'R')}).`,
    `It has to be down by ${ts(plan.deadline, 'f')}. ${timeLines(plan)}`,
    notInAir
      ? "FsHub's live feed doesn't show the pilot in the air yet, so this may be the moment to check they are on their way."
      : "I can't see whether the pilot has gone (FsHub shows a flight only once it has landed), so this may be the moment to check they are on their way.",
    NOTICE_HINT,
  ].join('\n');
}
