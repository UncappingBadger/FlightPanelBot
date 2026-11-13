import { PermissionFlagsBits } from 'discord.js';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, Client, Message, StringSelectMenuInteraction } from 'discord.js';
import type { AeroDaqClient, AirportFuel, Stock } from '../src/aerodaq/client.js';
import type { Config } from '../src/config.js';
import type { BotContext } from '../src/discord/context.js';
import type { FlightPage, FsHubAccount, FsHubAirline, FsHubApi, FsHubFlight, FsHubPilot, RosterPilot } from '../src/fshub/client.js';
import { AutoCompleter } from '../src/services/autoComplete.js';
import { FsHubSync } from '../src/services/fshubSync.js';
import { MarketService } from '../src/discord/market.js';
import { Notifier } from '../src/discord/notifier.js';
import { PanelService } from '../src/discord/panel.js';
import type { JobSource } from '../src/jobs/types.js';
import { sourceSelector } from '../src/jobs/sheet.js';
import type { SheetWriteBack } from '../src/services/writeback.js';
import { SourceRefresher } from '../src/services/refresh.js';
import { silentLogger } from '../src/util/log.js';
import { GUILD, USER_A, USER_B, USER_C, type Harness } from './helpers.js';

export const CONFIG: Config = {
  discordToken: 'x',
  discordClientId: '1',
  discordGuildId: undefined,
  databasePath: ':memory:',
  logLevel: 'error',
  googleServiceAccountFile: undefined,
  fshubToken: undefined,
};

/* ------------------------------------------------------------------ fake Discord objects */

/** A Discord user with a DM inbox that records what the bot sends them. */
export class FakeUser {
  dms: any[] = [];
  /** Simulate "Allow direct messages from server members" being off. */
  failDms = false;
  constructor(
    public id: string,
    public username: string,
    public bot = false,
  ) {}
  async send(payload: any) {
    if (this.failDms) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    this.dms.push(payload);
    return { id: `dm-m${this.dms.length}`, channelId: `dm-${this.id}` };
  }
  /** The DM channel with this user, where a list that is kept up to date lives (messages can be fetched, edited and deleted there). */
  private dm: FakeChannel | null = null;
  get dmChannel(): FakeChannel {
    return (this.dm ??= new FakeDmChannel(`dmc-${this.id}`, this));
  }
  async createDM() {
    return this.dmChannel as any;
  }
  /** Like discord.js: the address of the person's picture, in the size asked for. */
  displayAvatarURL(o: { size?: number } = {}): string {
    return `https://cdn.test/avatars/${this.id}.png?size=${o.size ?? 128}`;
  }
  /** The latest message in the DM channel, as text. */
  get lastListText(): string {
    const m = this.dmChannel.live.at(-1);
    return m ? messageText(m) : '';
  }
  get last(): any {
    return this.dms.at(-1);
  }
  /** Text of the latest DM. */
  get lastText(): string {
    return String(this.last?.content ?? '');
  }
}

/** Discord's "Unknown Message" (10008): what the API says about a message that no longer exists. */
export const unknownMessage = () => Object.assign(new Error('Unknown Message'), { code: 10008 });

/**
 * The words on a card, as one piece of text: its title, its description, and each box as `NAME: value` (a box's line breaks
 * become " / "), then the footer. Cards are embeds, so a test asks what a panel message says, not where it says it.
 */
export function embedText(e: { toJSON(): any }): string {
  const j = e.toJSON();
  const boxes = (j.fields ?? []).map((f: { name: string; value: string }) => `${f.name}: ${f.value.replace(/\n/g, ' / ')}`);
  return [j.title, j.description, ...boxes, j.footer?.text].filter(Boolean).join('\n');
}

/** Everything a message with cards says: each card's text, one after another. */
export function messageText(m: { payload: { embeds: Array<{ toJSON(): any }> } }): string {
  return m.payload.embeds.map(embedText).join('\n\n');
}

