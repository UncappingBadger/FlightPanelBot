import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { UserError } from '../src/discord/errors.js';
import { holderText, jobBlock } from '../src/discord/ui.js';
import { ImportError } from '../src/jobs/import.js';
import {
  downloadSheetCsv,
  parseSheetCsv,
  parseSheetDate,
  parseSheetUrl,
  parseZuluWindow,
  SheetJobSource,
  sheetExportUrl,
  sourceSelector,
} from '../src/jobs/sheet.js';
import type { SourceJob } from '../src/jobs/types.js';
import { AIRLINE, CHANNEL, GUILD, HOUR, makeHarness, sj, T0, USER_A, USER_B, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, fakeInteraction, FakeUser, makeDiscordHarness, settle, type DiscordHarness, type FakeInteractionOptions, messageText } from './discord-helpers.js';

/* A made-up sheet in the same shape as a real airline's sign-up tab. "Now" in these tests is 2026-11-11 12:00Z. */

const HEADER = 'Route,Date,Landing Window Zulu,Landing Window US Central,Pilot,Backup Pilot,Aircraft,Flight Completed (by Pilot),Pilot Paid,Profit Made,Pilot Pay,Airline Profit,Column 1';
const ROWS = {
  divider: 'Week 2,11/8/2026,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2,Week 2',
  longPast: 'EGLL-EDDF,11/1/2026,0600-2359z,Sun 0000 - Sun 1759 CT,Quinn,,A320,TRUE,TRUE,"$1,000.00",$0,,',
  doneYesterday: 'EGLL-EGPH,11/10/2026,0600-2359z,Tue 0000 - Tue 1759 CT,Casey,,A320,TRUE,TRUE,"$2,000.00",$0,,',
  open: 'EGLL-EGCC,11/12/2026,0600-2359z,Thu 0000 - Thu 1759 CT,,,A320,FALSE,FALSE,,,,',
  signedUp: 'EGCC-EGLL,11/12/2026, 1200 -  2359z,Thu 0600 - Thu 1759 CT,Taylor,Jordan,A320,FALSE,FALSE,,,,',
  overnight: 'KMIA-KORD,11/12/2026,1200-0600z,Thu 0600 - Fri 0000 CT,,,B738,FALSE,FALSE,,,,',
  weekday: 'KORD-KMIA,11/13/2026,Fri. 0600-2359z,Fri 0000 - Fri 1759 CT,,,B738,FALSE,FALSE,,,,',
  cancelled: 'EGLL-LFPG,11/12/2026,0600-2359z,Thu 0000 - Thu 1759 CT,CANCELLED,CANCELLED,B738,FALSE,FALSE,$0.00,$0,,',
  badDate: 'KORD-KPVD,Week 3,1200-0600,Thu 0600 - Fri 0000 CT,,,B738,FALSE,FALSE,,,,',
  badWindow: 'KLAS-KMIA,11/13/2026,sometime,#ERROR!,,,B38M,FALSE,FALSE,,,,',
  badRoute: 'ABC,11/13/2026,0600-2359z,Fri 0000 - Fri 1759 CT,,,A320,FALSE,FALSE,,,,',
  filler: ',,,,,,,,,,$0,,',
};
const SHEET_CSV = [HEADER, ...Object.values(ROWS)].join('\n');
const rowNo = (key: keyof typeof ROWS) => [HEADER, ...Object.values(ROWS)].indexOf(ROWS[key]) + 1;

const at = (day: number, hhmm: string) => Date.UTC(2026, 10, day, Number(hhmm.slice(0, 2)), Number(hhmm.slice(2)));
const byRoute = (jobs: SourceJob[], route: string) => jobs.find((j) => j.key.startsWith(`${route}@`));

/* A pretend Google: the export link redirects to a googleusercontent host, which serves the CSV. */

