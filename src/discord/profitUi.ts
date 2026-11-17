import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type MessageActionRowComponentBuilder } from 'discord.js';
import { dayName, formatMoney } from '../services/contributions.js';
import type { PayPlan, PayProblem, ProfitAnalysis, ProfitFillPlan } from '../services/airlineProfits.js';
import { WriteBackError } from '../services/writeback.js';
import { plainText, ts } from '../util/format.js';
import type { ComponentHandler } from './context.js';
import { isAdmin } from './guard.js';
import { noPings } from './ui.js';

/** A preview of cells to write waits this long for the admin to confirm it. */
const PENDING_TTL_MS = 10 * 60_000;
/** How many lines of each kind a message shows. */
const SHOWN_DIFFERENT = 8;
const SHOWN_FILLS = 8;
/** What a report may take of Discord's 2000 characters (a closing note is added after it), and what a preview may. */
const REPORT_BUDGET = 1650;
const PREVIEW_BUDGET = 1850;

interface Pending {
  userId: string;
  guildId: string;
  panelId: number;
  fills: ProfitFillPlan[];
  expiresAt: number;
}
const pending = new Map<string, Pending>();

/** Remember what an admin was shown, so pressing the button writes exactly that; returns the button's token. */
export function rememberFills(p: Omit<Pending, 'expiresAt'>, now: number): string {
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  const token = randomBytes(6).toString('hex');
  pending.set(token, { ...p, expiresAt: now + PENDING_TTL_MS });
  return token;
}

const PROBLEM_TEXT: Record<PayProblem, string> = {
  'no-flight-id': "the logbook names no FsHub flight, so the distance can't be checked",
  'no-distance': "FsHub gave no distance, so it isn't worked out",
  'distance-differs': "FsHub and Aeroconomy don't agree on the distance, so it isn't worked out",
};

/** The pilot's pay for a row, in words and how it was worked out, or why there is none. Empty when its cell isn't going to be filled anyway. */
function payText(p: PayPlan): string {
  if (p.cell !== 'empty') return '';
  if (p.amount === null || p.problem !== null) return ` · pilot pay: ${p.problem ? PROBLEM_TEXT[p.problem] : 'not worked out'}`;
  const how = p.basis === 'share' ? '15% of the profit' : p.basis === 'minimum' ? 'the $2,000 minimum' : `loss, ${Math.round(p.distanceNm ?? 0).toLocaleString('en-US')} nm flown`;
  return ` · pilot pay ${formatMoney(p.amount)} (${how})`;
}

/** How the pay of the blank rows stands: to be filled, already filled in (left alone), or not worked out. */
function paySummary(fills: ProfitFillPlan[]): { fill: number; kept: number; none: number; noColumn: number } {
  return {
    fill: fills.filter((f) => f.payPlan.cell === 'empty' && f.payPlan.amount !== null).length,
    kept: fills.filter((f) => f.payPlan.cell === 'filled').length,
    none: fills.filter((f) => f.payPlan.cell === 'empty' && f.payPlan.amount === null).length,
    noColumn: fills.filter((f) => f.payPlan.cell === 'missing').length,
  };
}

const row = (n: number, text: string) => `row ${n} · ${text}`;
const flight = (callsign: string, route: string, day: number) => `${callsign ? `${plainText(callsign)} ` : ''}${route} · ${dayName(day)}`;

/** Add as many of `items` to `lines` as fit in `budget` characters in all, and say how many were left out. */
function addWithin(lines: string[], items: string[], budget: number, total = items.length): void {
  let shown = 0;
  for (const item of items) {
    if ([...lines, item, `…and ${total - shown - 1} more.`].join('\n').length > budget) break;
    lines.push(item);
    shown++;
  }
  if (shown < total) lines.push(`…and ${total - shown} more.`);
}

/** One line on the pilots' pay beside the blank profits. */
function payBullet(fills: ProfitFillPlan[]): string {
  const s = paySummary(fills);
  if (s.noColumn === fills.length) return '• 💵 The sheet has no Pilot Pay column, so only Profit Made would be filled';
  const parts = [
    ...(s.fill > 0 ? [`**${s.fill}** empty, with a pay I can work out`] : []),
    ...(s.none > 0 ? [`**${s.none}** empty, with a pay I can't work out yet`] : []),
    ...(s.kept > 0 ? [`**${s.kept}** already filled in (left exactly as they are)`] : []),
  ];
  return `• 💵 Pilot Pay beside those: ${parts.join(', ')}`;
}

