import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import type { FsHubFlight } from '../src/fshub/client.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { HOUR, T0, USER_A, USER_B, USER_C, makeHarness, sj, type Harness } from './helpers.js';
import { FakeFsHub, FakeUser, fakeComponent, fakeDm, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up. The pilots, airlines and flights are not real. */

const AIRLINE_ID = 8123;
const NOW = T0 + 6 * HOUR;
const MIN = 60_000;
const { account, publicKey } = makeServiceAccount();

/* ------------------------------------------------------------------ the bot's side: who the flight is credited to */

describe('crediting a flight to its backup pilot when FsHub shows the backup flew it', () => {
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  let bob: FakeUser;
  let carol: FakeUser;
  let pid: number;
  let fid: number;

  /** A flight FsHub lists: by Bob (FsHub 1002), EGLL to EGKK, landed two hours ago, unless said otherwise. */
  const flown = (over: Partial<FsHubFlight> = {}): FsHubFlight => {
    const f: FsHubFlight = {
      id: ++fid,
      pilotId: 1002,
      pilotName: 'Bob Backup',
      dep: 'EGLL',
      arr: 'EGKK',
      departedAt: NOW - 3 * HOUR,
      arrivedAt: NOW - 2 * HOUR,
      aircraftIcao: 'A320',
      aircraftName: 'Airbus A320',
      scheduleStatus: 'ON-TIME',
      ...over,
    };
    fshub.flights.set(AIRLINE_ID, [...(fshub.flights.get(AIRLINE_ID) ?? []), f]);
    return f;
  };
  const windowed = (key: string, chain: string, over: Record<string, unknown> = {}) => sj(key, chain, { availableFrom: T0, deadline: T0 + 12 * HOUR, ...over });
  const jobId = (key: string) => h.store.listJobs(pid).find((j) => j.sourceKey === key)!.id;
  const job = (key: string) => h.store.getJob(jobId(key))!;
  const view = (key: string) => h.jobs.view(jobId(key))!;
  const panel = () => h.store.getPanel(pid)!;
  const hold = (key: string, user: FakeUser = alice, legs = [1]) => h.jobs.reserve(jobId(key), legs, { discordId: user.id, username: user.username });
  const standBy = (key: string, user: FakeUser = bob) => h.jobs.addBackup(jobId(key), { discordId: user.id, username: user.username });
  const holders = (key: string) => view(key).legs.map((l) => l.holder?.discordId ?? null);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    fid = 4_900_000;
    d = makeDiscordHarness(h, { fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    carol = d.client.user(new FakeUser(USER_C.discordId, USER_C.username));
    pid = h.panel.id;
    h.store.updatePanel(pid, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK', { aircraft: 'A320' }), windowed('t', 'EGKK-EGCC', { aircraft: 'B738' }), windowed('m', 'LFPG-EHAM-EDDF')]);
    await d.panels.refresh(pid);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  describe('what it credits', () => {
    it("completes the flight for the backup, in the pilot's place, when FsHub shows only the backup flew it", async () => {
      hold('s');
      standBy('s');
      flown();
      const [r] = await d.ctx.autoComplete!.run();
      assert.equal(r!.ok, true);
      assert.deepEqual(
        r!.completed.map((c) => [c.view.job.code, c.discordId, c.replaced?.discordId, c.sheetTicked]),
        [['TST-001', bob.id, alice.id, false]],
      );
      const j = job('s');
      assert.deepEqual([j.status, j.completedAt, j.completedBy, j.completedVia], ['expired', NOW, bob.id, 'fshub']);
      assert.deepEqual(holders('s'), [bob.id], "the backup is the flight's pilot now, and the other pilot no longer holds it");
      assert.equal(view('s').backup, null, 'and nobody is its backup any more');
      assert.equal(h.jobs.open(pid).some((v) => v.job.sourceKey === 's'), false);
      assert.deepEqual(h.jobs.mine(pid, alice.id), [], 'it is gone from the pilot\'s flights');
    });

    it('tells the backup it is theirs, and tells the pilot it was completed for their backup, pinging nobody', async () => {
      hold('s');
      standBy('s');
      flown();
      await d.ctx.autoComplete!.run();
      assert.equal(bob.dms.length, 1);
      assert.match(bob.lastText, /^FsHub shows you flew a flight for \*\*Test Air\*\*, so I marked it completed:/);
      assert.match(bob.lastText, /✅ \*\*TST-001\*\* \(EGLL → EGKK\): A320 \(Airbus A320\), landed <t:\d+:t> · on time · you were its backup, so it is yours now, in place of alice/);
      assert.deepEqual(bob.last.allowedMentions, { parse: [] });
      assert.equal(alice.dms.length, 1);
      assert.match(alice.lastText, new RegExp(`^FsHub shows <@${bob.id}>, who was down as backup for \\*\\*TST-001\\*\\* \\(EGLL → EGKK\\) with \\*\\*Test Air\\*\\*, flew it, and it doesn't show you flying it\\. I marked it completed for them, so it is no longer yours\\.\\nIf that is wrong`));
      assert.doesNotMatch(alice.lastText, /sheet/, 'there is no sheet here');
      assert.deepEqual(alice.last.allowedMentions, { parse: [] });
    });

    it('still tells the pilot when the backup has switched the completed messages off (it is about the pilot\'s own reservation)', async () => {
      h.store.setNotice(bob.id, 'completed', false, NOW);
      hold('s');
      standBy('s');
      flown();
      await d.ctx.autoComplete!.run();
      assert.equal(job('s').completedBy, bob.id, 'completed all the same');
      assert.equal(bob.dms.length, 0, 'the backup asked not to be told');
      assert.equal(alice.dms.length, 1, 'but the pilot always is');
    });

    it('still completes it when the pilot has their DMs closed', async () => {
      hold('s');
      standBy('s');
      flown();
      alice.failDms = true;
      const [r] = await d.ctx.autoComplete!.run();
      assert.equal(r!.completed.length, 1);
      assert.equal(job('s').completedBy, bob.id);
    });

    it("credits a flight of several legs only once FsHub has shown the backup flying every leg, and then takes every leg over", async () => {
      hold('m', alice, [1, 2]);
      standBy('m');
      flown({ dep: 'LFPG', arr: 'EHAM' });
      const partial = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual([partial.ok, partial.completed.length, partial.checked], [true, 0, 2], "one leg of two is not enough (the flight is looked at for the pilot, and again for the backup)");
      assert.deepEqual(holders('m'), [alice.id, alice.id]);
      assert.equal(alice.dms.length, 0);

      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      h.clock.now = NOW + 2 * MIN;
      const full = await d.ctx.autoComplete!.runPanel(panel());
      assert.equal(full.completed.length, 1);
      assert.deepEqual(holders('m'), [bob.id, bob.id]);
      assert.equal(job('m').completedBy, bob.id);
      assert.match(bob.lastText, /leg 1: A320 \(Airbus A320\), landed <t:\d+:t> · on time; leg 2: A320/);
    });

    it('credits a flight just past its deadline, when the landing was inside its window', async () => {
      hold('s');
      standBy('s');
      flown({ arrivedAt: T0 + 12 * HOUR + 10 * MIN, departedAt: T0 + 11 * HOUR });
      h.clock.now = T0 + 12 * HOUR + 30 * MIN;
      h.jobs.expireDue();
      assert.equal(job('s').status, 'expired');
      assert.equal(view('s').backup?.discordId, bob.id, 'the backup is still down for it');
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.equal(r.completed.length, 1);
      assert.equal(job('s').completedBy, bob.id);
    });

    it('has nothing more to do once it is done, and the backup is told once', async () => {
      hold('s');
      standBy('s');
      flown();
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 1);
      h.clock.now = NOW + 2 * MIN;
      const again = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual([again.ok, again.checked, again.completed.length], [true, 0, 0]);
      assert.equal(bob.dms.length, 1);
      assert.equal(alice.dms.length, 1);
    });

    it('looks only at the backup who has just landed when it is asked to look at one pilot', async () => {
      hold('s');
      standBy('s');
      flown();
      const other = await d.ctx.autoComplete!.runPanel(panel(), { only: new Set([carol.id]) });
      assert.deepEqual([other.checked, other.completed.length], [0, 0]);
      assert.equal(job('s').completedAt, null);
      const pilot = await d.ctx.autoComplete!.runPanel(panel(), { only: new Set([alice.id]) });
      assert.equal(pilot.completed.length, 0, 'the pilot who holds it is not the one who flew');
      const backup = await d.ctx.autoComplete!.runPanel(panel(), { only: new Set([bob.id]) });
      assert.deepEqual([backup.checked, backup.completed.map((c) => c.discordId)], [1, [bob.id]]);
    });
  });

  describe('what it leaves alone', () => {
    it('a flight the pilot flew, even when the backup flew it too: it is the pilot\'s', async () => {
      hold('s');
      standBy('s');
      flown({ pilotId: 1001, pilotName: 'Alice Pilot' });
      flown({ arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual(r.completed.map((c) => [c.discordId, c.replaced ?? null]), [[alice.id, null]]);
      assert.equal(job('s').completedBy, alice.id);
      assert.equal(bob.dms.length, 0);
    });

    it('a flight each of them flew a part of: left for an admin', async () => {
      hold('m', alice, [1, 2]);
      standBy('m');
      flown({ dep: 'LFPG', arr: 'EHAM', pilotId: 1001 });
      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.equal(r.completed.length, 0);
      assert.equal(job('m').completedAt, null);
      assert.deepEqual(holders('m'), [alice.id, alice.id]);
      assert.equal(view('m').backup?.discordId, bob.id, 'the backup is still down');
    });

    it('a flight nobody flew, and a flight a pilot who is not the backup flew', async () => {
      hold('s');
      standBy('s');
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
      flown({ pilotId: 1003, pilotName: 'Carol Other' });
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
      assert.equal(job('s').completedAt, null);
      assert.deepEqual(holders('s'), [alice.id]);
    });

    it("a flight with a backup when the backup flew a different route", async () => {
      hold('s');
      standBy('s');
      flown({ dep: 'EGKK', arr: 'EGLL' });
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
    });

    it('a flight whose window had not opened, and a landing outside its window', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), windowed('later', 'EGPH-EGLL', { availableFrom: NOW + 5 * HOUR, deadline: NOW + 20 * HOUR })]);
      hold('later');
      standBy('later');
      flown({ dep: 'EGPH', arr: 'EGLL' });
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
      hold('s');
      standBy('s');
      flown({ arrivedAt: T0 - 2 * HOUR, departedAt: T0 - 3 * HOUR });
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
    });

    it("a flight whose pilot's FsHub ID the bot does not know (it cannot say they did not fly it)", async () => {
      const dave = d.client.user(new FakeUser('555555555555555555', 'dave'));
      hold('s', dave);
      standBy('s');
      flown();
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [0, 0]);
      assert.equal(job('s').completedAt, null);
    });

    it("a backup whose FsHub ID the bot does not know", async () => {
      const dave = d.client.user(new FakeUser('555555555555555555', 'dave'));
      hold('s');
      standBy('s', dave);
      flown({ pilotId: 500 });
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual([r.checked, r.completed.length], [1, 0], 'only the pilot\'s own flight was looked at');
      assert.equal(job('s').completedAt, null);
    });

    it('a flight whose backup flew it for their own reservation: their own flight is theirs first, and the FsHub flight is not counted twice', async () => {
      h.jobs.sync(pid, [windowed('s', 'EGLL-EGKK'), windowed('s2', 'EGLL-EGKK')]);
      hold('s'); // alice's, backed up by bob
      standBy('s');
      hold('s2', bob); // bob's own, on the same route
      flown(); // bob flew once
      const r = await d.ctx.autoComplete!.runPanel(panel());
      assert.deepEqual(r.completed.map((c) => [c.view.job.sourceKey, c.discordId, c.replaced ?? null]), [['s2', bob.id, null]]);
      assert.deepEqual(holders('s'), [alice.id], 'his one flight was his own, so the one he stood by for is left');
    });

    it('a flight held by one pilot on one leg and another on the other', async () => {
      hold('m', alice, [1]);
      hold('m', carol, [2]);
      standBy('m');
      flown({ dep: 'LFPG', arr: 'EHAM' });
      flown({ dep: 'EHAM', arr: 'EDDF', arrivedAt: NOW - HOUR, departedAt: NOW - 2 * HOUR });
      assert.equal((await d.ctx.autoComplete!.runPanel(panel())).completed.length, 0);
      assert.equal(job('m').completedAt, null);
    });
  });
});

