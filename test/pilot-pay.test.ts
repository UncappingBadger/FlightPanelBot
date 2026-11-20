import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { previewText, profitReport } from '../src/discord/profitUi.js';
import { FsHubError, distanceNmOf, parseFlightPage, type FlightPage, type FsHubFlight } from '../src/fshub/client.js';
import { tokenProvider } from '../src/google/serviceAccount.js';
import { SheetsApi } from '../src/google/sheetsApi.js';
import { AirlineProfits, compareProfits, planPay, type ProfitAnalysis, type ProfitFillPlan } from '../src/services/airlineProfits.js';
import { pilotPay } from '../src/services/pilotPay.js';
import { SheetWriteBack } from '../src/services/writeback.js';
import type { LogFlight } from '../src/aeroconomy/account.js';
import { parseScheduleValues } from '../src/jobs/sheet.js';
import { readSheetFlights, type SheetFlight } from '../src/services/contributions.js';
import { HOUR, makeHarness, T0, USER_A, type Harness } from './helpers.js';
import { fakeComponent, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions } from './discord-helpers.js';
import { FakeGoogle, flightRow, HEADER, makeServiceAccount, SHEET_ID, TAB_GID } from './fake-google.js';

/* Everything below is made up: the airline (callsign code TST, FsHub airline 4242, Aeroconomy business 77), its aircraft, pilots and flights. */

const { account, publicKey } = makeServiceAccount();
const AIRLINE = 4242;
const BUSINESS = 77;
const D12 = Date.UTC(2026, 10, 12);

/* ------------------------------------------------------------------ the rule */

describe('what a pilot is paid for a flight', () => {
  it('pays a profitable flight 15% of the profit, and never less than $2,000', () => {
    assert.deepEqual(pilotPay(54489, null), { amount: 8174, basis: 'share' });
    assert.deepEqual(pilotPay(88552, null), { amount: 13283, basis: 'share' });
    assert.deepEqual(pilotPay(23931, null), { amount: 3590, basis: 'share' });
    assert.deepEqual(pilotPay(13333, null), { amount: 2000, basis: 'share' }, '15% comes to $1,999.95, which is $2,000');
    assert.deepEqual(pilotPay(13337, null), { amount: 2001, basis: 'share' }, '15% comes to $2,000.55');
    assert.deepEqual(pilotPay(13340, null), { amount: 2001, basis: 'share' }, '15% comes to exactly $2,001, which stays $2,001');
    assert.deepEqual(pilotPay(13300, null), { amount: 2000, basis: 'minimum' }, '$1,995 is less than the minimum');
    assert.deepEqual(pilotPay(7020, null), { amount: 2000, basis: 'minimum' });
    assert.deepEqual(pilotPay(1, null), { amount: 2000, basis: 'minimum' });
    assert.deepEqual(pilotPay(0, null), { amount: 2000, basis: 'minimum' }, 'a flight that broke even still pays the minimum');
  });

  it('rounds the pay UP to the next whole dollar, never to the nearest, and leaves a share that comes out even alone', () => {
    assert.deepEqual(pilotPay(54203, null), { amount: 8131, basis: 'share' }, '15% comes to $8,130.45: up, where the nearest would be $8,130');
    assert.deepEqual(pilotPay(54204, null), { amount: 8131, basis: 'share' }, '15% comes to $8,130.60 (the profit of $54,203.58 as the sheet keeps it)');
    assert.deepEqual(pilotPay(13401, null), { amount: 2011, basis: 'share' }, '15% comes to $2,010.15: up, where the nearest would be $2,010');
    assert.deepEqual(pilotPay(66667, null), { amount: 10001, basis: 'share' }, '15% comes to $10,000.05');
    assert.deepEqual(pilotPay(66666, null), { amount: 10000, basis: 'share' }, '15% comes to $9,999.90');
    for (const even of [20000, 40000, 100000, 1_000_000, 13340]) assert.equal(pilotPay(even, null)!.amount, (even * 15) / 100, `${even} is not pushed up a dollar by rounding noise`);
    for (let profit = 14000; profit < 14400; profit++) assert.equal(pilotPay(profit, null)!.amount, Math.floor((profit * 15 + 99) / 100), `${profit}`);
  });

  it('does not look at the distance of a profitable flight', () => {
    for (const nm of [null, 0, 600, 1001, 9566, Number.NaN, -3]) assert.deepEqual(pilotPay(54489, nm), { amount: 8174, basis: 'share' }, String(nm));
    assert.deepEqual(pilotPay(5000, 9566), { amount: 2000, basis: 'minimum' });
  });

  it('pays a flight that lost money $2,000, and $1,000 more for every further 500 nm flown, a started 500 counting as a whole one', () => {
    const loss = (nm: number) => pilotPay(-8000, nm);
    for (const nm of [0, 1, 117, 500, 999, 1000]) assert.deepEqual(loss(nm), { amount: 2000, basis: 'distance' }, `${nm} nm`);
    assert.deepEqual(loss(1001), { amount: 3000, basis: 'distance' }, "the CEO's own example");
    assert.deepEqual(loss(1500), { amount: 3000, basis: 'distance' });
    assert.deepEqual(loss(1501), { amount: 4000, basis: 'distance' });
    assert.deepEqual(loss(1502), { amount: 4000, basis: 'distance' }, "the CEO's other example");
    assert.deepEqual(loss(2000), { amount: 4000, basis: 'distance' });
    assert.deepEqual(loss(2001), { amount: 5000, basis: 'distance' });
    assert.deepEqual(loss(4826), { amount: 10000, basis: 'distance' });
    assert.deepEqual(loss(9566), { amount: 20000, basis: 'distance' });
    assert.deepEqual(loss(1000.4), { amount: 3000, basis: 'distance' }, 'a fraction of a mile past the base is a started stretch');
  });

  it('pays the same for a loss of a dollar as for a loss of a million', () => {
    assert.equal(pilotPay(-1, 1250)!.amount, 3000);
    assert.equal(pilotPay(-1_000_000, 1250)!.amount, 3000);
  });

  it('works out nothing for a flight that lost money without a distance it can trust, or from a profit that is not a number', () => {
    for (const nm of [null, Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.equal(pilotPay(-5, nm), null, String(nm));
    for (const p of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.equal(pilotPay(p, 800), null, String(p));
  });

});

/* ------------------------------------------------------------------ FsHub's distance */

describe("reading the distance FsHub recorded for a flight", () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    id: 5001,
    user: { id: 7001, name: 'Alex' },
    departure: { icao: 'EGLL', time: '2026-11-12T08:00:00Z' },
    arrival: { icao: 'EGCC', time: '2026-11-12T09:00:00Z' },
    distance: { nm: 392, km: 727 },
    ...over,
  });

  it('takes the nautical miles of the flight', () => {
    assert.equal(parseFlightPage([raw()]).flights[0]!.distanceNm, 392);
    assert.equal(parseFlightPage([raw({ distance: { nm: 0.5, km: 1 } })]).flights[0]!.distanceNm, 0.5);
    assert.equal(parseFlightPage([raw({ distance: { nm: '1502' } })]).flights[0]!.distanceNm, 1502);
  });

  it('takes none from anything that is not a sensible distance, and never loses the flight over it', () => {
    for (const odd of [undefined, null, 5, 'far', {}, { nm: null }, { nm: 'x' }, { nm: -4 }, { nm: Number.NaN }, { nm: 1e9 }, { km: 727 }, []]) {
      const page = parseFlightPage([raw({ distance: odd })]);
      assert.equal(page.flights.length, 1, JSON.stringify(odd));
      assert.equal(page.flights[0]!.distanceNm, null, JSON.stringify(odd));
    }
    assert.equal(distanceNmOf({ nm: 100000 }), 100000);
    assert.equal(distanceNmOf({ nm: 100000.5 }), null);
    assert.equal(distanceNmOf({ nm: '12 ' }), 12);
  });
});

