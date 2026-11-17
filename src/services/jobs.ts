import type { Holder, Job, JobView, Panel, Store } from '../db/store.js';
import type { SourceJob } from '../jobs/types.js';
import { DEBUG_BUILD, dbg } from '../util/debugBuild.js';
import { silentLogger, type Logger } from '../util/log.js';
import { mergeNotices, type BackupNotice, type JobEvents, type ReleasedNotice } from './events.js';
import { flightIdChunks, MAX_ID_WORDS, MAX_SHOWN_ID } from './flightIds.js';
import { namedForOneOf } from './pilotNames.js';
import { dayOf, flyableOn, matchesAircraft, matchesSearch, type SearchDay } from './search.js';

export type JobErrorCode = 'NOT_FOUND' | 'EXPIRED' | 'BAD_INPUT';

/** An expected, user-facing failure. `message` is safe to show in Discord as-is. */
export class JobError extends Error {
  constructor(
    readonly code: JobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  /** Flights the source newly shows as completed (they stay on the panel, marked done, for a day). */
  completed: number;
  /** People whose reservation was taken away by this sync (job removed, or its legs changed). */
  released: ReleasedNotice[];
  /**
   * Flight numbers the source gave a flight that could not be used as its ID because another flight on the panel already
   * has that ID, so the flight kept the one it had (or got an automatic one). Reported to the admin.
   */
  numberClashes?: string[];
  /** Backup pilots whose flight is gone or has nobody flying it any more, so their backup spot ended. They are told. */
  backupEnded?: BackupNotice[];
}

export interface ReserveResult {
  /** Legs newly reserved for this person. */
  reserved: number[];
  /** Legs they already held. */
  alreadyMine: number[];
  /**
   * Legs someone else holds, so nothing was changed for them. `holder` is the Discord reservation;
   * when it is null the leg is taken by a name in the airline's own schedule (`sheetHolder`).
   */
  taken: Array<{ legNo: number; holder: Holder | null; sheetHolder: string | null }>;
  job: JobView;
}

/** What `JobService.findSeveral` found in a message: flights and unrecognised IDs in the order written, and the words it did not get to. */
export interface FoundIds {
  items: Array<{ kind: 'flight'; view: JobView } | { kind: 'unknown'; typed: string }>;
  skipped: string[];
}
/** Most flights taken from one message. Each one may be written to the airline's sheet in turn, so there is a limit. */
export const MAX_IDS_AT_ONCE = 10;

const DAY = 24 * 3_600_000;
const STALE_AFTER_MS = 7 * DAY;
/** How long a completed flight stays on the panel, marked done. */
export const COMPLETED_SHOW_MS = DAY;
/**
 * The panel lists the flights that are open now or start within a number of days from now (1 to 7, chosen per panel with
 * `/setup window`; a new panel shows 7). A schedule often runs weeks ahead, and showing all of it buries the flights that can
 * be flown soon; later ones appear once they come within the period. A pilot can only reach what the panel lists: a flight
 * beyond the period cannot be reserved, stood by for or searched for (typing its ID does not get round that), until it
 * comes within the period. Only admins can still reach it, by its ID, to release someone from it.
 */
export const PANEL_DAYS_MIN = 1;
export const PANEL_DAYS_MAX = 7;
/** The period a new panel shows, and the longest any panel can. */
export const PANEL_HORIZON_MS = PANEL_DAYS_MAX * DAY;
/** How far ahead a panel set to show `days` days lists flights. */
export const panelHorizonMs = (days: number): number => Math.min(PANEL_DAYS_MAX, Math.max(PANEL_DAYS_MIN, Math.round(days))) * DAY;
/**
 * What a pilot is told when they ask for a flight that starts further off than the panel's days: the rule, with the admin's number
 * of days in it, and when the flight will be open. `verb` is what they were trying to do ("book" or "stand by for").
 */
export const beyondDaysText = (days: number, code: string, verb: 'book' | 'stand by for'): string => {
  const d = `${days} day${days === 1 ? '' : 's'}`;
  return `You can't ${verb} flights more than ${d} ahead, and **${code}** starts further off than that. It will be open for booking once it comes within ${d}.`;
};
/** The same, for flights asked for together (several IDs in one message): one sentence naming all of them. */
export const beyondDaysManyText = (days: number, codes: string[]): string => {
  if (codes.length === 1) return beyondDaysText(days, codes[0]!, 'book');
  const d = `${days} day${days === 1 ? '' : 's'}`;
  return `You can't book flights more than ${d} ahead, and ${andList(codes.map((c) => `**${c}**`))} start further off than that. They will be open for booking once they come within ${d}.`;
};
/** "a", "a and b", "a, b and c". */
export const andList = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
/** Is this flight one the panel lists: open now, or starting within the panel's days? The search uses the same rule, so it never finds more than the panel shows. */
export const inPanelWindow = (job: { availableFrom: number | null }, now: number, days: number): boolean => job.availableFrom === null || job.availableFrom <= now + panelHorizonMs(days);
/**
 * After a pilot completes a flight here, a sheet that still shows the box unticked is not believed
 * for this long: the tick was only just written, and the sheet's published copy can lag behind.
 */
export const COMPLETION_GRACE_MS = 10 * 60_000;
/** A pilot can still report a flight completed this long after its window closed. */
export const COMPLETE_AFTER_DEADLINE_MS = 2 * DAY;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Turn what a pilot typed into a job code for this panel. Accepts `DMO-007`, `dmo007`, `DMO 7`
 * or just `7`. Returns null if it can't be a code for this panel.
 */
export function normalizeCode(prefix: string, input: string): string | null {
  const t = input.trim().toUpperCase().replace(/\s+/g, '');
  if (!t) return null;
  let digits: string | null = null;
  if (/^\d{1,6}$/.test(t)) digits = t;
  else {
    const m = new RegExp(`^${escapeRegExp(prefix.toUpperCase())}-?(\\d{1,6})$`).exec(t);
    if (m) digits = m[1] as string;
  }
  if (digits === null) return null;
  return `${prefix}-${String(Number(digits)).padStart(3, '0')}`;
}

/** Derive a short, typeable code prefix from an airline's abbreviation or name. */
export function defaultPrefix(airline: { name: string; abbr: string | null }): string {
  const fromAbbr = (airline.abbr ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  if (fromAbbr.length >= 2) return fromAbbr;
  const initials = airline.name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .slice(0, 5);
  return initials.length >= 2 ? initials : (airline.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'JOB');
}

/**
 * The flight list for panels, and who has which leg. Knows nothing about Discord: it reports what
 * changed through `JobEvents` and leaves the drawing to the panel.
 */
export class JobService {
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly events: JobEvents,
    opts: { now?: () => number; logger?: Logger } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.logger ?? silentLogger;
  }

  /* ------------------------------------------------------------------ syncing from a source */

  /**
   * Make the panel's jobs match `jobs`. A job the source still lists keeps its bot ID and its
   * reservations; a new job gets the next ID; a job the source no longer lists is closed and its
   * holders are told. A leg whose airports changed loses its reservation (the flight is different now).
   */
  sync(panelId: number, jobs: SourceJob[]): SyncResult {
    const now = this.now();
    const result = this.store.tx(() => {
      const panel = this.store.getPanel(panelId);
      if (!panel) throw new JobError('NOT_FOUND', 'That panel no longer exists.');
      const out: SyncResult = { added: 0, updated: 0, removed: 0, completed: 0, released: [], numberClashes: [], backupEnded: [] };
      const seen = new Set<number>();
      if (DEBUG_BUILD) dbg(this.log, `sync ${panel.airlineName} (panel ${panelId}): the source lists ${jobs.length} flight(s); ${this.store.listJobs(panelId, 'open').length} are open here now`);
      /** The ID a flight gets: its flight number when it has one that no other flight on the panel has, else the automatic one. */
      const claim = (wanted: string | null | undefined, ownCode?: string): string | null => {
        if (!wanted || wanted === ownCode) return null;
        if (this.store.getJobByCode(panelId, wanted)) {
          out.numberClashes!.push(wanted);
          return null;
        }
        return wanted;
      };

      for (const sj of jobs) {
        const existing = this.store.getJobBySourceKey(panelId, sj.key);

        // Is it completed? A source that tracks completion (a schedule sheet) is believed, except for
        // a few minutes after a pilot completed the flight here, when the sheet may not show it yet.
        // A source that doesn't track completion says nothing, so what we know stays.
        let completed: boolean;
        if (!existing) completed = sj.completed === true;
        else if (sj.completed === undefined) completed = existing.completedAt !== null;
        else if (sj.completed) completed = true;
        // A completion FsHub confirmed stands even if the sheet is never ticked; one a pilot only claimed is given a few minutes.
        else completed = existing.completedBy !== null && existing.completedAt !== null && (existing.completedVia === 'fshub' || now - existing.completedAt < COMPLETION_GRACE_MS);
        const expired = (sj.deadline !== null && sj.deadline <= now) || sj.closed === true || completed;

        if (!existing) {
          // Never list a job that is already over. The exception is a flight that was flown recently:
          // it is worth showing as completed.
          const showAsCompleted = completed && (sj.deadline === null || sj.deadline > now - COMPLETED_SHOW_MS);
          if (expired && !showAsCompleted) continue;
          const code = claim(sj.flightNumber) ?? this.store.allocateCode(panelId);
          const job = this.store.insertJob({
            panelId,
            code,
            sourceKey: sj.key,
            title: sj.title,
            aircraft: sj.aircraft,
            availableFrom: sj.availableFrom,
            deadline: sj.deadline,
            pay: sj.pay,
            notes: sj.notes,
            distanceNm: sj.distanceNm ?? null,
            status: expired ? 'expired' : 'open',
            completedAt: completed ? now : null,
            now,
          });
          sj.legs.forEach((l, i) => this.store.insertLeg(job.id, i + 1, l.dep, l.arr, l.heldBy ?? null));
          if (DEBUG_BUILD) dbg(this.log, `sync: NEW ${job.code} key=${sj.key} status=${expired ? 'expired' : 'open'}${sj.legs.some((l) => l.heldBy) ? ` sheet-name=${sj.legs.find((l) => l.heldBy)?.heldBy}` : ''}`);
          seen.add(job.id);
          if (completed) out.completed++;
          else out.added++;
          continue;
        }

        seen.add(existing.id);
        const status = expired ? 'expired' : 'open';
        // Completed the first time it is seen so; forgotten again if the box is unticked.
        const completedAt = completed ? (existing.completedAt ?? now) : null;
        const completedBy = completed ? existing.completedBy : null;
        const completedVia = completed ? existing.completedVia : null;
        if (completed && existing.completedAt === null) out.completed++;
        // The airline's flight number becomes the flight's ID, also for a flight the bot already knew by its automatic one.
        // (A number taken away again leaves the ID as it was: IDs don't change back and forth.)
        const number = claim(sj.flightNumber, existing.code);
        if (number) this.store.setJobCode(existing.id, number);
        let changed =
          number !== null ||
          existing.title !== sj.title ||
          existing.aircraft !== sj.aircraft ||
          existing.availableFrom !== sj.availableFrom ||
          existing.deadline !== sj.deadline ||
          existing.pay !== sj.pay ||
          existing.notes !== sj.notes ||
          existing.distanceNm !== (sj.distanceNm ?? null) ||
          existing.status !== status ||
          existing.completedAt !== completedAt ||
          existing.completedBy !== completedBy ||
          existing.completedVia !== completedVia;
        if (DEBUG_BUILD && changed) {
          const what: string[] = [];
          if (number !== null) what.push(`code ${existing.code}->${number}`);
          if (existing.aircraft !== sj.aircraft) what.push(`aircraft ${existing.aircraft}->${sj.aircraft}`);
          if (existing.availableFrom !== sj.availableFrom) what.push('window start');
          if (existing.deadline !== sj.deadline) what.push('window end/deadline');
          if (existing.notes !== sj.notes) what.push(`notes ${existing.notes}->${sj.notes}`);
          if (existing.status !== status) what.push(`status ${existing.status}->${status}`);
          if (existing.completedAt !== completedAt) what.push(`completedAt ${existing.completedAt === null ? 'none' : 'set'}->${completedAt === null ? 'none' : 'set'}`);
          if (what.length > 0) dbg(this.log, `sync: CHANGED ${existing.code} key=${sj.key}: ${what.join('; ')}`);
        }
        this.store.updateJob(existing.id, {
          title: sj.title,
          aircraft: sj.aircraft,
          availableFrom: sj.availableFrom,
          deadline: sj.deadline,
          pay: sj.pay,
          notes: sj.notes,
          distanceNm: sj.distanceNm ?? null,
          status,
          completedAt,
          completedBy,
          completedVia,
          lastSeen: now,
        });

        const oldLegs = this.store.listLegs(existing.id);
        const releasedBefore = out.released.length;
        for (let i = 0; i < Math.max(oldLegs.length, sj.legs.length); i++) {
          const o = oldLegs[i];
          const nw = sj.legs[i];
          if (o && nw && o.dep === nw.dep && o.arr === nw.arr) {
            // Same flight; the source may have a different name against it now.
            const named = nw.heldBy ?? null;
            if (o.sheetHolder !== named) {
              if (DEBUG_BUILD) {
                const h = this.store.getHolder(existing.id, o.legNo);
                dbg(this.log, `sync: SHEET NAME on ${existing.code} leg ${o.legNo}: "${o.sheetHolder ?? ''}" -> "${named ?? ''}" (Discord reservation on that leg: ${h ? `${h.username} (${h.discordId}), kept` : 'none'})`);
              }
              this.store.setLegSheetHolder(existing.id, o.legNo, named);
              changed = true;
            }
            continue;
          }
          changed = true;
          if (DEBUG_BUILD) dbg(this.log, `sync: LEG CHANGED on ${existing.code} key=${sj.key} leg ${i + 1}: ${o ? `${o.dep}-${o.arr}` : '(none)'} -> ${nw ? `${nw.dep}-${nw.arr}` : '(none)'}`);
          if (o) {
            const holder = this.store.getHolder(existing.id, o.legNo);
            if (holder) out.released.push({ panelId, discordId: holder.discordId, jobCode: existing.code, legNos: [o.legNo], reason: 'changed' });
            this.store.deleteLeg(existing.id, o.legNo); // takes its reservation with it
          }
          if (nw) this.store.insertLeg(existing.id, i + 1, nw.dep, nw.arr, nw.heldBy ?? null);
        }
        if (changed) out.updated++;
        // A change to the route took the pilots off it: a backup has nobody to stand in for now.
        if (out.released.length > releasedBefore) this.endBackup(existing.id, 'freed', out.backupEnded!);
      }

      for (const job of this.store.listJobs(panelId, 'open')) {
        if (seen.has(job.id)) continue;
        if (DEBUG_BUILD) {
          const holders = this.store.listLegs(job.id).map((l) => ({ l, h: this.store.getHolder(job.id, l.legNo) })).filter((x) => x.h);
          dbg(this.log, `sync: REMOVED ${job.code} key=${job.sourceKey} (no row in the source reads as this flight any more)${holders.length > 0 ? `; Discord holders released: ${holders.map((x) => `leg ${x.l.legNo} ${x.h!.username} (${x.h!.discordId})`).join(', ')}` : '; nobody held it in Discord'}`);
        }
        for (const leg of this.store.listLegs(job.id)) {
          const holder = this.store.getHolder(job.id, leg.legNo);
          if (holder) out.released.push({ panelId, discordId: holder.discordId, jobCode: job.code, legNos: [leg.legNo], reason: 'removed' });
          this.store.deleteReservation(job.id, leg.legNo);
        }
        this.endBackup(job.id, 'removed', out.backupEnded!);
        this.store.updateJob(job.id, { status: 'removed' });
        out.removed++;
      }

      out.released = mergeNotices(out.released);
      return out;
    });

    if (DEBUG_BUILD) {
      dbg(this.log, `sync done (panel ${panelId}): +${result.added} ~${result.updated} -${result.removed} completed ${result.completed}; ${result.released.length} reservation holder(s) released${result.released.length > 0 ? `: ${result.released.map((n) => `${n.jobCode} legs ${n.legNos.join('/')} ${n.discordId} (${n.reason})`).join(', ')}` : ''}`);
    }
    this.events.emit({ type: 'changed', panelId });
    for (const notice of result.released) this.events.emit({ type: 'released', notice });
    for (const notice of result.backupEnded ?? []) this.events.emit({ type: 'backup-ended', notice });
    return result;
  }

  /**
   * End a flight's backup spot when it has no point any more: for `removed` always (the flight is gone), for `freed` once
   * nobody (no Discord pilot and no name in the schedule) is flying any leg. The notice is added to `into` for the caller to
   * announce. Call inside a transaction.
   */
  private endBackup(jobId: number, reason: BackupNotice['reason'], into: BackupNotice[]): void {
    const view = this.store.getJobView(jobId);
    if (!view?.backup) return;
    if (reason === 'freed' && view.legs.some((l) => l.holder || l.sheetHolder)) return;
    this.store.deleteBackup(jobId);
    into.push({ panelId: view.job.panelId, discordId: view.backup.discordId, jobCode: view.job.code, reason });
  }

  /** Close jobs whose deadline has passed. Returns the panels that changed. */
  expireDue(): number[] {
    const panels = this.store.expireDueJobs(this.now());
    for (const id of panels) this.events.emit({ type: 'changed', panelId: id });
    return panels;
  }

  /** Housekeeping: forget long-finished jobs and stale DM conversations. */
  cleanup(): void {
    const now = this.now();
    this.store.deleteStaleJobs(now, STALE_AFTER_MS);
    this.store.purgeSessions(now);
  }

  /* ------------------------------------------------------------------ reading */

  open(panelId: number): JobView[] {
    return this.store.listOpenJobViews(panelId);
  }

  /** Flights completed in the last day, most recent first. The panel lists them as done. */
  completed(panelId: number): JobView[] {
    return this.store.listCompletedJobViews(panelId, this.now() - COMPLETED_SHOW_MS);
  }

  findByCode(panel: Panel, input: string): JobView | null {
    // What was typed may be a flight number as the airline writes it (any case, spaces ignored) or one of the bot's own IDs
    // in its shorter forms (`dmo7`, `7`). A flight number is tried first: it is exactly what is on the panel.
    const typed = input.trim().toUpperCase().replace(/\s+/g, '');
    const code = (typed && this.store.getJobByCode(panel.id, typed) ? typed : null) ?? normalizeCode(panel.prefix, input);
    // A flight number flown on several days carries the day in its ID (`SKY330-17NOV`). Just the number finds it when only one such flight is open.
    const job = (code ? this.store.getJobByCode(panel.id, code) : null) ?? this.datedFlight(panel.id, typed);
    if (!job || job.status !== 'open') return null;
    // A deadline that has just passed counts as closed even if the sweep hasn't run yet.
    if (job.deadline !== null && job.deadline <= this.now()) return null;
    return this.store.getJobView(job.id);
  }

  /** The one open flight whose ID is this flight number with a day on the end (`SKY330` for `SKY330-17NOV`), or null when none or several are. */
  private datedFlight(panelId: number, typed: string): Job | null {
    if (!/^[A-Z][A-Z0-9]{1,15}$/.test(typed)) return null;
    const hits = this.store.listJobs(panelId, 'open').filter((j) => j.code.startsWith(`${typed}-`) && /^\d{2}[A-Z]{3}$/.test(j.code.slice(typed.length + 1)));
    return hits.length === 1 ? (hits[0] as Job) : null;
  }

  /**
   * Every flight named in a message that may hold several IDs (`DMO-004, DMO-007 and DMO-011`, or one to a line), in the
   * order they were written, each flight once however many times or ways it was named. A word that names no open flight
   * is reported back as `unknown` when it has a number in it (it looks like an ID that was mistyped, or is closed); a word with
   * no number in it is a word of the sentence ("please", "reserve") and is left out. Each word is tried on its own first and
   * is only joined to the next when it is not a flight by itself, so `DMO 7` is one flight and `7 8` is two. At most `max`
   * flights are taken; the words after that are given back in `skipped` to be sent again. Like `findByCode` it does not look
   * at the panel's days (see `isListed`).
   */
  findSeveral(panel: Panel, text: string, max = MAX_IDS_AT_ONCE): FoundIds {
    const items: FoundIds['items'] = [];
    const skipped: string[] = [];
    const seenFlights = new Set<number>();
    const seenWords = new Set<string>();
    const shown = (w: string) => w.slice(0, MAX_SHOWN_ID);
    let looked = 0;
    for (const words of flightIdChunks(text)) {
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        if (seenFlights.size >= max || looked >= MAX_ID_WORDS) {
          if (/\d/.test(word) && !skipped.some((s) => s.toUpperCase() === shown(word).toUpperCase())) skipped.push(shown(word));
          continue;
        }
        looked++;
        let view = this.findByCode(panel, word);
        if (!view && i + 1 < words.length) {
          view = this.findByCode(panel, `${word}${words[i + 1]}`);
          if (view) i++;
        }
        if (view) {
          if (!seenFlights.has(view.job.id)) {
            seenFlights.add(view.job.id);
            items.push({ kind: 'flight', view });
          }
        } else if (/\d/.test(word) && !seenWords.has(word.toUpperCase())) {
          seenWords.add(word.toUpperCase());
          items.push({ kind: 'unknown', typed: shown(word) });
        }
      }
    }
    return { items, skipped };
  }

