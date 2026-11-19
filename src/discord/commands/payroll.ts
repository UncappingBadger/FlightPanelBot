import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type AutocompleteInteraction } from 'discord.js';
import type { Panel, PayrollSettings } from '../../db/store.js';
import { parseSheetUrl, sheetRefOf, sheetViewUrl } from '../../jobs/sheet.js';
import { cleanAccount, dollarsText, isAccount } from '../../services/payroll.js';
import { airlineLabel, plainText, truncate, ts } from '../../util/format.js';
import type { BotContext, Command } from '../context.js';
import { UserError } from '../errors.js';
import { requireAdmin } from '../guard.js';
import { runTimeText, sendList } from '../payrollUi.js';
import { noPings } from '../ui.js';
import { pickPanel } from './setup.js';

const DAY = 86_400_000;

/** `2026-11-19` as midnight Zulu, or null for anything that is not a real date written that way. */
function parseDay(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  return back.getUTCFullYear() === Number(m[1]) && back.getUTCMonth() === Number(m[2]) - 1 && back.getUTCDate() === Number(m[3]) ? t : null;
}

/** `12:00` (Zulu) as minutes after midnight, or null. */
function parseTimeOfDay(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** What is set up, in words, and what is still missing. */
export function payrollSettingsText(ctx: BotContext, panel: Panel, s: PayrollSettings | null): string {
  const connected = ctx.payroll?.gateway.connected ?? false;
  const where =
    panel.profitSendTo === 'channel' && panel.profitChannelId
      ? `posted in <#${panel.profitChannelId}>`
      : s?.ownerId
        ? `sent to the DMs of <@${s.ownerId}> (the admin who last changed these settings)`
        : 'sent to the DMs of the admin who sets this up';
  const who = panel.profitRoleId ? `that admin, and any member of <@&${panel.profitRoleId}>` : 'that admin only';
  return [
    `💷 **Paying pilots: ${plainText(panel.airlineName)}** is **${s?.enabled ? 'on' : 'off'}**.`,
    `• The pay comes out of account: ${s?.sourceAccount ? `\`${s.sourceAccount}\`` : '**not set** (`source-account:`)'}`,
    `• The pilots' accounts are read from: ${s?.infoSheetId && s.infoGid ? `[the Pilot Info tab](${sheetViewUrl({ id: s.infoSheetId, gid: s.infoGid })})` : '**not set** (`pilot-info:`, the link of that tab)'}`,
    `• Flights are paid from: ${s?.startDay != null ? `**${new Date(s.startDay).toISOString().slice(0, 10)}** on (earlier flights are never put on a list)` : '**not set**: the day it is switched on'}`,
    `• A list of what is due is made every day at **${runTimeText(s?.runAtMinute ?? 720)}**, ${where}. Who can work on it: ${who} (the same as for \`/setup profit\`).`,
    s?.lastRunDay != null ? `• The last list was made for ${ts(s.lastRunDay, 'D')}.` : '• No list has been made yet.',
    ctx.writeback?.enabledFor(panel)
      ? '• After a payment goes through, I tick **Pilot Paid** on its row in the sheet (only an empty box is ever ticked).'
      : "• After a payment goes through, **Pilot Paid** can't be ticked for you: writing to the sheet isn't switched on for this panel (`/setup writeback`), so the Pay result lists the rows to tick by hand.",
    connected ? '• The bank connection is **on**.' : "• ⚠️ **Paying isn't connected to Aeroconomy yet** (the bot has no access to the airline's bank account). You get the list and can check and amend it, but **Pay** stops there: nothing is sent and nothing is recorded as paid.",
    '• A payment is only ever made once: each has a unique ID that is kept, and the pay is taken from the sheet\'s Pilot Pay column. `/payroll run` makes a list now.',
  ].join('\n');
}

