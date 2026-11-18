import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FsHubFlight } from '../src/fshub/client.js';
import type { LiveDetail } from '../src/fshub/liveFeed.js';
import { TwitchBridge, type TwitchStatus } from '../src/twitch/bridge.js';
import type { FlightSource } from '../src/twitch/flightInfo.js';
import { writeTokens, type TwitchTokens } from '../src/twitch/tokens.js';
import type { Logger } from '../src/util/log.js';
import { chatMessage, CLIENT, FakeTimers, FakeTwitchHttp, sockets, welcome } from './twitch-fakes.js';

/* The whole Twitch part of the bot, against a pretend Twitch: sign-in, channel, chat in, replies out. */

const SCOPES = ['user:read:chat', 'user:write:chat'];
const live: LiveDetail = { flightId: 'f1', phase: 'cruise', airborne: true, onGround: false, aircraftIcao: 'A320', callsign: 'TST517', dep: 'VHHH', arr: 'KORD', altitudeFt: 37_000, speedKts: 462, headingDeg: 20, distanceToGoNm: 3000, progressPct: 50, etaMinutes: 125, flightStatus: 'ON-TIME' };
const lastFlight: FsHubFlight = { id: 1, pilotId: 7, pilotName: 'S', dep: 'EINN', arr: 'EGLL', departedAt: null, arrivedAt: Date.now() - 2 * 3_600_000, aircraftIcao: 'A320', aircraftName: 'Airbus A320', scheduleStatus: null, landingRate: -367, distanceNm: 356 };

let tw: FakeTwitchHttp;
let net: ReturnType<typeof sockets>;
let timers: FakeTimers;
let dir: string;
let tokensFile: string;
let statusFile: string;
let bridge: TwitchBridge | null;
let lines: string[];
const log: Logger = { debug: (m) => lines.push(`debug ${m}`), info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
const source: FlightSource = { live: async () => live, lastFlight: async () => lastFlight };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 1000) => {
  for (let waited = 0; !cond() && waited < ms; waited += 5) await sleep(5);
  assert.ok(cond(), 'timed out waiting');
};
const status = (): TwitchStatus => JSON.parse(readFileSync(statusFile, 'utf8')) as TwitchStatus;

const tokens = (over: Partial<TwitchTokens> = {}): TwitchTokens => ({ clientId: CLIENT, accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: Date.now() + 3_600_000, userId: '555', login: 'kevinbot', scopes: SCOPES, ...over });
const make = (over: Partial<ConstructorParameters<typeof TwitchBridge>[0]> = {}) =>
  (bridge = new TwitchBridge({
    tokensFile,
    statusFile,
    channel: 'testair',
    commands: true,
    banter: true,
    feed: { pilotDetail: async () => null },
    fshub: null,
    source,
    fetchFn: tw.fetch,
    socketFactory: net.factory,
    timers,
    random: () => 0.3,
    logger: log,
    ...over,
  }));
/** Start it, and let Twitch say hello so the chat is subscribed. */
const join_ = async () => {
  await bridge!.start();
  await until(() => net.made.length > 0);
  net.made[0]!.emit(welcome());
  await until(() => bridge!.status().state === 'running');
};

