import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageActionRowComponentBuilder } from 'discord.js';
import type { Panel } from '../db/store.js';
import { PAY_MINIMUM } from '../services/pilotPay.js';
import { HARD_LANDINGS_CSV, managerRoles } from '../services/safetyReport.js';
import { IMPLAUSIBLE_FPM, type SafetyLimits } from '../services/safetyPay.js';
import { dollarsText } from '../services/payroll.js';
import { plainText } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { UserError } from './errors.js';
import { isAdmin } from './guard.js';
import { noPings } from './ui.js';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;

/** What `/setup safety-pay` and its buttons answer with. */
export interface SafetyReply {
  content: string;
  components: Row[];
}

/**
 * What an admin gave for the percentage of the minimum pay a pilot loses: one percentage for both tiers (`both`), or one for each (`tier1`, `tier2`), and the
 * share of a flight's profit a pilot is paid after each tier (`share1`, `share2`). Each is a whole number from 0 to 100, or null when it wasn't given.
 */
export interface LossArgs {
  both: number | null;
  tier1: number | null;
  tier2: number | null;
  share1?: number | null;
  share2?: number | null;
  /** `on` or `off`: whether what a hard landing takes off a pilot's pay is also written in the sheet's Safety Deductions column. Null or missing: unchanged. */
  deductions?: string | null;
}

const money = (dollars: number): string => dollarsText(dollars * 100);

/** The percentages offered as buttons (any whole number from 0 to 100 can be given with `minimum-loss`, `tier1-loss` and `tier2-loss`). */
export const LOSS_CHOICES: readonly number[] = [0, 25, 50, 100];

/** Why safety pay cannot be turned on for this panel yet, or null: it needs FsHub's landing rate for each flight. */
function cannotTurnOn(ctx: BotContext, panel: Panel): string | null {
  if (ctx.fshub === null) return "I have no FsHub token, and safety pay needs FsHub's landing rate for each flight, so it can't be turned on.";
  if (panel.fshubAirlineId === null) return `Safety pay needs FsHub's landing rates, so link **${plainText(panel.airlineName)}** to its airline's FsHub roster first: \`/setup fshub link:<your airline>\`.`;
  if (!panel.fshubConfirm) return `Reading FsHub's flights is switched off for **${plainText(panel.airlineName)}**, and safety pay needs them (they carry the landing rates). Switch it on with \`/setup fshub confirm:on\`.`;
  return null;
}

const buttonLabel = (pct: number): string => (pct === 0 ? 'Lose nothing (0%)' : pct === 100 ? 'Lose all (100%)' : `Lose ${pct}%`);
const cancelButton = (panelId: number): ButtonBuilder => new ButtonBuilder().setCustomId(`safety:cancel:${panelId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
const styleOf = (pct: number): ButtonStyle => (pct === 0 ? ButtonStyle.Primary : pct === 100 ? ButtonStyle.Danger : ButtonStyle.Secondary);

/** The first question's buttons: a percentage for both tiers, or "different for each tier", and a way out. */
const firstRows = (panelId: number): Row[] => [
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...LOSS_CHOICES.map((pct) => new ButtonBuilder().setCustomId(`safety:${pct}:${panelId}`).setLabel(buttonLabel(pct)).setStyle(styleOf(pct))),
  ),
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`safety:split:${panelId}`).setLabel('Different for each tier').setStyle(ButtonStyle.Primary),
    cancelButton(panelId),
  ),
];

/** The buttons of a question about one tier: each percentage, with the id the press carries. */
const tierRows = (panelId: number, idOf: (pct: number) => string): Row[] => [
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...LOSS_CHOICES.map((pct) => new ButtonBuilder().setCustomId(`safety:${idOf(pct)}:${panelId}`).setLabel(buttonLabel(pct)).setStyle(styleOf(pct))),
    cancelButton(panelId),
  ),
];

/** What the pay of a flight at the minimum comes to after a hard landing, for this percentage: `$2,000 less 25% is $1,500`. */
const afterLoss = (pct: number): number => Math.ceil((PAY_MINIMUM * (100 - pct)) / 100);

/** The first question, asked when safety pay is turned on: what percentage of the $2,000 minimum pay does a pilot lose, the same for both tiers or different? */
function question(panel: Panel): SafetyReply {
  return {
    content: [
      `**Turn on landing safety pay for ${plainText(panel.airlineName)}?** One question first.`,
      `When a pilot lands hard (Tier 1 or Tier 2) on a flight that pays the **${money(PAY_MINIMUM)} minimum** (a small profit, or a flight that lost money), what percentage of that pay should they lose? You can use the same percentage for both tiers, or a different one for each.`,
      `• **0%:** they keep the whole minimum, so on a small profit the fine costs nothing.`,
      `• **25%:** they lose a quarter of it, so the pay is no less than ${money(afterLoss(25))}. **50%:** no less than ${money(afterLoss(50))}.`,
      `• **100%:** there is no minimum: the pay is just the tier's share of the profit, and a flight that lost money pays nothing.`,
      'Press a percentage to use it for **both tiers**, or **Different for each tier** and I will ask about Tier 1, then Tier 2 (say 10% for one and 40% for the other). It applies to the distance pay of a flight that lost money too. For any other whole number, run `/setup safety-pay mode:on minimum-loss:15` (both tiers) or `/setup safety-pay mode:on tier1-loss:10 tier2-loss:40`. It only touches flights that land from now on, and you can change it later with the same options. The limits (how hard a landing has to be, aircraft by aircraft) and the shares of the profit are set separately: the limits in the **Landing safety** tab of the bot\'s settings page (the tray icon\'s **Open settings**), and the shares with `tier1-share` and `tier2-share` here.',
    ].join('\n'),
    components: firstRows(panel.id),
  };
}