export const payrollCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('payroll')
    .setDescription('Server admins: pay pilots from the sheet, after checking the list')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('settings')
        .setDescription('Show how pilots are paid, or change it (nothing is paid by changing it)')
        .addStringOption((o) =>
          o
            .setName('enabled')
            .setDescription('Make a list of what is due every day')
            .addChoices({ name: 'On: make a list every day', value: 'on' }, { name: 'Off: only when I use /payroll run', value: 'off' }),
        )
        .addStringOption((o) => o.setName('source-account').setDescription("The airline's account the pay comes out of, like 9954-0000123").setMaxLength(40))
        .addStringOption((o) => o.setName('pilot-info').setDescription('The link of the Pilot Info tab (names, FsHub IDs, bank accounts)').setMaxLength(300))
        .addStringOption((o) => o.setName('start-from').setDescription('The first flight day to pay, like 2026-11-19 (earlier flights are never put on a list)').setMaxLength(10))
        .addStringOption((o) => o.setName('at').setDescription('The time of day (Zulu) the list is made, like 12:00').setMaxLength(5))
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('run')
        .setDescription('Make the list of what is due now, and send it to be checked (nothing is paid until Pay is pressed)')
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('history')
        .setDescription('The latest payments the bot has made or tried')
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    ),

  async execute(ctx, interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = requireAdmin(interaction);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const panel = pickPanel(ctx, guildId, interaction.options.getString('airline'));
    const payroll = ctx.payroll;
    if (!payroll) throw new UserError('Paying pilots is not available in this copy of the bot.');
    const settings = ctx.store.getPayrollSettings(panel.id);

    switch (sub) {
      case 'settings': {
        const enabled = interaction.options.getString('enabled');
        const source = interaction.options.getString('source-account');
        const info = interaction.options.getString('pilot-info');
        const from = interaction.options.getString('start-from');
        const at = interaction.options.getString('at');
        if (enabled === null && source === null && info === null && from === null && at === null) {
          await interaction.editReply({ content: payrollSettingsText(ctx, panel, settings), allowedMentions: noPings });
          return;
        }
        // Everything is checked before anything is saved, so a mistake in one saves none of it.
        const patch: Partial<Omit<PayrollSettings, 'panelId'>> = {};
        if (enabled !== null && enabled !== 'on' && enabled !== 'off') throw new UserError('Choose on or off.');
        if (source !== null) {
          const account = cleanAccount(source);
          if (!isAccount(account)) throw new UserError("That isn't an account number. It looks like `9954-0000123`.");
          patch.sourceAccount = account;
        }
        if (info !== null) {
          const ref = parseSheetUrl(info);
          if (!ref) throw new UserError("That isn't a Google Sheets link. Open the Pilot Info tab and copy the link from the address bar.");
          if (!ref.gid) throw new UserError('That link does not say which tab. Open the Pilot Info tab in Google Sheets and copy the link from the address bar: it ends with `#gid=` and a number.');
          const own = sheetRefOf(panel);
          if (own && own.id === ref.id && (own.gid ?? '0') === ref.gid) throw new UserError("That is the schedule's own tab. I need the link of the Pilot Info tab.");
          patch.infoSheetId = ref.id;
          patch.infoGid = ref.gid;
        }
        if (from !== null) {
          const day = parseDay(from);
          if (day === null) throw new UserError('Write the first day to pay as year-month-day, like `2026-11-19`.');
          patch.startDay = day;
        }
        if (at !== null) {
          const minute = parseTimeOfDay(at);
          if (minute === null) throw new UserError('Write the time of day (Zulu) like `12:00`.');
          patch.runAtMinute = minute;
        }
        if (enabled !== null) {
          patch.enabled = enabled === 'on';
          if (enabled === 'on') {
            const missing = [
              ...((patch.sourceAccount ?? settings?.sourceAccount) ? [] : ['`source-account`']),
              ...(((patch.infoSheetId ?? settings?.infoSheetId) && (patch.infoGid ?? settings?.infoGid)) ? [] : ['`pilot-info`']),
            ];
            if (missing.length > 0) throw new UserError(`Before switching it on, set ${missing.join(' and ')}.`);
            if (!sheetRefOf(panel)) throw new UserError("This panel doesn't read a Google Sheet, so there is no schedule to pay from.");
            // Nothing from before the day it is switched on is ever offered, unless an admin says to start earlier.
            if (patch.startDay === undefined && (settings?.startDay ?? null) === null) patch.startDay = Math.floor(ctx.now() / DAY) * DAY;
          }
        }
        patch.ownerId = interaction.user.id;
        const saved = ctx.store.savePayrollSettings(panel.id, patch);
        await interaction.editReply({ content: `Done. Nothing was paid.\n${payrollSettingsText(ctx, panel, saved)}`, allowedMentions: noPings });
        return;
      }

      case 'run': {
        if (!settings) throw new UserError('Set it up first with `/payroll settings`.');
        const draft = await payroll.prepare(panel, settings);
        if (draft.lines.length === 0) {
          await interaction.editReply({
            content: [
              `💷 **${plainText(panel.airlineName)}**: nothing is due to be paid right now.`,
              ...(draft.waiting > 0 ? [`⏳ ${draft.waiting} completed flight${draft.waiting === 1 ? ' has' : 's have'} no Pilot Pay yet.`] : []),
              ...(draft.unsettled > 0 ? [`⛔ ${draft.unsettled} earlier payment${draft.unsettled === 1 ? '' : 's'} never got an answer from the bank. Check ${draft.unsettled === 1 ? 'it' : 'them'} there.`] : []),
            ].join('\n'),
            allowedMentions: noPings,
          });
          return;
        }
        await sendList(ctx, panel, settings, draft, { askerId: interaction.user.id, interaction });
        return;
      }

      case 'history': {
        const rows = ctx.store.listLedger(panel.id, 12);
        if (rows.length === 0) {
          await interaction.editReply({ content: `💷 **${plainText(panel.airlineName)}**: no payment has been made or tried yet.`, allowedMentions: noPings });
          return;
        }
        const mark = { paid: '✅ paid', failed: '❌ refused', sending: '⛔ no answer' } as const;
        await interaction.editReply({
          content: [
            `💷 **${plainText(panel.airlineName)}**: the latest payments`,
            ...rows.map((r) => `• ${mark[r.status]} · ${plainText(truncate(r.pilot, 30))} · ${dollarsText(r.cents)} · \`${r.uniqueId}\` · ${ts(r.updatedAt, 'f')}${r.status !== 'paid' && r.detail ? ` · ${truncate(r.detail, 80)}` : ''}`),
          ].join('\n'),
          allowedMentions: noPings,
        });
        return;
      }
    }
  },

  async autocomplete(ctx, interaction: AutocompleteInteraction) {
    const q = interaction.options.getFocused().trim().toLowerCase();
    const panels = interaction.guildId ? ctx.store.listPanels(interaction.guildId) : [];
    await interaction.respond(
      panels
        .filter((p) => !q || p.airlineName.toLowerCase().includes(q) || p.airlineAbbr?.toLowerCase().includes(q) || p.prefix.toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ name: truncate(airlineLabel({ name: p.airlineName, abbr: p.airlineAbbr }), 100), value: truncate(p.prefix, 100) })),
    );
  },
};