  /** The flights the panel lists: open now or starting within the panel's days. These are the only ones a pilot can reach. */
  listed(panel: Panel): JobView[] {
    const now = this.now();
    return this.open(panel.id).filter((v) => inPanelWindow(v.job, now, panel.showDays));
  }

  /**
   * Does the panel list this flight? A pilot can only reserve or stand by for a flight it lists: one that starts beyond the
   * panel's days is not open for booking yet, whatever way they got its ID. (`findByCode` does not look at the days; it is also
   * what admins use to release people from a flight.)
   */
  isListed(panel: Panel, view: JobView): boolean {
    return inPanelWindow(view.job, this.now(), panel.showDays);
  }

  view(jobId: number): JobView | null {
    return this.store.getJobView(jobId);
  }

  /**
   * The flights a pilot's search finds: those that go from `from` to `to` (see `matchesSearch`) among the flights the panel
   * lists, which is the flights open now or starting within the panel's days. A search never finds more than the panel shows.
   * With a day, only flights that can be flown at some point on that (Zulu) day; with aircraft types, only flights in one of
   * them. Any one of airports, a day or types may be the only thing asked for. Soonest deadline first.
   */
  search(panel: Panel, from: string[], to: string[], day?: SearchDay | null, aircraft: string[] = []): JobView[] {
    const now = this.now();
    const byAirport = from.length > 0 || to.length > 0;
    if (!byAirport && !day && aircraft.length === 0) return [];
    return this.open(panel.id).filter(
      (v) =>
        inPanelWindow(v.job, now, panel.showDays) &&
        (v.job.deadline === null || v.job.deadline > now) &&
        (!day || flyableOn(v.job, day)) &&
        matchesAircraft(v.job.aircraft, aircraft) &&
        (!byAirport || matchesSearch(v, from, to)),
    );
  }