const SHEET_ID = 'Q1w2E3r4T5y6U7i8O9p0AaSsDdFfGgHhJjKkLlZz';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=316683387#gid=316683387`;
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=316683387`;
const SERVED_URL = 'https://doc-0g-34-sheets.googleusercontent.com/export/abc/def/123/*/file?format=csv';

type Hop = { status?: number; location?: string; type?: string; body?: string };
function pretendGoogle(routes: Record<string, Hop | (() => Hop)>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const entry = routes[url];
    const hop = typeof entry === 'function' ? entry() : entry;
    if (!hop) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = {};
    if (hop.location) headers.location = hop.location;
    if (hop.type) headers['content-type'] = hop.type;
    return new Response(hop.status && hop.status >= 300 && hop.status < 400 ? null : (hop.body ?? ''), { status: hop.status ?? 200, headers });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}
const workingGoogle = (csv: string) => pretendGoogle({ [EXPORT_URL]: { status: 307, location: SERVED_URL }, [SERVED_URL]: { type: 'text/csv; charset=utf-8', body: csv } });

/* ------------------------------------------------------------------ reading the link */

describe('Google Sheets links', () => {
  it('reads the sheet and tab from a normal share link', () => {
    assert.deepEqual(parseSheetUrl(SHEET_URL), { id: SHEET_ID, gid: '316683387' });
    assert.deepEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=42`), { id: SHEET_ID, gid: '42' });
    assert.deepEqual(parseSheetUrl(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing&gid=7`), { id: SHEET_ID, gid: '7' });
    assert.deepEqual(parseSheetUrl(`  https://docs.google.com/spreadsheets/d/${SHEET_ID}  `), { id: SHEET_ID, gid: null }, 'no tab means the first one');
  });

  it('refuses anything that is not a docs.google.com spreadsheet over https', () => {
    for (const bad of [
      `http://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`,
      `https://evil.example/spreadsheets/d/${SHEET_ID}/edit`,
      `https://docs.google.com.evil.example/spreadsheets/d/${SHEET_ID}/edit`,
      `https://user@evil.example/spreadsheets/d/${SHEET_ID}`,
      `https://docs.google.com/document/d/${SHEET_ID}/edit`,
      'https://docs.google.com/spreadsheets/d/short/edit',
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vSomethingPublished/pubhtml',
      'not a link',
      '',
    ]) {
      assert.equal(parseSheetUrl(bad), null, bad);
    }
  });

  it('builds the export address from the id and tab only', () => {
    assert.equal(sheetExportUrl({ id: SHEET_ID, gid: '316683387' }), EXPORT_URL);
    assert.equal(sheetExportUrl({ id: SHEET_ID, gid: null }), `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`);
  });
});

/* ------------------------------------------------------------------ reading cells */

describe('reading the sheet\'s cells', () => {
  it('reads landing windows however people type them', () => {
    const w = (s: string) => parseZuluWindow(s);
    assert.deepEqual(w('0600-2359z'), { startMin: 360, endMin: 1439 });
    assert.deepEqual(w(' 1200 - 0600z'), { startMin: 720, endMin: 360 });
    assert.deepEqual(w(' 1200 -  2359z'), { startMin: 720, endMin: 1439 });
    assert.deepEqual(w('Fri. 0600-2359z'), { startMin: 360, endMin: 1439 });
    assert.deepEqual(w('Sun. 1200z-0600'), { startMin: 720, endMin: 360 });
    assert.deepEqual(w('0600-2359'), { startMin: 360, endMin: 1439 }, 'the z is optional');
    assert.deepEqual(w('600-1759z'), { startMin: 360, endMin: 1079 }, 'a missing leading zero');
    assert.deepEqual(w('0000-2400z'), { startMin: 0, endMin: 1440 });
    for (const bad of ['', 'Week 2', 'sometime', '0600', '2560-2359z', '0600-2461z', '2500-2600z']) assert.equal(w(bad), null, bad);
  });

  it('reads dates month-first, with a day-first fallback and ISO', () => {
    assert.deepEqual(parseSheetDate('11/1/2026'), { y: 2026, m: 11, d: 1 });
    assert.deepEqual(parseSheetDate('11/12/2026'), { y: 2026, m: 11, d: 12 });
    assert.deepEqual(parseSheetDate('13/11/2026'), { y: 2026, m: 11, d: 13 }, 'cannot be a month, so day first');
    assert.deepEqual(parseSheetDate('2026-11-05'), { y: 2026, m: 11, d: 5 });
    assert.deepEqual(parseSheetDate('11/5/26'), { y: 2026, m: 11, d: 5 });
    for (const bad of ['', 'Week 3', '2/30/2026', '13/13/2026', '11/1', 'Nov 1']) assert.equal(parseSheetDate(bad), null, bad);
  });
});

/* ------------------------------------------------------------------ the schedule tab */

