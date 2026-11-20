import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Job, JobView } from '../src/db/store.js';
import { commands, componentHandlers } from '../src/discord/commands/index.js';
import { UserError } from '../src/discord/errors.js';
import { registerInteractionRouter } from '../src/discord/router.js';
import { MAX_SEARCH_AIRPORTS, SEARCH_COOLDOWN_MS, WEATHER_REFRESH_MS, weatherHandler } from '../src/discord/weatherBoard.js';
import { metarBlocks, renderWeather, WEATHER_FOOTER, type GridAirport, type WeatherView } from '../src/discord/weatherUi.js';
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

/** The buttons of a message, as Discord is sent them. */
const buttonsOf = (components: Array<{ toJSON(): any }>): any[] => components.flatMap((r) => r.toJSON().components as any[]);
/** The airport buttons of a message (not the Search button), as `[code, dot]`. */
const airportsOn = (components: Array<{ toJSON(): any }>): Array<[string, string]> =>
  buttonsOf(components)
    .filter((b) => String(b.custom_id).startsWith('weather:metar:'))
    .map((b) => [String(b.label), String(b.emoji?.name)]);
const codesOn = (components: Array<{ toJSON(): any }>): string[] => airportsOn(components).map(([c]) => c);
/** Everything a message's cards say, as one piece of text. */
const embedsText = (embeds: Array<{ toJSON(): any }>): string =>
  embeds
    .map((e) => {
      const j = e.toJSON();
      return [j.title, j.description, j.footer?.text].filter(Boolean).join('\n');
    })
    .join('\n');

