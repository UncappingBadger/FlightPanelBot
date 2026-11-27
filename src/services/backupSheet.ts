import type { Store } from '../db/store.js';
import { sheetNameOf } from './pilotNames.js';
import { WriteBackError, type SheetWriteBack } from './writeback.js';
import type { JobListener } from './events.js';
import { silentLogger, type Logger } from '../util/log.js';
import { appNow } from '../util/clock.js';

/**
 * Takes a backup pilot's name off the airline's sheet when their spot ends. A backup's name is put in the flight's *Backup Pilot* cell when
 * they stand by (see the Backup pilot button); it comes off again here when they stand down, or when the flight is given back, freed by an
 * admin or dropped from the schedule (a dropped flight's row is simply gone, which is not a problem). Only the name the bot wrote is ever
 * removed, and only while it is still in the cell; anything else is left for the airline. Best effort: a failure is logged and nothing more.
 */
export function backupSheetCleaner(d: { store: Store; writeback: Pick<SheetWriteBack, 'enabledFor' | 'unclaimBackup'> | null; logger?: Logger }): JobListener {
  const log = d.logger ?? silentLogger;
  return async (event) => {
    if (event.type !== 'backup-ended') return;
    const n = event.notice;
    if (!d.writeback || n.sourceKey === undefined || n.sheetName === undefined) return;
    const panel = d.store.getPanel(n.panelId);
    if (!panel || !d.writeback.enabledFor(panel)) return;
    try {
      await d.writeback.unclaimBackup(panel, n.sourceKey, n.sheetName);
    } catch (e) {
      // A flight whose row is gone has nothing to take a name off; any other trouble is only worth a line in the log.
      if (e instanceof WriteBackError && e.code === 'FLIGHT_NOT_FOUND') return;
      log.warn(`Could not take ${n.sheetName} off the sheet as the backup for ${n.jobCode}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/** How often every panel is looked over, and the most backups looked at in one pass (the rest wait for the next). */
export const BACKUP_CHECK_EVERY_MS = 60 * 60_000;
const MAX_PER_PASS = 40;
const KV_LAST = 'backup.sheetcheck';

export interface BackupCheckResult {
  /** Backups looked at, and what became of them. */
  checked: number;
  written: number;
  /** The sheet already names someone else, or shows the flight finished: left as the airline has it. */
  left: number;
  /** Could not be written yet because the sheet could not be reached: looked at again in ten minutes. */
  waiting: number;
  /** The sheet has no Backup Pilot column: nothing to write, looked at again with the next hourly pass in case one is added. */
  noColumn: number;
}

/**
 * The retroactive check. A backup pilot is only written in the sheet when they stand by, so every backup put down before that was done (or
 * while the sheet could not be reached) has no name in the airline's *Backup Pilot* cell. Once an hour this goes through the open flights of
 * each panel the bot writes to, and puts the missing names in, one flight at a time, on the same terms as when a pilot stands by: only a
 * single-leg flight, only an empty cell (or one that already holds their name), and never over a name someone else put there or on a finished
 * flight. A backup is never undone by this: the pilot did stand by, and the panel still shows them whatever the sheet says.
 */
export class BackupSheetCheck {
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(
    private readonly d: {
      store: Store;
      writeback: Pick<SheetWriteBack, 'enabledFor' | 'claimBackup'> | null;
      logger?: Logger;
      now?: () => number;
    },
  ) {
    this.now = d.now ?? appNow;
    this.log = d.logger ?? silentLogger;
  }

  /** The hourly pass: does nothing until an hour has passed since the last one. */
  async run(force = false): Promise<BackupCheckResult> {
    const out: BackupCheckResult = { checked: 0, written: 0, left: 0, waiting: 0, noColumn: 0 };
    const writeback = this.d.writeback;
    if (!writeback) return out;
    const now = this.now();
    const last = Number(this.d.store.getKv(KV_LAST));
    if (!force && Number.isFinite(last) && last > 0 && now - last < BACKUP_CHECK_EVERY_MS) return out;

    let budget = MAX_PER_PASS;
    for (const panel of this.d.store.listAllPanels()) {
      if (!writeback.enabledFor(panel)) continue;
      for (const b of this.d.store.listUnloggedBackups(panel.id)) {
        if (budget-- <= 0) break;
        out.checked++;
        const name = sheetNameOf(this.d.store.getPilotName(b.discordId), b.username);
        try {
          if (await writeback.claimBackup(panel, b.sourceKey, name)) {
            this.d.store.setBackupSheetName(b.jobId, b.discordId, name);
            out.written++;
          } else out.noColumn++;
        } catch (e) {
          if (e instanceof WriteBackError && (e.code === 'CONFLICT' || e.code === 'CLOSED' || e.code === 'FLIGHT_NOT_FOUND')) {
            // The airline's sheet has its own answer for that flight. Not looked at again.
            this.d.store.setBackupSheetName(b.jobId, b.discordId, '');
            out.left++;
            this.log.info(`The sheet was left as it is for the backup on ${b.code} (${panel.airlineName}): ${e.message}`);
          } else {
            out.waiting++;
            this.log.warn(`Could not check the backup on ${b.code} against the sheet yet: ${e instanceof Error ? e.message : String(e)}`);
            if (e instanceof WriteBackError && (e.code === 'GOOGLE' || e.code === 'NO_SHEET' || e.code === 'NO_COLUMNS')) break; // the sheet itself is the trouble: no point asking again now
          }
        }
      }
    }
    // Only a pass that had nothing left waiting counts as done for the hour; otherwise it is tried again on the next tick.
    if (out.waiting === 0 && budget > 0) this.d.store.setKv(KV_LAST, String(now));
    else if (out.checked > 0) this.d.store.setKv(KV_LAST, String(now - BACKUP_CHECK_EVERY_MS + 10 * 60_000)); // try again in ten minutes
    if (out.checked > 0) this.log.info(`Checked ${out.checked} backup pilot${out.checked === 1 ? '' : 's'} against the airlines' sheets: ${out.written} written, ${out.left} left as the sheet has them, ${out.noColumn} with no Backup Pilot column, ${out.waiting} to try again`);
    return out;
  }
}
