import { randomBytes } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { Panel, PayrollSettings } from '../db/store.js';
import { NOT_CONNECTED_TEXT } from '../services/payGateway.js';
import { amendLine, dollarsText, FLAG_TEXT, summarise, type PayDraft, type PayLine } from '../services/payroll.js';
import { PayrollError, type PayOutcome, type TickOutcome } from '../services/payrollService.js';
import { plainText, truncate, ts } from '../util/format.js';
import type { BotContext, ComponentHandler } from './context.js';
import { isDmClosed, isMissingAccess, UserError } from './errors.js';
import { mayConfirm } from './profitUi.js';
import { noPings } from './ui.js';

/** How long a list waits when it is shown only to the admin who asked (the reply goes away by itself soon after), and when it is sent or posted. */
const HERE_TTL_MS = 60 * 60_000;
const SENT_TTL_MS = 26 * 3_600_000;
/** What one page of the list may take of Discord's 2000 characters, and the most payments it shows. */
const PAGE_BUDGET = 1250;
const PAGE_MAX = 8;
const MESSAGE_MAX = 1990;

type Place = 'here' | 'dm' | 'channel';
type View = { mode: 'list' | 'amend'; page: number };

/* ------------------------------------------------------------------ drawing the list */

const pageOfLine = (lines: PayLine[], n: number): number => Math.max(0, paginate(lines).findIndex((p) => p.some((l) => l.n === n)));

/** One payment, as it is shown: who, how much, which account and unique ID, and what is wrong with it if anything is. */
export function lineText(l: PayLine): string {
  const mark = l.out ? '⏸️' : l.flags.length > 0 ? '⚠️' : '✅';
  const lines = [
    `${mark} **${l.n}** · ${plainText(truncate(l.pilot, 40))} · **${dollarsText(l.cents)}**${l.amended ? ' ✏️' : ''}${l.out ? ' · *left out of this run*' : ''}`,
    `↳ ${l.account ? `\`${l.account}\`` : '*no account*'} · \`${l.uniqueId}\``,
  ];
  if (!l.out && l.flags.length > 0) lines.push(`↳ ⚠️ ${l.flags.map((f) => FLAG_TEXT[f]).join('; ')}`);
  return lines.join('\n');
}

/** The payments split into pages that fit in a message. */
export function paginate(lines: PayLine[]): PayLine[][] {
  const pages: PayLine[][] = [];
  let page: PayLine[] = [];
  let size = 0;
  for (const l of lines) {
    const len = lineText(l).length + 1;
    if (page.length > 0 && (size + len > PAGE_BUDGET || page.length >= PAGE_MAX)) {
      pages.push(page);
      page = [];
      size = 0;
    }
    page.push(l);
    size += len;
  }
  if (page.length > 0) pages.push(page);
  return pages.length > 0 ? pages : [[]];
}

function headerText(d: PayDraft): string {
  const s = summarise(d.lines);
  const parts = [`**${s.ready.length}** ready to pay, **${dollarsText(s.totalCents)}**`];
  if (s.flagged > 0) parts.push(`**${s.flagged}** ${s.flagged === 1 ? 'needs' : 'need'} a look first`);
  if (s.out > 0) parts.push(`${s.out} left out`);
  return [
    `💷 **Pilot payments: ${plainText(truncate(d.airline, 60))}**`,
    `From account \`${d.sourceAccount}\` · ${parts.join(' · ')}`,
    ...(d.waiting > 0 ? [`⏳ ${d.waiting} completed flight${d.waiting === 1 ? ' has' : 's have'} no Pilot Pay yet, so ${d.waiting === 1 ? 'it is' : 'they are'} not on this list.`] : []),
    ...(d.unsettled > 0 ? [`⛔ ${d.unsettled} earlier payment${d.unsettled === 1 ? ' never got' : 's never got'} an answer from the bank. Check ${d.unsettled === 1 ? 'it' : 'them'} there: ${d.unsettled === 1 ? 'its' : 'their'} flights stay off every list until then.`] : []),
  ].join('\n');
}