/** The question about Tier 1 (when the tiers are set apart). */
function tier1Question(panel: Panel): SafetyReply {
  return {
    content: [
      `**Turn on landing safety pay for ${plainText(panel.airlineName)}: Tier 1** (a landing from -${panel.safetyTier1Fpm} fpm, by the airline's default limits).`,
      `What percentage of the **${money(PAY_MINIMUM)} minimum pay** should a pilot lose after a Tier 1 landing? 0% keeps all of it, 25% leaves ${money(afterLoss(25))}, 50% leaves ${money(afterLoss(50))}, and 100% means there is no minimum. It applies to the distance pay of a flight that lost money too.`,
      'Next I will ask about Tier 2. For any other whole number, run `/setup safety-pay mode:on tier1-loss:10 tier2-loss:40`.',
    ].join('\n'),
    components: tierRows(panel.id, (pct) => `a${pct}`),
  };
}

/** The question about Tier 2, once Tier 1 has been answered. */
function tier2Question(panel: Panel, tier1: number): SafetyReply {
  return {
    content: [
      `**Turn on landing safety pay for ${plainText(panel.airlineName)}: Tier 2** (a landing from -${panel.safetyTier2Fpm} fpm, by the airline's default limits). Tier 1 will lose **${tier1}%**.`,
      `What percentage of the **${money(PAY_MINIMUM)} minimum pay** should a pilot lose after a Tier 2 landing? 0% keeps all of it, 25% leaves ${money(afterLoss(25))}, 50% leaves ${money(afterLoss(50))}, and 100% means there is no minimum.`,
    ].join('\n'),
    components: tierRows(panel.id, (pct) => `b${pct}-${tier1}`),
  };
}

/** Who is told about a penalty, in words: the manager roles, or the server owner when none is set. */
function managersText(ctx: BotContext, panel: Panel): string {
  const roles = managerRoles(ctx.store, panel);
  return roles.length > 0 ? `members of ${roles.map((r) => `<@&${r}>`).join(', ')}` : 'the server owner (no manager role is set: `/setup refresh-roles` sets one)';
}

/** The most people named in the line saying who a report reaches. */
const REACH_NAMED = 10;

/**
 * Who a report reaches right now, as a line for the status: the people holding the manager roles when the bot can see them, and otherwise why it is the
 * server's owner alone (no role set, nobody has it, or the server's member list cannot be read, which needs "Server Members Intent" switched on).
 * An empty text where the bot has no way to look.
 */
