import type { FlownFlight, Holder, JobView, Panel, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { confirmationsFor, type Confirmations } from './flightMatch.js';
import type { FsHubSync } from './fshubSync.js';
import { HourlySlot } from './hourlySlot.js';
import { COMPLETE_AFTER_DEADLINE_MS, JobError, type JobService } from './jobs.js';
import { nameKey } from './pilotNames.js';
import { WriteBackError, type SheetWriteBack } from './writeback.js';
import { appNow } from '../util/clock.js';

/** How often a FsHub-linked panel's flights are checked for ones that have been flown: once an hour, in the slot all the hourly checks share. */
export const AUTO_COMPLETE_MS = 60 * 60_000;
/** After a check that could not read FsHub, try again after this long rather than waiting for the next slot. */
const RETRY_MS = 10 * 60_000;
/** The flights are brought up to date before a check unless they were read this recently. */
const FRESH_FLIGHTS_MS = 60_000;

/**
 * The FsHub ID of a pilot that can be acted on, or null: the bot must know it, and it must not be one somebody typed that the
 * airline's FsHub roster gives to another Discord account.
 */
export function trustedFshubId(store: Store, discordId: string): number | null {
  const link = store.getPilotLink(discordId);
  if (!link) return null;
  return link.source === 'typed' && store.rosterOwnerOf(link.fshubId, discordId) !== null ? null : link.fshubId;
}

/** What a check may be narrowed to. */
export interface AutoCompleteScope {
  /** Only these Discord accounts' flights are looked at (a pilot who has just landed), and the hourly timer is left alone. */
  only?: ReadonlySet<string>;
  /** The flights are brought up to date first unless they were read this recently (default a minute). */
  maxAgeMs?: number;
}

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
  /** For a flight nobody reserved here: the name the airline's sheet had against it, which was taken to be this pilot. */
  namedAs?: string | null;
  /** For a flight the pilot flew as its backup: the pilot who held it, whom they replaced. */
  replaced?: { discordId: string; username: string };
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
  jobs: Pick<JobService, 'complete' | 'completeNamed' | 'completeAsBackup'>;
  sync: Pick<FsHubSync, 'refreshFlights'>;
  /** Writes the tick to the airline's sheet; null when the bot has no Google credentials. */
  writeback: (Pick<SheetWriteBack, 'enabledFor' | 'complete'> & Partial<Pick<SheetWriteBack, 'completeAsBackup'>>) | null;
  /** Told, once per pilot, which of their flights were completed, so they can be told too. A failure here never undoes a completion. */
  onCompleted?: (discordId: string, done: AutoCompleted[]) => Promise<void>;
  /** Told, for each flight that was completed for its backup, so the pilot who held it can be told (it was their reservation that was replaced). */
  onReplaced?: (done: AutoCompleted) => Promise<void>;
  logger?: Logger;
  now?: () => number;
  /** The moment each hour at which the hourly checks happen together. */
  slot?: HourlySlot;
}

/**
 * Once an hour, completes the flights FsHub shows have been flown, for panels linked to their airline's FsHub: the
 * same thing the Complete button does when a pilot presses it, done for every pilot at once without being asked.
 * The rules are the button's, and strict:
 *
 * - a flight is only completed for a pilot who holds every leg of it, whose FsHub ID the bot knows, and who FsHub
 *   shows flying each leg between the right two airports inside its window;
 * - an ID somebody typed is not trusted if the airline's FsHub roster gives it to another Discord account;
 * - a flight named only in the airline's sheet (no Discord holder) is completed only for a pilot who has told the bot that
 *   name (or had it written for them), whom no other account shares it with, and whom FsHub shows flying it: a name in a
 *   sheet is only someone's word, and a name two pilots answer to is nobody's;
 * - where write-back is on, the sheet is ticked first, and a flight the sheet will not accept is left alone;
 * - a flight that has a backup pilot, held by one pilot whom FsHub shows flying none of it, is completed for the backup instead when FsHub
 *   shows the backup (a pilot whose FsHub ID the bot knows) flying every leg: the backup takes the pilot's place on the flight, and in the
 *   sheet's Pilot cell where the bot wrote the pilot's name (never over any other name). If the pilot flew any of it, the pilot is the one credited.
 */
