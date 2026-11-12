import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

/* ------------------------------------------------------------------ types */

/** A flight board for one airline in one server, living in one channel. Configured by admins only. */
export interface Panel {
  id: number;
  guildId: string;
  /** The airline's name as the admin typed it. */
  airlineName: string;
  airlineAbbr: string | null;
  /** Job codes look like `${prefix}-007`. */
  prefix: string;
  channelId: string;
  /** The panel's Discord messages, in order (a long list spans several). */
  messageIds: string[];
  nextSeq: number;
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
  /** If set, only members with this Discord role (or server admins) can reserve. */
  requiredRoleId: string | null;
  /** A Google Sheet the flights are read from (its ID and tab), if the airline keeps its schedule in one. */
  sheetId: string | null;
  sheetGid: string | null;
  /** Anything worth an admin's attention from the last refresh, such as rows that were skipped. */
  lastRefreshNote: string | null;
  /** Who is pinged when a flight has no pilot 24 hours before it starts. */
  reminderMode: ReminderMode;
  /** The role to ping when `reminderMode` is 'role'. */
  reminderRoleId: string | null;
  /** Whether the "pilots needed" announcements are deleted at midnight (UTC) to keep the channel tidy. */
  reminderCleanup: boolean;
  /** Whether pilots' names and completions are written back to the linked Google Sheet (when the bot is able to). */
  writeback: boolean;
  createdAt: number;
}

/**
 * - `auto`: ping the role that may reserve, or @here if anyone can
 * - `role`: ping the role an admin chose
 * - `off`: no reminders
 */
export type ReminderMode = 'auto' | 'role' | 'off';

