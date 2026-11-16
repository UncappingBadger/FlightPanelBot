import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { componentHandlers } from '../src/discord/commands/index.js';
import { helpCommand } from '../src/discord/commands/help.js';
import { handleDmMessage } from '../src/discord/dm.js';
import { METAR_COOLDOWN_MS, MAX_REPORTS, splitReports } from '../src/discord/weather.js';
import { METAR_FOOTER } from '../src/discord/metarUi.js';
import { MetarError } from '../src/metar/client.js';
import { makeHarness, sj, USER_A, USER_B, T0, type Harness } from './helpers.js';
import { fakeComponent, fakeDm, FakeMetar, FakeUser, makeDiscordHarness, settle, type DiscordHarness } from './discord-helpers.js';

const EGLL = 'EGLL 161350Z COR 26008KT 230V290 9999 NSC 08/01 Q1006 NOSIG';
const KJFK = 'KJFK 161351Z 35011KT 10SM FEW028 08/01 A3039 RMK SLP291 T00830011';
const KORD = 'KORD 161451Z 31018G28KT 1 1/2SM -RA BR BKN008 OVC015 09/08 A2992 RMK AO2 SLP132';
const LFPG = 'LFPG 161430Z 27015G25KT 240V300 3000 R27L/1200U +TSRA BKN005 OVC030CB 14/13 Q0998 RETS WS R27L TEMPO 1500';

/** The module remembers when each person last asked (to enforce a pause), so each test starts at a different time. */
let testNo = 0;