export class AutoCompleter {
  constructor(private readonly d: AutoCompleteDeps) {}

  /** The moment each hour at which the hourly checks happen together: a panel is checked once in each slot. */
  private get slot(): HourlySlot {
    return (this.d.slot ??= new HourlySlot(0));
  }

  /** Panels whose check could not read FsHub, and when to try them again (sooner than the next slot). */
  private readonly retryAt = new Map<number, number>();

  private get now(): number {
    return (this.d.now ?? appNow)();
  }

  private get log(): Logger {
    return this.d.logger ?? silentLogger;
  }

  /** Check one panel now. Never throws: what happened is in the result. */
  async runPanel(panel: Panel, scope: AutoCompleteScope = {}): Promise<AutoCompleteResult> {
    const { store } = this.d;
    const now = this.now;
    if (panel.fshubAirlineId === null || !panel.fshubConfirm) return { ok: false, note: 'This panel is not reading FsHub flights.', checked: 0, completed: [] };

    // The flights must be current: a landing from a few minutes ago has to be there.
    const refreshed = await this.d.sync.refreshFlights(panel, scope.maxAgeMs ?? FRESH_FLIGHTS_MS);
    if (refreshed && !refreshed.ok) {
      if (!scope.only) this.retryAt.set(panel.id, now + RETRY_MS);
      return { ok: false, note: refreshed.note, checked: 0, completed: [] };
    }

    const current = store.getPanel(panel.id) ?? panel;
    const started = (v: JobView) => hasStarted(v, now);
    const held = store
      .listAllHeldJobViews(current.id, now - COMPLETE_AFTER_DEADLINE_MS)
      .filter(started)
      .map((v) => ({ view: v, holder: soleHolder(v), named: null as string | null }))
      .filter((c): c is { view: JobView; holder: string; named: null } => c.holder !== null)
      .filter((c) => this.trusted(c.holder));

    // Flights nobody reserved here but the airline's sheet names for a pilot who has told me that name (or had it written for them).
    const owners = ownersOfNames(store.listKnownPilotNames());
    const namedPilots = new Map<number, number>();
    const named: Array<{ view: JobView; holder: string; named: string }> = [];
    for (const view of store.listNamedJobViews(current.id, now - COMPLETE_AFTER_DEADLINE_MS).filter(started)) {
      const owner = soleOwner(view, owners);
      if (owner === null || !this.trusted(owner)) continue;
      const fshubId = store.getPilotLink(owner)?.fshubId;
      if (fshubId === undefined) continue;
      namedPilots.set(view.job.id, fshubId);
      named.push({ view, holder: owner, named: view.legs[0]?.sheetHolder ?? '' });
    }

    const candidates = [...held, ...named].filter((c) => !scope.only || scope.only.has(c.holder));
    const confirmed = confirmationsFor(store, current, candidates.map((c) => c.view), now, { strict: true, namedPilots });
    const completed: AutoCompleted[] = [];
    for (const { view, holder, named: sheetName } of candidates) {
      const legs = confirmed.get(view.job.id);
      if (!legs || legs.size < view.legs.length) continue; // FsHub has not shown every leg

      // The airline's sheet first, where the bot writes to it: a flight the sheet won't accept is not completed.
      let sheetTicked = false;
      if (current.sheetId && this.d.writeback?.enabledFor(current) && view.legs.length === 1) {
        try {
          await this.d.writeback.complete(current, view.job.sourceKey, sheetName ?? store.getPilotName(holder) ?? view.legs[0]?.holder?.username ?? 'pilot');
          sheetTicked = true;
        } catch (e) {
          if (!(e instanceof WriteBackError)) throw e;
          this.log.warn(`Auto-complete: ${view.job.code} was flown but not completed: ${e.message}`);
          continue;
        }
      }
      try {
        if (sheetName !== null) this.d.jobs.completeNamed(view.job.id, { discordId: holder, username: sheetName }, view.legs.map((l) => l.sheetHolder ?? ''), 'fshub');
        else this.d.jobs.complete(view.job.id, holder, 'fshub');
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
        continue; // completed or changed meanwhile
      }
      const done: AutoCompleted = { panel: current, view, discordId: holder, flights: legs, sheetTicked, namedAs: sheetName };
      completed.push(done);
      this.log.info(`Auto-completed ${view.job.code} for ${current.airlineName} from FsHub`);
    }

    // Flights a backup pilot flew in place of the pilot who held them.
    const credited = await this.creditBackups(current, scope, confirmed, new Set(completed.map((c) => c.view.job.id)), now);
    completed.push(...credited.completed);

    if (!scope.only) {
      this.retryAt.delete(current.id);
      store.updatePanel(current.id, { fshubAutoCompleteAt: now });
    }

    // One message per pilot, however many of their flights were completed. A pilot who has turned these messages off still has
    // their flights completed (that is the point of it); they are only not told.
    const byPilot = new Map<string, AutoCompleted[]>();
    for (const c of completed) byPilot.set(c.discordId, [...(byPilot.get(c.discordId) ?? []), c]);
    for (const [pilot, done] of byPilot) {
      if (!store.wantsNotice(pilot, 'completed')) continue;
      try {
        await this.d.onCompleted?.(pilot, done);
      } catch (e) {
        this.log.debug(`Could not tell ${pilot} about ${done.length} completed flight${done.length === 1 ? '' : 's'}`, e);
      }
    }
    // The pilot whose flight was taken over is always told: it was their reservation that was replaced, and that is never switched off.
    for (const c of completed.filter((x) => x.replaced)) {
      try {
        await this.d.onReplaced?.(c);
      } catch (e) {
        this.log.debug(`Could not tell ${c.replaced?.discordId} that their flight ${c.view.job.code} was completed for its backup`, e);
      }
    }
    return { ok: true, note: null, checked: candidates.length + credited.checked, completed };
  }

