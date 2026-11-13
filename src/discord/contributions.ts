import type { Message } from 'discord.js';
import type { Panel } from '../db/store.js';
import { ImportError, str } from '../jobs/import.js';
import { downloadSheetCsv, sheetRefOf } from '../jobs/sheet.js';
import { CONTRIBUTION_DAYS, contributionPeriod, contributionsOf, dayName, formatMoney, readSheetFlights, type Contributions, type SheetFlight } from '../services/contributions.js';
import { plainText, truncate } from '../util/format.js';
import type { BotContext } from './context.js';

/** What people type to ask for their contributions: `my contributions`, `contributions`, `show my contribution`... */
export const CONTRIBUTIONS_REQUEST = /^(?:(?:show|get|send|check)\s+(?:me\s+)?)?(?:my\s+)?contributions?\s*[?!.]*$/i;

/** At most this many airlines' sheets are read for one request. */
const MAX_PANELS = 5;
/** Flights listed in one airline's answer (the total always counts every one of them). */
const MAX_LISTED = 12;
/** Flights named as not yet calculated in one airline's answer. */
const MAX_WAITING = 25;
/** Pilots with a request already being worked on, so asking again and again doesn't read the sheet again and again. */
const busy = new Set<string>();

type Person = Message['author'];

/** Is this person in that server? Their sheet figures are only for people who belong to the airline's server. */
async function inGuild(message: Message, guildId: string): Promise<boolean> {
  try {
    const guild = message.client.guilds.cache.get(guildId) ?? (await message.client.guilds.fetch(guildId));
    await guild.members.fetch(message.author.id);
    return true;
  } catch {
    return false;
  }
}

