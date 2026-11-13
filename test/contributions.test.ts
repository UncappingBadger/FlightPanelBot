import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CONTRIBUTIONS_REQUEST } from '../src/discord/contributions.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { parseSheetCsv } from '../src/jobs/sheet.js';
import { CONTRIBUTION_DAYS, contributionPeriod, contributionsOf, dayName, formatMoney, parseMoney, readSheetFlights } from '../src/services/contributions.js';
import { GUILD, HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeDm, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;

/* A made-up sheet shaped like a real airline's tab. "Now" in these tests is Wednesday 2026-11-11 12:00Z, so the last seven
   days are Thursday 5 November to Wednesday 11 November. */

const HEADER = 'Route,Date,Landing Window Zulu,Landing Window US Central,Pilot,Backup Pilot,Aircraft,Flight Completed (by Pilot),Pilot Paid,Profit Made,Pilot Pay,Airline Profit';
const row = (route: string, date: string, pilot: string, done: boolean, profit: string) =>
  `${route},${date},0600-2359z,x,${pilot},,A320,${done ? 'TRUE' : 'FALSE'},${done ? 'TRUE' : 'FALSE'},"${profit}",$0,`;
const ROWS = {
  weekDivider: 'Week 2,11/8/2026,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2',
  today: row('EGLL-EGKK', '11/11/2026', 'Sam', true, '$10,000.00'),
  yesterday: row('EGKK-EGCC', '11/10/2026', 'sam', true, '-$2,500.00'),
  waiting: row('EGCC-EGPH', '11/9/2026', 'Sam', true, ''),
  firstDay: row('EGPH-EGLL', '11/5/2026', 'Sam', true, '$1,000'),
  zero: row('LFPG-EDDF', '11/7/2026', 'Sam', true, '$0'),
  tooOld: row('EGLL-LFPG', '11/4/2026', 'Sam', true, '$99,999'),
  tomorrow: row('EGLL-EDDF', '11/12/2026', 'Sam', true, '$5,000'),
  someoneElse: row('KJFK-KBOS', '11/10/2026', 'Riley', true, '$7,777'),
  notFlown: row('EGLL-EHAM', '11/8/2026', 'Sam', false, ''),
  cancelled: row('EGLL-LEMD', '11/8/2026', 'CANCELLED', true, '$0'),
  sameDayAgain: row('EGLL-EGKK', '11/11/2026', 'Sam', true, 'TBD'),
};
const CSV = [HEADER, ...Object.values(ROWS)].join('\n');
const lineOf = (key: keyof typeof ROWS) => [HEADER, ...Object.values(ROWS)].indexOf(ROWS[key]) + 1;

const SHEET_ID = 'Q1w2E3r4T5y6U7i8O9p0AaSsDdFfGgHhJjKkLlZz';
const EXPORT_URL = (id: string, gid = '5') => `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
/** A pretend Google: serves each sheet's CSV, or fails. */
function pretendGoogle(sheets: Record<string, string | (() => Promise<string>)>) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const body = sheets[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(typeof body === 'function' ? await body() : body, { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('reading a money cell', () => {
  it('reads amounts as a spreadsheet shows them', () => {
    assert.equal(parseMoney('$54,489.00'), 54489);
    assert.equal(parseMoney('-$114,799.00'), -114799);
    assert.equal(parseMoney('$-114,799.00'), -114799);
    assert.equal(parseMoney('($1,200)'), -1200);
    assert.equal(parseMoney('−$50'), -50);
    assert.equal(parseMoney('1200'), 1200);
    assert.equal(parseMoney(' £3.50 '), 3.5);
    assert.equal(parseMoney('$0'), 0, 'zero is an amount: it was entered');
    assert.equal(parseMoney('$0.00'), 0);
  });

  it('reads nothing from a cell that is empty or is not an amount', () => {
    for (const text of ['', '   ', null, undefined, 'TBD', '#N/A', '#REF!', '-', '$', 'pending', '1e5', '12 USD', '1.2.3']) {
      assert.equal(parseMoney(text as string), null, String(text));
    }
  });

  it('shows amounts without cents unless there are some', () => {
    assert.equal(formatMoney(8500), '$8,500');
    assert.equal(formatMoney(-114799), '-$114,799');
    assert.equal(formatMoney(1875400), '$1,875,400');
    assert.equal(formatMoney(3.5), '$3.50');
    assert.equal(formatMoney(0), '$0');
    assert.equal(formatMoney(-0.004), '$0');
    assert.equal(formatMoney(1234.567), '$1,234.57');
  });
});

describe('reading the flights of a schedule tab', () => {
  it('reads every flight row, old ones too, with who flew it, whether it was completed, and the profit', () => {
    const sheet = readSheetFlights(CSV)!;
    assert.equal(sheet.hasProfit, true);
    assert.equal(sheet.flights.length, 11, 'the divider row is not a flight');
    const today = sheet.flights.find((f) => f.row === lineOf('today'))!;
    assert.deepEqual([today.route, today.pilot, today.completed, today.profit, today.day], ['EGLL → EGKK', 'Sam', true, 10000, Date.UTC(2026, 10, 11)]);
    assert.equal(sheet.flights.find((f) => f.row === lineOf('waiting'))!.profit, null, 'nothing entered');
    assert.equal(sheet.flights.find((f) => f.row === lineOf('sameDayAgain'))!.profit, null, 'TBD is not an amount');
    assert.equal(sheet.flights.find((f) => f.row === lineOf('zero'))!.profit, 0);
    assert.equal(sheet.flights.find((f) => f.row === lineOf('notFlown'))!.completed, false);
    assert.equal(sheet.flights.find((f) => f.row === lineOf('cancelled'))!.completed, false, 'cancelled with the box ticked: nobody flew it');
  });

  it('gives each flight the same key the panel gives it, so the panel can say its ID', () => {
    const now = T0;
    const fromPanelReader = parseSheetCsv(CSV, now).jobs.map((j) => j.key).sort();
    const here = readSheetFlights(CSV)!
      .flights.map((f) => f.sourceKey)
      // the panel reader skips flights long over; compare the ones it keeps
      .filter((k) => fromPanelReader.includes(k))
      .sort();
    assert.deepEqual(here, fromPanelReader);
    assert.ok(here.some((k) => k.endsWith('#2')), 'including a second flight on the same route and day');
  });

  it('says whether the sheet has a profit column, and refuses a sheet that is not a schedule', () => {
    const noProfit = CSV.split('\n').map((l) => l.split(',').slice(0, 8).join(',')).join('\n');
    assert.equal(readSheetFlights(noProfit)!.hasProfit, false);
    assert.equal(readSheetFlights('Name,Score\nSam,3')!, null);
    assert.equal(readSheetFlights('Route,Date,Landing Window Zulu,Aircraft\nEGLL-EGKK,11/11/2026,0600-2359z,A320'), null, 'no Pilot or Completed column');
    assert.equal(readSheetFlights('')!, null);
  });

  it('only takes a column that is the flight profit: a pilot pay or an airline total is not it', () => {
    const csv = 'Route,Date,Landing Window Zulu,Pilot,Flight Completed,Pilot Pay,XYZ Profit\nEGLL-EGKK,11/11/2026,0600-2359z,Sam,TRUE,$100,$900';
    assert.equal(readSheetFlights(csv)!.hasProfit, false);
    const named = 'Route,Date,Landing Window Zulu,Pilot,Flight Completed,Profit\nEGLL-EGKK,11/11/2026,0600-2359z,Sam,TRUE,$900';
    assert.equal(readSheetFlights(named)!.flights[0]!.profit, 900);
  });

  it('reads the airline\'s flight number when the sheet has the column', () => {
    const csv = 'Route,Date,Landing Window Zulu,Flight Number,Pilot,Flight Completed,Profit Made\nEGLL-EGKK,11/11/2026,0600-2359z,sky 123,Sam,TRUE,$900';
    assert.equal(readSheetFlights(csv)!.flights[0]!.flightNumber, 'SKY123');
  });
});

describe('adding up what a pilot completed', () => {
  const sheet = () => readSheetFlights(CSV)!;
  const rows = (c: ReturnType<typeof contributionsOf>) => c.completed.map((f) => f.row);

  it('covers today and the six days before it, Zulu', () => {
    const p = contributionPeriod(T0);
    assert.equal(CONTRIBUTION_DAYS, 7);
    assert.equal(p.start, Date.UTC(2026, 10, 5));
    assert.equal(p.lastDay, Date.UTC(2026, 10, 11));
    assert.equal(p.end, Date.UTC(2026, 10, 12));
    assert.equal(dayName(p.start), 'Thu 5 Nov');
    assert.equal(dayName(p.lastDay), 'Wed 11 Nov');
    // the very start and end of the days
    assert.deepEqual(contributionPeriod(Date.UTC(2026, 10, 11, 0, 0)).start, Date.UTC(2026, 10, 5));
    assert.deepEqual(contributionPeriod(Date.UTC(2026, 10, 11, 23, 59)).start, Date.UTC(2026, 10, 5));
    assert.deepEqual(contributionPeriod(Date.UTC(2026, 10, 12, 0, 0)).start, Date.UTC(2026, 10, 6));
  });

  it("totals the profit of the pilot's completed flights in the period, and names the ones with none entered", () => {
    const c = contributionsOf(sheet(), ['Sam'], T0);
    assert.deepEqual(rows(c), [lineOf('firstDay'), lineOf('zero'), lineOf('waiting'), lineOf('yesterday'), lineOf('today'), lineOf('sameDayAgain')], 'oldest first');
    assert.equal(c.total, 8500, '10,000 - 2,500 + 1,000 + 0');
    assert.deepEqual(c.calculated.map((f) => f.row), [lineOf('firstDay'), lineOf('zero'), lineOf('yesterday'), lineOf('today')]);
    assert.deepEqual(c.waiting.map((f) => f.row), [lineOf('waiting'), lineOf('sameDayAgain')]);
  });

  it('leaves out other pilots, flights not completed, cancelled ones, and days outside the period', () => {
    const c = contributionsOf(sheet(), ['Sam'], T0);
    for (const key of ['someoneElse', 'notFlown', 'cancelled', 'tooOld', 'tomorrow'] as const) assert.ok(!rows(c).includes(lineOf(key)), key);
    assert.deepEqual(rows(contributionsOf(sheet(), ['Riley'], T0)), [lineOf('someoneElse')]);
  });

  it('moves with the clock: the day a flight falls out of the seven', () => {
    assert.ok(rows(contributionsOf(sheet(), ['Sam'], T0 + DAY - 13 * HOUR)).includes(lineOf('firstDay')), 'still the 11th: the 5th counts');
    assert.ok(!rows(contributionsOf(sheet(), ['Sam'], T0 + 12 * HOUR)).includes(lineOf('firstDay')), 'the 12th: the 5th is out, the 12th row is in');
    assert.ok(rows(contributionsOf(sheet(), ['Sam'], T0 + 12 * HOUR)).includes(lineOf('tomorrow')));
  });

  it('matches names without minding case or spaces, and any of several names', () => {
    assert.equal(contributionsOf(sheet(), ['SAM '], T0).completed.length, 6);
    assert.equal(contributionsOf(sheet(), ['Nobody', 'riley'], T0).completed.length, 1);
    assert.equal(contributionsOf(sheet(), ['Sam', 'Riley'], T0).completed.length, 7);
    assert.equal(contributionsOf(sheet(), [], T0).completed.length, 0);
    assert.equal(contributionsOf(sheet(), ['Sa'], T0).completed.length, 0, 'a name is the whole cell, not part of it');
  });

  it('counts a loss as a loss, and says so when nothing has a profit yet', () => {
    const csv = [HEADER, row('EGLL-EGKK', '11/10/2026', 'Sam', true, '-$114,799.00'), row('EGKK-EGCC', '11/11/2026', 'Sam', true, '')].join('\n');
    const c = contributionsOf(readSheetFlights(csv)!, ['Sam'], T0);
    assert.equal(c.total, -114799);
    assert.equal(c.waiting.length, 1);
    const none = contributionsOf(readSheetFlights([HEADER, row('EGLL-EGKK', '11/10/2026', 'Sam', true, '')].join('\n'))!, ['Sam'], T0);
    assert.deepEqual([none.total, none.calculated.length, none.waiting.length], [0, 0, 1]);
  });
});

describe('asking for contributions in a DM', () => {
  const asks = ['my contributions', 'My Contributions', 'contributions', 'my contribution', 'show my contributions', 'get me my contributions', 'check contributions', 'my contributions?', ' my contributions '];
  const notAsks = ['contributions 14', 'my contributions please', 'who contributions', 'TST-001', 'flights', 'my', 'contribute', 'my contributions and flights'];
  it('understands the usual ways of asking, and nothing else', () => {
    for (const t of asks) assert.ok(CONTRIBUTIONS_REQUEST.test(t.trim()), t);
    for (const t of notAsks) assert.ok(!CONTRIBUTIONS_REQUEST.test(t), t);
  });
});

describe('my contributions, in a DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let google: ReturnType<typeof pretendGoogle>;
  let sheetBody: string | (() => Promise<string>);
  const pid = () => h.panel.id;
  const say = (user: FakeUser, text: string, o: { guilds?: string[] } = {}) => handleDmMessage(d.ctx, fakeDm(user, text, o));
  /** What the answer calls a flight: its ID on the panel, or, for one the panel never had, its row in the sheet. */
  const codeOf = (key: keyof typeof ROWS) => {
    const f = readSheetFlights(CSV)!.flights.find((x) => x.row === lineOf(key))!;
    return h.store.getJobBySourceKey(pid(), f.sourceKey)?.code ?? `row ${f.row}`;
  };

  beforeEach(async () => {
    h = await makeHarness();
    sheetBody = CSV;
    // serve whatever the test has set as the sheet's body at the time it is asked
    google = pretendGoogle({ [EXPORT_URL(SHEET_ID)]: async () => (typeof sheetBody === 'function' ? sheetBody() : sheetBody) });
    d = makeDiscordHarness(h, { fetchFn: google.fetchFn });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
    h.store.updatePanel(pid(), { sheetId: SHEET_ID, sheetGid: '5' });
    h.jobs.sync(pid(), parseSheetCsv(CSV, T0).jobs);
    h.store.setPilotName(USER_A.discordId, 'Sam', T0);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('adds up the airline profit from the flights you completed this week, and names the ones with no profit yet by ID', async () => {
    await say(alice, 'my contributions');
    assert.equal(alice.dms.length, 1);
    const text = alice.lastText;
    assert.match(text, /^\*\*Your contributions to Test Air\*\*\nThu 5 Nov to Wed 11 Nov: the last 7 days, Zulu time\.\n\n/);
    assert.match(text, /Airline profit I can see so far: \*\*\$8,500\*\*, from 4 of the 6 flights you completed\./);
    assert.match(text, new RegExp(`⏳ \\*\\*Not calculated yet:\\*\\* \\*\\*${codeOf('waiting')}\\*\\*, \\*\\*${codeOf('sameDayAgain')}\\*\\*\\.`));
    assert.match(text, /A manager hasn't entered the profit for these flights yet\. The total above leaves them out, and will change once they are filled in\.$/);
    assert.deepEqual(alice.last.allowedMentions, { parse: [] });
    assert.equal(alice.dms.length, 1, 'one message for one airline');
  });

  it('lists each flight with its route, day and profit (a loss as a loss), the unfinished ones marked', async () => {
    await say(alice, 'my contributions');
    const lines = alice.lastText.split('\n').filter((l) => l.startsWith('•'));
    assert.equal(lines.length, 6);
    assert.equal(lines[2], `• **${codeOf('waiting')}** · EGCC → EGPH · Mon 9 Nov · ⏳ no profit entered yet`);
    assert.equal(lines[3], `• **${codeOf('yesterday')}** · EGKK → EGCC · Tue 10 Nov · -$2,500`);
    assert.equal(lines[4], `• **${codeOf('today')}** · EGLL → EGKK · Wed 11 Nov · $10,000`);
    assert.match(lines[1]!, /LFPG → EDDF · Sat 7 Nov · \$0$/);
  });

  it('uses the flight number, then the sheet row, for a flight the panel no longer has', async () => {
    // the flights older than three days are gone from the panel, so they have no ID there
    const first = lineOf('firstDay');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, new RegExp(`• \\*\\*row ${first}\\*\\* · EGPH → EGLL · Thu 5 Nov · \\$1,000`));

    const withNumbers = `${HEADER},Flight Number\n${row('EGPH-EGLL', '11/5/2026', 'Sam', true, '$1,000')},SKY 77`;
    sheetBody = withNumbers;
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /• \*\*SKY77\*\* · EGPH → EGLL · Thu 5 Nov · \$1,000/);
  });

  it('says it is the whole total, with no waiting note, when every flight has a profit', async () => {
    sheetBody = [HEADER, row('EGLL-EGKK', '11/10/2026', 'Sam', true, '$2,000'), row('EGKK-EGCC', '11/11/2026', 'Sam', true, '$500.50')].join('\n');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /Airline profit from the 2 flights you completed: \*\*\$2,500\.50\*\*/);
    assert.doesNotMatch(alice.lastText, /Not calculated|⏳/);
  });

  it('says so when none of the flights has a profit yet', async () => {
    sheetBody = [HEADER, row('EGLL-EGKK', '11/10/2026', 'Sam', true, ''), row('EGKK-EGCC', '11/11/2026', 'Sam', true, '')].join('\n');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /You completed 2 flights, but no profit has been entered for any of them yet, so I can't see a total\./);
    assert.match(alice.lastText, /⏳ \*\*Not calculated yet:\*\* \*\*row 2\*\*, \*\*row 3\*\*\./);
    assert.doesNotMatch(alice.lastText, /will change once/);
  });

  it('says it for a single flight in the singular', async () => {
    sheetBody = [HEADER, row('EGLL-EGKK', '11/11/2026', 'Sam', true, ''), row('EGKK-EGCC', '11/10/2026', 'Sam', true, '$900')].join('\n');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /\*\*\$900\*\*, from 1 of the 2 flights/);
    assert.match(alice.lastText, /A manager hasn't entered the profit for this flight yet\. The total above leaves it out, and will change once it is filled in\./);
  });

  it('works under any name the pilot has used in the sheet, even one they have since changed', async () => {
    h.store.setPilotName(USER_A.discordId, 'Samuel', T0);
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^I found no flights completed in the last 7 days under the name \*\*Samuel\*\*\./, 'the sheet says Sam, and nothing links Samuel to it');

    // the bot once wrote "Sam" against a flight for them
    h.jobs.sync(pid(), [sj('mine', 'EGLL-EGKK')]);
    const job = h.jobs.open(pid()).find((v) => v.job.sourceKey === 'mine')!;
    h.jobs.reserve(job.job.id, [1], USER_A);
    h.store.setReservationSheetName(job.job.id, 1, 'Sam');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /Airline profit I can see so far: \*\*\$8,500\*\*/);
  });

  it('starts from what Discord calls them when they have never given a name', async () => {
    const carol = d.client.user(new FakeUser('555555555555555555', 'sam'));
    await say(carol, 'my contributions');
    assert.match(carol.lastText, /\$8,500/, 'their Discord name is the sheet name');
  });

  it("says plainly, and how to fix it, when nothing is found under the pilot's name", async () => {
    await say(bob, 'my contributions');
    assert.equal(bob.dms.length, 1);
    assert.equal(bob.lastText, "I found no flights completed in the last 7 days under the name **bob**. If the sheet has you under another name, send me `name <your name as the sheet has it>` and ask again.");
  });

  it('does not count a flight that is not completed, and says nothing was found when that is all there is', async () => {
    sheetBody = [HEADER, row('EGLL-EGKK', '11/10/2026', 'Sam', false, '')].join('\n');
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^I found no flights completed in the last 7 days under the name \*\*Sam\*\*/);
  });

  it('is for people in the airline\'s server only', async () => {
    await say(alice, 'my contributions', { guilds: ['800000000000000009'] });
    assert.match(alice.lastText, /I don't know of one linked to a server you're in\./);
    assert.equal(google.calls.length, 0, 'the sheet is not even read');
  });

  it('says so when no airline has a sheet linked', async () => {
    h.store.updatePanel(pid(), { sheetId: null, sheetGid: null });
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^I work this out from an airline's Google Sheet, and I don't know of one linked to a server you're in\./);
  });

  it("says so when the sheet can't be read, and the next try reads it again", async () => {
    sheetBody = () => Promise.reject(new Error('offline'));
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^\*\*Test Air\*\*: I couldn't reach Google Sheets just now\. Try again in a minute\./);
    sheetBody = CSV;
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /\$8,500/);
  });

  it('passes on what Google said when the sheet is not shared', async () => {
    google = pretendGoogle({});
    d = makeDiscordHarness(h, { fetchFn: google.fetchFn });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^\*\*Test Air\*\*: Google couldn't find that sheet or tab\. Check the link\. Try again in a minute\./);
  });

  it('says so when the sheet has no profit column, or is not a schedule', async () => {
    sheetBody = 'Route,Date,Landing Window Zulu,Pilot,Flight Completed\nEGLL-EGKK,11/10/2026,0600-2359z,Sam,TRUE';
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^\*\*Test Air\*\*: that sheet has no profit column \(I look for one called \*Profit Made\*\), so I can't work out what flights made\./);
    sheetBody = 'Name,Score\nSam,3';
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /^\*\*Test Air\*\*: I couldn't find the flights in that sheet/);
  });

  it('answers once for each airline, in order, and says nothing for one where the pilot has no flights', async () => {
    const second = h.store.createPanel({ guildId: GUILD, name: 'Alpha Wings', prefix: 'ALP', channelId: '800000000000000008', now: T0 });
    h.store.updatePanel(second.id, { sheetId: 'ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlKkJjIiHhGg', sheetGid: '7' });
    const other = pretendGoogle({
      [EXPORT_URL(SHEET_ID)]: async () => CSV,
      [EXPORT_URL('ZzYyXxWwVvUuTtSsRrQqPpOoNnMmLlKkJjIiHhGg', '7')]: async () => [HEADER, row('KJFK-KBOS', '11/11/2026', 'Sam', true, '$4,000')].join('\n'),
    });
    d = makeDiscordHarness(h, { fetchFn: other.fetchFn });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    await say(alice, 'my contributions');
    assert.equal(alice.dms.length, 2);
    assert.match(alice.dms[0].content, /^\*\*Your contributions to Alpha Wings\*\*/);
    assert.match(alice.dms[0].content, /\*\*\$4,000\*\*/);
    assert.match(alice.dms[1].content, /^\*\*Your contributions to Test Air\*\*/);

    // a pilot with flights in neither is told once
    const nobody = d.client.user(new FakeUser('666666666666666666', 'nobody'));
    await say(nobody, 'my contributions');
    assert.equal(nobody.dms.length, 1);
    assert.match(nobody.lastText, /^I found no flights completed/);
  });

  it('only reads the airlines of servers the pilot is in', async () => {
    const second = h.store.createPanel({ guildId: '800000000000000009', name: 'Other Air', prefix: 'OTH', channelId: '800000000000000007', now: T0 });
    h.store.updatePanel(second.id, { sheetId: 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt', sheetGid: '9' });
    await say(alice, 'my contributions');
    assert.equal(google.calls.length, 1, 'only this server\'s sheet');
    assert.match(alice.lastText, /Test Air/);
    assert.equal(alice.dms.length, 1);
  });

  it('is not run twice at once by one pilot, and is ready for the next ask afterwards', async () => {
    let release!: (csv: string) => void;
    sheetBody = () => new Promise<string>((resolve) => (release = resolve));
    const first = say(alice, 'my contributions');
    await settle(5);
    await say(alice, 'my contributions');
    assert.equal(alice.lastText, "I'm still working out your last request. Give me a moment.");
    assert.equal(google.calls.length, 1, 'the sheet was read once');
    release(CSV);
    await first;
    assert.match(alice.lastText, /\$8,500/);
    sheetBody = CSV;
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /\$8,500/);
  });

  it('works whether or not a conversation is open, and leaves it open', async () => {
    h.store.upsertSession({ discordId: USER_A.discordId, panelId: pid(), step: 'await_code', expiresAt: T0 + 600000 });
    await say(alice, 'my contributions');
    assert.match(alice.lastText, /\$8,500/);
    assert.equal(h.store.getSession(USER_A.discordId, T0)?.step, 'await_code');
  });

  it('is mentioned in the pointer people get when they message the bot out of the blue', async () => {
    await say(bob, 'hello there');
    assert.match(bob.lastText, /Send me `flights` any time to see the flights you have, or `my contributions` to see what your completed flights made for the airline\./);
  });

  it('keeps a long list inside what one message can carry, and still names every flight with no profit', async () => {
    const many = [HEADER];
    for (let i = 0; i < 40; i++) many.push(row('EGLL-EGKK', `11/${5 + (i % 7)}/2026`, 'Sam', true, i % 2 === 0 ? '$1,000' : ''));
    sheetBody = many.join('\n');
    await say(alice, 'my contributions');
    assert.ok(alice.lastText.length <= 1990, `${alice.lastText.length} characters`);
    assert.match(alice.lastText, /…and 28 more\./);
    assert.match(alice.lastText, /\*\*\$20,000\*\*, from 20 of the 40 flights/);
    const ids = alice.lastText.split('Not calculated yet:** ')[1]!.split('.\n')[0]!.split(', ');
    assert.equal(ids.length, 20, 'every flight with no profit is named, though only twelve are listed');
  });

  it('names the first twenty-five with no profit and counts the rest', async () => {
    const many = [HEADER];
    for (let i = 0; i < 30; i++) many.push(row('EGLL-EGKK', `11/${5 + (i % 7)}/2026`, 'Sam', true, ''));
    sheetBody = many.join('\n');
    await say(alice, 'my contributions');
    assert.ok(alice.lastText.length <= 1990);
    assert.match(alice.lastText, /Not calculated yet:\*\* (\*\*[^*]+\*\*, ){24}\*\*[^*]+\*\* and 5 more\./);
  });

  it('shows a name safely: nothing in it can ping or break the message', async () => {
    h.store.setPilotName(USER_B.discordId, '@everyone *x* `y`', T0);
    await say(bob, 'my contributions');
    assert.deepEqual(bob.last.allowedMentions, { parse: [] });
    assert.match(bob.lastText, /under the name \*\*@\u200beveryone \\\*x\\\* \\`y\\`\*\*\./);
  });
});
