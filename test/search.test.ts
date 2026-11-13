import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers, commands } from '../src/discord/commands/index.js';
import { registerInteractionRouter } from '../src/discord/router.js';
import { searchEmbeds } from '../src/discord/ui.js';
import { flyableOn, matchesAircraft, matchesSearch, MAX_SEARCH_RESULTS, parseAircraftTypes, parseAirportCodes, parseSearchDate } from '../src/services/search.js';
import { CHANNEL, HOUR, T0, USER_A, USER_B, makeHarness, sj, type Harness } from './helpers.js';
import { FakeUser, fakeComponent, fakeInteraction, fakeModal, makeDiscordHarness, embedText, messageText, settle, type DiscordHarness } from './discord-helpers.js';

const DAY = 24 * HOUR;

describe('reading airport codes from a search box', () => {
  it('takes one or several, in any case, separated by spaces, commas or slashes', () => {
    assert.deepEqual(parseAirportCodes('EGLL').codes, ['EGLL']);
    assert.deepEqual(parseAirportCodes(' egll, EGKK  lfmn/lfpg ').codes, ['EGLL', 'EGKK', 'LFMN', 'LFPG']);
  });

  it('accepts two or three letters as the start of a code, and nothing shorter or longer', () => {
    assert.deepEqual(parseAirportCodes('EG LFP K').codes, ['EG', 'LFP']);
    assert.deepEqual(parseAirportCodes('K').ignored, ['K']);
    assert.deepEqual(parseAirportCodes('EGLLX').ignored, ['EGLLX']);
  });

  it('skips the words people put between airports, and repeats', () => {
    assert.deepEqual(parseAirportCodes('EGLL to EGKK and EGLL or EGCC').codes, ['EGLL', 'EGKK', 'EGCC']);
  });

  it('reports what it could not use, and copes with nothing at all', () => {
    const r = parseAirportCodes('EGLL **bold** <@123> ??');
    assert.deepEqual(r.codes, ['EGLL']);
    assert.deepEqual(r.ignored, ['**BOLD**', '<@123>', '??']);
    assert.deepEqual(parseAirportCodes('').codes, []);
    assert.deepEqual(parseAirportCodes(null).codes, []);
    assert.deepEqual(parseAirportCodes(undefined).ignored, []);
  });

  it('keeps no more than six codes', () => {
    assert.equal(parseAirportCodes('AA1 AA2 AA3 AA4 AA5 AA6 AA7 AA8').codes.length, 6);
  });
});

describe('reading a date from a search box', () => {
  // T0 is Wednesday 11 November 2026, 12:00 Zulu.
  const day = (text: string | null, now = T0) => {
    const d = parseSearchDate(text, now);
    return d ? new Date(d.start).toISOString().slice(0, 10) : null;
  };

  it('understands today, tomorrow, and weekdays (the next one, today if it is that day)', () => {
    assert.equal(day('today'), '2026-11-11');
    assert.equal(day('Tomorrow'), '2026-11-12');
    assert.equal(day('sat'), '2026-11-14');
    assert.equal(day('Saturday'), '2026-11-14');
    assert.equal(day('next saturday'), '2026-11-14');
    assert.equal(day('wed'), '2026-11-11');
    assert.equal(day('tue'), '2026-11-17');
    assert.equal(day('Thurs'), '2026-11-12');
    assert.equal(day('on friday'), '2026-11-13');
    for (const notADay of ['next month', 'month', 'saturn', 'monkey', 'sunny']) assert.equal(day(notADay), null, notADay);
  });

  it('understands the usual ways of writing a date, day first', () => {
    for (const text of ['2026-11-14', '2026/11/14', '14/11/2026', '14/11', '14-11', '14.11.26', '14 Nov', '14th November', '14 nov 2026', '14 Nov, 2026', 'Nov 14', 'november 14th', '  14   NOV  ']) {
      assert.equal(day(text), '2026-11-14', text);
    }
  });

  it('says the day in words, as Zulu time', () => {
    const d = parseSearchDate('14 nov', T0)!;
    assert.equal(d.label, 'Sat 14 Nov');
    assert.equal(d.end - d.start, 24 * HOUR);
    assert.equal(d.start, Date.UTC(2026, 10, 14));
  });

  it('takes the year that puts a date nearest to today when none is typed', () => {
    const dec = Date.UTC(2026, 11, 30, 9);
    assert.equal(day('2 Jan', dec), '2027-01-02');
    assert.equal(day('29 Dec', dec), '2026-12-29');
    const jan = Date.UTC(2026, 0, 2, 9);
    assert.equal(day('30 Dec', jan), '2025-12-30');
    assert.equal(day('3 Jan', jan), '2026-01-03');
  });

  it('refuses what is not a real date', () => {
    for (const text of ['', '   ', 'soon', '31/02', '32 Nov', '14 Foo', '2026-13-01', '0/11', '14', 'nov', 'sat 14', null, undefined]) {
      assert.equal(parseSearchDate(text as string, T0), null, String(text));
    }
    assert.equal(day('29 Feb 2028'), '2028-02-29');
    assert.equal(day('29 Feb 2027'), null, 'not a leap year');
  });

  it('counts a flight as flyable on a day when its window touches that day', () => {
    const d = parseSearchDate('14 nov', T0)!;
    const win = (availableFrom: number | null, deadline: number | null) => flyableOn({ availableFrom, deadline }, d);
    assert.equal(win(d.start - 2 * HOUR, d.start + HOUR), true, 'still open in the first hour');
    assert.equal(win(d.start - 2 * HOUR, d.start), false, 'closed as the day began');
    assert.equal(win(d.end - HOUR, d.end + 5 * HOUR), true, 'opens in the last hour');
    assert.equal(win(d.end, d.end + 5 * HOUR), false, 'opens as the day ends');
    assert.equal(win(d.start - 3 * 24 * HOUR, d.end + 3 * 24 * HOUR), true, 'open all the way through');
    assert.equal(win(null, null), true, 'a flight with no times is always open');
    assert.equal(win(null, d.start + HOUR), true);
    assert.equal(win(d.start + HOUR, null), true);
    assert.equal(win(d.end + HOUR, null), false);
  });
});

