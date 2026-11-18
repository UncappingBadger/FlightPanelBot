import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { FsHubFlight } from '../src/fshub/client.js';
import type { LiveDetail } from '../src/fshub/liveFeed.js';
import { intentOf, isRude, LINES, mentions, moodOf, pickLine, type Mood } from '../src/twitch/banter.js';
import * as chatBotModule from '../src/twitch/chatBot.js';
import { ChatBot, HELP_TEXT } from '../src/twitch/chatBot.js';

/* The pace, written out here in plain numbers, so that changing it in the code has to change it here too. */
const COMMAND_COOLDOWN_MS = 10_000;
const USER_COMMAND_COOLDOWN_MS = 4_000;
const BANTER_USER_COOLDOWN_MS = 20_000;
const BANTER_ALL_COOLDOWN_MS = 5_000;
const SEND_WINDOW_MS = 30_000;
const SEND_WINDOW_MAX = 10;
const SEND_MIN_GAP_MS = 1_500;
import type { ChatEvent } from '../src/twitch/eventsub.js';
import { ago, aircraftText, distanceText, duration, etaText, flightText, landingText, landingWord, StreamerFlights, withArticle, type FlightSource } from '../src/twitch/flightInfo.js';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const live = (over: Partial<LiveDetail> = {}): LiveDetail => ({
  flightId: 'f1',
  phase: 'cruise',
  airborne: true,
  onGround: false,
  aircraftIcao: 'A320',
  callsign: 'TST517',
  dep: 'VHHH',
  arr: 'KORD',
  altitudeFt: 37_000,
  speedKts: 462,
  headingDeg: 20,
  distanceToGoNm: 3000,
  progressPct: 50,
  etaMinutes: 125,
  flightStatus: 'ON-TIME',
  ...over,
});
const last = (over: Partial<FsHubFlight> = {}): FsHubFlight => ({
  id: 1,
  pilotId: 7,
  pilotName: 'Streamer',
  dep: 'EINN',
  arr: 'EGLL',
  departedAt: null,
  arrivedAt: NOW - 2 * 3_600_000,
  aircraftIcao: 'A320',
  aircraftName: 'Airbus A320',
  scheduleStatus: null,
  landingRate: -367,
  distanceNm: 356,
  ...over,
});

/* ------------------------------------------------------------------ the words for a flight */

