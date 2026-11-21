import type { Message } from 'discord.js';
import { plainText, truncate } from '../util/format.js';
import { isAdminMember, lookUpMember, type GuildLike, type MemberLike } from './access.js';
import type { BotContext } from './context.js';

/** What people send to ask what they can do: `commands`, `/commands`, `list commands`, `show my commands`, `help`. */
export const COMMANDS_REQUEST = /^\/?(?:(?:show|list)\s+)?(?:(?:my|the|all)\s+)?(?:commands?|help)\s*[?!.]*$/i;

/** At most this many of the bot's servers are looked at for one request (each one is a question to Discord). */
const MAX_SERVERS = 25;
/** The most one message of the answer may hold (Discord allows 2000). */
const MESSAGE_LIMIT = 1900;
/** Someone who asks again within this long gets nothing new. */
const COOLDOWN_MS = 5000;
const lastAsked = new Map<string, number>();

/** A slash command of the bot, as it is registered: what it is called, what it does, and (when it has parts) their names and what they do. */
export interface SlashCommandInfo {
  name: string;
  description: string;
  subs: Array<{ name: string; description: string }>;
  /** Discord keeps it from everyone but admins by default (it is for server admins, and checked again when it runs). */
  adminOnly: boolean;
}

/**
 * The slash commands the bot has registered, read from the commands themselves so this list cannot fall behind them. (They are loaded when
 * asked for, because the commands module in turn uses this one.)
 */
export async function slashCommands(): Promise<SlashCommandInfo[]> {
  const { commands } = await import('./commands/index.js');
  return commands.map((c) => {
    const j = c.data.toJSON();
    return {
      name: j.name,
      description: j.description,
      subs: (j.options ?? []).filter((o) => o.type === 1).map((o) => ({ name: o.name, description: o.description })),
      adminOnly: j.default_member_permissions !== undefined && j.default_member_permissions !== null,
    };
  });
}

/** One of a server's airlines, and whether this person may reserve on its panel. */
export interface AirlineStanding {
  name: string;
  canBook: boolean;
  /** The role the panel is limited to, by name when it is known. */
  roleName: string | null;
  limited: boolean;
}

/** What a person is in one server, as far as the bot's commands go. */
export interface ServerStanding {
  name: string;
  /** Has Manage Server: every `/setup` command. */
  admin: boolean;
  /** Not an admin, but holds a role the admins chose with `/setup refresh-roles`: `/setup refresh` and `/setup id-add`. */
  manager: boolean;
  airlines: AirlineStanding[];
}

/** What someone is in a server, from what is known of them there (admins always count as holding any role, as they do for the Reserve button). */
export function standingIn(ctx: BotContext, guildId: string, name: string, admin: boolean, hasRole: (roleId: string) => boolean, roleName: (roleId: string) => string | null): ServerStanding {
  return {
    name,
    admin,
    manager: !admin && ctx.store.listRefreshRoles(guildId).some(hasRole),
    airlines: ctx.store.listPanels(guildId).map((p) => ({
      name: p.airlineName,
      limited: p.requiredRoleId !== null,
      canBook: p.requiredRoleId === null || admin || hasRole(p.requiredRoleId),
      roleName: p.requiredRoleId === null ? null : roleName(p.requiredRoleId),
    })),
  };
}

/** What the person is in each server the bot is in and they are too, asked of Discord. `unsure` counts the servers it could not find out about. */
export async function dmStandings(ctx: BotContext, message: Message): Promise<{ standings: ServerStanding[]; unsure: number }> {
  const standings: ServerStanding[] = [];
  let unsure = 0;
  for (const guild of [...message.client.guilds.cache.values()].slice(0, MAX_SERVERS)) {
    const found = await lookUpMember(message.client, guild.id, message.author.id);
    if (!found.ok) {
      if (found.reason === 'unsure') unsure++;
      continue;
    }
    const member: MemberLike = found.member;
    const g: GuildLike = found.guild;
    standings.push(
      standingIn(ctx, guild.id, guild.name, isAdminMember(member), (id) => member.roles?.cache?.has(id) === true, (id) => g.roles?.cache?.get(id)?.name ?? null),
    );
  }
  return { standings, unsure };
}

/* ------------------------------------------------------------------ wording */

/** What can be sent to the bot in a DM, whoever you are. */
const DM_COMMANDS: string[] = [
  "• `reserve <flight ID>`, or just the ID: reserve a flight. Several at once: `<ID>, <ID>`.",
  '• `backup <flight ID>`: stand by as the backup for a flight that is already taken.',
  '• `flights`: the flights you hold, with a menu to give any back.',
  '• `my contributions`: what the flights you completed in the last 7 days made for the airline.',
  '• `metar EGLL`: the weather at an airport in plain language (up to three airports, or paste a METAR).',
  '• `notifications`: choose which messages I send you.',
  "• `name <your name>`: the name I put against your flights in the airline's sheet.",
  '• `fshub <your ID>`: set your FsHub pilot ID.',
  '• `/banking`: a message whenever money goes into or out of your Aeroconomy bank accounts.',
  '• `/monitor <flight number>`: a message when a flight is about to land.',
  '• `cancel`: close the conversation we have open.',
  '• `commands`: this list.',
];

/** A command's description as it follows its name: its first letter small, unless it starts a word in capitals (`ETA`). The descriptions are the bot's own words. */
const lowered = (t: string): string => (/^[A-Z][a-z]/.test(t) ? `${t[0]!.toLowerCase()}${t.slice(1)}` : t);
const slashLine = (command: string, description: string): string => `• \`${command}\`: ${lowered(description)}`;

