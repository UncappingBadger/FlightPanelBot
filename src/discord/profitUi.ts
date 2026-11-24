import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Panel, ProfitSendTo } from '../db/store.js';
import { dayName, formatMoney } from '../services/contributions.js';
import type { DeductionAnalysis, DeductionFill, HeldFlight, PayPlan, PayProblem, ProfitAnalysis, ProfitFillPlan } from '../services/airlineProfits.js';
import { WriteBackError } from '../services/writeback.js';
import { plainText, ts } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { isDmClosed, isMissingAccess, UserError } from './errors.js';
import { isAdmin, memberHasAnyRole } from './guard.js';
import { noPings } from './ui.js';

/** A preview shown only to the admin who asked waits this long for them to confirm it (their reply goes away by itself soon after). */
const PENDING_TTL_MS = 10 * 60_000;
/** A preview sent to a DM or posted in a channel waits longer: the person who confirms it may not be at their screen. Every cell is checked again when Write is pressed. */
const SHARED_TTL_MS = 60 * 60_000;
/** What the bot needs in a channel to post the preview there. */
const POST_PERMS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] as const;
/** How many lines of each kind a message shows. */
const SHOWN_DIFFERENT = 8;
const SHOWN_FILLS = 8;
/** What a report may take of Discord's 2000 characters (a closing note is added after it), and what a preview may. */
const REPORT_BUDGET = 1650;
const PREVIEW_BUDGET = 1850;

interface Pending {
  /** The admin who asked. */
  userId: string;
  guildId: string;
  panelId: number;
  fills: ProfitFillPlan[];
  /** Set when the preview is of Safety Deductions to add beside pay already in the sheet (`fills` is then empty). */
  deductions?: DeductionFill[];
  /** Where the preview was shown: only to that admin in the reply, in their DMs, or in a channel. */
  where: ProfitSendTo;
  expiresAt: number;
}
const pending = new Map<string, Pending>();

/** Remember what an admin was shown, so pressing the button writes exactly that; returns the button's token. */
export function rememberFills(p: Omit<Pending, 'expiresAt' | 'where'> & { where?: ProfitSendTo }, now: number, ttlMs = PENDING_TTL_MS): string {
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  const token = randomBytes(6).toString('hex');
  pending.set(token, { ...p, where: p.where ?? 'here', expiresAt: now + ttlMs });
  return token;
}

const PROBLEM_TEXT: Record<PayProblem, string> = {
  'no-flight-id': "the logbook names no FsHub flight, so the distance can't be checked",
  'no-distance': "FsHub gave no distance, so it isn't worked out",
  'distance-differs': "FsHub and Aeroconomy don't agree on the distance, so it isn't worked out",
};

/** Why a flight was left alone (safety pay is on), said briefly. */
const HELD_TEXT: Record<HeldFlight['reason'], (h: HeldFlight) => string> = {
  'no-landing-rate': () => 'FsHub has no landing rate for it',
  'landing-rate-not-believed': (h) => `FsHub's landing rate for it (-${h.fpm ?? '?'} fpm) is too hard to believe as a touchdown`,
};

/** How a pay that was cut for a hard landing came about, in words. */
function safetyHow(p: PayPlan): string {
  const s = p.safety as NonNullable<PayPlan['safety']>;
  const cut =
    p.distanceNm !== null
      ? `the usual loss pay for ${Math.round(p.distanceNm).toLocaleString('en-US')} nm${s.minimumLoss > 0 ? `, less ${s.minimumLoss}%` : ', with no cut'}`
      : s.byMinimum
        ? `the $2,000 minimum${s.minimumLoss > 0 ? `, less ${s.minimumLoss}%` : ' kept'}`
        : `${s.share}% of the profit`;
  return `Tier ${s.tier} safety: landed at -${s.fpm} fpm, ${cut}; ${formatMoney(s.normal)} without the cut`;
}

/** The pilot's pay for a row, in words and how it was worked out, or why there is none. Empty when its cell isn't going to be filled anyway. */
function payText(p: PayPlan): string {
  if (p.cell === 'zeroed') return ' · pilot pay: left at $0 (it was set back to $0 after I wrote one)';
  if (p.cell !== 'empty') return '';
  if (p.problem !== null) return ` · pilot pay: ${PROBLEM_TEXT[p.problem]}`;
  if (p.amount === null) return p.basis === 'safety' && p.safety ? ` · pilot pay: nothing to write (${safetyHow(p)})` : ' · pilot pay: not worked out';
  const how =
    p.basis === 'safety'
      ? safetyHow(p)
      : p.basis === 'share'
        ? '15% of the profit'
        : p.basis === 'minimum'
          ? 'the $2,000 minimum'
          : `loss, ${Math.round(p.distanceNm ?? 0).toLocaleString('en-US')} nm flown`;
  return ` · pilot pay ${formatMoney(p.amount)} (${how})`;
}