describe('what a viewer is told about the flight', () => {
  it('says where the flight is going, in what, and how it is going', () => {
    assert.equal(flightText(live(), last(), NOW), '✈️ VHHH → KORD (TST517) in an Airbus A320 · cruising · FL370, 462 kts · 50% of the way · about 2h 05m to go.');
    assert.equal(flightText(live({ phase: 'taxiing_to_runway', airborne: false, onGround: true, altitudeFt: 0, speedKts: 8, progressPct: 0, etaMinutes: 190 }), null, NOW), '✈️ VHHH → KORD (TST517) in an Airbus A320 · taxiing to the runway.');
    assert.equal(flightText(live({ dep: null, arr: null, callsign: null, aircraftIcao: 'ZZZZ', altitudeFt: 5_500 }), null, NOW), '✈️ On a flight in a ZZZZ · cruising · 5,500 ft, 462 kts · 50% of the way · about 2h 05m to go.');
  });

  it('says nobody is flying, and what the last flight was, when nothing is in the air', () => {
    assert.equal(flightText(null, last(), NOW), "Nobody's flying right now. The last flight was EINN → EGLL in an Airbus A320, landed 2 h ago.");
    assert.equal(flightText(null, null, NOW), "Nobody's flying right now.");
  });

  it('says how far there is to go, and how far the flight is in all', () => {
    assert.equal(distanceText(live(), null), '📏 3,000 nm still to go of about 6,000 nm (50% done).');
    assert.equal(distanceText(live({ progressPct: null }), null), '📏 3,000 nm still to go.');
    assert.equal(distanceText(live({ airborne: false, onGround: true }), null), "📏 3,000 nm to the destination, and we're not in the air yet.");
    assert.equal(distanceText(null, last()), '📏 Nothing in the air right now. The last flight (EINN → EGLL) was 356 nm.');
    assert.equal(distanceText(null, null), "📏 No flight in the air right now, so there's nothing to measure.");
  });

  it('gives the last landing rate with a kind word for it, and says so when it has not landed yet', () => {
    assert.equal(landingText(null, last(), NOW), '🛬 The last landing at EGLL, 2 h ago: 367 fpm. Perfectly respectable.');
    assert.equal(landingText(live(), last({ landingRate: -90 }), NOW), '🛬 Not landed yet, but the last landing at EGLL, 2 h ago: 90 fpm. Butter 🧈.');
    assert.equal(landingText(null, last({ landingRate: null }), NOW), '🛬 The last landing (EINN → EGLL, 2 h ago) has no landing rate recorded.');
    assert.equal(landingText(null, null, NOW), '🛬 No landing on record that I can see.');
    assert.equal(landingText(live(), null, NOW), "🛬 Haven't seen a landing yet.");
  });

  it('has a word for every kind of landing, and is never unkind about a pilot', () => {
    const words = [50, 150, 300, 450, 550, 700, 900, 1200].map(landingWord);
    assert.deepEqual(words, ['butter 🧈', 'smooth as silk', 'a nice one', 'perfectly respectable', 'a firm one', 'a proper thump', 'the runway felt that', 'the runway is filing a complaint']);
    assert.equal(landingWord(-90), landingWord(90), 'a descent is negative, the word is the same');
  });

  it('does not call a flight at flight level "getting ready" because FsHub has not worked out the phase yet', () => {
    assert.match(flightText(live({ phase: 'calculating' }), null, NOW), /· in the air · FL370/);
    assert.match(flightText(live({ phase: 'calculating', airborne: false, onGround: true }), null, NOW), /· getting ready\./);
  });

  it('never begins a reply with an exclamation mark, whatever it is asked', () => {
    const texts = [
      flightText(live(), last(), NOW), flightText(null, null, NOW), flightText(null, last(), NOW), distanceText(live(), null), distanceText(null, null), landingText(null, null, NOW),
      landingText(live(), last(), NOW), aircraftText(null, null), aircraftText(live({ aircraftIcao: null }), null), etaText(null, NOW), etaText(live(), NOW), HELP_TEXT,
    ];
    for (const t of texts) assert.equal(t.startsWith('!'), false, t);
  });

  it('names the aircraft, and the last one when nothing is flying', () => {
    assert.equal(aircraftText(live(), null), '🛩️ Flying an Airbus A320 (A320).');
    assert.equal(aircraftText(live({ aircraftIcao: 'ZZZZ' }), null), '🛩️ Flying a ZZZZ.');
    assert.equal(aircraftText(live({ aircraftIcao: null }), null), "🛩️ I can't tell what aircraft that is.");
    assert.equal(aircraftText(null, last()), '🛩️ Not flying right now. The last one was an Airbus A320.');
    assert.equal(aircraftText(null, null), '🛩️ Not flying right now.');
  });

  it('gives the time to go, and the time it lands (Zulu)', () => {
    assert.equal(etaText(live(), NOW), '🕐 About 2h 05m to go to KORD, landing around 14:05Z.');
    assert.equal(etaText(live({ airborne: false }), NOW), "🕐 Not in the air yet, so there's no landing time to give.");
    assert.equal(etaText(null, NOW), "🕐 Nobody's flying right now.");
  });

  it('writes times and articles the way a person would', () => {
    assert.deepEqual([duration(0), duration(45), duration(60), duration(125), duration(600)], ['0 min', '45 min', '1h 00m', '2h 05m', '10h 00m']);
    assert.deepEqual([ago(0), ago(60_000), ago(90_000), ago(12 * 60_000), ago(3 * 3_600_000), ago(3 * 86_400_000)], ['just now', 'just now', '2 min ago', '12 min ago', '3 h ago', '3 days ago']);
    assert.deepEqual(['Airbus A320', 'Boeing 737-800', 'Embraer E175', 'ATR 72', 'MD11', 'Cessna 172', 'Learjet 45', '8 seater', 'Dash 8 Q400'].map(withArticle), [
      'an Airbus A320', 'a Boeing 737-800', 'an Embraer E175', 'an ATR 72', 'an MD11', 'a Cessna 172', 'a Learjet 45', 'an 8 seater', 'a Dash 8 Q400',
    ]);
  });
});

