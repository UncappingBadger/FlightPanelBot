import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { callerPath } from '../util/debugBuild.js';
import type { Logger } from '../util/log.js';
import { installReservationAudit, type AuditRow } from './debugAudit.js';

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
  /** Who is pinged by the midnight (UTC) list of the day's flights that have no pilot, or off. */
  reminderMode: ReminderMode;
  /** The role to ping when `reminderMode` is 'role'. */
  reminderRoleId: string | null;
  /** Whether the "pilots needed" announcements are deleted at 23:59 (UTC) to keep the channel tidy. */
  reminderCleanup: boolean;
  /** The UTC day (days since 1970-01-01) this panel's list was last dealt with, so a restart does not repeat it; null until the bot first looks at the panel. */
  remindedDay: number | null;
  /** Whether pilots' names and completions are written back to the linked Google Sheet (when the bot is able to). */
  writeback: boolean;
  /** The airline's FsHub ID, when the panel is linked to its FsHub roster (which fills in pilots' IDs by itself). */
  fshubAirlineId: number | null;
  fshubAirlineName: string | null;
  /** When the roster was last tried (successful or not), so a failing one is not hammered. */
  fshubSyncedAt: number | null;
  /** Why the last roster read did not work, or null if it did. */
  fshubNote: string | null;
  /** Whether the airline's recent FsHub flights are read, to confirm completed flights and show the aircraft flown. */
  fshubConfirm: boolean;
  /** How far through the airline's FsHub flight list the bot has read (a FsHub flight ID); 0 before the first read. */
  fshubFlightCursor: number;
  /** When the flights were last read (successful or not). */
  fshubFlightsAt: number | null;
  /** Why the last flight read did not work, or null if it did. */
  fshubFlightsNote: string | null;
  /** Whether flights FsHub shows flown are completed automatically, once an hour, without the pilot pressing Complete. */
  fshubAutoComplete: boolean;
  /** When the hourly completion check last ran, or null if it never has. */
  fshubAutoCompleteAt: number | null;
  /** How many days ahead the panel lists flights (1 to 7): those open now or starting within this long. */
  showDays: number;
  /** A channel of its own for the completed flights, or null when they are shown on the panel itself (below the open flights). */
  completedChannelId: string | null;
  /** The messages the completed flights are drawn in, in that channel (empty while they are shown on the panel). */
  completedMessageIds: string[];
  /** How many minutes before the latest take-off that still makes a flight's window a pilot is warned; 0 means the warning is off. */
  departWarningMinutes: number;
  /** Whether pilots' flights are followed live (FsHub's public live feed) to know who is already flying and to complete a flight soon after it lands. */
  liveTracking: boolean;
  /** Whether the flights take Aeroconomy's own flight numbers as their IDs (read from its public contracts; needs `fshubAirlineId`). Off by default. */
  flightNumbers: boolean;
  /** How the panel is drawn: a card for each flight (the default), or a grid with a button for each flight. */
  layout: 'cards' | 'grid';
  /** The order of day and month in the short dates on a grid panel's buttons: day first (16/11/26) or month first (11/16/26). */
  gridDates: 'dmy' | 'mdy';
  /** Where the preview of the blank profits an admin may fill in is shown: only to that admin in the reply (the default), in their DMs, or in `profitChannelId`. */
  profitSendTo: ProfitSendTo;
  /** The channel the preview is posted in when `profitSendTo` is 'channel'; kept when it is switched away, so switching back needs no channel. */
  profitChannelId: string | null;
  /** Members of this role may press the preview's Write button as well as the admin who asked; null means only that admin. */
  profitRoleId: string | null;
  createdAt: number;
}

export type ProfitSendTo = 'here' | 'dm' | 'channel';

/** Someone who asked for a panel as a plain list in their DMs: where it is, so it can be kept up to date. */
export interface PanelFollower {
  panelId: number;
  discordId: string;
  /** The DM channel the list was posted in. */
  channelId: string;
  /** The list's messages in that channel, in order (a long list spans several). */
  messageIds: string[];
  createdAt: number;
}

/** A flight FsHub recorded for the airline's pilots, kept for a few days so it can be matched to the panel's flights. */
export interface FlownFlight {
  flightId: number;
  pilotId: number;
  pilotName: string | null;
  dep: string;
  arr: string;
  departedAt: number | null;
  arrivedAt: number;
  aircraftIcao: string | null;
  aircraftName: string | null;
  /** FsHub's own word for it: `ON-TIME`, `DELAYED` or `LATE`; null when it said nothing. */
  scheduleStatus: string | null;
  /** The rate FsHub recorded at touchdown, in feet per minute (a descent is negative); null or missing when it gave none. */
  landingRate?: number | null;
}

/** A flight shorter or longer than this is not a believable record of how long a route takes (a test flight, a flight left running). */
export const ROUTE_TIME_MIN_MINUTES = 10;
export const ROUTE_TIME_MAX_MINUTES = 20 * 60;

/** How long one FsHub flight of a route took, and in what. */
export interface RouteTime {
  minutes: number;
  aircraftIcao: string | null;
  arrivedAt: number;
}

/** Where an airport is. */
export interface AirportCoord {
  lat: number;
  lon: number;
  name: string | null;
}

/** A pilot's saved FsHub ID, and how the bot came to have it. */
export interface PilotLink {
  fshubId: number;
  /** The name FsHub has for this pilot, if the bot has looked it up. */
  name: string | null;
  /** `typed`: the pilot said so. `roster`: read from the airline's FsHub roster. */
  source: 'typed' | 'roster';
}