  /**
   * The latest day a search on this panel can ask about: the day that holds the end of the panel's days, because the panel
   * lists nothing that opens later than that.
   */
  lastSearchDay(panel: Panel): SearchDay {
    return dayOf(this.now() + panelHorizonMs(panel.showDays));
  }

  mine(panelId: number, discordId: string): JobView[] {
    return this.store.listReservationsByUser(panelId, discordId);
  }

  /* ------------------------------------------------------------------ reserving */

  /**
   * Reserve legs of a job for someone. Free legs are taken; legs they already hold are reported;
   * legs held by others are left alone and reported, never overwritten.
   */
  reserve(jobId: number, legNos: number[], user: { discordId: string; username: string }): ReserveResult {
    const now = this.now();
    const result = this.store.tx((): ReserveResult => {
      const view = this.store.getJobView(jobId);
      if (!view || view.job.status !== 'open') throw new JobError('NOT_FOUND', 'That flight is no longer on the panel.');
      if (view.job.deadline !== null && view.job.deadline <= now) throw new JobError('EXPIRED', `${view.job.code} has passed its deadline.`);
      // Whatever way the flight was reached (a typed ID, a conversation left open while the admin shortened the days), the panel
      // has to list it: a flight further off than the panel's days is not open for reservation yet.
      const panel = this.store.getPanel(view.job.panelId);
      if (panel && !inPanelWindow(view.job, now, panel.showDays)) throw new JobError('NOT_FOUND', beyondDaysText(panel.showDays, view.job.code, 'book'));

      const wanted = [...new Set(legNos)].sort((a, b) => a - b);
      if (wanted.length === 0) throw new JobError('BAD_INPUT', 'Pick at least one leg.');
      const known = new Set(view.legs.map((l) => l.legNo));
      const unknown = wanted.find((n) => !known.has(n));
      if (unknown !== undefined) throw new JobError('BAD_INPUT', `${view.job.code} has no leg ${unknown}.`);

      const out: ReserveResult = { reserved: [], alreadyMine: [], taken: [], job: view };
      for (const legNo of wanted) {
        const holder = this.store.getHolder(jobId, legNo);
        const sheetHolder = view.legs.find((l) => l.legNo === legNo)?.sheetHolder ?? null;
        if (holder?.discordId === user.discordId) out.alreadyMine.push(legNo);
        else if (holder || sheetHolder) out.taken.push({ legNo, holder, sheetHolder });
        else {
          this.store.insertReservation(jobId, legNo, user.discordId, user.username, now);
          out.reserved.push(legNo);
        }
      }
      out.job = this.store.getJobView(jobId) as JobView;
      return out;
    });
    if (result.reserved.length > 0) this.events.emit({ type: 'changed', panelId: result.job.job.panelId });
    return result;
  }