describe('reading aircraft types from a search box', () => {
  it('takes one or several, in any case, separated by spaces, commas or slashes', () => {
    assert.deepEqual(parseAircraftTypes('a320').codes, ['A320']);
    assert.deepEqual(parseAircraftTypes(' b738, A333 / b38m  a359+a20n ').codes, ['B738', 'A333', 'B38M', 'A359', 'A20N']);
  });

  it('takes two to five letters or numbers, so a few characters can start a type', () => {
    assert.deepEqual(parseAircraftTypes('B7 A32 C172').codes, ['B7', 'A32', 'C172']);
    assert.deepEqual(parseAircraftTypes('B').ignored, ['B']);
    assert.deepEqual(parseAircraftTypes('A320NEO7').ignored, ['A320NEO7']);
  });

  it('skips the words people put between types, and repeats, keeps at most six, and copes with nothing', () => {
    assert.deepEqual(parseAircraftTypes('A320 or B738 and A320 an A333').codes, ['A320', 'B738', 'A333']);
    assert.equal(parseAircraftTypes('AA1 AA2 AA3 AA4 AA5 AA6 AA7 AA8').codes.length, 6);
    assert.deepEqual(parseAircraftTypes('').codes, []);
    assert.deepEqual(parseAircraftTypes(null).codes, []);
    assert.deepEqual(parseAircraftTypes(undefined).ignored, []);
    assert.deepEqual(parseAircraftTypes('A320 **bold** <@1>').ignored, ['**BOLD**', '<@1>']);
  });
});

describe('which aircraft match', () => {
  it('matches a type that starts with one of the codes, in any case', () => {
    assert.equal(matchesAircraft('A320', ['A320']), true);
    assert.equal(matchesAircraft('a320', ['A32']), true);
    assert.equal(matchesAircraft('A20N', ['A32']), false);
    assert.equal(matchesAircraft('B738', ['A320', 'B73']), true);
    assert.equal(matchesAircraft('A320', ['A3200']), false, 'a code longer than the type finds nothing');
  });

  it('reads each word of a schedule that lists several types or names the type inside a name', () => {
    assert.equal(matchesAircraft('A320/A321', ['A321']), true);
    assert.equal(matchesAircraft('A320, A321', ['A321']), true);
    assert.equal(matchesAircraft('Airbus A320neo', ['A320']), true);
    assert.equal(matchesAircraft('Airbus A320', ['AIR']), true, 'any word, including the manufacturer');
    assert.equal(matchesAircraft('Boeing 737-800', ['B738']), false, 'a name that does not carry the code');
  });

  it('matches everything when no type is asked for, and nothing without an aircraft when one is', () => {
    assert.equal(matchesAircraft(null, []), true);
    assert.equal(matchesAircraft('A320', []), true);
    assert.equal(matchesAircraft(null, ['A320']), false);
    assert.equal(matchesAircraft('', ['A320']), false);
    assert.equal(matchesAircraft(undefined, ['A320']), false);
  });
});