export async function reachText(ctx: BotContext, panel: Panel): Promise<string> {
  if (!ctx.managerCheck) return '';
  let check;
  try {
    check = await ctx.managerCheck(panel);
  } catch (e) {
    ctx.log.warn('Could not work out who the safety reports reach', e);
    return '';
  }
  const roles = managerRoles(ctx.store, panel);
  const people = (ids: string[]): string => {
    const shown = ids.slice(0, REACH_NAMED).map((id) => `<@${id}>`).join(', ');
    return ids.length > REACH_NAMED ? `${shown} and ${ids.length - REACH_NAMED} more` : shown;
  };
  const owner = check.ids.length > 0 ? ` (${people(check.ids)})` : '';
  const roleList = roles.map((r) => `<@&${r}>`).join(', ');
  if (roles.length === 0) return `**Who is sent them:** only the server owner${owner}, since no manager role is set. \`/setup refresh-roles\` sets the role whose members should get them as well.`;
  if (!check.readable) {
    return `⚠️ **Who is sent them:** I can't read this server's member list, so I can't tell who holds ${roleList} and every report goes to the server owner${owner} alone. To fix it, open the bot in the Discord Developer Portal, go to **Bot**, switch on **Server Members Intent**, then look here again.`;
  }
  if (check.found === 0) return `⚠️ **Who is sent them:** nobody holds ${roleList} at the moment, so every report goes to the server owner${owner}.`;
  return `**Who is sent them:** the ${check.found === 1 ? '1 member' : `${check.found} members`} holding ${roleList} now: ${people(check.ids)}.`;
}

/** What a pilot loses of the minimum pay at one percentage, in words, for a bullet: nothing, all of it, or a share with the least the pay can then be. */
function lossSentence(loss: number, tierName: string | null): string {
  const after = tierName === null ? '' : ` after a ${tierName} landing`;
  if (loss <= 0) return `a pilot loses **nothing** of the ${money(PAY_MINIMUM)} minimum pay${after}, so a small profit is barely touched, and a flight that lost money is paid by its distance as usual`;
  if (loss >= 100) return `a pilot loses **all** of the ${money(PAY_MINIMUM)} minimum pay${after}. There is no minimum: the pay is exactly the tier's share, and a flight that lost money pays nothing`;
  return `a pilot loses **${loss}%** of the ${money(PAY_MINIMUM)} minimum pay${after}, so a hard landing never takes the pay below ${money(afterLoss(loss))}, and a flight that lost money is paid by its distance less ${loss}%`;
}

/** Where the limits are set: not in Discord, but on the bot's own settings page (the tray icon's "Open settings"), in the "Landing safety" tab. */
export const SETTINGS_PAGE = "The **Landing safety** tab of the bot's settings page (the tray icon's **Open settings**)";

/** The most aircraft types named in the status line about limits of their own. */
const NAMED_TYPES = 12;

/** The limits as a short line: `warning -400, Tier 1 -500, Tier 2 -600`. */
export const limitsText = (l: SafetyLimits): string => `warning -${l.warn}, Tier 1 -${l.tier1}, Tier 2 -${l.tier2}`;