/** The message for one page of the list (or the same page with a menu to choose the payment to amend). */
export function renderList(d: PayDraft, token: string, view: View, connected: boolean, note = ''): { content: string; components: ActionRowBuilder<MessageActionRowComponentBuilder>[]; allowedMentions: typeof noPings } {
  const pages = paginate(d.lines);
  const page = Math.min(Math.max(0, view.page), pages.length - 1);
  const shown = pages[page] as PayLine[];
  const foot = (withNote: boolean) =>
    [
      ...(pages.length > 1 ? [`Page ${page + 1} of ${pages.length}`] : []),
      view.mode === 'amend'
        ? '**Amend:** choose the payment to change, by its number, from the menu.'
        : 'Check each line, then press **Pay**. A ⚠️ line is not paid until you **Amend** it (submitting it as it is says you have checked it). Nothing is paid until someone presses **Pay**.',
      ...(connected ? [] : ["⚠️ Paying isn't connected to Aeroconomy yet: **Pay** checks the list and stops. Nothing is sent."]),
      ...(withNote && note ? [note] : []),
    ].join('\n');
  const build = (withNote: boolean) => [headerText(d), '', shown.map(lineText).join('\n'), '', foot(withNote)].join('\n');
  let content = build(true);
  if (content.length > MESSAGE_MAX) content = build(false);

  const { ready, totalCents } = summarise(d.lines);
  const button = (id: string, label: string, style: ButtonStyle, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (view.mode === 'amend') {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`payroll:pick:${token}:${page}`)
          .setPlaceholder('Which payment? (its number comes first)')
          .addOptions(
            shown.map((l) => ({
              label: truncate(`${l.n} · ${plainText(l.pilot)}`, 100),
              description: truncate(`${dollarsText(l.cents)} · ${l.account ?? 'no account'}${l.out ? ' · left out' : l.flags.length > 0 ? ' · needs a look' : ''}`, 100),
              value: String(l.n),
            })),
          ),
      ),
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...(pages.length > 1 ? [button(`payroll:ap:${token}:${page - 1}`, '◀', ButtonStyle.Secondary, page === 0), button(`payroll:ap:${token}:${page + 1}`, '▶', ButtonStyle.Secondary, page >= pages.length - 1)] : []),
        button(`payroll:bk:${token}:${page}`, 'Back to the list', ButtonStyle.Secondary),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...(pages.length > 1 ? [button(`payroll:pg:${token}:${page - 1}`, '◀', ButtonStyle.Secondary, page === 0), button(`payroll:pg:${token}:${page + 1}`, '▶', ButtonStyle.Secondary, page >= pages.length - 1)] : []),
        button(`payroll:am:${token}:${page}`, 'Amend', ButtonStyle.Primary, d.lines.length === 0),
      ),
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        button(`payroll:pay:${token}`, ready.length === 0 ? 'Nothing to pay' : `Pay ${ready.length} · ${dollarsText(totalCents)}`, ButtonStyle.Success, ready.length === 0),
        button(`payroll:no:${token}`, 'Cancel', ButtonStyle.Secondary),
      ),
    );
  }
  return { content, components: rows, allowedMentions: noPings };
}

/** The amend form for one payment, with what it has now filled in. */
export function amendModal(token: string, l: PayLine, page: number): ModalBuilder {
  const input = (id: string, label: string, value: string, max: number, placeholder?: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      // Discord allows a label of 45 characters at most, and a filled-in value no longer than the box takes.
      new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max).setValue(value.slice(0, max)).setPlaceholder(placeholder ?? ''),
    );
  const amount = l.out ? '0' : Number.isInteger(l.cents / 100) ? String(l.cents / 100) : (l.cents / 100).toFixed(2);
  return new ModalBuilder()
    .setCustomId(`payroll:save:${token}:${l.n}:${page}`)
    .setTitle(truncate(`Amend payment ${l.n}: ${plainText(l.pilot)}`, 45))
    .addComponents(
      input('account', 'Account number', l.account ?? '', 32, '9954-0000123'),
      input('amount', 'Amount in dollars (0 = leave it out)', amount, 14, '8131. Or 0 to leave it out of this run'),
      input('uid', 'Unique ID', l.uniqueId, 64),
    );
}

