import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { chatEventOf, EventSubClient, type ChatEvent, type EventSubState } from '../src/twitch/eventsub.js';
import { TwitchApiError } from '../src/twitch/helix.js';
import { chatMessage, FakeTimers, keepalive, reconnectTo, revocation, sockets, welcome } from './twitch-fakes.js';

/* The chat connection, with a pretend WebSocket and a clock that moves only when told. */

let timers: FakeTimers;
let net: ReturnType<typeof sockets>;
let subscribed: Array<{ session: string; broadcaster: string; user: string }>;
let subscribeError: Error | null;
let chats: ChatEvent[];
let states: Array<[EventSubState, string | undefined]>;
let client: EventSubClient;

const settle = () => new Promise<void>((r) => setImmediate(r));

beforeEach(() => {
  timers = new FakeTimers();
  net = sockets();
  subscribed = [];
  subscribeError = null;
  chats = [];
  states = [];
  client = new EventSubClient({
    api: {
      subscribeChat: async (session, broadcaster, user) => {
        if (subscribeError) throw subscribeError;
        subscribed.push({ session, broadcaster, user });
      },
    },
    broadcasterId: '100',
    userId: '555',
    onChat: (e) => chats.push(e),
    onState: (s, d) => states.push([s, d]),
    socketFactory: net.factory,
    timers,
    random: () => 0.5,
  });
});

const connectAndWelcome = async (session = 'sess-1') => {
  client.start();
  net.made[0]!.emit(welcome(session));
  await settle();
};