/** How safety pay stands for a panel, and what it does, in words. `own` is the limits aircraft types have of their own. */
export function safetyStatus(panel: Panel, done = '', managers = 'your managers', reach = '', own: ReadonlyMap<string, SafetyLimits> = new Map()): string {
  const name = plainText(panel.airlineName);
  if (panel.safetyPaySince === null) {
    return [
      `${done}Landing safety pay is **off** for **${name}**: pilots are paid as they always were, and hard landings only get the light-hearted remark.`,
      '`/setup safety-pay mode:on` turns it on: a hard landing then cuts the pilot\'s pay (Tier 1: ' + `${panel.safetyShareTier1}% of the profit, Tier 2: ${panel.safetyShareTier2}%, from -${panel.safetyTier1Fpm} and -${panel.safetyTier2Fpm} fpm unless an aircraft has limits of its own), the pilot is sent a safety notice, and your managers are sent a report. I will ask what percentage of the ${money(PAY_MINIMUM)} minimum pay a pilot loses first (the same for both tiers, or a different one for each). ${SETTINGS_PAGE} sets the limits aircraft by aircraft.`,
    ].join('\n');
  }
  const t1 = panel.safetyLossTier1;
  const t2 = panel.safetyLossTier2;
  const minimum =
    t1 === t2
      ? `**The minimum, the same for both tiers:** ${lossSentence(t1, null)}.`
      : `**The minimum, set for each tier:** ${lossSentence(t1, 'Tier 1')}; ${lossSentence(t2, 'Tier 2')}.`;
  const defaults: SafetyLimits = { warn: panel.safetyWarnFpm, tier1: panel.safetyTier1Fpm, tier2: panel.safetyTier2Fpm };
  const types = [...own.keys()];
  const ownText =
    types.length === 0
      ? `No aircraft has limits of its own yet, so every aircraft uses these. ${SETTINGS_PAGE} lists the fleet and sets each type.`
      : `${types.length === 1 ? '1 aircraft type has' : `${types.length} aircraft types have`} limits of its own (${types.slice(0, NAMED_TYPES).join(', ')}${types.length > NAMED_TYPES ? ` and ${types.length - NAMED_TYPES} more` : ''}); every other aircraft uses these. ${SETTINGS_PAGE} shows them all.`;
  return [
    `${done}Landing safety pay is **on** for **${name}**, for flights that landed after <t:${Math.floor(panel.safetyPaySince / 1000)}:f>. A flight that landed before that is paid as it always was.`,
    `• **Limits** (a landing at least this hard, in feet per minute), for an aircraft with none of its own: ${limitsText(defaults)}. ${ownText}`,
    `• **Warning**, a landing from -${defaults.warn} fpm: the pilot is sent a warning, and there is no fine.`,
    `• **Tier 1**, from -${defaults.tier1} fpm: the pilot is paid **${panel.safetyShareTier1}%** of the flight's profit instead of 15%.`,
    `• **Tier 2**, from -${defaults.tier2} fpm: the pilot is paid **${panel.safetyShareTier2}%** of the profit.`,
    `• ${minimum}`,
    `• **If in doubt, I leave it alone.** The landing rate is FsHub's. A flight it gave no rate for, or a rate beyond -${IMPLAUSIBLE_FPM.toLocaleString('en-US')} fpm (a bad reading), is **not filled in** by \`/setup profit\` (neither its profit nor its pay), and ${managers} is told so someone can fill it in by hand.`,
    `• **Reports.** When a pilot lands at Tier 1 or Tier 2, ${managers} is sent a report by DM (pilot, FsHub ID, flight, route, landing time and rate), and a row is added to **${HARD_LANDINGS_CSV}** in my data folder.`,
    ...(reach ? [`• ${reach}`] : []),
    panel.safetyDeductions
      ? "• **In the sheet.** What a hard landing takes off a pilot's pay (what the flight would have paid, less what it pays) is written in the sheet's **Safety Deductions** column, beside the Pilot Pay that `/setup profit` fills in. The sheet needs that column (I never add one), and its cell has to be empty; a flight whose pay is not cut writes nothing there. Flights filled in before you switched this on can be given theirs with `/setup profit action:deductions`."
      : "• **In the sheet.** What a hard landing takes off the pay is not written in the sheet. `/setup safety-pay deductions:on` writes it in a **Safety Deductions** column beside the Pilot Pay (add that heading to the sheet first).",
    `• Pilots are sent the safety notice by DM (they can't switch it off). The light-hearted remark follows it for a landing of -600 fpm or harder (that line is the same for every aircraft), unless the pilot switched the remarks off.`,
    'Change what a pilot loses of the minimum with `/setup safety-pay minimum-loss:...` (both tiers) or `tier1-loss:...` and `tier2-loss:...`, and the share of the profit with `tier1-share:...` and `tier2-share:...` (each from 0 to 100). Turn it off with `/setup safety-pay mode:off`.',
  ].join('\n');
}

/** Turn safety pay on from now, or, if it is on, change what a pilot loses (the day it started stays). */
function apply(ctx: BotContext, panel: Panel, tier1: number, tier2: number): void {
  if (panel.safetyPaySince === null) ctx.store.updatePanel(panel.id, { safetyPaySince: ctx.now(), safetyLossTier1: tier1, safetyLossTier2: tier2 });
  else ctx.store.updatePanel(panel.id, { safetyLossTier1: tier1, safetyLossTier2: tier2 });
}

/**
 * `/setup safety-pay`. With nothing given it says how things stand. `mode:off` turns it off. `mode:on` turns it on, asking first (with buttons) what percentage
 * of the minimum pay a pilot loses, the same for both tiers or a different one for each, unless it was given too. `minimum-loss` is one percentage for both tiers;
 * `tier1-loss` and `tier2-loss` are one for each, and `tier1-share` and `tier2-share` are the share of the profit a pilot is paid after each tier. Given on their own they change that answer.
 */