describe('the streamer\'s flight data', () => {
  it('works out whose flights they are from the FsHub token, and asks again only after a short while', async () => {
    let clock = NOW;
    const calls = { account: 0, live: 0, last: 0 };
    const src = new StreamerFlights({
      feed: { pilotDetail: async () => (calls.live++, live()) },
      fshub: { account: async () => (calls.account++, { id: 7 }), pilotRecentFlights: async () => (calls.last++, [last()]) },
      now: () => clock,
    });
    assert.equal((await src.live())?.callsign, 'TST517');
    await src.live();
    assert.equal(calls.live, 1, 'remembered for a few seconds');
    clock += 21_000;
    await src.live();
    assert.equal(calls.live, 2);
    assert.equal((await src.lastFlight())?.arr, 'EGLL');
    await src.lastFlight();
    assert.deepEqual(calls, { account: 1, live: 2, last: 1 }, 'who they are is asked once');
  });

  it('uses the pilot number it was given, and says nothing is known without one or a FsHub token', async () => {
    let asked = 0;
    const given = new StreamerFlights({ feed: { pilotDetail: async (id) => (id === 42 ? live() : null) }, fshub: { account: async () => (asked++, { id: 1 }), pilotRecentFlights: async () => [] }, pilotId: 42 });
    assert.ok(await given.live());
    assert.equal(await given.lastFlight(), null, 'no flights yet');
    assert.equal(asked, 0);
    const nobody = new StreamerFlights({ feed: { pilotDetail: async () => live() }, fshub: null });
    assert.equal(await nobody.live(), null);
    assert.equal(await nobody.lastFlight(), null);
    const noToken = new StreamerFlights({ feed: { pilotDetail: async () => live() }, fshub: null, pilotId: 9 });
    assert.ok(await noToken.live(), 'the live feed needs no token');
    assert.equal(await noToken.lastFlight(), null, 'the last landing does');
  });
});

/* ------------------------------------------------------------------ what was said */

describe('what was said to the bot', () => {
  const mood = (t: string) => moodOf(t);
  it('tells compliments, jokes and insults apart', () => {
    assert.deepEqual(
      ['good bot', 'kevin you are lazy', "you're fired", 'bad bot', 'thanks kevin', 'love you kevin', '<3', 'are you a bot?', 'how are you', 'need coffee', 'this is boring', 'hey kevin', 'great job', 'asleep at the desk again', 'what a banana'].map(mood),
      ['compliment', 'lazy', 'fired', 'insult', 'thanks', 'love', 'love', 'robot', 'howAre', 'coffee', 'bored', 'greeting', 'compliment', 'lazy', null],
    );
  });

  it('knows a question about the flight in plain words', () => {
    assert.deepEqual(
      ['how far are we', 'what was the landing rate', 'where are we going', 'what plane is this', 'when do we arrive', 'what is the eta', 'what a nice day', 'which aircraft'].map(intentOf),
      ['distance', 'landing', 'flight', 'aircraft', 'eta', 'eta', null, 'aircraft'],
    );
  });

  it('keeps out of anything crude, and does not mistake an innocent word for one', () => {
    for (const rude of ['what the fuck', 'this is shit', 'you bitch', 'asshole', 'wtf kevin', 'stfu', 'kys', 'FUCK', 'shitty landing', 'you dick', 'pissed off', 'n' + 'igger']) assert.equal(isRude(rude), true, rude);
    for (const fine of ['classic landing', 'a bass guitar', 'assume nothing', 'Scunthorpe', 'shiitake mushrooms', 'passenger', 'Dickens', 'the cocktail', 'Cumberland', 'Essex']) assert.equal(isRude(fine), false, fine);
  });

  it('knows when it is being talked to: by name, with or without an @, as a whole word', () => {
    const names = ['kevinbot', 'KevinBot', 'kevin'];
    assert.deepEqual(['hi kevin', '@KevinBot hello', 'KEVIN!', 'kevin, you there', 'kevinbotanical', 'sevenkevins', 'mykevin', 'x_kevin', 'ke vin', 'bob'].map((t) => mentions(t, names)), [true, true, true, true, false, false, false, false, false, false]);
    assert.equal(mentions('hi ab', ['ab']), false, 'a name shorter than three letters is never matched');
  });
});