/** One pilot on an airline's FsHub roster who has told FsHub their Discord account. */
export interface RosterLink {
  discordId: string;
  fshubId: number;
  name: string;
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

/** The weather board of a server: METARs in one channel, kept up to date. */
export interface WeatherBoard {
  guildId: string;
  channelId: string;
  /** The Discord messages it is drawn in, in order (a long board spans several). */
  messageIds: string[];
  /** The airports shown at the top (ICAO codes); empty means the built-in list. */
  airports: string[];
  /** When a refresh was last tried (successful or not), so a failing service is not hammered. */
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
  /** How far the flight is, in nautical miles, when the airline's sheet says (or the bot could work it out); null otherwise. */
  distanceNm: number | null;
  status: JobStatus;
  firstSeen: number;
  lastSeen: number;
  /** When the channel was last asked for a pilot for this flight; null if it hasn't been. */
  remindedAt: number | null;
  /** When this flight was first shown as completed; null if it isn't. */
  completedAt: number | null;
  /** The Discord user who completed it from here; null if it was the airline's schedule that said so. */
  completedBy: string | null;
  /** `fshub` when the completion was confirmed against FsHub's own record of the landing; null otherwise. */
  completedVia: 'fshub' | null;
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
  /** The FsHub pilot ID this person gave (or the airline's roster lists), so a manager can match them to the roster. */
  fshubId: number | null;
  /** The name FsHub has for that ID, when the bot has been able to look it up. */
  fshubName: string | null;
}

export interface LegView extends Leg {
  holder: Holder | null;
}

export interface JobView {
  job: Job;
  legs: LegView[];
  /** The pilot who has put themselves down as the backup for this flight, if one has. Filled in where views are read for the panel. */
  backup?: Holder | null;
}

/**
 * The private messages a person can turn off: 'completed' (the bot completed a flight of theirs from FsHub) and 'takeoff' (the
 * late-departure warning, to a pilot or to a backup). Anything about what they reserved, released or stand by for is not one of
 * these; it always goes out.
 */
export type NoticeKind = 'completed' | 'takeoff' | 'landing';
export const NOTICE_KINDS: readonly NoticeKind[] = ['completed', 'takeoff', 'landing'];
/** The column of `user_prefs` for each (a fixed list, so no text from outside is ever put in a query). */
const NOTICE_COLUMN: Record<NoticeKind, string> = { completed: 'notify_completed', takeoff: 'notify_takeoff', landing: 'notify_landing' };

export type SessionStep ='await_pilot' | 'await_code' | 'await_mode' | 'await_legs' | 'await_confirm';

/** What a DM conversation is for: picking a flight to fly, or one to stand by for. */
export type SessionPurpose = 'reserve' | 'backup';

export interface DmSession {
  discordId: string;
  panelId: number;
  step: SessionStep;
  purpose: SessionPurpose;
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
  distanceNm?: number | null;
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
  remindedDay: nn(r.reminded_day),
  writeback: r.writeback === undefined || r.writeback === null ? true : n(r.writeback) !== 0,
  fshubAirlineId: nn(r.fshub_airline_id),
  fshubAirlineName: sn(r.fshub_airline_name),
  fshubSyncedAt: nn(r.fshub_synced_at),
  fshubNote: sn(r.fshub_note),
  fshubConfirm: r.fshub_confirm === undefined || r.fshub_confirm === null ? true : n(r.fshub_confirm) !== 0,
  fshubFlightCursor: r.fshub_flight_cursor === undefined || r.fshub_flight_cursor === null ? 0 : n(r.fshub_flight_cursor),
  fshubFlightsAt: nn(r.fshub_flights_at),
  fshubFlightsNote: sn(r.fshub_flights_note),
  fshubAutoComplete: r.fshub_autocomplete === undefined || r.fshub_autocomplete === null ? true : n(r.fshub_autocomplete) !== 0,
  fshubAutoCompleteAt: nn(r.fshub_autocomplete_at),
  // Whatever is stored, a panel never shows less than a day or more than a week.
  showDays: r.show_days === undefined || r.show_days === null ? 7 : Math.min(7, Math.max(1, Math.round(n(r.show_days)))),
  completedChannelId: sn(r.completed_channel_id),
  completedMessageIds: parseJsonArray<string>(r.completed_message_ids, []).map(String),
  departWarningMinutes: r.depart_warning_minutes === undefined || r.depart_warning_minutes === null ? 30 : Math.min(180, Math.max(0, Math.round(n(r.depart_warning_minutes)))),
  liveTracking: r.live_tracking === undefined || r.live_tracking === null ? true : n(r.live_tracking) !== 0,
  flightNumbers: r.flight_numbers !== undefined && r.flight_numbers !== null && n(r.flight_numbers) !== 0,
  layout: s(r.layout) === 'grid' ? 'grid' : 'cards',
  gridDates: s(r.grid_dates) === 'mdy' ? 'mdy' : 'dmy',
  profitSendTo: s(r.profit_send_to) === 'dm' ? 'dm' : s(r.profit_send_to) === 'channel' ? 'channel' : 'here',
  profitChannelId: sn(r.profit_channel_id),
  profitRoleId: sn(r.profit_role_id),
  createdAt: n(r.created_at),
});

const toFollower = (r: Row): PanelFollower => ({
  panelId: n(r.panel_id),
  discordId: s(r.discord_id),
  channelId: s(r.channel_id),
  messageIds: parseJsonArray<string>(r.message_ids, []).map(String),
  createdAt: n(r.created_at),
});

const toFlownFlight = (r: Row): FlownFlight => ({
  flightId: n(r.flight_id),
  pilotId: n(r.pilot_id),
  pilotName: sn(r.pilot_name),
  dep: s(r.dep),
  arr: s(r.arr),
  departedAt: nn(r.departed_at),
  arrivedAt: n(r.arrived_at),
  aircraftIcao: sn(r.aircraft_icao),
  aircraftName: sn(r.aircraft_name),
  scheduleStatus: sn(r.schedule_status),
  landingRate: nn(r.landing_rate),
});

