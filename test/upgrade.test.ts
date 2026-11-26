import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS, openDatabase } from '../src/db/db.js';
import { Store } from '../src/db/store.js';
import { AirlineSettings } from '../src/services/airlineSettings.js';
import { pilotPay } from '../src/services/pilotPay.js';
import { fineFor, readLanding } from '../src/services/safetyPay.js';

/** The step that gave panels their own landing limits (the last one before it is what 0.4.1 ran with). */
const STEP = MIGRATIONS.findIndex((m) => m.includes('safety_warn_fpm'));
const SINCE = 1_700_000_000_000;

/** What 0.4.1 did with a landing, written out: a warning from 375, an 8% share from 400, a 5% share from 600, each with its own percentage of the minimum lost. */
function oldRule(rate: number, loss2: number, loss3: number): { share: number; loss: number } | 'warning' | null {
  const fpm = Math.abs(rate);
  if (fpm < 375) return null;
  if (fpm < 400) return 'warning';
  if (fpm < 600) return { share: 8, loss: loss2 };
  return { share: 5, loss: loss3 };
}

describe('a bot that was running the version before this one', () => {
  let dir: string;
  let file: string;

  /** A database as 0.4.1 left it: the schema before the limits, with these airlines (name, on since, % lost after the second and third tier, deductions). */
  const makeOld = (airlines: Array<[string, number | null, number, number, number]>) => {
    const raw = new DatabaseSync(file);
    for (let v = 0; v < STEP; v++) raw.exec(MIGRATIONS[v] as string);
    raw.exec(`PRAGMA user_version = ${STEP}`);
    const add = raw.prepare(`INSERT INTO panels(guild_id, airline_id, airline_name, prefix, channel_id, created_at, safety_pay_since, safety_loss_tier2, safety_loss_tier3, safety_deductions) VALUES ('g', ?, ?, ?, 'c', 1, ?, ?, ?, ?)`);
    airlines.forEach(([name, since, l2, l3, ded], i) => add.run(i + 1, name, name.slice(0, 3).toUpperCase(), since, l2, l3, ded));
    raw.close();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-upgrade-'));
    file = join(dir, 'data', 'bot.sqlite');
    mkdirSync(join(dir, 'data'), { recursive: true }); // the data folder, as the host makes it
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('upgrades with the settings it had: safety pay on keeps its day, its percentages and deductions, and the limits it was judged by', () => {
    makeOld([['Alpha', SINCE, 10, 40, 1], ['Bravo', SINCE, 0, 0, 0], ['Charlie', SINCE, 100, 100, 1]]);
    const store = new Store(openDatabase(file));
    const rows = store.listAllPanels().map((p) => [p.airlineName, p.safetyPaySince, p.safetyLossTier1, p.safetyLossTier2, p.safetyDeductions, p.safetyShareTier1, p.safetyShareTier2, p.safetyWarnFpm, p.safetyTier1Fpm, p.safetyTier2Fpm]);
    assert.deepEqual(rows, [
      ['Alpha', SINCE, 10, 40, true, 8, 5, 375, 400, 600],
      ['Bravo', SINCE, 0, 0, false, 8, 5, 375, 400, 600],
      ['Charlie', SINCE, 100, 100, true, 8, 5, 375, 400, 600],
    ]);
    store.close();
  });

  it('upgrades an airline with safety pay off: its percentages and deductions setting are kept, and it starts at 400, 500 and 600 when it is turned on', () => {
    makeOld([['Delta', null, 25, 50, 1], ['Echo', null, 0, 0, 0]]);
    const store = new Store(openDatabase(file));
    const rows = store.listAllPanels().map((p) => [p.airlineName, p.safetyPaySince, p.safetyLossTier1, p.safetyLossTier2, p.safetyDeductions, p.safetyWarnFpm, p.safetyTier1Fpm, p.safetyTier2Fpm]);
    assert.deepEqual(rows, [['Delta', null, 25, 50, true, 400, 500, 600], ['Echo', null, 0, 0, false, 400, 500, 600]]);
    store.close();
  });

  it('judges every landing and works out every pay exactly as the version before did, for an airline that already had safety pay on', () => {
    makeOld([['Alpha', SINCE, 10, 40, 1], ['Bravo', SINCE, 0, 0, 0], ['Charlie', SINCE, 100, 100, 1], ['Delta', SINCE, 25, 75, 0]]);
    const store = new Store(openDatabase(file));
    let compared = 0;
    const losses: Record<string, [number, number]> = { Alpha: [10, 40], Bravo: [0, 0], Charlie: [100, 100], Delta: [25, 75] };
    for (const p of store.listAllPanels()) {
      const [l2, l3] = losses[p.airlineName] as [number, number];
      const policy = store.safetyPolicy(p)!;
      const limits = { warn: p.safetyWarnFpm, tier1: p.safetyTier1Fpm, tier2: p.safetyTier2Fpm };
      for (let rate = -50; rate >= -900; rate--) {
        const want = oldRule(rate, l2, l3);
        const landing = readLanding(rate, limits);
        const fine = fineFor(landing, SINCE + 1, policy, 'A320');
        if (want === null || want === 'warning') {
          assert.equal(fine, null, `${p.airlineName} ${rate}: no fine`);
          assert.equal(landing.kind === 'ok' && landing.tier === (want === 'warning' ? 'warning' : null), true, `${p.airlineName} ${rate}: ${want === 'warning' ? 'a warning' : 'nothing'}`);
          continue;
        }
        assert.ok(fine, `${p.airlineName} ${rate}: a fine`);
        assert.deepEqual([fine.share, fine.minimumLoss], [want.share, want.loss], `${p.airlineName} ${rate}`);
        // a landing from before safety pay was turned on is never fined, as before
        assert.equal(fineFor(landing, SINCE - 1, policy, 'A320'), null);
        for (const [profit, nm] of [[-5000, 1200], [500, 0], [3000, 800], [54489, 900], [100000, 500]] as Array<[number, number]>) {
          const pay: { amount: number } = pilotPay(profit, nm, fine)!;
          const kept: number = 100 - want.loss;
          const lost = profit <= 0;
          const expected: number = lost ? Math.ceil((pilotPay(profit, nm)!.amount * kept) / 100) : Math.max(Math.ceil((profit * want.share) / 100), Math.ceil((2000 * kept) / 100));
          assert.equal(pay.amount, expected, `${p.airlineName} ${rate} profit ${profit}`);
          compared++;
        }
      }
    }
    assert.ok(compared > 3000);
    store.close();
  });

  it('shows the upgraded airline on the settings page as it was, with no limits of its own yet', () => {
    makeOld([['Alpha', SINCE, 10, 40, 1]]);
    const store = new Store(openDatabase(file));
    const view = new AirlineSettings({ store, profits: null, fshub: true, now: () => SINCE + 5 }).safety(store.listAllPanels()[0]!.id);
    assert.deepEqual([view.on, view.since, view.lossTier1, view.lossTier2, view.shareTier1, view.shareTier2, view.deductions, view.defaults, view.ownCount], [true, SINCE, 10, 40, 8, 5, true, { warn: 375, tier1: 400, tier2: 600 }, 0]);
    store.close();
  });

  it('keeps everything else in the file: other tables and panel settings are not touched by the upgrade', () => {
    makeOld([['Alpha', SINCE, 10, 40, 1]]);
    const raw = new DatabaseSync(file);
    raw.exec(`UPDATE panels SET show_days = 3, layout = 'grid', fshub_airline_id = 4242, sheet_id = 'abc'`);
    raw.exec(`INSERT INTO kv(key, value) VALUES ('keep-me', '1')`);
    const before = raw.prepare('SELECT count(*) AS c FROM jobs').get() as { c: number };
    raw.close();
    const store = new Store(openDatabase(file));
    const p = store.listAllPanels()[0]!;
    assert.deepEqual([p.showDays, p.layout, p.fshubAirlineId, p.sheetId], [3, 'grid', 4242, 'abc']);
    assert.equal(store.getKv('keep-me'), '1');
    store.close();
    const after = new DatabaseSync(file);
    assert.equal((after.prepare('SELECT count(*) AS c FROM jobs').get() as { c: number }).c, before.c);
    after.close();
  });

  describe('a copy of the database as it was', () => {
    const backup = () => join(dir, 'data', 'backups', `before-upgrade-from-v${STEP}`, 'bot.sqlite');

    it('is kept before the upgrade, with the old schema and the old values, and the upgraded file has the new ones', () => {
      makeOld([['Alpha', SINCE, 10, 40, 1]]);
      openDatabase(file).close();
      assert.ok(existsSync(backup()), 'the copy is there');
      const old = new DatabaseSync(backup(), { readOnly: true });
      assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, STEP);
      assert.deepEqual(old.prepare('SELECT safety_loss_tier2 AS a, safety_loss_tier3 AS b FROM panels').all().map((r) => [r.a, r.b]), [[10, 40]]);
      assert.equal((old.prepare("SELECT count(*) AS c FROM pragma_table_info('panels') WHERE name = 'safety_warn_fpm'").get() as { c: number }).c, 0, 'the copy is from before the limits existed');
      old.close();
      const now = new DatabaseSync(file, { readOnly: true });
      assert.equal((now.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
      now.close();
    });

    it('is not replaced by a later start, and is not made when there is nothing to upgrade', () => {
      makeOld([['Alpha', SINCE, 10, 40, 1]]);
      openDatabase(file).close();
      const first = readdirSync(join(dir, 'data', 'backups'));
      openDatabase(file).close();
      assert.deepEqual(readdirSync(join(dir, 'data', 'backups')), first, 'a database that is up to date makes no copy');
      const fresh = join(dir, 'fresh', 'bot.sqlite');
      openDatabase(fresh).close();
      assert.equal(existsSync(join(dir, 'fresh', 'backups')), false, 'a new database has nothing to keep');
      openDatabase(':memory:').close();
    });
  });
});