/** The AeroDAQ market, shown in one channel of a server and kept up to date. */
export interface MarketBoard {
  guildId: string;
  channelId: string;
  /** The Discord message(s) it is drawn in. */
  messageIds: string[];
  /** When a refresh was last tried (successful or not), so a failing source is not hammered. */
  lastAttemptAt: number | null;
  lastOkAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export type JobStatus = 'open' | 'expired' | 'removed';

export interface Job {
  id: number;
  panelId: number;
  /** The ID pilots type, e.g. DMO-007. Stable for the life of the job. */
  code: string;
  /** The source's own identifier for the job, so re-imports and refreshes keep the same code. */
  sourceKey: string;
  title: string | null;
  /** Required airframe. */
  aircraft: string | null;
  availableFrom: number | null;
  /** When the flight must be completed by. */
  deadline: number | null;
  pay: string | null;
  notes: string | null;
  status: JobStatus;
  firstSeen: number;
  lastSeen: number;
  /** When the channel was last asked for a pilot for this flight; null if it hasn't been. */
  remindedAt: number | null;
  /** When this flight was first shown as completed; null if it isn't. */
  completedAt: number | null;
  /** The Discord user who completed it from here; null if it was the airline's schedule that said so. */
  completedBy: string | null;
}

export interface Leg {
  jobId: number;
  legNo: number;
  dep: string;
  arr: string;
  /** Who the airline's own schedule says is flying this leg. A name only; not a Discord account. */
  sheetHolder: string | null;
}

export interface Holder {
  discordId: string;
  username: string;
  reservedAt: number;
  /** The name the bot wrote against this reservation in the airline's sheet, if it wrote one. */
  sheetName: string | null;
  /** The FsHub pilot ID this person gave, so a manager can match them to the airline's roster. Never checked with FsHub. */
  fshubId: number | null;
}

export interface LegView extends Leg {
  holder: Holder | null;
}

export interface JobView {
  job: Job;
  legs: LegView[];
}

export type SessionStep = 'await_pilot' | 'await_code' | 'await_mode' | 'await_legs' | 'await_confirm';

export interface DmSession {
  discordId: string;
  panelId: number;
  step: SessionStep;
  jobId: number | null;
  pendingLegs: number[];
  attempts: number;
  expiresAt: number;
}

export interface NewJob {
  panelId: number;
  code: string;
  sourceKey: string;
  title: string | null;
  aircraft: string | null;
  availableFrom: number | null;
  deadline: number | null;
  pay: string | null;
  notes: string | null;
  status: JobStatus;
  /** Set when a flight is first seen already completed. */
  completedAt?: number | null;
  now: number;
}

type Row = Record<string, unknown>;

const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function parseJsonArray<T>(raw: unknown, fallback: T[]): T[] {
  try {
    const v: unknown = JSON.parse(s(raw));
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

const toPanel = (r: Row): Panel => ({
  id: n(r.id),
  guildId: s(r.guild_id),
  airlineName: s(r.airline_name),
  airlineAbbr: sn(r.airline_abbr),
  prefix: s(r.prefix),
  channelId: s(r.channel_id),
  messageIds: parseJsonArray<string>(r.message_ids, []).map(String),
  nextSeq: n(r.next_seq),
  lastRefreshAt: nn(r.last_refresh_at),
  lastRefreshError: sn(r.last_refresh_error),
  requiredRoleId: sn(r.required_role_id),
  sheetId: sn(r.sheet_id),
  sheetGid: sn(r.sheet_gid),
  lastRefreshNote: sn(r.last_refresh_note),
  reminderMode: (['auto', 'role', 'off'].includes(s(r.reminder_mode)) ? s(r.reminder_mode) : 'auto') as ReminderMode,
  reminderRoleId: sn(r.reminder_role_id),
  reminderCleanup: r.reminder_cleanup === undefined || r.reminder_cleanup === null ? true : n(r.reminder_cleanup) !== 0,
  writeback: r.writeback === undefined || r.writeback === null ? true : n(r.writeback) !== 0,
  createdAt: n(r.created_at),
});

const toMarketBoard = (r: Row): MarketBoard => ({
  guildId: s(r.guild_id),
  channelId: s(r.channel_id),
  messageIds: parseJsonArray<string>(r.message_ids, []).map(String),
  lastAttemptAt: nn(r.last_attempt_at),
  lastOkAt: nn(r.last_ok_at),
  lastError: sn(r.last_error),
  createdAt: n(r.created_at),
});

const toJob = (r: Row): Job => ({
  id: n(r.id),
  panelId: n(r.panel_id),
  code: s(r.code),
  sourceKey: s(r.source_key),
  title: sn(r.title),
  aircraft: sn(r.aircraft),
  availableFrom: nn(r.available_from),
  deadline: nn(r.deadline),
  pay: sn(r.pay),
  notes: sn(r.notes),
  status: s(r.status) as JobStatus,
  firstSeen: n(r.first_seen),
  lastSeen: n(r.last_seen),
  remindedAt: nn(r.reminded_at),
  completedAt: nn(r.completed_at),
  completedBy: sn(r.completed_by),
});

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  /** Run `fn` inside a transaction; rolls back if it throws. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  private get(sql: string, ...p: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...p) as Row | undefined;
  }
  private all(sql: string, ...p: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...p) as Row[];
  }
  private run(sql: string, ...p: SQLInputValue[]): { changes: number; lastId: number } {
    const r = this.db.prepare(sql).run(...p);
    return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }

  /* ------------------------------------------------------------------ panels */

  /**
   * Add a panel. Its 'airline_id' column is a number this hands out (one more than the server's highest),
   * because the column pre-dates panels being named by hand; nothing reads it.
   */
  createPanel(p: { guildId: string; name: string; abbr?: string | null; prefix: string; channelId: string; requiredRoleId?: string | null; now: number }): Panel {
    const { lastId } = this.run(
      `INSERT INTO panels(guild_id, airline_id, airline_name, airline_abbr, prefix, channel_id, required_role_id, created_at)
       VALUES (?, (SELECT COALESCE(MAX(airline_id), 0) + 1 FROM panels WHERE guild_id = ?), ?,?,?,?,?,?)`,
      p.guildId,
      p.guildId,
      p.name,
      p.abbr ?? null,
      p.prefix,
      p.channelId,
      p.requiredRoleId ?? null,
      p.now,
    );
    return this.getPanel(lastId) as Panel;
  }

  getPanel(id: number): Panel | null {
    const r = this.get('SELECT * FROM panels WHERE id = ?', id);
    return r ? toPanel(r) : null;
  }

  /** The panel in a server with this airline name (ignoring capitals), if there is one. */
  getPanelByName(guildId: string, name: string): Panel | null {
    const r = this.get('SELECT * FROM panels WHERE guild_id = ? AND lower(airline_name) = ?', guildId, name.trim().toLowerCase());
    return r ? toPanel(r) : null;
  }

  listPanels(guildId: string): Panel[] {
    return this.all('SELECT * FROM panels WHERE guild_id = ? ORDER BY airline_name', guildId).map(toPanel);
  }

  listAllPanels(): Panel[] {
    return this.all('SELECT * FROM panels ORDER BY id').map(toPanel);
  }

  updatePanel(
    id: number,
    patch: Partial<{
      channelId: string;
      prefix: string;
      messageIds: string[];
      lastRefreshAt: number | null;
      lastRefreshError: string | null;
      lastRefreshNote: string | null;
      requiredRoleId: string | null;
      sheetId: string | null;
      sheetGid: string | null;
      reminderMode: ReminderMode;
      reminderRoleId: string | null;
      reminderCleanup: boolean;
      writeback: boolean;
    }>,
  ): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.reminderCleanup !== undefined) (sets.push('reminder_cleanup = ?'), params.push(patch.reminderCleanup ? 1 : 0));
    if (patch.writeback !== undefined) (sets.push('writeback = ?'), params.push(patch.writeback ? 1 : 0));
    if (patch.reminderMode !== undefined) (sets.push('reminder_mode = ?'), params.push(patch.reminderMode));
    if (patch.reminderRoleId !== undefined) (sets.push('reminder_role_id = ?'), params.push(patch.reminderRoleId));
    if (patch.requiredRoleId !== undefined) (sets.push('required_role_id = ?'), params.push(patch.requiredRoleId));
    if (patch.sheetId !== undefined) (sets.push('sheet_id = ?'), params.push(patch.sheetId));
    if (patch.sheetGid !== undefined) (sets.push('sheet_gid = ?'), params.push(patch.sheetGid));
    if (patch.lastRefreshNote !== undefined) (sets.push('last_refresh_note = ?'), params.push(patch.lastRefreshNote));
    if (patch.channelId !== undefined) (sets.push('channel_id = ?'), params.push(patch.channelId));
    if (patch.prefix !== undefined) (sets.push('prefix = ?'), params.push(patch.prefix));
    if (patch.messageIds !== undefined) (sets.push('message_ids = ?'), params.push(JSON.stringify(patch.messageIds)));
    if (patch.lastRefreshAt !== undefined) (sets.push('last_refresh_at = ?'), params.push(patch.lastRefreshAt));
    if (patch.lastRefreshError !== undefined) (sets.push('last_refresh_error = ?'), params.push(patch.lastRefreshError));
    if (sets.length === 0) return;
    this.run(`UPDATE panels SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
  }

  /** Delete a panel and, by cascade, its jobs, legs, reservations and DM sessions. */
  deletePanel(id: number): boolean {
    return this.run('DELETE FROM panels WHERE id = ?', id).changes > 0;
  }

  /** Hand out the next job code for a panel (DMO-001, DMO-002, ...). Call inside a transaction. */
  allocateCode(panelId: number): string {
    const p = this.getPanel(panelId);
    if (!p) throw new Error(`No panel ${panelId}`);
    this.run('UPDATE panels SET next_seq = next_seq + 1 WHERE id = ?', panelId);
    return `${p.prefix}-${String(p.nextSeq).padStart(3, '0')}`;
  }

  /* ------------------------------------------------------------------ jobs and legs */

  insertJob(j: NewJob): Job {
    const { lastId } = this.run(
      `INSERT INTO jobs(panel_id, code, source_key, title, aircraft, available_from, deadline, pay, notes, status, first_seen, last_seen, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      j.panelId,
      j.code,
      j.sourceKey,
      j.title,
      j.aircraft,
      j.availableFrom,
      j.deadline,
      j.pay,
      j.notes,
      j.status,
      j.now,
      j.now,
      j.completedAt ?? null,
    );
    return this.getJob(lastId) as Job;
  }

  getJob(id: number): Job | null {
    const r = this.get('SELECT * FROM jobs WHERE id = ?', id);
    return r ? toJob(r) : null;
  }

  getJobByCode(panelId: number, code: string): Job | null {
    const r = this.get('SELECT * FROM jobs WHERE panel_id = ? AND code = ?', panelId, code);
    return r ? toJob(r) : null;
  }

  getJobBySourceKey(panelId: number, sourceKey: string): Job | null {
    const r = this.get('SELECT * FROM jobs WHERE panel_id = ? AND source_key = ?', panelId, sourceKey);
    return r ? toJob(r) : null;
  }

  updateJob(
    id: number,
    patch: Partial<Pick<Job, 'title' | 'aircraft' | 'availableFrom' | 'deadline' | 'pay' | 'notes' | 'status' | 'lastSeen' | 'remindedAt' | 'completedAt' | 'completedBy'>>,
  ): void {
    const cols: Array<[string, SQLInputValue | undefined]> = [
      ['reminded_at', patch.remindedAt],
      ['completed_at', patch.completedAt],
      ['completed_by', patch.completedBy],
      ['title', patch.title],
      ['aircraft', patch.aircraft],
      ['available_from', patch.availableFrom],
      ['deadline', patch.deadline],
      ['pay', patch.pay],
      ['notes', patch.notes],
      ['status', patch.status],
      ['last_seen', patch.lastSeen],
    ];
    const present = cols.filter(([, v]) => v !== undefined);
    if (present.length === 0) return;
    this.run(`UPDATE jobs SET ${present.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`, ...present.map(([, v]) => v as SQLInputValue), id);
  }

  listJobs(panelId: number, status?: JobStatus): Job[] {
    return (
      status
        ? this.all('SELECT * FROM jobs WHERE panel_id = ? AND status = ? ORDER BY id', panelId, status)
        : this.all('SELECT * FROM jobs WHERE panel_id = ? ORDER BY id', panelId)
    ).map(toJob);
  }

  listLegs(jobId: number): Leg[] {
    return this.all('SELECT * FROM job_legs WHERE job_id = ? ORDER BY leg_no', jobId).map((r) => ({
      jobId: n(r.job_id),
      legNo: n(r.leg_no),
      dep: s(r.dep),
      arr: s(r.arr),
      sheetHolder: sn(r.sheet_holder),
    }));
  }

  insertLeg(jobId: number, legNo: number, dep: string, arr: string, sheetHolder: string | null = null): void {
    this.run('INSERT INTO job_legs(job_id, leg_no, dep, arr, sheet_holder) VALUES (?,?,?,?,?)', jobId, legNo, dep, arr, sheetHolder);
  }

  setLegSheetHolder(jobId: number, legNo: number, sheetHolder: string | null): void {
    this.run('UPDATE job_legs SET sheet_holder = ? WHERE job_id = ? AND leg_no = ?', sheetHolder, jobId, legNo);
  }

  /** Remove a leg; any reservation on it goes with it. */
  deleteLeg(jobId: number, legNo: number): void {
    this.run('DELETE FROM job_legs WHERE job_id = ? AND leg_no = ?', jobId, legNo);
  }

  /** A job with each leg and who holds it. Null if it doesn't exist. */
  getJobView(jobId: number): JobView | null {
    const job = this.getJob(jobId);
    if (!job) return null;
    return { job, legs: this.legViews([jobId]).get(jobId) ?? [] };
  }

  /** Open jobs for a panel with their legs and holders, soonest deadline first. */
  listOpenJobViews(panelId: number): JobView[] {
    const jobs = this.all(
      `SELECT * FROM jobs WHERE panel_id = ? AND status = 'open'
       ORDER BY (deadline IS NULL), deadline, id`,
      panelId,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [] }));
  }

  /** Flights the airline's schedule marked completed since `since`, most recently completed first. */
  listCompletedJobViews(panelId: number, since: number): JobView[] {
    const jobs = this.all(
      `SELECT * FROM jobs WHERE panel_id = ? AND completed_at IS NOT NULL AND completed_at > ?
       ORDER BY completed_at DESC, id DESC`,
      panelId,
      since,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [] }));
  }

  private legViews(jobIds: number[]): Map<number, LegView[]> {
    const out = new Map<number, LegView[]>();
    if (jobIds.length === 0) return out;
    const marks = jobIds.map(() => '?').join(',');
    const rows = this.all(
      `SELECT l.job_id, l.leg_no, l.dep, l.arr, l.sheet_holder, r.discord_id, r.username, r.reserved_at, r.sheet_name, p.fshub_id
       FROM job_legs l LEFT JOIN leg_reservations r ON r.job_id = l.job_id AND r.leg_no = l.leg_no
       LEFT JOIN pilot_ids p ON p.discord_id = r.discord_id
       WHERE l.job_id IN (${marks}) ORDER BY l.job_id, l.leg_no`,
      ...jobIds,
    );
    for (const r of rows) {
      const jobId = n(r.job_id);
      const list = out.get(jobId) ?? [];
      list.push({
        jobId,
        legNo: n(r.leg_no),
        dep: s(r.dep),
        arr: s(r.arr),
        sheetHolder: sn(r.sheet_holder),
        holder: r.discord_id == null ? null : { discordId: s(r.discord_id), username: s(r.username), reservedAt: n(r.reserved_at), sheetName: sn(r.sheet_name), fshubId: nn(r.fshub_id) },
      });
      out.set(jobId, list);
    }
    return out;
  }

  /** Open jobs whose deadline has passed. Returns the panels affected. */
  expireDueJobs(now: number): number[] {
    const panels = this.all(`SELECT DISTINCT panel_id FROM jobs WHERE status = 'open' AND deadline IS NOT NULL AND deadline <= ?`, now).map((r) => n(r.panel_id));
    if (panels.length > 0) this.run(`UPDATE jobs SET status = 'expired' WHERE status = 'open' AND deadline IS NOT NULL AND deadline <= ?`, now);
    return panels;
  }

  /** Forget finished jobs (expired or removed) a while after they ended. */
  deleteStaleJobs(now: number, olderThanMs: number): number {
    return this.run(
      `DELETE FROM jobs WHERE status != 'open' AND COALESCE(deadline, last_seen) < ?`,
      now - olderThanMs,
    ).changes;
  }

  /* ------------------------------------------------------------------ reservations */

  getHolder(jobId: number, legNo: number): Holder | null {
    const r = this.get(
      `SELECT r.*, p.fshub_id FROM leg_reservations r LEFT JOIN pilot_ids p ON p.discord_id = r.discord_id
       WHERE r.job_id = ? AND r.leg_no = ?`,
      jobId,
      legNo,
    );
    return r ? { discordId: s(r.discord_id), username: s(r.username), reservedAt: n(r.reserved_at), sheetName: sn(r.sheet_name), fshubId: nn(r.fshub_id) } : null;
  }

  /** Remember the name the bot wrote against a reservation in the airline's sheet (null if it didn't, or took it out). */
  setReservationSheetName(jobId: number, legNo: number, sheetName: string | null): void {
    this.run('UPDATE leg_reservations SET sheet_name = ? WHERE job_id = ? AND leg_no = ?', sheetName, jobId, legNo);
  }

  /** Reservations a person holds on open jobs where the bot wrote their name in the sheet. */
  listSheetReservationsByUser(discordId: string): Array<{ jobId: number; legNo: number; panelId: number; sourceKey: string; sheetName: string }> {
    return this.all(
      `SELECT r.job_id, r.leg_no, r.sheet_name, j.panel_id, j.source_key
       FROM leg_reservations r JOIN jobs j ON j.id = r.job_id
       WHERE r.discord_id = ? AND r.sheet_name IS NOT NULL AND j.status = 'open'
       ORDER BY r.job_id, r.leg_no`,
      discordId,
    ).map((r) => ({ jobId: n(r.job_id), legNo: n(r.leg_no), panelId: n(r.panel_id), sourceKey: s(r.source_key), sheetName: s(r.sheet_name) }));
  }

  /** Install-level bookkeeping. */
  getKv(key: string): string | null {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key);
    return r ? s(r.value) : null;
  }

  setKv(key: string, value: string): void {
    this.run('INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  deleteKv(key: string): void {
    this.run('DELETE FROM kv WHERE key = ?', key);
  }

  /** What a pilot is called in airline sheets, if they have said (or the bot has guessed). */
  getPilotName(discordId: string): string | null {
    const r = this.get('SELECT name FROM pilot_names WHERE discord_id = ?', discordId);
    return r ? s(r.name) : null;
  }

  setPilotName(discordId: string, name: string, now: number): void {
    this.run(
      `INSERT INTO pilot_names(discord_id, name, updated_at) VALUES (?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      discordId,
      name,
      now,
    );
  }

  /** The FsHub pilot ID a person has given, if they have. */
  getPilotId(discordId: string): number | null {
    const r = this.get('SELECT fshub_id FROM pilot_ids WHERE discord_id = ?', discordId);
    return r ? n(r.fshub_id) : null;
  }

  setPilotId(discordId: string, fshubId: number, now: number): void {
    this.run(
      `INSERT INTO pilot_ids(discord_id, fshub_id, updated_at) VALUES (?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET fshub_id = excluded.fshub_id, updated_at = excluded.updated_at`,
      discordId,
      fshubId,
      now,
    );
  }

  /** Every panel on which this person holds a leg of any flight still kept, so those panels can be redrawn when their details change. */
  listPanelIdsHeldBy(discordId: string): number[] {
    return this.all(
      `SELECT DISTINCT j.panel_id FROM leg_reservations r JOIN jobs j ON j.id = r.job_id WHERE r.discord_id = ?`,
      discordId,
    ).map((r) => n(r.panel_id));
  }

  insertReservation(jobId: number, legNo: number, discordId: string, username: string, now: number): void {
    this.run('INSERT INTO leg_reservations(job_id, leg_no, discord_id, username, reserved_at) VALUES (?,?,?,?,?)', jobId, legNo, discordId, username, now);
  }

  deleteReservation(jobId: number, legNo: number): boolean {
    return this.run('DELETE FROM leg_reservations WHERE job_id = ? AND leg_no = ?', jobId, legNo).changes > 0;
  }

  /** Everything one person holds on open jobs of a panel. */
  listReservationsByUser(panelId: number, discordId: string): JobView[] {
    const jobs = this.all(
      `SELECT DISTINCT j.* FROM jobs j JOIN leg_reservations r ON r.job_id = j.id
       WHERE j.panel_id = ? AND j.status = 'open' AND r.discord_id = ?
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      discordId,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: (legs.get(job.id) ?? []).filter((l) => l.holder?.discordId === discordId) }));
  }

  /**
   * Flights a person holds at least one leg of (with every leg shown), not yet completed, that are
   * open or whose deadline is after `deadlineAfter`. Soonest deadline first.
   */
  listHeldJobViews(panelId: number, discordId: string, deadlineAfter: number): JobView[] {
    const jobs = this.all(
      `SELECT DISTINCT j.* FROM jobs j JOIN leg_reservations r ON r.job_id = j.id
       WHERE j.panel_id = ? AND r.discord_id = ? AND j.completed_at IS NULL
         AND (j.status = 'open' OR (j.status = 'expired' AND j.deadline IS NOT NULL AND j.deadline > ?))
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      discordId,
      deadlineAfter,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [] }));
  }

  /* ------------------------------------------------------------------ "pilots needed" messages, kept so they can be cleared */

  addReminderMessage(panelId: number, channelId: string, messageId: string, postedAt: number): void {
    this.run('INSERT OR REPLACE INTO reminder_messages(message_id, channel_id, panel_id, posted_at) VALUES (?,?,?,?)', messageId, channelId, panelId, postedAt);
  }

  /** Announcements posted before `before`, oldest first, with whether their panel wants them cleared. */
  listReminderMessagesBefore(before: number): Array<{ messageId: string; channelId: string; panelId: number; postedAt: number; cleanup: boolean }> {
    return this.all(
      `SELECT m.message_id, m.channel_id, m.panel_id, m.posted_at, p.reminder_cleanup
       FROM reminder_messages m JOIN panels p ON p.id = m.panel_id
       WHERE m.posted_at < ? ORDER BY m.posted_at, m.message_id`,
      before,
    ).map((r) => ({ messageId: s(r.message_id), channelId: s(r.channel_id), panelId: n(r.panel_id), postedAt: n(r.posted_at), cleanup: n(r.reminder_cleanup) !== 0 }));
  }

  listReminderMessages(panelId: number): Array<{ messageId: string; channelId: string; postedAt: number }> {
    return this.all('SELECT message_id, channel_id, posted_at FROM reminder_messages WHERE panel_id = ? ORDER BY posted_at', panelId).map((r) => ({
      messageId: s(r.message_id),
      channelId: s(r.channel_id),
      postedAt: n(r.posted_at),
    }));
  }

  deleteReminderMessage(messageId: string): void {
    this.run('DELETE FROM reminder_messages WHERE message_id = ?', messageId);
  }

  /* ------------------------------------------------------------------ the AeroDAQ market board */

  getMarketBoard(guildId: string): MarketBoard | null {
    const r = this.get('SELECT * FROM market_boards WHERE guild_id = ?', guildId);
    return r ? toMarketBoard(r) : null;
  }

  listMarketBoards(): MarketBoard[] {
    return this.all('SELECT * FROM market_boards ORDER BY created_at, guild_id').map(toMarketBoard);
  }

  /** Turn the board on for a server, or move it to another channel (which forgets its old message). */
  setMarketBoard(guildId: string, channelId: string, now: number): MarketBoard {
    const existing = this.getMarketBoard(guildId);
    if (!existing) {
      this.run('INSERT INTO market_boards(guild_id, channel_id, created_at) VALUES (?,?,?)', guildId, channelId, now);
    } else if (existing.channelId !== channelId) {
      this.run("UPDATE market_boards SET channel_id = ?, message_ids = '[]', last_attempt_at = NULL, last_ok_at = NULL, last_error = NULL WHERE guild_id = ?", channelId, guildId);
    }
    return this.getMarketBoard(guildId) as MarketBoard;
  }

  updateMarketBoard(guildId: string, patch: Partial<Pick<MarketBoard, 'messageIds' | 'lastAttemptAt' | 'lastOkAt' | 'lastError'>>): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.messageIds !== undefined) (sets.push('message_ids = ?'), params.push(JSON.stringify(patch.messageIds)));
    if (patch.lastAttemptAt !== undefined) (sets.push('last_attempt_at = ?'), params.push(patch.lastAttemptAt));
    if (patch.lastOkAt !== undefined) (sets.push('last_ok_at = ?'), params.push(patch.lastOkAt));
    if (patch.lastError !== undefined) (sets.push('last_error = ?'), params.push(patch.lastError));
    if (sets.length === 0) return;
    this.run(`UPDATE market_boards SET ${sets.join(', ')} WHERE guild_id = ?`, ...params, guildId);
  }

  deleteMarketBoard(guildId: string): boolean {
    return this.run('DELETE FROM market_boards WHERE guild_id = ?', guildId).changes > 0;
  }

  /* ------------------------------------------------------------------ DM sessions */

  upsertSession(sess: { discordId: string; panelId: number; step: SessionStep; jobId?: number | null; pendingLegs?: number[]; attempts?: number; expiresAt: number }): void {
    this.run(
      `INSERT INTO dm_sessions(discord_id, panel_id, step, job_id, pending_legs, attempts, expires_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET panel_id = excluded.panel_id, step = excluded.step, job_id = excluded.job_id,
         pending_legs = excluded.pending_legs, attempts = excluded.attempts, expires_at = excluded.expires_at`,
      sess.discordId,
      sess.panelId,
      sess.step,
      sess.jobId ?? null,
      JSON.stringify(sess.pendingLegs ?? []),
      sess.attempts ?? 0,
      sess.expiresAt,
    );
  }

  getSession(discordId: string, now: number): DmSession | null {
    const r = this.get('SELECT * FROM dm_sessions WHERE discord_id = ? AND expires_at > ?', discordId, now);
    if (!r) return null;
    return {
      discordId: s(r.discord_id),
      panelId: n(r.panel_id),
      step: s(r.step) as SessionStep,
      jobId: nn(r.job_id),
      pendingLegs: parseJsonArray<number>(r.pending_legs, []).map(Number),
      attempts: n(r.attempts),
      expiresAt: n(r.expires_at),
    };
  }

  deleteSession(discordId: string): void {
    this.run('DELETE FROM dm_sessions WHERE discord_id = ?', discordId);
  }

  purgeSessions(now: number): void {
    this.run('DELETE FROM dm_sessions WHERE expires_at <= ?', now);
  }
}