export class FakeMessage {
  edits: any[] = [];
  deleted = false;
  editable = true;
  deletable = true;
  constructor(
    readonly channel: FakeChannel,
    readonly id: string,
    public payload: any,
  ) {}
  get channelId() {
    return this.channel.id;
  }
  async edit(p: any) {
    // Like the real API: you can't edit a message that has been deleted on the server, even if the
    // bot still holds a cached copy of it.
    if (!this.channel.existsOnServer(this.id)) throw unknownMessage();
    this.payload = p;
    this.edits.push(p);
    return this;
  }
  async delete() {
    if (!this.channel.existsOnServer(this.id)) throw unknownMessage();
    this.deleted = true;
    this.channel.deleteMessage(this.id);
  }
}

/**
 * A channel that behaves like Discord as discord.js sees it. The important part is the cache: the
 * bot only has the Guilds and DirectMessages intents, so it is never told when a person deletes a
 * message, and `messages.fetch(id)` keeps returning the cached copy unless forced to ask the API.
 */
export class FakeChannel {
  sent: FakeMessage[] = [];
  /** Messages that exist on Discord's servers. */
  private server = new Map<string, FakeMessage>();
  /** Messages the bot has cached locally (never invalidated by a person deleting one). */
  private cache = new Map<string, FakeMessage>();
  private next = 1;
  /** How many times the bot actually asked the API for a message (not served from cache). */
  apiFetches = 0;
  readonly messages = {
    fetch: async (arg: string | { message: string; force?: boolean }) => {
      const id = typeof arg === 'string' ? arg : arg.message;
      const force = typeof arg === 'object' && arg.force === true;
      if (!force) {
        const cached = this.cache.get(id);
        if (cached) return cached;
      }
      this.apiFetches++;
      const m = this.server.get(id);
      if (!m) {
        this.cache.delete(id);
        throw unknownMessage();
      }
      this.cache.set(id, m);
      return m;
    },
  };
  constructor(readonly id: string) {}
  /** Members who can't see this channel (for tests of a person losing access). */
  hiddenFrom = new Set<string>();
  /** The bot may not attach files here (an older invite did not ask for it). */
  noAttachFiles = false;
  /** Like a server channel: it knows the bot's own member, so its permissions can be asked about. */
  guild = { members: { me: { id: 'the-bot' } } };
  permissionsFor(member: { id: string }) {
    return {
      has: (permission?: bigint) => !this.hiddenFrom.has(member.id) && !(this.noAttachFiles && member.id === 'the-bot' && permission === PermissionFlagsBits.AttachFiles),
    };
  }
  isSendable() {
    return true;
  }
  isTextBased() {
    return true;
  }
  existsOnServer(id: string): boolean {
    return this.server.has(id);
  }
  async send(payload: any) {
    const m = new FakeMessage(this, `${this.id}-m${this.next++}`, payload);
    this.server.set(m.id, m);
    this.cache.set(m.id, m);
    this.sent.push(m);
    return m;
  }
  /** Simulate someone deleting a message in Discord: gone from the server, but still in the bot's cache. */
  deleteMessage(id: string) {
    this.server.delete(id);
  }
  /** Messages currently on the channel, oldest first. */
  get live(): FakeMessage[] {
    return this.sent.filter((m) => this.server.has(m.id));
  }
}

/** A DM channel: sending fails the way Discord's does when the person has closed their DMs. */
export class FakeDmChannel extends FakeChannel {
  constructor(
    id: string,
    private readonly owner: FakeUser,
  ) {
    super(id);
  }
  override async send(payload: any) {
    if (this.owner.failDms) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    return super.send(payload);
  }
}