describe('asking the bot for a weather report in a DM', () => {
  let h: Harness;
  let d: DiscordHarness;
  let alice: FakeUser;
  let bob: FakeUser;
  let metar: FakeMetar;

  beforeEach(async () => {
    h = await makeHarness();
    h.clock.now = T0 + ++testNo * 3_600_000;
    metar = new FakeMetar();
    metar.reports.set('EGLL', EGLL);
    metar.reports.set('KJFK', KJFK);
    metar.reports.set('KORD', KORD);
    metar.reports.set('LFPG', LFPG);
    d = makeDiscordHarness(h, { metar });
    alice = d.client.user(new FakeUser(USER_A.discordId, USER_A.username));
    bob = d.client.user(new FakeUser(USER_B.discordId, USER_B.username));
  });
  afterEach(async () => {
    await settle(40);
    await h.close();
  });

  const say = (user: FakeUser, text: string) => handleDmMessage(d.ctx, fakeDm(user, text));
  /** The cards (embeds) the bot sent a person, as plain data, oldest first. */
  const cards = (user: FakeUser) => user.dms.flatMap((m) => (m.embeds ?? []) as Array<{ toJSON(): any }>).map((e) => e.toJSON());
  const texts = (user: FakeUser) => user.dms.map((m) => String(m.content ?? '')).filter(Boolean);
  const field = (card: any, name: string): string => (card.fields ?? []).find((f: any) => f.name === name)?.value ?? '';

  describe('metar EGLL', () => {
    it('fetches the report for the airport and answers with it in plain language', async () => {
      await say(alice, 'metar EGLL');
      assert.deepEqual(metar.calls, ['EGLL']);
      const [card] = cards(alice);
      assert.equal(card.title, '🌦️ Weather at EGLL');
      assert.match(card.description, /^\*\*In short:\*\* Moderate wind from the west at 8 knots, very good visibility, no significant weather, no significant cloud, 8°C\. Flying conditions by the US-style rating: VFR\.\nObserved <t:\d+:f> \(<t:\d+:R>\)\. Fetched from VATSIM\.$/);
      assert.match(field(card, 'Wind'), /^From the west \(260°\), at 8 knots \(15 km\/h\)/);
      assert.match(field(card, 'Pressure'), /^1006 hPa/);
      assert.equal(field(card, 'The report as written'), `\`\`\`\n${EGLL}\n\`\`\``);
      assert.equal(card.footer.text, METAR_FOOTER);
      assert.match(METAR_FOOTER, /for flight simulation only/);
    });

    it('is the same however it is written: any case, extra words, commas', async () => {
      for (const text of ['METAR egll', 'metar   EGLL', 'Metar for EGLL please', 'metar EGLL,', 'metar\nEGLL']) {
        alice.dms.length = 0;
        h.clock.advance(METAR_COOLDOWN_MS + 1);
        await say(alice, text);
        assert.equal(cards(alice).length, 1, text);
        assert.equal(cards(alice)[0].title, '🌦️ Weather at EGLL', text);
        assert.deepEqual(texts(alice), [], `${text}: nothing but the card`);
      }
    });

    it('colours the card by the flying conditions, and gives the rating with what it means', async () => {
      await say(alice, 'metar EGLL');
      assert.equal(cards(alice)[0].color, 0x2ecc71);
      assert.match(field(cards(alice)[0], 'Flying conditions: VFR (US-style rating)'), /^VFR: good for flying by sight .*\nThese names come from the US\. Most countries do not use them/);
      h.clock.advance(METAR_COOLDOWN_MS + 1);
      await say(alice, 'metar KORD');
      const ord = cards(alice)[1];
      assert.equal(ord.color, 0xe74c3c, 'IFR is red');
      assert.match(field(ord, 'Flying conditions: IFR (US-style rating)'), /These ratings are in everyday use in the US and Canada\./);
    });

    it('explains the parts in boxes, in the order of the report, with the remarks last before the report itself', async () => {
      await say(alice, 'metar KJFK');
      const names = (cards(alice)[0].fields as any[]).map((f) => f.name);
      assert.deepEqual(names, ['Wind', 'Visibility', 'Weather', 'Clouds', 'Temperature', 'Pressure', 'Remarks', 'Flying conditions: VFR (US-style rating)', 'The report as written']);
    });

    it('says what it left as written, when it could not translate something', async () => {
      metar.reports.set('KTST', 'KTST 161351Z 35011KT 10SM FEW028 08/01 A3039 FOOBAR RMK AO2 CIG 005V010');
      await say(alice, 'metar KTST');
      assert.match(field(cards(alice)[0], 'Left as written'), /^I couldn't translate: `FOOBAR` `CIG` `005V010`\nRemarks differ from country to country/);
    });

    it('does not let a report break out of its box', async () => {
      metar.reports.set('KEVL', 'KEVL 161351Z 35011KT 10SM FEW028 08/01 A3039 RMK ``` @everyone <@123456789012345678> ```');
      await say(alice, 'metar KEVL');
      const card = cards(alice)[0];
      const written = field(card, 'The report as written');
      assert.equal((written.match(/```/g) ?? []).length, 2, 'only its own two fences');
      assert.doesNotMatch(field(card, 'Left as written'), /@|<@/);
      assert.deepEqual(alice.dms[0].allowedMentions, { parse: [] }, 'and nobody is pinged');
    });

    it('stays inside the size Discord allows for a card, even for a long report', async () => {
      metar.reports.set('LONG', `LONG 161350Z 27015G25KT 240V300 3000 1400SW R27L/1200U R26R/0800VP2000D +TSRA -SN BR FZFG BKN005 OVC030CB FEW040TCU 14/13 Q0998 RETS WS R27L WS ALL RWY W12/H75 R10R/290193 BLACKWHT TEMPO 1500 FG BECMG FM1100 25035G50KT 6000 BKN020 RMK ${'AO2 SLP141 CIG 005V010 '.repeat(25)}`);
      await say(alice, 'metar LONG');
      const c = cards(alice)[0];
      const size = (c.title?.length ?? 0) + (c.description?.length ?? 0) + (c.footer?.text.length ?? 0) + (c.fields ?? []).reduce((n: number, f: any) => n + f.name.length + f.value.length, 0);
      assert.ok(size <= 6000, `card is ${size} characters`);
      for (const f of c.fields) assert.ok(f.value.length <= 1024, `${f.name}: ${f.value.length}`);
      assert.ok((c.fields ?? []).length <= 25);
    });
  });

  describe('several airports', () => {
    it('answers each in its own card, in the order asked', async () => {
      await say(alice, 'metar EGLL KJFK');
      assert.deepEqual(metar.calls, ['EGLL', 'KJFK']);
      assert.deepEqual(cards(alice).map((c) => c.title), ['🌦️ Weather at EGLL', '🌦️ Weather at KJFK']);
    });

    it('asks for each airport once', async () => {
      await say(alice, 'metar EGLL egll, EGLL');
      assert.deepEqual(metar.calls, ['EGLL']);
    });

    it(`answers the first ${MAX_REPORTS} and says so about the rest`, async () => {
      await say(alice, 'metar EGLL KJFK KORD LFPG');
      assert.deepEqual(metar.calls, ['EGLL', 'KJFK', 'KORD']);
      assert.equal(cards(alice).length, 3);
      assert.match(texts(alice).at(-1) ?? '', /I answered the first 3 airports\. Ask again for the rest\./);
    });

    it('goes on to the next when one airport has no report', async () => {
      await say(alice, 'metar ZZZZ EGLL');
      assert.match(texts(alice)[0] ?? '', /^VATSIM has no weather report for \*\*ZZZZ\*\* right now\./);
      assert.equal(cards(alice)[0].title, '🌦️ Weather at EGLL');
    });
  });

  describe('what is not an airport code', () => {
    it('explains the code it needs, without asking VATSIM, when given nothing it can use', async () => {
      await say(alice, 'metar JFK');
      assert.deepEqual(metar.calls, []);
      assert.match(texts(alice)[0] ?? '', /^I couldn't use `JFK` as an airport code\. I need the four-letter ICAO code, like `EGLL` for London Heathrow or `KJFK` for New York JFK \(US airports start with a K, so JFK is KJFK\)\.$/);
    });

    it('never asks for a short code or "all", which VATSIM reads as every airport starting that way, or every airport', async () => {
      for (const text of ['metar EG', 'metar all', 'metar E', 'metar ../x', 'metar EGLL/../x', 'metar %2e%2e', 'metar ????', 'metar EGLLL']) {
        alice.dms.length = 0;
        metar.calls.length = 0;
        h.clock.advance(METAR_COOLDOWN_MS + 1);
        await say(alice, text);
        assert.deepEqual(metar.calls, [], text);
        assert.equal(cards(alice).length, 0, text);
        assert.match(texts(alice).at(-1) ?? '', /four-letter ICAO code/, text);
      }
    });

    it('skips what is not a code and answers what is', async () => {
      await say(alice, 'metar JFK EGLL');
      assert.match(texts(alice)[0] ?? '', /^I skipped `JFK`: not four-letter airport codes\.$/);
      assert.equal(cards(alice)[0].title, '🌦️ Weather at EGLL');
      assert.deepEqual(metar.calls, ['EGLL']);
    });

    it('shows what it skipped safely', async () => {
      await say(alice, 'metar `@everyone` EGLL');
      assert.doesNotMatch(texts(alice)[0] ?? '', /`@everyone`|@everyone/);
    });

    it('explains how to use it when sent on its own', async () => {
      await say(alice, 'metar');
      assert.match(texts(alice)[0] ?? '', /^\*\*Weather reports \(METAR\)\.\*\* Send me `metar` and an airport code, like `metar EGLL`/);
      assert.match(texts(alice)[0] ?? '', /Paste it after `metar`/);
      assert.deepEqual(metar.calls, []);
    });
  });

  describe('when VATSIM has nothing, or cannot be reached', () => {
    it('says there is no report, and how that can be', async () => {
      await say(alice, 'metar ZZZZ');
      assert.equal(texts(alice)[0], "VATSIM has no weather report for **ZZZZ** right now. Check the code (it is the four-letter ICAO one, like `EGLL`), and note that small airfields often have no weather station.");
    });

    it('says plainly when the service cannot be reached, and stops', async () => {
      metar.error = new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
      await say(alice, 'metar EGLL KJFK');
      assert.deepEqual(texts(alice), ["I couldn't reach VATSIM's weather service right now."]);
      assert.deepEqual(metar.calls, ['EGLL'], 'it does not ask again for the next airport');
    });

    it('says when VATSIM sent a report it cannot read', async () => {
      metar.reports.set('KBAD', 'KBAD NIL junk');
      await say(alice, 'metar KBAD');
      assert.match(texts(alice)[0] ?? '', /^VATSIM sent a report for \*\*KBAD\*\* that I couldn't read: `KBAD NIL junk`$/);
    });

    it('says a NIL report is a station that sent nothing', async () => {
      metar.reports.set('EDDF', 'EDDF 161350Z NIL');
      await say(alice, 'metar EDDF');
      assert.match(cards(alice)[0].description, /^EDDF sent no weather report for the 16th at 13:50 UTC \(NIL\)\./);
    });

    it('passes on any other failure, as it does for every other command', async () => {
      metar.error = new Error('boom');
      await assert.rejects(say(alice, 'metar EGLL'), /boom/);
    });
  });

  describe('a METAR pasted in', () => {
    it('translates it without asking VATSIM, when pasted after the word metar', async () => {
      await say(alice, `metar ${KJFK}`);
      assert.deepEqual(metar.calls, []);
      assert.equal(cards(alice)[0].title, '🌦️ Weather at KJFK');
      assert.doesNotMatch(cards(alice)[0].description, /Fetched from VATSIM/);
      assert.match(field(cards(alice)[0], 'Visibility'), /^10 statute miles/);
    });

    it('translates it when pasted on its own, with or without the METAR word', async () => {
      await say(alice, KORD);
      h.clock.advance(METAR_COOLDOWN_MS + 1);
      await say(alice, `METAR ${LFPG}=`);
      assert.deepEqual(metar.calls, []);
      assert.deepEqual(cards(alice).map((c) => c.title), ['🌦️ Weather at KORD', '🌦️ Weather at LFPG']);
      assert.match(field(cards(alice)[1], 'Weather'), /Thunderstorm with heavy rain\./);
    });

    it('translates several, one to a line or ending in =', async () => {
      await say(alice, `${EGLL}\n${KJFK}`);
      assert.deepEqual(cards(alice).map((c) => c.title), ['🌦️ Weather at EGLL', '🌦️ Weather at KJFK']);
      alice.dms.length = 0;
      h.clock.advance(METAR_COOLDOWN_MS + 1);
      await say(alice, `${EGLL}=\n${KJFK}=`);
      assert.equal(cards(alice).length, 2);
    });

    it('joins one report that was copied over several lines', async () => {
      await say(alice, 'EGLL 161350Z 26008KT\n9999 NSC\n08/01 Q1006');
      assert.equal(cards(alice).length, 1);
      assert.match(field(cards(alice)[0], 'The report as written'), /EGLL 161350Z 26008KT 9999 NSC 08\/01 Q1006/);
    });

    it(`translates the first ${MAX_REPORTS} and says so about the rest`, async () => {
      await say(alice, [EGLL, KJFK, KORD, LFPG].join('\n'));
      assert.equal(cards(alice).length, 3);
      assert.match(texts(alice).at(-1) ?? '', /I translated the first 3\. Send the rest in another message\./);
    });

    it('does not take a forecast (TAF) for a METAR, and says so', async () => {
      await say(alice, 'metar TAF EGLL 161100Z 1612/1718 26008KT 9999 NSC');
      assert.match(texts(alice)[0] ?? '', /^That looks like a forecast \(a TAF\)\. I only translate METARs/);
      assert.equal(cards(alice).length, 0);
    });

    it('says when it cannot read what was pasted', async () => {
      await say(alice, 'metar hello world 161350Z');
      assert.match(texts(alice)[0] ?? '', /^I couldn't read `HELLO WORLD 161350Z`|^I couldn't read `hello world 161350Z` as a METAR\./);
    });

    it('translates a report with the end of the line it came from, in any case', async () => {
      await say(alice, 'egll 161350z 26008kt 9999 nsc 08/01 q1006');
      assert.equal(cards(alice)[0].title, '🌦️ Weather at EGLL');
    });

    it('works when VATSIM cannot be reached, because a pasted report never asks it', async () => {
      metar.error = new MetarError('unavailable', "I couldn't reach VATSIM's weather service right now.");
      await say(alice, `metar ${EGLL}`);
      await say(alice, KJFK);
      assert.deepEqual(cards(alice).map((c) => c.title), ['🌦️ Weather at EGLL', '🌦️ Weather at KJFK']);
      assert.deepEqual(texts(alice), []);
      assert.deepEqual(metar.calls, []);
    });

    it('is never held up by the pause between lookups, one after another', async () => {
      for (let i = 0; i < 4; i++) await say(alice, i % 2 === 0 ? `metar ${EGLL}` : KJFK);
      assert.equal(cards(alice).length, 4);
      assert.deepEqual(texts(alice), []);
    });

    it('does not use up the pause for a lookup that follows', async () => {
      await say(alice, `metar ${EGLL}`);
      await say(alice, 'metar KJFK');
      assert.deepEqual(metar.calls, ['KJFK']);
      assert.equal(cards(alice).length, 2);
    });

    it('translates a report copied without its airport, after the word metar', async () => {
      await say(alice, 'metar 161350Z 26008KT 9999 NSC 08/01 Q1006');
      const [card] = cards(alice);
      assert.equal(card.title, '🌦️ Weather report');
      assert.match(card.description, /^\*\*In short:\*\* Moderate wind from the west at 8 knots/);
      assert.deepEqual(metar.calls, []);
    });

    it('translates a pasted report whatever its country: metres and Q, miles and A, metres per second', async () => {
      for (const report of ['UUEE 161430Z 24005MPS CAVOK 04/M02 Q1020 NOSIG', 'CYYZ 161400Z 27015G25KT 15SM -SN SCT015 BKN025 M02/M04 A2990 RMK SC3SC2 SLP120', 'YSSY 161400Z AUTO 26007KT 9999 // NCD 16/12 Q1018']) {
        alice.dms.length = 0;
        await say(alice, report);
        assert.equal(cards(alice).length, 1, report);
      }
    });

    it('splits pasted reports sensibly', () => {
      assert.deepEqual(splitReports(`${EGLL}\n${KJFK}`), [EGLL, KJFK]);
      assert.deepEqual(splitReports(`${EGLL}=${KJFK}=`), [EGLL, KJFK]);
      assert.deepEqual(splitReports('EGLL 161350Z\n26008KT 9999'), ['EGLL 161350Z 26008KT 9999']);
      assert.deepEqual(splitReports('  \n\n '), []);
    });
  });

  describe('limits', () => {
    it('asks people to wait a moment between requests, so a busy chat cannot flood VATSIM', async () => {
      await say(alice, 'metar EGLL');
      await say(alice, 'metar KJFK');
      assert.deepEqual(texts(alice), ['One moment, then ask again.']);
      assert.deepEqual(metar.calls, ['EGLL']);
      h.clock.advance(METAR_COOLDOWN_MS - 1);
      await say(alice, 'metar KJFK');
      assert.equal(texts(alice).length, 2, 'still too soon');
      h.clock.advance(2);
      await say(alice, 'metar KJFK');
      assert.deepEqual(metar.calls, ['EGLL', 'KJFK']);
    });

    it('is a pause for each person, not for everyone', async () => {
      await say(alice, 'metar EGLL');
      await say(bob, 'metar KJFK');
      assert.deepEqual(metar.calls, ['EGLL', 'KJFK']);
    });

    it('does not start a second request for someone whose first is still being answered', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow = metar.report.bind(metar);
      metar.report = async (code: string) => {
        await gate;
        return slow(code);
      };
      const first = say(alice, 'metar EGLL');
      await settle(10);
      await say(alice, 'metar KJFK');
      assert.deepEqual(texts(alice), ["I'm still working on your last request. Give me a moment."]);
      release();
      await first;
      assert.equal(cards(alice).length, 1);
      assert.deepEqual(metar.calls, ['EGLL']);
    });
  });

  describe('beside the Reserve conversation', () => {
    it('leaves an open conversation alone, and does not count as a wrong flight ID', async () => {
      h.jobs.sync(h.panel.id, [sj('a', 'EGLL-EGKK')]);
      await d.panels.refresh(h.panel.id);
      const press = fakeComponent(alice, `panel:reserve:${h.panel.id}`, {});
      await componentHandlers.find((x) => x.prefix === 'panel')!.handle(d.ctx, press.i);
      assert.equal(h.store.getSession(alice.id, h.clock.now)?.attempts, 0);
      await say(alice, 'metar EGLL');
      assert.equal(cards(alice).length, 1);
      assert.equal(h.store.getSession(alice.id, h.clock.now)?.attempts, 0, 'not counted as a mistyped flight ID');
      await say(alice, 'TST-001');
      assert.match(alice.lastText, /^✅ \*\*TST-001\*\*/, 'and the conversation carries on');
    });

    it('is not triggered by an ordinary flight ID or other messages', async () => {
      for (const text of ['TST-001', 'hello', 'cancel', 'weather', 'metars', 'metar-ish']) {
        h.clock.advance(60_000);
        await say(alice, text).catch(() => undefined);
      }
      assert.deepEqual(metar.calls, []);
      assert.equal(cards(alice).length, 0);
    });

    it('is in /help, which still fits the size Discord allows for a message', async () => {
      let embed: any;
      await (helpCommand as any).execute(d.ctx, { reply: async (p: any) => (embed = p.embeds[0].toJSON()) });
      const field = embed.fields.find((f: any) => f.name === 'Weather reports (METAR)');
      assert.match(field.value, /DM me `metar EGLL` .* explain it in plain language\. Paste a METAR after `metar`, or on its own, and I translate that instead\.$/);
      const size = embed.title.length + embed.description.length + embed.footer.text.length + embed.fields.reduce((n: number, f: any) => n + f.name.length + f.value.length, 0);
      assert.ok(size < 6000, `/help is ${size} characters`);
      for (const f of embed.fields) assert.ok(f.value.length <= 1024, f.name);
    });

    it('is mentioned in the short pointer people get when they message the bot with nothing open', async () => {
      await say(alice, 'hello');
      assert.match(alice.lastText, /`metar EGLL` \(any airport code\) for a weather report in plain language, or `notifications` to choose which messages I send you\.$/);
    });
  });
});
