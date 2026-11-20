import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../src/db/db.js';
import { Store, type FlownFlight } from '../src/db/store.js';
import { commands, commandSet, componentHandlers, handlerSet } from '../src/discord/commands/index.js';
import { payrollCommand } from '../src/discord/commands/payroll.js';
import { PAYROLL_FLAG, payrollEnabled } from '../src/features.js';
import { amendModal, lineText, outcomeText, paginate, PayrollDaily, payrollHandler, renderList, sendList, tickText } from '../src/discord/payrollUi.js';
import { noPings } from '../src/discord/ui.js';
import { readSheetFlights, type SheetFlight } from '../src/services/contributions.js';
import { NotConnectedGateway, type PayRequest, type PayResult, type PaymentGateway } from '../src/services/payGateway.js';
import {
  amendLine,
  buildPayLines,
  cleanAccount,
  dateStamp,
  isAccount,
  looselySame,
  MAX_PAYMENT_CENTS,
  parseAmount,
  readPilotInfo,
  rowStillAgrees,
  summarise,
  type IdentityBook,
  type LedgerView,
  type PayDraft,
  type PayLine,
  type PilotInfoRow,
} from '../src/services/payroll.js';
import { Payroll, PayrollError } from '../src/services/payrollService.js';
import { SheetWriteBack, WriteBackError } from '../src/services/writeback.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { HOUR, makeHarness, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { FakeGoogle, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';
import type { BotContext } from '../src/discord/context.js';
import { FakeChannel, FakeFsHub, fakeComponent, fakeInteraction, fakeModal, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';

/* Everything below is made up: the airline, its pilots, their accounts and their flights. */

const { account: googleAccount, publicKey } = makeServiceAccount();
const D10 = Date.UTC(2026, 10, 10);
const D11 = Date.UTC(2026, 10, 11);
const SOURCE = '9954-0000123';

/* ------------------------------------------------------------------ the pure part */

const csv = (rows: string[][]) => rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');

const flight = (over: Partial<SheetFlight> = {}): SheetFlight => ({
  row: 2,
  route: 'KORD → EGLL',
  sourceKey: 'KORD-EGLL@2026-11-10',
  flightNumber: null,
  day: D10,
  pilot: 'Alex Smith',
  completed: true,
  profit: null,
  profitRaw: '',
  payRaw: '$7,500',
  pilotPaid: false,
  ...over,
});

const none: LedgerView = { isTaken: () => false, hasUniqueId: () => false, failedIdFor: () => null, lastAccount: () => null };
const book = (known: Record<number, string[]> = { 32411: ['Alex Smith'], 41502: ['Sam Jones'] }, ties: Record<string, number[]> = {}): IdentityBook => ({
  idsForName: (name) => ties[name.toLowerCase()] ?? [],
  namesForId: (id) => known[id] ?? [],
  knowsId: (id) => id in known,
});
const info = (over: Partial<PilotInfoRow> = {}): PilotInfoRow => ({ row: 2, name: 'Alex Smith', fshubId: 32411, account: '2002-0001111', ...over });

const build = (flights: SheetFlight[], infoRows: PilotInfoRow[] = [info()], extra: { ledger?: Partial<LedgerView>; identities?: IdentityBook; startDay?: number | null; ref?: (f: SheetFlight) => string | null; distances?: Map<string, number> } = {}) =>
  buildPayLines({ flights, info: infoRows, startDay: extra.startDay ?? null, ledger: { ...none, ...extra.ledger }, identities: extra.identities ?? book(), flightRef: extra.ref ?? (() => null), ...(extra.distances ? { distances: extra.distances } : {}) });

describe('the Pilot Info tab', () => {
  it('finds the name, FsHub ID and bank account columns by their titles, and tidies what is in them', () => {
    const read = readPilotInfo(csv([['Pilot', 'Rank', 'FSHUB ID', 'Bank Acct'], ['Alex Smith', 'Captain', '32411', ' 2002 – 0001111 '], ['Sam Jones', '', 'https://fshub.io/pilot/41502/overview', '2002-0002222'], ['', '', '', ''], ['Jo Kim', '', 'n/a', '']]));
    assert.ok(read.ok);
    assert.deepEqual(
      read.rows.map((r) => [r.row, r.name, r.fshubId, r.account]),
      [
        [2, 'Alex Smith', 32411, '2002-0001111'],
        [3, 'Sam Jones', 41502, '2002-0002222'],
        [5, 'Jo Kim', null, ''],
      ],
    );
  });

  it('finds them under other titles and below a few rows of notes', () => {
    const read = readPilotInfo(csv([['Our pilots'], [''], ['Name', 'FsHub Pilot ID', 'Bank Account'], ['Alex Smith', '32411', '2002-0001111']]));
    assert.ok(read.ok);
    assert.deepEqual(read.rows, [{ row: 4, name: 'Alex Smith', fshubId: 32411, account: '2002-0001111' }]);
  });

  it('refuses a tab that lacks one of the three, and says which titles it did see', () => {
    for (const grid of [[['Pilot', 'FSHUB ID'], ['A', '1']], [['Pilot', 'Bank Acct'], ['A', '2002-0001111']], [['FSHUB ID', 'Bank Acct'], ['1', '2002-0001111']]]) {
      const read = readPilotInfo(csv(grid));
      assert.ok(!read.ok);
      assert.match(read.reason, /name, a FsHub ID and a bank account column/);
      assert.deepEqual(read.headers, grid[0]);
    }
    assert.ok(!readPilotInfo('').ok);
  });
});

describe('money and numbers', () => {
  it('knows an account number, and makes what was written into one', () => {
    assert.equal(cleanAccount(' 9954 – 0000123\n'), '9954-0000123');
    for (const good of ['9954-0000123', '2002-000', '2002-123456789012']) assert.ok(isAccount(good), good);
    for (const bad of ['', '9954', '99540000123', '9954-12', 'abcd-0000123', '9954-0000123-1', '99-0000123', '9954-1234567890123']) assert.ok(!isAccount(bad), bad);
  });

  it('reads an amount as an admin types it', () => {
    assert.deepEqual(parseAmount('8131'), { cents: 813100 });
    assert.deepEqual(parseAmount(' $8,131.50 '), { cents: 813150 });
    assert.deepEqual(parseAmount('0.5'), { cents: 50 });
    for (const out of ['0', '0.00', 'skip', 'REMOVE', '-', 'out']) assert.deepEqual(parseAmount(out), { out: true }, out);
    for (const bad of ['', 'lots', '8131.555', '-5', '1e3', '$', '8 131x']) assert.ok('error' in parseAmount(bad), bad);
    assert.deepEqual(parseAmount('500000'), { cents: MAX_PAYMENT_CENTS });
    assert.ok('error' in parseAmount('500000.01'), 'one cent over the most one payment may be');
  });

  it('writes the date as month, day and two-digit year', () => {
    assert.equal(dateStamp(Date.UTC(2026, 10, 19)), '111926');
    assert.equal(dateStamp(Date.UTC(2027, 0, 5)), '010527');
  });

  it('takes names as the same when one has the words of the other', () => {
    assert.ok(looselySame('Alex Smith', 'alex smith'));
    assert.ok(looselySame('Alex', 'Alex Smith'));
    assert.ok(looselySame('Alex-Smith', 'AlexSmith'));
    assert.ok(!looselySame('Alex Smith', 'Sam Jones'));
    assert.ok(!looselySame('', 'Alex'));
  });
});

describe('making the list of payments', () => {
  it("names each payment with the pilot's FsHub ID, the airports and the date, and sorts them oldest first", () => {
    const { lines } = build(
      [flight({ row: 9, day: D11, route: 'EGLL → EGCC', pilot: 'Sam Jones', sourceKey: 'b' }), flight({ row: 4, sourceKey: 'a' })],
      [info(), info({ row: 3, name: 'Sam Jones', fshubId: 41502, account: '2002-0002222' })],
    );
    assert.deepEqual(
      lines.map((l) => [l.n, l.pilot, l.account, l.cents, l.uniqueId, l.flags]),
      [
        [1, 'Alex Smith', '2002-0001111', 750000, '32411-KORD-EGLL-111026', []],
        [2, 'Sam Jones', '2002-0002222', 750000, '41502-EGLL-EGCC-111126', []],
      ],
    );
  });

  it("adds the flight's number when the same pilot flew the same route twice in a day, to each of the two", () => {
    const { lines } = build([flight({ row: 2, sourceKey: 'a' }), flight({ row: 3, sourceKey: 'b' })], [info()], { ref: (f) => (f.sourceKey === 'a' ? 'WLF516' : 'WLF-517') });
    assert.deepEqual(lines.map((l) => l.uniqueId), ['32411-KORD-EGLL-111026-516', '32411-KORD-EGLL-111026-517']);
  });

  it('uses the sheet row when there is no flight number to add, and never gives two payments the same ID', () => {
    const { lines } = build([flight({ row: 12, sourceKey: 'a' }), flight({ row: 13, sourceKey: 'b' }), flight({ row: 14, sourceKey: 'c' })], [info()], { ref: (f) => (f.sourceKey === 'c' ? 'WLF900' : f.sourceKey === 'b' ? 'WLF900' : null) });
    assert.deepEqual(lines.map((l) => l.uniqueId), ['32411-KORD-EGLL-111026-r12', '32411-KORD-EGLL-111026-900', '32411-KORD-EGLL-111026-900-2']);
    assert.equal(new Set(lines.map((l) => l.uniqueId)).size, 3);
  });

  it('adds the number too when the plain ID was already used for a payment made earlier', () => {
    const { lines } = build([flight({ sourceKey: 'second' })], [info()], { ledger: { hasUniqueId: (id) => id === '32411-KORD-EGLL-111026' }, ref: () => 'WLF516' });
    assert.deepEqual(lines.map((l) => l.uniqueId), ['32411-KORD-EGLL-111026-516']);
  });

  it('puts a flight on the list only once it is completed, has a pay, is not already paid, and is not before the first day to pay', () => {
    const { lines, waiting } = build(
      [
        flight({ row: 2, sourceKey: 'ok' }),
        flight({ row: 3, sourceKey: 'notdone', completed: false }),
        flight({ row: 4, sourceKey: 'ticked', pilotPaid: true }),
        flight({ row: 5, sourceKey: 'nopay', payRaw: '$0' }),
        flight({ row: 6, sourceKey: 'blank', payRaw: '' }),
        flight({ row: 7, sourceKey: 'text', payRaw: 'TBD' }),
        flight({ row: 8, sourceKey: 'nopilot', pilot: ' ' }),
        flight({ row: 9, sourceKey: 'early', day: D10 - 86_400_000 }),
        flight({ row: 10, sourceKey: 'ledger' }),
        flight({ row: 11, sourceKey: 'nocolumn', payRaw: null }),
      ],
      [info()],
      { startDay: D10, ledger: { isTaken: (key) => key === 'ledger' } },
    );
    assert.deepEqual(lines.map((l) => l.sourceKey), ['ok']);
    assert.equal(waiting, 4, 'completed, not paid, in range, and no amount yet: nopay, blank, text and nocolumn');
  });

  it('takes a payment that failed again under the same unique ID', () => {
    const { lines } = build([flight()], [info()], { ledger: { failedIdFor: () => '32411-KORD-EGLL-111026-old', hasUniqueId: () => true } });
    assert.equal(lines[0]!.uniqueId, '32411-KORD-EGLL-111026-old');
  });

  it('flags a pilot who is not on the tab, who is on it twice, who has no account or one that is not an account', () => {
    const flightsOf = (name: string) => [flight({ pilot: name })];
    const flagsFor = (name: string, rows: PilotInfoRow[]) => build(flightsOf(name), rows).lines[0]!.flags;
    assert.deepEqual(flagsFor('Pat Lee', [info()]), ['no-info']);
    assert.deepEqual(flagsFor('Alex Smith', [info(), info({ row: 5, account: '2002-0009999' })]), ['ambiguous-info']);
    assert.deepEqual(flagsFor('Alex Smith', [info({ account: '' })]), ['no-account']);
    assert.deepEqual(flagsFor('Alex Smith', [info({ account: '12345' })]), ['bad-account']);
    assert.deepEqual(flagsFor('alex smith', [info()]), [], 'capital letters do not matter');
    assert.equal(build(flightsOf('Pat Lee'), [info()]).lines[0]!.uniqueId, 'NOID-KORD-EGLL-111026');
  });

  it("flags an amount that is not a sensible one, whether or not the pilot is known", () => {
    for (const rows of [[info()], []]) {
      const lines = build([flight({ payRaw: '$500,000.01' })], rows).lines;
      assert.ok(lines[0]!.flags.includes('bad-amount'));
    }
    assert.deepEqual(build([flight({ payRaw: '$500,000' })]).lines[0]!.flags, []);
  });

  it("pays no less than the $2,000 minimum, whatever the Pilot Pay cell says, and keeps what the sheet had so the list can say so", () => {
    const lines = build([
      flight({ row: 2, sourceKey: 'share', payRaw: '$34' }), // Aeroconomy's own 15% of a $225 profit
      flight({ row: 3, sourceKey: 'edge', payRaw: '$1,999.99' }),
      flight({ row: 4, sourceKey: 'exact', payRaw: '$2,000' }),
      flight({ row: 5, sourceKey: 'over', payRaw: '$2,000.01' }),
      flight({ row: 6, sourceKey: 'big', payRaw: '$7,500' }),
      flight({ row: 7, sourceKey: 'tiny', payRaw: '$0.50' }),
    ]).lines;
    assert.deepEqual(
      lines.map((l) => [l.cents, l.sheetCents]),
      [
        [200000, 3400],
        [200000, 199999],
        [200000, undefined],
        [200001, undefined],
        [750000, undefined],
        [200000, 50],
      ],
    );
    assert.ok(lines.every((l) => l.flags.length === 0), 'raising to the minimum is the rule, not something to check by hand');
    assert.ok(!('sheetCents' in lines[2]!), 'nothing is noted when the sheet already had the minimum or more');
  });

  describe('a flight that lost money', () => {
    const lost = (key: string, pay: string, profit = -5000) => flight({ row: 2, sourceKey: key, profit, profitRaw: `-$${Math.abs(profit)}`, payRaw: pay });
    const payFor = (pay: string, nm: number | null, profit = -5000) => {
      const line = build([lost('k', pay, profit)], [info()], nm === null ? {} : { distances: new Map([['k', nm]]) }).lines[0]!;
      return [line.cents / 100, line.sheetCents === undefined ? null : line.sheetCents / 100, line.lossNm ?? null, line.flags] as const;
    };

    it('is paid $2,000 for the first 1,000 nm and $1,000 more for each further 500 nm, a started 500 counting as a whole one', () => {
      for (const [nm, expected] of [
        [0, 2000],
        [400, 2000],
        [999.9, 2000],
        [1000, 2000],
        [1000.1, 3000],
        [1001, 3000],
        [1499, 3000],
        [1500, 3000],
        [1501, 4000],
        [1502, 4000],
        [2000, 4000],
        [2001, 5000],
        [2100, 5000],
        [3000, 6000],
        [5000, 10000],
      ] as const) {
        assert.equal(payFor('$500', nm)[0], expected, `${nm} nm`);
      }
    });

    it('says what the sheet had, and the distance it worked from, when it raised the pay', () => {
      assert.deepEqual(payFor('$500', 2100), [5000, 500, 2100, []]);
      assert.deepEqual(payFor('$2,000', 1200), [3000, 2000, 1200, []]);
    });

    it("pays what the sheet says when that is already as much as the rule, or more (a manager's own bigger figure)", () => {
      assert.deepEqual(payFor('$3,000', 1200), [3000, null, 1200, []]);
      assert.deepEqual(payFor('$3,500', 1200), [3500, null, 1200, []]);
    });

    it('is raised only to the minimum, and flagged, when FsHub has no distance for it', () => {
      assert.deepEqual(payFor('$500', null), [2000, 500, null, ['no-distance']]);
      assert.deepEqual(payFor('$2,000', null), [2000, null, null, ['no-distance']]);
      assert.deepEqual(payFor('$5,000', null), [5000, null, null, ['no-distance']], 'what the sheet says is kept, but it cannot be checked');
    });

    it('does not use a distance for a flight that made a profit, or for one with no profit written yet', () => {
      assert.deepEqual(payFor('$34', 3000, 225), [2000, 34, null, []]);
      assert.deepEqual(payFor('$34', 3000, 0), [2000, 34, null, []]);
      const blank = build([flight({ payRaw: '$34', profit: null })], [info()], { distances: new Map([['KORD-EGLL@2026-11-10', 3000]]) }).lines[0]!;
      assert.deepEqual([blank.cents, blank.lossNm, blank.flags], [200000, undefined, []]);
    });

    it('keeps each flight to its own distance', () => {
      const lines = build([lost('a', '$100'), { ...lost('b', '$100'), row: 3 }, { ...lost('c', '$100'), row: 4 }], [info()], { distances: new Map([['a', 1200], ['c', 2600]]) }).lines;
      assert.deepEqual(lines.map((l) => [l.cents / 100, l.flags]), [[3000, []], [2000, ['no-distance']], [6000, []]]);
    });
  });

  it('knows whether a row still says what a payment on a list was made from', () => {
    const plain = { cents: 750000 };
    assert.ok(rowStillAgrees(plain, { payRaw: '$7,500', profit: 10_000 }));
    assert.ok(!rowStillAgrees(plain, { payRaw: '$7,600', profit: 10_000 }));
    assert.ok(!rowStillAgrees(plain, { payRaw: '', profit: 10_000 }));
    const raised = { cents: 200000, sheetCents: 3400 };
    assert.ok(rowStillAgrees(raised, { payRaw: '$34', profit: 225 }), 'the cell still says $34');
    assert.ok(!rowStillAgrees(raised, { payRaw: '$2,000', profit: 225 }), 'but not once somebody changed it');
    const byDistance = { cents: 500000, sheetCents: 200000, lossNm: 2100 };
    assert.ok(rowStillAgrees(byDistance, { payRaw: '$2,000', profit: -5000 }));
    assert.ok(!rowStillAgrees(byDistance, { payRaw: '$2,000', profit: 5000 }), 'no longer a loss, so the distance does not apply');
    assert.ok(!rowStillAgrees(byDistance, { payRaw: '$2,000', profit: null }));
  });

  it('still leaves a flight with no pay yet off the list, even though the minimum is $2,000', () => {
    const { lines, waiting } = build([flight({ sourceKey: 'zero', payRaw: '$0' }), flight({ row: 3, sourceKey: 'blank', payRaw: '' })]);
    assert.deepEqual([lines.length, waiting], [0, 2]);
  });

  it('cross-checks the tab against what the bot knows of each person', () => {
    const lineOf = (infoRow: PilotInfoRow, identities: IdentityBook, ledger: Partial<LedgerView> = {}, pilot = 'Alex Smith') => build([flight({ pilot })], [infoRow], { identities, ledger }).lines[0]!.flags;
    assert.deepEqual(lineOf(info(), book()), [], 'a known ID under the same name');
    assert.deepEqual(lineOf(info({ fshubId: null }), book()), ['unknown-id'], 'no ID on the tab');
    assert.deepEqual(lineOf(info({ fshubId: 99999 }), book()), ['unknown-id'], 'an ID nobody has heard of');
    assert.deepEqual(lineOf(info(), book({ 32411: ['Somebody Else'] })), ['name-differs'], 'FsHub knows the ID by another name');
    assert.deepEqual(lineOf(info(), book({ 32411: ['Alex'] })), [], 'a shorter name is the same person');
    assert.deepEqual(lineOf(info(), book({ 32411: [] })), [], 'a known ID with no name to compare');
    assert.deepEqual(lineOf(info(), book({ 32411: ['Alex Smith'] }, { 'alex smith': [11111] })), ['id-mismatch'], 'the bot ties this name to a different ID');
    assert.deepEqual(lineOf(info(), book({ 32411: ['Somebody Else'] }, { 'alex smith': [32411] })), [], 'the bot ties the sheet name to this very ID: no need to compare FsHub\'s name');
    assert.deepEqual(lineOf(info(), book(), { lastAccount: () => '2002-0005555' }), ['account-changed']);
    assert.deepEqual(lineOf(info(), book(), { lastAccount: () => '2002-0001111' }), []);
    assert.deepEqual(lineOf(info({ account: '' }), book(), { lastAccount: () => '2002-0001111' }), ['no-account'], 'no account is not a changed one');
  });
});

describe('amending a payment', () => {
  const line = (over: Partial<PayLine> = {}): PayLine => ({ n: 1, sourceKey: 'a', row: 2, pilot: 'Pat Lee', fshubId: null, account: null, cents: 300000, uniqueId: 'NOID-EGLL-EGKK-111026', dep: 'EGLL', arr: 'EGKK', day: D10, flags: ['no-info'], amended: false, out: false, ...over });
  const two = [line(), line({ n: 2, sourceKey: 'b', uniqueId: 'second', account: '2002-0001111', flags: [] })];
  const fields = { account: '2002-0003333', amount: '3000', uniqueId: 'NOID-EGLL-EGKK-111026' };
  const never = (_id: string) => false;

  it('changes the payment, marks it as amended, and clears what was flagged', () => {
    const done = amendLine(two, 1, { account: ' 2002 – 0003333', amount: '$3,250.50', uniqueId: ' 55555-EGLL-EGKK-111026 ' }, never);
    assert.ok(done.ok);
    assert.deepEqual(done.lines[0], line({ account: '2002-0003333', cents: 325050, uniqueId: '55555-EGLL-EGKK-111026', flags: [], amended: true }));
    assert.deepEqual(done.lines[1], two[1], 'the others are as they were');
    assert.deepEqual(two[0], line(), 'and the list it was made from is not changed');
    assert.equal(summarise(done.lines).ready.length, 2);
  });

  it('takes submitting a flagged payment unchanged as saying it has been checked', () => {
    const flagged = [line({ account: '2002-0003333', flags: ['name-differs'] })];
    const done = amendLine(flagged, 1, { account: '2002-0003333', amount: '3000', uniqueId: 'NOID-EGLL-EGKK-111026' }, never);
    assert.ok(done.ok);
    assert.deepEqual([done.lines[0]!.flags, done.lines[0]!.amended], [[], true]);
  });

  it('leaves a payment out of the run when its amount is made 0, and brings it back when it is not', () => {
    const out = amendLine(two, 2, { ...fields, account: '2002-0001111', amount: '0', uniqueId: 'second' }, never);
    assert.ok(out.ok);
    assert.deepEqual([out.lines[1]!.out, out.lines[1]!.cents], [true, 300000], 'its amount is kept');
    assert.equal(summarise(out.lines).out, 1);
    assert.equal(summarise(out.lines).ready.length, 0);
    const back = amendLine(out.lines, 2, { account: '2002-0001111', amount: '3000', uniqueId: 'second' }, never);
    assert.ok(back.ok);
    assert.equal(back.lines[1]!.out, false);
  });

  it('refuses what is not right, and changes nothing', () => {
    const refused = (f: Partial<typeof fields>, n = 1, taken = never) => {
      const r = amendLine(two, n, { ...fields, ...f }, taken);
      assert.ok(!r.ok, JSON.stringify(f));
      return r.error;
    };
    assert.match(refused({ account: '12345' }), /isn't an account number/);
    assert.match(refused({ account: '' }), /isn't an account number/);
    assert.match(refused({ amount: 'lots' }), /number of dollars/);
    assert.match(refused({ amount: '500000.01' }), /between \$0\.01 and \$500,000/);
    assert.match(refused({ uniqueId: 'x' }), /3 to 64 letters/);
    assert.match(refused({ uniqueId: 'has space' }), /3 to 64 letters/);
    assert.match(refused({ uniqueId: 'second' }), /Another payment on this list already has the unique ID second/);
    assert.match(refused({ uniqueId: 'used-before' }, 1, (id) => id === 'used-before'), /has been used for a payment before/);
    assert.match(refused({}, 7), /no payment number 7/);
  });

  it("lets a payment keep its own unique ID even though the ledger has it (it is the ledger's own retry of a failure)", () => {
    const r = amendLine(two, 1, fields, (id) => id === 'NOID-EGLL-EGKK-111026');
    assert.ok(r.ok);
  });
});

/* ------------------------------------------------------------------ the ledger and the settings */

describe('keeping the settings, the ledger and the lists', () => {
  let store: Store;
  let panelId: number;
  beforeEach(async () => {
    const h = await makeHarness();
    store = h.store;
    panelId = h.panel.id;
  });
  const entry = (over: Partial<{ uniqueId: string; sourceKey: string | null; pilot: string; fshubId: number | null; account: string; cents: number }> = {}) => ({ uniqueId: 'u1', sourceKey: 'k1', pilot: 'Alex Smith', fshubId: 32411, account: '2002-0001111', cents: 750000, ...over });

  it('starts with no settings and changes only what it is told to', () => {
    assert.equal(store.getPayrollSettings(panelId), null);
    assert.deepEqual(store.listPayrollEnabled(), []);
    const first = store.savePayrollSettings(panelId, { sourceAccount: SOURCE });
    assert.deepEqual(first, { panelId, enabled: false, sourceAccount: SOURCE, infoSheetId: null, infoGid: null, startDay: null, runAtMinute: 720, ownerId: null, lastRunDay: null });
    const second = store.savePayrollSettings(panelId, { enabled: true, infoSheetId: 'sheet', infoGid: '5', startDay: D10, runAtMinute: 60, ownerId: 'u', lastRunDay: D11 });
    assert.deepEqual(second, { panelId, enabled: true, sourceAccount: SOURCE, infoSheetId: 'sheet', infoGid: '5', startDay: D10, runAtMinute: 60, ownerId: 'u', lastRunDay: D11 });
    assert.equal(store.listPayrollEnabled().length, 1);
    assert.throws(() => store.savePayrollSettings(panelId, { runAtMinute: 1440 }), /minute from 0 to 1439/);
    assert.throws(() => store.savePayrollSettings(panelId, { runAtMinute: -1 }), /minute from 0 to 1439/);
  });

  it('writes a payment down before it is sent, and never lets the same unique ID be sent twice', () => {
    assert.equal(store.ledgerBegin(panelId, entry(), T0), true);
    assert.equal(store.ledgerByUniqueId(panelId, 'u1')!.status, 'sending');
    assert.equal(store.ledgerBegin(panelId, entry(), T0 + 1), false, 'being sent');
    store.ledgerFinish(panelId, 'u1', 'paid', 'ref-1', T0 + 2);
    assert.equal(store.ledgerBegin(panelId, entry(), T0 + 3), false, 'paid');
    assert.deepEqual(store.ledgerBySourceKey(panelId, 'k1'), { id: 1, panelId, uniqueId: 'u1', sourceKey: 'k1', pilot: 'Alex Smith', fshubId: 32411, account: '2002-0001111', cents: 750000, status: 'paid', detail: 'ref-1', createdAt: T0, updatedAt: T0 + 2 });
  });

  it('lets only a payment that failed be tried again, under the same unique ID', () => {
    store.ledgerBegin(panelId, entry(), T0);
    store.ledgerFinish(panelId, 'u1', 'failed', 'not enough money', T0 + 1);
    assert.equal(store.ledgerBegin(panelId, entry({ account: '2002-0002222', cents: 100 }), T0 + 2), true);
    const again = store.ledgerByUniqueId(panelId, 'u1')!;
    assert.deepEqual([again.status, again.detail, again.account, again.cents], ['sending', null, '2002-0002222', 100]);
    assert.equal(store.listLedger(panelId, 10).length, 1, 'still one row');
  });

  it('remembers the account a pilot was last paid into, and counts payments nobody settled', () => {
    assert.equal(store.lastPaidAccount(panelId, 32411), null);
    store.ledgerBegin(panelId, entry({ uniqueId: 'a', account: '2002-0001111' }), T0);
    store.ledgerFinish(panelId, 'a', 'paid', null, T0 + 1);
    store.ledgerBegin(panelId, entry({ uniqueId: 'b', sourceKey: 'k2', account: '2002-0004444' }), T0 + 2);
    store.ledgerFinish(panelId, 'b', 'failed', 'no', T0 + 3);
    store.ledgerBegin(panelId, entry({ uniqueId: 'c', sourceKey: 'k3', account: '2002-0005555' }), T0 + 4);
    assert.equal(store.lastPaidAccount(panelId, 32411), '2002-0001111', 'a failed or unsettled payment does not count');
    assert.equal(store.countUnsettledPayments(panelId), 1);
    store.ledgerFinish(panelId, 'c', 'paid', null, T0 + 5);
    assert.equal(store.lastPaidAccount(panelId, 32411), '2002-0005555', 'the latest one');
    assert.deepEqual(store.listLedger(panelId, 2).map((r) => r.uniqueId), ['c', 'b'], 'newest first');
  });

  it('ties a sheet name and a FsHub ID together from what pilots told it, and knows the IDs it has heard of', () => {
    store.setPilotId('d-alex', 32411, T0, 'Alex Smith');
    store.setPilotName('d-alex', 'Alexander', T0);
    assert.deepEqual(store.fshubIdsForSheetName('alexander'), [32411]);
    assert.deepEqual(store.fshubIdsForSheetName('Nobody'), []);
    assert.deepEqual(store.fshubNamesForId(panelId, 32411), ['Alex Smith']);
    assert.equal(store.knowsFshubId(panelId, 32411), true);
    assert.equal(store.knowsFshubId(panelId, 777), false);
  });

  it('keeps a list, takes it away for one caller only, and lets old ones go', () => {
    const base = { token: 't1', panelId, askerId: 'u', place: 'dm', body: '{"a":1}', createdAt: T0, expiresAt: T0 + HOUR };
    store.savePayrollDraft(base);
    assert.equal(store.getPayrollDraft('t1', T0)!.body, '{"a":1}');
    assert.equal(store.getPayrollDraft('t1', T0 + HOUR), null, 'it has run out');
    store.savePayrollDraft({ ...base, body: '{"a":2}', expiresAt: T0 + 2 * HOUR });
    assert.equal(store.getPayrollDraft('t1', T0 + HOUR)!.body, '{"a":2}');
    assert.equal(store.deletePayrollDraft('t1'), true);
    assert.equal(store.deletePayrollDraft('t1'), false, 'only the first call took it');
    store.savePayrollDraft(base);
    store.savePayrollDraft({ ...base, token: 't2' });
    store.clearPayrollDrafts(panelId, T0);
    assert.equal(store.getPayrollDraft('t1', T0), null);
    assert.equal(store.getPayrollDraft('t2', T0), null);
  });

  it('upgrades a database made before paying pilots existed', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const step = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE payroll_settings'));
    assert.ok(step >= 33);
    for (let v = 0; v < step; v++) {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    assert.ok(!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'payroll_payments'`).get());
    db.exec(MIGRATIONS[step] as string);
    for (const t of ['payroll_settings', 'payroll_payments', 'payroll_drafts']) assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get(t), t);
  });

  it('keeps which pay cells the bot wrote, per flight, in a table that a database made before it gets with the upgrade', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    const step = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE pay_writes'));
    assert.ok(step >= 34);
    for (let v = 0; v < step; v++) db.exec(MIGRATIONS[v] as string);
    assert.ok(!db.prepare(`SELECT name FROM sqlite_master WHERE name = 'pay_writes'`).get());
    db.exec(MIGRATIONS[step] as string);
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'pay_writes'`).get());
  });

  it('remembers each written pay once per flight (the newest wins), forgets them with the panel, and tells panels apart', async () => {
    const h = await makeHarness();
    try {
      const other = h.store.createPanel({ guildId: 'g2', name: 'Other Air', prefix: 'OTH', channelId: 'c2', now: T0 });
      h.store.recordPayWrites(h.panel.id, [{ sourceKey: 'a', cents: 100 }, { sourceKey: 'b', cents: 200 }], T0);
      h.store.recordPayWrites(h.panel.id, [{ sourceKey: 'a', cents: 300 }], T0 + 1);
      h.store.recordPayWrites(other.id, [{ sourceKey: 'z', cents: 100 }], T0);
      assert.deepEqual([...h.store.payWrittenKeys(h.panel.id)].sort(), ['a', 'b']);
      assert.deepEqual([...h.store.payWrittenKeys(other.id)], ['z']);
      assert.deepEqual([...h.store.payWrittenKeys(99999)], []);
    } finally {
      await h.close();
    }
  });
});

/* ------------------------------------------------------------------ reading the sheets, and paying */

const SCHEDULE_GID = String(TAB_GID);
const INFO_GID = '222';
const SCHEDULE_HEADER = ['Route', 'Date', 'Landing Window Zulu', 'Pilot', 'Backup Pilot', 'Aircraft', 'Flight Completed (by Pilot)', 'Pilot Paid', 'Profit Made', 'Pilot Pay'];
const srow = (route: string, date: string, pilot: string, o: { done?: boolean; paid?: boolean; pay?: string } = {}): string[] => [route, date, '0600-2359z', pilot, '', 'A320', o.done === false ? 'FALSE' : 'TRUE', o.paid ? 'TRUE' : 'FALSE', '$10,000.00', o.pay ?? '$7,500'];

const schedule = (): string[][] => [
  SCHEDULE_HEADER,
  srow('KORD-EGLL', '11/10/2026', 'Alex Smith'), // row 2
  srow('EGLL-EGCC', '11/10/2026', 'Sam Jones', { pay: '$2,000' }), // row 3
  srow('EGLL-EGKK', '11/10/2026', 'Pat Lee', { pay: '$3,000' }), // row 4: not on the Pilot Info tab
  srow('EGKK-EGLL', '11/11/2026', 'Jo Kim', { pay: '$2,500' }), // row 5: no account
  srow('KMIA-KORD', '11/11/2026', 'Alex Smith', { pay: '$0' }), // row 6: nothing to pay yet
  srow('EGCC-EGLL', '11/11/2026', 'Sam Jones', { done: false }), // row 7: not flown
  srow('EGLL-LFPG', '11/10/2026', 'Alex Smith', { paid: true }), // row 8: already paid by hand
];
const pilotInfo = (): string[][] => [
  ['Pilot', 'FSHUB ID', 'Bank Acct'],
  ['Alex Smith', '32411', '2002-0001111'],
  ['Sam Jones', '41502', '2002-0002222'],
  ['Jo Kim', '50003', ''],
];

class FakeGateway implements PaymentGateway {
  connected = true;
  calls: PayRequest[] = [];
  refuse = new Map<string, string>();
  silent = new Set<string>();
  async pay(request: PayRequest): Promise<PayResult> {
    this.calls.push(request);
    if (this.silent.has(request.uniqueId)) throw new Error('timed out');
    const why = this.refuse.get(request.uniqueId);
    return why ? { ok: false, reason: why } : { ok: true, reference: `ref-${this.calls.length}` };
  }
}

describe('paying pilots', () => {
  let h: Harness;
  let sheets: { schedule: string[][]; info: string[][]; status: number };
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let gw: FakeGateway;
  let payroll: Payroll;
  let reads: string[];

  const fetchFn = (async (url: string) => {
    reads.push(String(url));
    if (sheets.status !== 200) return new Response('nope', { status: sheets.status });
    const grid = String(url).includes(`gid=${INFO_GID}`) ? sheets.info : g.values;
    return new Response(csv(grid), { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as unknown as typeof fetch;

  const settings = () => h.store.getPayrollSettings(h.panel.id)!;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const byPilot = (draft: PayDraft, name: string, nth = 0) => draft.lines.filter((l) => l.pilot === name)[nth]!;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = schedule();
    // The schedule the bot reads and the one it writes to are the same tab: what the fake Google holds.
    sheets = {
      get schedule() {
        return g.values;
      },
      set schedule(v: string[][]) {
        g.values = v;
      },
      info: pilotInfo(),
      status: 200,
    };
    reads = [];
    gw = new FakeGateway();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(googleAccount, g.fetchFn, () => h.clock.now), g.fetchFn), googleAccount.email, { now: () => h.clock.now });
    payroll = new Payroll({ store: h.store, gateway: gw, writeback: wb, fetchFn, now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: SCHEDULE_GID, writeback: true });
    h.store.savePayrollSettings(h.panel.id, { enabled: true, sourceAccount: SOURCE, infoSheetId: SHEET_ID, infoGid: INFO_GID, startDay: D10, ownerId: USER_A.discordId });
    h.store.setPilotId('d-alex', 32411, T0, 'Alex Smith');
    h.store.setPilotId('d-sam', 41502, T0, 'Sam Jones');
    h.store.setPilotId('d-jo', 50003, T0, 'Jo Kim');
  });

  describe('the list', () => {
    it('is made from the schedule and the Pilot Info tab, with the unique IDs, and flags what needs a look', async () => {
      const draft = await payroll.prepare(panel(), settings());
      assert.deepEqual(draft.lines.map((l) => [l.n, l.pilot, l.account, l.cents, l.uniqueId, l.flags]), [
        [1, 'Alex Smith', '2002-0001111', 750000, '32411-KORD-EGLL-111026', []],
        [2, 'Sam Jones', '2002-0002222', 200000, '41502-EGLL-EGCC-111026', []],
        [3, 'Pat Lee', null, 300000, 'NOID-EGLL-EGKK-111026', ['no-info']],
        [4, 'Jo Kim', null, 250000, '50003-EGKK-EGLL-111126', ['no-account']],
      ]);
      assert.equal(draft.waiting, 1, 'the $0 flight has no pay yet');
      assert.equal(draft.unsettled, 0);
      assert.equal(draft.sourceAccount, SOURCE);
      assert.equal(draft.airline, 'Test Air');
      assert.equal(gw.calls.length, 0, 'making a list sends nothing');
      assert.equal(reads.length, 2, 'one read of each tab');
      assert.ok(reads.every((u) => u.startsWith('https://docs.google.com/spreadsheets/d/')), 'only Google Sheets is ever asked');
    });

    it("uses the airline's own flight number when the bot has one for the flight (two of the same route on one day)", async () => {
      sheets.schedule.push(srow('KORD-EGLL', '11/10/2026', 'Alex Smith')); // row 9: the same route, the same day
      const draft = await payroll.prepare(panel(), settings());
      const alex = draft.lines.filter((l) => l.pilot === 'Alex Smith').map((l) => l.uniqueId);
      assert.deepEqual(alex, ['32411-KORD-EGLL-111026-r2', '32411-KORD-EGLL-111026-r9']);
    });

    it('says what is missing before it reads anything', async () => {
      h.store.savePayrollSettings(h.panel.id, { sourceAccount: null });
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /which account the pay comes out of/.test(e.message));
      h.store.savePayrollSettings(h.panel.id, { sourceAccount: SOURCE, infoGid: null });
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /link of the Pilot Info tab/.test(e.message));
      assert.deepEqual(reads, []);
    });

    it('says so when a sheet cannot be read or is not what it should be', async () => {
      sheets.status = 403;
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /couldn't read the airline's schedule/.test(e.message));
      sheets.status = 200;
      sheets.info = [['Pilot', 'Rank'], ['Alex Smith', 'Captain']];
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /name, a FsHub ID and a bank account column/.test(e.message) && /The titles I can see are: Pilot, Rank/.test(e.message));
      sheets.info = pilotInfo();
      sheets.schedule = sheets.schedule.map((r) => r.slice(0, 9));
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /no Pilot Pay column/.test(e.message));
      sheets.schedule = [['Name', 'Score'], ['a', '1']];
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /couldn't read the schedule sheet/.test(e.message));
      h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
      await assert.rejects(payroll.prepare(panel(), settings()), (e: unknown) => e instanceof PayrollError && /doesn't read a Google Sheet/.test(e.message));
    });
  });

  describe('a flight that lost money', () => {
    const AIRLINE = 99;
    let fs: FakeFsHub;
    const SAM_ROW = 2; // sheet row 3: EGLL → EGCC, flown by Sam Jones on 10 Nov
    const flown = (flightId: number, over: Partial<FlownFlight> = {}): FlownFlight => ({
      flightId,
      pilotId: 41502,
      pilotName: 'Sam Jones',
      dep: 'EGLL',
      arr: 'EGCC',
      departedAt: D10 + 9 * HOUR,
      arrivedAt: D10 + 10 * HOUR,
      aircraftIcao: 'A320',
      aircraftName: null,
      scheduleStatus: null,
      ...over,
    });
    /** FsHub's own record of a flight (what it answers when asked about one), with the distance it recorded. */
    const known = (flightId: number, distanceNm: number | null, over: Partial<FlownFlight> = {}) => {
      const f = flown(flightId, over);
      const all = fs.flights.get(AIRLINE) ?? [];
      all.push({ id: f.flightId, pilotId: f.pilotId, pilotName: f.pilotName, dep: f.dep, arr: f.arr, departedAt: f.departedAt, arrivedAt: f.arrivedAt, aircraftIcao: f.aircraftIcao, aircraftName: f.aircraftName, scheduleStatus: null, distanceNm });
      fs.flights.set(AIRLINE, all);
      h.store.upsertFshubFlights(h.panel.id, [f]);
    };
    const withFsHub = () => (payroll = new Payroll({ store: h.store, gateway: gw, writeback: wb, fshub: fs, fetchFn, now: () => h.clock.now }));
    const sam = async () => byPilot(await payroll.prepare(panel(), settings()), 'Sam Jones');

    beforeEach(() => {
      fs = new FakeFsHub();
      h.store.updatePanel(h.panel.id, { fshubAirlineId: AIRLINE });
      sheets.schedule[SAM_ROW]![8] = '-$5,000.00'; // lost money
      sheets.schedule[SAM_ROW]![9] = '$500'; // and the sheet has only a small figure for the pilot
      withFsHub();
    });

    it("is paid by the distance FsHub recorded for it: $2,000 for the first 1,000 nm and $1,000 for each further 500", async () => {
      known(7001, 1620);
      const line = await sam();
      assert.deepEqual([line.cents, line.sheetCents, line.lossNm, line.flags], [400000, 50000, 1620, []]);
      assert.deepEqual(fs.flightCalls, [{ airlineId: AIRLINE, cursor: 7000, limit: 1 }], 'one question to FsHub, about that flight');
    });

    it('is the pilot that flew it, on that route, in that day, and nothing else', async () => {
      known(7001, 3000, { pilotId: 50003, pilotName: 'Jo Kim' }); // somebody else flew that route
      known(7002, 3000, { arr: 'EGKK' }); // another route
      known(7003, 3000, { arrivedAt: D10 + 4 * 24 * HOUR }); // another day
      const line = await sam();
      assert.deepEqual([line.cents, line.lossNm, line.flags], [200000, undefined, ['no-distance']]);
      assert.deepEqual(fs.flightCalls, [], 'there was nothing to ask about');
    });

    it('is raised to the minimum and flagged when the bot has no such flight, FsHub gives no distance, or it could be either of two', async () => {
      assert.deepEqual([(await sam()).cents, (await sam()).flags], [200000, ['no-distance']]);
      known(7001, null);
      assert.deepEqual([(await sam()).cents, (await sam()).flags], [200000, ['no-distance']], 'FsHub recorded no distance');
      known(7002, 3000, { arrivedAt: D10 + 11 * HOUR });
      const two = await sam();
      assert.deepEqual([two.cents, two.lossNm, two.flags], [200000, undefined, ['no-distance']], 'two flights of that pilot on that route that day: not guessed');
    });

    it('is flagged, never guessed, when FsHub cannot be asked at all', async () => {
      known(7001, 1620);
      fs.flightError = new Error('down');
      assert.deepEqual([(await sam()).cents, (await sam()).flags], [200000, ['no-distance']]);
      payroll = new Payroll({ store: h.store, gateway: gw, writeback: wb, fetchFn, now: () => h.clock.now });
      assert.deepEqual([(await sam()).cents, (await sam()).flags], [200000, ['no-distance']], 'and the same without FsHub connected');
      h.store.updatePanel(h.panel.id, { fshubAirlineId: null });
      withFsHub();
      assert.deepEqual([(await sam()).cents, (await sam()).flags], [200000, ['no-distance']], 'and for a panel not linked to an FsHub airline');
    });

    it('is not paid twice over for one FsHub flight when two rows claim it', async () => {
      known(7001, 1620);
      sheets.schedule.push(srow('EGLL-EGCC', '11/10/2026', 'Sam Jones', { pay: '$500' }));
      sheets.schedule[sheets.schedule.length - 1]![8] = '-$4,000.00';
      const draft = await payroll.prepare(panel(), settings());
      const lines = draft.lines.filter((l) => l.pilot === 'Sam Jones');
      assert.deepEqual(lines.map((l) => [l.cents, l.flags]), [[200000, ['no-distance']], [200000, ['no-distance']]]);
    });

    it('pays the amount worked out by distance, and is not stopped by the sheet still saying less', async () => {
      known(7001, 1620);
      const draft = await payroll.prepare(panel(), settings());
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.skipped, []);
      assert.equal(gw.calls.find((c) => c.recipientAccount === '2002-0002222')!.cents, 400000, 'the bank is asked for $4,000, not $500');
    });

    it('is left out if the sheet changes to another amount, or the flight is no longer one that lost money, before it is paid', async () => {
      known(7001, 1620);
      const draft = await payroll.prepare(panel(), settings());
      const samSkips = (out: Awaited<ReturnType<Payroll['pay']>>) => out.skipped.filter((s) => s.line.pilot === 'Sam Jones').map((s) => s.reason); // (Alex, on the same list, gets paid the first time)
      sheets.schedule[SAM_ROW]![9] = '$900';
      assert.deepEqual(samSkips(await payroll.pay(panel(), settings(), draft.lines)), ['changed']);
      sheets.schedule[SAM_ROW]![9] = '$500';
      sheets.schedule[SAM_ROW]![8] = '$5,000.00'; // now a profit
      assert.deepEqual(samSkips(await payroll.pay(panel(), settings(), draft.lines)), ['changed']);
      assert.ok(!gw.calls.some((c) => c.recipientAccount === '2002-0002222'));
    });

    it('is not asked about a flight that made a profit', async () => {
      sheets.schedule[SAM_ROW]![8] = '$5,000.00';
      known(7001, 1620);
      const line = await sam();
      assert.deepEqual([line.cents, line.lossNm, line.flags], [200000, undefined, []]);
      assert.deepEqual(fs.flightCalls, []);
    });
  });

  describe('paying a list', () => {
    it('sends each ready payment once, with its unique ID, and a list read again offers none of them', async () => {
      const draft = await payroll.prepare(panel(), settings());
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.paid.map((l) => l.uniqueId), ['32411-KORD-EGLL-111026', '41502-EGLL-EGCC-111026'], 'the two with nothing flagged');
      assert.deepEqual(gw.calls.map((c) => [c.sourceAccount, c.recipientAccount, c.uniqueId, c.cents]), [
        [SOURCE, '2002-0001111', '32411-KORD-EGLL-111026', 750000],
        [SOURCE, '2002-0002222', '41502-EGLL-EGCC-111026', 200000],
      ]);
      assert.match(gw.calls[0]!.description, /Test Air pilot pay, KORD to EGLL, Tue 10 Nov/);
      assert.deepEqual([out.failed, out.skipped, out.unconfirmed, out.held], [[], [], [], []]);
      assert.deepEqual(h.store.listLedger(h.panel.id, 5).map((r) => [r.uniqueId, r.status, r.detail]), [
        ['41502-EGLL-EGCC-111026', 'paid', 'ref-2'],
        ['32411-KORD-EGLL-111026', 'paid', 'ref-1'],
      ]);
      const next = await payroll.prepare(panel(), settings());
      assert.deepEqual(next.lines.map((l) => l.pilot), ['Pat Lee', 'Jo Kim'], 'only the two that were flagged are still due');
    });

    it('pays the $2,000 minimum when the sheet says less, and the sheet still saying less does not stop it', async () => {
      sheets.schedule[2]![9] = '$34'; // Sam's flight: the cell holds Aeroconomy's own small share
      const draft = await payroll.prepare(panel(), settings());
      const sam = byPilot(draft, 'Sam Jones');
      assert.deepEqual([sam.cents, sam.sheetCents, sam.flags], [200000, 3400, []]);
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.skipped, []);
      assert.deepEqual(out.paid.map((l) => l.pilot), ['Alex Smith', 'Sam Jones']);
      assert.equal(gw.calls.find((c) => c.recipientAccount === '2002-0002222')!.cents, 200000, 'the bank is asked for $2,000, not $34');
    });

    it('leaves that payment out if the sheet is then changed to some other amount', async () => {
      sheets.schedule[2]![9] = '$34';
      const draft = await payroll.prepare(panel(), settings());
      sheets.schedule[2]![9] = '$2,600';
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.skipped.map((s) => [s.line.pilot, s.reason]), [['Sam Jones', 'changed']]);
      assert.ok(!gw.calls.some((c) => c.recipientAccount === '2002-0002222'));
    });

    it('does not send what is flagged or left out, and is not made to by an old list', async () => {
      const draft = await payroll.prepare(panel(), settings());
      const lines = draft.lines.map((l) => (l.pilot === 'Sam Jones' ? { ...l, out: true } : l));
      const out = await payroll.pay(panel(), settings(), lines);
      assert.deepEqual(gw.calls.map((c) => c.uniqueId), ['32411-KORD-EGLL-111026']);
      assert.equal(out.paid.length, 1);
    });

    it('sends the same list only once, however many times it is paid', async () => {
      h.store.updatePanel(h.panel.id, { writeback: false }); // no ticking, so only the ledger stands in the way
      const draft = await payroll.prepare(panel(), settings());
      await payroll.pay(panel(), settings(), draft.lines);
      const second = await payroll.pay(panel(), settings(), draft.lines);
      assert.equal(gw.calls.length, 2, 'the bank was asked twice in all, not four times');
      assert.deepEqual(second.skipped.map((s) => s.reason), ['already-sent', 'already-sent']);
      assert.equal(second.paid.length, 0);
    });

    it('also leaves out what the box says is paid, once it has been ticked', async () => {
      const draft = await payroll.prepare(panel(), settings());
      await payroll.pay(panel(), settings(), draft.lines);
      const second = await payroll.pay(panel(), settings(), draft.lines);
      assert.equal(gw.calls.length, 2);
      assert.deepEqual(second.skipped.map((s) => s.reason), ['already-paid', 'already-paid']);
    });

    it('leaves a payment out when the sheet no longer agrees with the list, and says why', async () => {
      const draft = await payroll.prepare(panel(), settings());
      sheets.schedule[1]![9] = '$7,600'; // Alex's pay was changed
      sheets.schedule[2]![7] = 'TRUE'; // Sam's box was ticked: paid by hand
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.skipped.map((s) => [s.line.pilot, s.reason]), [['Alex Smith', 'changed'], ['Sam Jones', 'already-paid']]);
      assert.equal(gw.calls.length, 0);
      sheets.schedule = [SCHEDULE_HEADER, ...sheets.schedule.slice(3)]; // both rows are gone
      const gone = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(gone.skipped.map((s) => s.reason), ['gone', 'gone']);
      sheets.schedule = schedule();
      sheets.schedule[1]![3] = 'Somebody Else';
      sheets.schedule[2]![6] = 'FALSE';
      const other = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(other.skipped.map((s) => s.reason), ['changed', 'not-completed']);
      assert.equal(gw.calls.length, 0, 'nothing was ever sent');
      assert.deepEqual(h.store.listLedger(h.panel.id, 5), [], 'and nothing was written in the ledger');
    });

    it("pays what an admin amended even though the sheet says another amount, but still checks the flight", async () => {
      const draft = await payroll.prepare(panel(), settings());
      const done = amendLine(draft.lines, 3, { account: '2002-0003333', amount: '3100', uniqueId: 'pat-lee-nov-10' }, () => false);
      assert.ok(done.ok);
      const out = await payroll.pay(panel(), settings(), done.lines);
      assert.deepEqual(gw.calls.map((c) => [c.recipientAccount, c.uniqueId, c.cents]).slice(-1), [['2002-0003333', 'pat-lee-nov-10', 310000]]);
      assert.equal(out.paid.length, 3);
      const row = h.store.ledgerByUniqueId(h.panel.id, 'pat-lee-nov-10')!;
      assert.deepEqual([row.pilot, row.fshubId, row.sourceKey, row.status], ['Pat Lee', null, 'EGLL-EGKK@2026-11-10', 'paid']);
    });

    it('writes a refusal down, sends nothing more for it, and offers it again, under the same unique ID', async () => {
      gw.refuse.set('32411-KORD-EGLL-111026', 'Insufficient funds');
      const draft = await payroll.prepare(panel(), settings());
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.failed.map((f) => [f.line.pilot, f.reason]), [['Alex Smith', 'Insufficient funds']]);
      assert.equal(out.paid.length, 1, 'the others are paid');
      assert.deepEqual(h.store.ledgerByUniqueId(h.panel.id, '32411-KORD-EGLL-111026')!.status, 'failed');
      gw.refuse.clear();
      const again = await payroll.prepare(panel(), settings());
      assert.equal(byPilot(again, 'Alex Smith').uniqueId, '32411-KORD-EGLL-111026');
      const retry = await payroll.pay(panel(), settings(), again.lines);
      assert.deepEqual(retry.paid.map((l) => l.pilot), ['Alex Smith']);
      assert.equal(h.store.listLedger(h.panel.id, 10).filter((r) => r.uniqueId === '32411-KORD-EGLL-111026').length, 1, 'one ledger row for it');
    });

    it('stops at a payment the bank never answered, leaves it unsettled, and keeps its flight off every list', async () => {
      gw.silent.add('32411-KORD-EGLL-111026');
      const draft = await payroll.prepare(panel(), settings());
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.deepEqual(out.unconfirmed.map((l) => l.pilot), ['Alex Smith']);
      assert.deepEqual(out.held.map((l) => l.pilot), ['Sam Jones'], 'the one behind it was not tried');
      assert.equal(gw.calls.length, 1);
      assert.equal(h.store.ledgerByUniqueId(h.panel.id, '32411-KORD-EGLL-111026')!.status, 'sending');
      const next = await payroll.prepare(panel(), settings());
      assert.ok(!next.lines.some((l) => l.pilot === 'Alex Smith'), 'not offered again: nobody knows if the money moved');
      assert.equal(next.unsettled, 1);
      const again = await payroll.pay(panel(), settings(), draft.lines);
      assert.equal(again.skipped[0]?.reason, 'already-sent', 'and never sent again by an old list');
    });

    it('does nothing at all while there is no bank connection, and records nothing', async () => {
      const off = new Payroll({ store: h.store, gateway: new NotConnectedGateway(), fetchFn, now: () => h.clock.now });
      const draft = await off.prepare(panel(), settings());
      reads.length = 0;
      const out = await off.pay(panel(), settings(), draft.lines);
      assert.deepEqual([out.connected, out.paid, out.failed, out.skipped, out.unconfirmed], [false, [], [], [], []]);
      assert.deepEqual(reads, [], 'the sheet was not even read');
      assert.deepEqual(h.store.listLedger(h.panel.id, 5), []);
      assert.deepEqual(await new NotConnectedGateway().pay(), { ok: false, reason: (await new NotConnectedGateway().pay() as { reason: string }).reason });
    });

    it('sends nothing, and says so, when the sheet cannot be read just before paying', async () => {
      const draft = await payroll.prepare(panel(), settings());
      sheets.status = 500;
      await assert.rejects(payroll.pay(panel(), settings(), draft.lines), (e: unknown) => e instanceof PayrollError);
      assert.equal(gw.calls.length, 0);
      h.store.savePayrollSettings(h.panel.id, { sourceAccount: 'not-an-account' });
      sheets.status = 200;
      await assert.rejects(payroll.pay(panel(), settings(), draft.lines), (e: unknown) => e instanceof PayrollError && /which account the pay comes out of/.test(e.message));
    });
  });

  describe('ticking Pilot Paid', () => {
    const boxes = () => [2, 3, 4, 5, 6, 7, 8].map((r) => g.cell(`H${r}`));
    const payAll = async () => payroll.pay(panel(), settings(), (await payroll.prepare(panel(), settings())).lines);
    const K = { alex: 'KORD-EGLL@2026-11-10', sam: 'EGLL-EGCC@2026-11-10', pat: 'EGLL-EGKK@2026-11-10' };
    const tick = (row: number, sourceKey: string, pilot: string) => ({ sourceKey, row, pilot });

    it('ticks the box of every payment that was made, and changes no other cell', async () => {
      const before = g.values.map((r) => [...r]);
      const out = await payAll();
      assert.deepEqual(out.tick, { done: [2, 3], already: [], left: [] });
      assert.deepEqual(boxes(), ['TRUE', 'TRUE', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'TRUE']);
      g.values.forEach((r, i) =>
        r.forEach((c, k) => {
          if (!(k === 7 && (i === 1 || i === 2))) assert.equal(c, before[i]![k], `row ${i + 1} column ${k + 1} must not change`);
        }),
      );
      assert.equal(g.writes.length, 1, 'one write for all of them');
      assert.deepEqual(g.writes[0]!.data.map((d) => d.range.split('!')[1]), ['H2', 'H3']);
    });

    it('does not tick a payment that was refused or never answered', async () => {
      gw.refuse.set('32411-KORD-EGLL-111026', 'Insufficient funds');
      gw.silent.add('41502-EGLL-EGCC-111026');
      const out = await payAll();
      assert.deepEqual(out.tick, { done: [], already: [], left: [] });
      assert.equal(g.writes.length, 0);
      assert.deepEqual(boxes(), ['FALSE', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'FALSE', 'TRUE']);
    });

    it('keeps the payments and names the rows to tick when writing to the sheet is switched off, or the writer is not there', async () => {
      h.store.updatePanel(h.panel.id, { writeback: false });
      const off = await payAll();
      assert.equal(off.paid.length, 2);
      assert.deepEqual(off.tick.done, []);
      assert.deepEqual(off.tick.left, [
        { row: 2, pilot: 'Alex Smith', why: "writing to the sheet isn't switched on for this panel" },
        { row: 3, pilot: 'Sam Jones', why: "writing to the sheet isn't switched on for this panel" },
      ]);
      assert.equal(g.writes.length, 0);
      h.store.updatePanel(h.panel.id, { writeback: true });
      const bare = new Payroll({ store: h.store, gateway: gw, fetchFn, now: () => h.clock.now });
      sheets.schedule = schedule();
      h.store.savePayrollSettings(h.panel.id, {});
      const draft = await bare.prepare(panel(), settings());
      assert.equal(draft.lines.length, 2, 'the two that were flagged: the others are in the ledger');
      const amended = amendLine(draft.lines, 1, { account: '2002-0003333', amount: '3000', uniqueId: 'pat-lee-nov-10' }, () => false);
      assert.ok(amended.ok);
      const out = await bare.pay(panel(), settings(), amended.lines);
      assert.equal(out.paid.length, 1);
      assert.deepEqual(out.tick.left.map((l) => l.row), [4, 2, 3], 'the new one first, then the two paid before whose boxes were never ticked');
    });

    it('keeps the payments and says why when Google will not take the tick, and ticks what was missed at the next payment', async () => {
      g.mode = 'view-only';
      const first = await payAll();
      assert.equal(first.paid.length, 2);
      assert.deepEqual(first.tick.done, []);
      assert.deepEqual(first.tick.left.map((l) => l.row), [2, 3]);
      assert.ok(first.tick.left.every((l) => l.why.length > 0));
      assert.equal(h.store.ledgerByUniqueId(h.panel.id, '32411-KORD-EGLL-111026')!.status, 'paid', 'the payment stands');
      assert.deepEqual(boxes().slice(0, 2), ['FALSE', 'FALSE']);

      g.mode = 'ok';
      const draft = await payroll.prepare(panel(), settings());
      assert.deepEqual(draft.lines.map((l) => l.pilot), ['Pat Lee', 'Jo Kim'], 'the two paid ones are not offered again, ticked or not');
      const amended = amendLine(draft.lines, 1, { account: '2002-0003333', amount: '3000', uniqueId: 'pat-lee-nov-10' }, () => false);
      assert.ok(amended.ok);
      const second = await payroll.pay(panel(), settings(), amended.lines);
      assert.deepEqual([...second.tick.done].sort(), [2, 3, 4]);
      assert.deepEqual(boxes().slice(0, 3), ['TRUE', 'TRUE', 'TRUE']);
      assert.equal(gw.calls.length, 3, 'and nobody was paid twice');
    });

    it('leaves a box that a person ticked in the meantime as it is, and one with anything else in it', async () => {
      const draft = await payroll.prepare(panel(), settings());
      g.beforeNextRead = () => {
        g.values[1]![7] = 'TRUE'; // Alex's box is ticked by someone between the check and the tick
        g.values[2]![7] = 'paid by cheque';
      };
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.equal(out.paid.length, 2);
      assert.deepEqual(out.tick.already, [2]);
      assert.deepEqual(out.tick.done, []);
      assert.deepEqual(out.tick.left, [{ row: 3, pilot: 'Sam Jones', why: 'the Pilot Paid cell has something other than an empty box in it' }]);
      assert.equal(g.cell('H3'), 'paid by cheque');
      assert.equal(g.writes.length, 0);
    });

    it('says what changed in the sheet when a row is not what it was', async () => {
      const draft = await payroll.prepare(panel(), settings());
      g.beforeNextRead = () => {
        g.values[1]![3] = 'Somebody Else';
        g.values[2]![0] = 'EGLL-EGPH';
      };
      const out = await payroll.pay(panel(), settings(), draft.lines);
      assert.equal(out.paid.length, 2);
      assert.deepEqual(out.tick.left.map((l) => [l.row, l.why]), [[2, 'the pilot on the row changed'], [3, 'its row is now another flight']]);
      assert.deepEqual(boxes().slice(0, 2), ['FALSE', 'FALSE']);
    });

    it('never throws, whatever goes wrong with the tick', async () => {
      const draft = await payroll.prepare(panel(), settings());
      const broken = new Payroll({ store: h.store, gateway: gw, fetchFn, now: () => h.clock.now, writeback: { enabledFor: () => true, markPilotsPaid: async () => { throw new Error('boom'); } } });
      const out = await broken.pay(panel(), settings(), draft.lines);
      assert.equal(out.paid.length, 2);
      assert.deepEqual(out.tick.left.map((l) => [l.row, l.why]), [[2, 'something went wrong, it is in my log'], [3, 'something went wrong, it is in my log']]);
    });

    describe('what the writer does with a row', () => {
      it('ticks an empty box, whether it holds nothing or FALSE, and a row of any age', async () => {
        g.values[1]![7] = '';
        g.values.push(srow('KORD-EGLL', '1/5/2026', 'Alex Smith', { paid: false })); // row 9: months old
        const r = await wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith'), tick(9, 'KORD-EGLL@2026-01-05', 'ALEX smith')]);
        assert.deepEqual(r.ticked.map((t) => t.cell), ['H2', 'H9']);
        assert.deepEqual([g.cell('H2'), g.cell('H9')], ['TRUE', 'TRUE']);
      });

      it("finds a flight that repeats a route and a day by its own row, and not by its number among the others", async () => {
        g.values.push(srow('KORD-EGLL', '11/10/2026', 'Alex Smith')); // row 9: the same route, the same day
        const r = await wb.markPilotsPaid(panel(), [tick(9, `${K.alex}#2`, 'Alex Smith')]);
        assert.deepEqual(r.ticked.map((t) => t.cell), ['H9']);
        assert.equal(g.cell('H2'), 'FALSE');
        assert.deepEqual((await wb.markPilotsPaid(panel(), [tick(9, `${K.alex}#2`, 'Alex Smith')])).already, [`${K.alex}#2`]);
      });

      it('leaves alone a row that is not what it was, a pilot who changed, a flight not ticked as completed, and a box with a note or a formula in it', async () => {
        g.formulas.set('H4', '=TRUE');
        const r = await wb.markPilotsPaid(panel(), [
          tick(2, K.sam, 'Alex Smith'),
          tick(3, K.sam, 'Somebody Else'),
          tick(7, 'EGCC-EGLL@2026-11-11', 'Sam Jones'),
          tick(99, K.alex, 'Alex Smith'),
          tick(4, K.pat, 'Pat Lee'),
        ]);
        assert.deepEqual(r.skipped.map((s) => s.reason), ['moved', 'changed', 'not-completed', 'gone', 'filled']);
        assert.deepEqual([r.ticked, r.already], [[], []]);
        assert.equal(g.writes.length, 0);
        g.values[4]![7] = 'n/a';
        const text = await wb.markPilotsPaid(panel(), [tick(5, 'EGKK-EGLL@2026-11-11', 'Jo Kim')]);
        assert.deepEqual(text.skipped, [{ sourceKey: 'EGKK-EGLL@2026-11-11', reason: 'filled' }]);
      });

      it('never unticks a box, and a cancelled flight is not ticked', async () => {
        g.values[1]![7] = 'TRUE';
        g.values[2]![3] = 'CANCELLED';
        const r = await wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith'), tick(3, K.sam, 'CANCELLED')]);
        assert.deepEqual([r.already, r.skipped.map((s) => s.reason)], [[K.alex], ['not-completed']]);
        assert.deepEqual([g.cell('H2'), g.cell('H3')], ['TRUE', 'FALSE']);
        assert.equal(g.writes.length, 0);
      });

      it('says when the tab has no Pilot Paid column or is not a schedule, and when Google refuses', async () => {
        g.values = schedule().map((r) => r.filter((_, i) => i !== 7));
        await assert.rejects(wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith')]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_COLUMNS' && /Pilot Paid column/.test(e.message));
        g.values = [['Name', 'Score'], ['Anna', '5']];
        await assert.rejects(wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith')]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_COLUMNS');
        g.values = schedule();
        g.mode = 'view-only';
        await assert.rejects(wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith')]), (e: unknown) => e instanceof WriteBackError && e.code === 'GOOGLE');
        h.store.updatePanel(h.panel.id, { sheetId: null, sheetGid: null });
        await assert.rejects(wb.markPilotsPaid(panel(), [tick(2, K.alex, 'Alex Smith')]), (e: unknown) => e instanceof WriteBackError && e.code === 'NO_SHEET');
      });

      it('asks nothing of Google when there is nothing to tick', async () => {
        assert.deepEqual(await wb.markPilotsPaid(panel(), []), { ticked: [], already: [], skipped: [] });
        assert.equal(g.calls.length, 0);
      });
    });
  });

  describe('when the daily list is due', () => {
    it('is due once a day, after its time, and again the next day', () => {
      const s = (over = {}) => ({ ...settings(), runAtMinute: 13 * 60, ...over });
      assert.equal(payroll.isDue(s(), T0), false, 'it is 12:00 and the list is made at 13:00');
      assert.equal(payroll.isDue(s(), T0 + HOUR), true);
      assert.equal(payroll.isDue(s({ enabled: false }), T0 + HOUR), false, 'switched off');
      assert.equal(payroll.isDue(s({ lastRunDay: D11 }), T0 + 2 * HOUR), false, 'already made today');
      assert.equal(payroll.isDue(s({ lastRunDay: D10 }), T0 + 2 * HOUR), true, 'made yesterday');
      assert.equal(payroll.isDue(s({ lastRunDay: D11 }), T0 + 25 * HOUR), true, 'and again the day after');
    });

    it('waits half an hour after a list could not be made, and notes when it has been', () => {
      const s = { ...settings(), runAtMinute: 0 };
      payroll.noteTried(h.panel.id, T0);
      assert.equal(payroll.isDue(s, T0 + 29 * 60_000), false);
      assert.equal(payroll.isDue(s, T0 + 31 * 60_000), true);
      payroll.noteRan(h.panel.id, T0 + 31 * 60_000);
      assert.equal(settings().lastRunDay, D11);
      assert.equal(payroll.isDue(settings(), T0 + 2 * HOUR), false);
    });
  });
});

