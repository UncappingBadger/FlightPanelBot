import { InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../context.js';
import { requireGuild } from '../guard.js';
import { noPings } from '../ui.js';
import { setupCommand } from './setup.js';

/** What `/setup settings` answers: everything that was a `/setup` command is set on the bot's settings page now. */
export const SETTINGS_POINTER = [
  "**Setting me up is done on my settings page, not here.** It is on the computer that runs me: right-click my tray icon (near the clock) and choose **Open settings**.",
  'There is a tab for each thing: adding a panel, who can reserve, the layout, the Google Sheet and importing flights, the FsHub roster, reminders, departure warnings, live tracking, profit and pay, landing safety, and the market and weather boards. Whoever runs the bot (usually the server owner) sets them there.',
  "Two things stay in Discord, so the people you trust with them need not reach that computer: `/setup refresh` (redraw a panel now) and `/setup id-add` (fix a pilot's FsHub ID), which members with a role you choose in the **Staff roles** tab can use.",
].join('\n');

/**
 * `/setup` as Discord has it: only the three parts a person may need without reaching the host's computer. Everything else that used to be a part of it (adding panels, linking the
 * sheet, FsHub, reminders, pay, the boards...) is a tab on the host's settings page, which runs the very same code (see `setupConsole.ts`).
 *
 * `execute` hands every part to the full command, so what was said and checked there is said and checked here, and `settings` only says where to go.
 */
export const setupSlimCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Server admins: where to set me up, refresh a panel, fix a pilot ID')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('settings').setDescription('Where to set up panels, flights, FsHub, pay and the boards (on my settings page)'))
    .addSubcommand((s) =>
      s
        .setName('refresh')
        .setDescription('Re-fetch flights now (when a panel has an automatic source) and redraw the panel')
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('id-add')
        .setDescription("Set a pilot's FsHub pilot ID in the bot (to fix a wrong one)")
        .addUserOption((o) => o.setName('user').setDescription('The pilot').setRequired(true))
        .addStringOption((o) => o.setName('id').setDescription('Their FsHub pilot ID, or a link to their FsHub profile').setRequired(true).setMaxLength(100)),
    ),

  async execute(ctx, interaction) {
    if (interaction.options.getSubcommand() === 'settings') {
      requireGuild(interaction);
      await interaction.reply({ content: SETTINGS_POINTER, flags: MessageFlags.Ephemeral, allowedMentions: noPings });
      return;
    }
    await setupCommand.execute(ctx, interaction);
  },

  autocomplete: (ctx, interaction) => setupCommand.autocomplete!(ctx, interaction),
};
