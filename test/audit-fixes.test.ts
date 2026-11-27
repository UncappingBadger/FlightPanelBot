import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AeroconomyError } from '../src/aeroconomy/http.js';
import { AeroconomyPaymentsClient } from '../src/aeroconomy/payments.js';
import type { LogFlight } from '../src/aeroconomy/account.js';
import { componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { previewText, profitReport } from '../src/discord/profitUi.js';
import type { FsHubFlight } from '../src/fshub/client.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { hostPaths, type HostPaths } from '../src/host/paths.js';
import { loadSettings, saveSettings } from '../src/host/settings.js';
import { explainStartFailure } from '../src/host/supervisor.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { backupSheetCleaner } from '../src/services/backupSheet.js';
import { compareProfits, pairRows } from '../src/services/airlineProfits.js';
import type { SheetFlight } from '../src/services/contributions.js';
import type { PayRequest, PayResult, PaymentGateway } from '../src/services/payGateway.js';
import { buildPayLines, type LedgerView } from '../src/services/payroll.js';
import { Payroll } from '../src/services/payrollService.js';
import { usableSheetName } from '../src/services/pilotNames.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { FakeFsHub, FakeUser, fakeComponent, fakeDm, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';
import { FakeGoogle, flightRow, HEADER, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';
import { HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';

/* One test or more for each fault of the audit of 27 November 2026. Everything here is made up: the airline, its pilots, accounts and flights. */

const { account, publicKey } = makeServiceAccount();
const D10 = Date.UTC(2026, 10, 10);
const D12 = Date.UTC(2026, 10, 12);
const DAY_KEY = 'EGLL-EGCC@2026-11-12';
const SOURCE = '9954-0000123';
const INFO_GID = '222';

const writer = (h: Harness, g: FakeGoogle, opts: { followRows?: boolean } = {}) =>
  new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, {
    now: () => h.clock.now,
    ...(opts.followRows ? { flightOf: (panelId: number, key: string) => h.store.flightHint(panelId, key) } : {}),
  });

/** Read the pretend sheet the way a refresh does. */
const readSheet = (h: Harness, g: FakeGoogle) => {
  const parsed = parseScheduleValues(g.values, h.clock.now)!;
  return h.jobs.sync(h.panel.id, parsed.jobs, parsed.unreadable);
};

/* ------------------------------------------------------------------ 1: one flight is paid once */

const PAY_HEADER = ['Route', 'Date', 'Landing Window Zulu', 'Pilot', 'Backup Pilot', 'Aircraft', 'Flight Completed (by Pilot)', 'Pilot Paid', 'Profit Made', 'Pilot Pay'];
const payRow = (route: string, date: string, pilot: string, pay = '$7,500'): string[] => [route, date, '0600-2359z', pilot, '', 'A320', 'TRUE', 'FALSE', '$10,000.00', pay];
const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

class Bank implements PaymentGateway {
  connected = true;
  calls: PayRequest[] = [];
  async pay(request: PayRequest): Promise<PayResult> {
    this.calls.push(request);
    return { ok: true, reference: `ref-${this.calls.length}` };
  }
}

describe('a flight is paid once, even when its row moves or its date is corrected and Pilot Paid is not ticked', () => {
  let h: Harness;
  let schedule: string[][];
  let bank: Bank;
  let payroll: Payroll;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const settings = () => h.store.getPayrollSettings(h.panel.id)!;
  const info = [
    ['Pilot', 'FSHUB ID', 'Bank Acct'],
    ['Alex Smith', '32411', '2002-0001111'],
    ['Sam Jones', '41502', '2002-0002222'],
  ];
  const fetchFn = (async (url: string) => new Response(csv(String(url).includes(`gid=${INFO_GID}`) ? info : schedule), { status: 200, headers: { 'content-type': 'text/csv' } })) as unknown as typeof fetch;
  const alexRow = () => payRow('KORD-EGLL', '11/10/2026', 'Alex Smith');
  const prepare = () => payroll.prepare(panel(), settings());
  const alexSent = () => bank.calls.filter((c) => c.recipientAccount === '2002-0001111').length;

  beforeEach(async () => {
    h = await makeHarness();
    schedule = [PAY_HEADER, alexRow()];
    bank = new Bank();
    payroll = new Payroll({ store: h.store, gateway: bank, writeback: null, fetchFn, now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID), writeback: false });
    h.store.savePayrollSettings(h.panel.id, { enabled: true, sourceAccount: SOURCE, infoSheetId: SHEET_ID, infoGid: INFO_GID, startDay: D10, ownerId: USER_A.discordId });
    h.store.setPilotId('d-alex', 32411, T0, 'Alex Smith');
    h.store.setPilotId('d-sam', 41502, T0, 'Sam Jones');
  });
  afterEach(() => h.close());

  it('after a row of the same route and day is put in above it', async () => {
    await payroll.pay(panel(), settings(), (await prepare()).lines);
    assert.equal(alexSent(), 1);
    schedule = [PAY_HEADER, payRow('KORD-EGLL', '11/10/2026', 'Sam Jones'), alexRow()];
    const next = await prepare();
    assert.deepEqual(next.lines.map((l) => [l.pilot, l.flags]), [['Sam Jones', []]], 'only the new row is due');
    await payroll.pay(panel(), settings(), next.lines);
    assert.equal(alexSent(), 1);
  });

  it('after its date is corrected: it is listed to be checked, and not sent', async () => {
    await payroll.pay(panel(), settings(), (await prepare()).lines);
    schedule = [PAY_HEADER, payRow('KORD-EGLL', '11/11/2026', 'Alex Smith')];
    const next = await prepare();
    assert.deepEqual(next.lines.map((l) => l.flags), [['maybe-paid']]);
    await payroll.pay(panel(), settings(), next.lines);
    assert.equal(alexSent(), 1);
  });

  it('after its route and its pay are both corrected: it is listed to be checked, and not sent', async () => {
    await payroll.pay(panel(), settings(), (await prepare()).lines);
    schedule = [PAY_HEADER, payRow('KORD-EGKK', '11/10/2026', 'Alex Smith', '$8,200')];
    const next = await prepare();
    assert.deepEqual(next.lines.map((l) => l.flags), [['maybe-paid']]);
    await payroll.pay(panel(), settings(), next.lines);
    assert.equal(alexSent(), 1);
  });

  it('when an older list is paid after the flight has been paid from another one', async () => {
    schedule = [PAY_HEADER, payRow('KORD-EGLL', '11/10/2026', 'Sam Jones'), alexRow()];
    const older = await prepare();
    schedule = [PAY_HEADER, alexRow()];
    await payroll.pay(panel(), settings(), (await prepare()).lines);
    assert.equal(alexSent(), 1);
    schedule = [PAY_HEADER, payRow('KORD-EGLL', '11/10/2026', 'Sam Jones'), alexRow()];
    const out = await payroll.pay(panel(), settings(), older.lines.filter((l) => l.pilot === 'Alex Smith'));
    assert.deepEqual(out.skipped.map((s) => s.reason), ['already-sent']);
    assert.equal(alexSent(), 1);
  });
});

/* ------------------------------------------------------------------ 4: names in any alphabet */

describe('names written in other alphabets', () => {
  const none: LedgerView = { isTaken: () => false, hasUniqueId: () => false, failedIdFor: () => null, lastAccount: () => null };
  const flight: SheetFlight = { row: 2, route: 'KORD → EGLL', sourceKey: 'KORD-EGLL@2026-11-10', flightNumber: null, day: D10, pilot: 'Олег Смирнов', completed: true, profit: null, profitRaw: '', payRaw: '$7,500', pilotPaid: false };
  const lines = (infoName: string, pilot = flight.pilot) =>
    buildPayLines({
      flights: [{ ...flight, pilot }],
      info: [{ row: 2, name: infoName, fshubId: 32411, account: '2002-0001111' }],
      startDay: null,
      ledger: none,
      identities: { idsForName: () => [], namesForId: () => [], knowsId: () => true },
      flightRef: () => null,
    }).lines;

  it('are not taken for one another, so nobody is paid into another pilot\'s account', () => {
    const [line] = lines('Иван Петров');
    assert.equal(line!.account, null);
    assert.ok(line!.flags.includes('no-info'));
  });

  it('still find their own row', () => {
    assert.equal(lines('олег  смирнов')[0]!.account, '2002-0001111');
  });

  it('a name with nothing to compare matches nothing', () => {
    assert.equal(lines('???', '***')[0]!.account, null);
  });
});

/* ------------------------------------------------------------------ 6: an unanswered payment is never reported as refused */

describe('a payment that went unanswered once', () => {
  const answered = async (answers: Array<number | 'lost'>) => {
    const client = new AeroconomyPaymentsClient('TEST-TOKEN', {
      sleep: async () => undefined,
      fetchFn: (async () => {
        const next = answers.shift();
        if (next === undefined || next === 'lost') throw new Error('no reply');
        return new Response('{}', { status: next });
      }) as typeof fetch,
    });
    return client.pay({ idempotencyKey: 'fpb-test-1', sourceAccount: SOURCE, recipientAccount: '2002-0004567', description: 'Test', cents: 100 });
  };

  it('is of unknown outcome when the tries after it are told to slow down, or refused', async () => {
    await assert.rejects(answered(['lost', 429, 429]), AeroconomyError);
    await assert.rejects(answered([503, 429, 429]), AeroconomyError);
    await assert.rejects(answered(['lost', 422]), AeroconomyError);
  });

  it('is still a plain refusal when every try was answered', async () => {
    const out = await answered([429, 429, 429]);
    assert.equal(out.ok, false);
  });
});

/* ------------------------------------------------------------------ 2, 8, 12: what is written in the sheet */

describe('pilot names and rows in the sheet', () => {
  let h: Harness;
  let g: FakeGoogle;
  let d: DiscordHarness;
  let wb: SheetWriteBack;
  let alice: FakeUser;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const jobAt = (key: string) => h.store.listJobs(h.panel.id).find((j) => j.sourceKey === key)!;
  const press = async (customId: string, values?: string[]) => {
    const f = fakeComponent(alice, customId, values ? { values } : {});
    await componentHandlers.find((x) => x.prefix === customId.split(':')[0])!.handle(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const say = (text: string) => handleDmMessage(d.ctx, fakeDm(alice, text));
  const reserve = async (code: string) => {
    await press(`panel:reserve:${h.panel.id}`);
    await say(code);
    await settle();
  };

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = writer(h, g, { followRows: true });
    d = makeDiscordHarness(h, { writeback: wb });
    alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const two = () => [HEADER, flightRow('EGLL-EGCC', '11/12/2026', '', false, 'A320', '0600-0900z'), flightRow('EGLL-EGCC', '11/12/2026', '', false, 'A320', '1300-1600z')];

  it('a name that would cancel the flight is refused, and the sheet is left as it was', async () => {
    g.values = [HEADER, flightRow('EGLL-EGCC', '11/12/2026')];
    readSheet(h, g);
    await reserve('TST-001');
    assert.equal(g.cell('E2'), 'alice');
    await say('name Cancelled');
    assert.match(alice.lastText, /I can't use a name that starts with "cancel"/);
    assert.equal(g.cell('E2'), 'alice');
    assert.equal(h.store.getPilotName(alice.id), 'alice');
    await assert.rejects(wb.claim(panel(), DAY_KEY, 'Cancel Culture'), (e: unknown) => e instanceof WriteBackError && e.code === 'BAD_NAME');
    assert.equal(usableSheetName('cancelled'), false);
    assert.equal(usableSheetName('Alice'), true);
  });

  it('a flight whose row has changed places with another of the same route and day is still written on its own row', async () => {
    g.values = two();
    readSheet(h, g);
    g.values = [HEADER, two()[2]!, two()[1]!]; // re-sorted, and not read again yet
    await wb.claim(panel(), DAY_KEY, 'Alex'); // the key of the 0600 flight
    assert.deepEqual([g.cell('E2'), g.cell('E3')], ['', 'Alex']);
  });

  it('a name changed and the flight then given back before the next read leaves it free', async () => {
    g.values = [HEADER, flightRow('EGLL-EGCC', '11/12/2026')];
    readSheet(h, g);
    await reserve('TST-001');
    readSheet(h, g); // the sheet now names alice
    await say('name Captain Alice');
    await settle();
    assert.equal(g.cell('E2'), 'Captain Alice');
    await press(`panel:release:${h.panel.id}`, [`${jobAt(DAY_KEY).id}:1`]);
    assert.equal(g.cell('E2'), '');
    assert.equal(h.jobs.view(jobAt(DAY_KEY).id)!.legs[0]!.sheetHolder, null);
  });
});

/* ------------------------------------------------------------------ found by the sweep of the fixes themselves */

describe('a write never goes to another flight of the same route and day', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const jobs = () => h.store.listJobs(h.panel.id);
  const row = (pilot = '', window = '0600-0900z', backup = '') => {
    const r = flightRow('EGLL-EGCC', '11/12/2026', pilot, false, 'A320', window);
    r[5] = backup;
    return r;
  };
  const refusal = async (write: Promise<unknown>) => {
    try {
      await write;
    } catch (e) {
      if (e instanceof WriteBackError) return e.code;
      throw e;
    }
    return 'written';
  };

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    wb = writer(h, g, { followRows: true });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(() => h.close());

  it('when the backup of a deleted twin row is cleared away: the kept flight keeps its backup\'s name', async () => {
    g.values = [HEADER, row('Alex'), row('Sam')];
    readSheet(h, g);
    h.events.subscribe(backupSheetCleaner({ store: h.store, writeback: wb }));
    for (const j of jobs()) {
      h.jobs.addBackup(j.id, USER_B);
      h.store.setBackupSheetName(j.id, USER_B.discordId, 'bob');
    }
    g.values = [HEADER, row('Alex', '0600-0900z', 'bob'), row('Sam', '0600-0900z', 'bob')];
    readSheet(h, g);
    g.values = [HEADER, g.values[1]!];
    readSheet(h, g);
    await settle(100);
    assert.equal(g.cell('F2'), 'bob');
  });

  it('when the flight\'s own twin row can no longer be read', async () => {
    g.values = [HEADER, row(), row()];
    readSheet(h, g);
    const second = jobs()[1]!;
    h.jobs.reserve(second.id, [1], USER_A);
    g.values = [HEADER, row(), row('alice')];
    readSheet(h, g);
    g.values[2]![1] = '11/1';
    assert.deepEqual(readSheet(h, g).held, ['TST-002']);
    assert.equal(await refusal(wb.complete(panel(), h.store.getJob(second.id)!.sourceKey, 'alice')), 'ROWS_CHANGED');
    assert.deepEqual([g.cell('E2'), g.cell('H2')], ['', 'FALSE']);
  });

  it('when the flight\'s row has just been deleted and another has taken its key', async () => {
    g.values = [HEADER, row('', '0600-0900z'), row('', '1300-1600z')];
    readSheet(h, g);
    const key = jobs()[0]!.sourceKey;
    g.values = [HEADER, g.values[2]!]; // not read again yet
    assert.equal(await refusal(wb.complete(panel(), key, 'alice')), 'ROWS_CHANGED');
    assert.deepEqual([g.cell('E2'), g.cell('H2')], ['', 'FALSE']);
  });

  it('but a row left alone is still written after its twin has gone from the schedule', async () => {
    g.values = [HEADER, row(), row()];
    readSheet(h, g);
    const key = jobs()[0]!.sourceKey;
    g.values = [HEADER, row()];
    readSheet(h, g);
    assert.equal(await refusal(wb.complete(panel(), key, 'alice')), 'written');
  });

  for (const [what, finished] of [
    ['cancelled', () => row('CANCELLED')],
    ['completed', () => ((r: string[]) => ((r[7] = 'TRUE'), r))(row('Sam'))],
  ] as const) {
    it(`and the flight left over is written as usual after a ${what} twin's row is deleted`, async () => {
      g.values = [HEADER, row(), row()];
      readSheet(h, g);
      g.values = [HEADER, row(), finished()];
      readSheet(h, g);
      g.values = [HEADER, row()];
      readSheet(h, g);
      const open = h.store.listJobs(h.panel.id, 'open')[0]!;
      assert.equal(await refusal(wb.claim(panel(), open.sourceKey, 'alice')), 'written');
      assert.equal(g.cell('E2'), 'alice');
    });
  }

  /** Reserve a flight and write the pilot's name on its row, as the bot does, then read the sheet again. */
  const book = (code: number, sheetRow: number, who: { discordId: string; username: string }) => {
    const job = jobs()[code]!;
    h.jobs.reserve(job.id, [1], who);
    h.store.setReservationSheetName(job.id, 1, who.username);
    g.values[sheetRow]![4] = who.username;
    return job.id;
  };
  const keyOf = (id: number) => h.store.getJob(id)!.sourceKey;
  const heldBy = (id: number) => h.store.getHolder(id, 1)?.username;

  it('and follows the pilot\'s name when identical rows are re-sorted before the next read', async () => {
    g.values = [HEADER, row(), row()];
    readSheet(h, g);
    const alice = book(0, 1, USER_A);
    book(1, 2, USER_B);
    readSheet(h, g);
    g.values = [HEADER, g.values[2]!, g.values[1]!]; // not read again yet
    assert.equal(await refusal(wb.complete(panel(), keyOf(alice), 'alice')), 'written');
    assert.deepEqual([g.cell('E2'), g.cell('H2'), g.cell('E3'), g.cell('H3')], ['bob', 'FALSE', 'alice', 'TRUE']);
  });

  it('and the twin of a half-typed row can still be written once that has been read', async () => {
    g.values = [HEADER, row(), row()];
    readSheet(h, g);
    const alice = book(0, 1, USER_A);
    const bob = book(1, 2, USER_B);
    readSheet(h, g);
    g.values[2]![1] = '11/1';
    readSheet(h, g);
    assert.equal(await refusal(wb.complete(panel(), keyOf(alice), 'alice')), 'written');
    assert.equal(await refusal(wb.complete(panel(), keyOf(bob), 'bob')), 'ROWS_CHANGED');
    assert.deepEqual([g.cell('H2'), g.cell('H3')], ['TRUE', 'FALSE']);
  });

  it('and not to a row carrying another flight number', async () => {
    const numbered = (n: string, window: string, pilot = '') => [...row(pilot, window), n];
    g.values = [[...HEADER, 'Flight Number'], numbered('SKY101', '0600-0900z'), numbered('SKY102', '1800-2100z')];
    readSheet(h, g);
    const first = book(0, 1, USER_A);
    h.jobs.reserve(jobs()[1]!.id, [1], USER_A);
    g.values[2]![4] = 'alice';
    readSheet(h, g);
    g.values[1]![1] = '11/1'; // alice's SKY101 row is being retyped, and not read again yet
    assert.equal(await refusal(wb.unclaim(panel(), keyOf(first), 'alice')), 'ROWS_CHANGED');
    assert.equal(g.cell('E3'), 'alice');
  });

  it('and a deleted flight does not take a live flight\'s row from it', () => {
    g.values = [HEADER, row(), row(), row()];
    readSheet(h, g);
    const kept = book(1, 2, USER_A);
    book(2, 3, USER_A);
    readSheet(h, g);
    g.values = [HEADER, g.values[1]!, g.values[2]!]; // the third flight is deleted: only it is given up
    readSheet(h, g);
    g.values = [HEADER, g.values[1]!, row(), g.values[2]!]; // and later a new row goes in above alice's
    readSheet(h, g);
    assert.equal(heldBy(kept), 'alice');
    assert.equal(h.jobs.view(kept)!.legs[0]!.sheetHolder, 'alice', 'her flight is still on the row with her name');
  });

  it('and a reservation the sheet turns down is taken back even if the flight finished while it was asked', async () => {
    g.values = [HEADER, row()];
    readSheet(h, g);
    const d = makeDiscordHarness(h, { writeback: wb });
    const alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    const id = jobs()[0]!.id;
    g.beforeNextRead = () => {
      g.values[1]![4] = 'Sam';
      g.values[1]![7] = 'TRUE';
      readSheet(h, g);
    };
    const f = fakeComponent(alice, `panel:reserve:${h.panel.id}`, {});
    await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, f.i);
    await handleDmMessage(d.ctx, fakeDm(alice, 'TST-001'));
    await settle(100);
    assert.match(alice.lastText, /So I haven't reserved \*\*TST-001\*\* for you/);
    assert.equal(h.store.getHolder(id, 1), null);
  });
});

/* ------------------------------------------------------------------ 7, 9, 11: reservations */

describe('reservations when the sheet changes', () => {
  let h: Harness;
  let g: FakeGoogle;
  const job = () => h.store.listJobs(h.panel.id)[0]!;
  const holder = () => h.store.getHolder(job().id, 1)?.discordId ?? null;
  const released = () => h.emitted.filter((e) => e.type === 'released');

  beforeEach(async () => {
    h = await makeHarness();
    g = new FakeGoogle(publicKey);
    g.values = [HEADER, flightRow('EGLL-EGCC', '11/12/2026'), flightRow('EGKK-EGPH', '11/12/2026')];
    readSheet(h, g);
    h.jobs.reserve(job().id, [1], USER_A);
    g.values[1]![4] = 'alice';
    readSheet(h, g);
  });
  afterEach(() => h.close());

  for (const [what, column, typo] of [
    ['date', 1, '11/1'],
    ['route', 0, 'EGLL-EG'],
    ['empty route', 0, ''],
  ] as const) {
    it(`are kept while the row has a half-typed ${what}, and are still there once it is put right`, () => {
      const id = job().id;
      const good = g.values[1]![column]!;
      g.values[1]![column] = typo;
      const during = readSheet(h, g);
      assert.deepEqual(during.held, ['TST-001']);
      assert.equal(h.store.getHolder(id, 1)?.discordId, USER_A.discordId);
      g.values[1]![column] = good;
      readSheet(h, g);
      const open = h.store.listJobs(h.panel.id, 'open').find((j) => j.id === id)!;
      assert.equal(open.sourceKey, DAY_KEY);
      assert.equal(h.store.getHolder(id, 1)?.discordId, USER_A.discordId);
      assert.deepEqual(released(), []);
    });
  }

  it('are given up when the row is really gone', () => {
    g.values = [HEADER, g.values[2]!];
    readSheet(h, g);
    assert.equal(released().length, 1);
  });

  it('are given up, and the pilot told, when the airline cancels the flight, which can then not be completed', () => {
    const id = job().id;
    g.values[1]![4] = 'CANCELLED';
    readSheet(h, g);
    assert.equal(h.store.getHolder(id, 1), null);
    assert.deepEqual(released().map((e) => (e.type === 'released' ? [e.notice.discordId, e.notice.reason] : null)), [[USER_A.discordId, 'cancelled']]);
    assert.throws(() => h.jobs.complete(id, USER_A.discordId));
  });

  it('a finished flight cannot be given back from an old menu', () => {
    const id = job().id;
    h.jobs.complete(id, USER_A.discordId);
    assert.deepEqual(h.jobs.release(id, USER_A.discordId), []);
    assert.equal(holder(), USER_A.discordId);
  });
});

/* ------------------------------------------------------------------ 3: one landing, one flight */

describe('one FsHub landing', () => {
  const AIRLINE_ID = 8123;
  const NOW = T0 + 6 * HOUR;
  let h: Harness;
  let d: DiscordHarness;
  let fshub: FakeFsHub;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = NOW;
    fshub = new FakeFsHub();
    d = makeDiscordHarness(h, { fshub });
    d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE_ID, fshubAirlineName: 'Test Air' });
    const window = { availableFrom: T0, deadline: T0 + 12 * HOUR, aircraft: 'A320' };
    h.jobs.sync(h.panel.id, [sj('first', 'EGLL-EGKK', window), sj('second', 'EGLL-EGKK', window)]);
    for (const j of h.store.listJobs(h.panel.id)) h.jobs.reserve(j.id, [1], USER_A);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const lands = (id: number, arrivedAt: number) => {
    const f: FsHubFlight = { id, pilotId: 1001, pilotName: 'Alice', dep: 'EGLL', arr: 'EGKK', departedAt: arrivedAt - HOUR, arrivedAt, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: 'ON-TIME' };
    fshub.flights.set(AIRLINE_ID, [...(fshub.flights.get(AIRLINE_ID) ?? []), f]);
  };
  const completed = () => h.store.listJobs(h.panel.id).filter((j) => j.completedAt !== null).length;

  it('completes one flight, not a second one at the next check', async () => {
    lands(4_900_001, NOW - 2 * HOUR);
    await d.ctx.autoComplete!.run();
    assert.equal(completed(), 1);
    h.clock.advance(HOUR);
    await d.ctx.autoComplete!.run();
    assert.equal(completed(), 1);
  });

  it('each flight ticked by hand in the sheet accounts for its own landing', async () => {
    h.clock.now = T0 + HOUR;
    const window = { availableFrom: T0, deadline: T0 + 24 * HOUR, aircraft: 'A320' };
    const keys = ['first', 'second', 'third'];
    const sheet = (done: string[]) => keys.map((k) => sj(k, 'EGLL-EGKK', { ...window, ...(done.includes(k) ? { completed: true, closed: true } : { completed: false }) }));
    h.jobs.sync(h.panel.id, sheet([]));
    for (const j of h.store.listJobs(h.panel.id)) if (!h.store.getHolder(j.id, 1)) h.jobs.reserve(j.id, [1], USER_A);
    lands(4_900_001, T0 + 2 * HOUR);
    h.clock.now = T0 + 3 * HOUR;
    h.jobs.sync(h.panel.id, sheet(['first']));
    lands(4_900_002, T0 + 6 * HOUR);
    h.clock.now = T0 + 7 * HOUR;
    h.jobs.sync(h.panel.id, sheet(['first', 'second']));
    await d.ctx.autoComplete!.run();
    assert.equal(completed(), 2, 'both landings are accounted for, so the third flight is still to be flown');
  });

  it('and the pilot who really flies twice gets both', async () => {
    lands(4_900_001, NOW - 2 * HOUR);
    await d.ctx.autoComplete!.run();
    h.clock.advance(HOUR);
    lands(4_900_002, h.clock.now - 10 * 60_000);
    await d.ctx.autoComplete!.run();
    assert.equal(completed(), 2);
  });
});

/* ------------------------------------------------------------------ 5: profit of another pilot's flight */

describe('profit fill and who flew it', () => {
  const row = (over: Partial<SheetFlight> = {}): SheetFlight => ({ row: 3, route: 'EGLL → EGCC', sourceKey: DAY_KEY, flightNumber: null, day: D12, pilot: 'Alex', completed: true, profit: null, profitRaw: '', payRaw: '', pilotPaid: null, ...over });
  const flew = (pilotName: string | null): LogFlight => ({ entryId: 1, flightId: 5000, callsign: 'TST101', dep: 'EGLL', arr: 'EGCC', pilotId: 7001, pilotName, profit: 12345.67, landedAt: D12 + 10 * HOUR, distanceNm: 500 });
  const samElsewhere = row({ row: 9, pilot: 'Sam', route: 'EGKK → EGPH', sourceKey: 'EGKK-EGPH@2026-11-12' });

  it('leaves the row alone when the only flight that fits was flown by another pilot of the sheet', () => {
    const got = pairRows([row(), samElsewhere], [flew('Sam')]);
    assert.deepEqual([got.pairs.length, got.others.length], [0, 1]);
    const analysis = compareProfits([row(), samElsewhere], [flew('Sam')], 'TST');
    assert.deepEqual([analysis.fills.length, analysis.others], [0, 1]);
    const report = profitReport('Test Air', { ...analysis, business: 77, aircraft: 1, leased: 0, leasedHidden: 0, leasedProblem: null, readAt: T0 });
    assert.match(report, /\*\*1\*\* is left alone: the only flight that fits was flown by another pilot the sheet names/);
  });

  it('still fills when the logbook\'s name is nobody the sheet knows, and says so before it is written', () => {
    const analysis = compareProfits([row()], [flew('Someone Unknown')], 'TST');
    assert.equal(analysis.fills[0]!.logbookPilot, 'Someone Unknown');
    const text = previewText('Test Air', analysis.fills);
    assert.match(text, /the logbook says Someone Unknown flew it, the sheet says Alex/);
    assert.match(text, /On row 3 the logbook's pilot is not the name in the sheet: check it before pressing \*\*Write\*\*/);
  });

  it('does not question the name where the sheet gives none', () => {
    assert.equal(compareProfits([row({ pilot: '' })], [flew('Alex')], 'TST').fills[0]!.logbookPilot, undefined);
  });

  it('says nothing extra when the names agree', () => {
    const analysis = compareProfits([row()], [flew('Alex')], 'TST');
    assert.equal(analysis.fills[0]!.logbookPilot, undefined);
    assert.doesNotMatch(previewText('Test Air', analysis.fills), /logbook/);
  });
});

/* ------------------------------------------------------------------ 10, 13: starting up, and the settings file */

describe('starting while Discord is having trouble', () => {
  const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

  it('is tried again', () => {
    assert.equal(explainStartFailure(httpError(503, 'Service Unavailable')).retry, true);
    assert.equal(explainStartFailure(httpError(502, 'Bad Gateway')).retry, true);
    assert.equal(explainStartFailure(httpError(429, 'Too Many Requests')).retry, true);
    assert.equal(explainStartFailure(new Error('This operation was aborted')).retry, true);
  });

  it('while a refused token is not', () => {
    assert.equal(explainStartFailure(httpError(401, '401: Unauthorized')).retry, false);
  });
});

describe('a settings file with something wrong in it', () => {
  const TOKEN = `${Buffer.from('123456789012345678').toString('base64')}.abcdef.${'x'.repeat(30)}`;
  let dir: string;
  let paths: HostPaths;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fpb-settings-'));
    paths = hostPaths(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the tokens when one other value is wrong, also after saving', () => {
    writeFileSync(paths.settings, JSON.stringify({ discordToken: TOKEN, fshubAccessToken: 'keep-me', logLevel: 'loud', dailyNoteFromHour: 99 }));
    const loaded = loadSettings(paths);
    assert.deepEqual([loaded.discordToken, loaded.fshubAccessToken, loaded.logLevel], [TOKEN, 'keep-me', 'info']);
    saveSettings(paths, loaded);
    assert.equal(loadSettings(paths).fshubAccessToken, 'keep-me');
    assert.equal(existsSync(`${paths.settings}.unreadable`), false);
  });

  it('keeps a copy of a file that cannot be read at all before writing over it', () => {
    const broken = '{ "discordToken": "' + TOKEN + '",';
    writeFileSync(paths.settings, broken);
    saveSettings(paths, loadSettings(paths));
    assert.equal(readFileSync(`${paths.settings}.unreadable`, 'utf8'), broken);
  });
});