/* ------------------------------------------------------------------ switched off until the bank connection exists */

describe('paying pilots is switched off by default', () => {
  it('is on only when the variable says so', () => {
    assert.equal(PAYROLL_FLAG, 'FPB_ENABLE_PAYROLL');
    assert.equal(payrollEnabled({}), false);
    for (const on of ['1', 'true', 'TRUE', 'yes', 'On', ' 1 ']) assert.equal(payrollEnabled({ [PAYROLL_FLAG]: on }), true, on);
    for (const off of ['', '0', 'false', 'no', 'off', 'maybe', '11', 'enabled']) assert.equal(payrollEnabled({ [PAYROLL_FLAG]: off }), false, off);
    assert.equal(payrollEnabled({ SOMETHING_ELSE: '1' }), false);
  });

  it('registers no /payroll command and handles none of its buttons unless it is on', () => {
    const names = (on: boolean) => commandSet(on).map((c) => c.data.name).sort();
    const prefixes = (on: boolean) => handlerSet(on).map((h) => h.prefix).sort();
    assert.deepEqual(names(false), ['eta', 'fuel', 'help', 'hideunavailable', 'setup']);
    assert.deepEqual(names(true), ['eta', 'fuel', 'help', 'hideunavailable', 'payroll', 'setup']);
    assert.deepEqual(prefixes(false), ['dm', 'notices', 'panel', 'profit', 'weather']);
    assert.deepEqual(prefixes(true), ['dm', 'notices', 'panel', 'payroll', 'profit', 'weather']);
  });

  it('is off in the set the bot actually uses, when nobody has turned it on', () => {
    assert.equal(payrollEnabled(), false, `${PAYROLL_FLAG} must not be set when the tests run`);
    assert.ok(!commands.some((c) => c.data.name === 'payroll'));
    assert.ok(!componentHandlers.some((h) => h.prefix === 'payroll'));
  });

  it('refuses the command, even if it were called, when the bot has no payroll', async () => {
    const f = fakeInteraction({ sub: 'settings', admin: true });
    await assert.rejects(payrollCommand.execute({ ...(({} as unknown) as BotContext), store: { listPanels: () => [{ id: 1, prefix: 'T', airlineName: 'T', airlineAbbr: null }] } as never, payroll: null } as BotContext, f.i), /not available in this copy of the bot/);
  });
});