  /**
   * Flights with a backup pilot that FsHub shows the backup flew, and the pilot who held them did not: each is completed for the backup, who
   * takes the pilot's place on it (in the airline's sheet too, where the bot writes to it and the sheet still has the name the bot wrote for the
   * pilot). Only where every leg is held by one pilot and both pilots' FsHub IDs are known, and the pilot flew none of it: a flight both of them
   * flew is the pilot's, and one flown in part by each is left for an admin. Returns what was completed and how many flights were looked at.
   */
  private async creditBackups(current: Panel, scope: AutoCompleteScope, confirmed: Confirmations, alreadyDone: ReadonlySet<number>, now: number): Promise<{ completed: AutoCompleted[]; checked: number }> {
    const { store } = this.d;
    const candidates = store
      .listBackedJobViews(current.id, now - COMPLETE_AFTER_DEADLINE_MS)
      .filter((v) => hasStarted(v, now) && !alreadyDone.has(v.job.id))
      .flatMap((view) => {
        const holder = soleHolder(view);
        const backup = view.backup;
        return holder !== null && backup && backup.discordId !== holder && this.trusted(holder) && this.trusted(backup.discordId) ? [{ view, holder, backup }] : [];
      })
      .filter((c) => !scope.only || scope.only.has(c.backup.discordId));
    if (candidates.length === 0) return { completed: [], checked: 0 };

    // The pilot first: a flight they flew any of is theirs, however the backup stood by.
    const pilotFlew = confirmationsFor(store, current, candidates.map((c) => c.view), now, { strict: true });
    const open = candidates.filter((c) => (pilotFlew.get(c.view.job.id)?.size ?? 0) === 0);
    const backupPilots = new Map<number, number>();
    for (const c of open) backupPilots.set(c.view.job.id, trustedFshubId(store, c.backup.discordId) as number);
    const taken = [...confirmed.values()].flatMap((legs) => [...legs.values()].map((f) => f.flightId));
    const flown = confirmationsFor(store, current, open.map((c) => c.view), now, { strict: true, backupPilots, taken });

    const completed: AutoCompleted[] = [];
    for (const { view, holder, backup } of open) {
      const legs = flown.get(view.job.id);
      if (!legs || legs.size < view.legs.length) continue; // FsHub has not shown the backup flying every leg
      const heldBy = view.legs[0]?.holder as Holder;
      const backupName = store.getPilotName(backup.discordId) ?? backup.username;

      // The airline's sheet first, where the bot writes to it: the backup takes the pilot's place in the Pilot cell, and the flight is ticked.
      let wroteName: string | null = null;
      if (current.sheetId && this.d.writeback?.enabledFor(current) && view.legs.length === 1) {
        if (!this.d.writeback.completeAsBackup) continue;
        const written = store.getBackupSheetName(view.job.id);
        try {
          await this.d.writeback.completeAsBackup(current, view.job.sourceKey, {
            from: heldBy.sheetName ?? store.getPilotName(holder) ?? heldBy.username,
            to: backupName,
            backupName: written && written.discordId === backup.discordId ? written.name : null,
          });
          wroteName = backupName;
        } catch (e) {
          if (!(e instanceof WriteBackError)) throw e;
          this.log.warn(`Auto-complete: ${view.job.code} was flown by its backup but not completed: ${e.message}`);
          continue;
        }
      }
      try {
        this.d.jobs.completeAsBackup(view.job.id, { discordId: backup.discordId, username: backup.username }, wroteName, 'fshub');
      } catch (e) {
        if (!(e instanceof JobError)) throw e;
        continue; // completed or changed meanwhile
      }
      completed.push({ panel: current, view, discordId: backup.discordId, flights: legs, sheetTicked: wroteName !== null, replaced: { discordId: holder, username: heldBy.username } });
      this.log.info(`Auto-completed ${view.job.code} for ${current.airlineName} from FsHub, for its backup pilot`);
    }
    return { completed, checked: open.length };
  }