/* ------------------------------------------------------------------ keeping a list */

interface Kept {
  token: string;
  panelId: number;
  askerId: string;
  place: Place;
  createdAt: number;
  expiresAt: number;
  draft: PayDraft;
}

function loadList(ctx: BotContext, token: string | undefined): Kept | null {
  if (!token) return null;
  const row = ctx.store.getPayrollDraft(token, ctx.now());
  if (!row) return null;
  try {
    const draft = JSON.parse(row.body) as PayDraft;
    if (!draft || !Array.isArray(draft.lines)) return null;
    return { token: row.token, panelId: row.panelId, askerId: row.askerId, place: row.place === 'dm' ? 'dm' : row.place === 'channel' ? 'channel' : 'here', createdAt: row.createdAt, expiresAt: row.expiresAt, draft };
  } catch {
    return null;
  }
}

const keep = (ctx: BotContext, k: Kept): void => ctx.store.savePayrollDraft({ token: k.token, panelId: k.panelId, askerId: k.askerId, place: k.place, body: JSON.stringify(k.draft), createdAt: k.createdAt, expiresAt: k.expiresAt });

/* ------------------------------------------------------------------ sending the list */

/** What a list can be sent to: the bot's Discord client, for a list made on its own (nobody ran a command to get it). */
export interface ListClient {
  users: { fetch(id: string): Promise<{ send(payload: unknown): Promise<unknown> }> };
  channels: { fetch(id: string): Promise<unknown> };
}

function whyNot(e: unknown, where: 'dm' | 'channel'): string {
  if (where === 'dm' && isDmClosed(e)) return 'DMs from this server are closed';
  if (where === 'channel' && isMissingAccess(e)) return "I'm missing access or permissions there";
  return 'something went wrong, it is in my log';
}

/**
 * Send a list to be checked, where the panel sends the Profit Made preview (`/setup profit send-to`): to the admin who asked in the reply,
 * to their DMs, or to a channel. A list nobody asked for (the daily one) has no reply to go in, so "here" means the DMs of the admin who set
 * payroll up. If a DM or a channel does not work the list is tried in the next place, so it is never lost. Older lists of the panel are dropped.
 * Returns where it went, or null if it could not be delivered anywhere.
 */
