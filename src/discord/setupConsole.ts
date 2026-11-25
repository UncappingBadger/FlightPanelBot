import { ChannelType, type ChatInputCommandInteraction, type Guild, type User } from 'discord.js';
import { MAX_IMPORT_BYTES } from '../jobs/import.js';
import type { Panel } from '../db/store.js';
import { setupCommand } from './commands/setup.js';
import type { BotContext } from './context.js';
import { describeError, UserError } from './errors.js';

/**
 * The host's settings page as a front for the `/setup` commands. Every subcommand is a tab there, with a form made from the command's own definition (its options, their
 * choices and limits), and pressing the tab's button runs the very same command code the slash command ran, as the server's owner. Nothing about what a command does is written twice,
 * so the page and the commands cannot drift apart, and what a command says in reply is shown on the page.
 */

/** What the console needs from Discord: the servers the bot is in, one server in full, and one user. */
export interface ConsoleDiscord {
  guilds(): Array<{ id: string; name: string }>;
  guild(id: string): Promise<Guild | null>;
  user(id: string): Promise<User | null>;
}

export type FieldKind = 'text' | 'number' | 'select' | 'channel' | 'role' | 'user' | 'file';

/** One box of a tab's form, made from an option of the command. */
export interface FieldDef {
  name: string;
  label: string;
  help: string;
  kind: FieldKind;
  required: boolean;
  /** What leaving the box empty means, in words (shown as the empty choice of a drop-down and as the grey hint of a typed box). */
  blank: string;
  /** For `select`: the choices. */
  choices?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

/** What a tab applies to: one airline (panel), or the whole server. */
export type TabScope = 'airline' | 'server';

/**
 * How a tab says how things stand when it is opened: `self` runs the command with nothing to change (every one of those only reads), `overview` shows the airline's line of the list
 * of panels, and `none` shows nothing.
 */
export type TabStatus = 'self' | 'overview' | 'none';

export interface TabDef {
  id: string;
  label: string;
  group: string;
  scope: TabScope;
  /** A sentence or two on what the tab is for. */
  intro: string;
  status: TabStatus;
  /** Asked of the person before the button does its work, for something that cannot be undone. */
  confirm?: string;
  /** The words on the tab's button. */
  submit: string;
  /** The tab has a page of its own (landing safety), which is not made from the command's options. */
  custom?: 'safety';
  fields: FieldDef[];
}

interface Meta {
  label: string;
  group: string;
  scope: TabScope;
  intro?: string;
  status: TabStatus;
  confirm?: string;
  submit: string;
  custom?: 'safety';
  /** Values to run the command with when it says how things stand (instead of nothing). */
  statusValues?: Record<string, string>;
  /** Better words for an option than its name. */
  labels?: Record<string, string>;
  /**
   * What an empty box MEANS, by option. A box left empty is "no change" unless it is listed here, and a box where an empty one means something else (the role of "who can reserve",
   * where empty is "everyone") must say so, so nobody reads "no change" into it.
   */
  blanks?: Record<string, string>;
  /** Words for a choice where the command's own refer to Discord ("in the reply", "the role option"): by option, then by value. */
  choices?: Record<string, Record<string, string>>;
}

/** The tabs, in the order the page lists them, with how each is shown. The boxes of each come from the command itself. */
const META: Record<string, Meta> = {
  'panel-add': {
    label: 'Add or change a panel',
    group: 'Panels',
    scope: 'server',
    status: 'none',
    submit: 'Create the panel (or update it)',
    intro: "Creates an airline's flight panel in the channel you choose and posts the flight list there. If an airline with exactly this name already has a panel in this server, this changes that panel's channel (and its role, if you choose one) instead of making another. The Flight ID letters of an existing panel cannot be changed.",
    labels: { airline: 'Airline name', prefix: 'Flight ID letters (2 to 6)' },
    blanks: { prefix: 'Made from the airline name (an existing panel keeps its letters)', role: 'Anyone who can see the channel (an existing panel keeps the role it has)' },
  },
  'panel-role': {
    label: 'Who can reserve',
    group: 'Panels',
    scope: 'airline',
    status: 'overview',
    submit: 'Save who can reserve',
    intro: "Chooses who may reserve flights on the selected airline's panel. Server admins can always reserve. WARNING: pressing the button with the box empty (or @everyone chosen) opens the panel to everyone who can see its channel.",
    labels: { role: 'Role that may reserve' },
    blanks: { role: 'Everyone who can see the channel (no role needed)' },
  },
  'panel-remove': {
    label: 'Remove a panel',
    group: 'Panels',
    scope: 'airline',
    status: 'overview',
    submit: 'Remove the selected airline\'s panel',
    confirm: 'Remove this panel with its flights and reservations? This cannot be undone.',
    intro: "Deletes the selected airline's panel from Discord, and its flights and reservations from the bot. This cannot be undone. Nothing else in the server is touched.",
  },
  panels: { label: 'All panels', group: 'Panels', scope: 'server', status: 'self', submit: 'Show the list again', intro: 'Every panel in this server: where its flights come from, who can reserve, and how its last refresh went. Nothing here can be changed; this tab only shows.' },
  layout: { label: 'Layout', group: 'Panels', scope: 'airline', status: 'self', submit: 'Save the layout', intro: "How the selected airline's panel is drawn: a card for each flight, or a grid of buttons that takes much less room. Choose only what you want to change." },
  window: {
    label: 'Days shown',
    group: 'Panels',
    scope: 'airline',
    status: 'self',
    submit: 'Save the number of days',
    intro: "How many days ahead the selected airline's panel lists flights. Flights that start later are left off the panel until they come within that many days (a pilot can still reserve one by typing its flight ID).",
    labels: { days: 'Days ahead (1 to 7)' },
    blanks: { days: 'no change' },
  },
  completed: {
    label: 'Completed flights',
    group: 'Panels',
    scope: 'airline',
    status: 'self',
    submit: 'Save',
    intro: "Where the selected airline's completed flights are shown. Fill in ONE of the two boxes: a channel (completed flights are posted there and left off the panel), or Panel (they are shown on the panel itself, below the open flights). Both together is refused.",
  },
  refresh: { label: 'Refresh now', group: 'Panels', scope: 'airline', status: 'overview', submit: 'Refresh the selected airline\'s panel now', intro: "Reads the selected airline's flights again (when it has a Google Sheet or other automatic source) and redraws its panel straight away, instead of waiting for the next hourly check." },
  sheet: {
    label: 'Google Sheet',
    group: 'Flights',
    scope: 'airline',
    status: 'overview',
    submit: 'Link the sheet',
    intro: "Links the selected airline's schedule in Google Sheets, so its panel reads the flights from there every hour. Paste the sheet's address. Type none to stop reading a sheet (the panel keeps the flights it has).",
    labels: { link: 'Address of the Google Sheet (or none)' },
  },
  writeback: {
    label: 'Sheet write-back',
    group: 'Flights',
    scope: 'airline',
    status: 'overview',
    submit: 'Apply (empty: only check the sheet)',
    intro: "Whether the bot writes pilots' names and completions into the selected airline's linked Google Sheet. Choose On or Off to change it. With the box empty, nothing is changed and the bot only checks that it can open the sheet.",
    labels: { mode: 'Write-back' },
    blanks: { mode: 'no change (only check that the sheet can be opened)' },
  },
  import: {
    label: 'Import flights',
    group: 'Flights',
    scope: 'airline',
    status: 'overview',
    submit: 'Import the file',
    confirm: 'Import this file? Every flight that is not in it is closed.',
    intro: "Loads a file of flights (CSV or JSON) into the selected airline's panel, for an airline that has no Google Sheet. Import the FULL list each time: flights that are not in the file are closed. Use the Example file tab to see the columns.",
    labels: { file: 'Flights file (CSV or JSON, up to 256 KB)' },
  },
  template: { label: 'Example file', group: 'Flights', scope: 'server', status: 'none', submit: 'Get the example file', intro: 'Gives you an example flights file to download and fill in, for the Import flights tab. Nothing is changed.' },
  release: {
    label: 'Release a flight',
    group: 'Flights',
    scope: 'airline',
    status: 'none',
    submit: 'Release the reservation',
    confirm: 'Release this reservation? The pilot is told, and the flight is open again.',
    intro: "Takes the pilot off a flight (or one leg of it) on the selected airline's panel. The pilot is told in a private message, and the flight can be reserved again.",
    labels: { code: 'Flight ID (for example TST-004)', leg: 'Leg number' },
    blanks: { leg: 'every leg of the flight' },
  },
  'flight-numbers': {
    label: 'Flight numbers',
    group: 'Flights',
    scope: 'airline',
    status: 'self',
    submit: 'Save',
    intro: "Whether a flight whose sheet row has no flight number takes Aeroconomy's own number for it (read from Aeroconomy's public pages). Needs the airline linked to its FsHub roster. Choose only what you want to change.",
    labels: { mode: 'Flight numbers from Aeroconomy' },
  },
  fshub: {
    label: 'FsHub roster',
    group: 'Pilots and FsHub',
    scope: 'airline',
    status: 'overview',
    submit: 'Apply (all empty: read the roster now)',
    intro: "Links the selected airline to its FsHub roster (so pilots are matched to their Discord accounts), and chooses whether its recent FsHub flights are read and whether flown flights are completed by themselves. Fill in only what you want to change. If you fill in NOTHING and press the button, the roster and flights are read from FsHub right now.",
    labels: { link: 'Airline to link (short name, FsHub number or fshub.io link; none to unlink)', confirm: 'Read the airline\'s recent FsHub flights', autocomplete: 'Complete flown flights automatically' },
  },
  'live-tracking': { label: 'Live tracking', group: 'Pilots and FsHub', scope: 'airline', status: 'self', submit: 'Save', intro: "Whether the selected airline's pilots' flights are followed live from FsHub's public live feed. Choose only what you want to change.", labels: { mode: 'Live tracking' } },
  'depart-warning': {
    label: 'Departure warning',
    group: 'Pilots and FsHub',
    scope: 'airline',
    status: 'self',
    submit: 'Save',
    intro: 'Warns a pilot (and the backup pilot) in a private message this many minutes before the latest time they can take off and still land inside the flight window. Give minutes, or choose On (30 minutes) or Off. Giving minutes together with Off is refused.',
    labels: { minutes: 'Minutes before (5 to 180)', mode: 'Warning' },
    blanks: { minutes: 'no change' },
  },
  'id-add': {
    label: 'Pilot FsHub ID',
    group: 'Pilots and FsHub',
    scope: 'server',
    status: 'none',
    submit: 'Set the pilot\'s FsHub ID',
    intro: "Sets a pilot's FsHub pilot ID for them (to fix a wrong one). The pilot is told in a private message that the server's owner did it. Both boxes are needed.",
    labels: { user: "Pilot's Discord user ID", id: 'FsHub pilot ID or profile link' },
  },
  'refresh-roles': {
    label: 'Staff roles',
    group: 'Pilots and FsHub',
    scope: 'server',
    status: 'self',
    submit: 'Save (empty: nothing changes)',
    intro: "The roles whose members may run /setup refresh and /setup id-add in Discord, and nothing else. Choose a role and the mode: Add the role (also when the mode is left empty), Remove the role, or Clear every role (then leave the role empty). With both empty, nothing is changed.",
    labels: { role: 'Role', mode: 'What to do' },
    blanks: { mode: 'Add the role (if a role is chosen)' },
  },
  reminders: {
    label: 'Reminders',
    group: 'Pilots and FsHub',
    scope: 'airline',
    status: 'self',
    submit: 'Save',
    intro: "The selected airline's daily list, at midnight UTC, of the flights starting that day that still have no pilot, and who it pings. A role only applies to the 'role I choose' mode. Choose only what you want to change.",
    labels: { mode: 'Who is pinged', role: 'Role to ping', cleanup: 'Delete each list at 23:59 UTC' },
    choices: { mode: { role: 'A role I choose (pick it in the Role to ping box)' } },
  },
  profit: {
    label: 'Profit and pay',
    group: 'Pay and safety',
    scope: 'airline',
    status: 'self',
    submit: 'Run',
    statusValues: { action: 'settings' },
    intro: "Compares Aeroconomy's profit for each of the selected airline's flights with its sheet. Action Check (the default) only reads and reports: it changes nothing. Action Fill posts a preview of the blank cells it would fill, and NOTHING is written to the sheet until someone presses Write on that preview. The Write button only exists in Discord, so set Send the preview to DM or Channel first (a preview shown on this page has no button and is refused). The other boxes set where the preview goes and who may press Write.",
    labels: { action: 'Action', 'send-to': 'Send the preview to', channel: 'Channel for the preview', 'who-can-write': 'Who may press Write', role: 'Role that may press Write', business: 'Aeroconomy business number' },
    blanks: { action: 'Check: read and report only, change nothing (the default)', business: 'found automatically' },
    choices: {
      'send-to': {
        here: 'Here: in the answer on this page (it has no Write button, so a Fill cannot be confirmed from here)',
        dm: "DM: in the server owner's Discord direct messages, where the Write button is",
        channel: 'Channel: posted in the channel chosen in the Channel for the preview box, where the Write button is',
      },
      'who-can-write': {
        admins: 'Admins: only the server owner (the default)',
        role: 'A role: the server owner, and members of the role chosen in the Role that may press Write box',
      },
    },
  },
  'safety-pay': { label: 'Landing safety', group: 'Pay and safety', scope: 'airline', status: 'none', submit: 'Save', custom: 'safety', intro: "Links a pilot's pay to how well they land, with limits for each type of aircraft." },
  market: {
    label: 'Market board',
    group: 'Server boards',
    scope: 'server',
    status: 'self',
    submit: 'Save',
    intro: "A board of AeroDAQ's in-game market prices, posted in a channel and redrawn every 15 minutes. Choosing a channel turns the board ON in that channel, even with the mode left empty. Mode Off removes the board and deletes its messages. With both empty, nothing is changed.",
    blanks: { mode: 'no change (a channel alone turns it on there)', channel: 'no change (On needs a channel unless the board already has one)' },
  },
  weather: {
    label: 'Weather board',
    group: 'Server boards',
    scope: 'server',
    status: 'self',
    submit: 'Save',
    intro: "A board of airport weather from VATSIM (for flight simulation only), posted in a channel and redrawn every 10 minutes. Choosing a channel, giving airports, or choosing mode On turns the board on or redraws it. Mode Off removes the board and deletes its messages. With everything empty, nothing is changed.",
    labels: { airports: 'Airports to follow (4-letter codes, up to 8; or default)' },
    blanks: { mode: 'no change', channel: 'no change (On needs a channel unless the board already has one)', airports: 'no change' },
  },
};

/** What the page shows when the airline has a line in the list of panels, from the `/setup panels` text. */
const OVERVIEW_TAB = 'panels';

interface RawOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  choices?: Array<{ name: string; value: string | number }>;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
}