/* ------------------------------------------------------------------ in Discord */

const payrollButtons = payrollHandler;

const idsOf = (components: any[]): string[] => components.flatMap((r: any) => (r.toJSON?.().components ?? r.components ?? []).map((c: any) => c.custom_id ?? c.customId));
const labelsOf = (components: any[]): string[] => components.flatMap((r: any) => (r.toJSON?.().components ?? r.components ?? []).map((c: any) => c.label ?? c.placeholder));
const optionsOf = (components: any[]): Array<{ label: string; description: string; value: string }> => components.flatMap((r: any) => (r.toJSON?.().components ?? []).flatMap((c: any) => c.options ?? []));
const idStarting = (components: any[], start: string): string => idsOf(components).find((i) => i.startsWith(start)) as string;

describe('/payroll and its buttons', () => {
  const ROLE = '555000000000000001';
  const PAY_CHANNEL = 'c-paylist';
  let h: Harness;
  let d: DiscordHarness;
  let sheets: { schedule: string[][]; info: string[][] };
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  let gw: FakeGateway;
  let admin: FakeUser;
  let helper: FakeUser;
  let stranger: FakeUser;
  let channel: FakeChannel;
  const pid = () => h.panel.id;

  const fetchFn = (async (url: string) => new Response(csv(String(url).includes(`gid=${INFO_GID}`) ? sheets.info : g.values), { status: 200, headers: { 'content-type': 'text/csv' } })) as unknown as typeof fetch;
  const guildWith = (c: FakeChannel | null) => ({ channels: { fetch: async (id: string) => (c && id === c.id ? c : null) }, members: { me: { id: 'the-bot' } } });

  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, admin: true, userId: USER_A.discordId, user: admin, guild: guildWith(channel), ...o });
    let error: Error | null = null;
    try {
      await payrollCommand.execute(d.ctx, f.i);
    } catch (e) {
      error = e as Error;
    }
    await settle(40);
    const last = f.calls.edits.at(-1);
    return { text: String(last?.content ?? ''), components: (last?.components ?? []) as any[], error, calls: f.calls };
  };
  const settingsOf = (options: Record<string, unknown>) => run('settings', { options });
  const press = async (customId: string, o: { user?: FakeUser; admin?: boolean; guildId?: string | null; roles?: string[]; values?: string[]; notMember?: boolean } = {}) => {
    const f = fakeComponent(o.user ?? admin, customId, { admin: o.admin ?? true, ...(o.guildId !== undefined ? { guildId: o.guildId } : {}), ...(o.roles ? { roles: o.roles } : {}), ...(o.values ? { values: o.values } : {}), ...(o.notMember ? { notMember: true } : {}) });
    await payrollButtons.handle(d.ctx, f.i);
    await settle(40);
    const shown = f.calls.edits.at(-1) ?? f.calls.updates.at(-1);
    return { text: String(shown?.content ?? f.calls.replies.at(-1)?.content ?? ''), components: (shown?.components ?? []) as any[], modals: f.calls.modals, replies: f.calls.replies, updates: f.calls.updates, edits: f.calls.edits };
  };
  const submit = async (customId: string, fields: Record<string, string>, o: { user?: FakeUser; admin?: boolean } = {}) => {
    const f = fakeModal(o.user ?? admin, customId, fields, { admin: o.admin ?? true });
    let error: Error | null = null;
    try {
      await payrollButtons.handle(d.ctx, f.i);
    } catch (e) {
      error = e as Error;
    }
    await settle(40);
    const shown = f.calls.updates.at(-1);
    return { text: String(shown?.content ?? f.calls.replies.at(-1)?.content ?? ''), components: (shown?.components ?? []) as any[], error };
  };
  /** Make a list the way an admin does, in the reply (the default), and give back the message and its buttons. */
  const list = async () => {
    const r = await run('run');
    assert.equal(r.error, null);
    return r;
  };
  const noDmsOrPosts = () => assert.deepEqual([admin.dms.length, channel.sent.length], [0, 0]);

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = schedule();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(googleAccount, g.fetchFn, () => h.clock.now), g.fetchFn), googleAccount.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    sheets = {
      get schedule() {
        return g.values;
      },
      set schedule(v: string[][]) {
        g.values = v;
      },
      info: pilotInfo(),
    };
    gw = new FakeGateway();
    d.ctx.payroll = new Payroll({ store: h.store, gateway: new NotConnectedGateway(), writeback: wb, fetchFn, now: () => h.clock.now });
    admin = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    helper = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    stranger = d.client.user(new FakeUser('900000000000000009', 'stranger'));
    channel = new FakeChannel(PAY_CHANNEL);
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: SCHEDULE_GID, writeback: true });
    h.store.setPilotId('d-alex', 32411, T0, 'Alex Smith');
    h.store.setPilotId('d-sam', 41502, T0, 'Sam Jones');
    h.store.setPilotId('d-jo', 50003, T0, 'Jo Kim');
  });

  const configure = () => h.store.savePayrollSettings(pid(), { enabled: true, sourceAccount: SOURCE, infoSheetId: SHEET_ID, infoGid: INFO_GID, startDay: D10, ownerId: USER_A.discordId });
  const connect = () => (d.ctx.payroll = new Payroll({ store: h.store, gateway: gw, writeback: wb, fetchFn, now: () => h.clock.now }));

  describe('the command', () => {
    it('is for admins in a server, and has a subcommand for settings, for a list now, and for the history', () => {
      const json = payrollCommand.data.toJSON() as any;
      assert.equal(json.default_member_permissions, '32');
      assert.deepEqual(json.contexts, [0]);
      assert.deepEqual(json.options.map((o: any) => o.name), ['settings', 'run', 'history']);
      assert.ok(JSON.stringify(json).length < 6000);
      for (const sub of ['settings', 'run', 'history']) {
        assert.ok(json.options.find((o: any) => o.name === sub).options.some((o: any) => o.name === 'airline' && o.autocomplete));
      }
    });

    it('is refused to anyone who is not an admin, before anything is read', async () => {
      configure();
      for (const sub of ['settings', 'run', 'history']) {
        const r = await run(sub, { admin: false });
        assert.match(r.error?.message ?? '', /Manage Server/, sub);
      }
      noDmsOrPosts();
    });
  });

  describe('the settings', () => {
    it('start empty, and say so, including that nothing can be paid yet', async () => {
      const r = await settingsOf({});
      assert.equal(r.error, null);
      assert.match(r.text, /Paying pilots: Test Air\*\* is \*\*off\*\*/);
      assert.match(r.text, /pay comes out of account: \*\*not set\*\*/);
      assert.match(r.text, /pilots' accounts are read from: \*\*not set\*\*/);
      assert.match(r.text, /every day at \*\*12:00 Zulu\*\*/);
      assert.match(r.text, /No list has been made yet/);
      assert.match(r.text, /Paying isn't connected to Aeroconomy yet/);
      assert.doesNotMatch(r.text, /^Done/);
      assert.equal(h.store.getPayrollSettings(pid()), null, 'looking saves nothing');
    });

    it('save the account, the tab, the first day and the time, and pay nothing', async () => {
      const link = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${INFO_GID}`;
      const r = await settingsOf({ 'source-account': ' 9954 – 0000123 ', 'pilot-info': link, 'start-from': '2026-11-10', at: '6:30', enabled: 'on' });
      assert.equal(r.error, null);
      assert.match(r.text, /^Done\. Nothing was paid\./);
      assert.match(r.text, /is \*\*on\*\*/);
      assert.deepEqual(h.store.getPayrollSettings(pid()), { panelId: pid(), enabled: true, sourceAccount: SOURCE, infoSheetId: SHEET_ID, infoGid: INFO_GID, startDay: D10, runAtMinute: 390, ownerId: USER_A.discordId, lastRunDay: null });
      assert.match(r.text, /\*\*2026-11-10\*\* on/);
      assert.match(r.text, /\*\*06:30 Zulu\*\*/);
      assert.match(r.text, /DMs of <@111111111111111111>/);
      assert.equal(d.ctx.payroll!.gateway.connected, false);
      noDmsOrPosts();
    });

    it('will not switch on until the account and the tab are set, and takes the day it is switched on as the first to pay', async () => {
      assert.match((await settingsOf({ enabled: 'on' })).error?.message ?? '', /set `source-account` and `pilot-info`/);
      assert.equal(h.store.getPayrollSettings(pid()), null, 'and saves none of it');
      await settingsOf({ 'source-account': SOURCE });
      assert.match((await settingsOf({ enabled: 'on' })).error?.message ?? '', /set `pilot-info`/);
      await settingsOf({ 'pilot-info': `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${INFO_GID}` });
      const on = await settingsOf({ enabled: 'on' });
      assert.equal(on.error, null);
      assert.equal(h.store.getPayrollSettings(pid())!.startDay, D11, 'today, Zulu: earlier flights are never put on a list');
      await settingsOf({ 'start-from': '2026-11-01' });
      await settingsOf({ enabled: 'off' });
      await settingsOf({ enabled: 'on' });
      assert.equal(h.store.getPayrollSettings(pid())!.startDay, Date.UTC(2026, 10, 1), 'an admin chose another day, and it stays');
    });

    it('refuse what makes no sense, and save none of it', async () => {
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ 'source-account': '12345' }, /isn't an account number/],
        [{ 'pilot-info': 'https://example.com/sheet' }, /isn't a Google Sheets link/],
        [{ 'pilot-info': `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit` }, /does not say which tab/],
        [{ 'pilot-info': `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${SCHEDULE_GID}` }, /schedule's own tab/],
        [{ 'start-from': '19/11/2026' }, /year-month-day/],
        [{ 'start-from': '2026-02-30' }, /year-month-day/],
        [{ at: '25:00' }, /like `12:00`/],
        [{ at: 'noon' }, /like `12:00`/],
        [{ enabled: 'maybe' }, /Choose on or off/],
        [{ 'source-account': SOURCE, at: '99:99' }, /like `12:00`/],
      ];
      for (const [options, message] of cases) {
        const r = await settingsOf(options);
        assert.match(r.error?.message ?? 'no error', message, JSON.stringify(options));
        assert.equal(h.store.getPayrollSettings(pid()), null, `nothing saved after ${JSON.stringify(options)}`);
      }
    });

    it('show who works on the list the way /setup profit says', async () => {
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: PAY_CHANNEL, profitRoleId: ROLE });
      const r = await settingsOf({ 'source-account': SOURCE });
      assert.ok(r.text.includes(`posted in <#${PAY_CHANNEL}>`), r.text);
      assert.ok(r.text.includes(`any member of <@&${ROLE}>`), r.text);
    });
  });

  describe('making a list now', () => {
    it('needs the settings, and says what is missing', async () => {
      assert.match((await run('run')).error?.message ?? '', /Set it up first with `\/payroll settings`/);
      h.store.savePayrollSettings(pid(), { sourceAccount: SOURCE });
      assert.match((await run('run')).error?.message ?? '', /link of the Pilot Info tab/);
    });

    it('shows the admin, in the reply, every payment with its pilot, account, amount and unique ID, and what needs a look', async () => {
      configure();
      const r = await list();
      assert.match(r.text, /Pilot payments: Test Air/);
      assert.match(r.text, /From account `9954-0000123` · \*\*2\*\* ready to pay, \*\*\$9,500\*\* · \*\*2\*\* need a look first/);
      assert.match(r.text, /⏳ 1 completed flight has no Pilot Pay yet/);
      assert.match(r.text, /✅ \*\*1\*\* · Alex Smith · \*\*\$7,500\*\*\n↳ `2002-0001111` · `32411-KORD-EGLL-111026`/);
      assert.match(r.text, /✅ \*\*2\*\* · Sam Jones · \*\*\$2,000\*\*\n↳ `2002-0002222` · `41502-EGLL-EGCC-111026`/);
      assert.match(r.text, /⚠️ \*\*3\*\* · Pat Lee · \*\*\$3,000\*\*\n↳ \*no account\* · `NOID-EGLL-EGKK-111026`\n↳ ⚠️ not on the Pilot Info tab/);
      assert.match(r.text, /⚠️ \*\*4\*\* · Jo Kim · \*\*\$2,500\*\*\n↳ \*no account\* · `50003-EGKK-EGLL-111126`\n↳ ⚠️ no bank account on the Pilot Info tab/);
      assert.match(r.text, /Nothing is paid until someone presses \*\*Pay\*\*/);
      assert.match(r.text, /Paying isn't connected to Aeroconomy yet/);
      assert.ok(r.text.length <= 2000);
      assert.deepEqual(idsOf(r.components).map((i) => i.split(':').slice(0, 2).join(':')), ['payroll:am', 'payroll:pay', 'payroll:no']);
      assert.deepEqual(labelsOf(r.components), ['Amend', 'Pay 2 · $9,500', 'Cancel']);
      noDmsOrPosts();
    });

    it('says when nothing is due, and what is waiting', async () => {
      configure();
      sheets.schedule = [SCHEDULE_HEADER, srow('KORD-EGLL', '11/10/2026', 'Alex Smith', { pay: '' })];
      const r = await run('run');
      assert.match(r.text, /nothing is due to be paid right now/);
      assert.match(r.text, /1 completed flight has no Pilot Pay yet/);
      assert.deepEqual(r.components, []);
    });

    it('only ever reads: nothing is sent and the ledger stays empty', async () => {
      configure();
      connect();
      await list();
      assert.equal(gw.calls.length, 0);
      assert.deepEqual(h.store.listLedger(pid(), 5), []);
    });
  });

  describe('the buttons: paging, amending, cancelling', () => {
    const many = (count: number) => {
      sheets.schedule = [SCHEDULE_HEADER, ...Array.from({ length: count }, (_, i) => srow(`EG${String.fromCharCode(65 + (i % 20))}${String.fromCharCode(65 + Math.floor(i / 20))}-EGLL`, '11/10/2026', 'Alex Smith', { pay: `$${2000 + i}` }))];
    };

    it('split a long list into pages, and every page fits in a message however long the names and the flags', async () => {
      configure();
      many(30);
      sheets.info = [['Pilot', 'FSHUB ID', 'Bank Acct'], ['Alex Smith', '32411', '2002-0001111']];
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const pages = paginate(JSON.parse(h.store.getPayrollDraft(token, T0)!.body).lines);
      assert.ok(pages.length > 1);
      assert.equal(pages.flat().length, 30, 'every payment is on a page');
      assert.match(r.text, /Page 1 of \d+/);
      assert.deepEqual(idsOf(r.components).map((i) => i.split(':').slice(0, 2).join(':')), ['payroll:pg', 'payroll:pg', 'payroll:am', 'payroll:pay', 'payroll:no']);
      let page: { text: string; components: any[] } = r;
      const seen = new Set<string>();
      for (let p = 0; p < pages.length; p++) {
        for (const m of page.text.matchAll(/\*\*(\d+)\*\* · Alex Smith/g)) seen.add(m[1]!);
        assert.ok(page.text.length <= 2000, `page ${p + 1} is ${page.text.length} characters`);
        if (p < pages.length - 1) page = await press(idsOf(page.components).find((i, k) => i.startsWith('payroll:pg') && k === 1)!);
      }
      assert.equal(seen.size, 30, 'paging through shows all of them');
      assert.match(page.text, new RegExp(`Page ${pages.length} of ${pages.length}`));
    });

    it('draw the worst a payment can look inside the limit', () => {
      const worst: PayLine = { n: 99, sourceKey: 'k', row: 5, pilot: 'W'.repeat(80), fshubId: 1, account: '2002-123456789012', cents: 50_000_000, uniqueId: 'U'.repeat(64), dep: 'EGLL', arr: 'EGKK', day: D10, flags: ['no-info', 'ambiguous-info', 'id-mismatch', 'name-differs', 'account-changed', 'bad-amount'], amended: true, out: false };
      assert.ok(lineText(worst).length < 600);
      const raised: PayLine = { ...worst, amended: false, sheetCents: 49_999_999 };
      assert.match(lineText(raised), /the sheet says \$499,999\.99; raised to \$500,000, the minimum/);
      assert.match(lineText({ ...raised, lossNm: 2102.4 }), /the sheet says \$499,999\.99; raised to \$500,000 for a loss flight of 2,102 nm/);
      assert.ok(lineText({ ...raised, lossNm: 99_999.9 }).length < 750);
      assert.ok(lineText(raised).length < 700);
      assert.doesNotMatch(lineText({ ...raised, amended: true }), /the sheet says/, 'an amended amount is no longer the minimum');
      assert.doesNotMatch(lineText({ ...raised, out: true }), /the sheet says/);
      const draft: PayDraft = { airline: 'A'.repeat(100), made: T0, sourceAccount: SOURCE, lines: Array.from({ length: 40 }, (_, i) => ({ ...worst, n: i + 1 })), waiting: 99, unsettled: 99 };
      for (const mode of ['list', 'amend'] as const) {
        for (let page = 0; page < paginate(draft.lines).length; page++) {
          const view = renderList(draft, 'abcdef123456', { mode, page }, false, `Only <@${'1'.repeat(19)}> or anyone with <@&${'2'.repeat(19)}> can press **Pay**.`);
          assert.ok(view.content.length <= 2000, `${mode} page ${page}: ${view.content.length}`);
        }
      }
    });

    it('turn the list into a menu of the payments on the page when Amend is pressed, and back again', async () => {
      configure();
      const r = await list();
      const amend = await press(idStarting(r.components, 'payroll:am'));
      assert.match(amend.text, /\*\*Amend:\*\* choose the payment to change, by its number, from the menu/);
      assert.deepEqual(optionsOf(amend.components).map((o) => [o.value, o.label, o.description]), [
        ['1', '1 · Alex Smith', '$7,500 · 2002-0001111'],
        ['2', '2 · Sam Jones', '$2,000 · 2002-0002222'],
        ['3', '3 · Pat Lee', '$3,000 · no account · needs a look'],
        ['4', '4 · Jo Kim', '$2,500 · no account · needs a look'],
      ]);
      assert.deepEqual(labelsOf(amend.components).slice(1), ['Back to the list']);
      const back = await press(idStarting(amend.components, 'payroll:bk'));
      assert.deepEqual(labelsOf(back.components), ['Amend', 'Pay 2 · $9,500', 'Cancel']);
    });

    it("open a form with the chosen payment's account, amount and unique ID filled in", async () => {
      configure();
      const r = await list();
      const amend = await press(idStarting(r.components, 'payroll:am'));
      const picked = await press(idStarting(amend.components, 'payroll:pick'), { values: ['3'] });
      assert.equal(picked.modals.length, 1);
      const modal = picked.modals[0].toJSON();
      assert.equal(modal.title, 'Amend payment 3: Pat Lee');
      assert.match(modal.custom_id, /^payroll:save:[0-9a-f]{12}:3:0$/);
      const fields = modal.components.map((row: any) => row.components[0]);
      assert.deepEqual(fields.map((f: any) => [f.custom_id, f.label, f.value, f.required]), [
        ['account', 'Account number', '', true],
        ['amount', 'Amount in dollars (0 = leave it out)', '3000', true],
        ['uid', 'Unique ID', 'NOID-EGLL-EGKK-111026', true],
      ]);
      const unknown = await press(idStarting(amend.components, 'payroll:pick'), { values: ['9'] });
      assert.match(unknown.text, /not on the list/);
      assert.deepEqual(unknown.modals, []);
    });

    it('change the payment when the form is sent, and show the list again with it ready to pay', async () => {
      configure();
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const done = await submit(`payroll:save:${token}:3:0`, { account: '2002-0003333', amount: '3,100', uid: 'pat-lee-nov-10' });
      assert.equal(done.error, null);
      assert.match(done.text, /✅ \*\*3\*\* · Pat Lee · \*\*\$3,100\*\* ✏️\n↳ `2002-0003333` · `pat-lee-nov-10`/);
      assert.match(done.text, /\*\*3\*\* ready to pay, \*\*\$12,600\*\* · \*\*1\*\* needs a look first/);
      assert.match(done.text, /✏️ Payment 3 amended\./);
      assert.deepEqual(labelsOf(done.components), ['Amend', 'Pay 3 · $12,600', 'Cancel']);
      // it was kept, so it is still so after a restart, and when the list is pressed on again
      const again = await press(idStarting(done.components, 'payroll:am'));
      assert.match(again.text, /Pat Lee/);
      assert.equal(JSON.parse(h.store.getPayrollDraft(token, T0)!.body).lines[2].uniqueId, 'pat-lee-nov-10');
    });

    it('leave a payment out of the run when its amount is made 0', async () => {
      configure();
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const done = await submit(`payroll:save:${token}:2:0`, { account: '2002-0002222', amount: '0', uid: '41502-EGLL-EGCC-111026' });
      assert.match(done.text, /⏸️ \*\*2\*\* · Sam Jones · \*\*\$2,000\*\* ✏️ · \*left out of this run\*/);
      assert.deepEqual(labelsOf(done.components), ['Amend', 'Pay 1 · $7,500', 'Cancel']);
    });

    it('refuse a form that is not right, with the list as it was', async () => {
      configure();
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const bad = (fields: Record<string, string>) => submit(`payroll:save:${token}:3:0`, { account: '2002-0003333', amount: '3000', uid: 'fine-id', ...fields });
      assert.match((await bad({ account: 'abc' })).error?.message ?? '', /isn't an account number/);
      assert.match((await bad({ amount: 'x' })).error?.message ?? '', /number of dollars/);
      assert.match((await bad({ uid: '32411-KORD-EGLL-111026' })).error?.message ?? '', /Another payment on this list already has/);
      assert.equal(JSON.parse(h.store.getPayrollDraft(token, T0)!.body).lines[2].account, null);
      // and a unique ID that was used for a payment before cannot be typed in
      h.store.ledgerBegin(pid(), { uniqueId: 'used-before', sourceKey: 'z', pilot: 'X', fshubId: 1, account: '2002-0000001', cents: 100 }, T0);
      assert.match((await bad({ uid: 'used-before' })).error?.message ?? '', /has been used for a payment before/);
    });

    it('cancel the list, and nothing is paid', async () => {
      configure();
      connect();
      const r = await list();
      const cancelled = await press(idStarting(r.components, 'payroll:no'));
      assert.match(cancelled.text, /Cancelled\. No payments were made\. The same flights will be on the next list\./);
      assert.deepEqual(cancelled.components, []);
      assert.equal(gw.calls.length, 0);
      assert.match((await press(idStarting(r.components, 'payroll:pay'))).text, /expired, was replaced by a newer one, or was already used/);
    });

    it('a list that has run out, or was replaced by a newer one, does nothing', async () => {
      configure();
      const first = await list();
      const second = await list();
      assert.match((await press(idStarting(first.components, 'payroll:am'))).text, /expired, was replaced by a newer one, or was already used\. Nothing was paid/);
      const stale = await submit(`payroll:save:${idStarting(first.components, 'payroll:am').split(':')[2]}:1:0`, { account: '2002-0003333', amount: '1', uid: 'abc' });
      assert.match(stale.text, /expired, was replaced/);
      h.clock.advance(61 * 60_000);
      assert.match((await press(idStarting(second.components, 'payroll:am'))).text, /expired, was replaced/, 'a list shown only in the reply waits an hour');
    });
  });

  describe('Pay', () => {
    it('stops and says so while there is no bank connection, and the list stays as it was', async () => {
      configure();
      const r = await list();
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /Paying isn't connected to Aeroconomy yet/);
      assert.match(pay.text, /Nothing was sent, nothing was recorded as paid, and the list is still here/);
      assert.match(pay.text, /\(2 payments, \$9,500, would have gone out\.\)/);
      assert.deepEqual(h.store.listLedger(pid(), 5), []);
      const amend = await press(idStarting(r.components, 'payroll:am'));
      assert.match(amend.text, /Amend/, 'and it can still be worked on');
    });

    it('pays what is ready, once, and says what was paid', async () => {
      configure();
      connect();
      const r = await list();
      assert.doesNotMatch(r.text, /isn't connected/);
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /✅ Paid \*\*2\*\* payments, \*\*\$9,500\*\*, at <t:\d+:t>\./);
      assert.match(pay.text, /• 1 · Alex Smith · \$7,500 · `32411-KORD-EGLL-111026`/);
      assert.match(pay.text, /• 2 · Sam Jones · \$2,000 · `41502-EGLL-EGCC-111026`/);
      assert.doesNotMatch(pay.text, /Pat Lee/);
      assert.deepEqual(pay.components, []);
      assert.deepEqual(gw.calls.map((c) => c.uniqueId), ['32411-KORD-EGLL-111026', '41502-EGLL-EGCC-111026']);
      assert.match((await press(idStarting(r.components, 'payroll:pay'))).text, /expired, was replaced by a newer one, or was already used/);
      assert.equal(gw.calls.length, 2, 'pressing it again pays nothing');
    });

    it('says what the bank refused, what the sheet changed, and what got no answer', async () => {
      configure();
      connect();
      gw.refuse.set('32411-KORD-EGLL-111026', 'Insufficient funds');
      gw.silent.add('41502-EGLL-EGCC-111026');
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      await submit(`payroll:save:${token}:3:0`, { account: '2002-0003333', amount: '3000', uid: 'pat-lee-nov-10' });
      const pay = await press(`payroll:pay:${token}`);
      assert.match(pay.text, /✅ Paid \*\*0\*\* payments/);
      assert.match(pay.text, /❌ \*\*1\*\* refused by the bank, so nothing was sent for it\. It will be on the next list:\n• 1 · Alex Smith · Insufficient funds/);
      assert.match(pay.text, /⛔ \*\*1\*\* got no answer from the bank, so nobody knows if the money moved\./);
      assert.match(pay.text, /• 2 · Sam Jones · \$2,000 · `41502-EGLL-EGCC-111026`/);
      assert.match(pay.text, /⏸️ \*\*1\*\* more were not tried, because of that/);
    });

    it('puts the list back and says nothing was paid when the sheet cannot be read, so it can be tried again', async () => {
      configure();
      connect();
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const original = sheets.schedule;
      sheets.schedule = [['Name', 'Score']];
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /⚠️ Nothing was paid: I couldn't read the schedule sheet/);
      assert.equal(gw.calls.length, 0);
      assert.ok(h.store.getPayrollDraft(token, T0), 'the list is still kept');
      assert.deepEqual(labelsOf(pay.components), ['Amend', 'Pay 2 · $9,500', 'Cancel']);
      sheets.schedule = original;
      assert.match((await press(idStarting(pay.components, 'payroll:pay'))).text, /✅ Paid \*\*2\*\* payments/);
    });

    it('will not pay a list with nothing ready on it', async () => {
      configure();
      connect();
      sheets.schedule = [SCHEDULE_HEADER, srow('EGLL-EGKK', '11/10/2026', 'Pat Lee', { pay: '$3,000' })];
      const r = await list();
      assert.deepEqual(labelsOf(r.components), ['Amend', 'Nothing to pay', 'Cancel']);
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /nothing ready to pay/);
      assert.equal(gw.calls.length, 0);
    });
  });

  describe('Pay and the Pilot Paid box', () => {
    it('ticks the box of each payment that was made, and says so', async () => {
      configure();
      connect();
      const r = await list();
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /✅ Paid \*\*2\*\* payments/);
      assert.match(pay.text, /☑️ Ticked \*\*Pilot Paid\*\* in the sheet on 2 rows\./);
      assert.doesNotMatch(pay.text, /did not tick/);
      assert.deepEqual([g.cell('H2'), g.cell('H3'), g.cell('H4'), g.cell('H5')], ['TRUE', 'TRUE', 'FALSE', 'FALSE']);
    });

    it('lists the rows to tick by hand when writing to the sheet is switched off, and the payments stand', async () => {
      configure();
      connect();
      h.store.updatePanel(pid(), { writeback: false });
      const r = await list();
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.match(pay.text, /✅ Paid \*\*2\*\* payments/);
      assert.match(pay.text, /⚠️ I did not tick \*\*Pilot Paid\*\* on 2 rows \(writing to the sheet isn't switched on for this panel\)\. Tick them by hand: rows 2, 3\./);
      assert.doesNotMatch(pay.text, /Ticked/);
      assert.deepEqual([g.cell('H2'), g.cell('H3')], ['FALSE', 'FALSE']);
      assert.equal(gw.calls.length, 2);
    });

    it('says nothing about the box when nothing was paid', async () => {
      configure();
      connect();
      gw.refuse.set('32411-KORD-EGLL-111026', 'no');
      gw.refuse.set('41502-EGLL-EGCC-111026', 'no');
      const r = await list();
      const pay = await press(idStarting(r.components, 'payroll:pay'));
      assert.doesNotMatch(pay.text, /Pilot Paid/);
    });

    it('says in the settings whether the box is ticked for you', async () => {
      assert.match((await settingsOf({})).text, /After a payment goes through, I tick \*\*Pilot Paid\*\* on its row in the sheet/);
      h.store.updatePanel(pid(), { writeback: false });
      assert.match((await settingsOf({})).text, /\*\*Pilot Paid\*\* can't be ticked for you: writing to the sheet isn't switched on/);
    });

    it('words what is left to tick, however many rows there are', () => {
      assert.equal(tickText({ done: [], already: [], left: [] }), '');
      assert.equal(tickText({ done: [4], already: [], left: [] }), '☑️ Ticked **Pilot Paid** in the sheet on 1 row.');
      assert.equal(tickText({ done: [], already: [2], left: [] }), '', 'a box that was already ticked needs no words');
      const left = (rows: number[], why = 'a reason') => ({ done: [], already: [], left: rows.map((row) => ({ row, pilot: 'P', why })) });
      assert.equal(tickText(left([7])), '⚠️ I did not tick **Pilot Paid** on 1 row (a reason). Tick it by hand: row 7.');
      assert.match(tickText(left(Array.from({ length: 20 }, (_, i) => 30 - i))), /rows 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, and 5 more\./);
      assert.match(tickText({ done: [], already: [], left: [{ row: 2, pilot: 'A', why: 'one' }, { row: 3, pilot: 'B', why: 'two' }, { row: 4, pilot: 'C', why: 'one' }] }), /\(one; two\)/);
    });
  });

  describe('who may press', () => {
    it("lets only the admin who asked work on a list shown in the reply, and refuses everyone else, on every button", async () => {
      configure();
      connect();
      const r = await list();
      const token = idStarting(r.components, 'payroll:am').split(':')[2]!;
      const ids = [`payroll:pg:${token}:0`, `payroll:am:${token}:0`, `payroll:bk:${token}:0`, `payroll:pay:${token}`, `payroll:no:${token}`];
      for (const id of ids) {
        for (const o of [{ user: helper }, { admin: false }]) {
          const refused = await press(id, o);
          assert.match(refused.text, /Only the admin who set up paying can work on this list\./, id);
        }
      }
      const picked = await press(`payroll:pick:${token}:0`, { user: helper, values: ['1'] });
      assert.deepEqual(picked.modals, []);
      assert.match(picked.text, /Only the admin who set up paying/);
      const sent = await submit(`payroll:save:${token}:1:0`, { account: '2002-0003333', amount: '1', uid: 'abc' }, { user: helper });
      assert.match(sent.text, /Only the admin who set up paying/);
      assert.equal(gw.calls.length, 0);
      assert.ok(h.store.getPayrollDraft(token, T0), 'none of it used the list up');
    });

    it('also lets the members of the role chosen for /setup profit press the buttons of a list posted in a channel, and says who did', async () => {
      configure();
      connect();
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: PAY_CHANNEL, profitRoleId: ROLE });
      const asked = await run('run');
      assert.ok(asked.text.includes(`📣 I posted the pay list in <#${PAY_CHANNEL}>`), asked.text);
      assert.equal(channel.sent.length, 1);
      const posted = channel.sent[0]!.payload;
      assert.ok(posted.content.includes(`<@${USER_A.discordId}> or anyone with <@&${ROLE}> can press **Pay**.`), posted.content);
      assert.deepEqual(posted.allowedMentions, noPings);
      const pay = idStarting(posted.components, 'payroll:pay');
      const refused = await press(pay, { user: stranger, admin: false });
      assert.ok(refused.text.includes(`or a member of <@&${ROLE}>, can work on this list`), refused.text);
      assert.equal(gw.calls.length, 0);
      const done = await press(pay, { user: helper, admin: false, roles: [ROLE] });
      assert.match(done.text, /✅ Paid \*\*2\*\* payments/);
      assert.ok(done.text.includes(`Pressed by <@${USER_B.discordId}>.`), done.text);
      assert.equal(gw.calls.length, 2);
    });

    it('reads the role when the button is pressed, so a role removed meanwhile can no longer press', async () => {
      configure();
      connect();
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: PAY_CHANNEL, profitRoleId: ROLE });
      await run('run');
      const pay = idStarting(channel.sent[0]!.payload.components, 'payroll:pay');
      h.store.updatePanel(pid(), { profitRoleId: null });
      const refused = await press(pay, { user: helper, admin: false, roles: [ROLE] });
      assert.match(refused.text, /Only the admin who set up paying can work on this list\./);
      assert.equal(gw.calls.length, 0);
    });

    it('lets only one of two people who press Pay at once pay', async () => {
      configure();
      connect();
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: PAY_CHANNEL, profitRoleId: ROLE });
      await run('run');
      const pay = idStarting(channel.sent[0]!.payload.components, 'payroll:pay');
      const [a, b] = await Promise.all([press(pay), press(pay, { user: helper, admin: false, roles: [ROLE] })]);
      const texts = [a.text, b.text];
      assert.equal(texts.filter((t) => /✅ Paid/.test(t)).length, 1);
      assert.equal(texts.filter((t) => /Someone else pressed this a moment ago|expired, was replaced/.test(t)).length, 1);
      assert.equal(gw.calls.length, 2, 'two payments, once');
    });

    it("lets the admin work on a list in their DMs, where only they are, as long as they still are an admin or in the role", async () => {
      configure();
      connect();
      h.store.updatePanel(pid(), { profitSendTo: 'dm' });
      const asked = await run('run');
      assert.match(asked.text, /I sent the pay list to your DMs/);
      assert.deepEqual(asked.components, []);
      const dm = admin.dms[0];
      assert.match(dm.content, /Pilot payments: Test Air/);
      assert.deepEqual(dm.allowedMentions, noPings);
      const am = idStarting(dm.components, 'payroll:am');
      assert.match((await press(am, { guildId: null, admin: false })).text, /Only the admin who set up paying/, 'no longer an admin of the server');
      assert.match((await press(am, { guildId: null, notMember: true })).text, /Only the admin who set up paying/, 'no longer in the server');
      assert.match((await press(am, { guildId: null, user: stranger })).text, /Only the admin who set up paying/);
      assert.match((await press(am, { guildId: null })).text, /Amend:/);
      const done = await press(idStarting(dm.components, 'payroll:pay'), { guildId: null });
      assert.match(done.text, /✅ Paid \*\*2\*\* payments/);
      assert.doesNotMatch(done.text, /Pressed by/);
    });
  });

  describe('where the list goes', () => {
    it('falls back to the reply, with a line saying why, when the DMs are closed or the channel cannot be posted in', async () => {
      configure();
      h.store.updatePanel(pid(), { profitSendTo: 'dm' });
      admin.failDms = true;
      const dm = await run('run');
      assert.match(dm.text, /⚠️ I couldn't send it to your DMs \(DMs from this server are closed\), so it is here instead\./);
      assert.match(dm.text, /Pilot payments: Test Air/);
      assert.deepEqual(labelsOf(dm.components), ['Amend', 'Pay 2 · $9,500', 'Cancel'], 'and it can be worked on there');
      admin.failDms = false;
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: 'elsewhere' });
      const gone = await run('run');
      assert.match(gone.text, /⚠️ I couldn't post it in <#elsewhere> \(I can't post in that channel any more\), so it is here instead, for you alone\./);
      assert.match(gone.text, /Pilot payments: Test Air/);
      channel.hiddenFrom.add('the-bot');
      const broken = new FakeChannel(PAY_CHANNEL);
      broken.send = async () => {
        throw Object.assign(new Error('Missing Access'), { code: 50001 });
      };
      h.store.updatePanel(pid(), { profitChannelId: PAY_CHANNEL });
      const denied = await run('run', { guild: guildWith(broken) });
      assert.match(denied.text, /I couldn't post it in <#c-paylist> \(I'm missing access or permissions there\)/);
    });

    it('keeps only the newest list of a panel', async () => {
      configure();
      const first = await list();
      const token = idStarting(first.components, 'payroll:am').split(':')[2]!;
      assert.ok(h.store.getPayrollDraft(token, T0));
      await list();
      assert.equal(h.store.getPayrollDraft(token, T0), null);
    });

    it('sends a list made by itself where the panel sends the preview, and to the admin who set it up when that is "here"', async () => {
      configure();
      const draft = await d.ctx.payroll!.prepare(h.store.getPanel(pid())!, h.store.getPayrollSettings(pid())!);
      const settings = h.store.getPayrollSettings(pid())!;
      const dm = await sendList(d.ctx, h.store.getPanel(pid())!, settings, draft, { askerId: USER_A.discordId, client: d.client as any });
      assert.equal(dm?.where, 'dm');
      assert.equal(admin.dms.length, 1);
      assert.equal(channel.sent.length, 0);
      d.client.channels_.set(PAY_CHANNEL, channel);
      h.store.updatePanel(pid(), { profitSendTo: 'channel', profitChannelId: PAY_CHANNEL });
      const posted = await sendList(d.ctx, h.store.getPanel(pid())!, settings, draft, { askerId: USER_A.discordId, client: d.client as any });
      assert.equal(posted?.where, 'channel');
      assert.equal(channel.sent.length, 1);
      assert.equal(admin.dms.length, 1, 'not the DMs as well');
      channel.sent.length = 0;
      d.client.channels_.delete(PAY_CHANNEL);
      d.client.autoCreate = false;
      const instead = await sendList(d.ctx, h.store.getPanel(pid())!, settings, draft, { askerId: USER_A.discordId, client: d.client as any });
      assert.equal(instead?.where, 'dm', 'the channel is gone: the DMs of the admin instead');
      assert.match(admin.dms.at(-1).content, /I couldn't post it in <#c-paylist> \(I can't post in that channel any more\), so it is in your DMs instead/);
      admin.failDms = true;
      assert.equal(await sendList(d.ctx, h.store.getPanel(pid())!, settings, draft, { askerId: USER_A.discordId, client: d.client as any }), null, 'nowhere to send it');
    });
  });

  describe('the daily list', () => {
    let daily: PayrollDaily;
    beforeEach(() => {
      configure();
      h.store.savePayrollSettings(pid(), { runAtMinute: 13 * 60 });
      daily = new PayrollDaily(d.ctx, d.client as any);
    });
    const settingsNow = () => h.store.getPayrollSettings(pid())!;

    it('makes the list at the time chosen, once a day, and sends it to the DMs of the admin who set it up', async () => {
      await daily.run();
      assert.equal(admin.dms.length, 0, 'it is 12:00 and the list is made at 13:00');
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 1);
      assert.match(admin.dms[0].content, /Pilot payments: Test Air/);
      assert.deepEqual(labelsOf(admin.dms[0].components), ['Amend', 'Pay 2 · $9,500', 'Cancel']);
      assert.equal(settingsNow().lastRunDay, D11);
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 1, 'not twice in a day');
      h.clock.advance(23 * HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 2, 'and again the next day');
      assert.equal(gw.calls.length, 0, 'and it never pays anything');
    });

    it('does not send a list that is empty, and does not try again that day', async () => {
      sheets.schedule = [SCHEDULE_HEADER];
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 0);
      assert.equal(settingsNow().lastRunDay, D11);
    });

    it('does nothing for a panel that is switched off, and when payroll is not there at all', async () => {
      h.store.savePayrollSettings(pid(), { enabled: false });
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 0);
      d.ctx.payroll = null;
      await daily.run();
      assert.equal(admin.dms.length, 0);
    });

    it('tells the admin once a day when the list cannot be made, and tries again in half an hour', async () => {
      sheets.schedule = [['Name', 'Score']];
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(admin.dms.length, 1);
      assert.match(admin.dms[0].content, /I couldn't make today's pay list for \*\*Test Air\*\*: I couldn't read the schedule sheet/);
      assert.deepEqual(admin.dms[0].allowedMentions, noPings);
      assert.equal(settingsNow().lastRunDay, null);
      h.clock.advance(10 * 60_000);
      await daily.run();
      assert.equal(admin.dms.length, 1, 'not tried yet');
      h.clock.advance(30 * 60_000);
      await daily.run();
      assert.equal(admin.dms.length, 1, 'tried, failed again, and said nothing more today');
      sheets.schedule = schedule();
      h.clock.advance(31 * 60_000);
      await daily.run();
      assert.equal(admin.dms.length, 2, 'and then the list itself');
      assert.match(admin.dms[1].content, /Pilot payments/);
      assert.equal(settingsNow().lastRunDay, D11);
    });

    it('tries again later when the list could not be delivered anywhere', async () => {
      admin.failDms = true;
      h.clock.advance(HOUR);
      await daily.run();
      assert.equal(settingsNow().lastRunDay, null);
      assert.equal(h.store.getPayrollDraft('x', h.clock.now), null);
      admin.failDms = false;
      h.clock.advance(31 * 60_000);
      await daily.run();
      assert.equal(admin.dms.length, 1);
    });
  });

  describe('the history', () => {
    it('is empty at first, and then lists what was paid, refused or left without an answer', async () => {
      configure();
      connect();
      assert.match((await run('history')).text, /no payment has been made or tried yet/);
      gw.refuse.set('32411-KORD-EGLL-111026', 'Insufficient funds');
      const r = await list();
      await press(idStarting(r.components, 'payroll:pay'));
      const history = await run('history');
      assert.match(history.text, /the latest payments/);
      assert.match(history.text, /• ✅ paid · Sam Jones · \$2,000 · `41502-EGLL-EGCC-111026` · <t:\d+:f>/);
      assert.match(history.text, /• ❌ refused · Alex Smith · \$7,500 · `32411-KORD-EGLL-111026` · <t:\d+:f> · Insufficient funds/);
    });
  });
});