export async function sendList(
  ctx: BotContext,
  panel: Panel,
  settings: PayrollSettings,
  draft: PayDraft,
  who: { askerId: string; interaction?: ChatInputCommandInteraction; client?: ListClient },
): Promise<{ where: Place; token: string } | null> {
  const now = ctx.now();
  const connected = ctx.payroll?.gateway.connected ?? false;
  const roleId = panel.profitRoleId;
  ctx.store.clearPayrollDrafts(panel.id, now);
  const make = (place: Place, note: string) => {
    const token = randomBytes(6).toString('hex');
    keep(ctx, { token, panelId: panel.id, askerId: who.askerId, place, createdAt: now, expiresAt: now + (place === 'here' ? HERE_TTL_MS : SENT_TTL_MS), draft });
    return { token, message: renderList(draft, token, { mode: 'list', page: 0 }, connected, note) };
  };
  const interaction = who.interaction;
  let want: Place = panel.profitSendTo;
  if (want === 'channel' && !panel.profitChannelId) want = interaction ? 'here' : 'dm';
  if (!interaction && want === 'here') want = 'dm';
  let instead = '';

  if (want === 'channel') {
    const channelId = panel.profitChannelId as string;
    const press = roleId ? `<@${who.askerId}> or anyone with <@&${roleId}> can press **Pay**.` : `Only <@${who.askerId}> can press **Pay**.`;
    const { token, message } = make('channel', press);
    try {
      const channel = (interaction ? await interaction.guild?.channels.fetch(channelId).catch(() => null) : await who.client?.channels.fetch(channelId).catch(() => null)) as { isSendable?(): boolean; send(p: unknown): Promise<{ id: string }> } | null | undefined;
      if (!channel || !channel.isSendable?.()) throw new UserError("I can't post in that channel any more");
      const sent = await channel.send(message);
      if (interaction) {
        await interaction.editReply({ content: `📣 I posted the pay list in <#${channelId}> (https://discord.com/channels/${panel.guildId}/${channelId}/${sent.id}). Nothing is paid until someone who may presses **Pay** there${roleId ? `: you, or a member of <@&${roleId}>` : ''}.`, allowedMentions: noPings });
      }
      return { where: 'channel', token };
    } catch (e) {
      ctx.store.deletePayrollDraft(token);
      if (!(e instanceof UserError)) ctx.log.warn(`Could not post the pay list in ${channelId}`, e);
      instead = `⚠️ I couldn't post it in <#${channelId}> (${e instanceof UserError ? e.message : whyNot(e, 'channel')}), so it is ${interaction ? 'here instead, for you alone' : 'in your DMs instead'}.`;
      want = interaction ? 'here' : 'dm';
    }
  }
  if (want === 'dm') {
    const { token, message } = make('dm', instead);
    try {
      const user = interaction ? interaction.user : await who.client?.users.fetch(who.askerId);
      if (!user) throw new UserError('nobody to send it to');
      await user.send(message);
      if (interaction) await interaction.editReply({ content: '📬 I sent the pay list to your DMs. Nothing is paid until you press **Pay** there.', allowedMentions: noPings });
      return { where: 'dm', token };
    } catch (e) {
      ctx.store.deletePayrollDraft(token);
      if (!isDmClosed(e) && !(e instanceof UserError)) ctx.log.warn('Could not DM the pay list', e);
      if (!interaction) {
        ctx.log.warn(`The pay list for ${panel.airlineName} could not be delivered: ${whyNot(e, 'dm')}`);
        return null;
      }
      instead = `${instead ? `${instead}\n` : ''}⚠️ I couldn't send it to your DMs (${whyNot(e, 'dm')}), so it is here instead.`;
    }
  }
  const { token, message } = make('here', instead);
  await (interaction as ChatInputCommandInteraction).editReply(message);
  return { where: 'here', token };
}

/* ------------------------------------------------------------------ pressing the buttons */

const GONE = 'That pay list has expired, was replaced by a newer one, or was already used. Nothing was paid. `/payroll run` makes a fresh one.';

type Pressed = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

/** Replace the message the press came from. A form that was not opened from a message has none to replace, so it gets a private reply. */
async function showOn(interaction: Pressed, message: { content: string; components: ActionRowBuilder<MessageActionRowComponentBuilder>[]; allowedMentions: typeof noPings }): Promise<void> {
  if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
    await interaction.reply({ ...message, flags: MessageFlags.Ephemeral });
    return;
  }
  await (interaction as ButtonInteraction).update(message);
}

const refuse = (interaction: Pressed, content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noPings });

const money = (cents: number) => dollarsText(cents);

const SKIP_TEXT: Record<PayOutcome['skipped'][number]['reason'], string> = {
  gone: 'its row is no longer in the sheet',
  changed: 'the sheet no longer agrees with the list (the pilot or the Pilot Pay changed)',
  'not-completed': 'its row is no longer ticked as completed',
  'already-paid': 'its Pilot Paid box has been ticked',
  'already-sent': 'it is already in the ledger',
  'no-account': 'it has no account',
};