const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function fieldOf(o: RawOption, labels: Record<string, string>): Omit<FieldDef, 'blank'> | null {
  const base = { name: o.name, label: labels[o.name] ?? capitalise(o.name.replace(/-/g, ' ')), help: o.description, required: o.required === true };
  switch (o.type) {
    case 3:
      if (o.choices && o.choices.length > 0) return { ...base, kind: 'select', choices: o.choices.map((c) => ({ value: String(c.value), label: c.name })) };
      return { ...base, kind: 'text', ...(o.min_length !== undefined ? { minLength: o.min_length } : {}), ...(o.max_length !== undefined ? { maxLength: o.max_length } : {}) };
    case 4:
    case 10:
      return { ...base, kind: 'number', ...(o.min_value !== undefined ? { min: o.min_value } : {}), ...(o.max_value !== undefined ? { max: o.max_value } : {}) };
    case 6:
      return { ...base, kind: 'user' };
    case 7:
      return { ...base, kind: 'channel' };
    case 8:
      return { ...base, kind: 'role' };
    case 11:
      return { ...base, kind: 'file' };
    default:
      return null;
  }
}

let cachedTabs: TabDef[] | null = null;

/** The tabs, made from the definition of `/setup`. */
export function setupTabs(): TabDef[] {
  if (cachedTabs) return cachedTabs;
  const json = setupCommand.data.toJSON() as unknown as { options?: Array<{ type: number; name: string; description: string; options?: RawOption[] }> };
  const subs = new Map((json.options ?? []).filter((o) => o.type === 1).map((o) => [o.name, o]));
  const tabs: TabDef[] = [];
  for (const [id, meta] of Object.entries(META)) {
    const sub = subs.get(id);
    if (!sub) throw new Error(`The settings page has a tab for /setup ${id}, which does not exist.`);
    const fields: FieldDef[] = [];
    for (const o of sub.options ?? []) {
      // The airline is chosen at the top of the page, not in the tab, except where the box is the new airline's name.
      if (o.name === 'airline' && meta.scope === 'airline') continue;
      const f = fieldOf(o, meta.labels ?? {});
      if (f) {
        const words = meta.choices?.[f.name];
        const choices = f.choices && words ? f.choices.map((c) => ({ value: c.value, label: words[c.value] ?? c.label })) : f.choices;
        fields.push({ ...f, ...(choices ? { choices } : {}), blank: meta.blanks?.[f.name] ?? (f.required ? '' : 'no change') });
      }
    }
    tabs.push({ id, label: meta.label, group: meta.group, scope: meta.scope, intro: meta.intro ?? sub.description, status: meta.status, ...(meta.confirm ? { confirm: meta.confirm } : {}), submit: meta.submit, ...(meta.custom ? { custom: meta.custom } : {}), fields: meta.custom ? [] : fields });
  }
  // Every subcommand has a tab: one added to `/setup` and not here would be left off the page.
  for (const name of subs.keys()) if (!(name in META)) throw new Error(`/setup ${name} has no tab on the settings page.`);
  cachedTabs = tabs;
  return tabs;
}

