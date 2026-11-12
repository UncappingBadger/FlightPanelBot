import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { MIGRATIONS, openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { parsePilotId } from '../src/services/pilotId.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';

describe('database', () => {
  it('migrates a fresh file database and reopens it without error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aerobot-'));
    try {
      const path = join(dir, 'nested', 'bot.sqlite');
      const s1 = new Store(openDatabase(path));
      s1.setKv('hello', 'world');
      s1.close();
      const s2 = new Store(openDatabase(path));
      assert.equal(s2.getKv('hello'), 'world');
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('upgrading an install that still has FsHub data (schema v8 to v9)', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'aerobot-up-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** A database exactly as the previous version left it, with a live panel, a verified admin and an open DM conversation. */
    function buildV8(path: string): void {
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA foreign_keys = ON;');
      for (let v = 0; v < 8; v++) raw.exec(MIGRATIONS[v] as string);
      raw.exec('PRAGMA user_version = 8');
      raw.exec(`
        INSERT INTO panels(guild_id, airline_id, airline_name, airline_abbr, prefix, channel_id, created_at)
          VALUES ('g1', 12345, 'Old Air', 'OLD', 'OLD', 'c1', 1000);
        INSERT INTO jobs(panel_id, code, source_key, status, first_seen, last_seen) VALUES (1, 'OLD-001', 'k1', 'open', 1000, 1000);
        INSERT INTO job_legs(job_id, leg_no, dep, arr) VALUES (1, 1, 'EGLL', 'EGKK');
        INSERT INTO leg_reservations(job_id, leg_no, discord_id, username, reserved_at) VALUES (1, 1, 'u1', 'alice', 1000);
        INSERT INTO pilot_links(discord_id, pilot_id, pilot_name, verified_at) VALUES ('u1', 4821, 'Alice Anders', 1000);
        INSERT INTO verify_pending(discord_id, pilot_id, pilot_name, code, expires_at) VALUES ('u2', 9, 'Bob', 'AERO-ABCDEF', 99999999999999);
        INSERT INTO airlines(id, name, abbr, name_lc, abbr_lc) VALUES (12345, 'Old Air', 'OLD', 'old air', 'old');
        INSERT INTO meta(key, value) VALUES ('airline_directory_synced_at', '1');
        INSERT INTO dm_sessions(discord_id, panel_id, step, expires_at) VALUES ('u1', 1, 'await_code', 99999999999999);
      `);
      raw.close();
    }

    it('keeps the panel, its flights and reservations, and turns a verified admin into a saved pilot ID', () => {
      const path = join(dir, 'bot.sqlite');
      buildV8(path);
      const store = new Store(openDatabase(path));
      try {
        const panel = store.listPanels('g1')[0]!;
        assert.deepEqual([panel.airlineName, panel.airlineAbbr, panel.prefix], ['Old Air', 'OLD', 'OLD']);
        const view = store.listOpenJobViews(panel.id)[0]!;
        assert.equal(view.job.code, 'OLD-001');
        assert.equal(view.legs[0]!.holder?.discordId, 'u1');
        assert.equal(store.getPilotId('u1'), 4821, 'the ID the admin verified is now their pilot ID');
        assert.equal(view.legs[0]!.holder?.fshubId, 4821, 'and shows beside their reservation');
        assert.equal(store.getPilotId('u2'), null, 'an unfinished verification becomes nothing');
      } finally {
        store.close();
      }
    });

    it('drops the FsHub tables and lets the DM conversation ask for a pilot ID', () => {
      const path = join(dir, 'bot.sqlite');
      buildV8(path);
      const db = openDatabase(path);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name);
      for (const gone of ['pilot_links', 'verify_pending', 'airlines', 'meta']) assert.ok(!tables.includes(gone), `${gone} should be gone`);
      assert.ok(tables.includes('pilot_ids'));
      const store = new Store(db);
      try {
        assert.equal(store.getSession('u1', 1), null, 'in-flight conversations (ten minutes long) are simply dropped');
        store.upsertSession({ discordId: 'u1', panelId: 1, step: 'await_pilot', expiresAt: 99999999999999 });
        assert.equal(store.getSession('u1', 1)!.step, 'await_pilot');
        assert.equal(store.listPanels('g1').length, 1, 'remaking the conversation table did not take the panel with it');
      } finally {
        store.close();
      }
    });

    it('hands new panels in that server a fresh number rather than clashing with the old FsHub ID', () => {
      const path = join(dir, 'bot.sqlite');
      buildV8(path);
      const store = new Store(openDatabase(path));
      try {
        const added = store.createPanel({ guildId: 'g1', name: 'New Air', prefix: 'NEW', channelId: 'c2', now: 2000 });
        const other = store.createPanel({ guildId: 'g2', name: 'Elsewhere', prefix: 'ELS', channelId: 'c3', now: 2000 });
        assert.equal(store.listPanels('g1').length, 2);
        assert.equal(added.airlineAbbr, null);
        assert.ok(other.id > added.id);
      } finally {
        store.close();
      }
    });
  });
});