describe('the weather board layout', () => {
  const ap = (code: string, category: GridAirport['category'] = null): GridAirport => ({ code, category });
  const base = (over: Partial<WeatherView> = {}): WeatherView => ({
    now: T0,
    monitored: DEFAULT_WEATHER_AIRPORTS.map((c) => ap(c)),
    ofFlights: [],
    moreAirports: 0,
    skipped: [],
    everyMinutes: 10,
    ...over,
  });
  const many = (n: number, from = 0): GridAirport[] => Array.from({ length: n }, (_, i) => ap(`K${String.fromCharCode(65 + ((from + i) % 26))}${String(from + i).padStart(2, '0')}`));

  it('is a grid of buttons that say only the airport\'s code, with a header and the Search button, and writes no report out', () => {
    const [m, ...rest] = renderWeather(base());
    assert.equal(rest.length, 0);
    assert.deepEqual(codesOn(m!.components), ['KBOS', 'KMIA', 'SKBO', 'EGLL'], 'the airports followed, in the order given');
    assert.deepEqual(buttonsOf(m!.components).slice(0, 4).map((b) => b.custom_id), ['weather:metar:KBOS', 'weather:metar:KMIA', 'weather:metar:SKBO', 'weather:metar:EGLL']);
    assert.deepEqual(m!.components.map((r) => r.toJSON().components.length), [4, 1], 'a row of airports, then the Search button on its own');
    const search = buttonsOf(m!.components).at(-1);
    assert.deepEqual([search.custom_id, search.label], ['weather:search', 'Search airport']);
    const text = embedsText(m!.embeds);
    assert.match(text, /^🌦️ Weather · METARs from VATSIM\nPress an airport to see its METAR, or \*\*Search airport\*\* for any other\.\n\*\*Key:\*\* 🟢 VFR · 🔵 MVFR · 🔴 IFR · 🟣 LIFR \(US-style flying conditions\) · ⚪ no report\nChecked <t:\d+:R> · redrawn every 10 minutes\n\*\*Airports followed\*\* \(4\)/);
    assert.ok(text.endsWith(WEATHER_FOOTER), 'the disclaimer closes the board');
    assert.doesNotMatch(text, /\d{6}Z|\d{3}\d{2}KT|Q\d{4}|A\d{4}/, 'no METAR in the channel');
  });

  it('shows how each airport rates by the dot on its button, and a grey one when there is no report', () => {
    const [m] = renderWeather(base({ monitored: [ap('KAAA', 'VFR'), ap('KBBB', 'MVFR'), ap('KCCC', 'IFR'), ap('KDDD', 'LIFR'), ap('KEEE', null)] }));
    assert.deepEqual(airportsOn(m!.components), [['KAAA', '🟢'], ['KBBB', '🔵'], ['KCCC', '🔴'], ['KDDD', '🟣'], ['KEEE', '⚪']]);
    assert.ok(buttonsOf(m!.components).filter((b) => String(b.custom_id).startsWith('weather:metar:')).every((b) => b.style === 2), 'grey buttons, like the reserve panel\'s grid');
  });

  it('puts the airports of the flights in messages of their own, twenty-five to a message, five to a row', () => {
    const messages = renderWeather(base({ ofFlights: many(30) }));
    assert.equal(messages.length, 3);
    assert.deepEqual(codesOn(messages[1]!.components).length, 25);
    assert.deepEqual(messages[1]!.components.map((r) => r.toJSON().components.length), [5, 5, 5, 5, 5]);
    assert.deepEqual(messages[2]!.components.map((r) => r.toJSON().components.length), [5]);
    assert.match(embedsText(messages[1]!.embeds), /^\*\*Airports of the flights in the next 24 hours\*\* \(30\)$/);
    assert.match(embedsText(messages[2]!.embeds), /^\*\*…continued\*\* \(26–30\)\n/);
    assert.ok(embedsText(messages[2]!.embeds).endsWith(WEATHER_FOOTER), 'the disclaimer is on the last message');
    assert.ok(!embedsText(messages[1]!.embeds).includes(WEATHER_FOOTER) && !embedsText(messages[0]!.embeds).includes(WEATHER_FOOTER));
  });

  it('has only the one message when no flight needs another airport, and says nothing about flights then', () => {
    const messages = renderWeather(base());
    assert.equal(messages.length, 1);
    assert.doesNotMatch(embedsText(messages[0]!.embeds), /next 24 hours/);
  });

  it('says how many more airports there were than are shown, and which codes it did not ask about', () => {
    const messages = renderWeather(base({ ofFlights: many(3), moreAirports: 4, skipped: ['JFK', 'LHR'] }));
    const text = embedsText(messages[1]!.embeds);
    assert.match(text, /\(7\)/);
    assert.match(text, /…and 4 more airports not shown\./);
    assert.match(text, /No report asked for `JFK`, `LHR`: not four-letter airport codes\./);
    assert.match(embedsText(renderWeather(base({ ofFlights: many(1), moreAirports: 1 }))[1]!.embeds), /…and 1 more airport not shown\./);
  });

  it('stays inside what Discord allows: five rows of five, a header that fits, the airport code as the whole label', () => {
    const messages = renderWeather(base({ monitored: many(8), ofFlights: many(40, 8) }));
    for (const m of messages) {
      assert.ok(m.components.length <= 5, `${m.components.length} rows`);
      for (const r of m.components) assert.ok(r.toJSON().components.length <= 5);
      assert.ok(buttonsOf(m.components).length <= 25);
      assert.ok(embedsText(m.embeds).length < 4000);
    }
    assert.equal(messages[0]!.components.length, 3, 'eight airports make two rows, and the Search button a third');
    for (const b of buttonsOf(messages.flatMap((m) => m.components)).filter((x) => String(x.custom_id).startsWith('weather:metar:'))) assert.match(String(b.label), /^[A-Z0-9]{4}$/);
  });

  it('keeps nothing in a METAR able to end its block, start a mention or break a line (what a search shows)', () => {
    const blocks = metarBlocks(['KBOS 111154Z ``` @everyone <@123>\nRMK AO2']);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.split('```').length, 3, 'only the two fences are fences');
    assert.equal(blocks[0]!.split('\n').length, 3, 'one line of text between them');
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
  const everything = () => live().map((m) => embedsText(m.payload.embeds)).join('\n');
  const flight = (key: string, chain: string, fromH: number, toH: number) => sj(key, chain, { availableFrom: T0 + fromH * HOUR, deadline: T0 + toH * HOUR });
  const dots = () => new Map(live().flatMap((m) => airportsOn(m.payload.components)));

  it('posts the four airports as a grid of buttons, with the Search button, no report written out and no pings', async () => {
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    const message = live()[0]!;
    assert.deepEqual(codesOn(message.payload.components), ['KBOS', 'KMIA', 'SKBO', 'EGLL']);
    assert.equal(message.payload.content, '', 'no text in the message itself');
    assert.doesNotMatch(everything(), /\d{6}Z/, 'no METAR is written in the channel');
    assert.deepEqual(d.metar.calls.sort(), ['EGLL', 'KBOS', 'KMIA', 'SKBO'], 'only those four are asked for');
    assert.equal(buttonsOf(message.payload.components).at(-1).custom_id, 'weather:search');
    assert.deepEqual(message.payload.allowedMentions, { parse: [] });
    assert.deepEqual(board().messageIds, [message.id]);
    assert.deepEqual([board().lastOkAt, board().lastError], [h.clock.now, null]);
  });

  it('marks each airport with the rating of its report: green for fine weather here', async () => {
    await d.weather.refresh(GUILD);
    assert.deepEqual([...dots()], [['KBOS', '🟢'], ['KMIA', '🟢'], ['SKBO', '🟢'], ['EGLL', '🟢']]);
  });

  it('asks VATSIM for reports a little younger than its own redraws, so it never reuses its previous answer', async () => {
    await d.weather.refresh(GUILD);
    assert.ok(d.metar.maxAges.length > 0 && d.metar.maxAges.every((a) => a !== undefined && a < WEATHER_REFRESH_MS));
  });

  it('adds the airports of the flights in the next 24 hours, each once, in order of code, and none for flights outside them', async () => {
    h.jobs.sync(h.panel.id, [
      flight('soon', 'KJFK-KBOS', 2, 6),
      flight('open', 'EGKK-EGLL', -3, 3),
      flight('again', 'KJFK-EGKK', 8, 12),
      flight('tomorrow', 'LFPG-LFMN', 30, 36),
      flight('over', 'EDDF-EHAM', -9, -1),
    ]);
    await d.weather.refresh(GUILD);
    assert.deepEqual([...new Set(d.metar.calls)].sort(), ['EGKK', 'EGLL', 'KBOS', 'KJFK', 'KMIA', 'SKBO'], 'no report for the flights outside the 24 hours');
    assert.equal(live().length, 2);
    assert.deepEqual(codesOn(live()[1]!.payload.components), ['EGKK', 'KJFK'], 'each once, though two flights use KJFK; the airports followed are not repeated');
    assert.match(embedsText(live()[1]!.payload.embeds), /^\*\*Airports of the flights in the next 24 hours\*\* \(2\)/);
  });

  it('lists no flights: the flights themselves are not written in the channel', async () => {
    h.jobs.sync(h.panel.id, [flight('soon', 'KJFK-KBOS', 2, 6), flight('open', 'EGKK-EGLL', -3, 3)]);
    await d.weather.refresh(GUILD);
    const t = everything();
    assert.doesNotMatch(t, /Flights in the next 24 hours|→|TST-\d+|Nov 1[0-9]/);
  });

  it('asks VATSIM for the whole board in ONE request, however many airports the flights use (many requests at once got a server rate-limited)', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 30]}`, 1, 5)));
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(d.metar.batches.length, 1, 'one request');
    assert.equal(d.metar.batches[0]!.length, 4 + 30, 'for the four followed and every airport of the flights');
    assert.equal(live().length, 3, 'the four, then the thirty in two messages');
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

  it('shows the airports of the flights of every panel in the server, and none of another server\'s', async () => {
    const second = h.store.createPanel({ guildId: GUILD, name: 'Second Air', abbr: 'SEC', prefix: 'SEC', channelId: '700000000000000099', now: T0 });
    const foreign = h.store.createPanel({ guildId: 'another-server', name: 'Far Air', abbr: 'FAR', prefix: 'FAR', channelId: '700000000000000098', now: T0 });
    h.jobs.sync(h.panel.id, [flight('a', 'KJFK-KBOS', 1, 5)]);
    h.jobs.sync(second.id, [flight('b', 'EGKK-EGLL', 1, 5)]);
    h.jobs.sync(foreign.id, [flight('c', 'LFPG-LFMN', 1, 5)]);
    await d.weather.refresh(GUILD);
    assert.deepEqual(codesOn(live()[1]!.payload.components), ['EGKK', 'KJFK']);
    assert.ok(!d.metar.calls.includes('LFPG'));
  });

  it('uses the board\'s own airports when it has some', async () => {
    h.store.updateWeatherBoard(GUILD, { airports: ['EGKK', 'KJFK'] });
    await d.weather.refresh(GUILD);
    assert.deepEqual(d.metar.calls.sort(), ['EGKK', 'KJFK']);
    assert.deepEqual(codesOn(live()[0]!.payload.components), ['EGKK', 'KJFK']);
  });

  it('shows a grey button for an airport VATSIM has no report for, and for one whose report could not be read', async () => {
    d.metar.known.delete('SKBO');
    d.metar.errors.set('EGLL', new MetarError('bad-response', 'VATSIM sent a weather report I could not read.'));
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.deepEqual([...dots()], [['KBOS', '🟢'], ['KMIA', '🟢'], ['SKBO', '⚪'], ['EGLL', '⚪']]);
  });

  it('rates an airport by its report: bad weather is red', async () => {
    d.metar.known.set('KMIA', 'KMIA 111153Z 09008KT 2SM BR OVC006 24/23 A2995');
    d.metar.known.set('KBOS', 'KBOS 111154Z 27012KT 4SM BKN020 12/03 A3012');
    d.metar.known.set('EGLL', 'EGLL 111150Z 26008KT 0400 FG VV001 08/08 Q1006');
    await d.weather.refresh(GUILD);
    assert.deepEqual([...dots()], [['KBOS', '🔵'], ['KMIA', '🔴'], ['SKBO', '🟢'], ['EGLL', '🟣']]);
  });

  it('does not ask for a code that is not four letters, and says so with the flights\' airports', async () => {
    h.jobs.sync(h.panel.id, [flight('x', 'JFK-EGKK', 1, 5)]);
    await d.weather.refresh(GUILD);
    assert.ok(!d.metar.calls.includes('JFK'));
    assert.match(embedsText(live()[1]!.payload.embeds), /No report asked for `JFK`: not four-letter airport codes\./);
    assert.deepEqual(codesOn(live()[1]!.payload.components), ['EGKK']);
  });

  it('edits the messages in place, and only those whose airports or ratings changed', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 50]}`, 1, 5)));
    await d.weather.refresh(GUILD);
    assert.ok(live().length >= 3, `${live().length} messages`);
    const ids = live().map((m) => m.id);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.deepEqual(live().map((m) => m.id), ids, 'the same messages');
    assert.equal(live()[0]!.edits.length, 1, 'the first says when it was checked, so it changes');
    for (const m of live().slice(1)) assert.equal(m.edits.length, 0, 'the rest look the same, so they are not touched');
    assert.equal(live().filter((m) => buttonsOf(m.payload.components).some((b) => b.custom_id === 'weather:search')).length, 1, 'one Search button, on the first');
  });

  it('shows a changed rating when VATSIM\'s report changes, and touches only the message it is on', async () => {
    const codes = Array.from({ length: 30 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 30]}`, 1, 5)));
    await d.weather.refresh(GUILD);
    assert.equal(dots().get('KBOS'), '🟢');
    d.metar.known.set('KBOS', 'KBOS 111254Z 28015KT 2SM BR OVC006 11/10 A3010');
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.equal(dots().get('KBOS'), '🔴');
    assert.deepEqual(live().map((m) => m.edits.length), [1, 0, 0], 'the first, which has KBOS and the time it was checked');
  });

  it('posts the board again when it needs a different number of messages', async () => {
    const codes = Array.from({ length: 50 }, (_, i) => `K${String.fromCharCode(65 + (i % 26))}${String(i).padStart(2, '0')}`);
    h.jobs.sync(h.panel.id, codes.map((c, i) => flight(`j${i}`, `${c}-${codes[(i + 1) % 50]}`, 1, 5)));
    await d.weather.refresh(GUILD);
    assert.ok(live().length >= 3);
    h.jobs.sync(h.panel.id, []);
    h.clock.advance(WEATHER_REFRESH_MS);
    assert.equal(await d.weather.refresh(GUILD), 'posted');
    assert.equal(live().length, 1);
    assert.deepEqual(board().messageIds, [live()[0]!.id], 'and the old ones are gone');
  });

  it('rewrites a board drawn by the first version, which had the reports written in its message, without that text', async () => {
    const old = await d.client.channel(WX).send({ content: 'KBOS 111154Z 27012KT 10SM FEW250 12/03 A3012\nEGLL 111150Z AUTO 26008KT 9999 NCD 08/01 Q1006', embeds: [], components: [] });
    h.store.updateWeatherBoard(GUILD, { messageIds: [old.id] });
    assert.equal(await d.weather.refresh(GUILD), 'updated');
    assert.equal(old.payload.content, '', 'the old text is gone');
    assert.deepEqual(codesOn(old.payload.components), ['KBOS', 'KMIA', 'SKBO', 'EGLL']);
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
      assert.equal(d.metar.batches.length, 1, 'one try');
      h.clock.advance(WEATHER_REFRESH_MS);
      await d.weather.run();
      assert.equal(d.metar.batches.length, 2);
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

/* ------------------------------------------------------------------ pressing an airport */

describe('pressing an airport on the board', () => {
  let h: Harness;
  let d: DiscordHarness;
  let counter = 0;
  const person = () => new FakeUser(`7${String(++counter).padStart(17, '0')}`, `pilot${counter}`);
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
  const press = async (code: string) => {
    const f = fakeComponent(person(), `weather:metar:${code}`);
    await weatherHandler.handle(d.ctx, f.i);
    return f.calls;
  };
  const card = (calls: { edits: any[] }) => calls.edits.at(-1)?.embeds?.[0]?.toJSON() as { title?: string; description?: string; fields?: Array<{ name: string; value: string }>; footer?: { text: string } };

  it('shows the full METAR to that person only: the report in plain language, and as written at the bottom', async () => {
    const calls = await press('KJFK');
    assert.equal(calls.defers[0].flags, 64, 'only they see it');
    const c = card(calls);
    assert.equal(c.title, '🌦️ Weather at KJFK');
    assert.match(c.description!, /In short:/);
    assert.ok(c.fields!.some((f) => f.name === 'Wind'), 'the decoded parts');
    assert.ok(c.fields!.some((f) => f.name === 'The report as written' && f.value.includes(REPORTS.KJFK!)), 'the report as written');
    assert.match(c.footer!.text, /for flight simulation only/);
    assert.deepEqual(calls.edits.at(-1).allowedMentions, { parse: [] });
    assert.deepEqual(d.metar.calls, ['KJFK']);
  });

  it('says plainly when VATSIM has no report for the airport', async () => {
    const calls = await press('ZZZZ');
    assert.match(String(calls.edits.at(-1).content), /^VATSIM has no weather report for \*\*ZZZZ\*\* right now\. Small airfields often have no weather station\.$/);
    assert.equal(calls.edits.at(-1).embeds, undefined);
  });

  it('says so when the report cannot be read, and shows it as sent', async () => {
    d.metar.known.set('KBAD', 'KBAD NIL junk');
    const calls = await press('KBAD');
    assert.match(String(calls.edits.at(-1).content), /I couldn't read the report for \*\*KBAD\*\*: `KBAD NIL junk`/);
  });

  it('shows the last report it had, and says so, when VATSIM cannot be reached; and the plain reason when it never had one', async () => {
    h.jobs.sync(h.panel.id, []);
    await d.weather.refresh(GUILD);
    assert.equal(d.weather.lastKnown('KBOS')?.line, REPORTS.KBOS, 'the board remembers what it drew');
    d.metar.error = new MetarError('unavailable', "VATSIM's weather service is busy right now. Try again in about 3 minutes.", 161_000);
    const calls = await press('KBOS');
    assert.match(String(calls.edits.at(-1).content), /^⚠️ VATSIM's weather service is busy right now\. Try again in about 3 minutes\. This is the last report I had for \*\*KBOS\*\*, from <t:\d+:R>:$/);
    assert.ok(card(calls).fields!.some((f) => f.value.includes(REPORTS.KBOS!)));
    await assert.rejects(press('EGKK'), /busy right now\. Try again in about 3 minutes\./);
  });

  it('remembers a report it showed, to fall back on', async () => {
    assert.equal(d.weather.lastKnown('KJFK'), null);
    await press('KJFK');
    assert.equal(d.weather.lastKnown('KJFK')?.line, REPORTS.KJFK);
  });

  it('says a report VATSIM sent that cannot be used is that, rather than failing', async () => {
    d.metar.errors.set('KJFK', new MetarError('bad-response', 'VATSIM sent a weather report I could not read.'));
    await assert.rejects(press('KJFK'), /VATSIM sent a report for \*\*KJFK\*\* that I couldn't read/);
  });

  it('refuses a button whose code is not an airport, as out of date', async () => {
    for (const bad of ['xx', 'KJ', '../x', '']) await assert.rejects(weatherHandler.handle(d.ctx, fakeComponent(person(), `weather:metar:${bad}`).i), /out of date/, bad);
    assert.deepEqual(d.metar.calls, []);
  });

  it('goes through the router like the other buttons', async () => {
    const client = new EventEmitter();
    registerInteractionRouter(client as never, d.ctx);
    const f = fakeComponent(person(), 'weather:metar:EGLL');
    client.emit('interactionCreate', f.i);
    await settle();
    assert.ok(card(f.calls).fields!.some((x) => x.value.includes(REPORTS.EGLL!)));
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

  it('starts off, and says how to turn it on and which airports it follows', async () => {
    assert.match(text(await run()), /weather board is \*\*off\*\*.*\/setup weather mode:on channel:.*KBOS KMIA SKBO EGLL/);
  });

  it('turns on with a channel: posts the board and says what it shows and how often it updates', async () => {
    const calls = await run({ mode: 'on', channel: { id: WX } });
    assert.match(text(calls), new RegExp(`weather board is in <#${WX}>, a grid of buttons with one for each airport\\. Airports followed: \\*\\*KBOS KMIA SKBO EGLL \\(the built-in list\\)\\*\\*`));
    assert.match(text(calls), /next 24 hours.*Pressing an airport shows its METAR to that person only.*Search airport.*every 10 minutes/);
    assert.match(text(calls), /not for real-world flying/);
    assert.equal(h.store.getWeatherBoard(GUILD)!.channelId, WX);
    assert.equal(live().length, 1);
    assert.deepEqual(codesOn(live()[0]!.payload.components), ['KBOS', 'KMIA', 'SKBO', 'EGLL']);
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

  it('takes the airports to follow: four-letter codes in any case, which are then the ones shown', async () => {
    const calls = await run({ mode: 'on', channel: { id: WX }, airports: 'egkk, kjfk' });
    assert.deepEqual(h.store.getWeatherBoard(GUILD)!.airports, ['EGKK', 'KJFK']);
    assert.match(text(calls), /Airports followed: \*\*EGKK KJFK\*\*/);
    assert.deepEqual(codesOn(live()[0]!.payload.components), ['EGKK', 'KJFK']);
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
    assert.match(text(calls), /Airports followed: \*\*LFPG\*\*/);
    assert.equal(live().length, 1, 'still one board');
    assert.deepEqual(codesOn(live()[0]!.payload.components), ['LFPG']);
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
    assert.match(text(await run()), new RegExp(`weather board is \\*\\*on\\*\\* in <#${WX}>, last checked <t:\\d+:R>. Airports followed: \\*\\*EGKK\\*\\*. It is redrawn every 10 minutes`));
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