  /**
   * The flights a pilot could mark completed: ones they hold every leg of, that are still open or
   * only just past their deadline (people report a flight after landing it), and not already completed.
   */
  completable(panelId: number, discordId: string): JobView[] {
    return this.store
      .listHeldJobViews(panelId, discordId, this.now() - COMPLETE_AFTER_DEADLINE_MS)
      .filter((v) => v.legs.length > 0 && v.legs.every((l) => l.holder?.discordId === discordId));
  }

  /**
   * The flights a pilot may be flying without having pressed Reserve: ones the airline's sheet names for them (as any of
   * `names`) while nobody holds them in Discord, not completed, open or only just past their deadline. A name in a sheet is
   * only someone's word, so these are completed only on FsHub's record of the pilot's own landing (see `completeNamed`).
   */
  namedFor(panelId: number, names: string[]): JobView[] {
    if (names.length === 0) return [];
    return this.store.listNamedJobViews(panelId, this.now() - COMPLETE_AFTER_DEADLINE_MS).filter((v) => namedForOneOf(v, names) !== null);
  }

  /** Can this flight still be reported completed: not completed already, and open or only just past its deadline? */
  private completableNow(j: Job | undefined, now: number): j is Job {
    return j !== undefined && j.completedAt === null && (j.status === 'open' || (j.status === 'expired' && j.deadline !== null && j.deadline > now - COMPLETE_AFTER_DEADLINE_MS));
  }

