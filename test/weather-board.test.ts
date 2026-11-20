import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Job, JobView } from '../src/db/store.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { registerInteractionRouter } from '../src/discord/router.js';
import { MAX_SEARCH_AIRPORTS, SEARCH_COOLDOWN_MS, WEATHER_REFRESH_MS, weatherHandler } from '../src/discord/weatherBoard.js';
import { MAX_BOARD_MESSAGES, metarBlocks, renderWeather, WEATHER_FOOTER, windowText, type WeatherView } from '../src/discord/weatherUi.js';
import { MetarError } from '../src/metar/client.js';
import { Scheduler } from '../src/services/scheduler.js';
import { DEFAULT_WEATHER_AIRPORTS, flightAirports, flightsInWindow, MAX_TOP_AIRPORTS, parseAirportList, WEATHER_WINDOW_MS, type BoardFlight } from '../src/services/weatherAirports.js';
import { CHANNEL, GUILD, HOUR, makeHarness, sj, T0, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeInteraction, fakeModal, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const WX = '700000000000000050';
const OTHER_CHANNEL = '700000000000000051';

// Shaped like what VATSIM answers: one METAR to a line, each starting with its airport.
const REPORTS: Record<string, string> = {
  KBOS: 'KBOS 111154Z 27012KT 10SM FEW250 12/03 A3012 RMK AO2 SLP201 T01220028',
  KMIA: 'KMIA 111153Z 09008KT 10SM FEW025 SCT250 27/21 A3002 RMK AO2 SLP165',
  SKBO: 'SKBO 111100Z 08005KT 9999 FEW030 SCT100 14/09 Q1028',
  EGLL: 'EGLL 111150Z AUTO 26008KT 9999 NCD 08/01 Q1006 NOSIG',
  KJFK: 'KJFK 111151Z 35011KT 10SM FEW028 08/01 A3039 RMK AO2 SLP291',
  EGKK: 'EGKK 111150Z 24005KT CAVOK 09/04 Q1009 NOSIG',
};

/* ------------------------------------------------------------------ choosing flights and airports */

const job = (over: Partial<Job> = {}): Job => ({
  id: 1,
  panelId: 1,
  code: 'TST-001',
  sourceKey: 'k',
  title: null,
  aircraft: null,
  availableFrom: T0 + 2 * HOUR,
  deadline: T0 + 6 * HOUR,
  pay: null,
  notes: null,
  distanceNm: null,
  status: 'open',
  firstSeen: 0,
  lastSeen: 0,
  remindedAt: null,
  completedAt: null,
  completedBy: null,
  completedVia: null,
  ...over,
});
const view = (over: Partial<Job> = {}, route: Array<[string, string]> = [['KJFK', 'KBOS']]): JobView => ({
  job: job(over),
  legs: route.map(([dep, arr], i) => ({ jobId: 1, legNo: i + 1, dep, arr, sheetHolder: null, holder: null })),
});

describe('which flights are in the next 24 hours', () => {
  it('takes a flight whose landing window overlaps them, including one already open and still to be flown', () => {
    const inside = view({ code: 'IN' });
    const open = view({ code: 'OPEN', availableFrom: T0 - 5 * HOUR, deadline: T0 + HOUR });
    const edge = view({ code: 'EDGE', availableFrom: T0 + WEATHER_WINDOW_MS, deadline: T0 + WEATHER_WINDOW_MS + HOUR });
    const lastMinute = view({ code: 'ENDS', availableFrom: T0 - 2 * HOUR, deadline: T0 });
    assert.deepEqual(flightsInWindow([inside, open, edge, lastMinute], T0).map((f) => f.code), ['OPEN', 'ENDS', 'IN', 'EDGE']);
  });

  it('leaves out one that starts after the 24 hours, one whose window has passed, and one with no time at all', () => {
    const later = view({ code: 'LATER', availableFrom: T0 + WEATHER_WINDOW_MS + 1, deadline: T0 + 30 * HOUR });
    const over = view({ code: 'OVER', availableFrom: T0 - 4 * HOUR, deadline: T0 - 1 });
    const none = view({ code: 'NONE', availableFrom: null, deadline: null });
    assert.deepEqual(flightsInWindow([later, over, none], T0), []);
  });

  it('uses the deadline as the time of a flight that has no start', () => {
    assert.deepEqual(flightsInWindow([view({ code: 'A', availableFrom: null, deadline: T0 + 3 * HOUR })], T0).map((f) => [f.code, f.from, f.to]), [['A', T0 + 3 * HOUR, T0 + 3 * HOUR]]);
  });

  it('skips a flight that is completed or no longer open', () => {
    assert.deepEqual(flightsInWindow([view({ code: 'DONE', completedAt: T0 }), view({ code: 'GONE', status: 'removed' }), view({ code: 'EXP', status: 'expired' })], T0), []);
  });

  it('lists them soonest first, and keeps each flight\'s legs in order', () => {
    const a = view({ code: 'B', availableFrom: T0 + 5 * HOUR, deadline: T0 + 8 * HOUR }, [['EGLL', 'EGKK'], ['EGKK', 'EGCC']]);
    const b = view({ code: 'A', availableFrom: T0 + 2 * HOUR, deadline: T0 + 8 * HOUR });
    const out = flightsInWindow([a, b], T0);
    assert.deepEqual(out.map((f) => f.code), ['A', 'B']);
    assert.deepEqual(out[1]!.legs, [{ dep: 'EGLL', arr: 'EGKK' }, { dep: 'EGKK', arr: 'EGCC' }]);
  });
});

describe('which airports the flights need', () => {
  const flight = (...route: string[]): BoardFlight => ({ code: 'X', legs: route.slice(0, -1).map((dep, i) => ({ dep, arr: route[i + 1]! })), from: 0, to: 1 });

  it('lists each airport once, in the order the flights come, and not the ones already at the top', () => {
    const r = flightAirports([flight('KJFK', 'KBOS'), flight('EGKK', 'KJFK', 'EGLL'), flight('KORD', 'EGKK')], ['KBOS', 'EGLL']);
    assert.deepEqual(r.codes, ['KJFK', 'EGKK', 'KORD']);
    assert.deepEqual(r.skipped, []);
  });

  it('sets aside a code that is not four characters, once, since VATSIM has no report for it', () => {
    const r = flightAirports([flight('JFK', 'KBOS'), flight('LHR', 'JFK', 'EGKK')], []);
    assert.deepEqual(r.codes, ['KBOS', 'EGKK']);
    assert.deepEqual(r.skipped, ['JFK', 'LHR']);
  });
});

describe('reading the airports an admin types', () => {
  it('takes four-letter codes in any case, separated by spaces or commas, each once', () => {
    assert.deepEqual(parseAirportList(' kbos, KMIA  skbo;egll kbos').codes, ['KBOS', 'KMIA', 'SKBO', 'EGLL']);
  });

  it('reports what it could not use, made harmless', () => {
    const r = parseAirportList('KBOS JFK `bad` EGLLX');
    assert.deepEqual(r.codes, ['KBOS']);
    assert.deepEqual(r.refused, ['JFK', "'bad'", 'EGLLX']);
  });

  it('is the airports the board was asked for: KBOS KMIA SKBO EGLL', () => {
    assert.deepEqual([...DEFAULT_WEATHER_AIRPORTS], ['KBOS', 'KMIA', 'SKBO', 'EGLL']);
  });
});

/* ------------------------------------------------------------------ how it looks */

describe('the weather board text', () => {
  const base = (over: Partial<WeatherView> = {}): WeatherView => ({
    now: T0,
    top: DEFAULT_WEATHER_AIRPORTS.map((c) => REPORTS[c]!),
    flights: [],
    moreFlights: 0,
    flightAirports: [],
    moreAirports: 0,
    skipped: [],
    everyMinutes: 10,
    ...over,
  });
  const flight = (code: string, route: Array<[string, string]>, from: number, to: number): BoardFlight => ({ code, legs: route.map(([dep, arr]) => ({ dep, arr })), from, to });

  it('shows the airports first, then the flights, then the weather of the flights\' airports, with only the abbreviations', () => {
    const [text] = renderWeather(base({ flights: [flight('SKY330', [['KJFK', 'KBOS']], T0 + 2 * HOUR, T0 + 6 * HOUR)], flightAirports: [REPORTS.KJFK!] }));
    assert.ok(text!.startsWith('🌦️ **Weather** · METARs from VATSIM · checked <t:'));
    const at = (s: string) => text!.indexOf(s);
    assert.ok(at('**Airports**') < at(REPORTS.KBOS!) && at(REPORTS.KBOS!) < at(REPORTS.KMIA!) && at(REPORTS.KMIA!) < at(REPORTS.SKBO!) && at(REPORTS.SKBO!) < at(REPORTS.EGLL!), 'the four, in the order given');
    assert.ok(at(REPORTS.EGLL!) < at('**Flights in the next 24 hours** (1)'));
    assert.ok(at('**Flights in the next 24 hours** (1)') < at('**Airports of those flights**'));
    assert.ok(at('**Airports of those flights**') < at(REPORTS.KJFK!));
    assert.match(text!, /`SKY330` KJFK → KBOS · 11 Nov 1400-1800Z/);
    assert.doesNotMatch(text!, /In short|knots|statute|Flying conditions|Visibility|Wind/, 'the abbreviations, not the plain-language explanation');
    assert.ok(text!.endsWith(`*${WEATHER_FOOTER}*`));
  });

  it('says so when there are no flights, and leaves the flights\' airports out', () => {
    const [text] = renderWeather(base());
    assert.match(text!, /\*\*Flights in the next 24 hours\*\*\nNone in the schedule\./);
    assert.doesNotMatch(text!, /Airports of those flights/);
  });

  it('writes a multi-leg flight as a chain, and a window across midnight with both days', () => {
    const [text] = renderWeather(base({ flights: [flight('ABC', [['EGLL', 'EGKK'], ['EGKK', 'EGCC']], T0 + 10 * HOUR, T0 + 16 * HOUR)] }));
    assert.match(text!, /`ABC` EGLL → EGKK → EGCC · 11 Nov 2200Z to 12 Nov 0400Z/);
    assert.equal(windowText(T0, T0 + 6 * HOUR), '11 Nov 1200-1800Z');
    assert.equal(windowText(T0 + 11 * HOUR + 59 * 60_000, T0 + 11 * HOUR + 59 * 60_000), '11 Nov by 2359Z');
  });

  it('counts the flights it could not list, and the airports it could not show, and the codes it did not ask about', () => {
    const [text] = renderWeather(base({ flights: [flight('A', [['KJFK', 'KBOS']], T0, T0 + HOUR)], moreFlights: 4, flightAirports: [REPORTS.KJFK!], moreAirports: 1, skipped: ['JFK', 'LHR'] }));
    assert.match(text!, /\(5\)/);
    assert.match(text!, /…and 4 more flights\./);
    assert.match(text!, /…and 1 more airport not shown\./);
    assert.match(text!, /No report asked for `JFK`, `LHR`: not four-letter airport codes\./);
  });

  it('keeps nothing in a METAR able to end its block, start a mention or break a line', () => {
    const blocks = metarBlocks(['KBOS 111154Z ``` @everyone <@123>\nRMK AO2']);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.split('```').length, 3, 'only the two fences are fences');
    assert.equal(blocks[0]!.split('\n').length, 3, 'one line of text between them');
  });

  it('spreads a long board over several messages, each inside Discord\'s limit with its code blocks closed', () => {
    const many = Array.from({ length: 40 }, (_, i) => `KA${String(i).padStart(2, '0')} 111150Z ${'AUTO 26008KT 9999 NCD 08/01 Q1006 NOSIG '.repeat(2).trim()}`);
    const messages = renderWeather(base({ flights: Array.from({ length: 30 }, (_, i) => flight(`F${i}`, [['KJFK', 'KBOS']], T0 + i * HOUR / 2, T0 + 6 * HOUR)), flightAirports: many }));
    assert.ok(messages.length > 1 && messages.length <= MAX_BOARD_MESSAGES, `${messages.length} messages`);
    for (const m of messages) {
      assert.ok(m.length <= 2000, `a message of ${m.length} characters`);
      assert.equal(m.split('```').length % 2, 1, 'every code block is closed');
    }
    assert.ok(messages.join('\n').includes(many.at(-1)!), 'nothing lost on the way');
  });

  it('never needs more than eight messages, even for reports that are as long as one can be', () => {
    const huge = Array.from({ length: 40 }, (_, i) => `KB${String(i).padStart(2, '0')} ${'X'.repeat(790)}`);
    const messages = renderWeather(base({ flightAirports: huge }));
    assert.equal(messages.length, MAX_BOARD_MESSAGES);
    assert.ok(messages.every((m) => m.length <= 2000));
    assert.match(messages.at(-1)!, /…and more that did not fit\./);
  });
});