const toHolder = (r: Row): Holder => ({
  discordId: s(r.discord_id),
  username: s(r.username),
  reservedAt: n(r.reserved_at),
  sheetName: sn(r.sheet_name),
  fshubId: nn(r.fshub_id),
  fshubName: sn(r.fshub_name),
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

const toWeatherBoard = (r: Row): WeatherBoard => ({
  guildId: s(r.guild_id),
  channelId: s(r.channel_id),
  messageIds: parseJsonArray<string>(r.message_ids, []).map(String),
  airports: s(r.airports).split(/\s+/).filter(Boolean),
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
  distanceNm: nn(r.distance_nm),
  status: s(r.status) as JobStatus,
  firstSeen: n(r.first_seen),
  lastSeen: n(r.last_seen),
  remindedAt: nn(r.reminded_at),
  completedAt: nn(r.completed_at),
  completedBy: sn(r.completed_by),
  completedVia: sn(r.completed_via) === 'fshub' ? 'fshub' : null,
});

export class Store {
  constructor(private readonly db: DatabaseSync) {}

  /** Debug build only: reads what the reservation triggers recorded (see `enableAudit`). Null in every other build. */
  private audit: (() => AuditRow[]) | null = null;
  private auditLog: Logger | null = null;

  /**
   * Debug build only. Logs every reservation and backup row that is added, changed or removed, with the call path that did
   * it, however it happened (including by cascade). Never called in a normal build.
   */
  enableAudit(log: Logger): void {
    this.audit = installReservationAudit(this.db);
    this.auditLog = log;
  }

  private flushAudit(sql: string): void {
    if (!this.audit || !this.auditLog) return;
    const rows = this.audit();
    if (rows.length === 0) return;
    const who = callerPath(3);
    for (const r of rows) {
      const leg = r.legNo === null ? '' : ` leg ${r.legNo}`;
      this.auditLog.info(`[dbg] ${r.table === 'job_backups' ? 'BACKUP' : 'RESERVATION'} ${r.op}: ${r.code ?? `job #${r.jobId}`}${leg} ${r.username} (${r.discordId}) <- ${who} | ${sql.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }

  /** Run `fn` inside a transaction; rolls back if it throws. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      this.auditLog?.info(`[dbg] ROLLBACK: the reservation changes logged just above in this transaction were undone (${e instanceof Error ? e.message : e})`);
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
    if (this.audit) this.flushAudit(sql);
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

  /** Panels linked to an airline's FsHub roster. */
  listFshubPanels(): Panel[] {
    return this.all('SELECT * FROM panels WHERE fshub_airline_id IS NOT NULL ORDER BY id').map(toPanel);
  }

  updatePanel(
    id: number,
    patch: Partial<{
      channelId: string;
      prefix: string;
      messageIds: string[];
      completedChannelId: string | null;
      completedMessageIds: string[];
      lastRefreshAt: number | null;
      lastRefreshError: string | null;
      lastRefreshNote: string | null;
      requiredRoleId: string | null;
      sheetId: string | null;
      sheetGid: string | null;
      reminderMode: ReminderMode;
      reminderRoleId: string | null;
      reminderCleanup: boolean;
      remindedDay: number | null;
      writeback: boolean;
      fshubAirlineId: number | null;
      fshubAirlineName: string | null;
      fshubSyncedAt: number | null;
      fshubNote: string | null;
      fshubConfirm: boolean;
      fshubFlightCursor: number;
      fshubFlightsAt: number | null;
      fshubFlightsNote: string | null;
      fshubAutoComplete: boolean;
      fshubAutoCompleteAt: number | null;
      showDays: number;
      departWarningMinutes: number;
      liveTracking: boolean;
      flightNumbers: boolean;
      layout: 'cards' | 'grid';
      gridDates: 'dmy' | 'mdy';
      profitSendTo: ProfitSendTo;
      profitChannelId: string | null;
      profitRoleId: string | null;
    }>,
  ): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.profitSendTo !== undefined) {
      if (patch.profitSendTo !== 'here' && patch.profitSendTo !== 'dm' && patch.profitSendTo !== 'channel') throw new Error(`The preview goes here, to a DM or to a channel, not ${String(patch.profitSendTo)}`);
      sets.push('profit_send_to = ?');
      params.push(patch.profitSendTo);
    }
    if (patch.profitChannelId !== undefined) (sets.push('profit_channel_id = ?'), params.push(patch.profitChannelId));
    if (patch.profitRoleId !== undefined) (sets.push('profit_role_id = ?'), params.push(patch.profitRoleId));
    if (patch.flightNumbers !== undefined) (sets.push('flight_numbers = ?'), params.push(patch.flightNumbers ? 1 : 0));
    if (patch.gridDates !== undefined) {
      if (patch.gridDates !== 'dmy' && patch.gridDates !== 'mdy') throw new Error(`Dates are day first or month first, not ${String(patch.gridDates)}`);
      sets.push('grid_dates = ?');
      params.push(patch.gridDates);
    }
    if (patch.layout !== undefined) {
      if (patch.layout !== 'cards' && patch.layout !== 'grid') throw new Error(`A panel is drawn as cards or a grid, not ${String(patch.layout)}`);
      sets.push('layout = ?');
      params.push(patch.layout);
    }
    if (patch.liveTracking !== undefined) (sets.push('live_tracking = ?'), params.push(patch.liveTracking ? 1 : 0));
    if (patch.departWarningMinutes !== undefined) {
      if (!Number.isInteger(patch.departWarningMinutes) || patch.departWarningMinutes < 0 || patch.departWarningMinutes > 180) {
        throw new Error(`The departure warning is 0 (off) to 180 minutes, not ${patch.departWarningMinutes}`);
      }
      sets.push('depart_warning_minutes = ?');
      params.push(patch.departWarningMinutes);
    }
    if (patch.showDays !== undefined) {
      if (!Number.isInteger(patch.showDays) || patch.showDays < 1 || patch.showDays > 7) throw new Error(`A panel shows 1 to 7 days, not ${patch.showDays}`);
      sets.push('show_days = ?');
      params.push(patch.showDays);
    }
    if (patch.fshubAutoComplete !== undefined) (sets.push('fshub_autocomplete = ?'), params.push(patch.fshubAutoComplete ? 1 : 0));
    if (patch.fshubAutoCompleteAt !== undefined) (sets.push('fshub_autocomplete_at = ?'), params.push(patch.fshubAutoCompleteAt));
    if (patch.fshubConfirm !== undefined) (sets.push('fshub_confirm = ?'), params.push(patch.fshubConfirm ? 1 : 0));
    if (patch.fshubFlightCursor !== undefined) (sets.push('fshub_flight_cursor = ?'), params.push(patch.fshubFlightCursor));
    if (patch.fshubFlightsAt !== undefined) (sets.push('fshub_flights_at = ?'), params.push(patch.fshubFlightsAt));
    if (patch.fshubFlightsNote !== undefined) (sets.push('fshub_flights_note = ?'), params.push(patch.fshubFlightsNote));
    if (patch.fshubAirlineId !== undefined) (sets.push('fshub_airline_id = ?'), params.push(patch.fshubAirlineId));
    if (patch.fshubAirlineName !== undefined) (sets.push('fshub_airline_name = ?'), params.push(patch.fshubAirlineName));
    if (patch.fshubSyncedAt !== undefined) (sets.push('fshub_synced_at = ?'), params.push(patch.fshubSyncedAt));
    if (patch.fshubNote !== undefined) (sets.push('fshub_note = ?'), params.push(patch.fshubNote));
    if (patch.reminderCleanup !== undefined) (sets.push('reminder_cleanup = ?'), params.push(patch.reminderCleanup ? 1 : 0));
    if (patch.remindedDay !== undefined) (sets.push('reminded_day = ?'), params.push(patch.remindedDay));
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
    if (patch.completedChannelId !== undefined) (sets.push('completed_channel_id = ?'), params.push(patch.completedChannelId));
    if (patch.completedMessageIds !== undefined) (sets.push('completed_message_ids = ?'), params.push(JSON.stringify(patch.completedMessageIds)));
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
    // A flight number from the schedule may already be using what would be next (a sheet that numbers flights `WA-005`),
    // so skip any that is taken.
    for (let seq = p.nextSeq; ; seq++) {
      const code = `${p.prefix}-${String(seq).padStart(3, '0')}`;
      if (this.getJobByCode(panelId, code)) continue;
      this.run('UPDATE panels SET next_seq = ? WHERE id = ?', seq + 1, panelId);
      return code;
    }
  }

  /** Give a flight a different ID (an airline's flight number replacing the automatic one). Call inside a transaction. */
  setJobCode(jobId: number, code: string): void {
    this.run('UPDATE jobs SET code = ? WHERE id = ?', code, jobId);
  }

  /* ------------------------------------------------------------------ jobs and legs */

  insertJob(j: NewJob): Job {
    const { lastId } = this.run(
      `INSERT INTO jobs(panel_id, code, source_key, title, aircraft, available_from, deadline, pay, notes, distance_nm, status, first_seen, last_seen, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      j.panelId,
      j.code,
      j.sourceKey,
      j.title,
      j.aircraft,
      j.availableFrom,
      j.deadline,
      j.pay,
      j.notes,
      j.distanceNm ?? null,
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
    patch: Partial<Pick<Job, 'title' | 'aircraft' | 'availableFrom' | 'deadline' | 'pay' | 'notes' | 'distanceNm' | 'status' | 'lastSeen' | 'remindedAt' | 'completedAt' | 'completedBy' | 'completedVia'>>,
  ): void {
    const cols: Array<[string, SQLInputValue | undefined]> = [
      ['reminded_at', patch.remindedAt],
      ['completed_at', patch.completedAt],
      ['completed_by', patch.completedBy],
      ['completed_via', patch.completedVia],
      ['title', patch.title],
      ['aircraft', patch.aircraft],
      ['available_from', patch.availableFrom],
      ['deadline', patch.deadline],
      ['pay', patch.pay],
      ['notes', patch.notes],
      ['distance_nm', patch.distanceNm],
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
    return { job, legs: this.legViews([jobId]).get(jobId) ?? [], backup: this.backupViews([jobId]).get(jobId) ?? null };
  }

  /** Open jobs for a panel with their legs, holders and backup pilots, soonest deadline first. */
  listOpenJobViews(panelId: number): JobView[] {
    const jobs = this.all(
      `SELECT * FROM jobs WHERE panel_id = ? AND status = 'open'
       ORDER BY (deadline IS NULL), deadline, id`,
      panelId,
    ).map(toJob);
    const ids = jobs.map((j) => j.id);
    const legs = this.legViews(ids);
    const backups = this.backupViews(ids);
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [], backup: backups.get(job.id) ?? null }));
  }

  /** The backup pilot of each of these jobs that has one. */
  private backupViews(jobIds: number[]): Map<number, Holder> {
    const out = new Map<number, Holder>();
    if (jobIds.length === 0) return out;
    const marks = jobIds.map(() => '?').join(',');
    for (const r of this.all(
      `SELECT b.job_id, b.discord_id, b.username, b.created_at AS reserved_at, NULL AS sheet_name, p.fshub_id, p.fshub_name
       FROM job_backups b LEFT JOIN pilot_ids p ON p.discord_id = b.discord_id
       WHERE b.job_id IN (${marks})`,
      ...jobIds,
    )) {
      out.set(n(r.job_id), toHolder(r));
    }
    return out;
  }

  /** Put someone down as the backup for a job. False if the job already has a backup (nothing is changed). Call inside a transaction. */
  setBackup(jobId: number, discordId: string, username: string, now: number): boolean {
    return this.run('INSERT OR IGNORE INTO job_backups(job_id, discord_id, username, created_at) VALUES (?,?,?,?)', jobId, discordId, username, now).changes > 0;
  }

  /**
   * Remember what happened when this bot looked at the sheet's Backup Pilot cell for a job's backup: the name it wrote there, or an empty string
   * for "looked, and wrote nothing" (the sheet names someone else, or shows the flight finished), so that it is not looked at again. Null is "not
   * looked at yet".
   */
  setBackupSheetName(jobId: number, discordId: string, name: string | null): void {
    this.run('UPDATE job_backups SET sheet_name = ? WHERE job_id = ? AND discord_id = ?', name, jobId, discordId);
  }

  /** The name this bot wrote in the sheet for a job's backup, and the job's key in the sheet; null if there is no backup or nothing was written. */
  getBackupSheetName(jobId: number): { name: string; sourceKey: string; discordId: string } | null {
    const r = this.get("SELECT b.sheet_name, b.discord_id, j.source_key FROM job_backups b JOIN jobs j ON j.id = b.job_id WHERE b.job_id = ? AND b.sheet_name IS NOT NULL AND b.sheet_name <> ''", jobId);
    return r ? { name: s(r.sheet_name), sourceKey: s(r.source_key), discordId: s(r.discord_id) } : null;
  }

  /** The names this bot has written in sheets for this person as a backup, with the flight each is against (open flights only). */
  listSheetBackupsByUser(discordId: string): Array<{ panelId: number; jobId: number; sourceKey: string; sheetName: string }> {
    return this.all(
      `SELECT j.panel_id, j.id AS job_id, j.source_key, b.sheet_name FROM job_backups b JOIN jobs j ON j.id = b.job_id
       WHERE b.discord_id = ? AND b.sheet_name IS NOT NULL AND b.sheet_name <> '' AND j.status = 'open'`,
      discordId,
    ).map((r) => ({ panelId: n(r.panel_id), jobId: n(r.job_id), sourceKey: s(r.source_key), sheetName: s(r.sheet_name) }));
  }

  /**
   * The open flights of a panel that have a backup pilot whose name this bot has never tried to put in the sheet (they were put down before it
   * wrote backups there, or the sheet could not be reached then), oldest first. Only flights of one leg: a sheet row is one leg.
   */
  listUnloggedBackups(panelId: number): Array<{ jobId: number; discordId: string; username: string; sourceKey: string; code: string }> {
    return this.all(
      `SELECT j.id AS job_id, j.source_key, j.code, b.discord_id, b.username FROM job_backups b JOIN jobs j ON j.id = b.job_id
       WHERE j.panel_id = ? AND j.status = 'open' AND b.sheet_name IS NULL
         AND (SELECT COUNT(*) FROM job_legs l WHERE l.job_id = j.id) = 1
       ORDER BY b.created_at, j.id`,
      panelId,
    ).map((r) => ({ jobId: n(r.job_id), discordId: s(r.discord_id), username: s(r.username), sourceKey: s(r.source_key), code: s(r.code) }));
  }

  /** Take the backup off a job. With `discordId`, only if that person is the backup. True if one was removed. */
  deleteBackup(jobId: number, discordId?: string): boolean {
    return discordId === undefined
      ? this.run('DELETE FROM job_backups WHERE job_id = ?', jobId).changes > 0
      : this.run('DELETE FROM job_backups WHERE job_id = ? AND discord_id = ?', jobId, discordId).changes > 0;
  }

  /** The open flights of a panel one person is the backup for. */
  listBackupsByUser(panelId: number, discordId: string): JobView[] {
    const jobs = this.all(
      `SELECT j.* FROM jobs j JOIN job_backups b ON b.job_id = j.id
       WHERE j.panel_id = ? AND j.status = 'open' AND b.discord_id = ?
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      discordId,
    ).map(toJob);
    const ids = jobs.map((j) => j.id);
    const legs = this.legViews(ids);
    const backups = this.backupViews(ids);
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [], backup: backups.get(job.id) ?? null }));
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
      `SELECT l.job_id, l.leg_no, l.dep, l.arr, l.sheet_holder, r.discord_id, r.username, r.reserved_at, r.sheet_name, p.fshub_id, p.fshub_name
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
        holder: r.discord_id == null ? null : toHolder(r),
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
      `SELECT r.*, p.fshub_id, p.fshub_name FROM leg_reservations r LEFT JOIN pilot_ids p ON p.discord_id = r.discord_id
       WHERE r.job_id = ? AND r.leg_no = ?`,
      jobId,
      legNo,
    );
    return r ? toHolder(r) : null;
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

  /** Every name the bot has written into a sheet for this person (a name they later changed is still on the flights it was written to). */
  listSheetNamesByUser(discordId: string): string[] {
    return this.all('SELECT DISTINCT sheet_name FROM leg_reservations WHERE discord_id = ? AND sheet_name IS NOT NULL ORDER BY sheet_name', discordId).map((r) => s(r.sheet_name));
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

  /** What the bot has saved for a person: the FsHub ID, the name FsHub has for it, and who supplied it. */
  getPilotLink(discordId: string): PilotLink | null {
    const r = this.get('SELECT fshub_id, fshub_name, source FROM pilot_ids WHERE discord_id = ?', discordId);
    return r ? { fshubId: n(r.fshub_id), name: sn(r.fshub_name), source: s(r.source) === 'roster' ? 'roster' : 'typed' } : null;
  }

  /**
   * Save the FsHub pilot ID a person gave, with the name FsHub has for it if that was looked up. It
   * replaces whatever was saved before, including an ID that came from a roster.
   */
  setPilotId(discordId: string, fshubId: number, now: number, name: string | null = null): void {
    this.run(
      `INSERT INTO pilot_ids(discord_id, fshub_id, updated_at, fshub_name, source) VALUES (?,?,?,?, 'typed')
       ON CONFLICT(discord_id) DO UPDATE SET fshub_id = excluded.fshub_id, updated_at = excluded.updated_at,
         fshub_name = excluded.fshub_name, source = 'typed'`,
      discordId,
      fshubId,
      now,
      name,
    );
  }

  /**
   * Take what an airline's FsHub roster says about who is who. Someone with no saved ID gets the
   * roster's; one whose ID came from a roster before is brought up to date. An ID a pilot typed
   * themselves is never replaced (the roster only refreshes the name beside it when it agrees).
   * Returns the people whose saved details changed.
   */
  applyRosterLinks(links: RosterLink[], now: number): string[] {
    const changed: string[] = [];
    this.tx(() => {
      for (const link of links) {
        const cur = this.get('SELECT fshub_id, fshub_name, source FROM pilot_ids WHERE discord_id = ?', link.discordId);
        if (!cur) {
          this.run(`INSERT INTO pilot_ids(discord_id, fshub_id, updated_at, fshub_name, source) VALUES (?,?,?,?, 'roster')`, link.discordId, link.fshubId, now, link.name);
          changed.push(link.discordId);
          continue;
        }
        const sameId = n(cur.fshub_id) === link.fshubId;
        if (s(cur.source) === 'typed' && !sameId) continue; // what the pilot typed wins
        if (sameId && sn(cur.fshub_name) === link.name) continue; // nothing new
        this.run('UPDATE pilot_ids SET fshub_id = ?, fshub_name = ?, updated_at = ? WHERE discord_id = ?', link.fshubId, link.name, now, link.discordId);
        changed.push(link.discordId);
      }
    });
    return changed;
  }

  /** Another Discord account that an airline's FsHub roster says this FsHub pilot is, if there is one. */
  rosterOwnerOf(fshubId: number, exceptDiscordId: string): string | null {
    const r = this.get(`SELECT discord_id FROM pilot_ids WHERE fshub_id = ? AND source = 'roster' AND discord_id != ? LIMIT 1`, fshubId, exceptDiscordId);
    return r ? s(r.discord_id) : null;
  }

  /** The Discord accounts that have this FsHub pilot ID saved, and whether each got it from the airline's roster or typed it. */
  discordAccountsForFshubId(fshubId: number): Array<{ discordId: string; source: 'roster' | 'typed' }> {
    return this.all('SELECT discord_id, source FROM pilot_ids WHERE fshub_id = ? ORDER BY discord_id', fshubId).map((r) => ({
      discordId: s(r.discord_id),
      source: s(r.source) === 'roster' ? ('roster' as const) : ('typed' as const),
    }));
  }

  /* ------------------------------------------------------------------ remarks on very hard landings */

  /** Has the bot already dealt with this FsHub flight (told the pilot, or decided not to)? */
  hasLandingRemark(flightId: number): boolean {
    return this.get('SELECT 1 AS x FROM landing_remarks WHERE flight_id = ?', flightId) !== undefined;
  }

  /** Remember a flight as dealt with. `told` is whether a message went out. Dealing with the same flight twice changes nothing. */
  recordLandingRemark(flightId: number, discordId: string, rate: number, told: boolean, now: number): void {
    this.run('INSERT OR IGNORE INTO landing_remarks(flight_id, discord_id, rate, told, handled_at) VALUES (?,?,?,?,?)', flightId, discordId, rate, told ? 1 : 0, now);
  }

  /** When this person was last sent a remark about a landing, or null if never. */
  lastLandingRemarkAt(discordId: string): number | null {
    return nn(this.get('SELECT max(handled_at) AS t FROM landing_remarks WHERE discord_id = ? AND told = 1', discordId)?.t);
  }

  /** Has this person ever been sent a remark? (The words for turning them off only mean something to someone who has.) */
  wasRemarkedOn(discordId: string): boolean {
    return this.get('SELECT 1 AS x FROM landing_remarks WHERE discord_id = ? AND told = 1 LIMIT 1', discordId) !== undefined;
  }

  /** Forget flights that were dealt with without a message going out, before this time. Flights that were told about are kept: they are small, and they are how the bot knows who has been remarked on. */
  pruneLandingRemarks(before: number): void {
    this.run('DELETE FROM landing_remarks WHERE told = 0 AND handled_at < ?', before);
  }

  /* ------------------------------------------------------------------ the airline's recent FsHub flights */

  /** Keep these FsHub flights for a panel (one already kept is brought up to date). Returns how many were new. */
  upsertFshubFlights(panelId: number, flights: FlownFlight[]): number {
    let added = 0;
    this.tx(() => {
      for (const f of flights) {
        const existed = this.get('SELECT 1 AS x FROM fshub_flights WHERE panel_id = ? AND flight_id = ?', panelId, f.flightId) !== undefined;
        this.run(
          `INSERT OR REPLACE INTO fshub_flights(panel_id, flight_id, pilot_id, pilot_name, dep, arr, departed_at, arrived_at, aircraft_icao, aircraft_name, schedule_status, landing_rate)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          panelId,
          f.flightId,
          f.pilotId,
          f.pilotName,
          f.dep,
          f.arr,
          f.departedAt,
          f.arrivedAt,
          f.aircraftIcao,
          f.aircraftName,
          f.scheduleStatus,
          f.landingRate ?? null,
        );
        if (!existed) added++;
        this.learnRouteTime(panelId, f);
      }
    });
    return added;
  }

  /**
   * Keep how long this flight took, to know how long the route takes, when it is a believable time. These outlive the flights
   * themselves (which are forgotten after a week), because a route's usual time is worth keeping.
   */
  private learnRouteTime(panelId: number, f: FlownFlight): void {
    if (f.departedAt === null) return;
    const minutes = Math.round((f.arrivedAt - f.departedAt) / 60_000);
    if (minutes < ROUTE_TIME_MIN_MINUTES || minutes > ROUTE_TIME_MAX_MINUTES) return;
    this.run(
      'INSERT OR REPLACE INTO route_times(panel_id, flight_id, dep, arr, aircraft_icao, minutes, arrived_at) VALUES (?,?,?,?,?,?,?)',
      panelId,
      f.flightId,
      f.dep.toUpperCase(),
      f.arr.toUpperCase(),
      f.aircraftIcao ? f.aircraftIcao.toUpperCase() : null,
      minutes,
      f.arrivedAt,
    );
  }

  /** The flight times kept for a route (most recent first, up to `limit`), each with the aircraft it was flown in. */
  listRouteTimes(panelId: number, dep: string, arr: string, limit = 25): RouteTime[] {
    return this.all(
      'SELECT minutes, aircraft_icao, arrived_at FROM route_times WHERE panel_id = ? AND dep = ? AND arr = ? ORDER BY arrived_at DESC, flight_id DESC LIMIT ?',
      panelId,
      dep.toUpperCase(),
      arr.toUpperCase(),
      limit,
    ).map((r) => ({ minutes: n(r.minutes), aircraftIcao: sn(r.aircraft_icao), arrivedAt: n(r.arrived_at) }));
  }

  /** Forget flight times older than `before`. */
  pruneRouteTimes(before: number): number {
    return this.run('DELETE FROM route_times WHERE arrived_at < ?', before).changes;
  }

  /* ------------------------------------------------------------------ airports' positions and who has been warned */

  getAirportCoords(codes: string[]): Map<string, AirportCoord> {
    const out = new Map<string, AirportCoord>();
    for (const code of new Set(codes.map((c) => c.toUpperCase()))) {
      const r = this.get('SELECT code, lat, lon, name FROM airport_coords WHERE code = ?', code);
      if (r) out.set(code, { lat: n(r.lat), lon: n(r.lon), name: sn(r.name) });
    }
    return out;
  }

  saveAirportCoords(rows: Array<{ code: string; lat: number; lon: number; name: string | null }>): void {
    this.tx(() => {
      for (const a of rows) this.run('INSERT OR REPLACE INTO airport_coords(code, lat, lon, name) VALUES (?,?,?,?)', a.code.toUpperCase(), a.lat, a.lon, a.name);
    });
  }

  /** Whether this person has already been warned about this flight. */
  wasWarned(jobId: number, discordId: string): boolean {
    return this.get('SELECT 1 AS x FROM departure_warnings WHERE job_id = ? AND discord_id = ?', jobId, discordId) !== undefined;
  }

  markWarned(jobId: number, discordId: string, now: number): void {
    this.run('INSERT OR IGNORE INTO departure_warnings(job_id, discord_id, sent_at) VALUES (?,?,?)', jobId, discordId, now);
  }

  /** The FsHub pilots who flew the airline's flights most recently (each once), newest first. */
  recentFshubPilotIds(panelId: number, limit: number): number[] {
    return this.all('SELECT pilot_id FROM fshub_flights WHERE panel_id = ? GROUP BY pilot_id ORDER BY MAX(arrived_at) DESC LIMIT ?', panelId, limit).map((r) => n(r.pilot_id));
  }

  /** The airline's FsHub flights from `dep` to `arr` that landed between `from` and `to` (epoch ms), earliest first. */
  listFshubFlights(panelId: number, dep: string, arr: string, from: number, to: number): FlownFlight[] {
    return this.all(
      `SELECT * FROM fshub_flights WHERE panel_id = ? AND dep = ? AND arr = ? AND arrived_at >= ? AND arrived_at <= ?
       ORDER BY arrived_at, flight_id`,
      panelId,
      dep,
      arr,
      from,
      to,
    ).map(toFlownFlight);
  }

  countFshubFlights(panelId: number): number {
    return n(this.get('SELECT count(*) AS c FROM fshub_flights WHERE panel_id = ?', panelId)?.c ?? 0);
  }

  /** Forget flights that landed before `before`. */
  pruneFshubFlights(panelId: number, before: number): number {
    return this.run('DELETE FROM fshub_flights WHERE panel_id = ? AND arrived_at < ?', panelId, before).changes;
  }

  /** Forget every kept flight of a panel and where the reading had got to (when it is switched off or unlinked). */
  clearFshubFlights(panelId: number): void {
    this.run('DELETE FROM fshub_flights WHERE panel_id = ?', panelId);
    this.run('UPDATE panels SET fshub_flight_cursor = 0, fshub_flights_at = NULL, fshub_flights_note = NULL WHERE id = ?', panelId);
  }

  /** Every panel with a flight this person is down as the backup for. */
  listPanelIdsBackedBy(discordId: string): number[] {
    return this.all(`SELECT DISTINCT j.panel_id FROM job_backups b JOIN jobs j ON j.id = b.job_id WHERE b.discord_id = ?`, discordId).map((r) => n(r.panel_id));
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

  /**
   * Every flight on a panel that somebody holds at least one leg of (with every leg shown), not yet completed, that is
   * open or whose deadline is after `deadlineAfter`. Soonest deadline first. Used by the hourly automatic completion.
   */
  listAllHeldJobViews(panelId: number, deadlineAfter: number): JobView[] {
    const jobs = this.all(
      `SELECT DISTINCT j.* FROM jobs j JOIN leg_reservations r ON r.job_id = j.id
       WHERE j.panel_id = ? AND j.completed_at IS NULL
         AND (j.status = 'open' OR (j.status = 'expired' AND j.deadline IS NOT NULL AND j.deadline > ?))
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      deadlineAfter,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [] }));
  }

  /**
   * Every flight on a panel that has a backup pilot, not yet completed, that is open or whose deadline is after `deadlineAfter` (with its
   * legs and its backup). Soonest deadline first. Used to credit a flight to its backup when FsHub shows the backup flew it.
   */
  listBackedJobViews(panelId: number, deadlineAfter: number): JobView[] {
    const jobs = this.all(
      `SELECT DISTINCT j.* FROM jobs j JOIN job_backups b ON b.job_id = j.id
       WHERE j.panel_id = ? AND j.completed_at IS NULL
         AND (j.status = 'open' OR (j.status = 'expired' AND j.deadline IS NOT NULL AND j.deadline > ?))
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      deadlineAfter,
    ).map(toJob);
    const ids = jobs.map((j) => j.id);
    const legs = this.legViews(ids);
    const backups = this.backupViews(ids);
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [], backup: backups.get(job.id) ?? null }));
  }

  /**
   * Flights on a panel that the airline's sheet puts a name against while nobody holds any leg of them in Discord, not yet
   * completed, that are open or whose deadline is after `deadlineAfter`. Soonest deadline first. These are the flights a
   * pilot may be flying without having pressed Reserve.
   */
  listNamedJobViews(panelId: number, deadlineAfter: number): JobView[] {
    const jobs = this.all(
      `SELECT DISTINCT j.* FROM jobs j JOIN job_legs l ON l.job_id = j.id
       WHERE j.panel_id = ? AND j.completed_at IS NULL AND l.sheet_holder IS NOT NULL
         AND (j.status = 'open' OR (j.status = 'expired' AND j.deadline IS NOT NULL AND j.deadline > ?))
         AND NOT EXISTS (SELECT 1 FROM leg_reservations r WHERE r.job_id = j.id)
       ORDER BY (j.deadline IS NULL), j.deadline, j.id`,
      panelId,
      deadlineAfter,
    ).map(toJob);
    const legs = this.legViews(jobs.map((j) => j.id));
    return jobs.map((job) => ({ job, legs: legs.get(job.id) ?? [] }));
  }

  /** Every name any pilot has given the bot or had it write in a sheet, with whose it is (a name may be more than one person's). */
  listKnownPilotNames(): Array<{ discordId: string; name: string }> {
    return this.all(
      `SELECT discord_id, name FROM pilot_names
       UNION SELECT discord_id, sheet_name AS name FROM leg_reservations WHERE sheet_name IS NOT NULL`,
    ).map((r) => ({ discordId: s(r.discord_id), name: s(r.name) }));
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

  /* ------------------------------------------------------------------ panel lists kept in people's DMs */

  getFollower(panelId: number, discordId: string): PanelFollower | null {
    const r = this.get('SELECT * FROM panel_followers WHERE panel_id = ? AND discord_id = ?', panelId, discordId);
    return r ? toFollower(r) : null;
  }

  listFollowers(panelId: number): PanelFollower[] {
    return this.all('SELECT * FROM panel_followers WHERE panel_id = ? ORDER BY created_at, discord_id', panelId).map(toFollower);
  }

  countFollowers(panelId: number): number {
    return n(this.get('SELECT COUNT(*) AS c FROM panel_followers WHERE panel_id = ?', panelId)?.c ?? 0);
  }

  /** Remember (or replace) where someone's list for a panel is. */
  saveFollower(f: PanelFollower): void {
    this.run(
      `INSERT INTO panel_followers(panel_id, discord_id, channel_id, message_ids, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(panel_id, discord_id) DO UPDATE SET channel_id = excluded.channel_id, message_ids = excluded.message_ids`,
      f.panelId,
      f.discordId,
      f.channelId,
      JSON.stringify(f.messageIds),
      f.createdAt,
    );
  }

  deleteFollower(panelId: number, discordId: string): void {
    this.run('DELETE FROM panel_followers WHERE panel_id = ? AND discord_id = ?', panelId, discordId);
  }

  /* ------------------------------------------------------------------ a person's own settings */

  getHideUnavailable(discordId: string): boolean {
    return n(this.get('SELECT hide_unavailable FROM user_prefs WHERE discord_id = ?', discordId)?.hide_unavailable ?? 0) !== 0;
  }

  setHideUnavailable(discordId: string, on: boolean, now: number): void {
    this.run(
      `INSERT INTO user_prefs(discord_id, hide_unavailable, updated_at) VALUES (?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET hide_unavailable = excluded.hide_unavailable, updated_at = excluded.updated_at`,
      discordId,
      on ? 1 : 0,
      now,
    );
  }

  /** Does this person want this optional private message? Everyone does until they say otherwise. */
  wantsNotice(discordId: string, kind: NoticeKind): boolean {
    return n(this.get(`SELECT ${NOTICE_COLUMN[kind]} AS on_ FROM user_prefs WHERE discord_id = ?`, discordId)?.on_ ?? 1) !== 0;
  }

  /** Which optional private messages this person wants. */
  getNotices(discordId: string): Record<NoticeKind, boolean> {
    return { completed: this.wantsNotice(discordId, 'completed'), takeoff: this.wantsNotice(discordId, 'takeoff'), landing: this.wantsNotice(discordId, 'landing') };
  }

  setNotice(discordId: string, kind: NoticeKind, on: boolean, now: number): void {
    const column = NOTICE_COLUMN[kind];
    this.run(
      `INSERT INTO user_prefs(discord_id, ${column}, updated_at) VALUES (?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at`,
      discordId,
      on ? 1 : 0,
      now,
    );
  }

  /** The panels this person has a list view of. */
  listFollowedPanelIds(discordId: string): number[] {
    return this.all('SELECT panel_id FROM panel_followers WHERE discord_id = ? ORDER BY panel_id', discordId).map((r) => n(r.panel_id));
  }

  /* ------------------------------------------------------------------ roles that may run /setup refresh */

  listRefreshRoles(guildId: string): string[] {
    return this.all('SELECT role_id FROM refresh_roles WHERE guild_id = ? ORDER BY created_at, role_id', guildId).map((r) => s(r.role_id));
  }

  /** False if the role was already one. */
  addRefreshRole(guildId: string, roleId: string, now: number): boolean {
    return this.run('INSERT OR IGNORE INTO refresh_roles(guild_id, role_id, created_at) VALUES (?,?,?)', guildId, roleId, now).changes > 0;
  }

  /** False if the role was not one. */
  removeRefreshRole(guildId: string, roleId: string): boolean {
    return this.run('DELETE FROM refresh_roles WHERE guild_id = ? AND role_id = ?', guildId, roleId).changes > 0;
  }

  /** How many were removed. */
  clearRefreshRoles(guildId: string): number {
    return this.run('DELETE FROM refresh_roles WHERE guild_id = ?', guildId).changes;
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

  /* ------------------------------------------------------------------ the weather board */

  getWeatherBoard(guildId: string): WeatherBoard | null {
    const r = this.get('SELECT * FROM weather_boards WHERE guild_id = ?', guildId);
    return r ? toWeatherBoard(r) : null;
  }

  listWeatherBoards(): WeatherBoard[] {
    return this.all('SELECT * FROM weather_boards ORDER BY created_at, guild_id').map(toWeatherBoard);
  }

  /** Turn the board on for a server, or move it to another channel (which forgets its old messages). The airports at the top are kept. */
  setWeatherBoard(guildId: string, channelId: string, now: number): WeatherBoard {
    const existing = this.getWeatherBoard(guildId);
    if (!existing) {
      this.run('INSERT INTO weather_boards(guild_id, channel_id, created_at) VALUES (?,?,?)', guildId, channelId, now);
    } else if (existing.channelId !== channelId) {
      this.run("UPDATE weather_boards SET channel_id = ?, message_ids = '[]', last_attempt_at = NULL, last_ok_at = NULL, last_error = NULL WHERE guild_id = ?", channelId, guildId);
    }
    return this.getWeatherBoard(guildId) as WeatherBoard;
  }

  updateWeatherBoard(guildId: string, patch: Partial<Pick<WeatherBoard, 'messageIds' | 'airports' | 'lastAttemptAt' | 'lastOkAt' | 'lastError'>>): void {
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    if (patch.messageIds !== undefined) (sets.push('message_ids = ?'), params.push(JSON.stringify(patch.messageIds)));
    if (patch.airports !== undefined) (sets.push('airports = ?'), params.push(patch.airports.join(' ')));
    if (patch.lastAttemptAt !== undefined) (sets.push('last_attempt_at = ?'), params.push(patch.lastAttemptAt));
    if (patch.lastOkAt !== undefined) (sets.push('last_ok_at = ?'), params.push(patch.lastOkAt));
    if (patch.lastError !== undefined) (sets.push('last_error = ?'), params.push(patch.lastError));
    if (sets.length === 0) return;
    this.run(`UPDATE weather_boards SET ${sets.join(', ')} WHERE guild_id = ?`, ...params, guildId);
  }

  deleteWeatherBoard(guildId: string): boolean {
    return this.run('DELETE FROM weather_boards WHERE guild_id = ?', guildId).changes > 0;
  }

  /* ------------------------------------------------------------------ DM sessions */

  upsertSession(sess: {
    discordId: string;
    panelId: number;
    step: SessionStep;
    purpose?: SessionPurpose;
    jobId?: number | null;
    pendingLegs?: number[];
    attempts?: number;
    expiresAt: number;
  }): void {
    this.run(
      `INSERT INTO dm_sessions(discord_id, panel_id, step, purpose, job_id, pending_legs, attempts, expires_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(discord_id) DO UPDATE SET panel_id = excluded.panel_id, step = excluded.step, purpose = excluded.purpose, job_id = excluded.job_id,
         pending_legs = excluded.pending_legs, attempts = excluded.attempts, expires_at = excluded.expires_at`,
      sess.discordId,
      sess.panelId,
      sess.step,
      sess.purpose ?? 'reserve',
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
      purpose: s(r.purpose) === 'backup' ? 'backup' : 'reserve',
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

  /* ------------------------------------------------------------------ paying pilots */

  /** What an admin set up for paying a panel's pilots, or null when nothing was ever set. */
  getPayrollSettings(panelId: number): PayrollSettings | null {
    const r = this.get('SELECT * FROM payroll_settings WHERE panel_id = ?', panelId);
    return r ? toPayrollSettings(r) : null;
  }

  /** Every panel's settings that are switched on. */
  listPayrollEnabled(): PayrollSettings[] {
    return this.all('SELECT * FROM payroll_settings WHERE enabled = 1 ORDER BY panel_id').map(toPayrollSettings);
  }

  /** Change some of a panel's payroll settings (the rest are kept); the row is made on the first change. */
  savePayrollSettings(panelId: number, patch: Partial<Omit<PayrollSettings, 'panelId'>>): PayrollSettings {
    this.run('INSERT OR IGNORE INTO payroll_settings(panel_id) VALUES (?)', panelId);
    const sets: string[] = [];
    const params: SQLInputValue[] = [];
    const set = (column: string, value: SQLInputValue) => (sets.push(`${column} = ?`), params.push(value));
    if (patch.enabled !== undefined) set('enabled', patch.enabled ? 1 : 0);
    if (patch.sourceAccount !== undefined) set('source_account', patch.sourceAccount);
    if (patch.infoSheetId !== undefined) set('info_sheet_id', patch.infoSheetId);
    if (patch.infoGid !== undefined) set('info_gid', patch.infoGid);
    if (patch.startDay !== undefined) set('start_day', patch.startDay);
    if (patch.runAtMinute !== undefined) {
      if (!Number.isInteger(patch.runAtMinute) || patch.runAtMinute < 0 || patch.runAtMinute >= 1440) throw new Error('The time of day has to be a minute from 0 to 1439.');
      set('run_at_minute', patch.runAtMinute);
    }
    if (patch.ownerId !== undefined) set('owner_id', patch.ownerId);
    if (patch.lastRunDay !== undefined) set('last_run_day', patch.lastRunDay);
    if (sets.length > 0) this.run(`UPDATE payroll_settings SET ${sets.join(', ')} WHERE panel_id = ?`, ...params, panelId);
    return this.getPayrollSettings(panelId) as PayrollSettings;
  }

  /** The newest ledger row for a sheet flight (by its key), if the bot ever began paying it. */
  ledgerBySourceKey(panelId: number, sourceKey: string): LedgerEntry | null {
    const r = this.get('SELECT * FROM payroll_payments WHERE panel_id = ? AND source_key = ? ORDER BY id DESC LIMIT 1', panelId, sourceKey);
    return r ? toLedgerEntry(r) : null;
  }

  ledgerByUniqueId(panelId: number, uniqueId: string): LedgerEntry | null {
    const r = this.get('SELECT * FROM payroll_payments WHERE panel_id = ? AND unique_id = ?', panelId, uniqueId);
    return r ? toLedgerEntry(r) : null;
  }

  /**
   * Write down that a payment is about to be sent, before it is. False when that unique ID is already in the ledger and was not a failure (it is
   * paid, or it is being sent, or was and nobody knows): then nothing is to be sent. A payment that failed is the one thing that may be tried again,
   * under the same unique ID.
   */
  ledgerBegin(panelId: number, e: { uniqueId: string; sourceKey: string | null; pilot: string; fshubId: number | null; account: string; cents: number }, now: number): boolean {
    return this.tx(() => {
      const have = this.ledgerByUniqueId(panelId, e.uniqueId);
      if (have && have.status !== 'failed') return false;
      if (have) {
        this.run(`UPDATE payroll_payments SET status = 'sending', source_key = ?, pilot = ?, fshub_id = ?, account = ?, cents = ?, detail = NULL, updated_at = ? WHERE id = ?`, e.sourceKey, e.pilot, e.fshubId, e.account, e.cents, now, have.id);
        return true;
      }
      this.run(
        `INSERT INTO payroll_payments(panel_id, unique_id, source_key, pilot, fshub_id, account, cents, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,'sending',?,?)`,
        panelId,
        e.uniqueId,
        e.sourceKey,
        e.pilot,
        e.fshubId,
        e.account,
        e.cents,
        now,
        now,
      );
      return true;
    });
  }

  /** What became of a payment that was begun: the bank said yes (`paid`) or no (`failed`, with why). */
  ledgerFinish(panelId: number, uniqueId: string, status: 'paid' | 'failed', detail: string | null, now: number): void {
    this.run('UPDATE payroll_payments SET status = ?, detail = ?, updated_at = ? WHERE panel_id = ? AND unique_id = ?', status, detail, now, panelId, uniqueId);
  }

  /** The account this FsHub pilot was most recently paid into, or null if they never were. */
  lastPaidAccount(panelId: number, fshubId: number): string | null {
    const r = this.get(`SELECT account FROM payroll_payments WHERE panel_id = ? AND fshub_id = ? AND status = 'paid' ORDER BY updated_at DESC, id DESC LIMIT 1`, panelId, fshubId);
    return r ? s(r.account) : null;
  }

  /** The newest ledger rows, newest first. */
  listLedger(panelId: number, limit: number): LedgerEntry[] {
    return this.all('SELECT * FROM payroll_payments WHERE panel_id = ? ORDER BY id DESC LIMIT ?', panelId, limit).map(toLedgerEntry);
  }

  /** Rows still marked as being sent, which nobody has settled. */
  countUnsettledPayments(panelId: number): number {
    return n(this.get(`SELECT count(*) AS c FROM payroll_payments WHERE panel_id = ? AND status = 'sending'`, panelId)?.c ?? 0);
  }

  /** The FsHub pilot IDs the bot ties to a name written in a sheet: by what the pilot told it, or by a flight it wrote that name on. */
  fshubIdsForSheetName(name: string): number[] {
    return this.all(
      `SELECT DISTINCT fshub_id FROM pilot_ids WHERE discord_id IN (
         SELECT discord_id FROM leg_reservations WHERE lower(sheet_name) = lower(?)
         UNION SELECT discord_id FROM pilot_names WHERE lower(name) = lower(?))`,
      name.trim(),
      name.trim(),
    ).map((r) => n(r.fshub_id));
  }

  /** The names the bot has for a FsHub pilot: what FsHub calls them, and what they were called on the airline's flights it has read. */
  fshubNamesForId(panelId: number, fshubId: number): string[] {
    const out = new Set<string>();
    for (const r of this.all('SELECT fshub_name AS name FROM pilot_ids WHERE fshub_id = ? AND fshub_name IS NOT NULL', fshubId)) out.add(s(r.name));
    for (const r of this.all('SELECT DISTINCT pilot_name AS name FROM fshub_flights WHERE panel_id = ? AND pilot_id = ? AND pilot_name IS NOT NULL', panelId, fshubId)) out.add(s(r.name));
    return [...out];
  }

  /** Does the bot know this FsHub pilot at all (a pilot who told it, or one who flew one of the airline's flights it has read)? */
  knowsFshubId(panelId: number, fshubId: number): boolean {
    return (
      this.get('SELECT 1 AS x FROM pilot_ids WHERE fshub_id = ?', fshubId) !== undefined ||
      this.get('SELECT 1 AS x FROM fshub_flights WHERE panel_id = ? AND pilot_id = ? LIMIT 1', panelId, fshubId) !== undefined
    );
  }

  /** A list of payments waiting for an admin to check it. Replaces any with the same token. */
  savePayrollDraft(d: { token: string; panelId: number; askerId: string; place: string; body: string; createdAt: number; expiresAt: number }): void {
    this.run(
      `INSERT INTO payroll_drafts(token, panel_id, asker_id, place, body, created_at, expires_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(token) DO UPDATE SET body = excluded.body, expires_at = excluded.expires_at`,
      d.token,
      d.panelId,
      d.askerId,
      d.place,
      d.body,
      d.createdAt,
      d.expiresAt,
    );
  }

  getPayrollDraft(token: string, now: number): { token: string; panelId: number; askerId: string; place: string; body: string; createdAt: number; expiresAt: number } | null {
    const r = this.get('SELECT * FROM payroll_drafts WHERE token = ? AND expires_at > ?', token, now);
    return r ? { token: s(r.token), panelId: n(r.panel_id), askerId: s(r.asker_id), place: s(r.place), body: s(r.body), createdAt: n(r.created_at), expiresAt: n(r.expires_at) } : null;
  }

  /** Take a list away. True only for the one call that did (so of two people pressing at once, one gets it). */
  deletePayrollDraft(token: string): boolean {
    return this.run('DELETE FROM payroll_drafts WHERE token = ?', token).changes > 0;
  }

  /** Drop a panel's older lists when a new one is made, and any that have run out. */
  clearPayrollDrafts(panelId: number, now: number): void {
    this.run('DELETE FROM payroll_drafts WHERE panel_id = ? OR expires_at <= ?', panelId, now);
  }

  /* ------------------------------------------------------------------ Pilot Pay cells this bot wrote */

  /** Remember that these flights' Pilot Pay cells were written by this bot (a flight written again keeps one record, with the newest amount). */
  recordPayWrites(panelId: number, writes: Array<{ sourceKey: string; cents: number }>, now: number): void {
    this.tx(() => {
      for (const w of writes) this.run('INSERT OR REPLACE INTO pay_writes(panel_id, source_key, cents, written_at) VALUES (?,?,?,?)', panelId, w.sourceKey, w.cents, now);
    });
  }

  /** The flights (by their key in the sheet) whose Pilot Pay cell this bot has written. */
  payWrittenKeys(panelId: number): Set<string> {
    return new Set(this.all('SELECT source_key FROM pay_writes WHERE panel_id = ?', panelId).map((r) => s(r.source_key)));
  }
}

/** What an admin set up for paying a panel's pilots. */
export interface PayrollSettings {
  panelId: number;
  enabled: boolean;
  /** The airline's account the pay comes out of. */
  sourceAccount: string | null;
  /** The tab of a sheet that lists the pilots (name, FsHub ID, bank account). */
  infoSheetId: string | null;
  infoGid: string | null;
  /** Midnight (Zulu) of the first flight day that is ever paid: earlier flights are never put on a list. */
  startDay: number | null;
  /** Minutes after midnight (Zulu) at which each day's list is made. */
  runAtMinute: number;
  /** The admin who set it up last: a list made on its own, with nobody asking, goes to their DMs unless a channel is chosen. */
  ownerId: string | null;
  /** The Zulu day (midnight, epoch ms) a list was last made for. */
  lastRunDay: number | null;
}

/** One payment the bot has begun to make. */
export interface LedgerEntry {
  id: number;
  panelId: number;
  uniqueId: string;
  sourceKey: string | null;
  pilot: string;
  fshubId: number | null;
  account: string;
  cents: number;
  status: 'sending' | 'paid' | 'failed';
  detail: string | null;
  createdAt: number;
  updatedAt: number;
}

const toPayrollSettings = (r: Row): PayrollSettings => ({
  panelId: n(r.panel_id),
  enabled: n(r.enabled) !== 0,
  sourceAccount: sn(r.source_account),
  infoSheetId: sn(r.info_sheet_id),
  infoGid: sn(r.info_gid),
  startDay: r.start_day === null || r.start_day === undefined ? null : n(r.start_day),
  runAtMinute: n(r.run_at_minute),
  ownerId: sn(r.owner_id),
  lastRunDay: r.last_run_day === null || r.last_run_day === undefined ? null : n(r.last_run_day),
});

const toLedgerEntry = (r: Row): LedgerEntry => ({
  id: n(r.id),
  panelId: n(r.panel_id),
  uniqueId: s(r.unique_id),
  sourceKey: sn(r.source_key),
  pilot: s(r.pilot),
  fshubId: r.fshub_id === null || r.fshub_id === undefined ? null : n(r.fshub_id),
  account: s(r.account),
  cents: n(r.cents),
  status: s(r.status) === 'paid' ? 'paid' : s(r.status) === 'failed' ? 'failed' : 'sending',
  detail: sn(r.detail),
  createdAt: n(r.created_at),
  updatedAt: n(r.updated_at),
});