/** A server's line: what the person is there, and which airlines they may reserve for. */
function serverLine(s: ServerStanding, where: 'dm' | 'server'): string[] {
  const role = s.admin ? 'a server admin (you have Manage Server)' : s.manager ? 'a manager (you can run `/setup refresh` and `/setup id-add`)' : 'a member';
  const head = where === 'dm' ? `• **${plainText(truncate(s.name, 60))}**: you are ${role}.` : `You are ${role}.`;
  if (s.airlines.length === 0) return [`${head} No airline has a panel here yet.`];
  const open = s.airlines.filter((a) => a.canBook).map((a) => `**${plainText(truncate(a.name, 40))}**`);
  const shut = s.airlines.filter((a) => !a.canBook);
  const parts = [head];
  if (open.length > 0) parts.push(`You can reserve and back up flights for ${open.join(', ')}.`);
  for (const a of shut) {
    parts.push(`Reserving for **${plainText(truncate(a.name, 40))}** is limited to ${a.roleName ? `the **${plainText(truncate(a.roleName, 40))}** role` : 'a role'}, which you don't have.`);
  }
  return [parts.join(' ')];
}

/** Pack groups of lines into messages that fit Discord, keeping a group together where it fits, and splitting a too-long one by line. */
function pack(groups: string[][]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length > 0) out.push(cur.join('\n').trim());
    cur = [];
    size = 0;
  };
  for (const g of groups) {
    const len = g.join('\n').length + 2;
    if (size + len <= MESSAGE_LIMIT) {
      cur.push(...g, '');
      size += len;
      continue;
    }
    flush();
    if (len <= MESSAGE_LIMIT) {
      cur.push(...g, '');
      size = len;
      continue;
    }
    const [head = '', ...items] = g;
    let part: string[] = [head];
    let partSize = head.length;
    for (const line of items) {
      if (partSize + line.length + 1 > MESSAGE_LIMIT) {
        out.push(part.join('\n'));
        part = [`${head} (continued)`];
        partSize = part[0]!.length;
      }
      part.push(line);
      partSize += line.length + 1;
    }
    cur = [...part, ''];
    size = partSize + 2;
  }
  flush();
  return out;
}

/**
 * Everything the person can do with the bot at their level, as messages. Whoever they are: what a DM understands, the commands anyone can
 * use in a server, and what each server they belong to makes of them (which airlines they may reserve for). Server admins also get every admin
 * command (named and described as the commands themselves describe them), and managers the two a role can be given.
 */
export function commandsMessages(standings: ServerStanding[], slash: SlashCommandInfo[], o: { where: 'dm' | 'server'; unsure?: number }): string[] {
  const groups: string[][] = [];
  groups.push(['**What you can do with me**', 'In a DM to me:', ...DM_COMMANDS]);

  const everyone = slash.filter((c) => !c.adminOnly);
  groups.push([
    '**In a server**',
    'The buttons under an airline\'s panel: **Reserve**, **Backup pilot**, **Search**, **My flights**, **Complete** and **List view**.',
    ...everyone.map((c) => slashLine(`/${c.name}`, c.description)),
  ]);

  if (standings.length === 0) {
    groups.push([
      o.where === 'dm' ? '**Your servers**' : '**This server**',
      o.where === 'dm'
        ? "I don't share a server with you, so there is nothing to reserve or set up. The weather, `/banking` and `/monitor` still work in a DM."
        : 'I could not find your place in this server.',
    ]);
  } else {
    groups.push([o.where === 'dm' ? '**Your servers**' : '**This server**', ...standings.flatMap((s) => serverLine(s, o.where))]);
  }
  if ((o.unsure ?? 0) > 0) groups.push([`I couldn't check ${o.unsure === 1 ? 'one server' : `${o.unsure} servers`} just now, so ${o.unsure === 1 ? 'it is' : 'they are'} not above. Ask again in a minute.`]);

  const admins = standings.filter((s) => s.admin);
  if (admins.length > 0) {
    const where = admins.length === 1 && o.where === 'server' ? '' : ` (${admins.map((s) => plainText(truncate(s.name, 40))).join(', ')})`;
    for (const c of slash.filter((x) => x.adminOnly)) {
      groups.push([
        `**Server admin: \`/${c.name}\`**${where}`,
        ...(c.subs.length > 0 ? c.subs.map((s) => slashLine(`/${c.name} ${s.name}`, s.description)) : [slashLine(`/${c.name}`, c.description)]),
      ]);
    }
  }
  const managers = standings.filter((s) => s.manager);
  if (managers.length > 0) {
    const setup = slash.find((c) => c.name === 'setup');
    const lines = ['refresh', 'id-add'].flatMap((name) => {
      const sub = setup?.subs.find((x) => x.name === name);
      return sub ? [slashLine(`/setup ${name}`, sub.description)] : [];
    });
    groups.push([`**Manager** (a role your admins chose)${o.where === 'dm' ? ` in ${managers.map((s) => plainText(truncate(s.name, 40))).join(', ')}` : ''}`, ...lines]);
  }
  return pack(groups);
}

/** Answer someone who sent `commands` in a DM. */
export async function showCommands(ctx: BotContext, message: Message, send: (text: string) => Promise<void>): Promise<void> {
  const now = ctx.now();
  const last = lastAsked.get(message.author.id);
  if (last !== undefined && now - last < COOLDOWN_MS) return;
  lastAsked.set(message.author.id, now);
  if (lastAsked.size > 5000) for (const [k, t] of lastAsked) if (now - t >= COOLDOWN_MS) lastAsked.delete(k);

  const { standings, unsure } = await dmStandings(ctx, message);
  for (const text of commandsMessages(standings, await slashCommands(), { where: 'dm', unsure })) await send(text);
}