describe('reading a schedule tab', () => {
  const { jobs, warnings } = parseSheetCsv(SHEET_CSV, T0);

  it('turns each row into a one-leg flight with its landing window as UTC times', () => {
    const open = byRoute(jobs, 'EGLL-EGCC')!;
    assert.deepEqual(open.legs, [{ dep: 'EGLL', arr: 'EGCC', heldBy: null }]);
    assert.equal(open.aircraft, 'A320');
    assert.equal(open.availableFrom, at(12, '0600'));
    assert.equal(open.deadline, at(12, '2359'));
    assert.equal(open.closed, false);
    assert.equal(open.key, 'EGLL-EGCC@2026-11-12');
    assert.equal(open.pay, null);
  });

  it('runs an overnight window into the next day, and ignores the weekday words', () => {
    const night = byRoute(jobs, 'KMIA-KORD')!;
    assert.equal(night.availableFrom, at(12, '1200'));
    assert.equal(night.deadline, at(13, '0600'));
    const fri = byRoute(jobs, 'KORD-KMIA')!;
    assert.equal(fri.availableFrom, at(13, '0600'));
    assert.equal(fri.deadline, at(13, '2359'));
  });

  it('carries the pilot already signed up in the sheet, and the backup as a note', () => {
    const signed = byRoute(jobs, 'EGCC-EGLL')!;
    assert.equal(signed.legs[0]!.heldBy, 'Taylor');
    assert.equal(signed.notes, 'Backup: Jordan');
    assert.equal(byRoute(jobs, 'EGLL-EGCC')!.notes, null);
  });

  it('marks cancelled and completed flights closed instead of dropping them', () => {
    const cancelled = byRoute(jobs, 'EGLL-LFPG')!;
    assert.equal(cancelled.closed, true);
    assert.equal(cancelled.legs[0]!.heldBy, null, '"CANCELLED" is not a pilot');
    assert.equal(cancelled.notes, null);
    const done = byRoute(jobs, 'EGLL-EGPH')!;
    assert.equal(done.closed, true);
    assert.equal(done.legs[0]!.heldBy, 'Casey');
  });

  it('skips divider and filler rows silently, and flights that ended long ago', () => {
    assert.equal(byRoute(jobs, 'EGLL-EDDF'), undefined, 'a window from 10 days ago');
    assert.equal(jobs.some((j) => j.key.startsWith('Week')), false);
    assert.deepEqual(jobs.map((j) => j.key.split('@')[0]).sort(), ['EGCC-EGLL', 'EGLL-EGCC', 'EGLL-EGPH', 'EGLL-LFPG', 'KLAS-KMIA', 'KMIA-KORD', 'KORD-KMIA']);
  });

  it('reports rows it cannot read, with their row numbers, and keeps going', () => {
    assert.equal(warnings.length, 3, warnings.join(' | '));
    assert.match(warnings.find((w) => w.includes('KORD-KPVD'))!, new RegExp(`^row ${rowNo('badDate')} \\(KORD-KPVD\\): the date "Week 3" isn't a date`));
    assert.match(warnings.find((w) => w.includes('sometime'))!, new RegExp(`^row ${rowNo('badWindow')} \\(KLAS-KMIA\\).*landing window "sometime".*whole day`));
    assert.match(warnings.find((w) => w.startsWith(`row ${rowNo('badRoute')}`))!, /route "ABC" needs at least two airports/);
    assert.equal(byRoute(jobs, 'KORD-KPVD'), undefined, 'no date, so no flight');
  });

  it('still lists a flight whose window is unreadable, using the whole day', () => {
    const j = byRoute(jobs, 'KLAS-KMIA')!;
    assert.equal(j.availableFrom, Date.UTC(2026, 10, 13));
    assert.equal(j.deadline, Date.UTC(2026, 10, 13, 23, 59));
  });

  it('finds the columns by name, wherever they are, and ignores the rest', () => {
    const csv = ['Notes,Aircraft,Pilot,Date,Route,Landing Window UTC', 'junk,B738,Sam,11/12/2026,EGLL-EGKK,0800-1000z'].join('\n');
    const r = parseSheetCsv(csv, T0);
    assert.equal(r.jobs.length, 1);
    assert.deepEqual([r.jobs[0]!.aircraft, r.jobs[0]!.legs[0]!.heldBy, r.jobs[0]!.availableFrom], ['B738', 'Sam', at(12, '0800')]);
  });

  it('finds the header even when a title sits above it, and keeps row numbers true', () => {
    const csv = ['Our schedule,,,', '', HEADER, 'ABC,11/13/2026,0600-2359z,,,,A320,FALSE,FALSE,,,,'].join('\n');
    const r = parseSheetCsv(csv, T0);
    assert.match(r.warnings[0]!, /^row 4:/, 'the blank line above still counts as a row');
  });

  it('gives a repeated route on the same day its own key, in order', () => {
    const row = 'EGLL-EGCC,11/12/2026,0600-2359z,,,,A320,FALSE,FALSE,,,,';
    const r = parseSheetCsv([HEADER, row, row].join('\n'), T0);
    assert.deepEqual(r.jobs.map((j) => j.key), ['EGLL-EGCC@2026-11-12', 'EGLL-EGCC@2026-11-12#2']);
  });

  it('cuts long lists of warnings short', () => {
    const rows = Array.from({ length: 20 }, () => 'ZZ,11/13/2026,0600-2359z,,,,A320,FALSE,FALSE,,,,');
    const r = parseSheetCsv([HEADER, ...rows].join('\n'), T0);
    assert.equal(r.warnings.length, 9);
    assert.match(r.warnings.at(-1)!, /…and 12 more/);
  });

  it('strips control characters from names and keeps them short', () => {
    const csv = [HEADER, `EGLL-EGCC,11/12/2026,0600-2359z,,${'Pilot\u0007Name '.repeat(20)},,A320,FALSE,FALSE,,,,`].join('\n');
    const held = parseSheetCsv(csv, T0).jobs[0]!.legs[0]!.heldBy!;
    assert.ok(held.length <= 40);
    assert.doesNotMatch(held, /[\u0000-\u001f]/);
  });

  it('falls back to the template layout for a sheet that is not a schedule', () => {
    const csv = ['id,legs,aircraft,from,deadline', 'A1,EGLL-EGKK,A20N,,2026-11-14 18:00'].join('\n');
    const r = parseSheetCsv(csv, T0);
    assert.deepEqual([r.jobs.length, r.jobs[0]!.key, r.warnings], [1, 'A1', []]);
  });

  it('rejects a tab that is neither, saying why', () => {
    assert.throws(() => parseSheetCsv('Name,Score\nAnna,5', T0), (e: unknown) => e instanceof ImportError && /legs/.test(e.message));
    assert.throws(() => parseSheetCsv('', T0), /empty|no jobs/i);
    assert.throws(
      () => parseSheetCsv('id,legs\nA1,EGLL', T0),
      (e: unknown) => e instanceof ImportError && /at least two airports/.test(e.message),
      'the first problems are in the message, so they reach the refresh error',
    );
  });
});