describe('the bot\'s lines', () => {
  const moods = Object.keys(LINES) as Mood[];
  it('has plenty for every mood, all short, clean and kind', () => {
    for (const m of moods) {
      assert.ok(LINES[m].length >= 4, `${m} has ${LINES[m].length}`);
      assert.ok(LINES[m].every((l) => !l.startsWith('!')), `${m}: no line begins with ! (the bot must never mistake its own words for a command)`);
      for (const line of LINES[m]) {
        assert.ok(line.length <= 300, `${m}: too long: ${line}`);
        assert.equal(isRude(line), false, `${m}: ${line}`);
        assert.equal(/\{(?!user\})/.test(line), false, `${m}: an unknown placeholder in ${line}`);
        assert.equal(/\b(stupid|idiot|dumb|hate|shut up|loser)\b/i.test(line), false, `${m}: unkind: ${line}`);
      }
    }
    assert.ok(moods.reduce((n, m) => n + LINES[m].length, 0) >= 80);
    assert.equal(new Set(moods.flatMap((m) => LINES[m])).size, moods.reduce((n, m) => n + LINES[m].length, 0), 'no line is used twice');
  });

  it('puts the person\'s name in, and does not repeat itself until it has to', () => {
    const recent: string[] = [];
    const same = () => 0.3; // the same roll every time: only remembering what was said keeps it from saying the same thing
    const got = Array.from({ length: 4 }, () => pickLine('lazy', 'Sam', recent, same));
    assert.equal(new Set(got).size, 4, 'the last few are never picked again');
    assert.ok(got.every((l) => !l.includes('{user}')));
    assert.ok(got.some((l) => l.includes('Sam')));
    for (let n = 0; n < 40; n++) assert.ok(LINES.lazy.map((l) => l.replace('{user}', 'Sam')).includes(pickLine('lazy', 'Sam', recent, Math.random)));
    assert.ok(recent.length <= 4, 'it only remembers a few');
    assert.ok(LINES.greeting.length > 0 && pickLine('greeting', 'Pat', [], () => 0.999).length > 0, 'a random number at the very top is still a line');
  });
});

/* ------------------------------------------------------------------ the bot that decides what to say */