/* ------------------------------------------------------------------ planning the pay beside a profit */

const sheetRow = (over: Partial<SheetFlight> = {}): SheetFlight => ({
  row: 3,
  route: 'EGLL → EGCC',
  sourceKey: 'EGLL-EGCC@2026-11-12',
  flightNumber: null,
  day: D12,
  pilot: 'Alex',
  completed: true,
  profit: null,
  profitRaw: '',
  payRaw: '',
  ...over,
});
const lf = (over: Partial<LogFlight> = {}): LogFlight => ({
  entryId: 1,
  flightId: 5000,
  callsign: 'TST101',
  dep: 'EGLL',
  arr: 'EGCC',
  pilotId: 7001,
  pilotName: 'Alex',
  profit: -8000,
  landedAt: D12 + 10 * HOUR,
  distanceNm: 1502,
  ...over,
});

describe('planning the pilot pay beside a blank profit', () => {
  const plan = (row: SheetFlight, flight: LogFlight, distances: Array<[number, number]> = []) => planPay(Math.ceil(flight.profit), row, flight.flightId, flight.distanceNm, new Map(distances));

  it('works a loss out from FsHub\'s distance when the logbook agrees with it', () => {
    assert.deepEqual(plan(sheetRow(), lf(), [[5000, 1502]]), { amount: 4000, basis: 'distance', distanceNm: 1502, problem: null, cell: 'empty' });
  });

  it('uses FsHub\'s own figure: the logbook is only there to agree with it, to within a mile', () => {
    assert.deepEqual(plan(sheetRow(), lf({ distanceNm: 1501.4 }), [[5000, 1502]]), { amount: 4000, basis: 'distance', distanceNm: 1502, problem: null, cell: 'empty' });
    assert.deepEqual(plan(sheetRow(), lf({ distanceNm: 1503 }), [[5000, 1502]]).amount, 4000, 'one mile out is the same flight');
    assert.deepEqual(plan(sheetRow(), lf({ distanceNm: 1503.1 }), [[5000, 1502]]), { amount: null, basis: null, distanceNm: null, problem: 'distance-differs', cell: 'empty' });
    assert.equal(plan(sheetRow(), lf({ distanceNm: null }), [[5000, 1502]]).amount, 4000, 'a logbook with no distance does not stand in the way of FsHub having one');
  });

  it('works out nothing for a loss that FsHub gave no distance for, or that names no FsHub flight, and says why', () => {
    assert.equal(plan(sheetRow(), lf()).problem, 'no-distance');
    assert.equal(plan(sheetRow(), lf(), [[9999, 1502]]).problem, 'no-distance', "another flight's distance is not this one's");
    assert.equal(plan(sheetRow(), lf({ flightId: null }), [[5000, 1502]]).problem, 'no-flight-id');
    const none = plan(sheetRow(), lf());
    assert.deepEqual([none.amount, none.basis, none.distanceNm], [null, null, null]);
  });

  it('needs no distance at all for a profit', () => {
    assert.deepEqual(plan(sheetRow(), lf({ profit: 54489, flightId: null })), { amount: 8174, basis: 'share', distanceNm: null, problem: null, cell: 'empty' });
    assert.deepEqual(plan(sheetRow(), lf({ profit: 1000 })), { amount: 2000, basis: 'minimum', distanceNm: null, problem: null, cell: 'empty' });
    assert.equal(planPay(0, sheetRow(), null, null, new Map()).basis, 'minimum', 'a profit that rounds to nothing is not a loss');
    assert.equal(planPay(-1, sheetRow(), 5000, null, new Map([[5000, 100]])).basis, 'distance');
  });

  it('knows what is in the sheet\'s Pilot Pay cell: no pay, a pay, or no such column', () => {
    assert.equal(plan(sheetRow({ payRaw: '' }), lf({ profit: 9000 })).cell, 'empty');
    for (const filled of [' ', '$1,500', '$0.01', '=J3*0.15', 'TBD', '-', '$34']) assert.equal(plan(sheetRow({ payRaw: filled }), lf({ profit: 9000 })).cell, 'filled', JSON.stringify(filled));
    assert.equal(plan(sheetRow({ payRaw: null }), lf({ profit: 9000 })).cell, 'missing');
  });

  it('counts a plain zero as no pay, because a column formatted as money shows $0 for an empty cell', () => {
    for (const zero of ['$0', '0', '$0.00', ' $0 ', '0.00', '£0']) {
      const p = plan(sheetRow({ payRaw: zero }), lf({ profit: 9000 }));
      assert.deepEqual([p.cell, p.amount, p.basis], ['empty', 2000, 'minimum'], JSON.stringify(zero)); // 15% of $9,000 is under the $2,000 minimum
    }
  });

  it('leaves a cell alone that is back to no pay after this bot wrote one there: somebody set it to $0 on purpose', () => {
    const wrote = (payRaw: string) => planPay(9000, sheetRow({ payRaw }), 5000, 500, new Map(), true);
    for (const back of ['$0', '0', '']) assert.deepEqual(wrote(back), { amount: null, basis: null, distanceNm: null, problem: null, cell: 'zeroed' }, JSON.stringify(back));
    assert.equal(wrote('$1,500').cell, 'filled', 'a pay above zero is simply a pay');
    assert.equal(planPay(9000, sheetRow({ payRaw: null }), 5000, 500, new Map(), true).cell, 'missing');
    assert.equal(planPay(9000, sheetRow({ payRaw: '$0' }), 5000, 500, new Map(), false).cell, 'empty', 'where the bot never wrote, a $0 is free to be written over');
  });

  it('hands a pay to be written only when its cell has no pay in it and it could be worked out', () => {
    const rows = [
      sheetRow({ row: 3, payRaw: '' }),
      sheetRow({ row: 4, sourceKey: 'a@b', pilot: 'B', route: 'EGCC → EGLL', payRaw: '$1,500' }),
      sheetRow({ row: 5, sourceKey: 'c@d', pilot: 'C', route: 'KMIA → KORD', payRaw: null }),
      sheetRow({ row: 6, sourceKey: 'e@f', pilot: 'D', route: 'EGKK → EGLL', payRaw: '' }),
    ];
    const flights = [
      lf({ profit: 54489 }),
      lf({ entryId: 2, dep: 'EGCC', arr: 'EGLL', pilotName: 'B', profit: 54489, flightId: 1 }),
      lf({ entryId: 3, dep: 'KMIA', arr: 'KORD', pilotName: 'C', profit: 54489, flightId: 2 }),
      lf({ entryId: 4, dep: 'EGKK', arr: 'EGLL', pilotName: 'D', profit: -300, flightId: 3, distanceNm: 800 }),
    ];
    const r = compareProfits(rows, flights, 'TST');
    assert.deepEqual(r.fills.map((f) => [f.row, f.pay]), [[3, 8174], [4, null], [5, null], [6, null]]);
    const withFsHub = compareProfits(rows, flights, 'TST', new Map([[3, 800]]));
    assert.deepEqual(withFsHub.fills.map((f) => [f.row, f.pay]), [[3, 8174], [4, null], [5, null], [6, 2000]]);
  });

  it('hands a pay for a $0 cell too, but not for one the bot wrote a pay to before', () => {
    const rows = [sheetRow({ row: 3, payRaw: '$0' }), sheetRow({ row: 4, sourceKey: 'a@b', pilot: 'B', route: 'EGCC → EGLL', payRaw: '$0' })];
    const flights = [lf({ profit: 54489 }), lf({ entryId: 2, dep: 'EGCC', arr: 'EGLL', pilotName: 'B', profit: 54489, flightId: 1 })];
    assert.deepEqual(compareProfits(rows, flights, 'TST').fills.map((f) => [f.row, f.pay, f.payPlan.cell]), [[3, 8174, 'empty'], [4, 8174, 'empty']]);
    const again = compareProfits(rows, flights, 'TST', new Map(), new Set(['a@b']));
    assert.deepEqual(again.fills.map((f) => [f.row, f.pay, f.payPlan.cell]), [[3, 8174, 'empty'], [4, null, 'zeroed']]);
    assert.ok(again.fills.every((f) => f.value === 54489), 'the profit is filled either way');
  });
});