describe('which flights match a search', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK'), sj('b', 'LFPG-EHAM-EDDF'), sj('c', 'KBOS-KORD'), sj('d', 'EGLC-EGPH')]);
  });
  afterEach(() => h.close());
  const view = (key: string) => h.jobs.open(h.panel.id).find((v) => v.job.sourceKey === key)!;
  const codes = (from: string[], to: string[]) => ['a', 'b', 'c', 'd'].filter((k) => matchesSearch(view(k), from, to));

  it('finds flights leaving from an airport, or arriving at one', () => {
    assert.deepEqual(codes(['EGLL'], []), ['a']);
    assert.deepEqual(codes([], ['EGKK']), ['a']);
    assert.deepEqual(codes([], ['KORD']), ['c']);
  });

  it('finds flights from one airport to another', () => {
    assert.deepEqual(codes(['EGLL'], ['EGKK']), ['a']);
    assert.deepEqual(codes(['EGKK'], ['EGLL']), [], 'the other way round is a different flight');
  });

  it('treats a short code as the start of a code, so two letters find a whole country', () => {
    assert.deepEqual(codes(['EG'], []), ['a', 'd']);
    assert.deepEqual(codes(['EG'], ['EGP']), ['d']);
  });

  it('finds a multi-leg flight that leaves from the first airport and later arrives at the second', () => {
    assert.deepEqual(codes(['LFPG'], ['EDDF']), ['b']);
    assert.deepEqual(codes(['EHAM'], ['EDDF']), ['b'], 'from a later leg is fine');
    assert.deepEqual(codes(['EDDF'], ['LFPG']), [], 'but not backwards');
  });

  it('accepts several codes for either end, and any case in the schedule', () => {
    assert.deepEqual(codes(['EGLL', 'KBOS'], []), ['a', 'c']);
    assert.deepEqual(codes([], ['KORD', 'EGKK']), ['a', 'c']);
  });

  it('finds nothing when no airport is given', () => {
    assert.deepEqual(codes([], []), []);
  });
});