/** What became of the Pilot Paid boxes: ticked, and any that a person has to tick (with the rows, so they can). Empty when there was nothing to tick. */
export function tickText(t: TickOutcome): string {
  const rows = (list: number[]) => {
    const sorted = [...new Set(list)].sort((a, b) => a - b);
    return `${sorted.slice(0, 15).join(', ')}${sorted.length > 15 ? `, and ${sorted.length - 15} more` : ''}`;
  };
  const lines: string[] = [];
  const ticked = t.done.length;
  if (ticked > 0) lines.push(`☑️ Ticked **Pilot Paid** in the sheet on ${ticked} row${ticked === 1 ? '' : 's'}.`);
  if (t.left.length > 0) {
    const why = [...new Set(t.left.map((l) => l.why))].join('; ');
    lines.push(`⚠️ I did not tick **Pilot Paid** on ${t.left.length} row${t.left.length === 1 ? '' : 's'} (${truncate(why, 160)}). Tick ${t.left.length === 1 ? 'it' : 'them'} by hand: row${t.left.length === 1 ? '' : 's'} ${rows(t.left.map((l) => l.row))}.`);
  }
  return lines.join('\n');
}

/** What a paid list came to, in words, kept inside one message. */
export function outcomeText(o: PayOutcome, by: string, now: number): string {
  const total = o.paid.reduce((sum, l) => sum + l.cents, 0);
  const who = (l: PayLine) => `${l.n} · ${plainText(truncate(l.pilot, 30))}`;
  // The four sections, in the order they are shown. Each has its heading and the line for every payment in it.
  const sections = [
    { key: 'paid', head: `✅ Paid **${o.paid.length}** payment${o.paid.length === 1 ? '' : 's'}, **${money(total)}**, at ${ts(now, 't')}.`, items: o.paid.map((l) => `• ${who(l)} · ${money(l.cents)} · \`${l.uniqueId}\``), always: true },
    { key: 'failed', head: `❌ **${o.failed.length}** refused by the bank, so nothing was sent for ${o.failed.length === 1 ? 'it' : 'them'}. ${o.failed.length === 1 ? 'It' : 'They'} will be on the next list:`, items: o.failed.map((f) => `• ${who(f.line)} · ${truncate(f.reason, 100)}`), always: false },
    { key: 'skipped', head: `⏭️ **${o.skipped.length}** left unpaid because the sheet changed since the list was made. ${o.skipped.length === 1 ? 'It comes' : 'They come'} up again on the next list if still due:`, items: o.skipped.map((s) => `• ${who(s.line)} · ${SKIP_TEXT[s.reason]}`), always: false },
    { key: 'unconfirmed', head: `⛔ **${o.unconfirmed.length}** got no answer from the bank, so nobody knows if the money moved. Check ${o.unconfirmed.length === 1 ? 'it' : 'them'} at the bank before anything else is done about ${o.unconfirmed.length === 1 ? 'it' : 'them'}:`, items: o.unconfirmed.map((l) => `• ${who(l)} · ${money(l.cents)} · \`${l.uniqueId}\``), always: false },
  ].filter((s) => s.always || s.items.length > 0);
  const ticks = tickText(o.tick);
  const held = o.held.length > 0 ? `⏸️ **${o.held.length}** more were not tried, because of that. They come up again on the next list.` : '';
  // Every heading is always shown. What is left of the message is shared out between the payments in the order that matters most: a payment
  // with no answer first, then a refusal, then one left out, and last the ones that went through.
  const MORE = 22;
  let used = sections.reduce((sum, s) => sum + s.head.length + 1, 0) + (held ? held.length + 1 : 0) + (ticks ? ticks.length + 1 : 0) + (by ? by.length + 1 : 0);
  const shown = new Map<string, number>();
  for (const key of ['unconfirmed', 'failed', 'skipped', 'paid']) {
    const s = sections.find((x) => x.key === key);
    if (!s) continue;
    let n = 0;
    for (const item of s.items) {
      if (used + item.length + 1 + MORE > MESSAGE_MAX) break;
      used += item.length + 1;
      n++;
    }
    if (n < s.items.length) used += MORE;
    shown.set(key, n);
  }
  const lines: string[] = [];
  for (const s of sections) {
    const n = shown.get(s.key) ?? 0;
    lines.push(s.head, ...s.items.slice(0, n));
    if (n < s.items.length) lines.push(`…and ${s.items.length - n} more.`);
  }
  if (ticks) lines.push(ticks);
  if (held) lines.push(held);
  if (by) lines.push(by);
  return lines.join('\n');
}