/* ------------------------------------------------------------------ finding the Pilot Pay column */

describe('finding the Pilot Pay column', () => {
  const grid = (header: string[]): string[][] => [header, ['EGLL-EGCC', '11/12/2026', '0600-2359z', '', 'Alex', '', 'A320', 'TRUE', 'TRUE', '$5,000', '$750', '$4,250']];
  const HDR = [...HEADER, 'Profit Made', 'Pilot Pay', 'Airline Profit'];

  it('is the column called Pilot Pay, and not the Pilot Paid box before it', () => {
    const parsed = parseScheduleValues(grid(HDR), T0)!;
    assert.deepEqual(parsed.cols, { pilot: 4, done: 7, profit: 9, pay: 10, distance: -1, flightNo: -1 });
    const read = readSheetFlights(csvOf(grid(HDR)))!;
    assert.deepEqual([read.hasPay, read.flights[0]!.payRaw, read.flights[0]!.profitRaw], [true, '$750', '$5,000']);
  });

  it('is absent when the sheet has only the Pilot Paid box, and every row then says there is no such cell', () => {
    const header = HDR.filter((n) => n !== 'Pilot Pay');
    assert.equal(parseScheduleValues(grid(header), T0)!.cols.pay, -1);
    const read = readSheetFlights(csvOf(grid(header)))!;
    assert.equal(read.hasPay, false);
    assert.ok(read.flights.every((f) => f.payRaw === null));
  });

  it('reads a Pilot Pay cell exactly as it is, empty only when it is', () => {
    const rows = [HDR, ['EGLL-EGCC', '11/12/2026', '0600-2359z', '', 'Alex', '', 'A320', 'TRUE', 'TRUE', '', ' '], ['EGCC-EGLL', '11/12/2026', '0600-2359z', '', 'Sam', '', 'A320', 'TRUE', 'TRUE', '', ''], ['EGLL-EGKK', '11/12/2026', '0600-2359z', '', 'Pat', '', 'A320', 'TRUE', 'TRUE']];
    const read = readSheetFlights(csvOf(rows))!;
    assert.deepEqual(read.flights.map((f) => f.payRaw), [' ', '', '']);
  });
});