/* ------------------------------------------------------------------ the airline's sheet */

describe('crediting a backup pilot in the airline\'s sheet', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let fshub: FakeFsHub;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const SHEET_NOW = Date.UTC(2026, 10, 12, 20, 0); // the evening of the day TST-001 (EGLL-EGCC, 0600-2359z) is flown
  const K = 'EGLL-EGCC@2026-11-12';

  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const job = () => h.store.listJobs(pid()).find((j) => j.sourceKey === K)!;
  const view = () => h.jobs.view(job().id)!;
  const press = async (user: FakeUser, customId: string) => {
    const f = fakeComponent(user, customId, {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  /** Alice reserves TST-001 (the bot writes her into the Pilot cell) and Bob stands by for it (the bot writes him into the Backup Pilot cell). */
  const reserveAndStandBy = async () => {
    await press(alice, `panel:reserve:${pid()}`);
    await say(alice, 'TST-001');
    await press(bob, `panel:backup:${pid()}`);
    await say(bob, 'TST-001');
  };
  const bobFlew = (pilotId = 1002) =>
    fshub.flights.set(AIRLINE_ID, [
      { id: 4_900_001, pilotId, pilotName: 'Bob', dep: 'EGLL', arr: 'EGCC', departedAt: SHEET_NOW - 3 * HOUR, arrivedAt: SHEET_NOW - 2 * HOUR, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' },
    ]);

  const boot = async (withWriteback: boolean) => {
    h = await makeHarness();
    h.clock.now = SHEET_NOW;
    g = new FakeGoogle(publicKey);
    fshub = new FakeFsHub();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: withWriteback ? wb : null, fshub });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    bob = d.client.user(new FakeUser(USER_B.discordId, 'bob'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    syncFromSheet();
    await d.panels.refresh(pid());
  };
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it("puts the backup's name in the Pilot cell in place of the pilot's, ticks the box and takes the backup's name off the Backup Pilot cell, in one write", async () => {
    await boot(true);
    await reserveAndStandBy();
    assert.deepEqual([g.cell('E3'), g.cell('F3'), g.cell('H3')], ['alice', 'bob', 'FALSE']);
    bobFlew();
    const writes = g.writes.length;
    const [r] = await d.ctx.autoComplete!.run();
    assert.deepEqual(r!.completed.map((c) => [c.discordId, c.replaced?.discordId, c.sheetTicked]), [[bob.id, alice.id, true]]);
    assert.deepEqual([g.cell('E3'), g.cell('F3'), g.cell('H3')], ['bob', '', 'TRUE']);
    assert.equal(g.writes.length, writes + 1, 'all three cells in a single write');
    assert.deepEqual(g.writes.at(-1)!.data.map((x) => x.range.split('!')[1]).sort(), ['E3', 'F3', 'H3']);
    assert.equal(job().completedBy, bob.id);
    assert.deepEqual(view().legs.map((l) => [l.holder?.discordId, l.holder?.sheetName]), [[bob.id, 'bob']], 'and the bot remembers it wrote his name');
    assert.equal(view().backup, null);
    assert.match(bob.lastText, /· ticked in the airline's sheet · you were its backup, so it is yours now, in place of alice/);
    assert.match(alice.lastText, /The airline's sheet has their name against it now and the flight is ticked\./);
    // The next read of the sheet agrees with what was written: the flight is done, and it was bob who flew it.
    syncFromSheet();
    assert.notEqual(job().completedAt, null);
    assert.deepEqual(view().legs.map((l) => l.holder?.discordId), [bob.id]);
  });

  it("uses the name the backup has told the bot, in the Pilot cell", async () => {
    await boot(true);
    await say(bob, 'name Captain Bob');
    await reserveAndStandBy();
    assert.equal(g.cell('F3'), 'Captain Bob');
    bobFlew();
    await d.ctx.autoComplete!.run();
    assert.deepEqual([g.cell('E3'), g.cell('F3')], ['Captain Bob', '']);
  });

  it('leaves everything alone when the sheet names someone else as the pilot now, and tells nobody', async () => {
    await boot(true);
    await reserveAndStandBy();
    g.values[2]![4] = 'Sam'; // a manager changed the pilot after the last read
    bobFlew();
    const told = [alice.dms.length, bob.dms.length];
    const [r] = await d.ctx.autoComplete!.run();
    assert.equal(r!.completed.length, 0);
    assert.deepEqual([g.cell('E3'), g.cell('F3'), g.cell('H3')], ['Sam', 'bob', 'FALSE']);
    assert.equal(job().completedAt, null);
    assert.deepEqual(view().legs.map((l) => l.holder?.discordId), [alice.id], 'the pilot still holds it here');
    assert.equal(view().backup?.discordId, bob.id, 'and the backup is still down');
    assert.deepEqual([alice.dms.length, bob.dms.length], told);
  });

  it('leaves a flight the sheet already shows as completed or cancelled', async () => {
    await boot(true);
    await reserveAndStandBy();
    bobFlew();
    g.values[2]![7] = 'TRUE';
    assert.equal((await d.ctx.autoComplete!.run())[0]!.completed.length, 0);
    assert.deepEqual([g.cell('E3'), g.cell('F3')], ['alice', 'bob']);
    g.values[2]![7] = 'FALSE';
    g.values[2]![4] = 'CANCELLED';
    h.clock.now = SHEET_NOW + 2 * MIN;
    assert.equal((await d.ctx.autoComplete!.runPanel(h.store.getPanel(pid())!)).completed.length, 0);
    assert.equal(g.cell('E3'), 'CANCELLED');
  });

  it("does not touch a Backup Pilot cell that no longer holds the name the bot wrote, but still gives the flight to the backup", async () => {
    await boot(true);
    await reserveAndStandBy();
    g.values[2]![5] = 'Somebody Else';
    bobFlew();
    const [r] = await d.ctx.autoComplete!.run();
    assert.equal(r!.completed.length, 1);
    assert.deepEqual([g.cell('E3'), g.cell('F3'), g.cell('H3')], ['bob', 'Somebody Else', 'TRUE']);
  });

  it("changes the Pilot cell when it is empty (the pilot's name never reached the sheet)", async () => {
    await boot(true);
    await reserveAndStandBy();
    g.values[2]![4] = '';
    bobFlew();
    assert.equal((await d.ctx.autoComplete!.run())[0]!.completed.length, 1);
    assert.deepEqual([g.cell('E3'), g.cell('H3')], ['bob', 'TRUE']);
  });

  it('still completes it here when there is no write-back, and says nothing of the sheet', async () => {
    await boot(false);
    h.jobs.reserve(job().id, [1], USER_A);
    h.jobs.addBackup(job().id, USER_B);
    bobFlew();
    const [r] = await d.ctx.autoComplete!.run();
    assert.deepEqual(r!.completed.map((c) => [c.discordId, c.sheetTicked]), [[bob.id, false]]);
    assert.doesNotMatch(bob.lastText, /sheet/);
    assert.doesNotMatch(alice.lastText, /sheet/);
    assert.deepEqual(g.writes, []);
    assert.deepEqual(view().legs.map((l) => l.holder?.discordId), [bob.id]);
  });

  describe('the sheet writer on its own', () => {
    const panel = () => h.store.getPanel(pid())!;

    it('refuses a Pilot cell that names anyone but the pilot it was told to expect, and says who', async () => {
      await boot(true);
      g.values[2]![4] = 'Sam';
      await assert.rejects(wb.completeAsBackup(panel(), K, { from: 'alice', to: 'bob', backupName: 'bob' }), (e: unknown) => e instanceof WriteBackError && e.code === 'CONFLICT' && e.existing === 'Sam' && /names \*\*Sam\*\* for that flight/.test(e.message));
      assert.equal(g.writes.length, 0);
    });

    it('accepts a Pilot cell that already has the backup\'s name, and ticks the box; capital letters do not matter', async () => {
      await boot(true);
      g.values[2]![4] = 'BOB';
      assert.deepEqual(await wb.completeAsBackup(panel(), K, { from: 'alice', to: 'bob', backupName: null }), { backupCleared: false });
      assert.deepEqual([g.cell('E3'), g.cell('H3')], ['BOB', 'TRUE']);
    });

    it('does not know whose name an unrecorded one is: a name it was not told to expect is not replaced', async () => {
      await boot(true);
      g.values[2]![4] = 'alice';
      await assert.rejects(wb.completeAsBackup(panel(), K, { from: null, to: 'bob', backupName: null }), (e: unknown) => e instanceof WriteBackError && e.code === 'CONFLICT');
      assert.equal(g.cell('E3'), 'alice');
    });

    it("says when the flight's row is gone, and writes as plain text", async () => {
      await boot(true);
      await assert.rejects(wb.completeAsBackup(panel(), 'EGLL-NOWHERE@2026-11-12', { from: 'alice', to: 'bob', backupName: null }), (e: unknown) => e instanceof WriteBackError && e.code === 'FLIGHT_NOT_FOUND');
      g.values[2]![4] = 'alice';
      await wb.completeAsBackup(panel(), K, { from: 'alice', to: '=HYPERLINK("x")', backupName: null });
      assert.equal(g.writes.at(-1)!.valueInputOption, 'RAW');
    });
  });
});