describe('the search form and its results on a panel', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  const pid = () => h.panel.id;
  const panelHandler = () => componentHandlers.find((x) => x.prefix === 'panel')!;
  const starting = (key: string, chain: string, inDays: number, over = {}) => sj(key, chain, { availableFrom: T0 + inDays * DAY, deadline: T0 + (inDays + 1) * DAY, ...over });
  const search = async (fields: Record<string, string>, o = {}) => {
    const f = fakeModal(alice, `panel:searchgo:${pid()}`, fields, o);
    await panelHandler().handle(d.ctx, f.i);
    return f.calls;
  };
  const titles = (embeds: any[]) => embeds.map((e) => e.toJSON().title ?? '');

  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    h.jobs.sync(pid(), [starting('now', 'EGLL-EGKK', 0), starting('three', 'EGLL-EGCC', 3), starting('six', 'EGLL-EGPH', 6), starting('ten', 'EGLL-LFMN', 10), starting('other', 'KBOS-KORD', 1)]);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('is a Search button on the panel that opens a form with four optional boxes: from, to, a date, and an aircraft type', async () => {
    const f = fakeComponent(alice, `panel:search:${pid()}`, {});
    await panelHandler().handle(d.ctx, f.i);
    assert.equal(f.calls.modals.length, 1);
    const modal = f.calls.modals[0].toJSON();
    assert.equal(modal.custom_id, `panel:searchgo:${pid()}`);
    assert.ok(modal.title.length <= 45);
    const inputs = modal.components.map((r: any) => r.components[0]);
    assert.deepEqual(inputs.map((i: any) => i.custom_id), ['from', 'to', 'date', 'aircraft']);
    assert.ok(inputs.every((i: any) => i.required === false && i.label.length <= 45 && i.placeholder.length <= 100));
    assert.match(inputs[2].label, /Zulu/, 'the form says which timezone dates are read in');
    assert.match(inputs[2].placeholder, /2026-11-11/, 'with today as the example');
    assert.match(inputs[3].label, /Aircraft type/);
    assert.match(inputs[3].placeholder, /A320/);
  });

  it('answers privately with the flights between the two airports, as the same cards the panel uses', async () => {
    const calls = await search({ from: 'egll', to: 'EGKK' });
    assert.deepEqual(calls.defers[0], { flags: 64 }, 'only the person who searched sees it');
    const reply = calls.edits[0];
    assert.deepEqual(reply.allowedMentions, { parse: [] });
    assert.deepEqual(titles(reply.embeds), ['🔎 Flights from EGLL to EGKK', 'TST-001 · A320']);
    assert.match(reply.embeds[0].toJSON().description, /^1 flight matches, open now or starting within the next 7 days\./);
    assert.match(embedText(reply.embeds[1]), /EGLL ✈ EGKK/);
  });

  it('works with only where from, or only where to', async () => {
    const from = (await search({ from: 'EGLL' })).edits[0];
    assert.deepEqual(titles(from.embeds).slice(1), ['TST-001 · A320', 'TST-002 · A320', 'TST-003 · A320'], 'soonest first, and only the ones the panel lists');
    const to = (await search({ to: 'KORD' })).edits[0];
    assert.deepEqual(titles(to.embeds), ['🔎 Flights to KORD', 'TST-005 · A320']);
  });

  it("only searches as far ahead as the admin's days allow, the same flights the panel lists", async () => {
    const week = (await search({ from: 'EGLL' })).edits[0];
    assert.deepEqual(titles(week.embeds).slice(1).map((t) => t.slice(0, 7)), ['TST-001', 'TST-002', 'TST-003'], 'the one 10 days out is not found');

    h.store.updatePanel(pid(), { showDays: 2 });
    const two = (await search({ from: 'EGLL' })).edits[0];
    assert.deepEqual(titles(two.embeds).slice(1).map((t) => t.slice(0, 7)), ['TST-001'], 'only the one inside 2 days');
    assert.match(two.embeds[0].toJSON().description, /within the next 2 days/);

    h.store.updatePanel(pid(), { showDays: 1 });
    const one = (await search({ from: 'EGLL' })).edits[0];
    assert.match(one.embeds[0].toJSON().description, /within the next 1 day\./);
    assert.deepEqual(titles(one.embeds).slice(1).map((t) => t.slice(0, 7)), ['TST-001']);

    // exactly what the panel itself lists
    await d.panels.refresh(pid());
    const onPanel = d.client.channel(CHANNEL).live.slice(0, -1).map(messageText).join('\n');
    assert.match(onPanel, /^TST-001 ·/m);
    assert.doesNotMatch(onPanel, /^TST-002 ·/m);
  });

  it('says plainly when nothing matches, what the days are, and how to search', async () => {
    const reply = (await search({ from: 'EGLL', to: 'LFMN' })).edits[0];
    assert.equal(reply.embeds.length, 1);
    const text = reply.embeds[0].toJSON().description;
    assert.match(text, /^Nothing from EGLL to LFMN is open now or starts within the next 7 days\./);
    assert.match(text, /two or three letters match every airport that starts with them/);
  });

  it('does not find flights that are over, completed or taken off the panel', async () => {
    h.jobs.sync(pid(), [starting('now', 'EGLL-EGKK', 0)]); // the others are no longer listed
    h.clock.now = T0 + 2 * DAY; // and its deadline has passed
    assert.deepEqual(titles((await search({ from: 'EGLL' })).edits[0].embeds), ['🔎 Flights from EGLL']);
    h.clock.now = T0;
    h.jobs.reserve(h.jobs.open(pid())[0]!.job.id, [1], USER_B);
    h.jobs.complete(h.jobs.open(pid())[0]!.job.id, USER_B.discordId);
    assert.match((await search({ from: 'EGLL' })).edits[0].embeds[0].toJSON().description, /^Nothing from EGLL/);
  });

  it('shows who has a flight that is taken (without pinging them), so pilots know what is free', async () => {
    h.jobs.reserve(h.jobs.open(pid()).find((v) => v.job.sourceKey === 'now')!.job.id, [1], USER_B);
    const reply = (await search({ from: 'EGLL', to: 'EGKK' })).edits[0];
    assert.match(embedText(reply.embeds[1]), new RegExp(`PILOT: <@${USER_B.discordId}>`));
    assert.deepEqual(reply.allowedMentions, { parse: [] });
  });

  it('shows the first eight when many match, and asks for a narrower search', async () => {
    h.jobs.sync(pid(), Array.from({ length: 12 }, (_, i) => starting(`m${i}`, 'EGLL-EGKK', 1, { deadline: T0 + (2 + i) * DAY })));
    const reply = (await search({ from: 'EGLL' })).edits[0];
    assert.equal(reply.embeds.length, 1 + MAX_SEARCH_RESULTS);
    const text = reply.embeds[0].toJSON().description;
    assert.match(text, /^12 flights match, open now or starting within the next 7 days\./);
    assert.match(text, /Showing the first 8\. Search for something narrower to see the rest\./);
    assert.ok(reply.embeds.reduce((n: number, e: any) => n + embedText(e).length, 0) < 6000, 'inside the size Discord allows a message');
  });

  it('tells you which words it skipped, and asks again when none of it was a code', async () => {
    const some = (await search({ from: 'EGLL', to: 'airport?' })).edits[0];
    assert.match(some.content, /I skipped `AIRPORT\?`: not airport codes\./);
    assert.deepEqual(titles(some.embeds).slice(0, 1), ['🔎 Flights from EGLL']);
    await assert.rejects(search({ from: '*', to: '??' }), /I couldn't use `\*`, `\?\?` as an airport code/);
    await assert.rejects(search({ from: '', to: '  ', date: ' ', aircraft: ' ' }), /Type where you want to fly from, where you want to fly to, a date, an aircraft type, or any of them together\./);
  });

  describe('by aircraft type', () => {
    // 'now' is an A320 EGLL-EGKK; the flights below are added to it (all open now or within the 7 days), with their types.
    const types = (reply: any) => titles(reply.embeds).slice(1).map((t) => t.split(' · ').at(-1));
    const codesOf = (reply: any) => titles(reply.embeds).slice(1).map((t) => t.split(' · ')[0]);
    const codeOf = (key: string) => h.store.listJobs(pid()).find((j) => j.sourceKey === key)!.code;
    beforeEach(() => {
      h.jobs.sync(pid(), [
        starting('a320', 'EGLL-EGKK', 0, { aircraft: 'A320' }),
        starting('a321', 'EGLL-EGCC', 1, { aircraft: 'A321' }),
        starting('b738', 'EGKK-EGLL', 1, { aircraft: 'B738' }),
        starting('b38m', 'EGCC-EGLL', 2, { aircraft: 'B38M' }),
        starting('a333', 'EGLL-KJFK', 2, { aircraft: 'A333' }),
        starting('either', 'EGPH-EGLL', 3, { aircraft: 'A320/A321' }),
        starting('named', 'EGLL-LFPG', 3, { aircraft: 'Airbus A333' }),
        starting('none', 'EGLL-EDDF', 3, { aircraft: null }),
        starting('far', 'EGLL-LFMN', 10, { aircraft: 'B738' }),
      ]);
    });

    it('finds the flights in that type, with the type in the heading and the description', async () => {
      const reply = (await search({ aircraft: 'b738' })).edits[0];
      assert.deepEqual(titles(reply.embeds), ['🔎 Flights in B738', `${codeOf('b738')} · B738`]);
      assert.deepEqual(types(reply), ['B738']);
      assert.match(reply.embeds[0].toJSON().description, /^1 flight matches, open now or starting within the next 7 days\.\nTo take one/);
      assert.deepEqual(reply.allowedMentions, { parse: [] });
    });

    it('takes a few characters as the start of a type, so B73 finds every B73x and A32 every A32x', async () => {
      assert.deepEqual(types((await search({ aircraft: 'A32' })).edits[0]).sort(), ['A320', 'A320/A321', 'A321']);
      assert.deepEqual(types((await search({ aircraft: 'B3' })).edits[0]), ['B38M']);
      assert.deepEqual(types((await search({ aircraft: 'B7' })).edits[0]), ['B738']);
    });

    it('takes several types, in any case and with any separators', async () => {
      const reply = (await search({ aircraft: 'b738, a333 / B38M' })).edits[0];
      assert.equal(titles(reply.embeds)[0], '🔎 Flights in B738 or A333 or B38M');
      assert.deepEqual(types(reply).sort(), ['A333', 'Airbus A333', 'B38M', 'B738'], 'the A333, the one named Airbus A333, the B38M and the B738');
    });

    it("finds a flight whose schedule lists several types, or gives the type inside a name, and not one with no aircraft named", async () => {
      assert.ok(codesOf((await search({ aircraft: 'A321' })).edits[0]).includes(codeOf('either')), 'either type of A320/A321');
      assert.ok(codesOf((await search({ aircraft: 'A320' })).edits[0]).includes(codeOf('either')));
      assert.ok(codesOf((await search({ aircraft: 'A333' })).edits[0]).includes(codeOf('named')), 'Airbus A333');
      for (const t of ['A32', 'A333', 'B738', 'B7', 'E1']) assert.ok(!codesOf((await search({ aircraft: t })).edits[0]).includes(codeOf('none')), `a flight with no aircraft is not an ${t}`);
    });

    it('works with where from, where to and a date, narrowing each other', async () => {
      assert.deepEqual(codesOf((await search({ from: 'EGLL', aircraft: 'A32' })).edits[0]).sort(), [codeOf('a320'), codeOf('a321')].sort(), 'from EGLL: the A320 and the A321');
      assert.deepEqual(codesOf((await search({ from: 'EGLL', to: 'KJFK', aircraft: 'A333' })).edits[0]), [codeOf('a333')]);
      assert.deepEqual(codesOf((await search({ from: 'EGLL', to: 'KJFK', aircraft: 'B738' })).edits[0]), [], 'right route, wrong type');
      const day = (await search({ date: '13 Nov', aircraft: 'A333' })).edits[0];
      assert.equal(titles(day.embeds)[0], '🔎 Flights on Fri 13 Nov in A333');
      assert.deepEqual(codesOf(day), [codeOf('a333')]);
      assert.equal(titles((await search({ from: 'EGLL', date: '13 Nov', aircraft: 'A333' })).edits[0].embeds)[0], '🔎 Flights from EGLL on Fri 13 Nov in A333');
    });

    it("never goes beyond the panel's days, whatever the type", async () => {
      assert.ok(!codesOf((await search({ aircraft: 'B738' })).edits[0]).includes(codeOf('far')), 'ten days out is not listed');
      h.store.updatePanel(pid(), { showDays: 2 });
      assert.deepEqual(types((await search({ aircraft: 'A32' })).edits[0]).sort(), ['A320', 'A321'], 'only those starting within two days');
    });

    it('says plainly when no flight is that type, and how types are written', async () => {
      const some = (await search({ aircraft: 'B77W' })).edits[0];
      assert.equal(some.embeds.length, 1);
      assert.match(some.embeds[0].toJSON().description, /^Nothing in B77W is open now or starts within the next 7 days\.\nAircraft types are the short codes on the cards \(like A320 or B738\), and a few characters match every type that starts with them \(B73 finds B737, B738 and B739\)\./);
      assert.doesNotMatch(some.embeds[0].toJSON().description, /airport codes/);
      const both = (await search({ from: 'EGLL', aircraft: 'B77W' })).edits[0].embeds[0].toJSON().description;
      assert.match(both, /^Nothing from EGLL in B77W is open now or starts within the next 7 days\.\nCheck the airport codes[^\n]*\nAircraft types are/);
      assert.match((await search({ date: '13 Nov', aircraft: 'B77W' })).edits[0].embeds[0].toJSON().description, /^Nothing in B77W can be flown on Fri 13 Nov \(Zulu time\)\./);
    });

    it('tells you which words it skipped, and asks again when none of it was a type', async () => {
      const some = (await search({ aircraft: 'A320 ??? <@1>' })).edits[0];
      assert.equal(some.content, 'I skipped `???`, `<@1>`: not aircraft types.');
      assert.equal(titles(some.embeds)[0], '🔎 Flights in A320');
      const both = (await search({ from: 'EGLL', to: 'airport?', aircraft: '?!' })).edits[0];
      assert.equal(both.content, 'I skipped `AIRPORT?`: not airport codes.\nI skipped `?!`: not aircraft types.');
      await assert.rejects(search({ aircraft: '*' }), /I couldn't use `\*` as an aircraft type\. Aircraft types are the short codes on the cards, like `A320` or `B738`\./);
      await assert.rejects(search({ from: '*', aircraft: '??' }), /I couldn't use `\*` as an airport code/, 'the airport words are reported first');
    });

    it('builds the same reply directly, with the types', () => {
      const embeds = searchEmbeds(h.panel, [], [], h.jobs.open(pid()).slice(0, 1), T0, null, ['A320', 'B738']);
      assert.equal(embeds[0]!.toJSON().title, '🔎 Flights in A320 or B738');
      assert.equal(searchEmbeds(h.panel, ['EGLL'], [], [], T0, null, [])[0]!.toJSON().title, '🔎 Flights from EGLL', 'no types, no change');
    });
  });

  describe('by date', () => {
    // 'now' flies 11 Nov 12:00 to 12 Nov 12:00, 'other' 12 Nov 12:00 to 13 Nov 12:00, 'three' 14 Nov 12:00 to 15 Nov 12:00,
    // 'six' 17 Nov 12:00 to 18 Nov 12:00, 'ten' 21 Nov 12:00 to 22 Nov 12:00 (the panel is at 7 days).
    const codes = (reply: any) => titles(reply.embeds).slice(1).map((t) => t.slice(0, 7));

    it('finds the flights that can be flown on that day, with the day in the heading and the description', async () => {
      const reply = (await search({ from: 'EGLL', date: 'sat' })).edits[0];
      assert.deepEqual(titles(reply.embeds), ['🔎 Flights from EGLL on Sat 14 Nov', 'TST-002 · A320']);
      assert.match(reply.embeds[0].toJSON().description, /^1 flight matches, that can be flown on Sat 14 Nov \(Zulu time\)\.\nTo take one, press \*\*Reserve\*\*/);
      assert.deepEqual(reply.allowedMentions, { parse: [] });
    });

    it('works on its own, with no airports: what is flying that day', async () => {
      const reply = (await search({ date: '12 Nov' })).edits[0];
      assert.equal(titles(reply.embeds)[0], '🔎 Flights on Thu 12 Nov');
      assert.deepEqual(codes(reply), ['TST-001', 'TST-005'], 'one still open in the morning, one opening at noon');
    });

    it('narrows airports by the day, and the day by airports', async () => {
      assert.deepEqual(codes((await search({ from: 'KBOS', date: '12 Nov' })).edits[0]), ['TST-005']);
      assert.deepEqual(codes((await search({ to: 'KORD', date: '14 Nov' })).edits[0]), [], 'that one is not on that day');
      assert.deepEqual(codes((await search({ from: 'EGLL', to: 'EGKK', date: 'today' })).edits[0]), ['TST-001']);
      assert.deepEqual(codes((await search({ from: 'EGLL', date: '2026-11-17' })).edits[0]), ['TST-003']);
    });

    it('says plainly when nothing can be flown that day, with or without airports', async () => {
      const some = (await search({ from: 'EGLL', date: '16 Nov' })).edits[0];
      assert.equal(some.embeds.length, 1);
      assert.match(some.embeds[0].toJSON().description, /^Nothing from EGLL can be flown on Mon 16 Nov \(Zulu time\)\. The panel lists flights open now or starting within the next 7 days\.\nCheck the airport codes/);
      const none = (await search({ date: '16 Nov' })).edits[0];
      assert.equal(none.embeds[0].toJSON().description, 'Nothing can be flown on Mon 16 Nov (Zulu time). The panel lists flights open now or starting within the next 7 days.');
    });

    it('counts a flight that closes as the day starts as closed that day, and one that opens as it ends as not yet open', async () => {
      h.jobs.sync(pid(), [
        starting('closes', 'EGLL-EGKK', 0, { deadline: Date.UTC(2026, 10, 12) }),
        starting('opens', 'EGLL-EGCC', 0, { availableFrom: Date.UTC(2026, 10, 13), deadline: Date.UTC(2026, 10, 14) }),
      ]);
      const codeOf = (key: string) => h.jobs.open(pid()).find((v) => v.job.sourceKey === key)!.job.code;
      const on = async (date: string) => titles((await search({ from: 'EGLL', date })).edits[0].embeds).slice(1).map((t) => t.split(' · ')[0]);
      assert.deepEqual(await on('11 Nov'), [codeOf('closes')]);
      assert.deepEqual(await on('12 Nov'), [], 'one closed at midnight, the other is not open until the 13th');
      assert.deepEqual(await on('13 Nov'), [codeOf('opens')]);
    });

    it("only searches the days the admin shows: a day beyond them is refused, and the last one is named", async () => {
      await assert.rejects(search({ from: 'EGLL', date: '19 Nov' }), /\*\*Test Air\*\* shows flights up to 7 days ahead, so I can only search up to \*\*Wed 18 Nov\*\*\. \*\*Thu 19 Nov\*\* is further than that/);
      assert.ok((await search({ from: 'EGLL', date: '18 Nov' })).edits[0], 'the last day is fine');

      h.store.updatePanel(pid(), { showDays: 2 });
      await assert.rejects(search({ from: 'EGLL', date: 'sat' }), /shows flights up to 2 days ahead, so I can only search up to \*\*Fri 13 Nov\*\*/);
      const inside = (await search({ date: '13 Nov' })).edits[0];
      assert.match(inside.embeds[0].toJSON().description, /^1 flight matches, that can be flown on Fri 13 Nov \(Zulu time\)\./);

      h.store.updatePanel(pid(), { showDays: 1 });
      await assert.rejects(search({ from: 'EGLL', date: '13 Nov' }), /shows flights up to 1 day ahead, so I can only search up to \*\*Thu 12 Nov\*\*/);
    });

    it('never finds a flight the panel does not list, even on a day that is inside the days', async () => {
      // opens at 18:00 on the 13th: on a 2-day panel (ending 12:00 on the 13th) it is not listed yet, though the 13th is the last day searched
      h.jobs.sync(pid(), [starting('now', 'EGLL-EGKK', 0), starting('late', 'EGLL-LFPG', 0, { availableFrom: Date.UTC(2026, 10, 13, 18), deadline: Date.UTC(2026, 10, 14, 18) })]);
      h.store.updatePanel(pid(), { showDays: 2 });
      assert.deepEqual(codes((await search({ from: 'EGLL', date: '13 Nov' })).edits[0]), [], 'not on the panel, so not found');
      h.store.updatePanel(pid(), { showDays: 3 });
      assert.deepEqual(codes((await search({ from: 'EGLL', date: '13 Nov' })).edits[0]).length, 1, 'found once the panel lists it');
    });

    it('refuses a day that has already passed, and says where to start', async () => {
      await assert.rejects(search({ from: 'EGLL', date: '10 Nov' }), /\*\*Tue 10 Nov\*\* has already passed\. Search from today \(\*\*Wed 11 Nov\*\*\) onwards\./);
      await assert.rejects(search({ date: 'yesterday' }), /couldn't read `yesterday` as a date/);
      h.clock.now = T0 + 20 * HOUR; // late on the 11th: today is still fine
      assert.ok((await search({ date: 'today' })).edits[0]);
    });

    it('says what it can read when the date is not one, and shows what was typed safely', async () => {
      await assert.rejects(search({ from: 'EGLL', date: 'next month' }), /I couldn't read `next month` as a date\. Try `tomorrow`, a weekday like `sat`, `14 Nov`, `14\/11` or `2026-11-11`\. Dates are Zulu \(UTC\), like the flight times\./);
      await assert.rejects(search({ date: '31/02' }), /couldn't read `31\/02`/);
      await assert.rejects(search({ date: '`**@everyone**` ' + 'x'.repeat(100) }), (e: any) => /^I couldn't read `[^`]{1,30}` as a date\. Try /.test(e.message));
    });

    it('a date with airports that were not codes still searches, and says which it skipped', async () => {
      const reply = (await search({ from: 'airport?', date: '12 Nov' })).edits[0];
      assert.match(reply.content, /I skipped `AIRPORT\?`: not airport codes\./);
      assert.deepEqual(codes(reply), ['TST-001', 'TST-005']);
    });

    it('builds the same reply directly, with the day', () => {
      const day = parseSearchDate('sat', T0)!;
      const embeds = searchEmbeds(h.panel, ['EGLL'], [], h.jobs.open(pid()).slice(0, 1), T0, day);
      assert.equal(embeds[0]!.toJSON().title, '🔎 Flights from EGLL on Sat 14 Nov');
      assert.match(embeds[0]!.toJSON().description!, /that can be flown on Sat 14 Nov \(Zulu time\)/);
      assert.equal(searchEmbeds(h.panel, ['EGLL'], [], [], T0, null)[0]!.toJSON().title, '🔎 Flights from EGLL', 'no day, no change');
    });
  });

  it('is open to everyone who can see the panel: a role needed to reserve is not needed to look', async () => {
    h.store.updatePanel(pid(), { requiredRoleId: '555555555555555555' });
    const calls = await search({ from: 'EGLL' }, { roles: [] });
    assert.ok(calls.edits[0].embeds.length > 1);
  });

  it('refuses a form for a panel that is gone or belongs to another server', async () => {
    await assert.rejects(search({ from: 'EGLL' }, { guildId: '123' }), /no longer active/);
    h.store.deletePanel(pid());
    await assert.rejects(search({ from: 'EGLL' }), /no longer active/);
  });

  it('builds the same reply directly from a list of flights', () => {
    const views = h.jobs.open(pid());
    const embeds = searchEmbeds(h.panel, ['EGLL'], ['EGKK'], views.slice(0, 1), T0);
    assert.equal(embeds.length, 2);
    assert.equal(embeds[0]!.toJSON().title, '🔎 Flights from EGLL to EGKK');
  });
});

describe('search through the interaction router', () => {
  let h: Harness;
  let d: DiscordHarness;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  it('sends a submitted search form to the panel handler (and the DM handler ignores forms)', async () => {
    const client = new EventEmitter();
    registerInteractionRouter(client as never, d.ctx);
    const f = fakeModal(new FakeUser(USER_A.discordId, 'alice'), `panel:searchgo:${h.panel.id}`, { from: 'EGLL' });
    client.emit('interactionCreate', f.i);
    await settle();
    assert.equal(f.calls.edits.length, 1);
    assert.match(f.calls.edits[0].embeds[0].toJSON().title, /Flights from EGLL/);

    const stray = fakeModal(new FakeUser(USER_A.discordId, 'alice'), 'dm:all', {});
    client.emit('interactionCreate', stray.i);
    await settle();
    assert.equal(stray.calls.edits.length + stray.calls.replies.length, 0, 'a form is not a DM button');
  });

  it('is not a slash command: pilots find it on the panel', () => {
    assert.deepEqual(commands.map((c) => c.data.name).sort(), ['fuel', 'help', 'setup']);
  });
});

describe('/setup refresh brings a panel posted by an older version up to date', () => {
  let h: Harness;
  let d: DiscordHarness;
  const setup = commands.find((c) => c.data.name === 'setup')!;
  const pid = () => h.panel.id;
  beforeEach(async () => {
    h = await makeHarness();
    d = makeDiscordHarness(h);
    h.jobs.sync(pid(), [sj('a', 'EGLL-EGKK')]);
    await d.panels.refresh(pid());
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });
  const buttons = () => d.client.channel(CHANNEL).live[0]!.payload.components[0].toJSON().components.map((c: any) => c.custom_id.split(':')[1]);
  const run = async () => {
    const f = fakeInteraction({ sub: 'refresh', admin: true });
    await setup.execute(d.ctx, f.i);
    await settle();
    return String(f.calls.edits.at(-1)?.content ?? '');
  };

  /** Make the posted messages look as an older version left them: the three original buttons. */
  const makeOld = () => {
    for (const m of d.client.channel(CHANNEL).live) {
      if (m.payload.components.length === 0) continue;
      const old = m.payload.components[0].toJSON();
      m.payload = { ...m.payload, components: [{ toJSON: () => ({ ...old, components: old.components.filter((c: any) => ['reserve', 'mine', 'complete'].includes(c.custom_id.split(':')[1])) }) }] };
    }
  };

  it('puts the new buttons on the messages already in the channel, with no need to remove and add the panel', async () => {
    assert.deepEqual(buttons(), ['reserve', 'search', 'backup', 'mine', 'complete']);
    makeOld();
    assert.deepEqual(buttons(), ['reserve', 'mine', 'complete']);
    assert.match(await run(), /Redrew the \*\*Test Air\*\* panel/);
    assert.deepEqual(buttons(), ['reserve', 'search', 'backup', 'mine', 'complete']);
  });

  it('does so even for a panel whose flights come from file imports, with no sheet to read', async () => {
    makeOld();
    const reply = await run();
    assert.match(reply, /takes flights from `\/setup import`, so there is nothing to fetch/);
    assert.deepEqual(buttons(), ['reserve', 'search', 'backup', 'mine', 'complete']);
  });

  it('sends every message again when forced, but leaves unchanged ones alone on an ordinary redraw', async () => {
    h.jobs.sync(pid(), Array.from({ length: 40 }, (_, i) => sj(`j${i}`, 'EGLL-EGKK-EGCC', { notes: 'n'.repeat(150) })));
    await d.panels.refresh(pid());
    await settle(40);
    const edits = () => d.client.channel(CHANNEL).live.map((m) => m.edits.length);
    const before = edits();
    await d.panels.refresh(pid());
    const ordinary = edits();
    assert.ok(ordinary.slice(1).every((n, i) => n === before.slice(1)[i]), 'messages that say the same are not edited again');
    await d.panels.refresh(pid(), { force: true });
    const forced = edits();
    assert.ok(forced.every((n, i) => n > ordinary[i]!), 'every message was sent again');
  });

  it('counts a change to the buttons as a change, so a newer layout is never skipped as unchanged', async () => {
    const before = d.client.channel(CHANNEL).live[0]!.edits.length;
    d.client.channel(CHANNEL).live[0]!.payload = { ...d.client.channel(CHANNEL).live[0]!.payload };
    await d.panels.refresh(pid(), { force: true });
    assert.ok(d.client.channel(CHANNEL).live[0]!.edits.length > before);
  });
});