  /**
   * A pilot marks a flight completed. They must hold every leg of it. The flight leaves the open
   * list and is shown as completed; the person who completed it is remembered. `via` is `fshub` when
   * FsHub's own record of the landing was what confirmed it (such a completion is not undone by a sheet
   * that has not been ticked).
   */
  complete(jobId: number, discordId: string, via: 'fshub' | null = null): JobView {
    const now = this.now();
    const view = this.store.tx(() => {
      const current = this.store.getJobView(jobId);
      const j = current?.job;
      if (!current || !this.completableNow(j, now)) throw new JobError('NOT_FOUND', 'That flight is no longer open, so it can\'t be completed from here.');
      if (current.legs.length === 0 || current.legs.some((l) => l.holder?.discordId !== discordId)) {
        throw new JobError('BAD_INPUT', `You can only complete a flight you hold every leg of, and ${current.job.code} has legs that aren't yours.`);
      }
      this.store.updateJob(jobId, { status: 'expired', completedAt: now, completedBy: discordId, completedVia: via });
      return this.store.getJobView(jobId) as JobView;
    });
    this.events.emit({ type: 'changed', panelId: view.job.panelId });
    return view;
  }

  /**
   * Complete a flight the airline's sheet names for this pilot (as one of `names`) that nobody holds in Discord, for the
   * pilot FsHub showed flying it. Their name in the sheet becomes a reservation of theirs, so the flight is theirs here as
   * it is in the sheet, and it is then completed as `complete` does. The caller has the proof (FsHub's record of the pilot's
   * own landing); the checks here are that the sheet still names them on every leg and that nobody has taken the flight.
   */
  completeNamed(jobId: number, user: { discordId: string; username: string }, names: string[], via: 'fshub'): JobView {
    const now = this.now();
    const view = this.store.tx(() => {
      const current = this.store.getJobView(jobId);
      if (!current || !this.completableNow(current.job, now)) throw new JobError('NOT_FOUND', 'That flight is no longer open, so it can\'t be completed from here.');
      const sheet = namedForOneOf(current, names);
      if (!sheet) throw new JobError('BAD_INPUT', `${current.job.code} isn't named for you in the airline's sheet any more, so I haven't completed it for you.`);
      current.legs.forEach((leg, i) => {
        this.store.insertReservation(jobId, leg.legNo, user.discordId, user.username, now);
        this.store.setReservationSheetName(jobId, leg.legNo, sheet[i] as string);
      });
      this.store.updateJob(jobId, { status: 'expired', completedAt: now, completedBy: user.discordId, completedVia: via });
      return this.store.getJobView(jobId) as JobView;
    });
    this.events.emit({ type: 'changed', panelId: view.job.panelId });
    return view;
  }

