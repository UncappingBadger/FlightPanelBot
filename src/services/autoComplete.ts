import type { FlownFlight, JobView, Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { confirmationsFor } from './flightMatch.js';
import type { FsHubSync } from './fshubSync.js';
import { COMPLETE_AFTER_DEADLINE_MS, JobError, type JobService } from './jobs.js';
import { WriteBackError, type SheetWriteBack } from './writeback.js';

/** How often a FsHub-linked panel's flights are checked for ones that have been flown. */
export const AUTO_COMPLETE_MS = 60 * 60_000;
/** After a check that could not read FsHub, try again after this long rather than waiting the whole hour. */
const RETRY_MS = 10 * 60_000;
/** The flights are brought up to date before a check unless they were read this recently. */
const FRESH_FLIGHTS_MS = 60_000;

/** A flight the check completed. */
export interface AutoCompleted {
  panel: Panel;
  /** The flight as it was just before it was completed. */
  view: JobView;
  /** The pilot who held it, and whom it was completed for. */
  discordId: string;
  /** The FsHub flight that confirmed each leg. */
  flights: Map<number, FlownFlight>;
  /** Whether the airline's sheet was ticked too (write-back). */
  sheetTicked: boolean;
}

export interface AutoCompleteResult {
  /** False if FsHub could not be read, so nothing was checked. */
  ok: boolean;
  note: string | null;
  /** Flights whose pilot and legs could be checked against FsHub. */
  checked: number;
  completed: AutoCompleted[];
}

export interface AutoCompleteDeps {
  store: Store;
  jobs: Pick<JobService, 'complete'>;
  sync: Pick<FsHubSync, 'refreshFlights'>;
  /** Writes the tick to the airline's sheet; null when the bot has no Google credentials. */
  writeback: Pick<SheetWriteBack, 'enabledFor' | 'complete'> | null;
  /** Told, once per pilot, which of their flights were completed, so they can be told too. A failure here never undoes a completion. */
  onCompleted?: (discordId: string, done: AutoCompleted[]) => Promise<void>;
  logger?: Logger;
  now?: () => number;
}

/**
 * Once an hour, completes the flights FsHub shows have been flown, for panels linked to their airline's FsHub: the
 * same thing the Complete button does when a pilot presses it, done for every pilot at once without being asked.
 * The rules are the button's, and strict:
 *
 * - a flight is only completed for a pilot who holds every leg of it, whose FsHub ID the bot knows, and who FsHub
 *   shows flying each leg between the right two airports inside its window;
 * - an ID somebody typed is not trusted if the airline's FsHub roster gives it to another Discord account;
 * - a flight named only in the airline's sheet (no Discord holder) is left alone: nothing says whose it is;
 * - where write-back is on, the sheet is ticked first, and a flight the sheet will not accept is left alone.
 */
export class AutoCompleter {
  constructor(private readonly d: AutoCompleteDeps) {}

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  private get log(): Logger {
    return this.d.logger ?? silentLogger;
  }

  /** Check one panel now. Never throws: what happened is in the result. */
  async runPanel(panel: Panel): Promise<AutoCompleteResult> {
    const { store } = this.d;
    const now = this.now;
    if (panel.fshubAirlineId === null || !panel.fshubConfirm) return { ok: false, note: 'This panel is not reading FsHub flights.', checked: 0, completed: [] };

    // The flights must be current: a landing from a few minutes ago has to be there.
    const refreshed = await this.d.sync.refreshFlights(panel, FRESH_FLIGHTS_MS);
    if (refreshed && !refreshed.ok) {
      store.updatePanel(panel.id, { fshubAutoCompleteAt: now - (AUTO_COMPLETE_MS - RETRY_MS) });
      return { ok: false, note: refreshed.note, checked: 0, completed: [] };
    }

    const current = store.getPanel(panel.id) ?? panel;
    const candidates = store
      .listAllHeldJobViews(current.id, now - COMPLETE_AFTER_DEADLINE_MS)
      .filter((v) => v.job.availableFrom === null || v.job.availableFrom <= now)
      .map((v) => ({ view: v, holder: soleHolder(v) }))
      .filter((c): c is { view: JobView; holder: string } => c.holder !== null)
      .filter((c) => this.trusted(c.holder));

    const confirmed = confirmationsFor(store, current, candidates.map((c) => c.view), now, { strict: true });
    const completed: AutoCompleted[] = [];
    for (const { view, holder } of candidates) {
      const legs = confirmed.get(view.job.id);
      if (!legs || legs.size < view.legs.length) continue; // FsHub has not shown every leg

      // The airline's sheet first, where the bot writes to it: a flight the sheet won't accept is not completed.
      let sheetTicked = false;
      if (current.sheetId && this.d.writeback?.enabledFor(current) && view.legs.length === 1) {
        try {
          await this.d.writeback.complete(current, view.job.sourceKey, store.getPilotName(holder) ?? view.legs[0]?.holder?.username ?? 'pilot');
          sheetTicked = true;
        } catch (e) {
          if (!(e instanceof WriteBackError)) throw e;
          this.log.warn(`Auto-complete: ${view.job.code} was flown but not completed: ${e.message}`);
          continue;
        }
      }
      try {
        this.d.jobs.complete(view.job.id, holder, 'fshub');
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
        continue; // completed or changed meanwhile
      }
      const done: AutoCompleted = { panel: current, view, discordId: holder, flights: legs, sheetTicked };
      completed.push(done);
      this.log.info(`Auto-completed ${view.job.code} for ${current.airlineName} from FsHub`);
    }
    store.updatePanel(current.id, { fshubAutoCompleteAt: now });

    // One message per pilot, however many of their flights were completed.
    const byPilot = new Map<string, AutoCompleted[]>();
    for (const c of completed) byPilot.set(c.discordId, [...(byPilot.get(c.discordId) ?? []), c]);
    for (const [pilot, done] of byPilot) {
      try {
        await this.d.onCompleted?.(pilot, done);
      } catch (e) {
        this.log.debug(`Could not tell ${pilot} about ${done.length} completed flight${done.length === 1 ? '' : 's'}`, e);
      }
    }
    return { ok: true, note: null, checked: candidates.length, completed };
  }

  /** Check every FsHub-linked panel that is due (once an hour, and not at all where an admin switched it off). */
  async run(): Promise<AutoCompleteResult[]> {
    const out: AutoCompleteResult[] = [];
    for (const panel of this.d.store.listFshubPanels()) {
      if (!panel.fshubAutoComplete || !panel.fshubConfirm) continue;
      if (panel.fshubAutoCompleteAt !== null && this.now - panel.fshubAutoCompleteAt < AUTO_COMPLETE_MS) continue;
      out.push(await this.runPanel(panel));
    }
    return out;
  }

  /** Whether a pilot's FsHub ID can be acted on: known, and not one the roster says belongs to another Discord account. */
  private trusted(discordId: string): boolean {
    const link = this.d.store.getPilotLink(discordId);
    if (!link) return false;
    return !(link.source === 'typed' && this.d.store.rosterOwnerOf(link.fshubId, discordId) !== null);
  }
}

/** The one Discord account that holds every leg of the flight, or null if it is open, shared or only named in the sheet. */
function soleHolder(view: JobView): string | null {
  const first = view.legs[0]?.holder?.discordId;
  if (!first) return null;
  return view.legs.every((l) => l.holder?.discordId === first) ? first : null;
}
