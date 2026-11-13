import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered migrations. Index + 1 is the schema version stored in PRAGMA user_version.
 * Never edit a migration that has shipped; append a new one.
 */
/** Exported so a test can build an older database and check that it upgrades. */
export const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE links (
    discord_id TEXT PRIMARY KEY,
    pilot_id   INTEGER NOT NULL UNIQUE,
    pilot_name TEXT NOT NULL,
    method     TEXT NOT NULL CHECK (method IN ('roster','bio')),
    linked_at  INTEGER NOT NULL
  );

  CREATE TABLE pending_verifications (
    discord_id TEXT PRIMARY KEY,
    pilot_id   INTEGER NOT NULL,
    pilot_name TEXT NOT NULL,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE airlines (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    abbr    TEXT,
    name_lc TEXT NOT NULL,
    abbr_lc TEXT
  );
  CREATE INDEX idx_airlines_name ON airlines(name_lc);
  CREATE INDEX idx_airlines_abbr ON airlines(abbr_lc);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE guild_airlines (
    guild_id         TEXT NOT NULL,
    airline_id       INTEGER NOT NULL,
    name             TEXT NOT NULL,
    abbr             TEXT,
    channel_id       TEXT,
    board_message_id TEXT,
    PRIMARY KEY (guild_id, airline_id)
  );

  CREATE TABLE guild_settings (
    guild_id    TEXT PRIMARY KEY,
    max_active  INTEGER NOT NULL,
    hold_hours  INTEGER NOT NULL,
    exclusive   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE selections (
    guild_id     TEXT NOT NULL,
    discord_id   TEXT NOT NULL,
    airline_id   INTEGER NOT NULL,
    airline_name TEXT NOT NULL,
    airline_abbr TEXT,
    selected_at  INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_id)
  );

  CREATE TABLE reservations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id      TEXT NOT NULL,
    airline_id    INTEGER NOT NULL,
    airline_name  TEXT NOT NULL,
    airline_abbr  TEXT,
    discord_id    TEXT NOT NULL,
    pilot_id      INTEGER NOT NULL,
    pilot_name    TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('route','leg')),
    route_id      INTEGER,
    route_name    TEXT,
    dep           TEXT NOT NULL,
    arr           TEXT NOT NULL,
    dist_nm       INTEGER,
    aircraft      TEXT,
    note          TEXT,
    starts_at     INTEGER,
    window_start  INTEGER NOT NULL,
    window_end    INTEGER NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('reserved','in_progress','completed','cancelled','expired')),
    channel_id    TEXT,
    message_channel_id TEXT,
    message_id    TEXT,
    reminded      INTEGER NOT NULL DEFAULT 0,
    flight_id     INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    started_at    INTEGER,
    ended_at      INTEGER
  );
  CREATE INDEX idx_res_board  ON reservations(guild_id, airline_id, status);
  CREATE INDEX idx_res_pilot  ON reservations(guild_id, discord_id, status);
  CREATE INDEX idx_res_status ON reservations(status, window_end);
  `,

  /* v2: flights are now "jobs" shown on an admin-configured panel; pilots just click Reserve.
     The v1 pilot-linking and per-pilot reservation tables are no longer used. The airline
     directory (airlines, meta) is kept. */
  `
  DROP TABLE IF EXISTS reservations;
  DROP TABLE IF EXISTS selections;
  DROP TABLE IF EXISTS guild_settings;
  DROP TABLE IF EXISTS guild_airlines;
  DROP TABLE IF EXISTS pending_verifications;
  DROP TABLE IF EXISTS links;

  CREATE TABLE panels (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id          TEXT NOT NULL,
    airline_id        INTEGER NOT NULL,
    airline_name      TEXT NOT NULL,
    airline_abbr      TEXT,
    prefix            TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    message_ids       TEXT NOT NULL DEFAULT '[]',
    next_seq          INTEGER NOT NULL DEFAULT 1,
    last_refresh_at   INTEGER,
    last_refresh_error TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE (guild_id, airline_id)
  );

  CREATE TABLE jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id        INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    code            TEXT NOT NULL,
    source_key      TEXT NOT NULL,
    title           TEXT,
    aircraft        TEXT,
    available_from  INTEGER,
    deadline        INTEGER,
    pay             TEXT,
    notes           TEXT,
    status          TEXT NOT NULL CHECK (status IN ('open','expired','removed')),
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    UNIQUE (panel_id, code),
    UNIQUE (panel_id, source_key)
  );
  CREATE INDEX idx_jobs_panel_status ON jobs(panel_id, status);

  CREATE TABLE job_legs (
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    leg_no  INTEGER NOT NULL,
    dep     TEXT NOT NULL,
    arr     TEXT NOT NULL,
    PRIMARY KEY (job_id, leg_no)
  );

  CREATE TABLE leg_reservations (
    job_id       INTEGER NOT NULL,
    leg_no       INTEGER NOT NULL,
    discord_id   TEXT NOT NULL,
    username     TEXT NOT NULL,
    reserved_at  INTEGER NOT NULL,
    PRIMARY KEY (job_id, leg_no),
    FOREIGN KEY (job_id, leg_no) REFERENCES job_legs(job_id, leg_no) ON DELETE CASCADE
  );
  CREATE INDEX idx_leg_res_user ON leg_reservations(discord_id);

  CREATE TABLE dm_sessions (
    discord_id    TEXT PRIMARY KEY,
    panel_id      INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    step          TEXT NOT NULL CHECK (step IN ('await_code','await_mode','await_legs','await_confirm')),
    job_id        INTEGER,
    pending_legs  TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL
  );
  `,

  /* v3: admins must prove they belong to an airline before setting up its panel (FsHub pilot
     verified with a bio code), and a panel can require a Discord role to reserve. */
  `
  CREATE TABLE pilot_links (
    discord_id  TEXT PRIMARY KEY,
    pilot_id    INTEGER NOT NULL UNIQUE,
    pilot_name  TEXT NOT NULL,
    verified_at INTEGER NOT NULL
  );

  CREATE TABLE verify_pending (
    discord_id TEXT PRIMARY KEY,
    pilot_id   INTEGER NOT NULL,
    pilot_name TEXT NOT NULL,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  ALTER TABLE panels ADD COLUMN required_role_id TEXT;
  `,

  /* v4: a panel can read its flights from a Google Sheet the airline already keeps. The sheet may
     name who is flying a leg (a name, not a Discord account), and refreshes can leave a note about
     rows they had to skip. */
  `
  ALTER TABLE panels ADD COLUMN sheet_id TEXT;
  ALTER TABLE panels ADD COLUMN sheet_gid TEXT;
  ALTER TABLE panels ADD COLUMN last_refresh_note TEXT;
  ALTER TABLE job_legs ADD COLUMN sheet_holder TEXT;
  `,

  /* v5: a flight that still has no pilot 24 hours before it starts is announced in the panel's
     channel, once. 'reminded_at' remembers that it was; the panel chooses who is pinged. */
  `
  ALTER TABLE jobs ADD COLUMN reminded_at INTEGER;
  ALTER TABLE panels ADD COLUMN reminder_mode TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE panels ADD COLUMN reminder_role_id TEXT;
  `,

  /* v6: remember when a flight was completed (the airline's schedule says so), so the panel can
     show it as done for a day instead of letting it vanish. */
  `
  ALTER TABLE jobs ADD COLUMN completed_at INTEGER;
  `,

  /* v7: pilots can reserve, release and complete flights from Discord and have the airline's Google
     Sheet follow ("write-back"). 'writeback' lets an admin switch that off per panel; 'completed_by'
     is the Discord user who completed a flight here (null when the sheet said so); 'sheet_name' is
     the name written in the sheet for a reservation; pilot_names remembers what each pilot is
     called in the sheet. */
  `
  ALTER TABLE panels ADD COLUMN writeback INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE jobs ADD COLUMN completed_by TEXT;
  ALTER TABLE leg_reservations ADD COLUMN sheet_name TEXT;

  CREATE TABLE pilot_names (
    discord_id TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  /* v8: a small key/value table for bookkeeping that belongs to the install rather than to a panel
     (for example, which version of the slash commands each server was last given). */
  `
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* v9: the bot no longer talks to FsHub, so the airline list it cached and the proof that an admin
     belongs to an airline are gone. What stays is each pilot's FsHub pilot ID, which the pilot types in
     when they reserve a flight (it is shown next to their name so a manager can match them to the
     airline's roster). IDs that admins had already verified are kept as that pilot's ID. A panel's
     'airline_id' column (once the FsHub airline ID) is now just a number the bot hands out, one per
     panel in a server, and is never shown. The DM conversation gains a step that asks for the ID; those
     conversations only last ten minutes, so the table is simply remade. */
  `
  CREATE TABLE pilot_ids (
    discord_id TEXT PRIMARY KEY,
    fshub_id   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO pilot_ids(discord_id, fshub_id, updated_at) SELECT discord_id, pilot_id, verified_at FROM pilot_links;

  DROP TABLE pilot_links;
  DROP TABLE verify_pending;
  DROP TABLE airlines;
  DROP TABLE meta;

  DROP TABLE dm_sessions;
  CREATE TABLE dm_sessions (
    discord_id    TEXT PRIMARY KEY,
    panel_id      INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    step          TEXT NOT NULL CHECK (step IN ('await_pilot','await_code','await_mode','await_legs','await_confirm')),
    job_id        INTEGER,
    pending_legs  TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER NOT NULL
  );
  `,

  /* v10: a server can show the AeroDAQ in-game market on a board the bot keeps up to date. One per
     server: the channel it lives in, the message it is drawn in, and how the last refresh went. */
  `
  CREATE TABLE market_boards (
    guild_id        TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    message_ids     TEXT NOT NULL DEFAULT '[]',
    last_attempt_at INTEGER,
    last_ok_at      INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  `,

  /* v11: the "pilots needed" announcements are remembered so the bot can delete them at midnight (UTC)
     and keep the channel tidy. 'reminder_cleanup' lets an admin switch that off per panel. */
  `
  ALTER TABLE panels ADD COLUMN reminder_cleanup INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE reminder_messages (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    panel_id   INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    posted_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_reminder_messages_posted ON reminder_messages(posted_at);
  `,

  /* v12: an optional FsHub connection. A pilot's saved ID can now carry the name FsHub has for it
     ('fshub_name') and say where it came from ('source': 'typed' by the pilot, or 'roster' when it was
     read from the airline's FsHub roster, which lists each pilot's Discord ID). A panel can be linked
     to its airline's FsHub roster ('fshub_airline_id'); the bot reads that roster about once an hour
     and notes when it last tried and how it went. */
  `
  ALTER TABLE pilot_ids ADD COLUMN fshub_name TEXT;
  ALTER TABLE pilot_ids ADD COLUMN source TEXT NOT NULL DEFAULT 'typed';

  ALTER TABLE panels ADD COLUMN fshub_airline_id INTEGER;
  ALTER TABLE panels ADD COLUMN fshub_airline_name TEXT;
  ALTER TABLE panels ADD COLUMN fshub_synced_at INTEGER;
  ALTER TABLE panels ADD COLUMN fshub_note TEXT;
  `,

  /* v13: confirming flights against FsHub. A panel linked to its airline's FsHub roster also reads the
     airline's recent flights (landings), so a completed flight can show the aircraft that was actually
     flown and that FsHub saw it flown. The flights are kept for a few days in 'fshub_flights' (one row per
     panel and FsHub flight), 'fshub_flight_cursor' is how far through FsHub's list the bot has read, and
     'fshub_confirm' lets an admin switch the whole thing off per panel (existing linked panels start on). */
  `
  ALTER TABLE panels ADD COLUMN fshub_confirm INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE panels ADD COLUMN fshub_flight_cursor INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE panels ADD COLUMN fshub_flights_at INTEGER;
  ALTER TABLE panels ADD COLUMN fshub_flights_note TEXT;

  CREATE TABLE fshub_flights (
    panel_id        INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    flight_id       INTEGER NOT NULL,
    pilot_id        INTEGER NOT NULL,
    pilot_name      TEXT,
    dep             TEXT NOT NULL,
    arr             TEXT NOT NULL,
    departed_at     INTEGER,
    arrived_at      INTEGER NOT NULL,
    aircraft_icao   TEXT,
    aircraft_name   TEXT,
    schedule_status TEXT,
    PRIMARY KEY (panel_id, flight_id)
  );
  CREATE INDEX idx_fshub_flights_route ON fshub_flights(panel_id, dep, arr, arrived_at);
  `,

  /* v14: a flight a pilot completes with the Complete button on a panel linked to FsHub is completed
     because FsHub saw it flown. 'completed_via' remembers that ('fshub'), so a schedule sheet that has not
     been ticked (because the bot cannot write to it) does not quietly undo the completion a few minutes
     later, the way it does for a completion the pilot only claimed. */
  `
  ALTER TABLE jobs ADD COLUMN completed_via TEXT;
  `,

  /* v15: automatic completion. Once an hour the bot looks at the flights pilots hold on a FsHub-linked panel and
     completes the ones FsHub shows flown, without anyone pressing Complete. 'fshub_autocomplete' lets an admin
     switch that off per panel (existing linked panels start with it on); 'fshub_autocomplete_at' is when it
     last ran, so a restart does not make it run again at once. */
  `
  ALTER TABLE panels ADD COLUMN fshub_autocomplete INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE panels ADD COLUMN fshub_autocomplete_at INTEGER;
  `,

  /* v16: how many days ahead a panel lists flights. A schedule often runs for weeks, so the panel shows the flights
     that are open now or start within this many days (1 to 7); an admin chooses it per panel with /setup window.
     Existing panels get 7, which is what they were shown by default when the limit was introduced. */
  `
  ALTER TABLE panels ADD COLUMN show_days INTEGER NOT NULL DEFAULT 7;
  `,

  /* v17: a backup pilot. A pilot can put themselves down as the backup for a flight that is already taken, so there is
     someone ready if the pilot who has it can't fly it. One backup a flight; it goes if the flight does. */
  `
  CREATE TABLE job_backups (
    job_id      INTEGER PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    discord_id  TEXT NOT NULL,
    username    TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_job_backups_user ON job_backups(discord_id);
  `,

  /* v18: what a DM conversation is for. The Backup pilot button now asks for a flight ID in a DM just as Reserve does, so a
     conversation says whether it is to reserve a flight ('reserve') or to stand by for one ('backup'). Conversations
     already open carry on as reservations. */
  `
  ALTER TABLE dm_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'reserve';
  `,

  /* v19: reserved. A test build once added a table here for showing what flights pay from Aeroconomy contracts; that feature was
     dropped before release. The number stays so a database that test builds already moved to v19 still opens. */
  `
  SELECT 1;
  `,

  /* v20: clears away the table those test builds made (nothing else ever used it). */
  `
  DROP TABLE IF EXISTS panel_contracts;
  `,

  /* v21: two optional extras for a panel.
     - 'completed_channel_id': an admin can have the completed flights shown in a channel of their own, so the flights that
       can still be flown are not crowded by the ones already flown. Its messages are remembered like the panel's own.
     - 'panel_followers': a pilot can ask for the panel as a plain list in their DMs. The bot keeps that list up to date
       whenever the panel is redrawn, so it remembers the DM channel and the messages it posted there. */
  `
  ALTER TABLE panels ADD COLUMN completed_channel_id TEXT;
  ALTER TABLE panels ADD COLUMN completed_message_ids TEXT NOT NULL DEFAULT '[]';

  CREATE TABLE panel_followers (
    panel_id    INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    discord_id  TEXT NOT NULL,
    channel_id  TEXT NOT NULL,
    message_ids TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (panel_id, discord_id)
  );
  CREATE INDEX idx_panel_followers_user ON panel_followers(discord_id);
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema v${current} is newer than this bot supports (v${MIGRATIONS.length}). Update the bot.`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
