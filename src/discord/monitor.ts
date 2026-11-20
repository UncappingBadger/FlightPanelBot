import type { Message } from 'discord.js';
import { MAX_MONITORS, NEAR_MINUTES, WAIT_FOR_FLIGHT_MS, parseFlightNumber } from '../services/flightMonitor.js';
import { plainText } from '../util/format.js';
import type { BotContext } from './context.js';
import { noPings } from './ui.js';

/** `/monitor` (the slash is optional) in a DM, and what may follow it: a flight number, or `stop` and one. */
export const MONITOR_REQUEST = /^\/?monitor(?:\s+([\s\S]*))?$/i;

/** One person can ask this often, so a busy chat cannot make the bot ask FsHub over and over. */
export const MONITOR_COOLDOWN_MS = 3_000;
const lastUse = new Map<string, number>();

export const MONITOR_HELP = [
  '✈️ **Watch a flight**',
  `Send me \`/monitor SKY330\` (a flight number: the airline's letters and the number) and I'll message you when that flight is about **${NEAR_MINUTES} minutes from landing**, and again when it has **landed**. I find it in FsHub's public live feed, so it works for any airline's flights that show there.`,
  `If it isn't in the air yet I keep looking for up to ${WAIT_FOR_FLIGHT_MS / 3_600_000} hours. You can watch up to ${MAX_MONITORS} flights at once.`,
  '`/monitor` shows what I am watching. `/monitor stop SKY330` stops one, and `/monitor stop all` stops them all.',
].join('\n');

type Sender = Message['author'];

async function say(user: Sender, content: string): Promise<void> {
  await user.send({ content, allowedMentions: noPings });
}

/** How a flight stands right now, in words. */
function standing(live: { phase: string | null; airborne: boolean; dep: string | null; arr: string | null; etaMinutes: number | null } | null): string {
  if (!live) return "It isn't in the live feed right now, so I'll keep looking for it.";
  const route = live.dep && live.arr ? `${live.dep} → ${live.arr}` : null;
  if (live.airborne) return `It is in the air now${route ? ` (${route})` : ''}${live.etaMinutes !== null && live.etaMinutes >= 0 ? `, about ${Math.round(live.etaMinutes)} minutes from landing by FsHub's estimate` : ''}.`;
  return `It is in the feed but on the ground at the moment${route ? ` (${route})` : ''}.`;
}

/**
 * `/monitor ...` in a DM: watch a flight by its number and be told when it is about ten minutes from landing and when it has landed; with nothing, see what is
 * being watched; with `stop`, stop one or all.
 */
export async function showMonitor(ctx: BotContext, message: Message, argument: string): Promise<void> {
  const user = message.author;
  const arg = argument.trim();

  const stop = /^(?:stop|cancel|remove|delete|off)(?:\s+(.*))?$/i.exec(arg);
  if (stop) {
    const what = (stop[1] ?? '').trim();
    if (!what) {
      await say(user, 'Which flight? Send `/monitor stop SKY330`, or `/monitor stop all` to stop watching every flight.');
      return;
    }
    const everything = what.toLowerCase() === 'all';
    const n = ctx.monitors.stop(user.id, what);
    await say(
      user,
      n === 0
        ? everything
          ? "I wasn't watching any flight for you."
          : "I wasn't watching that flight for you. `/monitor` shows what I am watching."
        : n === 1 && !everything
          ? `🔕 Stopped. I'm no longer watching **${plainText(what.toUpperCase().replace(/[\s_-]+/g, ''))}** for you.`
          : `🔕 Stopped. I'm no longer watching **${n}** flight${n === 1 ? '' : 's'} for you.`,
    );
    return;
  }

  if (!arg) {
    const mine = ctx.monitors.list(user.id);
    if (mine.length === 0) {
      await say(user, MONITOR_HELP);
      return;
    }
    await say(
      user,
      [
        `✈️ I'm watching **${mine.length}** flight${mine.length === 1 ? '' : 's'} for you:`,
        ...mine.map((m) => `• **${m.flightNo}**${m.state === 'airborne' ? ` (in the air${m.arr ? `, to ${m.arr}` : ''}${m.nearSent ? ', I have told you it is close' : ''})` : ' (not seen in the air yet)'}`),
        '',
        'Stop one with `/monitor stop SKY330`, or all with `/monitor stop all`.',
      ].join('\n'),
    );
    return;
  }

  const now = ctx.now();
  const last = lastUse.get(user.id);
  if (last !== undefined && now - last < MONITOR_COOLDOWN_MS) {
    await say(user, 'One moment, then ask again.');
    return;
  }
  lastUse.set(user.id, now);
  if (lastUse.size > 5000) for (const [k, t] of lastUse) if (now - t > MONITOR_COOLDOWN_MS) lastUse.delete(k);

  if (!parseFlightNumber(arg)) {
    await say(user, `I need a flight number: the airline's letters and the number, like \`SKY330\`. I couldn't use \`${arg.replace(/`/g, "'").slice(0, 40)}\`.`);
    return;
  }
  const r = await ctx.monitors.add(user.id, arg);
  if (r.kind === 'limit') {
    await say(user, `I can watch ${MAX_MONITORS} flights for you at once. Stop one first with \`/monitor stop <flight number>\`.`);
    return;
  }
  if (r.kind === 'already') {
    await say(user, `I'm already watching **${r.monitor.flightNo}** for you.`);
    return;
  }
  if (r.kind !== 'added') return;
  await say(
    user,
    `✈️ I'm watching **${r.monitor.flightNo}**. ${standing(r.live)}\nI'll message you when it is about ${NEAR_MINUTES} minutes from landing, and again when it has landed. \`/monitor\` shows what I'm watching and \`/monitor stop ${r.monitor.flightNo}\` stops it.`,
  );
}