/* ------------------------------------------------------------------ keeping a board up to date */

describe('the weather board in a channel', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    for (const [code, report] of Object.entries(REPORTS)) d.metar.known.set(code, report);
    h.store.setWeatherBoard(GUILD, WX, h.clock.now);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });
  const board = () => h.store.getWeatherBoard(GUILD)!;
  const live = () => d.client.channel(WX).live;
  const text = () => live().map((m) => String(m.payload.content)).join('\n');
  const flight = (key: string, chain: string, fromH: number, toH: number) => sj(key, chain, { availableFrom: T0 + fromH * HOUR, deadline: T0 + toH * HOUR });

  it('posts the four airports at the top as written, with the Search button under it and no pings', async () => {
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    const content = String(live()[0]!.payload.content);
    for (const code of ['KBOS', 'KMIA', 'SKBO', 'EGLL']) assert.ok(content.includes(REPORTS[code]!), code);
    assert.deepEqual(d.metar.calls.sort(), ['EGLL', 'KBOS', 'KMIA', 'SKBO'], 'only those four are asked for');
    const rows = live()[0]!.payload.components.map((r: { toJSON(): any }) => r.toJSON());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].components[0].custom_id, 'weather:search');
    assert.equal(rows[0].components[0].label, 'Search airport');
    assert.deepEqual(live()[0]!.payload.allowedMentions, { parse: [] });
    assert.deepEqual(board().messageIds, [live()[0]!.id]);
    assert.deepEqual([board().lastOkAt, board().lastError], [h.clock.now, null]);
  });

  it('asks VATSIM for reports a little younger than its own redraws, so it never reuses its previous answer', async () => {
    await d.weather.refresh(GUILD);
    assert.ok(d.metar.maxAges.length > 0 && d.metar.maxAges.every((a) => a !== undefined && a < WEATHER_REFRESH_MS));
  });

  it('adds the airports of the flights in the next 24 hours, each once, and not those of flights outside them', async () => {
    h.jobs.sync(h.panel.id, [
      flight('soon', 'KJFK-KBOS', 2, 6),
      flight('open', 'EGKK-EGLL', -3, 3),
      flight('again', 'KJFK-EGKK', 8, 12),
      flight('tomorrow', 'LFPG-LFMN', 30, 36),
      flight('over', 'EDDF-EHAM', -9, -1),
    ]);
    await d.weather.refresh(GUILD);
    assert.deepEqual([...new Set(d.metar.calls)].sort(), ['EGKK', 'EGLL', 'KBOS', 'KJFK', 'KMIA', 'SKBO'], 'no report for the flights outside the 24 hours');
    assert.equal(d.metar.calls.length, 6, 'one request for each airport');
    const t = text();
    assert.match(t, /\*\*Flights in the next 24 hours\*\* \(3\)/);
    assert.match(t, /EGKK → EGLL · 11 Nov 0900-1500Z/);
    assert.match(t, /KJFK → KBOS · 11 Nov 1400-1800Z/);
    assert.doesNotMatch(t, /LFPG|LFMN|EDDF|EHAM/);
    const theirs = t.slice(t.indexOf('**Airports of those flights**'));
    assert.equal(theirs.split(REPORTS.KJFK!).length, 2, 'KJFK is there once though two flights use it');
    assert.ok(theirs.includes(REPORTS.EGKK!));
    assert.ok(!theirs.includes(REPORTS.KBOS!), 'the airports at the top are not repeated');
    assert.ok(theirs.indexOf(REPORTS.EGKK!) < theirs.indexOf(REPORTS.KJFK!), 'in the order the flights come');
  });

  it('asks VATSIM for the whole board in ONE request, however many airports the flights use (many requests at once got a server rate-limited)', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 30]}`, 1, 5)));
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(d.metar.batches.length, 1, 'one request');
    assert.equal(d.metar.batches[0]!.length, 4 + 30, 'for the four at the top and every airport of the flights');
    h.clock.advance(WEATHER_REFRESH_MS);
    await d.weather.refresh(GUILD);
    assert.equal(d.metar.batches.length, 2, 'and one more at the next redraw');
  });

  it('leaves the board as it was, and says how long VATSIM asked to be left alone, when it is rate-limited', async () => {
    await d.weather.refresh(GUILD);
    const shown = live()[0]!;
    d.metar.error = new MetarError('unavailable', "VATSIM's weather service is busy right now. Try again in about 3 minutes.", 161_000);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'unavailable');
    assert.equal(shown.edits.length, 0);
    assert.match(board().lastError!, /busy right now\. Try again in about 3 minutes\./);
  });

  it('shows the flights of every panel in the server, and none of another server\'s', async () => {
    const second = h.store.createPanel({ guildId: GUILD, name: 'Second Air', abbr: 'SEC', prefix: 'SEC', channelId: '700000000000000099', now: T0 });
    const foreign = h.store.createPanel({ guildId: 'another-server', name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000098', now: T0 });
    h.jobs.sync(h.panel.id, [flight('a', 'KJFK-KBOS', 1, 5)]);
    h.jobs.sync(second.id, [flight('b', 'EGKK-EGLL', 1, 5)]);
    h.jobs.sync(foreign.id, [flight('c', 'LFPG-LFMN', 1, 5)]);
    await d.weather.refresh(GUILD);
    assert.match(text(), /\*\*Flights in the next 24 hours\*\* \(2\)/);
    assert.match(text(), /`SEC-\d+` EGKK → EGLL/);
    assert.doesNotMatch(text(), /LFPG|FAR-/);
    assert.ok(!d.metar.calls.includes('LFPG'));
  });

  it('uses the board\'s own airports at the top when it has some', async () => {
    h.store.updateWeatherBoard(GUILD, { airports: ['EGKK', 'KJFK'] });
    await d.weather.refresh(GUILD);
    assert.deepEqual(d.metar.calls.sort(), ['EGKK', 'KJFK']);
    assert.ok(text().includes(REPORTS.EGKK!) && !text().includes(REPORTS.KBOS!));
  });

  it('says so for an airport VATSIM has no report for, and for one whose report could not be read', async () => {
    d.metar.known.delete('SKBO');
    d.metar.errors.set('EGLL', new MetarError('bad-response', 'VATSIM sent a weather report I could not read.'));
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.match(text(), /^SKBO no METAR available$/m);
    assert.match(text(), /^EGLL report could not be read$/m);
    assert.ok(text().includes(REPORTS.KBOS!), 'the rest are there');
  });

  it('does not ask for a code that is not four letters, and says so', async () => {
    h.jobs.sync(h.panel.id, [flight('x', 'JFK-EGKK', 1, 5)]);
    await d.weather.refresh(GUILD);
    assert.ok(!d.metar.calls.includes('JFK'));
    assert.match(text(), /No report asked for `JFK`: not four-letter airport codes\./);
    assert.ok(text().includes(REPORTS.EGKK!));
  });

  it('edits the messages in place, and only those whose words changed', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 50]}`, 1, 5)));
    await d.weather.refresh(GUILD);
    assert.ok(live().length >= 2, `${live().length} messages`);
    const ids = live().map((m) => m.id);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.deepEqual(live().map((m) => m.id), ids, 'the same messages');
    assert.equal(live()[0]!.edits.length, 1, 'the first says when it was checked, so it changes');
    for (const m of live().slice(1)) assert.equal(m.edits.length, 0, 'the rest say the same, so they are not touched');
    assert.equal(live().filter((m) => m.payload.components.length > 0).length, 1, 'one Search button');
    assert.equal(live().at(-1)!.payload.components.length, 1, 'under the last message');
  });

  it('shows a new report when VATSIM has one', async () => {
    await d.weather.refresh(GUILD);
    const newer = 'KBOS 111254Z 28015G25KT 10SM BKN040 11/02 A3010 RMK AO2';
    d.metar.known.set('KBOS', newer);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.ok(text().includes(newer) && !text().includes(REPORTS.KBOS!));
  });

  it('posts the board again when it needs a different number of messages', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 50]}`, 1, 5)));
    await d.weather.refresh(GUILD);
    const first = live().length;
    assert.ok(first >= 2);
    h.jobs.sync(h.panel.id, []);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    assert.deepEqual(board().messageIds, [live()[0]!.id], 'and the old ones are gone');
  });

  it('never posts two boards when redraws overlap (the schedule and /setup weather can ask at the same moment)', async () => {
    const results = await Promise.all([d.weather.refresh(GUILD), d.weather.refresh(GUILD), d.weather.refresh(GUILD)]);
    assert.deepEqual(results, ['posted', 'updated', 'updated']);
    assert.equal(live().length, 1);
    assert.deepEqual(board().messageIds, [live()[0]!.id]);
  });

  it('posts it again if someone deleted a message', async () => {
    await d.weather.refresh(GUILD);
    d.client.channel(WX).deleteMessage(live()[0]!.id);
    assert.equal(live().length, 0);
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    assert.deepEqual(board().messageIds, [live()[0]!.id]);
  });

  it('leaves the board as it was, and says why, when VATSIM cannot be reached', async () => {
    await d.weather.refresh(GUILD);
    const shown = live()[0]!;
    const before = shown.edits.length;
    d.metar.error = new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'unavailable');
    assert.equal(shown.edits.length, before, 'untouched');
    assert.equal(live().length, 1);
    assert.deepEqual([board().lastError, board().lastOkAt], ["I couldn't reach VATSIM's weather service right now.", h.clock.now - WEATHER_REFRESH_MS]);
    d.metar.error = null;
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.equal(board().lastError, null, 'cleared once it works again');
  });

  it('leaves the board as it was when VATSIM fails for only one of the airports', async () => {
    await d.weather.refresh(GUILD);
    const shown = live()[0]!;
    d.metar.errors.set('KMIA', new MetarError('unavailable', "VATSIM's weather service is busy right now. Try again in a minute."));
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'unavailable');
    assert.equal(shown.edits.length, 0);
    assert.match(board().lastError!, /busy/);
  });

  it('reports a channel that is gone or closed to it, without throwing', async () => {
    d.client.deleteAllChannels();
    assert.equal(await d.weather.refresh(GUILD), 'no-access');
    assert.match(board().lastError!, /missing, or I can't write/);
  });

  it('does nothing for a server whose board is off', async () => {
    assert.equal(await d.weather.refresh('another-server'), 'skipped');
    assert.equal(d.metar.calls.length, 0);
  });

  it('removes its messages when asked', async () => {
    await d.weather.refresh(GUILD);
    await d.weather.deleteMessages(board());
    assert.equal(live().length, 0);
  });

  describe('on a schedule', () => {
    it('draws a new board at once, then only when ten minutes have passed', async () => {
      await d.weather.run();
      assert.equal(d.metar.calls.length, 4);
      h.clock.advance(WEATHER_REFRESH_MS - 1000);
      await d.weather.run();
      assert.equal(d.metar.calls.length, 4, 'not yet');
      h.clock.advance(2000);
      await d.weather.run();
      assert.equal(d.metar.calls.length, 8);
    });

    it('does not hammer VATSIM while it is down: a failed try also waits ten minutes', async () => {
      d.metar.error = new MetarError('unavailable', 'down');
      await d.weather.run();
      await d.weather.run();
      h.clock.advance(5 * 60_000);
      await d.weather.run();
      assert.equal(new Set(d.metar.calls).size > 0 && d.metar.calls.length <= 4, true, 'one try (up to four airports asked before the failure was seen)');
      const asked = d.metar.calls.length;
      h.clock.advance(WEATHER_REFRESH_MS);
      await d.weather.run();
      assert.ok(d.metar.calls.length > asked);
    });

    it('serves several servers', async () => {
      h.store.setWeatherBoard('second-server', OTHER_CHANNEL, h.clock.now);
      await d.weather.run();
      assert.equal(live().length, 1);
      assert.equal(d.client.channel(OTHER_CHANNEL).live.length, 1);
    });

    it('is run by the scheduler beside its main pass, and a failure there stops nothing else', async () => {
      let runs = 0;
      const ok = new Scheduler(h.jobs, d.refresher, { weather: { run: async () => void runs++ } });
      await ok.tick();
      await ok.idle();
      assert.equal(runs, 1);
      const bad = new Scheduler(h.jobs, d.refresher, { weather: { run: async () => Promise.reject(new Error('boom')) } });
      await assert.doesNotReject(bad.tick());
      await assert.doesNotReject(bad.idle());
    });

    it('a shutdown can wait for a redraw that is under way', async () => {
      let finish!: () => void;
      const slow = new Scheduler(h.jobs, d.refresher, { weather: { run: () => new Promise<void>((r) => (finish = r)) } });
      await slow.tick();
      let waited = false;
      void slow.idle().then(() => (waited = true));
      await settle(10);
      assert.equal(waited, false);
      finish();
      await settle(10);
      assert.equal(waited, true);
    });
  });
});

/* ------------------------------------------------------------------ the Search button */

describe('the Search button', () => {
  let h: Harness;
  let d: DiscordHarness;
  let counter = 0;
  const person = () => new FakeUser(`8${String(++counter).padStart(17, '0')}`, `pilot${counter}`);
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    for (const [code, report] of Object.entries(REPORTS)) d.metar.known.set(code, report);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  const search = async (codes: string, user = person()) => {
    const f = fakeModal(user, 'weather:searchgo', { codes });
    await weatherHandler.handle(d.ctx, f.i);
    return f.calls;
  };
  const answer = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');

  it('is handled under the "weather" prefix', () => {
    assert.ok(componentHandlers.some((x) => x.prefix === 'weather'));
  });

  it('opens a form with one box for the airport code', async () => {
    const f = fakeComponent(person(), 'weather:search');
    await weatherHandler.handle(d.ctx, f.i);
    assert.equal(f.calls.modals.length, 1);
    const json = f.calls.modals[0].toJSON();
    assert.equal(json.custom_id, 'weather:searchgo');
    assert.ok(json.title.length <= 45);
    assert.equal(json.components.length, 1);
    const box = json.components[0].components[0];
    assert.equal(box.custom_id, 'codes');
    assert.equal(box.required, true);
    assert.ok(box.max_length >= 20);
  });

  it('answers only to the person who asked, with the METAR as written', async () => {
    const calls = await search('kjfk');
    assert.equal(calls.defers[0].flags, 64, 'ephemeral');
    assert.ok(answer(calls).includes(`\`\`\`\n${REPORTS.KJFK}\n\`\`\``));
    assert.deepEqual(d.metar.calls, ['KJFK']);
    assert.doesNotMatch(answer(calls), /In short|knots|statute/, 'not the plain-language version');
    assert.match(answer(calls), /Send me a DM: `metar KJFK`/);
    assert.ok(answer(calls).includes(WEATHER_FOOTER));
    assert.deepEqual(calls.edits.at(-1).allowedMentions, { parse: [] });
  });

  it('looks up several at once, in the order typed, each once', async () => {
    const calls = await search('EGLL, kbos  EGLL KJFK');
    const text = answer(calls);
    assert.ok(text.indexOf(REPORTS.EGLL!) < text.indexOf(REPORTS.KBOS!) && text.indexOf(REPORTS.KBOS!) < text.indexOf(REPORTS.KJFK!));
    assert.deepEqual(d.metar.calls, ['EGLL', 'KBOS', 'KJFK']);
  });

  it('says so for an airport VATSIM has no report for', async () => {
    const text = answer(await search('ZZZZ'));
    assert.match(text, /ZZZZ no METAR available/);
    assert.match(text, /Small airfields often have no weather station/);
  });

  it('looks up the first five and says so', async () => {
    const text = answer(await search('KJFK EGLL KBOS KMIA SKBO EGKK'));
    assert.equal(MAX_SEARCH_AIRPORTS, 5);
    assert.equal(d.metar.calls.length, 5);
    assert.match(text, /I looked up the first 5\. Search again for the rest\./);
  });

  it('skips what is not a four-letter code, and explains when nothing was usable', async () => {
    assert.match(answer(await search('KJFK JFK')), /I skipped `JFK`: not four-letter airport codes\./);
    await assert.rejects(search('JFK'), (e: unknown) => e instanceof UserError && /need the four-letter ICAO code.*US airports start with a K/.test(e.message) && /`JFK`/.test(e.message));
    await assert.rejects(search('   '), /four-letter ICAO code/);
    await assert.rejects(search('<@123> **x**'), (e: unknown) => e instanceof UserError && !e.message.includes('@everyone'));
  });

  it('tells the person plainly when VATSIM cannot be reached', async () => {
    d.metar.error = new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
    await assert.rejects(search('KJFK'), /couldn't reach VATSIM/);
  });

  it('shows a report it could not read as such, and still answers the others', async () => {
    d.metar.errors.set('KMIA', new MetarError('bad-response', 'VATSIM sent a weather report I could not read.'));
    const text = answer(await search('KMIA KJFK'));
    assert.match(text, /KMIA report could not be read/);
    assert.ok(text.includes(REPORTS.KJFK!));
  });

  it('keeps one person from asking again within a few seconds, and lets them after that', async () => {
    const user = person();
    await search('KJFK', user);
    await assert.rejects(search('EGLL', user), /One moment, then search again/);
    assert.deepEqual(d.metar.calls, ['KJFK'], 'VATSIM was not asked for the second');
    h.clock.advance(SEARCH_COOLDOWN_MS);
    assert.ok(answer(await search('EGLL', user)).includes(REPORTS.EGLL!));
    assert.ok(answer(await search('EGKK')).includes(REPORTS.EGKK!), 'someone else is not held up');
  });

  it('goes through the router like the other buttons, and shows a refusal as a message', async () => {
    const client = new EventEmitter();
    registerInteractionRouter(client as never, d.ctx);
    const f = fakeModal(person(), 'weather:searchgo', { codes: 'KJFK' });
    client.emit('interactionCreate', f.i);
    await settle();
    assert.ok(String(f.calls.edits.at(-1).content).includes(REPORTS.KJFK!));

    const g = fakeModal(person(), 'weather:searchgo', { codes: 'no' });
    client.emit('interactionCreate', g.i);
    await settle();
    assert.match(String(g.calls.edits.at(-1).content), /^⚠️ I couldn't use `no` as an airport code/);
  });

  it('says a button from an older version is out of date, rather than failing', async () => {
    await assert.rejects(weatherHandler.handle(d.ctx, fakeComponent(person(), 'weather:gone').i), /out of date/);
  });
});