/** A server the bot is in, with its airlines. */
export interface ConsoleServer {
  id: string;
  name: string;
  airlines: Array<{ id: number; name: string; abbr: string | null; prefix: string }>;
}

/** What the page offers in its drop-downs for a server. */
export interface ConsoleChoices {
  channels: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string }>;
}

export interface ConsoleRun {
  tab: string;
  guild: string;
  /** The airline (panel) the tab applies to, for a tab that is for one. */
  panel?: number | null;
  /** What was typed or chosen, by the name of each option. */
  values?: Record<string, unknown>;
  /** Say how things stand (what a tab does when it is opened) instead of applying what was typed. */
  status?: boolean;
}

export interface ConsoleResult {
  /** Whether it worked (false: it was refused, and the text says why). */
  ok: boolean;
  /** What the command said, with a few `**bold**` and `code` marks and no Discord mentions. */
  text: string;
  /** Files the command gave back (the example flights file). */
  files: Array<{ name: string; text: string }>;
}

/** The only kinds of channel a board or panel can go in. */
const POSTING_TYPES: ReadonlySet<number> = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

const DISCORD_ID = /(\d{15,22})/;

/**
 * A command names its options (`role`, `mode:on`); on the page the same things are boxes with names of their own, so the words are changed to point at the box a person can see:
 * the `role` option becomes the **Role to ping** box, and `mode:on` becomes **Who is pinged** set to On.
 */
