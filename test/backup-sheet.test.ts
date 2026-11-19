import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { jobBlock } from '../src/discord/ui.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { BACKUP_CHECK_EVERY_MS, BackupSheetCheck, backupSheetCleaner } from '../src/services/backupSheet.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { makeHarness, T0, USER_A, USER_B, USER_C, type Harness } from './helpers.js';
import { FakeGoogle, makeServiceAccount, scheduleGrid, SHEET_ID, TAB_GID, TAB_TITLE } from './fake-google.js';
import { fakeComponent, fakeDm, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

/* Everything below is made up: the airline, its pilots and their flights. */

const { account, publicKey } = makeServiceAccount();
const K = { open: 'EGLL-EGCC@2026-11-12', taken: 'EGCC-EGLL@2026-11-12', other: 'EGLL-EGPH@2026-11-12' };
const BACKUP_COL = 'F'; // the Backup Pilot column of the pretend sheet

/* ------------------------------------------------------------------ the sheet writer */

describe('the Backup Pilot cell', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(() => h.close());

  it("writes a backup's name into that flight's Backup Pilot cell and nowhere else", async () => {
    assert.equal(await wb.claimBackup(panel(), K.open, 'Bob'), true);
    assert.equal(g.cell(`${BACKUP_COL}3`), 'Bob');
    assert.equal(g.writes.length, 1);
    assert.deepEqual(g.writes[0]!.data.map((d) => d.range), [`'${TAB_TITLE}'!${BACKUP_COL}3`]);
    assert.equal(g.writes[0]!.valueInputOption, 'RAW', 'as plain text, never a formula');
    assert.equal(g.cell('E3'), '', 'the Pilot cell is not touched');
  });

  it('writes nothing, and says so, where the sheet has no Backup Pilot column', async () => {
    g.values = scheduleGrid().map((r) => r.filter((_, i) => i !== 5));
    assert.equal(await wb.claimBackup(panel(), K.open, 'Bob'), false);
    assert.equal(g.writes.length, 0);
    assert.equal(await wb.unclaimBackup(panel(), K.open, 'Bob'), false);
    assert.equal(await wb.renameBackup(panel(), K.open, 'Bob', 'Bobby'), false);
    assert.equal(g.writes.length, 0);
  });

  it("refuses a cell that already names someone else, leaves one that already has the same name, and refuses a finished flight", async () => {
    g.values[2]![5] = 'Sam';
    await assert.rejects(wb.claimBackup(panel(), K.open, 'Bob'), (e: unknown) => e instanceof WriteBackError && e.code === 'CONFLICT' && e.existing === 'Sam' && /already names \*\*Sam\*\* as the backup/.test(e.message));
    assert.equal(g.cell('F3'), 'Sam');
    g.values[2]![5] = 'bob';
    assert.equal(await wb.claimBackup(panel(), K.open, 'Bob'), true, 'capital letters do not matter');
    assert.equal(g.writes.length, 0, 'already there: nothing to write');
    g.values[2]![5] = '';
    g.values[2]![7] = 'TRUE';
    await assert.rejects(wb.claimBackup(panel(), K.open, 'Bob'), (e: unknown) => e instanceof WriteBackError && e.code === 'CLOSED');
    g.values[2]![7] = 'FALSE';
    g.values[2]![4] = 'CANCELLED';
    await assert.rejects(wb.claimBackup(panel(), K.open, 'Bob'), (e: unknown) => e instanceof WriteBackError && e.code === 'CLOSED');
    assert.equal(g.writes.length, 0);
  });

  it("takes the name off only if it is still the one that was written, and never from a finished flight", async () => {
    await wb.claimBackup(panel(), K.open, 'Bob');
    g.values[2]![5] = 'Somebody Else';
    assert.equal(await wb.unclaimBackup(panel(), K.open, 'Bob'), false);
    assert.equal(g.cell('F3'), 'Somebody Else');
    g.values[2]![5] = 'Bob';
    g.values[2]![7] = 'TRUE';
    assert.equal(await wb.unclaimBackup(panel(), K.open, 'Bob'), false, 'a completed flight keeps its record');
    g.values[2]![7] = 'FALSE';
    assert.equal(await wb.unclaimBackup(panel(), K.open, 'bob'), true);
    assert.equal(g.cell('F3'), '');
  });

  it('changes the name only if it is still the one that was written', async () => {
    await wb.claimBackup(panel(), K.open, 'Bob');
    assert.equal(await wb.renameBackup(panel(), K.open, 'Bob', 'Captain Bob'), true);
    assert.equal(g.cell('F3'), 'Captain Bob');
    assert.equal(await wb.renameBackup(panel(), K.open, 'Bob', 'Again'), false);
    assert.equal(g.cell('F3'), 'Captain Bob');
  });

  it("says when the flight's row is gone", async () => {
    await assert.rejects(wb.claimBackup(panel(), 'EGLL-NOWHERE@2026-11-12', 'Bob'), (e: unknown) => e instanceof WriteBackError && e.code === 'FLIGHT_NOT_FOUND');
  });
});