/* ------------------------------------------------------------------ /setup weather */

describe('/setup weather', () => {
  let h: Harness;
  let d: DiscordHarness;
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const guildFake = (hasPerms = true) => ({
    channels: { fetch: async (id: string) => ({ id, permissionsFor: () => ({ has: () => hasPerms }) }) },
    members: { me: {}, fetchMe: async () => ({}) },
  });

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    for (const [code, report] of Object.entries(REPORTS)) d.metar.known.set(code, report);
  });
  afterEach(async () => {
    await settle(20);
    await h.close();
  });

  const run = async (options: Record<string, unknown> = {}, o: { admin?: boolean; guild?: unknown } = {}) => {
    const f = fakeInteraction({ sub: 'weather', admin: o.admin ?? true, guild: o.guild ?? guildFake(), options });
    await setup.execute(d.ctx, f.i);
    return f.calls;
  };
  const text = (calls: { edits: any[] }) => String(calls.edits.at(-1)?.content ?? '');
  const live = (channel = WX) => d.client.channel(channel).live;

  it('is for admins only, and changes nothing otherwise', async () => {
    await assert.rejects(run({ mode: 'on', channel: { id: WX } }, { admin: false }), /Manage Server/);
    assert.equal(h.store.getWeatherBoard(GUILD), null);
  });

  it('starts off, and says how to turn it on and what is shown at the top', async () => {
    assert.match(text(await run()), /weather board is \*\*off\*\*.*\/setup weather mode:on channel:.*KBOS KMIA SKBO EGLL/);
  });

  it('turns on with a channel: posts the board and says what it shows and how often it updates', async () => {
    const calls = await run({ mode: 'on', channel: { id: WX } });
    assert.match(text(calls), new RegExp(`weather board is in <#${WX}>. At the top: \\*\\*KBOS KMIA SKBO EGLL \\(the built-in list\\)\\*\\*`));
    assert.match(text(calls), /next 24 hours.*every 10 minutes.*Search airport/);
    assert.match(text(calls), /not for real-world flying/);
    assert.equal(h.store.getWeatherBoard(GUILD)!.channelId, WX);
    assert.equal(live().length, 1);
    assert.ok(String(live()[0]!.payload.content).includes(REPORTS.KBOS!));
  });

  it('a channel alone is enough to turn it on', async () => {
    await run({ channel: { id: WX } });
    assert.equal(live().length, 1);
  });

  it('needs a channel the first time, also when only airports are given', async () => {
    await assert.rejects(run({ mode: 'on' }), /Choose the channel/);
    await assert.rejects(run({ airports: 'EGLL' }), /Choose the channel/);
    assert.equal(h.store.getWeatherBoard(GUILD), null);
  });

  it('refuses a channel the bot cannot write to, and stores nothing', async () => {
    await assert.rejects(run({ mode: 'on', channel: { id: WX } }, { guild: guildFake(false) }), /missing permissions/);
    assert.equal(h.store.getWeatherBoard(GUILD), null);
  });

  it('takes the airports for the top: four-letter codes in any case, which are then the ones shown', async () => {
    const calls = await run({ mode: 'on', channel: { id: WX }, airports: 'egkk, kjfk' });
    assert.deepEqual(h.store.getWeatherBoard(GUILD)!.airports, ['EGKK', 'KJFK']);
    assert.match(text(calls), /At the top: \*\*EGKK KJFK\*\*/);
    assert.ok(String(live()[0]!.payload.content).includes(REPORTS.EGKK!));
    assert.ok(!String(live()[0]!.payload.content).includes(REPORTS.KBOS!));
  });

  it('refuses codes that are not four letters, and more than eight, and stores nothing', async () => {
    await assert.rejects(run({ mode: 'on', channel: { id: WX }, airports: 'KBOS JFK' }), (e: unknown) => e instanceof UserError && /couldn't use `JFK`/.test(e.message));
    await assert.rejects(run({ mode: 'on', channel: { id: WX }, airports: 'KAAA KAAB KAAC KAAD KAAE KAAF KAAG KAAH KAAI' }), /9 airports\. Up to 8/);
    assert.equal(MAX_TOP_AIRPORTS, 8);
    assert.equal(h.store.getWeatherBoard(GUILD), null);
  });

  it('changes the airports of a board that is already on, and redraws it', async () => {
    await run({ mode: 'on', channel: { id: WX } });
    const calls = await run({ airports: 'LFPG' });
    assert.match(text(calls), /At the top: \*\*LFPG\*\*/);
    assert.equal(live().length, 1, 'still one board');
    assert.ok(!String(live()[0]!.payload.content).includes(REPORTS.KBOS!));
    assert.equal(live()[0]!.edits.length, 1, 'edited in place');
  });

  it('"default" goes back to the built-in list', async () => {
    await run({ mode: 'on', channel: { id: WX }, airports: 'LFPG' });
    const calls = await run({ airports: 'Default' });
    assert.deepEqual(h.store.getWeatherBoard(GUILD)!.airports, []);
    assert.match(text(calls), /KBOS KMIA SKBO EGLL \(the built-in list\)/);
  });

  it('keeps the board and tries again later when VATSIM cannot be reached, saying so', async () => {
    d.metar.error = new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
    const calls = await run({ mode: 'on', channel: { id: WX } });
    assert.match(text(calls), /couldn't get the weather from VATSIM.*I try again every 10 minutes/);
    assert.ok(h.store.getWeatherBoard(GUILD), 'still switched on');
    assert.equal(live().length, 0);
  });

  it('moving it to another channel removes the old messages and keeps the airports', async () => {
    await run({ mode: 'on', channel: { id: WX }, airports: 'EGKK' });
    const old = live()[0]!;
    await run({ channel: { id: OTHER_CHANNEL } });
    assert.equal(old.deleted, true);
    assert.equal(live(OTHER_CHANNEL).length, 1);
    assert.deepEqual([h.store.getWeatherBoard(GUILD)!.channelId, h.store.getWeatherBoard(GUILD)!.airports], [OTHER_CHANNEL, ['EGKK']]);
  });

  it('running it again in the same channel does not duplicate the board', async () => {
    await run({ mode: 'on', channel: { id: WX } });
    await run({ mode: 'on', channel: { id: WX } });
    assert.equal(live().length, 1);
  });

  it('says how it stands when given nothing to change', async () => {
    await run({ mode: 'on', channel: { id: WX }, airports: 'EGKK' });
    assert.match(text(await run()), new RegExp(`weather board is \\*\\*on\\*\\* in <#${WX}>, last checked <t:\\d+:R>. At the top: \\*\\*EGKK\\*\\*. It is redrawn every 10 minutes`));
    d.metar.error = new MetarError('unavailable', "VATSIM's weather service is busy right now. Try again in a minute.");
    h.clock.advance(HOUR);
    await d.weather.refresh(GUILD);
    assert.match(text(await run()), /last try failed: VATSIM's weather service is busy/);
  });

  it('turns off: removes the messages and forgets the board', async () => {
    await run({ mode: 'on', channel: { id: WX } });
    const msg = live()[0]!;
    assert.match(text(await run({ mode: 'off' })), /Removed the weather board/);
    assert.equal(msg.deleted, true);
    assert.equal(h.store.getWeatherBoard(GUILD), null);
    assert.match(text(await run({ mode: 'off' })), /already off/);
  });

  it('is part of the /setup command, inside Discord\'s limits, and /setup still has room for more', () => {
    const json = setup.data.toJSON() as { options: Array<{ name: string; description: string; options?: Array<{ name: string; description: string; choices?: unknown[]; max_length?: number }> }> };
    const sub = json.options.find((o) => o.name === 'weather')!;
    assert.ok(sub.description.length <= 100);
    assert.deepEqual(sub.options!.map((o) => o.name).sort(), ['airports', 'channel', 'mode']);
    assert.ok(sub.options!.every((o) => o.description.length <= 100));
    assert.equal(sub.options!.find((o) => o.name === 'mode')!.choices!.length, 2);
    assert.ok(json.options.length <= 25, `${json.options.length} subcommands`);
    // Discord adds up every name, description and choice of a command, subcommands included, and refuses one over 8000 characters.
    const size = (o: any): number =>
      (o.name?.length ?? 0) + (o.description?.length ?? 0) + (o.choices ?? []).reduce((n: number, c: any) => n + String(c.name).length + (typeof c.value === 'string' ? c.value.length : 0), 0) + (o.options ?? []).reduce((n: number, x: any) => n + size(x), 0);
    assert.ok(size(json) < 8000, `the command is ${size(json)} characters by Discord's count`);
  });
});

/* ------------------------------------------------------------------ storing the board */

describe('storing the weather board', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => h.close());

  it('has one board per server; moving it forgets the old messages and history but keeps the airports', () => {
    const a = h.store.setWeatherBoard('g1', 'c1', 10);
    assert.deepEqual(a.airports, []);
    h.store.updateWeatherBoard('g1', { messageIds: ['m1', 'm2'], airports: ['EGKK', 'KJFK'], lastAttemptAt: 20, lastOkAt: 20, lastError: 'old' });
    assert.deepEqual(h.store.getWeatherBoard('g1')!.messageIds, ['m1', 'm2']);
    assert.equal(h.store.setWeatherBoard('g1', 'c1', 99).createdAt, a.createdAt, 'the same channel changes nothing');
    const moved = h.store.setWeatherBoard('g1', 'c2', 30);
    assert.deepEqual([moved.channelId, moved.messageIds, moved.airports, moved.lastAttemptAt, moved.lastOkAt, moved.lastError], ['c2', [], ['EGKK', 'KJFK'], null, null, null]);
    assert.equal(h.store.listWeatherBoards().length, 1);
  });

  it('lists every server\'s board, deletes one, and keeps apart from the market board', () => {
    h.store.setWeatherBoard('g1', 'c1', 10);
    h.store.setWeatherBoard('g2', 'c2', 5);
    h.store.setMarketBoard('g1', 'cm', 1);
    assert.deepEqual(h.store.listWeatherBoards().map((b) => b.guildId), ['g2', 'g1']);
    assert.equal(h.store.deleteWeatherBoard('g1'), true);
    assert.equal(h.store.deleteWeatherBoard('g1'), false);
    assert.equal(h.store.getWeatherBoard('g1'), null);
    assert.equal(h.store.getMarketBoard('g1')!.channelId, 'cm');
  });

  it('can be emptied of its airports again', () => {
    h.store.setWeatherBoard('g1', 'c1', 10);
    h.store.updateWeatherBoard('g1', { airports: ['EGKK'] });
    h.store.updateWeatherBoard('g1', { airports: [] });
    assert.deepEqual(h.store.getWeatherBoard('g1')!.airports, []);
  });

  it('does not touch the flight panels in the same database', () => {
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
    h.store.setWeatherBoard(GUILD, CHANNEL, 1);
    h.store.deleteWeatherBoard(GUILD);
    assert.equal(h.jobs.open(h.panel.id).length, 1);
  });
});