export class FakeClient {
  channels_ = new Map<string, FakeChannel>();
  users_ = new Map<string, FakeUser>();
  autoCreate = true;
  /** Who is in the server (null: everyone is). */
  members: Set<string> | null = null;
  readonly guilds = {
    fetch: async (_id: string) => ({
      members: {
        fetch: async (userId: string) => {
          if (this.members && !this.members.has(userId)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
          return { id: userId, permissions: { has: () => false }, roles: { cache: { has: () => false } } };
        },
      },
    }),
  };
  readonly channels = {
    fetch: async (id: string) => {
      const c = this.channels_.get(id) ?? (this.autoCreate ? this.channel(id) : undefined);
      if (!c) throw new Error('Unknown Channel');
      return c;
    },
  };
  readonly users = {
    fetch: async (id: string) => {
      const u = this.users_.get(id);
      if (!u) throw new Error('Unknown User');
      return u;
    },
  };
  channel(id: string): FakeChannel {
    let c = this.channels_.get(id);
    if (!c) {
      c = new FakeChannel(id);
      this.channels_.set(id, c);
    }
    return c;
  }
  /** Register a user so the bot can look them up and DM them. */
  user(u: FakeUser): FakeUser {
    this.users_.set(u.id, u);
    return u;
  }
  deleteAllChannels() {
    this.channels_.clear();
    this.autoCreate = false;
  }
}

/**
 * A DM sent to the bot. The sender belongs to the panels' server (the one every test panel is in), unless `guilds` names
 * the servers they are in.
 */
export function fakeDm(user: FakeUser, content: string, o: { guilds?: string[] } = {}): Message {
  const member = (guildId: string) => (o.guilds ?? [GUILD]).includes(guildId);
  const client = {
    guilds: {
      cache: new Map(),
      fetch: async (guildId: string) => ({
        members: {
          fetch: async () => {
            if (!member(guildId)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
            return { id: user.id };
          },
        },
      }),
    },
  };
  return { author: user, guildId: null, content, client } as unknown as Message;
}

interface ComponentOptions {
  /** Where it was pressed: a server's ID (the default), or null for a DM. */
  guildId?: string | null;
  values?: string[];
  /** The pressing member's role IDs. */
  roles?: string[];
  /** Has Manage Server. */
  admin?: boolean;
  /** The person is not (or no longer) in the server: looking them up fails the way Discord's does. */
  notMember?: boolean;
}

/** What `interaction.client` offers: looking the pressing person up as a member of the server. */
function memberClient(o: ComponentOptions) {
  return {
    guilds: {
      fetch: async (_guildId: string) => ({
        members: {
          fetch: async (userId: string) => {
            if (o.notMember) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
            return { id: userId, permissions: { has: () => !!o.admin }, roles: { cache: { has: (r: string) => (o.roles ?? []).includes(r) } } };
          },
        },
      }),
    },
  };
}

/** A button press (or, with `values`, a select-menu choice). Records every response. */
export function fakeComponent(user: FakeUser, customId: string, o: ComponentOptions = {}) {
  const calls = { defers: [] as any[], edits: [] as any[], updates: [] as any[], replies: [] as any[], modals: [] as any[] };
  const isMenu = o.values !== undefined;
  const i: any = {
    customId,
    user,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    values: o.values ?? [],
    member: o.guildId === null ? null : { roles: o.roles ?? [] },
    memberPermissions: o.guildId === null ? null : { has: () => !!o.admin },
    client: memberClient(o),
    deferred: false,
    replied: false,
    isButton: () => !isMenu,
    isStringSelectMenu: () => isMenu,
    isModalSubmit: () => false,
    showModal: async (m: any) => {
      calls.modals.push(m);
    },
    deferReply: async (a: any) => {
      i.deferred = true;
      calls.defers.push(a);
    },
    deferUpdate: async () => {
      i.deferred = true;
    },
    editReply: async (p: any) => {
      calls.edits.push(p);
    },
    update: async (p: any) => {
      calls.updates.push(p);
    },
    reply: async (p: any) => {
      i.replied = true;
      calls.replies.push(p);
    },
  };
  return { i: i as ButtonInteraction & StringSelectMenuInteraction, calls };
}

/** A form (modal) the user filled in and sent: `fields` are the values of its text boxes by id. */
export function fakeModal(user: FakeUser, customId: string, fields: Record<string, string>, o: ComponentOptions = {}) {
  const calls = { defers: [] as any[], edits: [] as any[], replies: [] as any[] };
  const i: any = {
    customId,
    user,
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    member: o.guildId === null ? null : { roles: o.roles ?? [] },
    memberPermissions: o.guildId === null ? null : { has: () => !!o.admin },
    client: memberClient(o),
    deferred: false,
    replied: false,
    fields: { getTextInputValue: (id: string) => fields[id] ?? '' },
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isRepliable: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => true,
    deferReply: async (a: any) => {
      i.deferred = true;
      calls.defers.push(a);
    },
    editReply: async (p: any) => {
      calls.edits.push(p);
    },
    reply: async (p: any) => {
      i.replied = true;
      calls.replies.push(p);
    },
  };
  return { i, calls };
}

export interface FakeInteractionOptions {
  sub?: string;
  options?: Record<string, unknown>;
  userId?: string;
  guildId?: string | null;
  channelId?: string;
  admin?: boolean;
  focused?: { name: string; value: string };
  guild?: unknown;
}

/** A slash command or autocomplete interaction. */
export function fakeInteraction(o: FakeInteractionOptions = {}) {
  const calls = { defers: [] as any[], edits: [] as any[], replies: [] as any[], responds: [] as any[] };
  const opts = o.options ?? {};
  const get = (name: string, required?: boolean) => {
    const v = opts[name];
    if (v === undefined && required) throw new Error(`test bug: option ${name} required but not provided`);
    return v ?? null;
  };
  const i: any = {
    user: { id: o.userId ?? '111111111111111111', bot: false },
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    channelId: o.channelId ?? '700000000000000001',
    guild: o.guild ?? {},
    memberPermissions: { has: () => !!o.admin },
    deferred: false,
    replied: false,
    options: {
      getSubcommand: () => o.sub,
      getString: get,
      getInteger: get,
      getBoolean: get,
      getUser: get,
      getChannel: get,
      getAttachment: get,
      getRole: get,
      getFocused: (full?: boolean) => (full ? o.focused : (o.focused?.value ?? '')),
    },
    deferReply: async (arg: any) => {
      i.deferred = true;
      calls.defers.push(arg);
    },
    editReply: async (p: any) => {
      calls.edits.push(p);
    },
    reply: async (p: any) => {
      i.replied = true;
      calls.replies.push(p);
    },
    respond: async (choices: any) => {
      calls.responds.push(choices);
    },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isRepliable: () => true,
  };
  return { i: i as ChatInputCommandInteraction & AutocompleteInteraction, calls };
}

/* ------------------------------------------------------------------ wiring */

/** A stand-in for AeroDAQ: answers with whatever a test sets, or fails the way a real outage would. */
export class FakeAeroDaq {
  stocks: Stock[] = [];
  airports = new Map<string, AirportFuel | null>();
  /** When set, every call throws it. */
  error: Error | null = null;
  marketCalls = 0;
  fuelCalls: string[] = [];
  async market(): Promise<Stock[]> {
    this.marketCalls++;
    if (this.error) throw this.error;
    return this.stocks;
  }
  async fuel(icao: string): Promise<AirportFuel | null> {
    this.fuelCalls.push(icao);
    if (this.error) throw this.error;
    return this.airports.get(icao) ?? null;
  }
}

/**
 * A stand-in for FsHub. Everything in it is made up: the pilots, airlines and Discord IDs are not real
 * people. Tests set what it knows, or make it fail the way a real outage or refusal would.
 */
export class FakeFsHub implements FsHubApi {
  /** Pilots FsHub knows, by ID. */
  pilots = new Map<number, FsHubPilot>();
  /** Airlines FsHub knows, by ID. */
  airlines = new Map<number, FsHubAirline>();
  /** The airlines the token's own account belongs to. */
  mine: FsHubAirline[] = [];
  /** Rosters, by airline ID. */
  rosters = new Map<number, RosterPilot[]>();
  /** When set, every call throws it. */
  error: Error | null = null;
  /** When set, only roster reads throw it (the rest still work). */
  rosterError: Error | null = null;
  /** The flights FsHub lists for each airline (any order: it serves them oldest first, by ID, like FsHub does). */
  flights = new Map<number, FsHubFlight[]>();
  /** When set, only flight reads throw it. */
  flightError: Error | null = null;
  pilotCalls: number[] = [];
  rosterCalls: number[] = [];
  flightCalls: Array<{ airlineId: number; cursor: number; limit: number }> = [];
  async account(): Promise<FsHubAccount> {
    if (this.error) throw this.error;
    return { id: 1, name: 'Token Holder', premium: false };
  }
  async pilot(id: number): Promise<FsHubPilot | null> {
    this.pilotCalls.push(id);
    if (this.error) throw this.error;
    return this.pilots.get(id) ?? null;
  }
  async airline(id: number): Promise<FsHubAirline | null> {
    if (this.error) throw this.error;
    return this.airlines.get(id) ?? null;
  }
  async myAirlines(): Promise<FsHubAirline[]> {
    if (this.error) throw this.error;
    return this.mine;
  }
  async roster(airlineId: number): Promise<RosterPilot[]> {
    this.rosterCalls.push(airlineId);
    if (this.error) throw this.error;
    if (this.rosterError) throw this.rosterError;
    return this.rosters.get(airlineId) ?? [];
  }
  async airlineFlights(airlineId: number, cursor: number, limit: number): Promise<FlightPage> {
    this.flightCalls.push({ airlineId, cursor, limit });
    if (this.error) throw this.error;
    if (this.flightError) throw this.flightError;
    const page = (this.flights.get(airlineId) ?? [])
      .filter((f) => f.id > cursor)
      .sort((a, b) => a.id - b.id)
      .slice(0, limit);
    return {
      flights: page,
      count: page.length,
      lastId: page.length ? page[page.length - 1]!.id : null,
      firstAt: page.length ? page[0]!.arrivedAt : null,
      lastAt: page.length ? page[page.length - 1]!.arrivedAt : null,
    };
  }
}

export interface DiscordHarness {
  ctx: BotContext;
  client: FakeClient;
  panels: PanelService;
  refresher: SourceRefresher;
  aerodaq: FakeAeroDaq;
  market: MarketService;
  /** Present when the test asked for FsHub (`fshub: true`); otherwise ctx.fshub is null, as for a host with no token. */
  fshub: FakeFsHub | null;
}

export function makeDiscordHarness(
  h: Harness,
  opts: { source?: JobSource | null; fetchFn?: typeof fetch; writeback?: SheetWriteBack | null; pilotIds?: boolean; aerodaq?: FakeAeroDaq; fshub?: boolean | FakeFsHub } = {},
): DiscordHarness {
  const client = new FakeClient();
  const now = () => h.clock.now;
  // By default the test pilots have already told the bot their FsHub pilot ID, so Reserve goes straight to the flight.
  // Tests of the first-time question ask for `pilotIds: false`.
  if (opts.pilotIds !== false) {
    h.store.setPilotId(USER_A.discordId, 1001, now());
    h.store.setPilotId(USER_B.discordId, 1002, now());
    h.store.setPilotId(USER_C.discordId, 1003, now());
  }
  const panels = new PanelService(h.store, h.jobs, silentLogger, now, 0, 0);
  panels.attach(client as unknown as Client);
  // The same selection the real bot uses: a panel's linked sheet first, then the test's own source.
  const refresher = new SourceRefresher(h.store, h.jobs, sourceSelector({ fallback: opts.source ?? null, fetchFn: opts.fetchFn }), silentLogger, now);
  const aerodaq = opts.aerodaq ?? new FakeAeroDaq();
  const market = new MarketService(h.store, aerodaq, silentLogger, now);
  market.attach(client as unknown as Client);
  const fshub = opts.fshub ? (opts.fshub === true ? new FakeFsHub() : opts.fshub) : null;
  const fshubSync = fshub ? new FsHubSync(h.store, fshub, panels, { logger: silentLogger, now, completed: (panelId) => h.jobs.completed(panelId) }) : null;
  const notifier = new Notifier(client as unknown as Client, panels, silentLogger);
  // As in the real bot: the hourly completion, which tells each pilot in a DM (FakeUser records them).
  const autoComplete = fshubSync
    ? new AutoCompleter({ store: h.store, jobs: h.jobs, sync: fshubSync, writeback: opts.writeback ?? null, logger: silentLogger, now, onCompleted: (discordId, done) => notifier.autoCompleted(discordId, done) })
    : null;
  panels.fshubEnabled = fshub !== null;
  const ctx: BotContext = {
    config: CONFIG,
    store: h.store,
    jobs: h.jobs,
    panels,
    refresher,
    aerodaq: aerodaq as unknown as AeroDaqClient,
    market,
    writeback: opts.writeback ?? null,
    fshub,
    fshubSync,
    autoComplete,
    log: silentLogger,
    now,
    fetchFn: opts.fetchFn ?? fetch,
  };
  notifier.subscribe(h.events);
  return { ctx, client, panels, refresher, aerodaq, market, fshub };
}

/** Let fire-and-forget event listeners and debounce timers finish. */
export const settle = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