/* ------------------------------------------------------------------ reading both sides, with FsHub */

const GRID_HEADER = [...HEADER, 'Profit Made', 'Pilot Pay'];
const row = (route: string, date: string, pilot: string, done: boolean, profit: string, pay: string, window = '0600-2359z'): string[] => [...flightRow(route, date, pilot, done, 'A320', window), profit, pay];
const csvOf = (grid: string[][]) => grid.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
/** The icao of the n-th made-up airport: EGAA, EGAB, ... */
const apt = (i: number) => `EG${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;

describe('working out the pay when reading an airline', () => {
  let h: Harness;
  let sheet: string[][];
  let logbook: LogFlight[];
  let asked: Array<[number, number, number]>;
  let answer: (cursor: number) => Promise<FlightPage>;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const page = (flights: Array<Partial<FsHubFlight> & { id: number }>): FlightPage => ({
    flights: flights.map((f) => ({ pilotId: 7001, pilotName: 'Alex', dep: 'EGLL', arr: 'EGCC', departedAt: null, arrivedAt: T0, aircraftIcao: null, aircraftName: null, scheduleStatus: null, ...f })),
    count: flights.length,
    lastId: flights.at(-1)?.id ?? null,
    firstAt: null,
    lastAt: null,
  });
  const profits = (withFsHub = true) =>
    new AirlineProfits({
      store: h.store,
      account: {
        ownedAircraft: async (b: number) => [{ serial: 151, registration: null, type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: b }],
        aircraft: async () => null,
        logbook: async () => logbook,
      },
      publicClient: { pilotAircraftOwner: async () => ({ airlineId: AIRLINE, businessId: BUSINESS }) },
      ...(withFsHub
        ? {
            fshub: {
              airlineFlights: async (airline: number, cursor: number, limit: number) => {
                asked.push([airline, cursor, limit]);
                return answer(cursor);
              },
            },
          }
        : {}),
      fetchFn: (async () => new Response(csvOf(sheet), { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch,
      now: () => h.clock.now,
    });

  /** Rows 2.. of the sheet, one completed flight each from EGLL to a made-up airport, with the logbook flight for each. */
  const manyLosses = (n: number, pay = '') => {
    sheet = [GRID_HEADER, ...Array.from({ length: n }, (_, i) => row(`EGLL-${apt(i)}`, '11/12/2026', 'Alex', true, '', pay))];
    logbook = Array.from({ length: n }, (_, i) => lf({ entryId: i + 1, dep: 'EGLL', arr: apt(i), callsign: `TST${100 + i}`, flightId: 6000 + i, profit: -500, distanceNm: 1502 }));
  };

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
    asked = [];
    answer = async (cursor) => page([{ id: cursor + 1, distanceNm: 1502 }]);
    sheet = [
      GRID_HEADER,
      row('EGLL-EGCC', '11/12/2026', 'Alex', true, '', ''), // row 2: a profit
      row('KMIA-KORD', '11/12/2026', 'Sam', true, '', ''), // row 3: a loss
    ];
    logbook = [lf({ profit: 54489, distanceNm: 500, flightId: 5000 }), lf({ entryId: 2, dep: 'KMIA', arr: 'KORD', pilotName: 'Sam', callsign: 'TST202', profit: -4000.4, flightId: 5001, distanceNm: 1502, landedAt: D12 + 20 * HOUR })];
  });
  afterEach(async () => {
    await h.close();
  });

  it("asks FsHub how far a flight that lost money was flown, with the flight just before it as the cursor, and works the pay out from the answer", async () => {
    const a = await profits().analyse(panel());
    assert.deepEqual(asked, [[AIRLINE, 5000, 1]], 'one request, for the loss only: a profit needs no distance');
    assert.deepEqual(
      a.fills.map((f) => [f.row, f.value, f.pay, f.payPlan.basis, f.payPlan.distanceNm]),
      [[2, 54489, 8174, 'share', null], [3, -4000, 4000, 'distance', 1502]],
    );
  });

  it('takes the distance from the flight FsHub names, not from whatever it lists first', async () => {
    answer = async () => page([{ id: 4999, distanceNm: 100 }, { id: 5001, distanceNm: 1502 }, { id: 5002, distanceNm: 3000 }]);
    const a = await profits().analyse(panel());
    assert.equal(a.fills[1]!.pay, 4000);
  });

  it('does not take a pay from a flight FsHub does not list, nor from one it gave no distance for', async () => {
    answer = async () => page([{ id: 7777, distanceNm: 1502 }]);
    assert.equal((await profits().analyse(panel())).fills[1]!.payPlan.problem, 'no-distance');
    answer = async () => page([{ id: 5001, distanceNm: null }]);
    assert.equal((await profits().analyse(panel())).fills[1]!.payPlan.problem, 'no-distance');
    answer = async () => page([]);
    const a = await profits().analyse(panel());
    assert.deepEqual([a.fills[1]!.pay, a.fills[1]!.payPlan.problem], [null, 'no-distance']);
    assert.equal(a.fills[0]!.pay, 8174, 'the profit\'s pay does not depend on it');
  });

  it('works out no pay for a loss when FsHub and the logbook disagree about the distance', async () => {
    answer = async (cursor) => page([{ id: cursor + 1, distanceNm: 1700 }]);
    const a = await profits().analyse(panel());
    assert.deepEqual([a.fills[1]!.pay, a.fills[1]!.payPlan.problem], [null, 'distance-differs']);
  });

  it('carries on past an error for one flight, and stops when FsHub says it is busy', async () => {
    manyLosses(5);
    answer = async (cursor) => {
      if (cursor === 6000 - 1 + 1) throw new Error('boom'); // the second flight
      if (cursor === 6002 - 1) throw new FsHubError('rate-limited', 'busy'); // the third
      return page([{ id: cursor + 1, distanceNm: 1502 }]);
    };
    const a = await profits().analyse(panel());
    assert.deepEqual(asked.map((q) => q[1]), [5999, 6000, 6001], 'no more questions once FsHub is busy');
    assert.deepEqual(a.fills.map((f) => f.pay), [4000, null, null, null, null]);
    assert.deepEqual(a.fills.map((f) => f.payPlan.problem), [null, 'no-distance', 'no-distance', 'no-distance', 'no-distance']);
  });

  it('asks about no more than 25 flights in a run, and leaves the rest to the next one, saying so', async () => {
    manyLosses(30);
    const a = await profits().analyse(panel());
    assert.deepEqual(asked.map((q) => q[1]), Array.from({ length: 25 }, (_, i) => 5999 + i), 'the first 25, in row order');
    assert.equal(a.fills.length, 30);
    assert.equal(a.fills.filter((f) => f.pay === 4000).length, 25);
    assert.deepEqual(a.fills.slice(25).map((f) => [f.pay, f.payPlan.problem]), Array.from({ length: 5 }, () => [null, 'no-distance']));
  });

  it('asks FsHub nothing about a flight whose Pilot Pay already has a pay in it, or the sheet has no column for', async () => {
    sheet = sheet.map((r, i) => (i === 0 ? r : [...r.slice(0, 10), '$34']));
    const a = await profits().analyse(panel());
    assert.deepEqual(asked, []);
    assert.deepEqual(a.fills.map((f) => [f.payPlan.cell, f.pay]), [['filled', null], ['filled', null]]);
    sheet = sheet.map((r) => r.slice(0, 10));
    const b = await profits().analyse(panel());
    assert.deepEqual(asked, []);
    assert.deepEqual(b.fills.map((f) => [f.payPlan.cell, f.pay]), [['missing', null], ['missing', null]]);
  });

  it('treats the $0 of a money-formatted empty cell as no pay: it works the pay out, and asks FsHub about a loss as it does for a blank one', async () => {
    sheet = sheet.map((r, i) => (i === 0 ? r : [...r.slice(0, 10), '$0']));
    const a = await profits().analyse(panel());
    assert.deepEqual(asked, [[AIRLINE, 5000, 1]]);
    assert.deepEqual(a.fills.map((f) => [f.payPlan.cell, f.pay]), [['empty', 8174], ['empty', 4000]]);
  });

  it('leaves a $0 alone where this bot wrote a pay before, since somebody set it back on purpose, and asks FsHub nothing for it', async () => {
    sheet = sheet.map((r, i) => (i === 0 ? r : [...r.slice(0, 10), '$0']));
    h.store.recordPayWrites(h.panel.id, [{ sourceKey: 'KMIA-KORD@2026-11-12', cents: 400000 }], T0);
    const a = await profits().analyse(panel());
    assert.deepEqual(asked, [], 'the loss is the one that was zeroed, and the profit needs no distance');
    assert.deepEqual(a.fills.map((f) => [f.row, f.value, f.payPlan.cell, f.pay]), [[2, 54489, 'empty', 8174], [3, -4000, 'zeroed', null]]);
  });

  it('works out no pay for a loss, and says so, when it has no way of asking FsHub', async () => {
    const a = await profits(false).analyse(panel());
    assert.deepEqual([a.fills[0]!.pay, a.fills[1]!.pay, a.fills[1]!.payPlan.problem], [8174, null, 'no-distance']);
  });
});

/* ------------------------------------------------------------------ writing the pay */

describe('writing the pay beside a profit', () => {
  let h: Harness;
  let g: FakeGoogle;
  let wb: SheetWriteBack;
  const panel = () => h.store.getPanel(h.panel.id)!;
  const K = { open: 'EGLL-EGCC@2026-11-12', second: 'EGCC-EGLL@2026-11-12', third: 'KMIA-KORD@2026-11-12' };
  const grid = (): string[][] => [
    GRID_HEADER,
    ['Week 2', '11/8/2026', 'Week 2'],
    row('EGLL-EGCC', '11/12/2026', 'Alex', true, '', ''), // row 3
    row('EGCC-EGLL', '11/12/2026', 'Taylor', true, '', '$1,500'), // row 4: a pay cell with a pay in it
    row('KMIA-KORD', '11/12/2026', 'Sam', true, '', '', '1200-0600z'), // row 5
  ];
  const fill = (rowNumber: number, value: number, pilot: string, key: string, pay?: number | null) => ({ sourceKey: key, value, row: rowNumber, pilot, ...(pay !== undefined ? { pay } : {}) });

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = grid();
    wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID) });
  });
  afterEach(async () => {
    await h.close();
  });

  it('writes the pay into the empty Pilot Pay cell of the same row, in the same request as the profit, as a number', async () => {
    const got = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174), fill(5, -4000, 'Sam', K.third, 4000)]);
    assert.deepEqual(got.written.map((w) => [w.cell, w.value]), [['J3', 54489], ['J5', -4000]]);
    assert.deepEqual(got.paid.map((w) => [w.cell, w.value]), [['K3', 8174], ['K5', 4000]]);
    assert.equal(got.payLeft, 0);
    assert.equal(g.writes.length, 1, 'one request');
    assert.deepEqual(g.writes[0]!.data.map((d) => d.range.split('!')[1]), ['J3', 'K3', 'J5', 'K5']);
    assert.ok(g.writes[0]!.data.every((d) => typeof d.values[0]![0] === 'number'), 'numbers, not text');
    assert.deepEqual([g.cell('J3'), g.cell('K3'), g.cell('J5'), g.cell('K5')], ['54489', '8174', '-4000', '4000']);
  });

  it('never replaces a Pilot Pay cell that has a pay or anything else in it: it writes the profit and leaves the pay as it is', async () => {
    const got = await wb.fillProfits(panel(), [fill(4, 20000, 'Taylor', K.second, 3000)]);
    assert.deepEqual(got.written.map((w) => w.cell), ['J4']);
    assert.deepEqual(got.paid, []);
    assert.equal(got.payLeft, 1);
    assert.equal(g.cell('K4'), '$1,500', 'still what it was');
    for (const [what, setup] of [
      ['a note', () => void (g.values[2]![10] = 'TBD')],
      ['a stray space', () => void (g.values[2]![10] = ' ')],
      ['a cent', () => void (g.values[2]![10] = '$0.01')],
      ['a dash', () => void (g.values[2]![10] = '-')],
      ['a formula that shows nothing', () => void g.formulas.set('K3', '=IF(1=2,1,"")')],
      ['a formula that works out to zero', () => void ((g.values[2]![10] = '$0'), g.formulas.set('K3', '=J3*0'))],
      ['a formula with a value', () => void ((g.values[2]![10] = '$1,200'), g.formulas.set('K3', '=J3*0.15'))],
    ] as Array<[string, () => void]>) {
      g.values = grid();
      g.formulas.clear();
      setup();
      const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174)]);
      assert.deepEqual(r.paid, [], what);
      assert.equal(r.payLeft, 1, what);
      assert.deepEqual(r.written.map((w) => w.cell), ['J3'], `${what}: the profit still goes in`);
      assert.notEqual(g.cell('K3'), '8174', what);
    }
  });

  it('writes over a Pilot Pay cell that holds only a zero (a money-formatted column shows $0 for an empty cell)', async () => {
    for (const shown of ['$0', '$0.00', '0', ' $0 ']) {
      g.values = grid();
      g.values[2]![10] = shown;
      const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174)]);
      assert.deepEqual(r.paid.map((w) => [w.cell, w.value]), [['K3', 8174]], shown);
      assert.equal(r.payLeft, 0);
      assert.equal(g.cell('K3'), '8174');
      assert.deepEqual(g.writes.at(-1)!.data.map((d) => d.range.split('!')[1]), ['J3', 'K3']);
    }
  });

  it('writes no pay where none was worked out', async () => {
    for (const none of [null, undefined]) {
      g.values = grid();
      const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, none)]);
      assert.deepEqual([r.written.length, r.paid.length, r.payLeft], [1, 0, 0]);
      assert.equal(g.cell('K3'), '');
    }
    g.values = grid();
    const zero = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 0)]);
    assert.deepEqual(zero.paid.map((w) => w.value), [0], 'a pay of nothing is still a pay that was asked for');
  });

  it('leaves a pay unwritten when the sheet has no Pilot Pay column at all, and counts it as left', async () => {
    g.values = grid().map((r) => r.slice(0, 10));
    const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174)]);
    assert.deepEqual([r.written.length, r.paid.length, r.payLeft], [1, 0, 1]);
    assert.equal(g.writes[0]!.data.length, 1);
  });

  it('does not write a pay for a profit it skipped', async () => {
    g.values[2]![9] = '$13,000.00';
    const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174), fill(5, -4000, 'Sam', K.third, 4000)]);
    assert.deepEqual(r.skipped, [{ sourceKey: K.open, reason: 'filled' }]);
    assert.deepEqual(r.paid.map((w) => w.cell), ['K5']);
    assert.equal(r.payLeft, 0);
    assert.equal(g.cell('K3'), '', 'the pay beside a profit that was not written is not written either');
  });

  it('looks again at the pay cell when it writes, so a manager who typed one meanwhile is not overwritten', async () => {
    g.beforeNextRead = () => {
      g.values[2]![10] = '$1,500';
    };
    const r = await wb.fillProfits(panel(), [fill(3, 54489, 'Alex', K.open, 8174)]);
    assert.deepEqual([r.written.length, r.paid.length, r.payLeft], [1, 0, 1]);
    assert.equal(g.cell('K3'), '$1,500');
  });
});

/* ------------------------------------------------------------------ what the admin reads */

describe('what the admin reads about the pay', () => {
  const plan = (over: Partial<ProfitFillPlan> = {}, pay: Partial<ProfitFillPlan['payPlan']> = {}): ProfitFillPlan => ({
    sourceKey: 'k',
    value: 54489,
    pay: 8174,
    row: 3,
    pilot: 'Alex',
    route: 'EGLL → EGCC',
    day: D12,
    callsign: 'TST101',
    exact: 54489.2,
    flightId: 5000,
    logbookNm: 500,
    payPlan: { amount: 8174, basis: 'share', distanceNm: null, problem: null, cell: 'empty', ...pay },
    ...over,
  });
  const analysis = (fills: ProfitFillPlan[]): ProfitAnalysis => ({ business: BUSINESS, aircraft: 1, leased: 0, leasedHidden: 0, leasedProblem: null, logbookFlights: 3, usableFlights: 3, sheetCompleted: 3, matched: 3, agree: 0, fills, different: [], unreadable: 0, unmatched: 0, ambiguous: 0, readAt: T0 });

  it('shows each pay and how it was worked out, in the preview and in the report', () => {
    const fills = [
      plan(),
      plan({ row: 4, value: 5000, pay: 2000, payPlan: { amount: 2000, basis: 'minimum', distanceNm: null, problem: null, cell: 'empty' } }),
      plan({ row: 5, value: -4000, pay: 4000, payPlan: { amount: 4000, basis: 'distance', distanceNm: 1502, problem: null, cell: 'empty' } }),
    ];
    for (const text of [previewText('Test Air', fills), profitReport('Test Air', analysis(fills))]) {
      assert.match(text, /row 3 · .* · \$54,489.* · pilot pay \$8,174 \(15% of the profit\)/);
      assert.match(text, /row 4 · .* · pilot pay \$2,000 \(the \$2,000 minimum\)/);
      assert.match(text, /row 5 · .* · -\$4,000.* · pilot pay \$4,000 \(loss, 1,502 nm flown\)/);
    }
    assert.match(previewText('Test Air', fills), /the pilot's pay into \*\*3\*\* Pilot Pay cells that are empty or \$0: 15% of the profit, rounded up to a whole dollar \(at least \$2,000\), or for a flight that lost money \$2,000 plus \$1,000 per 500 nm beyond the first 1,000, by FsHub's distance/);
    assert.match(profitReport('Test Air', analysis(fills)), /Pilot Pay beside those: \*\*3\*\* empty or \$0, with a pay I can work out/);
  });

  it('says why a pay is not worked out, and leaves a filled pay cell out of the lines', () => {
    const fills = [
      plan({ row: 3, pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: 'no-distance', cell: 'empty' } }),
      plan({ row: 4, pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: 'distance-differs', cell: 'empty' } }),
      plan({ row: 5, pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: 'no-flight-id', cell: 'empty' } }),
      plan({ row: 6, pay: null, payPlan: { amount: 8174, basis: 'share', distanceNm: null, problem: null, cell: 'filled' } }),
      // A loss whose pay cell is already filled in: nothing was asked of FsHub, so no pay was worked out, and that is not a problem to report.
      plan({ row: 7, pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: 'no-distance', cell: 'filled' } }),
    ];
    const text = previewText('Test Air', fills);
    assert.match(text, /row 3 · .* · pilot pay: FsHub gave no distance, so it isn't worked out/);
    assert.match(text, /row 4 · .* · pilot pay: FsHub and Aeroconomy don't agree on the distance, so it isn't worked out/);
    assert.match(text, /row 5 · .* · pilot pay: the logbook names no FsHub flight, so the distance can't be checked/);
    for (const filledRow of ['• row 6', '• row 7']) assert.doesNotMatch(text.split('\n').find((l) => l.startsWith(filledRow)) ?? '', /pilot pay/, filledRow);
    assert.match(text, /\*\*2\*\* already have a pay in Pilot Pay; \*\*3\*\* have a pay I can't work out: left as they are/);
    assert.match(profitReport('Test Air', analysis(fills)), /Pilot Pay beside those: \*\*3\*\* empty or \$0, with a pay I can't work out yet, \*\*2\*\* already have a pay in them \(left exactly as they are\)/);
  });

  it('says which pay cells were set back to $0 after the bot wrote one, and leaves them out of the lines', () => {
    const fills = [
      plan({ row: 3 }),
      plan({ row: 4, pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: null, cell: 'zeroed' } }),
    ];
    const text = previewText('Test Air', fills);
    assert.match(text, /row 4 · .* · pilot pay: left at \$0 \(it was set back to \$0 after I wrote one\)/);
    assert.doesNotMatch(text.split('\n').find((l) => l.startsWith('• row 3')) ?? '', /left at/);
    assert.match(text, /\*\*1\*\* were set back to \$0 after I wrote a pay: left as they are/);
    assert.match(profitReport('Test Air', analysis(fills)), /\*\*1\*\* empty or \$0, with a pay I can work out, \*\*1\*\* set back to \$0 after I wrote one \(left alone\)/);
  });

  it('says plainly that only the profit would be written when every pay cell already has something in it, or there is none', () => {
    const filled = [plan({ pay: null, payPlan: { amount: 8174, basis: 'share', distanceNm: null, problem: null, cell: 'filled' } }), plan({ row: 4, pay: null, payPlan: { amount: 2000, basis: 'minimum', distanceNm: null, problem: null, cell: 'filled' } })];
    const text = previewText('Test Air', filled);
    assert.match(text, /\*\*2\*\* Profit Made cells that are empty today \(\*\*2\*\* already have a pay in Pilot Pay: left as they are\)\. I would change nothing else/);
    assert.doesNotMatch(text, /the pilot's pay into/);
    assert.match(profitReport('Test Air', analysis(filled)), /Pilot Pay beside those: \*\*2\*\* already have a pay in them \(left exactly as they are\)/);
    const none = [plan({ pay: null, payPlan: { amount: null, basis: null, distanceNm: null, problem: null, cell: 'missing' } })];
    assert.match(previewText('Test Air', none), /empty today\. The sheet has no Pilot Pay column\. I would change nothing else/);
    assert.match(profitReport('Test Air', analysis(none)), /The sheet has no Pilot Pay column, so only Profit Made would be filled/);
  });

  it('keeps a long preview and report inside one Discord message with pay on every line', () => {
    const many = Array.from({ length: 40 }, (_, i) => plan({ row: 100 + i, value: -123456789 - i, pay: 18518518, payPlan: { amount: 18518518, basis: 'distance', distanceNm: 99999, problem: null, cell: 'empty' } }));
    assert.ok(previewText('Test Air', many).length <= 1990, `${previewText('Test Air', many).length} characters`);
    assert.ok(profitReport('Test Air', analysis(many)).length <= 1800, `${profitReport('Test Air', analysis(many)).length} characters`);
    assert.match(previewText('Test Air', many), /Nothing is written unless you press \*\*Write\*\*/);
  });
});

/* ------------------------------------------------------------------ the command, end to end */

describe('/setup profit action:fill with a Pilot Pay column', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const profitButtons = componentHandlers.find((c) => c.prefix === 'profit')!;
  let h: Harness;
  let d: DiscordHarness;
  let g: FakeGoogle;
  let asked: number[];
  let admin: FakeUser;

  const run = async (o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub: 'profit', admin: true, userId: USER_A.discordId, ...o });
    await setup.execute(d.ctx, f.i);
    await settle(40);
    const last = f.calls.edits.at(-1);
    return { text: String(last?.content ?? ''), components: (last?.components ?? []) as any[] };
  };
  const press = async (customId: string) => {
    const f = fakeComponent(admin, customId, { admin: true });
    await profitButtons.handle(d.ctx, f.i);
    await settle(40);
    return String((f.calls.edits.at(-1) ?? f.calls.updates.at(-1))?.content ?? '');
  };
  const idsOf = (components: any[]): string[] => components.flatMap((r: any) => (r.toJSON?.().components ?? r.components ?? []).map((c: any) => c.custom_id ?? c.customId));

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0;
    g = new FakeGoogle(publicKey);
    g.values = [
      GRID_HEADER,
      ['Week 2', '11/8/2026', 'Week 2'],
      row('EGLL-EGCC', '11/12/2026', 'Alex', true, '', ''), // row 3: a profit, pay cell empty
      row('KMIA-KORD', '11/12/2026', 'Sam', true, '', '', '1200-0600z'), // row 4: a loss, pay cell empty
      row('EGCC-EGLL', '11/12/2026', 'Taylor', true, '', '$1,500'), // row 5: a profit, pay cell already has a pay
    ];
    const wb = new SheetWriteBack(new SheetsApi(tokenProvider(account, g.fetchFn, () => h.clock.now), g.fetchFn), account.email, { now: () => h.clock.now });
    d = makeDiscordHarness(h, { writeback: wb });
    admin = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    asked = [];
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: String(TAB_GID), fshubAirlineId: AIRLINE, writeback: true });
    h.store.setKv(`aero.business.${AIRLINE}`, String(BUSINESS));
    const logbook = [
      lf({ profit: 54489, distanceNm: 500, flightId: 5000 }),
      lf({ entryId: 2, dep: 'KMIA', arr: 'KORD', pilotName: 'Sam', callsign: 'TST202', profit: -4000.4, flightId: 5001, distanceNm: 1502, landedAt: D12 + 20 * HOUR }),
      lf({ entryId: 3, dep: 'EGCC', arr: 'EGLL', pilotName: 'Taylor', callsign: 'TST303', profit: 20000, flightId: 5002, distanceNm: 300 }),
    ];
    d.ctx.profits = new AirlineProfits({
      store: h.store,
      account: {
        ownedAircraft: async (b: number) => [{ serial: 151, registration: null, type: 'B738', ownerType: 'airline', ownerAirlineId: AIRLINE, businessId: b }],
        aircraft: async () => null,
        logbook: async () => logbook,
      },
      publicClient: { pilotAircraftOwner: async () => ({ airlineId: AIRLINE, businessId: BUSINESS }) },
      fshub: {
        airlineFlights: async (_a: number, cursor: number) => {
          asked.push(cursor + 1);
          return { flights: [{ id: cursor + 1, pilotId: 7001, pilotName: 'Sam', dep: 'KMIA', arr: 'KORD', departedAt: null, arrivedAt: T0, aircraftIcao: null, aircraftName: null, scheduleStatus: null, distanceNm: 1502 }], count: 1, lastId: cursor + 1, firstAt: null, lastAt: null };
        },
      },
      fetchFn: (async () => new Response(csvOf(g.values), { status: 200, headers: { 'content-type': 'text/csv' } })) as typeof fetch,
      now: () => h.clock.now,
    });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('checks without writing and shows the pay it would fill in', async () => {
    const { text, components } = await run();
    assert.match(text, /Pilot Pay beside those: \*\*2\*\* empty or \$0, with a pay I can work out, \*\*1\*\* already have a pay in them/);
    assert.match(text, /row 3 · TST101 EGLL → EGCC · Thu 12 Nov · \$54,489 · pilot pay \$8,174 \(15% of the profit\)/);
    assert.match(text, /row 4 · TST202 KMIA → KORD · Thu 12 Nov · -\$4,000 · pilot pay \$4,000 \(loss, 1,502 nm flown\)/);
    assert.deepEqual(components, []);
    assert.equal(g.writes.length, 0);
    assert.deepEqual(asked, [5001], 'FsHub was asked about the loss only');
  });

  it('writes the profits and the empty pay cells when the admin presses Write, and leaves the filled pay cell alone', async () => {
    const { text, components } = await run({ options: { action: 'fill' } });
    assert.match(text, /the pilot's pay into \*\*2\*\* Pilot Pay cells that are empty or \$0/);
    assert.match(text, /\*\*1\*\* already have a pay in Pilot Pay/);
    assert.deepEqual(components.length, 1);
    assert.match(JSON.stringify(components[0].toJSON?.() ?? components[0]), /Write 5 cells/, 'three profits and two pays');
    assert.equal(g.writes.length, 0, 'nothing yet');
    const done = await press(idsOf(components)[0]!);
    assert.match(done, /Wrote \*\*3\*\* Profit Made cells/);
    assert.match(done, /And \*\*2\*\* Pilot Pay cells: K3, K4/);
    assert.deepEqual([g.cell('J3'), g.cell('K3'), g.cell('J4'), g.cell('K4'), g.cell('J5'), g.cell('K5')], ['54489', '8174', '-4000', '4000', '20000', '$1,500']);
    assert.equal(g.writes.length, 1);
    assert.deepEqual([...h.store.payWrittenKeys(h.panel.id)].sort(), ['EGLL-EGCC@2026-11-12', 'KMIA-KORD@2026-11-12'], 'the two pay cells the bot wrote are remembered, and not the one a manager had filled');
  });

  it('writes over a $0 pay cell, remembers it, and then leaves it alone once somebody sets it back to $0 on purpose', async () => {
    g.values[2]![10] = '$0';
    g.values[3]![10] = '$0';
    const first = await run({ options: { action: 'fill' } });
    assert.match(first.text, /the pilot's pay into \*\*2\*\* Pilot Pay cells that are empty or \$0/);
    const done = await press(idsOf(first.components)[0]!);
    assert.match(done, /And \*\*2\*\* Pilot Pay cells: K3, K4/);
    assert.deepEqual([g.cell('K3'), g.cell('K4')], ['8174', '4000']);
    // The manager clears Alex's profit to have it looked at again, and puts the pay back to $0, because that pilot is not to be paid for it.
    g.values[2]![9] = '';
    g.values[2]![10] = '$0';
    g.writes.length = 0;
    const second = await run({ options: { action: 'fill' } });
    assert.match(second.text, /row 3 · .* · pilot pay: left at \$0 \(it was set back to \$0 after I wrote one\)/);
    assert.match(second.text, /\*\*1\*\* were set back to \$0 after I wrote a pay/);
    const again = await press(idsOf(second.components)[0]!);
    assert.match(again, /Wrote \*\*1\*\* Profit Made cell/);
    assert.doesNotMatch(again, /Pilot Pay cell/);
    assert.deepEqual([g.cell('J3'), g.cell('K3')], ['54489', '$0'], 'the profit is back, and the pay is still the $0 that was put there');
  });

  it('says so when a pay cell got something in it between the preview and the button', async () => {
    const { components } = await run({ options: { action: 'fill' } });
    g.values[2]![10] = '$1,000';
    const done = await press(idsOf(components)[0]!);
    assert.match(done, /Wrote \*\*3\*\* Profit Made cells/);
    assert.match(done, /And \*\*1\*\* Pilot Pay cell: K4/);
    assert.match(done, /Left alone: \*\*1\*\* Pilot Pay cell had something in it by then\./);
    assert.equal(g.cell('K3'), '$1,000');
  });
});