/* ------------------------------------------------------------------ downloading */

describe('downloading a sheet', () => {
  it('follows Google\'s redirect to its content host and returns the CSV', async () => {
    const g = workingGoogle('a,b\n1,2');
    assert.equal(await downloadSheetCsv({ id: SHEET_ID, gid: '316683387' }, g.fetchFn), 'a,b\n1,2');
    assert.deepEqual(g.calls.map((c) => c.url), [EXPORT_URL, SERVED_URL]);
    for (const c of g.calls) {
      assert.equal(c.init?.redirect, 'manual', 'redirects are checked by hand');
      assert.ok(c.init?.signal, 'has a timeout');
    }
  });

  const failsWith = async (hops: Record<string, Hop | (() => Hop)>, pattern: RegExp) => {
    const g = pretendGoogle(hops);
    await assert.rejects(downloadSheetCsv({ id: SHEET_ID, gid: '316683387' }, g.fetchFn), (e: unknown) => e instanceof ImportError && pattern.test(e.message));
    return g;
  };

  it('tells the admin to share the sheet when Google asks for a sign-in', async () => {
    await failsWith({ [EXPORT_URL]: { status: 302, location: 'https://accounts.google.com/ServiceLogin?continue=x' } }, /Anyone with the link/);
    await failsWith({ [EXPORT_URL]: { status: 401 } }, /Anyone with the link/);
    await failsWith({ [EXPORT_URL]: { status: 403 } }, /Anyone with the link/);
    await failsWith({ [EXPORT_URL]: { type: 'text/html; charset=utf-8', body: '<html>Sign in</html>' } }, /Anyone with the link/);
  });

  it('never follows a redirect off Google, and does not even contact the other host', async () => {
    const g = await failsWith({ [EXPORT_URL]: { status: 302, location: 'https://evil.example/steal' } }, /somewhere unexpected/);
    assert.deepEqual(g.calls.map((c) => c.url), [EXPORT_URL]);
    await failsWith({ [EXPORT_URL]: { status: 302, location: 'http://doc-1.googleusercontent.com/x' } }, /somewhere unexpected/);
    await failsWith({ [EXPORT_URL]: { status: 302, location: 'https://googleusercontent.com.evil.example/x' } }, /somewhere unexpected/);
    await failsWith({ [EXPORT_URL]: { status: 302, location: 'http://127.0.0.1:8080/admin' } }, /somewhere unexpected/);
  });

  it('gives up on redirect loops, a missing sheet, other errors and unreachable Google', async () => {
    await failsWith({ [EXPORT_URL]: { status: 302, location: EXPORT_URL } }, /too many times/);
    await failsWith({ [EXPORT_URL]: { status: 404 } }, /couldn't find that sheet/);
    await failsWith({ [EXPORT_URL]: { status: 500 } }, /HTTP 500/);
    await failsWith({ [EXPORT_URL]: { status: 302 } }, /redirect I could not follow/);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await assert.rejects(downloadSheetCsv({ id: SHEET_ID, gid: null }, offline), /couldn't reach Google Sheets/);
  });

  it('refuses a sheet that is far bigger than any schedule', async () => {
    await failsWith({ [EXPORT_URL]: { type: 'text/csv', body: 'x'.repeat(2_100_000) } }, /too large/);
  });

  it('is what the source uses: one fetch, parsed into jobs', async () => {
    const g = workingGoogle(SHEET_CSV);
    const r = await new SheetJobSource({ id: SHEET_ID, gid: '316683387' }, g.fetchFn).fetch(AIRLINE, T0);
    assert.equal(r.jobs.length, 7);
    assert.equal(r.warnings.length, 3);
  });
});

/* ------------------------------------------------------------------ names from the sheet on the panel */

describe('flights the sheet already assigns', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let pid: number;

  const legAt = (code: string, legNo = 1) => h.jobs.open(pid).find((v) => v.job.code === code)!.legs.find((l) => l.legNo === legNo)!;
  const named = (key: string, chain: string, heldBy: string | null, over: Partial<SourceJob> = {}) => {
    const job = sj(key, chain, over);
    return { ...job, legs: job.legs.map((l, i) => ({ ...l, heldBy: i === 0 ? heldBy : null })) };
  };

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    pid = h.panel.id;
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('stores the name against the leg and shows it on the panel as in the schedule, not as a reservation', async () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor'), named('b', 'EGLL-EGCC', null)]);
    assert.equal(legAt('TST-001').sheetHolder, 'Taylor');
    assert.equal(legAt('TST-001').holder, null);
    await d.panels.refresh(pid);
    const text = d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
    assert.match(text, /^TST-001 ·[^\n]*\n## EGLL ✈ EGKK\n(?:[A-Z ]+: [^\n]*\n)*PILOT: Taylor \*\(in the schedule\)\*$/m);
    assert.match(text, /^TST-002 ·[^\n]*\n## [^\n]*\n(?:[A-Z ]+: [^\n]*\n)*PILOT: \*open\*$/m);
  });

  it('treats such a leg as taken: nobody can reserve it, and they are told who has it', async () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]);
    const r = h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
    assert.deepEqual([r.reserved, r.taken.map((t) => [t.legNo, t.holder, t.sheetHolder])], [[], [[1, null, 'Taylor']]]);
    assert.equal(h.jobs.mine(pid, USER_A.discordId).length, 0, 'nothing was reserved');
  });

  it('says so in the DM, naming the sheet\'s pilot', async () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]);
    h.store.upsertSession({ discordId: alice.id, panelId: pid, step: 'await_code', expiresAt: T0 + HOUR });
    await handleDmMessage(d.ctx, fakeDm(alice, 'TST-001'));
    assert.match(alice.lastText, /already taken by \*\*Taylor\*\* \(named in the airline's schedule\)/);
    assert.match(alice.lastText, /Nothing was reserved/);
  });

  it('lets a pilot take the free legs of a flight whose other leg is named in the sheet', async () => {
    h.jobs.sync(pid, [named('m', 'EGLL-EGKK-EGCC', 'Taylor')]);
    h.store.upsertSession({ discordId: alice.id, panelId: pid, step: 'await_code', expiresAt: T0 + HOUR });
    await handleDmMessage(d.ctx, fakeDm(alice, 'TST-001'));
    const buttons = alice.last.components[0].toJSON().components as Array<{ custom_id: string }>;
    assert.deepEqual(buttons.map((b) => b.custom_id), ['dm:all', 'dm:some', 'dm:cancel']);

    const dm = componentHandlers.find((x) => x.prefix === 'dm')!;
    const all = fakeComponent(alice, 'dm:all');
    await dm.handle(d.ctx, all.i);
    assert.match(String(all.calls.updates[0].content), /Leg 1 \(EGLL → EGKK\) is already taken by \*\*Taylor\*\*/);
    assert.match(String(all.calls.updates[0].content), /other leg \(2\) instead/);

    const take = fakeComponent(alice, 'dm:take');
    await dm.handle(d.ctx, take.i);
    assert.deepEqual(h.jobs.view(h.jobs.open(pid)[0]!.job.id)!.legs.map((l) => [l.holder?.username ?? null, l.sheetHolder]), [[null, 'Taylor'], ['alice', null]]);
  });

  it('follows the sheet: a name that appears is shown, one that is cleared frees the leg', () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', null)]);
    assert.equal(legAt('TST-001').sheetHolder, null);

    const added = h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]);
    assert.equal(added.updated, 1, 'a changed name counts as a change, so the panel is redrawn');
    assert.equal(legAt('TST-001').sheetHolder, 'Taylor');

    assert.equal(h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]).updated, 0, 'unchanged is not a change');

    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', null)]);
    assert.equal(legAt('TST-001').sheetHolder, null);
    assert.equal(h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A).reserved.length, 1, 'free again');
  });

  it('never takes a Discord reservation away because the sheet now names someone, and shows both', async () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', null)]);
    h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
    const r = h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]);
    assert.equal(r.released.length, 0);
    const leg = legAt('TST-001');
    assert.equal(leg.holder?.username, 'alice');
    assert.equal(leg.sheetHolder, 'Taylor');
    assert.equal(holderText(leg), `<@${USER_A.discordId}> · FsHub #1001 · *schedule: Taylor*`);
    // and the same person asking again is told they already hold it, not that it is taken
    assert.deepEqual(h.jobs.reserve(leg.jobId, [1], USER_A).alreadyMine, [1]);
    assert.equal(h.jobs.reserve(leg.jobId, [1], USER_B).taken.length, 1);
  });

  it('leaves flights the sheet marks finished quietly: closed, holders not told they were "removed"', () => {
    h.jobs.sync(pid, [sj('a', 'EGLL-EGKK')]);
    h.jobs.reserve(h.jobs.open(pid)[0]!.job.id, [1], USER_A);
    const r = h.jobs.sync(pid, [{ ...sj('a', 'EGLL-EGKK'), closed: true }]);
    assert.deepEqual([r.removed, r.released.length], [0, 0]);
    assert.equal(h.jobs.open(pid).length, 0);
    assert.equal(h.store.listJobs(pid)[0]!.status, 'expired');
  });

  it('does not list, or number, a flight that arrives already closed', () => {
    const r = h.jobs.sync(pid, [{ ...sj('x', 'EGLL-EGKK'), closed: true }, sj('y', 'EGLL-EGCC')]);
    assert.equal(r.added, 1);
    assert.deepEqual(h.jobs.open(pid).map((v) => v.job.code), ['TST-001'], 'no gap in the numbering');
  });

  it('shows a sheet name as plain text, whatever it contains', () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', '@everyone **bold** <@123456789012345678> _x_')]);
    const leg = legAt('TST-001');
    const shown = holderText(leg);
    assert.doesNotMatch(shown, /@everyone/, 'no live @everyone');
    assert.doesNotMatch(shown, /<@123456789012345678>/, 'no live mention');
    assert.match(shown, /\\\*\\\*bold\\\*\\\*/);
    assert.match(jobBlock(h.jobs.open(pid)[0]!, T0), /\(in the schedule\)/);
  });

  it('a flight\'s route changing in the sheet still resets that leg\'s name and reservation', () => {
    h.jobs.sync(pid, [named('a', 'EGLL-EGKK', 'Taylor')]);
    h.jobs.sync(pid, [named('a', 'EGLL-EGCC', 'Taylor')]);
    const leg = legAt('TST-001');
    assert.deepEqual([leg.arr, leg.sheetHolder], ['EGCC', 'Taylor']);
  });
});