/** What was found, in words. Reading only: nothing in it has been changed. */
export function profitReport(airline: string, a: ProfitAnalysis): string {
  const lines = [
    `💰 **Profit check: ${plainText(airline)}**`,
    `I read ${a.aircraft} aircraft logbook${a.aircraft === 1 ? '' : 's'} from Aeroconomy (${a.logbookFlights} flights, ${a.usableFlights} flown under the airline's own callsign) and compared them with the ${a.sheetCompleted} flights ticked as completed in the sheet.`,
    `• ✅ **${a.agree}** have a Profit Made that agrees with Aeroconomy (within a dollar)`,
    `• ✏️ **${a.different.length}** have a Profit Made that is not what Aeroconomy says`,
    `• ⬜ **${a.fills.length}** have a blank Profit Made that Aeroconomy can fill in`,
    ...(a.fills.length > 0 ? [payBullet(a.fills)] : []),
    ...(a.unreadable > 0 ? [`• 🔒 **${a.unreadable}** have something in Profit Made that is not an amount (like TBD): left exactly as it is`] : []),
    `• ❔ **${a.unmatched}** I found no logbook flight for, and **${a.ambiguous}** could be more than one flight (left alone)`,
  ];
  if (a.different.length > 0) {
    lines.push('', '**Different** (the sheet is not changed; a manager should look):');
    const shown = a.different.slice(0, SHOWN_DIFFERENT).map((d) => `• ${row(d.row, `${flight(d.callsign, d.route, d.day)} · sheet ${formatMoney(d.sheet)} · Aeroconomy ${formatMoney(d.aeroconomy)}`)}`);
    addWithin(lines, shown, Math.round(REPORT_BUDGET * 0.6), a.different.length);
  }
  if (a.fills.length > 0) {
    lines.push('', '**Blank, could be filled in:**');
    const shown = a.fills.slice(0, SHOWN_FILLS).map((f) => `• ${row(f.row, `${flight(f.callsign, f.route, f.day)} · ${formatMoney(f.value)}${payText(f.payPlan)}`)}`);
    addWithin(lines, shown, REPORT_BUDGET, a.fills.length);
  }
  return lines.join('\n');
}

/** What pressing the button would write, for the admin to read first. */
export function previewText(airline: string, fills: ProfitFillPlan[]): string {
  const closing = 'Each one is checked again against the sheet as it is when you press the button, and skipped if its row has moved, its pilot or box has changed, or the cell is no longer empty. Nothing is written unless you press **Write**.';
  const lines = [
    `✍️ **Fill blank Profit Made cells: ${plainText(airline)}**`,
    `I would write the profit Aeroconomy gives, in whole dollars as your sheet is kept, into **${fills.length}** Profit Made cell${fills.length === 1 ? '' : 's'} that ${fills.length === 1 ? 'is' : 'are'} empty today${payIntro(fills)}`,
    '',
  ];
  const shown = fills.slice(0, SHOWN_FILLS).map((f) => `• ${row(f.row, `${flight(f.callsign, f.route, f.day)} · ${formatMoney(f.value)} (Aeroconomy: ${formatMoney(f.exact)})${payText(f.payPlan)}`)}`);
  addWithin(lines, shown, PREVIEW_BUDGET - closing.length - 2, fills.length);
  lines.push('', closing);
  return lines.join('\n');
}