/** What would go in the row's Safety Deductions cell, or why nothing would (the airline asked for deductions and this flight's pay is cut). */
function deductionText(f: ProfitFillPlan): string {
  if (f.deduction) return ` · deduction ${formatMoney(f.deduction)}`;
  return f.deductionCell === 'filled' ? ' · deduction: the Safety Deductions cell already has something (left alone)' : '';
}

/** How the pay of the blank rows stands: to be filled, already filled in or set back to $0 on purpose (left alone), or not worked out. */
function paySummary(fills: ProfitFillPlan[]): { fill: number; kept: number; zeroed: number; none: number; noColumn: number } {
  return {
    fill: fills.filter((f) => f.payPlan.cell === 'empty' && f.payPlan.amount !== null).length,
    kept: fills.filter((f) => f.payPlan.cell === 'filled').length,
    zeroed: fills.filter((f) => f.payPlan.cell === 'zeroed').length,
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

/** The counts of what the deductions would do (the airline asked for them to be written): to be written, already something in the cell, or no such column. */
function deductionSummary(fills: ProfitFillPlan[]): { write: number; filled: number; missing: number } {
  return {
    write: fills.filter((f) => f.deduction).length,
    filled: fills.filter((f) => f.deductionCell === 'filled').length,
    missing: fills.filter((f) => f.deductionCell === 'missing').length,
  };
}

/** One line on the Safety Deductions column, only where the airline asked for deductions and some flight's pay is cut. */
function deductionBullet(fills: ProfitFillPlan[]): string[] {
  const s = deductionSummary(fills);
  if (s.write + s.filled + s.missing === 0) return [];
  if (s.missing > 0 && s.write + s.filled === 0) return ['• 🧾 The sheet has no **Safety Deductions** column, so what the hard landings take off would not be written'];
  const parts = [
    ...(s.write > 0 ? [`**${s.write}** would be written (what the pay would have been, less what it is)`] : []),
    ...(s.filled > 0 ? [`**${s.filled}** already have something in them (left exactly as they are)`] : []),
  ];
  return [`• 🧾 Safety Deductions beside those: ${parts.join(', ')}`];
}

/** Lines on landing safety, when it touches the rows: pay cut, flights left alone for want of a trustworthy reading, and flights held for a later run. */
function safetyBullets(fills: ProfitFillPlan[], waiting: number, held: HeldFlight[]): string[] {
  const cut = fills.filter((f) => f.payPlan.cell === 'empty' && f.payPlan.safety).length;
  return [
    ...(cut > 0 ? [`• ⚖️ **${cut}** have their pilot pay cut for a hard landing (safety pay)`] : []),
    ...deductionBullet(fills),
    ...(held.length > 0 ? [`• ⏸️ **${held.length}** are left alone, profit and pay both, because safety pay is on and FsHub's landing rate for ${held.length === 1 ? 'it' : 'them'} can't be trusted: your managers are told, and can fill ${held.length === 1 ? 'it' : 'them'} in by hand`] : []),
    ...(waiting > 0 ? [`• ⏳ **${waiting}** would be filled, but FsHub's landing rate for ${waiting === 1 ? 'it' : 'them'} couldn't be read yet, so ${waiting === 1 ? 'it waits' : 'they wait'} for the next run (safety pay is on)`] : []),
  ];
}

/** One line on the pilots' pay beside the blank profits. */
function payBullet(fills: ProfitFillPlan[]): string {
  const s = paySummary(fills);
  if (s.noColumn === fills.length) return '• 💵 The sheet has no Pilot Pay column, so only Profit Made would be filled';
  const parts = [
    ...(s.fill > 0 ? [`**${s.fill}** empty or $0, with a pay I can work out`] : []),
    ...(s.none > 0 ? [`**${s.none}** empty or $0, with a pay I can't work out yet`] : []),
    ...(s.kept > 0 ? [`**${s.kept}** already have a pay in them (left exactly as they are)`] : []),
    ...(s.zeroed > 0 ? [`**${s.zeroed}** set back to $0 after I wrote one (left alone)`] : []),
  ];
  return `• 💵 Pilot Pay beside those: ${parts.join(', ')}`;
}

/** What was found, in words. Reading only: nothing in it has been changed. */
export function profitReport(airline: string, a: ProfitAnalysis): string {
  const lines = [
    `💰 **Profit check: ${plainText(airline)}**`,
    `I read ${a.aircraft} aircraft logbook${a.aircraft === 1 ? '' : 's'} from Aeroconomy${a.leased > 0 ? ` (${a.aircraft - a.leased} owned, ${a.leased} leased)` : ''} (${a.logbookFlights} flights, ${a.usableFlights} flown under the airline's own callsign) and compared them with the ${a.sheetCompleted} flights ticked as completed in the sheet.`,
    ...(a.leasedProblem ? [`• ⚠️ I couldn't list the airline's leased aircraft (${a.leasedProblem.replace(/\.$/, '')}), so only the aircraft it owns are in this.`] : []),
    ...(a.leasedHidden > 0 ? [`• ⚠️ Aeroconomy wouldn't show **${a.leasedHidden}** leased aircraft logbook${a.leasedHidden === 1 ? '' : 's'} to this account, so ${a.leasedHidden === 1 ? 'its' : 'their'} flights are left out.`] : []),
    `• ✅ **${a.agree}** have a Profit Made that agrees with Aeroconomy (within a dollar)`,
    `• ✏️ **${a.different.length}** have a Profit Made that is not what Aeroconomy says`,
    `• ⬜ **${a.fills.length}** have a blank Profit Made that Aeroconomy can fill in`,
    ...(a.fills.length > 0 ? [payBullet(a.fills)] : []),
    ...safetyBullets(a.fills, a.waiting ?? 0, a.held ?? []),
    ...(a.unreadable > 0 ? [`• 🔒 **${a.unreadable}** have something in Profit Made that is not an amount (like TBD): left exactly as it is`] : []),
    `• ❔ **${a.unmatched}** I found no logbook flight for${a.unmatched > 0 ? " (Aeroconomy only lets me read the newest 100 entries of each aircraft's logbook, so older flights are out of reach)" : ''}, and **${a.ambiguous}** could be more than one flight (left alone)`,
  ];
  if (a.different.length > 0) {
    lines.push('', '**Different** (the sheet is not changed; a manager should look):');
    const shown = a.different.slice(0, SHOWN_DIFFERENT).map((d) => `• ${row(d.row, `${flight(d.callsign, d.route, d.day)} · sheet ${formatMoney(d.sheet)} · Aeroconomy ${formatMoney(d.aeroconomy)}`)}`);
    addWithin(lines, shown, Math.round(REPORT_BUDGET * 0.6), a.different.length);
  }
  if (a.fills.length > 0) {
    lines.push('', '**Blank, could be filled in:**');
    const shown = a.fills.slice(0, SHOWN_FILLS).map((f) => `• ${row(f.row, `${flight(f.callsign, f.route, f.day)} · ${formatMoney(f.value)}${payText(f.payPlan)}${deductionText(f)}`)}`);
    addWithin(lines, shown, REPORT_BUDGET, a.fills.length);
  }
  if (a.held && a.held.length > 0) {
    lines.push('', '**Left alone (safety pay):**');
    const shown = a.held.slice(0, SHOWN_FILLS).map((h) => `• ${row(h.row, `${flight(h.callsign, h.route, h.day)} · ${HELD_TEXT[h.reason](h)}`)}`);
    addWithin(lines, shown, 1900, a.held.length);
  }
  return lines.join('\n');
}

/**
 * What pressing the button would write, for the admin to read first. A `note` (who asked, who may press, or why it is not where it was
 * meant to be) goes after the closing words, and is counted in the budget so the message always fits.
 */
export function previewText(airline: string, fills: ProfitFillPlan[], note = ''): string {
  const closing = `Each one is checked again against the sheet as it is when you press the button, and skipped if its row has moved, its pilot or box has changed, or the cell is no longer empty. Nothing is written unless you press **Write**.${note ? `\n${note}` : ''}`;
  const lines = [
    `✍️ **Fill blank Profit Made cells: ${plainText(airline)}**`,
    `I would write the profit Aeroconomy gives, rounded up to a whole dollar (Aeroconomy has no cents), into **${fills.length}** Profit Made cell${fills.length === 1 ? '' : 's'} that ${fills.length === 1 ? 'is' : 'are'} empty today${payIntro(fills)}`,
    '',
  ];
  const shown = fills.slice(0, SHOWN_FILLS).map((f) => `• ${row(f.row, `${flight(f.callsign, f.route, f.day)} · ${formatMoney(f.value)} (Aeroconomy: ${formatMoney(f.exact)})${payText(f.payPlan)}${deductionText(f)}`)}`);
  addWithin(lines, shown, PREVIEW_BUDGET - closing.length - 2, fills.length);
  lines.push('', closing);
  return lines.join('\n');
}

/** The rest of the preview's opening sentence: what would go in the Pilot Pay cells, and what would not. */
function payIntro(fills: ProfitFillPlan[]): string {
  const s = paySummary(fills);
  const left = [
    ...(s.kept > 0 ? [`**${s.kept}** already have a pay in Pilot Pay`] : []),
    ...(s.zeroed > 0 ? [`**${s.zeroed}** were set back to $0 after I wrote a pay`] : []),
    ...(s.none > 0 ? [`**${s.none}** have a pay I can't work out`] : []),
  ];
  const tail = left.length > 0 ? ` (${left.join('; ')}: left as they are)` : '';
  const d = deductionSummary(fills);
  const deductions =
    d.write > 0
      ? ` I would also write what the hard landing takes off the pay (what it would have paid, less what it pays) into **${d.write}** empty Safety Deductions cell${d.write === 1 ? '' : 's'}.`
      : d.missing > 0 && d.filled === 0
        ? ' The sheet has no Safety Deductions column, so no deductions would be written.'
        : '';
  const nothingElse = `${deductions} I would change nothing else, and no other cell that has anything in it.`;
  if (s.noColumn === fills.length) return `. The sheet has no Pilot Pay column.${nothingElse}`;
  if (s.fill === 0) return `${tail}.${nothingElse}`;
  const rule = "15% of the profit, rounded up to a whole dollar (at least $2,000), or for a flight that lost money $2,000 plus $1,000 per 500 nm beyond the first 1,000, by FsHub's distance";
  return `, and the pilot's pay into **${s.fill}** Pilot Pay cell${s.fill === 1 ? '' : 's'} that ${s.fill === 1 ? 'is' : 'are'} empty or $0: ${rule}${tail}.${nothingElse}`;
}

/* ------------------------------------------------------------------ deductions for flights already filled in */

/** The lines that say what a look for missing deductions found, besides the ones it could write. Only the kinds that have any are said. */
function deductionCounts(a: DeductionAnalysis): string[] {
  const n = (count: number, one: string, many: string = one) => `**${count}** ${count === 1 ? one : many}`;
  return [
    `• ✍️ ${n(a.fills.length, 'can have its deduction written: the Pilot Pay in the sheet is exactly what the cut gives', 'can have their deduction written: the Pilot Pay in the sheet is exactly what the cut gives')}`,
    ...(a.paidInFull > 0 ? [`• 💵 ${n(a.paidInFull, 'landed hard but was paid in full in the sheet, so nothing was taken off and nothing is recorded', 'landed hard but were paid in full in the sheet, so nothing was taken off and nothing is recorded')}`] : []),
    ...(a.differs > 0 ? [`• ✋ ${n(a.differs, 'has a Pilot Pay that is not what the cut gives (somebody changed it, or the percentages changed since): left alone', 'have a Pilot Pay that is not what the cut gives (somebody changed it, or the percentages changed since): left alone')}`] : []),
    ...(a.unpaid > 0 ? [`• 💤 ${n(a.unpaid, 'has no Pilot Pay yet, so there is nothing to record a deduction against', 'have no Pilot Pay yet, so there is nothing to record a deduction against')}`] : []),
    ...(a.already > 0 ? [`• 🔒 ${n(a.already, 'already has something in Safety Deductions (left exactly as it is)', 'already have something in Safety Deductions (left exactly as they are)')}`] : []),
    ...(a.uncut > 0 ? [`• ➖ ${n(a.uncut, 'was not cut: it landed before safety pay was turned on, more gently than Tier 2, or the cut took nothing off', 'were not cut: they landed before safety pay was turned on, more gently than Tier 2, or the cut took nothing off')}`] : []),
    ...(a.noRate > 0 ? [`• ❔ ${n(a.noRate, "has no landing rate (or distance) from FsHub that I can use, so I can't tell", "have no landing rate (or distance) from FsHub that I can use, so I can't tell")}`] : []),
    ...(a.waiting > 0 ? [`• ⏳ ${n(a.waiting, "I haven't been able to ask FsHub about yet (I ask about at most 50 a run): run this again", "I haven't been able to ask FsHub about yet (I ask about at most 50 a run): run this again")}`] : []),
  ];
}

/** What a look for missing deductions found, in words. Reading only. */
export function deductionReport(airline: string, a: DeductionAnalysis): string {
  const lines = [
    `🧾 **Missing Safety Deductions: ${plainText(airline)}**`,
    `I read ${a.aircraft} aircraft logbook${a.aircraft === 1 ? '' : 's'} from Aeroconomy and the sheet, and matched **${a.matched}** completed flights to the logbooks.`,
    ...(a.leasedProblem ? [`• ⚠️ I couldn't list the airline's leased aircraft (${a.leasedProblem.replace(/\.$/, '')}), so only the aircraft it owns are in this.`] : []),
    ...(a.leasedHidden > 0 ? [`• ⚠️ Aeroconomy wouldn't show **${a.leasedHidden}** leased aircraft logbook${a.leasedHidden === 1 ? '' : 's'} to this account, so ${a.leasedHidden === 1 ? 'its' : 'their'} flights are left out.`] : []),
    ...deductionCounts(a),
  ];
  return lines.join('\n');
}

/** One flight to be given its deduction, as a line. */
function deductionLine(f: DeductionFill): string {
  return `• ${row(f.row, `${flight(f.callsign, f.route, f.day)} · Tier ${f.tier} (-${f.fpm} fpm) · paid ${formatMoney(f.pay)}, ${formatMoney(f.normal)} without the cut · deduction ${formatMoney(f.deduction)}`)}`;
}

/**
 * What pressing the button would write, for the admin to read first. A `note` (who asked, who may press, or why it is not where it was meant to be) goes after
 * the closing words, and is counted in the budget so the message always fits.
 */
export function deductionPreviewText(airline: string, a: DeductionAnalysis, note = ''): string {
  const closing = `Each one is checked again against the sheet as it is when you press the button, and skipped if its row has moved, its pilot or box has changed, its Pilot Pay is not what it is now, or the cell is no longer empty. Nothing is written unless you press **Write**.${note ? `\n${note}` : ''}`;
  const lines = [
    `✍️ **Add missing Safety Deductions: ${plainText(airline)}**`,
    `I would write what each hard landing took off (what the flight would have paid, less what it was paid) into **${a.fills.length}** empty Safety Deductions cell${a.fills.length === 1 ? '' : 's'}, beside Pilot Pay that already matches the cut. I would change nothing else.`,
    ...deductionCounts(a).slice(1),
    '',
  ];
  addWithin(lines, a.fills.slice(0, SHOWN_FILLS).map(deductionLine), PREVIEW_BUDGET - closing.length - 2, a.fills.length);
  lines.push('', closing);
  return lines.join('\n');
}

export function profitButtons(token: string, count: number): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`profit:go:${token}`).setLabel(`Write ${count} cell${count === 1 ? '' : 's'}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`profit:no:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/* ------------------------------------------------------------------ where the preview goes, and who may confirm it */

/** What the settings are, in words, for the admin to read (after changing them, or when asked). */
export function profitSettingsText(panel: Panel): string {
  const where =
    panel.profitSendTo === 'dm'
      ? 'in **your DMs** (the DMs of the admin who asks)'
      : panel.profitSendTo === 'channel' && panel.profitChannelId
        ? `posted in <#${panel.profitChannelId}>, for whoever may confirm it to see`
        : 'only to **the admin who asks**, in the reply to the command (the default)';
  const who = panel.profitRoleId ? `the admin who asked, and any member of <@&${panel.profitRoleId}>` : 'only the admin who asked (the default)';
  return [
    `✍️ **${plainText(panel.airlineName)}**: the preview that \`/setup profit action:fill\` makes, of the cells it would write, is shown ${where}.`,
    `• Who can press **Write** (or **Cancel**) on it: ${who}.`,
    '• Change it with `/setup profit send-to:` (here, a DM or a channel, and `channel:` for the channel) and `/setup profit who-can-write:` (admins only, or a role, and `role:` for the role). Nothing is written to the sheet by changing them.',
  ].join('\n');
}

/**
 * Save the delivery and confirming-role options of `/setup profit`, when any is given. Returns the panel as it is now and whether
 * anything was given. A mix that makes no sense is refused with nothing saved.
 */
export async function applyProfitSettings(ctx: BotContext, interaction: ChatInputCommandInteraction, panel: Panel): Promise<{ panel: Panel; given: boolean }> {
  const sendTo = interaction.options.getString('send-to');
  const picked = interaction.options.getChannel('channel');
  const who = interaction.options.getString('who-can-write');
  const role = interaction.options.getRole('role');
  const given = sendTo !== null || picked !== null || who !== null || role !== null;
  if (!given) return { panel, given };

  if (sendTo !== null && sendTo !== 'here' && sendTo !== 'dm' && sendTo !== 'channel') throw new UserError('Choose where the preview goes: here, your DMs, or a channel.');
  if (who !== null && who !== 'admins' && who !== 'role') throw new UserError('Choose who can press Write: admins only, or a role.');
  if (picked && (sendTo === 'here' || sendTo === 'dm')) throw new UserError('A channel only goes with the "A channel" choice. Leave `send-to` empty or choose that one.');
  if (role && who === 'admins') throw new UserError('A role only goes with the "A role" choice. Leave `who-can-write` empty or choose that one.');
  if (role && role.id === panel.guildId) throw new UserError('Pick a specific role. @everyone would let any member write to the sheet.');

  const nextSendTo: ProfitSendTo | null = sendTo ?? (picked ? 'channel' : null);
  const patch: Partial<Pick<Panel, 'profitSendTo' | 'profitChannelId' | 'profitRoleId'>> = {};
  if (nextSendTo !== null) patch.profitSendTo = nextSendTo;
  if (nextSendTo === 'channel') {
    const channelId = picked?.id ?? panel.profitChannelId;
    if (!channelId) throw new UserError('Choose the channel with the `channel` option.');
    const guild = interaction.guild;
    if (!guild) throw new UserError('This only works inside a server.');
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new UserError("I can't see that channel.");
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const perms = channel.permissionsFor(me);
    const missing = POST_PERMS.filter((p) => !perms?.has(p));
    if (missing.length > 0) throw new UserError(`I'm missing permissions in <#${channel.id}>: ${new PermissionsBitField(missing).toArray().join(', ')}. Grant those and run this again.`);
    patch.profitChannelId = channel.id;
  }
  if (who === 'admins') patch.profitRoleId = null;
  else if (role) patch.profitRoleId = role.id;
  else if (who === 'role' && !panel.profitRoleId) throw new UserError('Choose which role with the `role` option.');

  ctx.store.updatePanel(panel.id, patch);
  return { panel: ctx.store.getPanel(panel.id) as Panel, given };
}

/** Why a post or DM did not work, in a few words. */
function whyNot(e: unknown, where: 'dm' | 'channel'): string {
  if (where === 'dm' && isDmClosed(e)) return 'your DMs from this server are closed';
  if (where === 'channel' && isMissingAccess(e)) return "I'm missing access or permissions there";
  return 'something went wrong, it is in my log';
}

/**
 * Show the admin the cells `/setup profit action:fill` would write, where the panel is set to show them: only to them in the reply (the
 * default), in their DMs, or in a channel for whoever may confirm it. If the DM or the channel does not work, it is shown in the reply
 * with a line saying why, so a preview is never lost.
 */
export async function showPreview(ctx: BotContext, interaction: ChatInputCommandInteraction, panel: Panel, fills: ProfitFillPlan[]): Promise<void> {
  const now = ctx.now();
  const count = fills.length + fills.filter((f) => f.pay !== null && f.pay !== undefined).length + fills.filter((f) => f.deduction).length;
  const asker = interaction.user.id;
  await deliverPreview(ctx, interaction, panel, (where, note) => {
    const token = rememberFills({ userId: asker, guildId: panel.guildId, panelId: panel.id, fills, where }, now, where === 'here' ? PENDING_TTL_MS : SHARED_TTL_MS);
    return { token, message: { content: previewText(panel.airlineName, fills, note), components: profitButtons(token, count), allowedMentions: noPings } };
  });
}

/** The same for the Safety Deductions to add beside pay that is already in the sheet (`/setup profit action:deductions`). */
export async function showDeductionPreview(ctx: BotContext, interaction: ChatInputCommandInteraction, panel: Panel, found: DeductionAnalysis): Promise<void> {
  const now = ctx.now();
  const asker = interaction.user.id;
  await deliverPreview(ctx, interaction, panel, (where, note) => {
    const token = rememberFills({ userId: asker, guildId: panel.guildId, panelId: panel.id, fills: [], deductions: found.fills, where }, now, where === 'here' ? PENDING_TTL_MS : SHARED_TTL_MS);
    return { token, message: { content: deductionPreviewText(panel.airlineName, found, note), components: profitButtons(token, found.fills.length), allowedMentions: noPings } };
  });
}

/** Show a preview where the panel is set to show it (the reply, the admin's DMs or a channel), falling back to the reply with a line saying why. */
async function deliverPreview(
  ctx: BotContext,
  interaction: ChatInputCommandInteraction,
  panel: Panel,
  make: (where: ProfitSendTo, note: string) => { token: string; message: { content: string; components: ActionRowBuilder<MessageActionRowComponentBuilder>[]; allowedMentions: typeof noPings } },
): Promise<void> {
  const asker = interaction.user.id;
  let instead = '';
  if (panel.profitSendTo === 'channel' && panel.profitChannelId) {
    const channelId = panel.profitChannelId;
    const who = panel.profitRoleId ? `The admin who asked (<@${asker}>), or anyone with <@&${panel.profitRoleId}>, can press **Write**.` : `Only the admin who asked (<@${asker}>) can press **Write**.`;
    const { token, message } = make('channel', who);
    try {
      const channel = await interaction.guild?.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isSendable()) throw new UserError("I can't post in that channel any more");
      const sent = await channel.send(message);
      await interaction.editReply({
        content: `📣 I posted the preview in <#${channelId}> (https://discord.com/channels/${panel.guildId}/${channelId}/${sent.id}). Nothing is written until someone who may presses **Write** there${panel.profitRoleId ? `: you, or a member of <@&${panel.profitRoleId}>` : ''}.`,
        allowedMentions: noPings,
      });
      return;
    } catch (e) {
      pending.delete(token);
      if (!(e instanceof UserError)) ctx.log.warn(`Could not post the profit preview in ${channelId}`, e);
      instead = `⚠️ I couldn't post it in <#${channelId}> (${e instanceof UserError ? e.message : whyNot(e, 'channel')}), so it is here instead, for you alone.`;
    }
  } else if (panel.profitSendTo === 'dm') {
    const { token, message } = make('dm', '');
    try {
      await interaction.user.send(message);
      await interaction.editReply({ content: '📬 I sent the preview to your DMs. Nothing is written until you press **Write** there.', allowedMentions: noPings });
      return;
    } catch (e) {
      pending.delete(token);
      if (!isDmClosed(e)) ctx.log.warn('Could not DM the profit preview', e);
      instead = `⚠️ I couldn't send it to your DMs (${whyNot(e, 'dm')}), so it is here instead.`;
    }
  }
  const { message } = make('here', instead);
  await interaction.editReply(message);
}

const REASON_TEXT: Record<string, string> = {
  gone: 'the row is no longer in the sheet',
  moved: 'the row has moved',
  changed: 'the pilot named on the row changed',
  'not-completed': 'the row is no longer ticked as completed',
  filled: 'the cell has something in it now',
  'pay-changed': 'the Pilot Pay is not what it was',
};

/**
 * May this person press the buttons of a preview? The admin who asked, as long as they are still one, and members of the panel's
 * confirming role (when it has one). In a DM nobody but the admin it was sent to is there, so that is looked up in the server instead.
 */
export async function mayConfirm(interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction, wanted: { userId: string; guildId: string }, roleId: string | null): Promise<boolean> {
  if (interaction.guildId === null) {
    if (interaction.user.id !== wanted.userId) return false;
    try {
      const guild = await interaction.client.guilds.fetch(wanted.guildId);
      const member = await guild.members.fetch({ user: wanted.userId, force: true }); // who may write to the airline's sheet is asked of Discord, not read from an old copy
      return member.permissions.has(PermissionFlagsBits.ManageGuild) || (roleId !== null && member.roles.cache.has(roleId));
    } catch {
      return false; // no longer in the server, or the bot no longer is
    }
  }
  if (interaction.guildId !== wanted.guildId) return false;
  if (interaction.user.id === wanted.userId && isAdmin(interaction)) return true;
  return roleId !== null && memberHasAnyRole(interaction, [roleId]);
}

/** The buttons of the preview: `profit:go:<token>` writes it, `profit:no:<token>` drops it. Only the admin who asked, or a member of the confirming role, can press them. */
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
    // The role is read now and not when the preview was made, so changing it takes effect on previews that are already up.
    const roleId = ctx.store.getPanel(wanted.panelId)?.profitRoleId ?? null;
    if (!(await mayConfirm(interaction, wanted, roleId))) {
      await interaction.reply({ content: `Only the admin who asked for this${roleId ? `, or a member of <@&${roleId}>,` : ''} can confirm it.`, flags: MessageFlags.Ephemeral, allowedMentions: noPings });
      return;
    }
    // Nothing is awaited between that check and taking the preview off the list, so when two people press at once only one of them gets it.
    if (!pending.delete(token as string)) {
      await interaction.reply({ content: 'Someone else pressed this a moment ago, so nothing more was written.', flags: MessageFlags.Ephemeral, allowedMentions: noPings });
      return;
    }
    // In a channel it matters who did it, since it may not be the admin who asked. Anywhere else it can only be them.
    const by = wanted.where === 'channel' ? ` Pressed by <@${interaction.user.id}>.` : '';
    if (way === 'no') {
      await interaction.update({ content: `Cancelled. Nothing was written to the sheet.${by}`, components: [], allowedMentions: noPings });
      return;
    }

    await interaction.deferUpdate();
    const panel = ctx.store.getPanel(wanted.panelId);
    if (!panel || !ctx.writeback || !ctx.writeback.enabledFor(panel)) {
      await interaction.editReply({ content: "I can't write to that sheet any more (the panel is gone, or writing to it was switched off), so nothing was written.", components: [], allowedMentions: noPings });
      return;
    }
    try {
      if (wanted.deductions) {
        const done = await ctx.writeback.fillDeductions(
          panel,
          wanted.deductions.map((d) => ({ sourceKey: d.sourceKey, value: d.deduction, row: d.row, pilot: d.pilot, pay: d.pay })),
        );
        const left = new Map<string, number>();
        for (const x of done.skipped) left.set(x.reason, (left.get(x.reason) ?? 0) + 1);
        const text = [
          `✅ Wrote **${done.written.length}** Safety Deductions cell${done.written.length === 1 ? '' : 's'} in the sheet at ${ts(now, 't')}${done.written.length > 0 ? `: ${done.written.slice(0, 12).map((w) => w.cell).join(', ')}${done.written.length > 12 ? '…' : ''}` : '.'}`,
          ...(done.skipped.length > 0 ? [`Left alone, because they changed since the preview: ${[...left].map(([r, n]) => `${n} (${REASON_TEXT[r] ?? r})`).join('; ')}.`] : []),
          ...(by ? [by.trim()] : []),
        ];
        await interaction.editReply({ content: text.join('\n'), components: [], allowedMentions: noPings });
        return;
      }
      const result = await ctx.writeback.fillProfits(panel, wanted.fills);
      // Remember which pay cells were written by this bot: one that is later set back to $0 is then known to be somebody's own choice.
      if (result.paid.length > 0) ctx.store.recordPayWrites(panel.id, result.paid.map((p) => ({ sourceKey: p.sourceKey, cents: Math.round(p.value * 100) })), now);
      const skipped = new Map<string, number>();
      for (const s of result.skipped) skipped.set(s.reason, (skipped.get(s.reason) ?? 0) + 1);
      const lines = [
        `✅ Wrote **${result.written.length}** Profit Made cell${result.written.length === 1 ? '' : 's'} in the sheet at ${ts(now, 't')}${result.written.length > 0 ? `: ${result.written.slice(0, 12).map((w) => w.cell).join(', ')}${result.written.length > 12 ? '…' : ''}` : '.'}`,
        ...(result.paid.length > 0 ? [`💵 And **${result.paid.length}** Pilot Pay cell${result.paid.length === 1 ? '' : 's'}: ${result.paid.slice(0, 12).map((w) => w.cell).join(', ')}${result.paid.length > 12 ? '…' : ''}`] : []),
        ...(result.deducted.length > 0 ? [`🧾 And **${result.deducted.length}** Safety Deductions cell${result.deducted.length === 1 ? '' : 's'}: ${result.deducted.slice(0, 12).map((w) => w.cell).join(', ')}${result.deducted.length > 12 ? '…' : ''}`] : []),
        ...(result.deductionLeft > 0 ? [`Left alone: **${result.deductionLeft}** Safety Deductions cell${result.deductionLeft === 1 ? '' : 's'} could not be written (${result.deductionLeft === 1 ? 'it has' : 'they have'} something in ${result.deductionLeft === 1 ? 'it' : 'them'}, the Pilot Pay beside ${result.deductionLeft === 1 ? 'it has' : 'them has'} a pay, or the column is gone).`] : []),
        ...(result.payLeft > 0 ? [`Left alone: **${result.payLeft}** Pilot Pay cell${result.payLeft === 1 ? '' : 's'} had something in ${result.payLeft === 1 ? 'it' : 'them'} by then.`] : []),
        ...(result.skipped.length > 0 ? [`Left alone, because they changed since the preview: ${[...skipped].map(([r, n]) => `${n} (${REASON_TEXT[r] ?? r})`).join('; ')}.`] : []),
        ...(by ? [by.trim()] : []),
      ];
      await interaction.editReply({ content: lines.join('\n'), components: [], allowedMentions: noPings });
    } catch (e) {
      if (!(e instanceof WriteBackError)) throw e;
      await interaction.editReply({ content: `I couldn't write to the sheet, so nothing was written: ${e.message}${by}`, components: [], allowedMentions: noPings });
    }
  },
};