/* ------------------------------------------------------------------ the refresh keeps a note */

describe('refreshing from a linked sheet', () => {
  let h: Harness;
  let d: DiscordHarness;
  let body: () => Hop;

  beforeEach(async () => {
    h = await makeHarness();
    const g = pretendGoogle({ [EXPORT_URL]: { status: 307, location: SERVED_URL }, [SERVED_URL]: () => body() });
    d = makeDiscordHarness(h, { fetchFn: g.fetchFn });
    h.store.updatePanel(h.panel.id, { sheetId: SHEET_ID, sheetGid: '316683387' });
    body = () => ({ type: 'text/csv', body: SHEET_CSV });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('picks the sheet as the panel\'s source, ahead of any fallback', () => {
    const panel = h.store.getPanel(h.panel.id)!;
    const pick = sourceSelector({ fallback: null });
    assert.equal(pick(panel)?.kind, 'google-sheet');
    assert.equal(pick({ ...panel, sheetId: null, sheetGid: null }), null, 'no sheet and no fallback: file imports');
    const demo = { kind: 'demo', fetch: async () => [] };
    assert.equal(sourceSelector({ fallback: demo })({ ...panel, sheetId: null, sheetGid: null }), demo);
  });

  it('loads the flights and remembers what it skipped, then clears the note when the sheet is fixed', async () => {
    const panel = h.store.getPanel(h.panel.id)!;
    const out = await d.refresher.refresh(panel);
    assert.equal(out.added, 5, 'seven rows are readable; the cancelled and the completed one never reach the panel');
    assert.equal(out.warnings.length, 3);
    assert.match(h.store.getPanel(panel.id)!.lastRefreshNote!, /KORD-KPVD/);
    assert.equal(h.store.getPanel(panel.id)!.lastRefreshError, null);

    body = () => ({ type: 'text/csv', body: [HEADER, ROWS.open].join('\n') });
    const again = await d.refresher.refresh(h.store.getPanel(panel.id)!);
    assert.deepEqual(again.warnings, []);
    assert.equal(h.store.getPanel(panel.id)!.lastRefreshNote, null);
  });

  it('keeps the existing flights and records the problem when Google cannot be read', async () => {
    const panel = h.store.getPanel(h.panel.id)!;
    await d.refresher.refresh(panel);
    const before = h.jobs.open(panel.id).map((v) => v.job.code);

    body = () => ({ type: 'text/html', body: '<html>Sign in</html>' });
    await assert.rejects(d.refresher.refresh(panel), /Anyone with the link/);
    assert.deepEqual(h.jobs.open(panel.id).map((v) => v.job.code), before);
    assert.match(h.store.getPanel(panel.id)!.lastRefreshError!, /Anyone with the link/);
  });

  it('keeps IDs and reservations across refreshes, and a pilot signing up in the sheet shows up', async () => {
    const panel = h.store.getPanel(h.panel.id)!;
    await d.refresher.refresh(panel);
    const first = h.jobs.open(panel.id).find((v) => v.job.sourceKey === 'EGLL-EGCC@2026-11-12')!;
    h.jobs.reserve(first.job.id, [1], USER_A);

    const csv = SHEET_CSV.replace(ROWS.overnight, 'KMIA-KORD,11/12/2026,1200-0600z,Thu 0600 - Fri 0000 CT,Robin,,B738,FALSE,FALSE,,,,');
    body = () => ({ type: 'text/csv', body: csv });
    const r = await d.refresher.refresh(panel);
    assert.equal(r.added, 0);
    assert.equal(r.updated, 1);
    const same = h.jobs.open(panel.id).find((v) => v.job.sourceKey === 'EGLL-EGCC@2026-11-12')!;
    assert.deepEqual([same.job.code, same.legs[0]!.holder?.username], [first.job.code, 'alice']);
    assert.equal(h.jobs.open(panel.id).find((v) => v.job.sourceKey === 'KMIA-KORD@2026-11-12')!.legs[0]!.sheetHolder, 'Robin');
  });
});

/* ------------------------------------------------------------------ /setup sheet */

describe('/setup sheet', () => {
  const setup = commands.find((c) => c.data.name === 'setup')!;
  let h: Harness;
  let d: DiscordHarness;
  let google: ReturnType<typeof pretendGoogle>;
  let body: () => Hop;

  const guildFake = { channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => true }) }) }, members: { me: {}, fetchMe: async () => ({}) } };
  const run = async (sub: string, o: FakeInteractionOptions = {}) => {
    const f = fakeInteraction({ sub, admin: true, guild: guildFake, ...o });
    await setup.execute(d.ctx, f.i);
    await settle();
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const panelOf = () => h.store.getPanelByName(GUILD, 'Test Air')!;

  beforeEach(async () => {
    h = await makeHarness();
    google = pretendGoogle({ [EXPORT_URL]: { status: 307, location: SERVED_URL }, [SERVED_URL]: () => body() });
    body = () => ({ type: 'text/csv', body: SHEET_CSV });
    d = makeDiscordHarness(h, { fetchFn: google.fetchFn });
    h.store.deletePanel(h.panel.id);
    await run('panel-add', { options: { airline: 'Test Air', prefix: 'TST', channel: { id: CHANNEL } } });
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is admin-only like the rest of /setup', async () => {
    await assert.rejects(run('sheet', { admin: false, options: { link: SHEET_URL } }), (e: unknown) => e instanceof UserError && /Manage Server/.test(e.message));
    assert.equal(panelOf().sheetId, null);
  });

  it('links the sheet, loads its flights, redraws the panel and says what it will and will not do', async () => {
    const calls = await run('sheet', { options: { link: SHEET_URL } });
    const p = panelOf();
    assert.deepEqual([p.sheetId, p.sheetGid], [SHEET_ID, '316683387']);
    assert.equal(h.jobs.open(p.id).length, 5);
    const reply = text(calls);
    assert.match(reply, /now reads its flights from your sheet: 5 open flights \(5 new/);
    assert.match(reply, /only \*\*read\*\* the sheet and never change it/);
    assert.match(reply, /Zulu/);
    assert.match(reply, /skipped or guessed at some rows/);
    assert.match(reply, /KORD-KPVD/);
    // the panel shows the sheet's own sign-ups
    const panelText = d.client.channel(CHANNEL).live.map((m) => messageText(m)).join('\n');
    assert.match(panelText, /Taylor \*\(in the schedule\)\*/);
    assert.match(panelText, /Backup: Jordan/);
  });

  it('accepts the link again later, without duplicating flights', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    const codes = h.jobs.open(panelOf().id).map((v) => v.job.code);
    const calls = await run('sheet', { options: { link: SHEET_URL } });
    assert.match(text(calls), /0 new, 0 changed, 0 closed/);
    assert.deepEqual(h.jobs.open(panelOf().id).map((v) => v.job.code), codes);
  });

  it('saves nothing when the sheet cannot be read, and says how to fix it', async () => {
    body = () => ({ type: 'text/html', body: '<html>Sign in</html>' });
    await assert.rejects(run('sheet', { options: { link: SHEET_URL } }), (e: unknown) => /Anyone with the link/.test(String((e as Error).message)));
    assert.equal(panelOf().sheetId, null);
    assert.equal(panelOf().lastRefreshError, null);
    assert.equal(h.jobs.open(panelOf().id).length, 0);
  });

  it('rejects anything that is not a Google Sheets link, without contacting anyone', async () => {
    google.calls.length = 0;
    for (const link of ['https://evil.example/spreadsheets/d/' + SHEET_ID, 'http://169.254.169.254/latest/meta-data', 'banana']) {
      await assert.rejects(run('sheet', { options: { link } }), (e: unknown) => e instanceof UserError && /isn't a Google Sheets link/.test(e.message));
    }
    assert.equal(google.calls.length, 0);
    assert.equal(panelOf().sheetId, null);
  });

  it('"none" unlinks the sheet but leaves the flights on the panel', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    const open = h.jobs.open(panelOf().id).length;
    const calls = await run('sheet', { options: { link: 'none' } });
    assert.match(text(calls), /Stopped reading a sheet/);
    assert.deepEqual([panelOf().sheetId, panelOf().sheetGid, panelOf().lastRefreshNote], [null, null, null]);
    assert.equal(h.jobs.open(panelOf().id).length, open);
    assert.equal(d.refresher.hasSource(panelOf()), false);
  });

  it('tells a holder when the linked sheet drops a flight they reserved', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    const alice = d.client.user(new FakeUser(USER_A.discordId, 'alice'));
    const job = h.jobs.open(panelOf().id).find((v) => v.job.sourceKey === 'EGLL-EGCC@2026-11-12')!;
    h.jobs.reserve(job.job.id, [1], USER_A);
    body = () => ({ type: 'text/csv', body: [HEADER, ROWS.overnight].join('\n') });
    const calls = await run('refresh');
    assert.match(text(calls), /Fetched: 0 new, 0 changed, 4 closed/);
    await settle(60);
    assert.match(alice.lastText, /TST-\d+/, 'the holder was told');
  });

  it('refresh shows what it skipped', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    const calls = await run('refresh');
    assert.match(text(calls), /Fetched: 0 new, 0 changed, 0 closed/);
    assert.match(text(calls), /KORD-KPVD/);
  });

  it('/setup panels names the source, counts the sheet\'s sign-ups, and shows the note', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    const calls = await run('panels');
    assert.match(text(calls), /flights from: Google Sheet/);
    assert.match(text(calls), /5 open flights, 0\/5 legs reserved, 1 named in the sheet/);
    assert.match(text(calls), /KORD-KPVD/);
  });

  it('refuses a file import while a sheet is linked, since the next refresh would undo it', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    await assert.rejects(run('import', { options: { file: { url: 'https://cdn.discordapp.com/attachments/1/2/x.csv', size: 10, name: 'x.csv' } } }), /reads its flights from a Google Sheet.*sheet link:none/);
  });

  it('the scheduler\'s daily refresh picks up a linked sheet on its own', async () => {
    await run('sheet', { options: { link: SHEET_URL } });
    google.calls.length = 0;
    assert.equal(await d.refresher.refreshDue(), 0, 'not due yet: it was just read');
    assert.equal(google.calls.length, 0);

    h.clock.advance(25 * HOUR);
    body = () => ({ type: 'text/csv', body: [HEADER, ROWS.open, 'EGLL-EGKK,11/13/2026,0600-2359z,,,,A20N,FALSE,FALSE,,,,'].join('\n') });
    assert.equal(await d.refresher.refreshDue(), 1, 'due once the last read is a day old');
    assert.ok(h.jobs.open(panelOf().id).some((v) => v.job.sourceKey === 'EGLL-EGKK@2026-11-13'), 'the new flight arrived without anyone asking');
  });
});