  /** Give legs back. With `legNos` omitted, releases everything the person holds on that job. Returns the legs freed. */
  release(jobId: number, discordId: string, legNos?: number[]): number[] {
    const ended: BackupNotice[] = [];
    const freed = this.store.tx(() => {
      const view = this.store.getJobView(jobId);
      if (!view) return [] as number[];
      const out: number[] = [];
      for (const leg of view.legs) {
        if (legNos && !legNos.includes(leg.legNo)) continue;
        if (leg.holder?.discordId === discordId && this.store.deleteReservation(jobId, leg.legNo)) out.push(leg.legNo);
      }
      if (out.length > 0) this.endBackup(jobId, 'freed', ended);
      return out;
    });
    if (freed.length > 0) {
      const job = this.store.getJob(jobId);
      if (job) this.events.emit({ type: 'changed', panelId: job.panelId });
    }
    for (const notice of ended) this.events.emit({ type: 'backup-ended', notice });
    return freed;
  }

  /* ------------------------------------------------------------------ backup pilots */

  /**
   * Why this person can't be the backup for this flight, or null if they can. A flight can have a backup once every leg of
   * it is taken (until then the free legs can simply be reserved), by a pilot who is not flying it, and only one.
   */
  backupProblem(view: JobView, discordId: string): string | null {
    const code = view.job.code;
    if (view.job.status !== 'open' || (view.job.deadline !== null && view.job.deadline <= this.now())) return `${code} is no longer open.`;
    const panel = this.store.getPanel(view.job.panelId);
    if (panel && !inPanelWindow(view.job, this.now(), panel.showDays)) return beyondDaysText(panel.showDays, code, 'stand by for');
    if (view.legs.some((l) => l.holder?.discordId === discordId)) return `You are flying ${code} yourself, so you can't also be its backup.`;
    if (view.legs.length === 0 || view.legs.some((l) => !l.holder && !l.sheetHolder)) return `${code} still has a leg nobody has, so you can reserve it instead of backing it up.`;
    if (view.backup) return view.backup.discordId === discordId ? `You are already down as backup for ${code}.` : `${code} already has a backup pilot.`;
    return null;
  }

