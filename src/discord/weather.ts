import type { EmbedBuilder, Message } from 'discord.js';
import { MetarError, normalizeStation } from '../metar/client.js';
import { decodeMetar, looksLikeMetar } from '../services/metar.js';
import { truncate } from '../util/format.js';
import type { BotContext } from './context.js';
import { metarEmbed } from './metarUi.js';
import { noPings } from './ui.js';

/** What people send to ask for weather: `metar`, `metar EGLL`, `METAR EGLL KJFK`, or a pasted report after it. */
export const METAR_REQUEST = /^metar(?:\s+([\s\S]*))?$/i;

/** One person can ask this often, so a busy chat cannot flood VATSIM through the bot. */
export const METAR_COOLDOWN_MS = 3_000;
/** At most this many airports (or pasted reports) are answered for one message. */
export const MAX_REPORTS = 3;
const lastUse = new Map<string, number>();
/** People with a request already being worked on. */
const busy = new Set<string>();

/** Words people put between airports that are not airports. */
const FILLER = new Set(['FOR', 'AT', 'IN', 'AND', 'OR', 'THE', 'AIRPORT', 'PLEASE', 'FROM', 'AT:', 'OF']);

export const METAR_HELP = [
  '**Weather reports (METAR).** Send me `metar` and an airport code, like `metar EGLL`, and I fetch the current report from VATSIM and explain it in plain language. You can give up to 3 airports: `metar EGLL KJFK`.',
  "Already have a report? Paste it after `metar` (or on its own) and I'll translate that instead.",
  'Airport codes are the four-letter ICAO ones: EGLL for London Heathrow, and US airports start with a K (KJFK, not JFK).',
].join('\n');

/**
 * The reports in some pasted text: reports may be separated by `=` or sit one to a line; a report spread over several lines
 * (copied from a page that wraps it) is joined up.
 */
export function splitReports(text: string): string[] {
  return text
    .split('=')
    .flatMap((chunk) => {
      const lines = chunk
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 1 && lines.every((l) => looksLikeMetar(l))) return lines;
      return [lines.join(' ')];
    })
    .filter((c) => c.trim().length > 0);
}

type Person = Message['author'];

async function say(user: Person, content: string): Promise<void> {
  await user.send({ content: truncate(content, 1990), allowedMentions: noPings });
}

async function sendCard(user: Person, embed: EmbedBuilder): Promise<void> {
  await user.send({ embeds: [embed], allowedMentions: noPings });
}

/**
 * `metar ...` in a DM (or a METAR pasted on its own). With airport codes the current report for each is fetched from VATSIM's
 * METAR service; with a pasted report that report is translated. Either way the answer is the report in plain language.
 */
export async function showMetar(ctx: BotContext, message: Message, argument: string): Promise<void> {
  const user = message.author;
  if (busy.has(user.id)) {
    await say(user, "I'm still working on your last request. Give me a moment.");
    return;
  }
  const arg = argument.trim();
  if (!arg) {
    await say(user, METAR_HELP);
    return;
  }

  // A pasted report is translated on the spot and never leaves the bot, so it is never held up. Only asking VATSIM has a pause.
  const pasted = /\b\d{6}Z\b/i.test(arg);
  if (!pasted) {
    const now = ctx.now();
    const last = lastUse.get(user.id);
    if (last !== undefined && now - last < METAR_COOLDOWN_MS) {
      await say(user, 'One moment, then ask again.');
      return;
    }
    lastUse.set(user.id, now);
    if (lastUse.size > 5000) for (const [k, t] of lastUse) if (now - t > METAR_COOLDOWN_MS) lastUse.delete(k);
  }

  busy.add(user.id);
  try {
    if (pasted) await translatePasted(ctx, user, arg);
    else await fetchAndTranslate(ctx, user, arg);
  } finally {
    busy.delete(user.id);
  }
}

async function translatePasted(ctx: BotContext, user: Person, arg: string): Promise<void> {
  if (/^\s*TAF\b/i.test(arg)) {
    await say(user, "That looks like a forecast (a TAF). I only translate METARs, which are the current report, so far.");
    return;
  }
  const reports = splitReports(arg);
  let done = 0;
  for (const text of reports.slice(0, MAX_REPORTS)) {
    const decoded = decodeMetar(text, { now: ctx.now() });
    if (!decoded) {
      await say(user, `I couldn't read \`${text.replace(/`/g, "'").slice(0, 60)}\` as a METAR. A METAR starts with the airport's four-letter code and the day and time, like \`EGLL 161350Z\`.`);
      continue;
    }
    await sendCard(user, metarEmbed(decoded, 'pasted'));
    done++;
  }
  if (reports.length > MAX_REPORTS) await say(user, `I translated the first ${MAX_REPORTS}. Send the rest in another message.`);
  if (done === 0 && reports.length === 0) await say(user, METAR_HELP);
}

async function fetchAndTranslate(ctx: BotContext, user: Person, arg: string): Promise<void> {
  const tokens = arg.toUpperCase().split(/[\s,;]+/).filter((t) => t && !FILLER.has(t));
  const codes: string[] = [];
  const refused: string[] = [];
  for (const token of tokens) {
    const code = normalizeStation(token);
    if (code === null) refused.push(token.replace(/`/g, "'").slice(0, 20));
    else if (!codes.includes(code)) codes.push(code);
  }
  if (codes.length === 0) {
    await say(
      user,
      `${refused.length > 0 ? `I couldn't use ${refused.map((r) => `\`${r}\``).join(', ')} as an airport code. ` : ''}I need the four-letter ICAO code, like \`EGLL\` for London Heathrow or \`KJFK\` for New York JFK (US airports start with a K, so JFK is KJFK).`,
    );
    return;
  }
  if (refused.length > 0) await say(user, `I skipped ${refused.map((r) => `\`${r}\``).join(', ')}: not four-letter airport codes.`);

  for (const code of codes.slice(0, MAX_REPORTS)) {
    let report: string | null;
    try {
      report = await ctx.metar.report(code);
    } catch (e) {
      if (e instanceof MetarError) {
        await say(user, e.message);
        return;
      }
      throw e;
    }
    if (report === null) {
      await say(user, `VATSIM has no weather report for **${code}** right now. Check the code (it is the four-letter ICAO one, like \`EGLL\`), and note that small airfields often have no weather station.`);
      continue;
    }
    const decoded = decodeMetar(report, { now: ctx.now(), station: code });
    if (!decoded) {
      await say(user, `VATSIM sent a report for **${code}** that I couldn't read: \`${report.replace(/`/g, "'").slice(0, 200)}\``);
      continue;
    }
    await sendCard(user, metarEmbed(decoded, 'vatsim'));
  }
  if (codes.length > MAX_REPORTS) await say(user, `I answered the first ${MAX_REPORTS} airports. Ask again for the rest.`);
}