/** The buttons, menu and forms of a pay list. Only the admin the list belongs to, or a member of the role chosen for it, can work on it. */
export const payrollHandler: ComponentHandler = {
  prefix: 'payroll',
  async handle(ctx, interaction) {
    const [, way, token, a, b] = interaction.customId.split(':');
    const kept = loadList(ctx, token);
    const panel = kept ? ctx.store.getPanel(kept.panelId) : null;
    if (!kept || !panel) {
      if (interaction.isModalSubmit() && !interaction.isFromMessage()) await refuse(interaction, GONE);
      else await (interaction as ButtonInteraction).update({ content: GONE, components: [], allowedMentions: noPings });
      return;
    }
    // The role is read now and not when the list was made, so changing it takes effect on lists that are already up.
    const roleId = panel.profitRoleId;
    if (!(await mayConfirm(interaction, { userId: kept.askerId, guildId: panel.guildId }, roleId))) {
      await refuse(interaction, `Only the admin who set up paying${roleId ? `, or a member of <@&${roleId}>,` : ''} can work on this list.`);
      return;
    }
    const connected = ctx.payroll?.gateway.connected ?? false;
    const draw = (view: View, note = '') => renderList(kept.draft, kept.token, view, connected, note);
    const page = Math.max(0, Number(a) || 0);

    switch (way) {
      case 'pg':
      case 'ap':
        await showOn(interaction, draw({ mode: way === 'ap' ? 'amend' : 'list', page }));
        return;
      case 'am':
        await showOn(interaction, draw({ mode: 'amend', page }));
        return;
      case 'bk':
        await showOn(interaction, draw({ mode: 'list', page }));
        return;

      case 'pick': {
        if (!interaction.isStringSelectMenu()) return;
        const line = kept.draft.lines.find((l) => l.n === Number(interaction.values[0]));
        if (!line) {
          await refuse(interaction, 'That payment is not on the list.');
          return;
        }
        await interaction.showModal(amendModal(kept.token, line, page));
        return;
      }

      case 'save': {
        if (!interaction.isModalSubmit()) return;
        const n = Number(a);
        const done = amendLine(
          kept.draft.lines,
          n,
          { account: interaction.fields.getTextInputValue('account'), amount: interaction.fields.getTextInputValue('amount'), uniqueId: interaction.fields.getTextInputValue('uid') },
          (id) => ctx.payroll?.uniqueIdTaken(panel.id, id) ?? false,
        );
        if (!done.ok) throw new UserError(done.error);
        kept.draft = { ...kept.draft, lines: done.lines };
        keep(ctx, kept);
        await showOn(interaction, draw({ mode: 'list', page: pageOfLine(done.lines, n) }, `✏️ Payment ${n} amended.`));
        return;
      }

      case 'no': {
        if (!ctx.store.deletePayrollDraft(kept.token)) {
          await refuse(interaction, 'Someone else pressed this a moment ago.');
          return;
        }
        const by = kept.place === 'channel' ? ` Pressed by <@${interaction.user.id}>.` : '';
        await (interaction as ButtonInteraction).update({ content: `Cancelled. No payments were made. The same flights will be on the next list.${by}`, components: [], allowedMentions: noPings });
        return;
      }

      case 'pay': {
        const payroll = ctx.payroll;
        const { ready, totalCents } = summarise(kept.draft.lines);
        if (!payroll || !payroll.gateway.connected) {
          await refuse(interaction, `${NOT_CONNECTED_TEXT}\n(${ready.length} payment${ready.length === 1 ? '' : 's'}, ${money(totalCents)}, would have gone out.)`);
          return;
        }
        if (ready.length === 0) {
          await refuse(interaction, 'There is nothing ready to pay on this list.');
          return;
        }
        const settings = ctx.store.getPayrollSettings(panel.id);
        if (!settings) {
          await refuse(interaction, 'Paying is not set up for this airline any more.');
          return;
        }
        // Nothing is awaited between the permission check and taking the list away, so when two people press at once only one of them gets it.
        if (!ctx.store.deletePayrollDraft(kept.token)) {
          await refuse(interaction, 'Someone else pressed this a moment ago, so nothing more was paid.');
          return;
        }
        const by = kept.place === 'channel' ? `Pressed by <@${interaction.user.id}>.` : '';
        await (interaction as ButtonInteraction).deferUpdate();
        try {
          const outcome = await payroll.pay(panel, settings, kept.draft.lines);
          await (interaction as ButtonInteraction).editReply({ content: outcomeText(outcome, by, ctx.now()), components: [], allowedMentions: noPings });
        } catch (e) {
          if (!(e instanceof PayrollError)) throw e;
          // Nothing was sent: the list goes back as it was, so it can be tried again.
          keep(ctx, kept);
          await (interaction as ButtonInteraction).editReply({ ...draw({ mode: 'list', page: 0 }, `⚠️ Nothing was paid: ${e.message}`) });
        }
        return;
      }
    }
  },
};