  /** Check every FsHub-linked panel that is due (once in each hourly slot, and not at all where an admin switched it off). */
  async run(): Promise<AutoCompleteResult[]> {
    const out: AutoCompleteResult[] = [];
    for (const panel of this.d.store.listFshubPanels()) {
      if (!panel.fshubAutoComplete || !panel.fshubConfirm) continue;
      if (!this.slot.due(panel.fshubAutoCompleteAt, this.now) || this.now < (this.retryAt.get(panel.id) ?? 0)) continue;
      out.push(await this.runPanel(panel));
    }
    return out;
  }

  /** Whether a pilot's FsHub ID can be acted on: known, and not one the roster says belongs to another Discord account. */
  private trusted(discordId: string): boolean {
    return trustedFshubId(this.d.store, discordId) !== null;
  }
}

/** Whether a flight's window has opened: a flight is not looked for in FsHub before it can be flown. */
function hasStarted(view: JobView, now: number): boolean {
  return view.job.availableFrom === null || view.job.availableFrom <= now;
}

/** Who answers to each name (lower case): the Discord accounts that have given the bot that name or had it written for them. */
function ownersOfNames(known: Array<{ discordId: string; name: string }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { discordId, name } of known) {
    const key = nameKey(name);
    if (key) out.set(key, (out.get(key) ?? new Set()).add(discordId));
  }
  return out;
}

/**
 * The one Discord account the sheet's names on this flight can be taken to be: every leg is named, and each name belongs
 * to exactly one account, the same on every leg. A name two accounts answer to is nobody's here: nothing says which.
 */
function soleOwner(view: JobView, owners: Map<string, Set<string>>): string | null {
  let owner: string | null = null;
  for (const leg of view.legs) {
    if (leg.holder !== null || leg.sheetHolder === null) return null;
    const who = owners.get(nameKey(leg.sheetHolder));
    if (!who || who.size !== 1) return null;
    const only = [...who][0] as string;
    if (owner !== null && owner !== only) return null;
    owner = only;
  }
  return owner;
}

/** The one Discord account that holds every leg of the flight, or null if it is open, shared or only named in the sheet. */
function soleHolder(view: JobView): string | null {
  const first = view.legs[0]?.holder?.discordId;
  if (!first) return null;
  return view.legs.every((l) => l.holder?.discordId === first) ? first : null;
}