/** The names this person may be written as in a sheet: the one they gave (or Discord's names for them), and any the bot wrote before. */
function sheetNames(ctx: BotContext, user: Person): string[] {
  const given = ctx.store.getPilotName(user.id);
  const all = [given, ...(given ? [] : [str(user.globalName ?? '', 40), str(user.username, 40)]), ...ctx.store.listSheetNamesByUser(user.id)];
  const out: string[] = [];
  for (const n of all) if (n && !out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}

/** What to call a flight: its ID on the panel if it is still there, else the airline's own flight number, else its row in the sheet. */
function idOf(ctx: BotContext, panel: Panel, f: SheetFlight): string {
  return ctx.store.getJobBySourceKey(panel.id, f.sourceKey)?.code ?? f.flightNumber ?? `row ${f.row}`;
}

const line = (id: string, f: SheetFlight) =>
  `• **${plainText(id)}** · ${f.route} · ${dayName(f.day)} · ${f.profit === null ? '⏳ no profit entered yet' : formatMoney(f.profit)}`;

/**
 * One airline's answer: what the flights the pilot completed in the period made for it, the flights listed with their
 * profit, and which have no profit entered yet (by ID), with the total being only what can be seen.
 */
export function contributionsText(panel: Panel, now: number, c: Contributions, id: (f: SheetFlight) => string): string {
  const period = contributionPeriod(now);
  const head = `**Your contributions to ${plainText(truncate(panel.airlineName, 60))}**\n${dayName(period.start)} to ${dayName(period.lastDay)}: the last ${CONTRIBUTION_DAYS} days, Zulu time.`;
  const flights = c.completed.length === 1 ? '1 flight' : `${c.completed.length} flights`;

  const summary =
    c.calculated.length === 0
      ? `You completed ${flights}, but no profit has been entered for ${c.completed.length === 1 ? 'it' : 'any of them'} yet, so I can't see a total.`
      : c.waiting.length === 0
        ? `Airline profit from the ${flights} you completed: **${formatMoney(c.total)}**`
        : `Airline profit I can see so far: **${formatMoney(c.total)}**, from ${c.calculated.length} of the ${flights} you completed.`;

  const listed = c.completed.slice(0, MAX_LISTED).map((f) => line(id(f), f));
  const parts = [head, '', summary, '', ...listed];
  if (c.completed.length > listed.length) parts.push(`…and ${c.completed.length - listed.length} more.`);

  if (c.waiting.length > 0) {
    const ids = c.waiting.slice(0, MAX_WAITING).map((f) => `**${plainText(id(f))}**`);
    const extra = c.waiting.length - ids.length;
    const one = c.waiting.length === 1;
    parts.push(
      '',
      `⏳ **Not calculated yet:** ${ids.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}.`,
      `A manager hasn't entered the profit for ${one ? 'this flight' : 'these flights'} yet.${c.calculated.length > 0 ? ` The total above leaves ${one ? 'it' : 'them'} out, and will change once ${one ? 'it is' : 'they are'} filled in.` : ''}`,
    );
  }
  return parts.join('\n').slice(0, 1990);
}

/**
 * What was found for one panel: a message to send, and what kind of answer it is: the pilot's own figures, nothing found for
 * them, or a problem with the sheet (which is the whole answer for that airline).
 */
async function forPanel(ctx: BotContext, panel: Panel, names: string[]): Promise<{ text: string; kind: 'figures' | 'none' | 'problem' }> {
  const ref = sheetRefOf(panel);
  const airline = `**${plainText(truncate(panel.airlineName, 60))}**`;
  if (!ref) return { text: `${airline}: no sheet is linked.`, kind: 'problem' };
  let csv: string;
  try {
    csv = await downloadSheetCsv(ref, ctx.fetchFn);
  } catch (e) {
    ctx.log.warn(`Contributions: could not read the sheet of ${panel.airlineName}: ${e instanceof Error ? e.message : e}`);
    const why = e instanceof ImportError ? e.message : "I couldn't read the airline's sheet just now.";
    return { text: `${airline}: ${why} Try again in a minute.`, kind: 'problem' };
  }
  const sheet = readSheetFlights(csv);
  if (!sheet) return { text: `${airline}: I couldn't find the flights in that sheet (I look for columns called Route, Date, Pilot and Flight Completed).`, kind: 'problem' };
  if (!sheet.hasProfit) return { text: `${airline}: that sheet has no profit column (I look for one called *Profit Made*), so I can't work out what flights made.`, kind: 'problem' };

  const c = contributionsOf(sheet, names, ctx.now());
  if (c.completed.length === 0) return { text: '', kind: 'none' };
  return { text: contributionsText(panel, ctx.now(), c, (f) => idOf(ctx, panel, f)), kind: 'figures' };
}

/**
 * `my contributions` in a DM: for each airline the person belongs to that keeps a linked Google Sheet, read the sheet and add
 * up the airline's profit from the flights they completed in the last seven days. Flights a manager hasn't entered a profit
 * for are named by ID, and the total is only what can be seen.
 */
export async function showContributions(ctx: BotContext, message: Message, reply: (text: string) => Promise<void>): Promise<void> {
  const user = message.author;
  if (busy.has(user.id)) {
    await reply("I'm still working out your last request. Give me a moment.");
    return;
  }
  busy.add(user.id);
  try {
    const panels: Panel[] = [];
    for (const p of ctx.store.listAllPanels().filter((x) => x.sheetId).sort((a, b) => a.airlineName.localeCompare(b.airlineName))) {
      if (panels.length < MAX_PANELS && (await inGuild(message, p.guildId))) panels.push(p);
    }
    if (panels.length === 0) {
      await reply("I work this out from an airline's Google Sheet, and I don't know of one linked to a server you're in. Ask your airline's managers whether its sheet is linked with `/setup sheet`.");
      return;
    }

    const names = sheetNames(ctx, user);
    const answers: string[] = [];
    const kinds = new Set<string>();
    for (const panel of panels) {
      const r = await forPanel(ctx, panel, names);
      kinds.add(r.kind);
      if (r.text) answers.push(r.text);
    }
    // Nothing found for them, and nothing wrong with any sheet: say whose name was looked for. (A sheet that couldn't be read says so itself.)
    if (!kinds.has('figures') && !kinds.has('problem')) {
      answers.push(
        `I found no flights completed in the last ${CONTRIBUTION_DAYS} days under the name${names.length === 1 ? '' : 's'} ${names.map((n) => `**${plainText(n)}**`).join(', ')}. If the sheet has you under another name, send me \`name <your name as the sheet has it>\` and ask again.`,
      );
    }
    for (const text of answers) await reply(text);
  } finally {
    busy.delete(user.id);
  }
}