export function boxWords(def: Pick<TabDef, 'fields'>, text: string): string {
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  const label = (f: FieldDef): string => `**${f.label}**`;
  return text
    .replace(/\bthe `([a-z-]+)` option\b/g, (m, n: string) => (byName.has(n) ? `the ${label(byName.get(n)!)} box` : m))
    .replace(/`([a-z-]+):([^`\s]*)`/g, (m, n: string, v: string) => {
      const f = byName.get(n);
      if (!f) return m;
      const word = f.choices?.find((c) => c.value === v)?.label.split(':')[0] ?? v;
      return `${label(f)} set to ${word}`;
    })
    .replace(/`([a-z-]+)`/g, (m, n: string) => (byName.has(n) ? label(byName.get(n)!) : m));
}

function formatDate(seconds: number): string {
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? 'a date' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** How the tabs are named in the words of a command: `/setup sheet` becomes the **Google Sheet** tab. */
export function tabPhrase(text: string): string {
  const named = (sub: string): string => {
    const meta = META[sub];
    return meta ? `the **${meta.label}** tab` : 'the settings page';
  };
  return text.replace(/`\/setup ([a-z-]+)[^`]*`/g, (_m, sub: string) => named(sub)).replace(/\/setup ([a-z][a-z-]*)/g, (_m, sub: string) => named(sub)).replace(/`\/setup`|\/setup\b/g, 'the settings page');
}

