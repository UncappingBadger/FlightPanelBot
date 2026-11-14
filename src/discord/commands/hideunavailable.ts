import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../context.js';
import { noPings } from '../ui.js';

/**
 * `/hideunavailable`: anyone can use it, and it only ever changes what that person sees. It hides the flights that are no longer
 * available to them (already taken by others, and the completed ones) from the places that are theirs alone: their list view in
 * their DMs, and their search results. The panel in the channel is one message everyone shares, so it cannot change for one person.
 */
export const hideUnavailableCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('hideunavailable')
    .setDescription('Hide flights that are already taken from your own list view and searches (only for you)')
    .setContexts(InteractionContextType.Guild)
    .addStringOption((o) =>
      o
        .setName('mode')
        .setDescription('Turn it on or off (leave empty to switch it)')
        .addChoices({ name: 'On: hide flights that are taken, and completed ones', value: 'on' }, { name: 'Off: show everything', value: 'off' }),
    ),

  async execute(ctx, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;
    const mode = interaction.options.getString('mode');
    const next = mode === 'on' ? true : mode === 'off' ? false : !ctx.store.getHideUnavailable(userId);
    ctx.store.setHideUnavailable(userId, next, ctx.now());

    // A list they already have is redrawn to match, in a moment.
    const lists = ctx.store.listFollowedPanelIds(userId);
    for (const panelId of lists) ctx.panels.refreshFollowers(panelId).catch((e) => ctx.log.warn(`Could not update the list kept for ${userId}`, e));
    const listLine = lists.length > 0 ? 'Your list view will update in a moment.' : next ? "You don't have a list view yet: press **List view** under the panel to get one that follows this." : '';

    await interaction.editReply({
      content: next
        ? [
            '🙈 **On.** Your list view and your searches now leave out flights that are already taken, and the completed ones, so you only see flights you could still take. Flights you hold, or are the backup for, stay.',
            listLine,
            "The panel in the channel looks the same for everyone, because Discord can't show one message differently to different people.",
            'Run `/hideunavailable` again to turn it off.',
          ]
            .filter(Boolean)
            .join('\n')
        : ['👀 **Off.** Your list view and your searches show everything again.', listLine].filter(Boolean).join('\n'),
      allowedMentions: noPings,
    });
  },
};