beforeEach(() => {
  tw = new FakeTwitchHttp();
  net = sockets();
  timers = new FakeTimers();
  lines = [];
  bridge = null;
  dir = mkdtempSync(join(tmpdir(), 'fpb-bridge-'));
  tokensFile = join(dir, 'twitch.json');
  statusFile = join(dir, 'twitch-status.json');
  tw.valid.set('acc-1', { login: 'kevinbot', userId: '555', scopes: SCOPES, expiresIn: 3000 });
  tw.users.testair = { id: '100', login: 'testair', display_name: 'TestAir' };
  writeTokens(tokensFile, tokens());
});
afterEach(() => {
  bridge?.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Twitch chat in the running bot', () => {
  it('joins the chosen channel, subscribes to its chat, and says so on the setup page', async () => {
    make();
    await join_();
    assert.deepEqual(tw.subscriptions[0], { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '100', user_id: '555' }, transport: { method: 'websocket', session_id: 'sess-1' } });
    const s = status();
    assert.equal(s.state, 'running');
    assert.match(s.detail, /testair/);
    assert.equal(s.login, 'kevinbot');
    assert.equal(s.channel, 'testair');
  });

  it('answers a command as a reply to the message that asked, as the bot\'s own account', async () => {
    make();
    await join_();
    net.made[0]!.emit(chatMessage({ id: 'chat-1', text: '!flight' }));
    await until(() => tw.chat.length === 1);
    assert.equal(tw.chat[0]!.broadcaster_id, '100');
    assert.equal(tw.chat[0]!.sender_id, '555');
    assert.equal(tw.chat[0]!.reply_parent_message_id, 'chat-1');
    assert.match(tw.chat[0]!.message, /^✈️ VHHH → KORD \(TST517\) in an Airbus A320/);
  });

  it('answers a message to it with a joke, and says nothing about the rest of the chat', async () => {
    make();
    await join_();
    net.made[0]!.emit(chatMessage({ id: 'c1', text: 'great stream everyone', user: 'a', userId: '1' }));
    net.made[0]!.emit(chatMessage({ id: 'c2', text: 'kevin you are lazy', user: 'b', userId: '2', name: 'Bea' }));
    await until(() => tw.chat.length === 1);
    await sleep(20);
    assert.equal(tw.chat.length, 1);
    assert.equal(tw.chat[0]!.reply_parent_message_id, 'c2');
    assert.match(tw.chat[0]!.message, /Bea/);
  });

  it('never answers the account it is signed in as, so it cannot talk to itself', async () => {
    make();
    await join_();
    for (const [i, text] of ['!flight', 'kevin you are lazy', '@kevinbot hello'].entries()) net.made[0]!.emit(chatMessage({ id: `own${i}`, text, user: 'kevinbot', userId: '555' }));
    await sleep(40);
    assert.equal(tw.chat.length, 0);
  });

  it('will not join a chat as the channel\'s own account: a release needs an account of its own for the bot', async () => {
    writeTokens(tokensFile, tokens({ login: 'testair' }));
    tw.valid.set('acc-1', { login: 'testair', userId: '100', scopes: SCOPES, expiresIn: 3000 });
    make();
    await bridge!.start();
    assert.equal(bridge!.status().state, 'needs-connect');
    assert.match(bridge!.status().detail, /needs a Twitch account of its own/);
    assert.equal(net.made.length, 0, 'it joined nothing');
    assert.ok(lines.some((l) => l.startsWith('warn Twitch chat: The bot needs a Twitch account of its own')));
    // another account in the same chat is fine
    make({ channel: 'someoneelse' });
    tw.users.someoneelse = { id: '300', login: 'someoneelse', display_name: 'SomeoneElse' };
    await bridge!.start();
    await until(() => net.made.length > 0);
  });

  describe('in a test build, where the bot may use the channel\'s own account', () => {
    it('joins as the channel\'s own account, answers what that account types, and never its own replies', async () => {
      writeTokens(tokensFile, tokens({ login: 'testair' }));
      tw.valid.set('acc-1', { login: 'testair', userId: '100', scopes: SCOPES, expiresIn: 3000 });
      let clock = Date.now();
      make({ ownAccount: true, now: () => clock });
      await join_();
      net.made[0]!.emit(chatMessage({ id: 'mine', text: '!flight', user: 'testair', userId: '100' }));
      await until(() => tw.chat.length === 1);
      assert.equal(tw.chat[0]!.reply_parent_message_id, 'mine');
      clock += 30_000;
      net.made[0]!.emit(chatMessage({ id: 'mine2', text: '@testair hello', user: 'testair', userId: '100' }));
      await until(() => tw.chat.length === 2);
      assert.equal(tw.chat[1]!.reply_parent_message_id, 'mine2');
      // Twitch shows the bot its own replies as well, as replies and with the name in front
      clock += 30_000;
      for (const [i, c] of tw.chat.entries()) {
        net.made[0]!.emit(chatMessage({ id: `echo${i}`, text: `@testair ${c.message}`, user: 'testair', userId: '100', replyTo: { id: '100', login: 'testair' } }));
        net.made[0]!.emit(chatMessage({ id: `bare${i}`, text: c.message, user: 'testair', userId: '100' }));
      }
      await sleep(60);
      assert.equal(tw.chat.length, 2, 'nothing more was said');
    });
  });

  it('keeps to its pace: of a burst of questions, only the first is answered at once', async () => {
    make();
    await join_();
    for (const [i, cmd] of ['!flight', '!distance', '!aircraft', '!eta'].entries()) {
      net.made[0]!.emit(chatMessage({ id: `c${i}`, text: cmd, user: `u${i}`, userId: `${i + 10}` }));
    }
    await sleep(50);
    assert.deepEqual(tw.chat.map((c) => c.reply_parent_message_id), ['c0']);
  });

  it('sends its replies one at a time, in the order they were asked, even when Twitch is slow to take one', async () => {
    let clock = Date.now();
    make({ now: () => clock });
    await join_();
    tw.chatDelays = [120];
    net.made[0]!.emit(chatMessage({ id: 'first', text: '!flight', user: 'a', userId: '31' }));
    await sleep(10);
    clock += 3_000; // the pace allows a second reply by now
    net.made[0]!.emit(chatMessage({ id: 'second', text: '!distance', user: 'b', userId: '32' }));
    await until(() => tw.chat.length === 2, 2000);
    assert.deepEqual(tw.chat.map((c) => c.reply_parent_message_id), ['first', 'second']);
  });

  it('does nothing at all until a Twitch account is connected and a channel is chosen', async () => {
    rmSync(tokensFile);
    make();
    await bridge!.start();
    assert.equal(bridge!.status().state, 'off');
    assert.match(bridge!.status().detail, /No Twitch account/);
    assert.equal(tw.seen.length, 0, 'not a request to anyone');
    assert.equal(net.made.length, 0);
    writeTokens(tokensFile, tokens());
    make({ channel: '' });
    await bridge!.start();
    assert.equal(bridge!.status().state, 'off');
    assert.match(bridge!.status().detail, /No Twitch channel/);
    assert.equal(tw.seen.length, 0);
  });

  it('asks to be connected again when Twitch no longer accepts the sign-in, and does not start the chat', async () => {
    tw.valid.clear();
    make();
    await bridge!.start();
    assert.equal(bridge!.status().state, 'needs-connect');
    assert.match(bridge!.status().detail, /Connect to Twitch again/);
    assert.equal(net.made.length, 0);
    assert.equal(status().state, 'needs-connect');
    assert.ok(lines.some((l) => l.startsWith('warn Twitch chat:')));
  });

  it('asks to be connected again when the sign-in lacks permission to send, or to read', async () => {
    tw.valid.set('acc-1', { login: 'kevinbot', userId: '555', scopes: ['user:read:chat'], expiresIn: 3000 });
    make();
    await bridge!.start();
    assert.equal(bridge!.status().state, 'needs-connect');
    assert.match(bridge!.status().detail, /send chat/);
    tw.valid.set('acc-1', { login: 'kevinbot', userId: '555', scopes: [], expiresIn: 3000 });
    make();
    await bridge!.start();
    assert.match(bridge!.status().detail, /(read|send) chat/);
  });

  it('says so when there is no such channel, and does not join anything', async () => {
    make({ channel: 'nosuchchannel' });
    await bridge!.start();
    assert.equal(bridge!.status().state, 'bad-channel');
    assert.match(bridge!.status().detail, /nosuchchannel/);
    assert.equal(net.made.length, 0);
  });

  it('keeps going, quietly, when Twitch cannot be reached, and says what it is doing', async () => {
    tw.down = true;
    make();
    await bridge!.start();
    assert.equal(bridge!.status().state, 'retrying');
    assert.match(bridge!.status().detail, /Trying again in 30 s/);
    assert.equal(net.made.length, 0);
  });

  it('is not allowed to chat in a room that bans it: one warning in the log, not one a message', async () => {
    tw.sendStatus = 403;
    let clock = Date.now();
    make({ now: () => clock });
    await join_();
    for (let i = 0; i < 3; i++) {
      clock += 30_000; // far enough apart that the bot wants to answer each
      net.made[0]!.emit(chatMessage({ id: `x${i}`, text: 'kevin you are lazy', user: `u${i}`, userId: `${i + 20}` }));
      await until(() => tw.sent === i + 1);
    }
    await sleep(10);
    assert.equal(tw.sent, 3, 'it tried each time');
    assert.equal(lines.filter((l) => l.startsWith('warn Twitch chat: the bot is not allowed')).length, 1, 'and said so once');
  });

  it('treats a message Twitch drops (a repeat, slow mode) as nothing to worry about', async () => {
    tw.sendResult = { sent: false, code: 'slow_mode' };
    make();
    await join_();
    net.made[0]!.emit(chatMessage({ id: 'c1', text: '!flight' }));
    await until(() => tw.sent === 1);
    await sleep(10);
    assert.ok(lines.some((l) => l.includes('did not send a reply (slow_mode)')));
    assert.equal(bridge!.status().state, 'running');
  });

  it('checks the sign-in again on a timer, and stops the chat when Twitch no longer accepts it', async () => {
    make({ validateEveryMs: 30 });
    await join_();
    tw.valid.clear();
    tw.refresh.clear();
    await until(() => bridge!.status().state === 'needs-connect', 2000);
    assert.equal(net.made[0]!.closed, true, 'the chat connection is closed');
    assert.equal(status().state, 'needs-connect');
  });

  it('stops when the chat connection says it cannot go on, and says to connect again if that is why', async () => {
    make();
    await join_();
    net.made[0]!.emit({ metadata: { message_id: 'r', message_type: 'revocation' }, payload: { subscription: { type: 'channel.chat.message', status: 'authorization_revoked' } } });
    await until(() => bridge!.status().state === 'needs-connect');
    assert.match(bridge!.status().detail, /taken back/);
  });

  it('can be stopped, and is then off', async () => {
    make();
    await join_();
    bridge!.stop();
    assert.equal(bridge!.status().state, 'off');
    assert.equal(net.made[0]!.closed, true);
    net.made[0]!.emit(chatMessage({ id: 'late', text: '!flight' }));
    await sleep(20);
    assert.equal(tw.chat.length, 0);
    assert.equal(status().state, 'off');
  });

  it('writes no status file when it has nowhere to write one, and does not mind', async () => {
    make({ statusFile: undefined });
    await bridge!.start();
    assert.equal(existsSync(statusFile), false);
  });

  it('uses the live feed and FsHub when no test source is given', async () => {
    make({ source: undefined, feed: { pilotDetail: async (id) => (id === 7 ? live : null) }, fshub: { account: async () => ({ id: 7, name: 'Streamer', premium: false }), pilotRecentFlights: async () => [lastFlight] } });
    await join_();
    net.made[0]!.emit(chatMessage({ id: 'c1', text: '!landing' }));
    await until(() => tw.chat.length === 1);
    assert.match(tw.chat[0]!.message, /^🛬 Not landed yet, but the last landing at EGLL/);
  });
});