describe('panels are named by hand', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('finds a panel by its name whatever the capitals, within one server', () => {
    assert.equal(h.store.getPanelByName(GUILD, 'test air')?.id, h.panel.id);
    assert.equal(h.store.getPanelByName(GUILD, '  TEST AIR ')?.id, h.panel.id);
    assert.equal(h.store.getPanelByName(GUILD, 'Test'), null);
    assert.equal(h.store.getPanelByName('another-server', 'Test Air'), null);
  });

  it('lets two servers use the same name, and one server several airlines', () => {
    const other = h.store.createPanel({ guildId: 'g2', name: 'Test Air', prefix: 'TST', channelId: CHANNEL, now: T0 });
    const second = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: CHANNEL, now: T0 });
    assert.notEqual(other.id, h.panel.id);
    assert.equal(h.store.listPanels(GUILD).length, 2);
    assert.equal(second.airlineAbbr, null);
  });
});

describe('FsHub pilot IDs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'EGLL-EGCC-EGPH', { deadline: T0 + 40 * HOUR })]);
  });
  afterEach(() => h.close());

  it('remembers the ID a person gives and replaces it when they give another', () => {
    assert.equal(h.store.getPilotId(USER_A.discordId), null);
    h.store.setPilotId(USER_A.discordId, 1234, T0);
    assert.equal(h.store.getPilotId(USER_A.discordId), 1234);
    h.store.setPilotId(USER_A.discordId, 99, T0 + 1);
    assert.equal(h.store.getPilotId(USER_A.discordId), 99);
    assert.equal(h.store.getPilotId(USER_B.discordId), null, 'it belongs to that Discord account only');
  });

  it('is shown beside whoever holds a leg, and absent for someone who has not given one', () => {
    h.store.setPilotId(USER_A.discordId, 1234, T0);
    const open = h.jobs.open(h.panel.id);
    h.jobs.reserve(open[0]!.job.id, [1], USER_A);
    h.jobs.reserve(open[1]!.job.id, [1], USER_B);
    const views = h.jobs.open(h.panel.id);
    assert.equal(views[0]!.legs[0]!.holder?.fshubId, 1234);
    assert.equal(views[1]!.legs[0]!.holder?.fshubId, null);
    assert.equal(h.store.getHolder(open[0]!.job.id, 1)?.fshubId, 1234);
  });

  it('a later change is picked up by reservations already made', () => {
    const job = h.jobs.open(h.panel.id)[0]!.job;
    h.jobs.reserve(job.id, [1], USER_A);
    assert.equal(h.store.getHolder(job.id, 1)?.fshubId, null);
    h.store.setPilotId(USER_A.discordId, 555, T0);
    assert.equal(h.store.getHolder(job.id, 1)?.fshubId, 555);
  });

  it('lists the panels where a person holds something, so they can be redrawn', () => {
    const second = h.store.createPanel({ guildId: GUILD, name: 'Other Air', prefix: 'OTH', channelId: CHANNEL, now: T0 });
    h.jobs.sync(second.id, [sj('z', 'EGLL-EGKK')]);
    assert.deepEqual(h.store.listPanelIdsHeldBy(USER_A.discordId), []);
    h.jobs.reserve(h.jobs.open(h.panel.id)[0]!.job.id, [1], USER_A);
    h.jobs.reserve(h.jobs.open(second.id)[0]!.job.id, [1], USER_A);
    assert.deepEqual(h.store.listPanelIdsHeldBy(USER_A.discordId).sort(), [h.panel.id, second.id].sort());
    assert.deepEqual(h.store.listPanelIdsHeldBy(USER_B.discordId), []);
  });

  describe('parsePilotId', () => {
    it('reads a number, a number with #, or a profile link', () => {
      assert.equal(parsePilotId('1234'), 1234);
      assert.equal(parsePilotId('  #1234 '), 1234);
      assert.equal(parsePilotId('https://fshub.io/pilot/1234/overview'), 1234);
      assert.equal(parsePilotId('fshub.io/pilot/77'), 77);
      assert.equal(parsePilotId('https://www.fshub.io/pilot/9?tab=flights'), 9);
    });

    it('refuses anything else, including zero, huge numbers and other sites', () => {
      for (const bad of ['', 'Alice', '0', '-5', '12.5', '1234567890', 'https://evil.example/pilot/1234', 'https://fshub.io/airline/1234', 'DMO-001', '12 34']) {
        assert.equal(parsePilotId(bad), null, bad);
      }
    });
  });
});

describe('loadConfig', () => {
  const base = { DISCORD_TOKEN: 'tok', DISCORD_CLIENT_ID: '123' };

  it('applies defaults and trims blanks', () => {
    const c = loadConfig({ ...base, DISCORD_GUILD_ID: '   ' });
    assert.equal(c.discordGuildId, undefined);
    assert.equal(c.databasePath, 'data/bot.sqlite');
  });

  it('needs no FsHub setting, and ignores any left in an old .env', () => {
    const c = loadConfig({ ...base, FSHUB_TOKEN: 'old', FSHUB_BASE_URL: 'https://fshub.io/api/v3' });
    assert.ok(!('fshubToken' in c));
    assert.equal(c.discordToken, 'tok');
  });

  it('lists every problem at once and never echoes secret values', () => {
    assert.throws(
      () => loadConfig({ DISCORD_TOKEN: 'super-secret', LOG_LEVEL: 'loud' }),
      (e: Error) => {
        assert.match(e.message, /DISCORD_CLIENT_ID/);
        assert.match(e.message, /LOG_LEVEL/);
        assert.ok(!e.message.includes('super-secret'));
        return true;
      },
    );
  });
});