export interface SetupConsoleDeps {
  ctx: BotContext;
  discord: ConsoleDiscord;
}

export class SetupConsole {
  constructor(private readonly deps: SetupConsoleDeps) {}

  tabs(): TabDef[] {
    return setupTabs();
  }

  /** The servers the bot is in, each with its airlines. */
  servers(): ConsoleServer[] {
    const { ctx, discord } = this.deps;
    return discord.guilds().map((g) => ({
      id: g.id,
      name: g.name,
      airlines: ctx.store.listPanels(g.id).map((p) => ({ id: p.id, name: p.airlineName, abbr: p.airlineAbbr ?? null, prefix: p.prefix })),
    }));
  }

  private async guildOf(id: string): Promise<Guild> {
    const guild = id ? await this.deps.discord.guild(id) : null;
    if (!guild) throw new UserError("I'm not in that server (any more). Choose another, or add the bot to it again.");
    return guild;
  }

  /** The channels and roles of a server, for the drop-downs. */
  async choices(guildId: string): Promise<ConsoleChoices> {
    const guild = await this.guildOf(guildId);
    const channels = [...guild.channels.cache.values()].filter((c) => POSTING_TYPES.has(c.type)).sort((a, b) => ((a as { rawPosition?: number }).rawPosition ?? 0) - ((b as { rawPosition?: number }).rawPosition ?? 0));
    const roles = [...guild.roles.cache.values()].filter((r) => !r.managed).sort((a, b) => b.position - a.position);
    return {
      channels: channels.map((c) => ({ id: c.id, name: c.name })),
      roles: roles.map((r) => ({ id: r.id, name: r.id === guild.id ? '@everyone' : r.name })),
    };
  }