/* ------------------------------------------------------------------ what pilots do in Discord */

describe('standing by as backup with write-back on', () => {
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let alice: FakeUser;
  let bob: FakeUser;
  const pid = () => h.panel.id;
  const syncFromSheet = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const job = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!;
  const view = (key: string) => h.jobs.view(job(key).id)!;
  const press = async (user: FakeUser, customId: string, o: { values?: string[] } = {}) => {
    const f = fakeComponent(user, customId, o);
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    return f.calls;
  };
  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  const standBy = async (user: FakeUser, code: string) => {
    await press(user, `panel:backup:${pid()}`);
    await say(user, code);
  };
  const session = (user: FakeUser) => h.store.getSession(user.id, h.clock.now);

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    h.events.subscribe(backupSheetCleaner({ store: h.store, writeback: wb }));
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    bob = d.client.user(new FakeUser(USER_B.discordId, 'bob'));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
    syncFromSheet(); // TST-001 EGLL-EGCC (row 3), TST-002 EGCC-EGLL (Taylor, row 4), TST-003 KMIA-KORD, TST-004 EGLL-EGPH (row 7), TST-005 EGLL-EGKK
    h.jobs.reserve(job(K.open).id, [1], USER_A); // alice flies TST-001 (row 3)
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it("puts the backup's name in the Backup Pilot cell, remembers what it wrote, and tells them how to change it", async () => {
    await standBy(bob, 'TST-001');
    assert.equal(g.cell('F3'), 'bob');
    assert.equal(g.cell('E3'), '', "the pilot's cell is the pilot's: not touched");
    assert.deepEqual(h.store.getBackupSheetName(job(K.open).id), { name: 'bob', sourceKey: K.open, discordId: USER_B.discordId });
    assert.match(bob.lastText, /^🛟 You're down as backup for \*\*TST-001\*\*/);
    assert.match(bob.lastText, /📝 I've put \*\*bob\*\* as the backup in the airline's sheet\. Not how you appear there\? Reply `name <your name>` and I'll use that from now on\.$/);
    assert.equal(session(bob), null);
  });

  it('uses the name the pilot has chosen for themselves', async () => {
    await say(bob, 'name Captain Bob');
    await standBy(bob, 'TST-001');
    assert.equal(g.cell('F3'), 'Captain Bob');
  });

  it('does not make them the backup when the sheet already names someone else, and lets them try another flight', async () => {
    g.values[2]![5] = 'Sam'; // a manager typed a backup into the sheet after the last hourly read
    await standBy(bob, 'TST-001');
    assert.match(bob.lastText, /already names \*\*Sam\*\* as the backup for that flight\. So I haven't put you down as backup for \*\*TST-001\*\*\.\nSend a different flight ID, or say `cancel`\.$/);
    assert.equal(view(K.open).backup, null);
    assert.equal(g.cell('F3'), 'Sam');
    assert.equal(session(bob)?.step, 'await_code', 'the conversation stays open');
    assert.equal(h.store.getBackupSheetName(job(K.open).id), null);
  });

  it('does not make them the backup for a flight the sheet shows as finished', async () => {
    g.values[2]![7] = 'TRUE';
    await standBy(bob, 'TST-001');
    assert.match(bob.lastText, /already shows that flight as completed or cancelled/);
    assert.equal(view(K.open).backup, null);
  });

  it('keeps the backup, and says the sheet was not updated, when Google cannot be reached; the hourly check writes it later', async () => {
    g.mode = 'down';
    await standBy(bob, 'TST-001');
    assert.match(bob.lastText, /^🛟 You're down as backup for \*\*TST-001\*\*/);
    assert.match(bob.lastText, /⚠️ I couldn't update the airline's sheet \(.*HTTP 503.*\), so it doesn't show you as the backup yet\. Please ask a manager to add you to the \*Backup Pilot\* cell for \*\*TST-001\*\* there\./);
    assert.equal(view(K.open).backup?.discordId, USER_B.discordId);
    assert.equal(h.store.getBackupSheetName(job(K.open).id), null, 'nothing was written, so nothing is remembered');
    g.mode = 'ok';
    const out = await new BackupSheetCheck({ store: h.store, writeback: wb, now: () => h.clock.now }).run(true);
    assert.deepEqual([out.checked, out.written], [1, 1]);
    assert.equal(g.cell('F3'), 'bob');
  });

  it("says nothing about the sheet where it has no Backup Pilot column, and the backup stands", async () => {
    g.values = scheduleGrid().map((r) => r.filter((_, i) => i !== 5));
    await standBy(bob, 'TST-001');
    assert.match(bob.lastText, /^🛟 You're down as backup for \*\*TST-001\*\* \(EGLL → EGCC\)\. The panel shows your name\. If the pilot gives it back I'll tell you, and you can stand down any time from \*\*My flights\*\*\.$/);
    assert.equal(g.writes.length, 0);
    assert.equal(view(K.open).backup?.discordId, USER_B.discordId);
  });

  it('leaves the sheet alone when an admin has switched write-back off for the panel', async () => {
    h.store.updatePanel(pid(), { writeback: false });
    await standBy(bob, 'TST-001');
    assert.match(bob.lastText, /^🛟 You're down as backup/);
    assert.doesNotMatch(bob.lastText, /sheet/);
    assert.equal(g.writes.length, 0);
    assert.equal(view(K.open).backup?.discordId, USER_B.discordId);
  });

  it('takes the name off the sheet when they stand down, and says nothing to them about it being a heads-up', async () => {
    await standBy(bob, 'TST-001');
    const before = bob.dms.length;
    const down = await press(bob, `panel:release:${pid()}`, { values: [`b:${job(K.open).id}`] });
    await settle();
    assert.match(down.edits[0].content, /^You're no longer the backup for TST-001\.$/);
    assert.equal(g.cell('F3'), '');
    assert.equal(view(K.open).backup, null);
    assert.equal(bob.dms.length, before, 'they stood down themselves: no "your spot has ended" message');
  });

  it('leaves a name in the cell that is not the one it wrote, when they stand down', async () => {
    await standBy(bob, 'TST-001');
    g.values[2]![5] = 'Somebody Else';
    await press(bob, `panel:release:${pid()}`, { values: [`b:${job(K.open).id}`] });
    await settle();
    assert.equal(g.cell('F3'), 'Somebody Else');
    assert.equal(view(K.open).backup, null, 'they are still no longer the backup');
  });

  it("takes the backup's name off the sheet when the pilot gives the flight back, and tells the backup as before", async () => {
    await standBy(bob, 'TST-001');
    await press(alice, `panel:release:${pid()}`, { values: [`${job(K.open).id}:1`] });
    await settle();
    assert.equal(g.cell('F3'), '', "the backup's name");
    assert.equal(g.cell('E3'), '', "and the pilot's");
    assert.match(bob.lastText, /^Heads up: nobody is flying \*\*TST-001\*\* any more, and you were down as its backup\./);
  });

  it("takes the backup's name off when an admin frees the flight", async () => {
    await standBy(bob, 'TST-001');
    h.jobs.adminRelease(h.store.getPanel(pid())!, 'TST-001');
    await settle();
    assert.equal(g.cell('F3'), '');
    assert.equal(view(K.open).backup, null);
  });

  it('changes the name in the Backup Pilot cell when they rename themselves', async () => {
    await standBy(bob, 'TST-001');
    await say(bob, 'name Captain Bob');
    assert.equal(g.cell('F3'), 'Captain Bob');
    assert.equal(h.store.getBackupSheetName(job(K.open).id)?.name, 'Captain Bob');
    assert.match(bob.lastText, /I've changed it on 1 flight/);
    // and standing down then finds it under the new name
    await press(bob, `panel:release:${pid()}`, { values: [`b:${job(K.open).id}`] });
    await settle();
    assert.equal(g.cell('F3'), '');
  });

  it("does not show the backup twice on the panel once the sheet's own note says the same", async () => {
    await standBy(bob, 'TST-001');
    syncFromSheet(); // the hourly read now sees "bob" in the Backup Pilot column, which it reads as a note
    assert.equal(job(K.open).notes, 'Backup: bob');
    assert.doesNotMatch(jobBlock(view(K.open), T0), /Backup: bob/, "the sheet's note repeats what the panel already shows");
    // a flight with no backup here still shows what the sheet says
    g.values[6]![5] = 'Pat'; // row 7: EGLL-EGPH
    syncFromSheet();
    assert.equal(job(K.other).notes, 'Backup: Pat');
    assert.match(jobBlock(view(K.other), T0), /Backup: Pat/);
  });
});

/* ------------------------------------------------------------------ the retroactive check */

describe('checking the backups that were never written in the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let check: BackupSheetCheck;
  const pid = () => h.panel.id;
  const job = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!;
  const sync = () => h.jobs.sync(pid(), parseScheduleValues(g.values, h.clock.now)!.jobs);
  const names = () => [g.cell('F3'), g.cell('F4'), g.cell('F7')];

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
    h.clock.now = T0;
    sync(); // TST-001 row 3, TST-002 row 4 (Taylor), TST-003, TST-004 row 7, TST-005
    h.jobs.reserve(job(K.open).id, [1], USER_A);
    h.jobs.reserve(job(K.other).id, [1], USER_A);
    check = new BackupSheetCheck({ store: h.store, writeback: wb, now: () => h.clock.now });
  });
  afterEach(() => h.close());

  it("writes in the name of every backup put down before backups were written in the sheet, once, and remembers it did", async () => {
    h.jobs.addBackup(job(K.open).id, USER_B); // put down by an earlier version: no sheet name remembered
    h.jobs.addBackup(job(K.other).id, USER_C);
    h.store.setPilotName(USER_B.discordId, 'Captain Bob', T0);
    const out = await check.run();
    assert.deepEqual(out, { checked: 2, written: 2, left: 0, waiting: 0, noColumn: 0 });
    assert.deepEqual(names(), ['Captain Bob', '', USER_C.username], 'the name they chose, else the one Discord knows them by');
    assert.equal(h.store.getBackupSheetName(job(K.open).id)?.name, 'Captain Bob');
    const writes = g.writes.length;
    assert.deepEqual((await check.run(true)).checked, 0, 'nothing is left to look at');
    assert.equal(g.writes.length, writes);
  });

  it('is only done once an hour, unless it is told to', async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    assert.equal((await check.run()).written, 1);
    h.jobs.addBackup(job(K.other).id, USER_C);
    assert.equal((await check.run()).checked, 0, 'too soon');
    h.clock.advance(BACKUP_CHECK_EVERY_MS - 1);
    assert.equal((await check.run()).checked, 0);
    h.clock.advance(1);
    assert.equal((await check.run()).written, 1);
  });

  it("leaves a name somebody else put in the cell, and a finished flight, alone, and does not look at them again", async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    h.jobs.addBackup(job(K.other).id, USER_C);
    g.values[2]![5] = 'Sam';
    g.values[6]![7] = 'TRUE';
    const out = await check.run(true);
    assert.deepEqual([out.checked, out.written, out.left], [2, 0, 2]);
    assert.deepEqual(names(), ['Sam', '', ''], 'the sheet is left as the airline has it');
    assert.equal(h.jobs.view(job(K.open).id)!.backup?.discordId, USER_B.discordId, 'and the backup still stands here');
    assert.equal(h.store.getBackupSheetName(job(K.open).id), null, 'nothing was written, so nothing will be taken off');
    assert.deepEqual((await check.run(true)).checked, 0, 'not looked at again');
  });

  it('counts a cell that already has their name as done', async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    g.values[2]![5] = USER_B.username;
    const out = await check.run(true);
    assert.deepEqual([out.written, out.left], [1, 0]);
    assert.equal(g.writes.length, 0, 'nothing to write');
    assert.equal(h.store.getBackupSheetName(job(K.open).id)?.name, USER_B.username);
  });

  it('tries again in ten minutes when the sheet cannot be reached, and writes them then', async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    g.mode = 'down';
    const first = await check.run();
    assert.deepEqual([first.checked, first.written, first.waiting], [1, 0, 1]);
    g.mode = 'ok';
    assert.equal((await check.run()).checked, 0, 'not straight away');
    h.clock.advance(10 * 60_000);
    assert.deepEqual([(await check.run()).written, g.cell('F3')], [1, USER_B.username]);
  });

  it("looks again each hour where the sheet has no Backup Pilot column, in case one is added, and writes nothing", async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    g.values = scheduleGrid().map((r) => r.filter((_, i) => i !== 5));
    const out = await check.run(true);
    assert.deepEqual([out.checked, out.noColumn, out.written], [1, 1, 0]);
    assert.equal(g.writes.length, 0);
    g.values = scheduleGrid();
    h.clock.advance(BACKUP_CHECK_EVERY_MS);
    assert.equal((await check.run()).written, 1, 'the column was added');
    assert.equal(g.cell('F3'), USER_B.username);
  });

  it('leaves out panels that are not written to, flights of several legs, backups that are written already, and flights that are gone', async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    h.store.updatePanel(pid(), { writeback: false });
    assert.equal((await check.run(true)).checked, 0, 'write-back is off for the panel');
    h.store.updatePanel(pid(), { writeback: true });
    h.store.setBackupSheetName(job(K.open).id, USER_B.discordId, 'Already Written');
    assert.equal((await check.run(true)).checked, 0, 'already written');
    h.store.setBackupSheetName(job(K.open).id, USER_B.discordId, null);
    h.jobs.sync(pid(), []); // the flight has gone from the schedule
    assert.equal((await check.run(true)).checked, 0);
    assert.equal(g.writes.length, 0);
  });

  it('does nothing at all when the bot cannot write to sheets', async () => {
    h.jobs.addBackup(job(K.open).id, USER_B);
    assert.deepEqual(await new BackupSheetCheck({ store: h.store, writeback: null }).run(true), { checked: 0, written: 0, left: 0, waiting: 0, noColumn: 0 });
  });

  it('looks at no more than forty in a pass, and does the rest soon after', async () => {
    // Forty-one open single-leg flights, each with a backup, all against rows the sheet has.
    const rows = Array.from({ length: 41 }, (_, i) => [`EGLL-EGA${String.fromCharCode(65 + (i % 26))}${i >= 26 ? '' : ''}`.slice(0, 9), '11/12/2026', '0600-2359z', 'x', `Pilot ${i}`, '', 'A320', 'FALSE', 'FALSE']);
    // (the first 26 and the last 15 would collide on route, so give each its own date within the window)
    rows.forEach((r, i) => void (r[1] = `11/${12 + Math.floor(i / 26)}/2026`));
    g.values = [scheduleGrid()[0]!, ['Week 2', '11/8/2026', 'Week 2'], ...rows];
    sync();
    const open = h.store.listJobs(pid()).filter((x) => x.status === 'open');
    assert.equal(open.length, 41);
    for (const j of open) h.store.setBackup(j.id, USER_B.discordId, USER_B.username, T0);
    const first = await check.run(true);
    assert.equal(first.checked, 40);
    h.clock.advance(10 * 60_000);
    const second = await check.run();
    assert.equal(second.checked, 1, 'the one that was left');
  });
});
