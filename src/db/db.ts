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

  /* v22: roles an admin lets run `/setup refresh` (and nothing else from /setup). Per server. */
  `
  CREATE TABLE refresh_roles (
    guild_id   TEXT NOT NULL,
    role_id    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, role_id)
  );
  `,

  /* v23: a person's own settings. 'hide_unavailable': hide the flights that are no longer available to them (taken by others,
     and completed ones) from their list view and their searches. It is theirs alone; nothing shared changes. */
  `
  CREATE TABLE user_prefs (
    discord_id       TEXT PRIMARY KEY,
    hide_unavailable INTEGER NOT NULL DEFAULT 0,
    updated_at       INTEGER NOT NULL
  );
  `,

  /* v24: the late-departure warning. A panel's setting (minutes before the latest take-off that a pilot is warned; 0 is off), the
     flight times learned from the airline's own FsHub flights (kept long after the flights themselves are forgotten), the airports'
     positions (for a distance when no flight of that route has been seen), and who has been warned about which flight. */
  `
  ALTER TABLE panels ADD COLUMN depart_warning_minutes INTEGER NOT NULL DEFAULT 30;

  CREATE TABLE route_times (
    panel_id      INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    flight_id     INTEGER NOT NULL,
    dep           TEXT NOT NULL,
    arr           TEXT NOT NULL,
    aircraft_icao TEXT,
    minutes       INTEGER NOT NULL,
    arrived_at    INTEGER NOT NULL,
    PRIMARY KEY (panel_id, flight_id)
  );
  CREATE INDEX idx_route_times_route ON route_times(panel_id, dep, arr, arrived_at);

  CREATE TABLE airport_coords (
    code TEXT PRIMARY KEY,
    lat  REAL NOT NULL,
    lon  REAL NOT NULL,
    name TEXT
  );

  CREATE TABLE departure_warnings (
    job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    discord_id TEXT NOT NULL,
    sent_at    INTEGER NOT NULL,
    PRIMARY KEY (job_id, discord_id)
  );
  `,

  /* v25: whether a panel follows its pilots' flights live (FsHub's public live feed), so a late-departure warning knows who is already
     flying and a flight is completed (checked against FsHub's own record) soon after it lands. Nothing about it is stored: only the switch. */
  `
  ALTER TABLE panels ADD COLUMN live_tracking INTEGER NOT NULL DEFAULT 1;
  `,

  /* v26: how a panel is drawn: 'cards' (a card for each flight, the original look and still the default) or 'grid' (a button for each flight). */
  `
  ALTER TABLE panels ADD COLUMN layout TEXT NOT NULL DEFAULT 'cards';
  `,

  /* v27: the order of the day and the month in the short dates on a grid panel's buttons: 'dmy' (16/11/26, UK and Europe) or 'mdy' (11/16/26, US). */
  `
  ALTER TABLE panels ADD COLUMN grid_dates TEXT NOT NULL DEFAULT 'dmy';
  `,

  /* v28: which of the bot's optional private messages a person wants. Both start on, as they always were: 'notify_completed' (the bot
     marked a flight of theirs completed from FsHub) and 'notify_takeoff' (the late-departure warning, as a pilot or as a backup). Messages
     about what they have reserved, released or stand by for are not optional and are not here. */
  `
  ALTER TABLE user_prefs ADD COLUMN notify_completed INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE user_prefs ADD COLUMN notify_takeoff INTEGER NOT NULL DEFAULT 1;
  `,

  /* v29: a light-hearted message after a very hard landing. 'landing_rate' is the rate FsHub recorded for a flight (feet per minute,
     negative for a descent; null when FsHub gave none). 'landing_remarks' is every flight the bot has dealt with, so none is
     remarked on twice: 'told' is 1 when a message went out and 0 when it was held back (too soon after another one, or the person
     has switched them off). 'notify_landing' is the person's own switch, on until they say otherwise. */
  `
  ALTER TABLE fshub_flights ADD COLUMN landing_rate INTEGER;

  CREATE TABLE landing_remarks (
    flight_id  INTEGER PRIMARY KEY,
    discord_id TEXT NOT NULL,
    rate       INTEGER NOT NULL,
    told       INTEGER NOT NULL,
    handled_at INTEGER NOT NULL
  );
  CREATE INDEX idx_landing_remarks_pilot ON landing_remarks(discord_id, handled_at);

  ALTER TABLE user_prefs ADD COLUMN notify_landing INTEGER NOT NULL DEFAULT 1;
  `,

  /* v30: the "pilots needed" announcement became a single list at midnight UTC of the flights that start that day and have no pilot (it used to
     be one announcement per flight, 24 hours before it starts, which meant several a day). 'reminded_day' is the UTC day (days since 1970-01-01) the
     panel was last dealt with, so a restart does not repeat the list. It starts empty: the first pass over a panel counts that day as done without
     posting. The older 'reminded_at' column of a flight is no longer used. */
  `
  ALTER TABLE panels ADD COLUMN reminded_day INTEGER;
  `,

  /* v31: whether a panel takes Aeroconomy's own flight numbers as its flights' IDs (read from Aeroconomy's public contracts, for a panel
     linked to its airline's FsHub number). Off until an admin turns it on, since it changes the IDs people know. */
  `
  ALTER TABLE panels ADD COLUMN flight_numbers INTEGER NOT NULL DEFAULT 0;
  `,

  /* v32: the distance of a flight in nautical miles, from the sheet's Distance column (or worked out from the airports when that cell is blank),
     shown in small type under the route on the flight's card. Empty when the sheet has no such column. */
  `
  ALTER TABLE jobs ADD COLUMN distance_nm REAL;
  `,

  /* v33: where the preview of "/setup profit action:fill" is shown, and who may press its Write button. 'profit_send_to' is 'here' (only to the
     admin who asked, in the reply: the original behaviour and still the default), 'dm' (in that admin's DMs) or 'channel' (in 'profit_channel_id').
     'profit_role_id' is a role whose members may press Write besides the admin who asked; null means only that admin. */
  `
  ALTER TABLE panels ADD COLUMN profit_send_to TEXT NOT NULL DEFAULT 'here';
  ALTER TABLE panels ADD COLUMN profit_channel_id TEXT;
  ALTER TABLE panels ADD COLUMN profit_role_id TEXT;
  `,

  /* v34: paying pilots. 'payroll_settings' is what an admin set up for a panel (the account the pay comes out of, the tab of the sheet that lists the
     pilots' accounts, the first day that is ever paid, when each day's list is made). 'payroll_payments' is the ledger: one row for every payment the
     bot has begun, by its unique ID, which is never used twice; a row is 'sending' from just before the bank is asked until it says yes ('paid') or no
     ('failed'), and one left 'sending' is never retried by itself, since nobody knows whether the money moved. 'payroll_drafts' is a list of payments waiting
     for an admin to check it, kept in the database (as JSON) so that a restart does not lose it or the changes made to it. */
  `
  CREATE TABLE payroll_settings (
    panel_id        INTEGER PRIMARY KEY REFERENCES panels(id) ON DELETE CASCADE,
    enabled         INTEGER NOT NULL DEFAULT 0,
    source_account  TEXT,
    info_sheet_id   TEXT,
    info_gid        TEXT,
    start_day       INTEGER,
    run_at_minute   INTEGER NOT NULL DEFAULT 720,
    owner_id        TEXT,
    last_run_day    INTEGER
  );

  CREATE TABLE payroll_payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    panel_id    INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    unique_id   TEXT NOT NULL,
    source_key  TEXT,
    pilot       TEXT NOT NULL,
    fshub_id    INTEGER,
    account     TEXT NOT NULL,
    cents       INTEGER NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('sending','paid','failed')),
    detail      TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (panel_id, unique_id)
  );
  CREATE INDEX idx_payroll_payments_key ON payroll_payments(panel_id, source_key);

  CREATE TABLE payroll_drafts (
    token       TEXT PRIMARY KEY,
    panel_id    INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    asker_id    TEXT NOT NULL,
    place       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,

  /* v35: 'pay_writes' remembers each Pilot Pay cell this bot wrote into a sheet (by the flight's key), so that a pay someone later sets back to $0 on
     purpose is recognised as theirs and left alone, where a $0 the bot never wrote (a money-formatted empty cell) is free to be written over. */
  `
  CREATE TABLE pay_writes (
    panel_id    INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    source_key  TEXT NOT NULL,
    cents       INTEGER NOT NULL,
    written_at  INTEGER NOT NULL,
    PRIMARY KEY (panel_id, source_key)
  );
  `,

  /* v36: the name this bot wrote into a flight's *Backup Pilot* cell for its backup pilot, so it can be taken off again (only if it is still that
     name) when they stand down, rename themselves, or their spot ends. Null where nothing was written (no such column, several legs, or writing off). */
  `
  ALTER TABLE job_backups ADD COLUMN sheet_name TEXT;
  `,

  /* v37: a server can show a weather board (METARs for a few chosen airports, then for the airports of the flights in the next 24 hours) in one channel,
     kept up to date. One per server: its channel, its messages, the airports shown at the top (empty: the built-in list), and how the last refresh went. */
  `
  CREATE TABLE weather_boards (
    guild_id        TEXT PRIMARY KEY,
    channel_id      TEXT NOT NULL,
    message_ids     TEXT NOT NULL DEFAULT '[]',
    airports        TEXT NOT NULL DEFAULT '',
    last_attempt_at INTEGER,
    last_ok_at      INTEGER,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  `,

  /* v38: two private-message features. 'banking_links' is a pilot's link to their Aeroconomy bank accounts (`/banking` in a DM): where the conversation
     stands, their API token SEALED (AES-GCM, key in a file beside the database; null until they send it, and gone the moment they turn it off), the accounts
     last offered to them, and when it is next due to be looked at. 'banking_accounts' are the accounts they chose, with the newest payment already told.
     'flight_monitors' are the flights people asked to be told about (`/monitor`): told within ten minutes of landing, and on landing. */
  `
  CREATE TABLE banking_links (
    discord_id    TEXT PRIMARY KEY,
    step          TEXT NOT NULL CHECK (step IN ('await_token','choose','active')),
    token_sealed  TEXT,
    offered       TEXT NOT NULL DEFAULT '[]',
    attempts      INTEGER NOT NULL DEFAULT 0,
    expires_at    INTEGER,
    created_at    INTEGER NOT NULL,
    next_poll_at  INTEGER,
    last_ok_at    INTEGER
  );
  CREATE TABLE banking_accounts (
    discord_id      TEXT NOT NULL REFERENCES banking_links(discord_id) ON DELETE CASCADE,
    account_number  TEXT NOT NULL,
    name            TEXT NOT NULL,
    kind            TEXT,
    last_tx_id      INTEGER,
    PRIMARY KEY (discord_id, account_number)
  );
  CREATE TABLE flight_monitors (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id    TEXT NOT NULL,
    flight_no     TEXT NOT NULL,
    airline       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    state         TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting','airborne')),
    near_sent     INTEGER NOT NULL DEFAULT 0,
    dep           TEXT,
    arr           TEXT,
    last_seen_at  INTEGER,
    misses        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (discord_id, flight_no)
  );
  `,

  /* v39: a pilot who sends a flight ID straight to the bot (no Reserve button first) and has not yet given their FsHub pilot ID is asked
     for it first; what they sent is kept here so it is carried out as soon as they have answered. */
  `
  ALTER TABLE dm_sessions ADD COLUMN pending_text TEXT;
  `,

  /* v40: landing safety pay (`/setup safety-pay`). 'safety_pay_since' is when an airline turned it on (a flight that landed before that is paid as it always
     was); NULL means it is off. 'safety_loss_tier2' and 'safety_loss_tier3' are the percentage of the $2,000 minimum pay a pilot loses after a Tier 2 and a Tier 3 landing (0: none); an airline that
     wants one percentage for both tiers just has them equal.
     'safety_landings' remembers, per flight, which of the three things a penalty landing causes have been done (the pilot told, the CSV row written, the
     managers told), so none is done twice. 'safety_doubts' remembers which flights managers have already been told were left unfilled for want of a landing rate. */
  `
  ALTER TABLE panels ADD COLUMN safety_pay_since INTEGER;
  ALTER TABLE panels ADD COLUMN safety_loss_tier2 INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE panels ADD COLUMN safety_loss_tier3 INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE safety_landings (
    panel_id   INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    flight_id  INTEGER NOT NULL,
    told       INTEGER NOT NULL DEFAULT 0,
    logged     INTEGER NOT NULL DEFAULT 0,
    reported   INTEGER NOT NULL DEFAULT 0,
    handled_at INTEGER NOT NULL,
    PRIMARY KEY (panel_id, flight_id)
  );

  CREATE TABLE safety_doubts (
    panel_id   INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    noted_at   INTEGER NOT NULL,
    PRIMARY KEY (panel_id, source_key)
  );
  `,

  /* v41: 'safety_deductions' is whether `/setup profit` also writes what a hard landing took off a pilot's pay (what the flight would have paid, less what it
     pays) into the sheet's Safety Deductions column, beside the Pilot Pay it writes. Off by default. */
  `
  ALTER TABLE panels ADD COLUMN safety_deductions INTEGER NOT NULL DEFAULT 0;
  `,

  /* v42: landing safety limits by aircraft, and the whole of the rule an airline's own. The tiers are now called Warning, Tier 1 and Tier 2 (they were Tier 1 for the
     warning, and Tier 2 and Tier 3 for the two pay cuts), so the old 'safety_loss_tier2' and 'safety_loss_tier3' (what a pilot loses of the minimum pay after the first and the
     second pay cut) are copied to 'safety_loss_t1' and 'safety_loss_t2' and no longer read. 'safety_warn_fpm', 'safety_tier1_fpm' and 'safety_tier2_fpm' are the airline's
     default limits (feet per minute, a landing at least that hard): a panel that already had safety pay on keeps what it had (375, 400 and 600), a new one starts at
     400, 500 and 600. 'safety_share_tier1' and 'safety_share_tier2' are the percentage of a flight's profit a pilot is paid after each pay cut (they were fixed at 8 and 5).
     'safety_limits' holds the limits an aircraft type has of its own (its ICAO code, upper case); a type with no row uses the airline's default. */
  `
  ALTER TABLE panels ADD COLUMN safety_warn_fpm INTEGER NOT NULL DEFAULT 400;
  ALTER TABLE panels ADD COLUMN safety_tier1_fpm INTEGER NOT NULL DEFAULT 500;
  ALTER TABLE panels ADD COLUMN safety_tier2_fpm INTEGER NOT NULL DEFAULT 600;
  ALTER TABLE panels ADD COLUMN safety_share_tier1 INTEGER NOT NULL DEFAULT 8;
  ALTER TABLE panels ADD COLUMN safety_share_tier2 INTEGER NOT NULL DEFAULT 5;
  ALTER TABLE panels ADD COLUMN safety_loss_t1 INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE panels ADD COLUMN safety_loss_t2 INTEGER NOT NULL DEFAULT 0;
  UPDATE panels SET safety_loss_t1 = safety_loss_tier2, safety_loss_t2 = safety_loss_tier3;
  UPDATE panels SET safety_warn_fpm = 375, safety_tier1_fpm = 400, safety_tier2_fpm = 600 WHERE safety_pay_since IS NOT NULL;

  CREATE TABLE safety_limits (
    panel_id   INTEGER NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
    aircraft   TEXT NOT NULL,
    warn_fpm   INTEGER NOT NULL,
    tier1_fpm  INTEGER NOT NULL,
    tier2_fpm  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (panel_id, aircraft)
  );
  `,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // A deleted row (a pilot's sealed token, once they turn payment messages off) is overwritten, not left in a freed page of the file.
  db.exec('PRAGMA secure_delete = ON;');
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