describe('reading a Twitch chat over the EventSub WebSocket', () => {
  it('connects to Twitch\'s address, waits for the welcome, and asks for the channel\'s chat within its session', async () => {
    client.start();
    assert.match(net.made[0]!.url, /^wss:\/\/eventsub\.wss\.twitch\.tv\/ws\?keepalive_timeout_seconds=20$/);
    assert.deepEqual(subscribed, [], 'nothing is asked before the welcome');
    assert.equal(client.state, 'connecting');
    net.made[0]!.emit(welcome('sess-9'));
    await settle();
    assert.deepEqual(subscribed, [{ session: 'sess-9', broadcaster: '100', user: '555' }]);
    assert.equal(client.state, 'connected');
  });

  it('hands over each chat message, tidied, and ignores everything that is not a chat message', async () => {
    await connectAndWelcome();
    const s = net.made[0]!;
    s.emit(chatMessage({ id: 'c1', user: 'Viewer1', name: 'Viewer1', text: '!flight', badges: ['moderator', 'subscriber'] }));
    s.emit(chatMessage({ id: 'c2', text: 'hello kevin', replyTo: { id: '555', login: 'KevinBot' } }));
    s.emit({ metadata: { message_id: 'x', message_type: 'notification' }, payload: { subscription: { type: 'channel.follow' }, event: { user_id: '1' } } });
    s.emit(keepalive());
    s.onmessage?.({ data: 'not json' });
    assert.deepEqual(chats.map((c) => [c.messageId, c.chatterLogin, c.text, c.badges, c.replyToUserId, c.replyToLogin]), [
      ['c1', 'viewer1', '!flight', ['moderator', 'subscriber'], null, null],
      ['c2', 'viewer1', 'hello kevin', [], '555', 'kevinbot'],
    ]);
  });

  it('does not deliver the same notification twice', async () => {
    await connectAndWelcome();
    const m = chatMessage({ id: 'c1', text: 'hi' }, 'same-message-id');
    net.made[0]!.emit(m);
    net.made[0]!.emit(m);
    assert.equal(chats.length, 1);
  });

  it('answers silence with a new connection: a keepalive resets the wait, and its absence does not', async () => {
    await connectAndWelcome();
    timers.advance(25_000);
    net.made[0]!.emit(keepalive());
    timers.advance(25_000);
    assert.equal(net.made.length, 1, 'the keepalive kept it alive');
    timers.advance(10_000);
    assert.equal(net.made[0]!.closed, true, 'a quiet connection is dropped');
    assert.equal(client.state, 'reconnecting');
    timers.advance(2_000);
    assert.equal(net.made.length, 2, 'and made again');
    net.made[1]!.emit(welcome('sess-2'));
    await settle();
    assert.deepEqual(subscribed.map((s) => s.session), ['sess-1', 'sess-2'], 'the chat is asked for again on the new session');
    assert.equal(client.state, 'connected');
  });

  it('gives up on a connection that never says a word, not even the welcome', () => {
    client.start();
    timers.advance(60_000);
    assert.equal(net.made[0]!.closed, true);
    assert.equal(client.state, 'reconnecting');
  });

  it('tries again when the connection closes, waiting longer each time, and starts over once it is working', async () => {
    await connectAndWelcome();
    net.made[0]!.drop();
    assert.equal(client.state, 'reconnecting');
    timers.advance(999);
    assert.equal(net.made.length, 1);
    timers.advance(2);
    assert.equal(net.made.length, 2);
    net.made[1]!.drop(); // before it ever worked
    timers.advance(1_500);
    assert.equal(net.made.length, 2, 'the second wait is longer');
    timers.advance(1_000);
    assert.equal(net.made.length, 3);
    net.made[2]!.emit(welcome());
    await settle();
    net.made[2]!.drop();
    timers.advance(1_100);
    assert.equal(net.made.length, 4, 'back to the short wait after a good connection');
  });

  it('moves to the address Twitch asks for without a gap and without asking for the chat again', async () => {
    await connectAndWelcome();
    const old = net.made[0]!;
    old.emit(reconnectTo('wss://eventsub.wss.twitch.tv/ws?reconnect=1'));
    assert.equal(net.made.length, 2);
    assert.equal(net.made[1]!.url, 'wss://eventsub.wss.twitch.tv/ws?reconnect=1', 'the address is used as it is');
    assert.equal(old.closed, false, 'the old connection stays until the new one has said hello');
    chats.length = 0;
    old.emit(chatMessage({ id: 'still-on-old', text: 'hi' }));
    assert.equal(chats.length, 1);
    net.made[1]!.emit(welcome('sess-2'));
    await settle();
    assert.equal(old.closed, true);
    assert.equal(subscribed.length, 1, 'the subscription came with it');
    net.made[1]!.emit(chatMessage({ id: 'on-new', text: 'hi again' }));
    assert.equal(chats.length, 2);
    assert.equal(client.state, 'connected');
  });

  it('does not listen to a connection that has already closed', async () => {
    await connectAndWelcome();
    const old = net.made[0]!;
    old.drop();
    chats.length = 0;
    old.emit(chatMessage({ id: 'ghost', text: 'from a connection that is gone' }));
    assert.equal(chats.length, 0);
  });

  it('ignores a request to move to an address that is not Twitch\'s', async () => {
    await connectAndWelcome();
    net.made[0]!.emit(reconnectTo('wss://evil.example/ws'));
    net.made[0]!.emit(reconnectTo('ws://eventsub.wss.twitch.tv/ws'));
    assert.equal(net.made.length, 1);
  });

  it('stops for good when Twitch takes the subscription away', async () => {
    await connectAndWelcome();
    net.made[0]!.emit(revocation('authorization_revoked'));
    assert.equal(client.state, 'failed');
    assert.match(states.at(-1)![1]!, /taken back/);
    assert.equal(net.made[0]!.closed, true);
    timers.advance(120_000);
    assert.equal(net.made.length, 1, 'no new attempts');
  });

  it('stops for good when it is not allowed to read the chat, and says why', async () => {
    subscribeError = new TwitchApiError('forbidden', 'subscription missing proper authorization');
    await connectAndWelcome();
    assert.equal(client.state, 'failed');
    assert.match(states.at(-1)![1]!, /banned or timed out/);
    subscribeError = null;
    timers.advance(120_000);
    assert.equal(net.made.length, 1);
  });

  it('stops when the sign-in is not accepted, and tries again when Twitch is only having trouble', async () => {
    subscribeError = new TwitchApiError('unauthorized', 'no');
    await connectAndWelcome();
    assert.equal(client.state, 'failed');
    assert.match(states.at(-1)![1]!, /Connect to Twitch again/);
    // a new client for the trouble case
    net = sockets();
    states = [];
    client = new EventSubClient({ api: { subscribeChat: async () => { throw new TwitchApiError('unavailable', 'down'); } }, broadcasterId: '100', userId: '555', onChat: () => {}, onState: (s) => states.push([s, undefined]), socketFactory: net.factory, timers, random: () => 0.5 });
    client.start();
    net.made[0]!.emit(welcome());
    await settle();
    assert.equal(client.state, 'reconnecting');
    assert.equal(net.made[0]!.closed, true);
    timers.advance(1_100);
    assert.equal(net.made.length, 2);
  });

  it('stops cleanly when told to, closing everything and leaving no timer behind', async () => {
    await connectAndWelcome();
    net.made[0]!.emit(reconnectTo('wss://eventsub.wss.twitch.tv/ws?r=1'));
    client.stop();
    assert.equal(client.state, 'stopped');
    assert.equal(net.made.every((s) => s.closed), true);
    assert.equal(timers.pending, 0);
    net.made[0]!.emit(chatMessage({ id: 'late', text: 'too late' }));
    assert.equal(chats.length, 0, 'nothing is delivered once stopped');
    client.start();
    assert.equal(net.made.length, 3, 'and it can be started again');
  });

  it('is not stopped for good by a WebSocket that cannot be opened at all', () => {
    const broken = new EventSubClient({ api: { subscribeChat: async () => {} }, broadcasterId: '1', userId: '2', onChat: () => {}, socketFactory: () => { throw new Error('This version of Node.js has no WebSocket.'); }, timers });
    broken.start();
    assert.equal(broken.state, 'failed');
  });
});

describe('reading a chat message', () => {
  it('needs an ID, a chatter and some text, and tolerates the rest being missing', () => {
    assert.equal(chatEventOf({}), null);
    assert.equal(chatEventOf({ message_id: 'a', chatter_user_id: '1', message: { text: '' } }), null);
    const e = chatEventOf({ message_id: 'a', chatter_user_id: '1', chatter_user_login: 'MixedCase', message: { text: 'hi' } })!;
    assert.deepEqual({ login: e.chatterLogin, name: e.chatterName, badges: e.badges, type: e.messageType, reply: e.replyToUserId }, { login: 'mixedcase', name: 'MixedCase', badges: [], type: 'text', reply: null });
  });
});