/* ------------------------------------------------------------------ the daily list */

/** Once a day, at the time an admin chose, makes the list of what is due and sends it to be checked. Nothing is ever paid by this. */
export class PayrollDaily {
  constructor(
    private readonly ctx: BotContext,
    private readonly client: ListClient,
  ) {}

  async run(): Promise<void> {
    const { ctx } = this;
    const payroll = ctx.payroll;
    if (!payroll) return;
    for (const settings of ctx.store.listPayrollEnabled()) {
      const now = ctx.now();
      if (!payroll.isDue(settings, now)) continue;
      const panel = ctx.store.getPanel(settings.panelId);
      if (!panel || !settings.ownerId) continue;
      try {
        const draft = await payroll.prepare(panel, settings);
        if (draft.lines.length === 0) {
          ctx.log.info(`No pilot payments are due for ${panel.airlineName} today`);
          payroll.noteRan(panel.id, now);
          continue;
        }
        const sent = await sendList(ctx, panel, settings, draft, { askerId: settings.ownerId, client: this.client });
        if (sent) payroll.noteRan(panel.id, now);
        else payroll.noteTried(panel.id, now);
      } catch (e) {
        payroll.noteTried(panel.id, now);
        if (!(e instanceof PayrollError)) {
          ctx.log.error(`Making the pay list for ${panel.airlineName} failed`, e);
          continue;
        }
        ctx.log.warn(`Could not make the pay list for ${panel.airlineName}: ${e.message}`);
        // Said once a day, not every time it is tried again.
        const told = `payroll.told.${panel.id}`;
        const today = String(Math.floor(now / 86_400_000));
        if (ctx.store.getKv(told) !== today) {
          ctx.store.setKv(told, today);
          try {
            const user = await this.client.users.fetch(settings.ownerId);
            await user.send({ content: `💷 I couldn't make today's pay list for **${plainText(panel.airlineName)}**: ${e.message}\nI will try again in a while.`, allowedMentions: noPings });
          } catch {
            /* DMs closed: it is in the log */
          }
        }
      }
    }
  }
}

/** For the settings text: when a day's list is made. */
export const runTimeText = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} Zulu`;