  /** The flights on a panel's list (open now or starting within its days) this person could be the backup for. */
  backupCandidates(panel: Panel, discordId: string): JobView[] {
    const now = this.now();
    return this.open(panel.id).filter((v) => inPanelWindow(v.job, now, panel.showDays) && this.backupProblem(v, discordId) === null);
  }

  /** Put a pilot down as the backup for a flight. Throws a `JobError` saying why not if they can't be. */
  addBackup(jobId: number, user: { discordId: string; username: string }): JobView {
    const now = this.now();
    const view = this.store.tx(() => {
      const current = this.store.getJobView(jobId);
      if (!current || current.job.status !== 'open') throw new JobError('NOT_FOUND', 'That flight is no longer on the panel.');
      const problem = this.backupProblem(current, user.discordId);
      if (problem) throw new JobError('BAD_INPUT', problem);
      if (!this.store.setBackup(jobId, user.discordId, user.username, now)) throw new JobError('BAD_INPUT', `${current.job.code} already has a backup pilot.`);
      return this.store.getJobView(jobId) as JobView;
    });
    this.events.emit({ type: 'changed', panelId: view.job.panelId });
    return view;
  }

  /** Stand down as the backup for a flight. True if they were the backup. */
  removeBackup(jobId: number, discordId: string): boolean {
    const removed = this.store.deleteBackup(jobId, discordId);
    if (removed) {
      const job = this.store.getJob(jobId);
      if (job) this.events.emit({ type: 'changed', panelId: job.panelId });
    }
    return removed;
  }