  /** Turn what a command said into what the page shows: mentions become names, dates are written out, and `/setup x` becomes the name of the tab. */
  private async plain(guild: Guild, text: string, def?: Pick<TabDef, 'fields'>): Promise<string> {
    const userIds = [...new Set([...text.matchAll(/<@!?(\d{15,22})>/g)].map((m) => m[1] as string))].slice(0, 25);
    const users = new Map<string, string>();
    for (const id of userIds) {
      const u = await this.deps.discord.user(id).catch(() => null);
      users.set(id, u ? u.username : 'a Discord user');
    }
    const out = text
      .replace(/<#(\d{15,22})>/g, (_m, id: string) => `#${guild.channels.cache.get(id)?.name ?? 'a channel'}`)
      .replace(/<@&(\d{15,22})>/g, (_m, id: string) => `@${id === guild.id ? 'everyone' : (guild.roles.cache.get(id)?.name ?? 'a role')}`)
      .replace(/<@!?(\d{15,22})>/g, (_m, id: string) => `@${users.get(id) ?? 'a Discord user'}`)
      .replace(/<t:(-?\d+)(?::[a-zA-Z])?>/g, (_m, s: string) => formatDate(Number(s)));
    const named = tabPhrase(out);
    return def ? boxWords(def, named) : named;
  }

  /** Check what was typed against the definition of each box, as Discord did for the command, and turn it into what the command reads. */
  private async options(def: TabDef, values: Record<string, unknown>, guild: Guild, airline: Panel | null): Promise<Map<string, unknown>> {
    const options = new Map<string, unknown>();
    if (def.scope === 'airline' && airline) options.set('airline', airline.prefix);
    for (const f of def.fields) {
      const raw = values[f.name];
      const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
      if (empty) {
        if (f.required) throw new UserError(`${f.label} is needed.`);
        continue;
      }
      switch (f.kind) {
        case 'text': {
          if (typeof raw !== 'string') throw new UserError(`${f.label} has to be text.`);
          const v = raw.trim();
          if (f.minLength !== undefined && v.length < f.minLength) throw new UserError(`${f.label} has to be at least ${f.minLength} characters.`);
          if (f.maxLength !== undefined && v.length > f.maxLength) throw new UserError(`${f.label} has to be ${f.maxLength} characters or fewer.`);
          options.set(f.name, v);
          break;
        }
        case 'select': {
          const v = String(raw);
          if (!f.choices?.some((c) => c.value === v)) throw new UserError(`${f.label}: choose one of the choices offered.`);
          options.set(f.name, v);
          break;
        }
        case 'number': {
          const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
          if (!Number.isInteger(n)) throw new UserError(`${f.label} has to be a whole number.`);
          if (f.min !== undefined && n < f.min) throw new UserError(`${f.label} has to be at least ${f.min}.`);
          if (f.max !== undefined && n > f.max) throw new UserError(`${f.label} can be at most ${f.max}.`);
          options.set(f.name, n);
          break;
        }
        case 'channel': {
          const id = String(raw).trim();
          const channel = await guild.channels.fetch(id).catch(() => null);
          if (!channel || !POSTING_TYPES.has(channel.type)) throw new UserError(`${f.label}: choose a text channel of this server.`);
          options.set(f.name, channel);
          break;
        }
        case 'role': {
          const id = String(raw).trim();
          const role = id === guild.id ? guild.roles.everyone : await guild.roles.fetch(id).catch(() => null);
          if (!role) throw new UserError(`${f.label}: choose a role of this server.`);
          options.set(f.name, role);
          break;
        }
        case 'user': {
          const id = DISCORD_ID.exec(String(raw))?.[1];
          if (!id) throw new UserError(`${f.label}: give the person's Discord user ID (in Discord: Settings, Advanced, turn on Developer Mode, then right-click the person and choose Copy User ID).`);
          const user = await this.deps.discord.user(id);
          if (!user) throw new UserError(`I couldn't find a Discord user with the ID ${id}.`);
          options.set(f.name, user);
          break;
        }
        case 'file': {
          const file = raw as { name?: unknown; text?: unknown };
          if (!file || typeof file !== 'object' || typeof file.text !== 'string') throw new UserError(`${f.label}: choose a file.`);
          const size = Buffer.byteLength(file.text, 'utf8');
          if (size > MAX_IMPORT_BYTES) throw new UserError(`That file is larger than ${MAX_IMPORT_BYTES / 1024} KB.`);
          options.set(f.name, { name: typeof file.name === 'string' && file.name !== '' ? file.name : 'flights.csv', size, url: '', inlineText: file.text });
          break;
        }
      }
    }
    return options;
  }

  /**
   * Run a tab's command, as the server's owner: with what was typed in its form, or (`status`) with nothing to change, to say how things stand. A refusal comes back
   * as a result with `ok: false` and the reason, as it would have been said in Discord.
   */
  async run(req: ConsoleRun): Promise<ConsoleResult> {
    const { ctx, discord } = this.deps;
    const def = this.tabs().find((t) => t.id === req.tab);
    if (!def || def.custom) return { ok: false, text: 'That tab is not one I know.', files: [] };
    let guild: Guild;
    try {
      guild = await this.guildOf(req.guild);
    } catch (e) {
      return { ok: false, text: describeError(e, ctx.log), files: [] };
    }
    try {
      let airline: Panel | null = null;
      if (def.scope === 'airline') {
        airline = req.panel ? ctx.store.getPanel(req.panel) : null;
        if (!airline || airline.guildId !== guild.id) throw new UserError('Choose an airline first (at the top of the page).');
      }
      const meta = META[def.id] as Meta;
      const values = req.status ? (meta.statusValues ?? {}) : (req.values ?? {});
      if (def.id === 'profit' && airline && !req.status) {
        const action = String(values.action ?? '');
        const sendTo = String(values['send-to'] ?? airline.profitSendTo);
        if ((action === 'fill' || action === 'deductions') && sendTo === 'here') {
          throw new UserError("A Fill or Deductions preview has Write and Cancel buttons, and those only work in Discord, so it can't be confirmed from this page. First set **Send the preview to** to **DM** (your Discord direct messages) or **Channel**, and press **Run**; then run it again.");
        }
      }
      const options = req.status && meta.status === 'overview' ? new Map<string, unknown>() : await this.options(def, values, guild, airline);
      const replies: Array<{ content?: string; files?: Array<{ attachment?: unknown; name?: string | null }> }> = [];
      const owner = (await discord.user(guild.ownerId)) ?? ({ id: guild.ownerId, bot: false, username: 'the server owner' } as unknown as User);
      const get = (name: string, required?: boolean) => {
        const v = options.get(name);
        if (v === undefined && required) throw new UserError(`${capitalise(name)} is needed.`);
        return v ?? null;
      };
      const sub = req.status && meta.status === 'overview' ? OVERVIEW_TAB : def.id;
      const interaction = {
        user: owner,
        guild,
        guildId: guild.id,
        channelId: airline?.channelId ?? null,
        member: { roles: [] },
        memberPermissions: { has: () => true },
        deferred: false,
        replied: false,
        options: { getSubcommand: () => sub, getString: get, getInteger: get, getNumber: get, getBoolean: get, getUser: get, getChannel: get, getAttachment: get, getRole: get, getFocused: () => '' },
        deferReply: async () => undefined,
        editReply: async (p: { content?: string }) => void replies.push(p),
        reply: async (p: { content?: string }) => void replies.push(p),
        followUp: async (p: { content?: string }) => void replies.push(p),
      } as unknown as ChatInputCommandInteraction;
      await setupCommand.execute(ctx, interaction);
      const last = replies.at(-1);
      let text = last?.content ?? 'Done.';
      if (((last as { components?: unknown[] } | undefined)?.components?.length ?? 0) > 0) text += '\nButtons came with this answer; they work only in Discord, so they are not shown here.';
      if (req.status && meta.status === 'overview' && airline) {
        // The list of panels has a line for each airline: show this airline's.
        const mine = text.split('\n').find((l) => l.includes(`\`${airline!.prefix}-…\``));
        text = mine ?? text;
      }
      const files = (last?.files ?? []).flatMap((f) => {
        const data = f.attachment;
        return Buffer.isBuffer(data) ? [{ name: f.name ?? 'file.txt', text: data.toString('utf8') }] : [];
      });
      return { ok: true, text: await this.plain(guild, text, def), files };
    } catch (e) {
      return { ok: false, text: await this.plain(guild, describeError(e, ctx.log), def), files: [] };
    }
  }
}
