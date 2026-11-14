import type { DatabaseSync } from 'node:sqlite';

/** One change to a reservation (or backup) row, as the database itself saw it. */
export interface AuditRow {
  table: 'leg_reservations' | 'job_backups';
  op: 'INSERT' | 'DELETE' | 'UPDATE';
  jobId: number;
  legNo: number | null;
  discordId: string;
  username: string;
  /** The flight's code, when the job row is still there to ask. */
  code: string | null;
}

/**
 * Debug build only. Puts triggers on the reservation and backup tables (TEMP ones: they live in this connection only and
 * leave the database file untouched), so every row that appears, changes or disappears is recorded no matter which code
 * path did it, including the ones that happen by cascade when a flight or leg is deleted. `flush` hands back what has
 * been recorded since the last call.
 */
export function installReservationAudit(db: DatabaseSync): () => AuditRow[] {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS dbg_audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, op TEXT NOT NULL,
      job_id INTEGER NOT NULL, leg_no INTEGER, discord_id TEXT NOT NULL, username TEXT NOT NULL
    );
    CREATE TEMP TRIGGER IF NOT EXISTS dbg_res_ins AFTER INSERT ON main.leg_reservations
      BEGIN INSERT INTO dbg_audit(tbl, op, job_id, leg_no, discord_id, username) VALUES ('leg_reservations', 'INSERT', NEW.job_id, NEW.leg_no, NEW.discord_id, NEW.username); END;
    CREATE TEMP TRIGGER IF NOT EXISTS dbg_res_del AFTER DELETE ON main.leg_reservations
      BEGIN INSERT INTO dbg_audit(tbl, op, job_id, leg_no, discord_id, username) VALUES ('leg_reservations', 'DELETE', OLD.job_id, OLD.leg_no, OLD.discord_id, OLD.username); END;
    CREATE TEMP TRIGGER IF NOT EXISTS dbg_res_upd AFTER UPDATE ON main.leg_reservations
      BEGIN INSERT INTO dbg_audit(tbl, op, job_id, leg_no, discord_id, username) VALUES ('leg_reservations', 'UPDATE', NEW.job_id, NEW.leg_no, NEW.discord_id, NEW.username); END;
    CREATE TEMP TRIGGER IF NOT EXISTS dbg_bak_ins AFTER INSERT ON main.job_backups
      BEGIN INSERT INTO dbg_audit(tbl, op, job_id, leg_no, discord_id, username) VALUES ('job_backups', 'INSERT', NEW.job_id, NULL, NEW.discord_id, NEW.username); END;
    CREATE TEMP TRIGGER IF NOT EXISTS dbg_bak_del AFTER DELETE ON main.job_backups
      BEGIN INSERT INTO dbg_audit(tbl, op, job_id, leg_no, discord_id, username) VALUES ('job_backups', 'DELETE', OLD.job_id, NULL, OLD.discord_id, OLD.username); END;
  `);
  const pending = db.prepare('SELECT seq, tbl, op, job_id, leg_no, discord_id, username FROM dbg_audit ORDER BY seq');
  const clear = db.prepare('DELETE FROM dbg_audit');
  const codeOf = db.prepare('SELECT code FROM jobs WHERE id = ?');

  return () => {
    const rows = pending.all() as Array<Record<string, unknown>>;
    if (rows.length === 0) return [];
    clear.run();
    return rows.map((r) => ({
      table: String(r.tbl) as AuditRow['table'],
      op: String(r.op) as AuditRow['op'],
      jobId: Number(r.job_id),
      legNo: r.leg_no === null ? null : Number(r.leg_no),
      discordId: String(r.discord_id),
      username: String(r.username),
      code: ((codeOf.get(Number(r.job_id)) as { code?: string } | undefined)?.code as string | undefined) ?? null,
    }));
  };
}