  /** The open flights of a panel this person is down as the backup for. */
  myBackups(panelId: number, discordId: string): JobView[] {
    return this.store.listBackupsByUser(panelId, discordId);
  }

  /** Admin: free every reservation on a job, or one leg of it. The holders are told. */
  adminRelease(panel: Panel, codeInput: string, legNo?: number): ReleasedNotice[] {
    const view = this.findByCode(panel, codeInput);
    if (!view) throw new JobError('NOT_FOUND', `I can't find an open flight with the ID "${codeInput}" on this panel.`);
    const notices: ReleasedNotice[] = [];
    this.store.tx(() => {
      for (const leg of view.legs) {
        if (legNo !== undefined && leg.legNo !== legNo) continue;
        if (leg.holder && this.store.deleteReservation(view.job.id, leg.legNo)) {
          notices.push({ panelId: panel.id, discordId: leg.holder.discordId, jobCode: view.job.code, legNos: [leg.legNo], reason: 'admin' });
        }
      }
    });
    const merged = mergeNotices(notices);
    const ended: BackupNotice[] = [];
    if (merged.length > 0) this.store.tx(() => this.endBackup(view.job.id, 'freed', ended));
    if (merged.length > 0) {
      this.events.emit({ type: 'changed', panelId: panel.id });
      for (const n of merged) this.events.emit({ type: 'released', notice: n });
      for (const notice of ended) this.events.emit({ type: 'backup-ended', notice });
    }
    this.log.info(`Admin released ${merged.length} reservation holder(s) on ${view.job.code}`);
    return merged;
  }
}