export function safetyPayCommand(ctx: BotContext, panelIn: Panel, mode: string | null, loss: LossArgs, reach = ''): SafetyReply {
  let panel = panelIn;
  const fresh = () => ctx.store.getPanel(panel.id) as Panel;
  /** What was saved about writing deductions in the sheet, said first in whatever the reply is. */
  let deductionsDone = '';
  const own = () => ctx.store.listSafetyLimits(panel.id);
  const say = (content: string): SafetyReply => ({ content: deductionsDone !== '' && !content.startsWith(deductionsDone) ? `${deductionsDone.trim()}\n${content}` : content, components: [] });
  const managers = managersText(ctx, panel);
  const status = (p: Panel, done = ''): string => safetyStatus(p, `${deductionsDone}${done}`, managers, reach, own());
  for (const v of [loss.both, loss.tier1, loss.tier2, loss.share1 ?? null, loss.share2 ?? null]) {
    if (v !== null && (!Number.isInteger(v) || v < 0 || v > 100)) throw new UserError('`minimum-loss`, `tier1-loss`, `tier2-loss`, `tier1-share` and `tier2-share` are whole numbers of per cent, from 0 to 100.');
  }
  if (loss.both !== null && (loss.tier1 !== null || loss.tier2 !== null)) {
    throw new UserError('Give `minimum-loss` (one percentage for both tiers) or `tier1-loss` and `tier2-loss` (one for each), not both.');
  }
  // The share of the profit a pilot is paid after each tier is its own setting too: saved at once, whatever else is asked (also while safety pay is off).
  if ((loss.share1 ?? null) !== null || (loss.share2 ?? null) !== null) {
    const s1 = loss.share1 ?? panel.safetyShareTier1;
    const s2 = loss.share2 ?? panel.safetyShareTier2;
    if (s1 !== panel.safetyShareTier1 || s2 !== panel.safetyShareTier2) {
      ctx.store.updatePanel(panel.id, { safetyShareTier1: s1, safetyShareTier2: s2 });
      panel = fresh();
      deductionsDone += `Done: a pilot is now paid ${s1}% of the profit after a Tier 1 landing and ${s2}% after a Tier 2 one${panel.safetyPaySince === null ? ' (once safety pay is on)' : ''}. `;
    } else deductionsDone += 'Those shares were already set. ';
  }
  // Whether the deductions are written in the sheet is its own setting: saved at once, whatever else is asked (also while safety pay is off).
  if (loss.deductions === 'on' || loss.deductions === 'off') {
    const want = loss.deductions === 'on';
    if (want !== panel.safetyDeductions) {
      ctx.store.updatePanel(panel.id, { safetyDeductions: want });
      panel = fresh();
      deductionsDone = want
        ? `Done: from now on \`/setup profit\` also writes what a hard landing takes off a pilot's pay in the sheet's Safety Deductions column${panel.safetyPaySince === null ? ' (once safety pay is on)' : ''}. `
        : 'Done: deductions are no longer written in the sheet. ';
    } else deductionsDone = want ? 'Deductions were already being written in the sheet. ' : 'Deductions were already not being written in the sheet. ';
  }
  const given = loss.both !== null || loss.tier1 !== null || loss.tier2 !== null;
  const t1 = loss.both ?? loss.tier1 ?? panel.safetyLossTier1;
  const t2 = loss.both ?? loss.tier2 ?? panel.safetyLossTier2;
  const same = t1 === panel.safetyLossTier1 && t2 === panel.safetyLossTier2;
  if (mode === 'off') {
    if (panel.safetyPaySince === null) return say(status(panel, 'It was already off. '));
    ctx.store.updatePanel(panel.id, { safetyPaySince: null });
    return say(status(fresh(), 'Done. Flights that land from now on are paid as they always were, and the light-hearted remarks about hard landings are back for this airline. (Pay already worked out is not changed.) '));
  }
  if (mode === 'on') {
    const blocked = cannotTurnOn(ctx, panel);
    if (blocked) return say(blocked);
    if (panel.safetyPaySince === null) {
      if (!given) {
        const q = question(panel);
        return deductionsDone !== '' ? { ...q, content: `${deductionsDone.trim()}\n${q.content}` } : q;
      }
      if (loss.both === null && (loss.tier1 === null) !== (loss.tier2 === null)) return say('To turn it on with a percentage for each tier I need both: give `tier1-loss` and `tier2-loss`, or `minimum-loss` for both tiers at once.');
      apply(ctx, panel, t1, t2);
      return say(status(fresh(), 'Done. '));
    }
    if (given && !same) {
      apply(ctx, panel, t1, t2);
      return say(status(fresh(), 'Done. It was already on; the percentages are changed. '));
    }
    return say(status(panel, 'It is already on. '));
  }
  if (given) {
    if (same) return say(status(panel, 'That is how it already is. '));
    ctx.store.updatePanel(panel.id, { safetyLossTier1: t1, safetyLossTier2: t2 });
    return say(status(fresh(), panel.safetyPaySince === null ? 'Saved. Safety pay is still off, and will use this when you turn it on. ' : 'Done. '));
  }
  return say(status(panel));
}