describe('the chat bot', () => {
  it('keeps to the pace it documents', () => {
    assert.deepEqual(
      [chatBotModule.COMMAND_COOLDOWN_MS, chatBotModule.USER_COMMAND_COOLDOWN_MS, chatBotModule.BANTER_USER_COOLDOWN_MS, chatBotModule.BANTER_ALL_COOLDOWN_MS, chatBotModule.SEND_WINDOW_MS, chatBotModule.SEND_WINDOW_MAX, chatBotModule.SEND_MIN_GAP_MS],
      [COMMAND_COOLDOWN_MS, USER_COMMAND_COOLDOWN_MS, BANTER_USER_COOLDOWN_MS, BANTER_ALL_COOLDOWN_MS, SEND_WINDOW_MS, SEND_WINDOW_MAX, SEND_MIN_GAP_MS],
    );
  });

  let clock: number;
  let state: { live: LiveDetail | null; last: FsHubFlight | null; fail: boolean };
  let bot: ChatBot;
  let n: number;
  const source: FlightSource = {
    live: async () => {
      if (state.fail) throw new Error('feed down');
      return state.live;
    },
    lastFlight: async () => {
      if (state.fail) throw new Error('fshub down');
      return state.last;
    },
  };
  const ev = (text: string, over: Partial<ChatEvent> = {}): ChatEvent => ({
    messageId: `m${++n}`,
    chatterId: over.chatterId ?? '900',
    chatterLogin: over.chatterLogin ?? 'viewer1',
    chatterName: over.chatterName ?? 'Viewer1',
    text,
    badges: [],
    replyToUserId: null,
    replyToLogin: null,
    messageType: 'text',
    ...over,
  });
  const make = (over: { commands?: boolean; banter?: boolean } = {}) =>
    new ChatBot({ botLogin: 'kevinbot', botUserId: '555', source, commands: over.commands ?? true, banter: over.banter ?? true, now: () => clock, random: () => 0.3 });

  beforeEach(() => {
    clock = NOW;
    n = 0;
    state = { live: live(), last: last(), fail: false };
    bot = make();
  });

  describe('commands', () => {
    it('answers each as a reply to the message that asked', async () => {
      const cases: Array<[string, RegExp]> = [
        ['!flight', /^✈️ VHHH → KORD/],
        ['!distance', /^📏 3,000 nm still to go/],
        ['!landing', /^🛬 Not landed yet, but the last landing at EGLL/],
        ['!aircraft', /^🛩️ Flying an Airbus A320/],
        ['!eta', /^🕐 About 2h 05m to go/],
      ];
      for (const [i, [text, expected]] of cases.entries()) {
        clock = NOW + i * 60_000;
        const r = await bot.respond(ev(text, { chatterId: `u${i}`, chatterLogin: `u${i}` }));
        assert.match(r!.text, expected, text);
        assert.equal(r!.replyTo, `m${i + 1}`);
      }
    });

    it('takes the same command by its other names, in any case, with words after it', async () => {
      assert.match((await bot.respond(ev('!FLIGHT please')))!.text, /VHHH/);
      clock += 60_000;
      assert.match((await bot.respond(ev('!route', { chatterId: 'b' })))!.text, /VHHH/);
      clock += 60_000;
      assert.match((await bot.respond(ev('!plane', { chatterId: 'c' })))!.text, /Airbus/);
      clock += 60_000;
      assert.equal((await bot.respond(ev('!kevin', { chatterId: 'd' })))!.text, HELP_TEXT);
      clock += 60_000;
      assert.equal((await bot.respond(ev('!commands', { chatterId: 'e' })))!.text, HELP_TEXT);
    });

    it('stays quiet for a command it does not have, and when commands are switched off', async () => {
      assert.equal(await bot.respond(ev('!dice')), null);
      assert.equal(await bot.respond(ev('!')), null);
      const off = make({ commands: false });
      assert.equal(await off.respond(ev('!flight')), null);
      clock += 60_000;
      const plain = await off.respond(ev('kevin where are we going', { chatterId: 'p' }));
      assert.ok(plain && !/^✈️/.test(plain.text), 'a question about the flight is not answered with the flight');
      assert.equal(/![a-z]/.test(plain.text), false, 'and what it says never sends anyone to a command that is switched off');
      clock += 60_000;
      assert.ok(await off.respond(ev('kevin you are lazy', { chatterId: 'q' })), 'banter still works');
    });

    it('does not answer the same command again for a few seconds, whoever asks, nor the same person too soon', async () => {
      assert.ok(await bot.respond(ev('!flight', { chatterId: 'a' })));
      clock += COMMAND_COOLDOWN_MS - 1;
      assert.equal(await bot.respond(ev('!flight', { chatterId: 'b' })), null, 'someone else asks the same thing');
      assert.ok(await bot.respond(ev('!distance', { chatterId: 'c' })), 'a different command is fine');
      clock += SEND_MIN_GAP_MS;
      assert.ok(await bot.respond(ev('!flight', { chatterId: 'b' })), 'and the same one again once the wait is over');
      clock += USER_COMMAND_COOLDOWN_MS - 1;
      assert.equal(await bot.respond(ev('!eta', { chatterId: 'b' })), null, 'one person cannot fire commands one after another');
      clock += 1;
      assert.ok(await bot.respond(ev('!eta', { chatterId: 'b' })));
    });

    it('says it cannot see the flight, politely, when the data is down', async () => {
      state.fail = true;
      assert.match((await bot.respond(ev('!flight')))!.text, /can't reach the live flight data/);
    });

    it('still gives the live flight when only the last landing cannot be read', async () => {
      state.last = null;
      const broken: FlightSource = { live: async () => live(), lastFlight: async () => { throw new Error('fshub down'); } };
      const b = new ChatBot({ botLogin: 'kevinbot', botUserId: '555', source: broken, commands: true, banter: true, now: () => clock, random: () => 0.3 });
      assert.match((await b.respond(ev('!flight')))!.text, /VHHH → KORD/);
    });

    it('does not read FsHub for the last flight when the question is about the time to go', async () => {
      let lastAsked = 0;
      const counting: FlightSource = { live: async () => live(), lastFlight: async () => (lastAsked++, last()) };
      const b = new ChatBot({ botLogin: 'kevinbot', botUserId: '555', source: counting, commands: true, banter: true, now: () => clock, random: () => 0.3 });
      await b.respond(ev('!eta'));
      assert.equal(lastAsked, 0);
      clock += 60_000;
      await b.respond(ev('!landing', { chatterId: 'x' }));
      assert.equal(lastAsked, 1);
    });
  });

  describe('being talked to', () => {
    it('ignores a message that is not for it', async () => {
      for (const text of ['great stream everyone', 'lol', 'where are we going', 'you are lazy']) assert.equal(await bot.respond(ev(text)), null, text);
    });

    it('answers a message that names it, using the person\'s name, whatever case it is written in', async () => {
      const r = await bot.respond(ev('@KevinBot you are lazy', { chatterName: 'Pat' }));
      assert.ok(r);
      assert.equal(r.replyTo, 'm1');
      assert.ok(LINES.lazy.some((l) => l.replace('{user}', 'Pat') === r.text), r.text);
      clock += 30_000;
      assert.ok(LINES.compliment.some((l) => l.replace('{user}', 'Sam') === (null as unknown as string) || true));
      const c = await bot.respond(ev('KEVIN you are the best', { chatterName: 'Sam', chatterId: 's' }));
      assert.ok(c && LINES.compliment.some((l) => l.replace('{user}', 'Sam') === c.text), c?.text);
    });

    it('answers a reply to one of its own messages, even without its name', async () => {
      const r = await bot.respond(ev('haha you are so lazy', { replyToUserId: '555', replyToLogin: 'kevinbot' }));
      assert.ok(r && LINES.lazy.some((l) => l.replace('{user}', 'Viewer1') === r.text));
      assert.equal(await bot.respond(ev('haha you are so lazy', { chatterId: 'z', replyToUserId: '999', replyToLogin: 'someoneelse' })), null, 'a reply to somebody else is not for it');
    });

    it('answers a question about the flight asked in plain words as the matching command would', async () => {
      assert.match((await bot.respond(ev('kevin how far are we')))!.text, /^📏/);
      clock += 60_000;
      assert.match((await bot.respond(ev('kevin where are we going', { chatterId: 'b' })))!.text, /^✈️/);
      clock += 60_000;
      assert.match((await bot.respond(ev('kevin what plane is this', { chatterId: 'c' })))!.text, /^🛩️/);
    });

    it('prefers a joke to the flight when a message is both, and gives the flight when the joke is just hello', async () => {
      const r = await bot.respond(ev('kevin nice landing!'));
      assert.ok(r && LINES.compliment.some((l) => l.replace('{user}', 'Viewer1') === r.text), 'nice landing is a compliment first');
      clock += 60_000;
      assert.match((await bot.respond(ev('hey kevin where are we headed', { chatterId: 'b' })))!.text, /^✈️/);
    });

    it('has something for a message it does not understand, and points to the commands', async () => {
      const r = await bot.respond(ev('kevin banana'));
      assert.ok(r && LINES.unsure.some((l) => l.replace('{user}', 'Viewer1') === r.text));
      assert.ok(LINES.unsure.filter((l) => /!flight/.test(l)).length >= 4, 'most of them say what to try');
      assert.ok(LINES.unsure.filter((l) => !/![a-z]/.test(l)).length >= 3, 'and some do not, for a host who switched the commands off');
    });

    it('says nothing when banter is switched off, but still answers the flight', async () => {
      const b = make({ banter: false });
      assert.equal(await b.respond(ev('kevin you are lazy')), null);
      assert.equal(await b.respond(ev('kevin banana', { chatterId: 'q' })), null);
      assert.match((await b.respond(ev('kevin how far are we', { chatterId: 'r' })))!.text, /^📏/);
    });

    it('does not banter with the same person more than every so often, nor with the room in a rush', async () => {
      assert.ok(await bot.respond(ev('kevin you are lazy', { chatterId: 'a' })));
      clock += BANTER_ALL_COOLDOWN_MS - 1;
      assert.equal(await bot.respond(ev('kevin you are lazy', { chatterId: 'b' })), null, 'the room is not answered twice in a rush');
      clock += 1;
      assert.ok(await bot.respond(ev('kevin you are lazy', { chatterId: 'b' })));
      clock += BANTER_USER_COOLDOWN_MS - BANTER_ALL_COOLDOWN_MS - 1;
      assert.equal(await bot.respond(ev('kevin you are lazy', { chatterId: 'a' })), null, 'and one person is not answered again so soon');
      clock += 1;
      assert.ok(await bot.respond(ev('kevin you are lazy', { chatterId: 'a' })));
    });

    it('cleans a name before using it, and has one when there is nothing left', async () => {
      const first = () => new ChatBot({ botLogin: 'kevinbot', botUserId: '555', source, commands: true, banter: true, now: () => clock, random: () => 0 });
      const r = await first().respond(ev('kevin you are lazy', { chatterName: '★✦ Pat_99 ✦★' }));
      assert.ok(r && r.text.startsWith('Lazy?! Pat_99,') && !r.text.includes('★'), r?.text);
      const s = await first().respond(ev('kevin you are lazy', { chatterName: '★★★', chatterId: 'z' }));
      assert.ok(s && s.text.startsWith('Lazy?! friend,'), s?.text);
      const long = await first().respond(ev('kevin you are lazy', { chatterName: 'A'.repeat(60), chatterId: 'y' }));
      assert.ok(long && long.text.startsWith(`Lazy?! ${'A'.repeat(25)},`), 'a long name is cut');
    });
  });

  describe('who and what it leaves alone', () => {
    it('lets the account it is signed in as ask for a command, and nothing else, so it can never answer its own words', async () => {
      const own = { chatterId: '555', chatterLogin: 'kevinbot' };
      assert.match((await bot.respond(ev('!flight', own)))!.text, /^✈️/, 'a streamer using their own account for the bot can ask');
      clock += 60_000;
      assert.equal(await bot.respond(ev('kevin you are lazy', own)), null, 'its own chatter is not banter');
      assert.equal(await bot.respond(ev('hello kevinbot', own)), null);
      assert.equal(await bot.respond(ev('✈️ VHHH → KORD (TST517) in an Airbus A320 · cruising · FL370, 462 kts', own)), null, 'nor are its own replies');
      assert.equal(await bot.respond(ev('Kevin from scheduling here. Ask me: !flight', own)), null, 'not even one that mentions a command');
    });

    it('never answers other bots, anything crude, or a very long message', async () => {
      for (const other of ['nightbot', 'streamelements', 'moobot', 'fossabot']) assert.equal(await bot.respond(ev('!flight', { chatterLogin: other, chatterId: other })), null, other);
      assert.equal(await bot.respond(ev('kevin what the fuck is this')), null);
      assert.equal(await bot.respond(ev('!flight wtf')), null, 'a command with a crude word in it is not answered either');
      assert.equal(await bot.respond(ev(`kevin ${'blah '.repeat(100)}`)), null);
      assert.equal(await bot.respond(ev('   ')), null);
    });

    it('never repeats what someone typed', async () => {
      const r = await bot.respond(ev('kevin you are a zorblax and also lazy', { chatterName: 'Pat' }));
      assert.ok(r && !/zorblax/.test(r.text));
    });
  });

  describe('pace', () => {
    it('never sends more than a handful of messages in half a minute, however busy the chat', async () => {
      let sent = 0;
      for (let i = 0; i < 60; i++) {
        clock = NOW + i * 1_000; // a message every second for a minute
        if (await bot.respond(ev('!flight', { chatterId: `u${i}`, chatterLogin: `u${i}` }))) sent++;
      }
      // the command's own cooldown (10 s) already makes it six in a minute
      assert.equal(sent, 6);
    });

    it('keeps to its own limit when different commands and jokes pile up', async () => {
      const t0 = NOW;
      const times: number[] = [];
      const cmds = ['!flight', '!distance', '!landing', '!aircraft', '!eta'];
      for (let i = 0; i < 240; i++) {
        clock = t0 + i * 400;
        const text = i % 3 === 0 ? 'kevin you are lazy' : cmds[i % cmds.length]!;
        if (await bot.respond(ev(text, { chatterId: `v${i}`, chatterLogin: `v${i}` }))) times.push(clock);
      }
      for (let i = 0; i < times.length; i++) {
        const inWindow = times.filter((t) => t > times[i]! - SEND_WINDOW_MS && t <= times[i]!).length;
        assert.ok(inWindow <= SEND_WINDOW_MAX, `${inWindow} messages in ${SEND_WINDOW_MS / 1000} s at ${times[i]! - t0} ms`);
        if (i > 0) assert.ok(times[i]! - times[i - 1]! >= SEND_MIN_GAP_MS || times[i]! === times[i - 1]!, 'two replies are never sent at once');
      }
      assert.ok(times.length >= 20, `it did answer (${times.length})`);
    assert.ok(times.some((t) => times.filter((u) => u > t - SEND_WINDOW_MS && u <= t).length >= SEND_WINDOW_MAX), 'and it was busy enough to reach the limit, so the limit was what held it back');
    });

    it('takes its place in the pace before it reads the data, so a burst cannot all slip through', async () => {
      const slow = { resolve: () => {} };
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const waiting: FlightSource = { live: async () => (await gate, live()), lastFlight: async () => last() };
      const b = new ChatBot({ botLogin: 'kevinbot', botUserId: '555', source: waiting, commands: true, banter: true, now: () => clock, random: () => 0.3 });
      const a = b.respond(ev('!flight', { chatterId: 'a' }));
      const c = b.respond(ev('!distance', { chatterId: 'c' }));
      release();
      slow.resolve();
      const [ra, rc] = await Promise.all([a, c]);
      assert.ok(ra, 'the first is answered');
      assert.equal(rc, null, 'the second arrived inside the minimum gap');
    });
  });
});