/** The rest of the preview's opening sentence: what would go in the Pilot Pay cells, and what would not. */
function payIntro(fills: ProfitFillPlan[]): string {
  const s = paySummary(fills);
  const left = [
    ...(s.kept > 0 ? [`**${s.kept}** already have something in Pilot Pay`] : []),
    ...(s.none > 0 ? [`**${s.none}** have a pay I can't work out`] : []),
  ];
  const tail = left.length > 0 ? ` (${left.join('; ')}: left as they are)` : '';
  const nothingElse = ' I would change nothing else, and no cell that has anything in it.';
  if (s.noColumn === fills.length) return `. The sheet has no Pilot Pay column.${nothingElse}`;
  if (s.fill === 0) return `${tail}.${nothingElse}`;
  const rule = "15% of the profit (at least $2,000), or for a flight that lost money $2,000 plus $1,000 per 500 nm beyond the first 1,000, by FsHub's distance";
  return `, and the pilot's pay into **${s.fill}** empty Pilot Pay cell${s.fill === 1 ? '' : 's'}: ${rule}${tail}.${nothingElse}`;
}

export function profitButtons(token: string, count: number): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`profit:go:${token}`).setLabel(`Write ${count} cell${count === 1 ? '' : 's'}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`profit:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const REASON_TEXT: Record<string, string> = {
  gone: 'the row is no longer in the sheet',
  moved: 'the row has moved',
  changed: 'the pilot named on the row changed',
  'not-completed': 'the row is no longer ticked as completed',
  filled: 'the cell has something in it now',
};

/** The buttons of the preview: `profit:go:<token>` writes it, `profit:no:<token>` drops it. Only the admin who asked can press them. */
export const profitHandler: ComponentHandler = {
  prefix: 'profit',
  async handle(ctx, interaction) {
    if (!interaction.isButton()) return;
    const [, way, token] = interaction.customId.split(':');
    const wanted = token ? pending.get(token) : undefined;
    const now = ctx.now();
    if (!wanted || wanted.expiresAt < now || (way !== 'go' && way !== 'no')) {
      if (token) pending.delete(token);
      await interaction.update({ content: 'That preview has expired or was already used, and nothing was written. Run `/setup profit action:fill` again to see the cells afresh.', components: [], allowedMentions: noPings });
      return;
    }
    if (interaction.user.id !== wanted.userId || !isAdmin(interaction)) {
      await interaction.reply({ content: 'Only the admin who asked for this can confirm it.', flags: MessageFlags.Ephemeral });
      return;
    }
    pending.delete(token as string);
    if (way === 'no') {
      await interaction.update({ content: 'Cancelled. Nothing was written to the sheet.', components: [], allowedMentions: noPings });
      return;
    }

    await interaction.deferUpdate();
    const panel = ctx.store.getPanel(wanted.panelId);
    if (!panel || !ctx.writeback || !ctx.writeback.enabledFor(panel)) {
      await interaction.editReply({ content: "I can't write to that sheet any more (the panel is gone, or writing to it was switched off), so nothing was written.", components: [], allowedMentions: noPings });
      return;
    }
    try {
      const result = await ctx.writeback.fillProfits(panel, wanted.fills);
      const skipped = new Map<string, number>();
      for (const s of result.skipped) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + 1);
      const lines = [
        `✅ Wrote **${result.written.length}** Profit Made cell${result.written.length === 1 ? '' : 's'} in the sheet at ${ts(now, 't')}${result.written.length > 0 ? `: ${result.written.slice(0, 12).map((w) => w.cell).join(', ')}${result.written.length > 12 ? '…' : ''}` : '.'}`,
        ...(result.paid.length > 0 ? [`💵 And **${result.paid.length}** Pilot Pay cell${result.paid.length === 1 ? '' : 's'}: ${result.paid.slice(0, 12).map((w) => w.cell).join(', ')}${result.paid.length > 12 ? '…' : ''}`] : []),
        ...(result.payLeft > 0 ? [`Left alone: **${result.payLeft}** Pilot Pay cell${result.payLeft === 1 ? '' : 's'} had something in ${result.payLeft === 1 ? 'it' : 'them'} by then.`] : []),
        ...(result.skipped.length > 0 ? [`Left alone, because they changed since the preview: ${[...skipped].map(([r, n]) => `${n} (${REASON_TEXT[r] ?? r})`).join('; ')}.`] : []),
      ];
      await interaction.editReply({ content: lines.join('\n'), components: [], allowedMentions: noPings });
    } catch (e) {
      if (!(e instanceof WriteBackError)) throw e;
      await interaction.editReply({ content: `I couldn't write to the sheet, so nothing was written: ${e.message}`, components: [], allowedMentions: noPings });
    }
  },
};