/** What a button's `way` means: cancel, one percentage for both tiers, "set each tier apart", Tier 1 answered (`a25`), or Tier 2 answered with Tier 1 given (`b40-10`). */
type Press = { kind: 'cancel' } | { kind: 'both'; pct: number } | { kind: 'split' } | { kind: 'tier1'; pct: number } | { kind: 'tier2'; pct: number; tier1: number };

function parsePress(way: string | undefined): Press | null {
  if (way === undefined) return null;
  if (way === 'cancel') return { kind: 'cancel' };
  if (way === 'split') return { kind: 'split' };
  const within = (n: number): boolean => n >= 0 && n <= 100;
  let m = /^(\d{1,3})$/.exec(way);
  if (m && within(Number(m[1]))) return { kind: 'both', pct: Number(m[1]) };
  m = /^a(\d{1,3})$/.exec(way);
  if (m && within(Number(m[1]))) return { kind: 'tier1', pct: Number(m[1]) };
  m = /^b(\d{1,3})-(\d{1,3})$/.exec(way);
  if (m && within(Number(m[1])) && within(Number(m[2]))) return { kind: 'tier2', pct: Number(m[1]), tier1: Number(m[2]) };
  return null;
}

/**
 * The buttons under the questions: `safety:<percent>:<panel>` (both tiers), `safety:split:<panel>`, `safety:a<percent>:<panel>` (Tier 1),
 * `safety:b<percent>-<tier 1 percent>:<panel>` (Tier 2) and `safety:cancel:<panel>`. Only a server admin of that panel's server can press them.
 */
export const safetyHandler: ComponentHandler = {
  prefix: 'safety',
  async handle(ctx, interaction) {
    if (!interaction.isButton()) return;
    const [, way, id] = interaction.customId.split(':');
    const panelId = Number(id);
    const press = parsePress(way);
    if (!Number.isInteger(panelId) || press === null) throw new UserError('That button is out of date.');
    if (!interaction.guildId) throw new UserError('This only works inside a server.');
    if (!isAdmin(interaction)) throw new UserError('Only server admins (with the **Manage Server** permission) can do that.');
    const panel = ctx.store.getPanel(panelId);
    if (!panel || panel.guildId !== interaction.guildId) throw new UserError('That panel is no longer active.');
    const say = (content: string, components: Row[] = []) => interaction.update({ content, components, allowedMentions: noPings });
    if (press.kind === 'cancel') {
      await say('Okay, nothing was changed.');
      return;
    }
    const blocked = cannotTurnOn(ctx, panel);
    if (blocked) {
      await say(blocked);
      return;
    }
    if (press.kind === 'split') {
      const q = tier1Question(panel);
      await say(q.content, q.components);
      return;
    }
    if (press.kind === 'tier1') {
      const q = tier2Question(panel, press.pct);
      await say(q.content, q.components);
      return;
    }
    if (press.kind === 'tier2') apply(ctx, panel, press.tier1, press.pct);
    else apply(ctx, panel, press.pct, press.pct);
    await say(safetyStatus(ctx.store.getPanel(panelId) as Panel, 'Done. ', managersText(ctx, panel), await reachText(ctx, panel), ctx.store.listSafetyLimits(panelId)));
  },
};