describe('the words of a result', () => {
  it('keeps even a very long result inside one message', () => {
    const line = (n: number): PayLine => ({ n, sourceKey: `k${n}`, row: n, pilot: 'P'.repeat(60), fshubId: 1, account: '2002-0001111', cents: 123456789, uniqueId: 'U'.repeat(64), dep: 'EGLL', arr: 'EGKK', day: D10, flags: [], amended: false, out: false });
    const many = Array.from({ length: 60 }, (_, i) => line(i + 1));
    const text = outcomeText(
      { connected: true, paid: many, failed: many.map((l) => ({ line: l, reason: 'r'.repeat(300) })), skipped: many.map((l) => ({ line: l, reason: 'changed' as const })), unconfirmed: many, held: many, tick: { done: many.map((l) => l.row), already: [], left: many.map((l) => ({ row: l.row, pilot: l.pilot, why: 'w'.repeat(300) })) } },
      `Pressed by <@${'1'.repeat(19)}>.`,
      T0,
    );
    assert.ok(text.length <= 2000, `${text.length} characters`);
    assert.match(text, /…and \d+ more\./);
    assert.match(text, /Pressed by/);
  });

  it('builds the amend form for a payment that was left out with its amount as 0', () => {
    const out: PayLine = { n: 2, sourceKey: 'k', row: 3, pilot: 'Sam', fshubId: 1, account: '2002-0001111', cents: 12345, uniqueId: 'abc', dep: 'EGLL', arr: 'EGKK', day: D10, flags: [], amended: false, out: true };
    const fields = amendModal('tok', out, 1).toJSON().components.map((r: any) => r.components[0].value);
    assert.deepEqual(fields, ['2002-0001111', '0', 'abc']);
    const cents = amendModal('tok', { ...out, out: false }, 1).toJSON().components.map((r: any) => r.components[0].value);
    assert.equal(cents[1], '123.45');
  });

  it('reads what a sheet with a Pilot Paid column says (ticked or not), and nothing when it has none', () => {
    const read = readSheetFlights(csv([SCHEDULE_HEADER, srow('KORD-EGLL', '11/10/2026', 'A', { paid: true }), srow('EGLL-EGCC', '11/10/2026', 'B')]))!;
    assert.deepEqual(read.flights.map((f) => f.pilotPaid), [true, false]);
    const without = readSheetFlights(csv([SCHEDULE_HEADER.filter((c) => c !== 'Pilot Paid'), ['KORD-EGLL', '11/10/2026', '0600-2359z', 'A', '', 'A320', 'TRUE', '$1', '$2']]))!;
    assert.deepEqual(without.flights.map((f) => f.pilotPaid), [null]);
  });
});
