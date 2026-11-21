import { InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../context.js';
import { commandsMessages, slashCommands, standingIn } from '../commandsList.js';
import { isAdmin, memberHasAnyRole, requireGuild } from '../guard.js';
import { noPings } from '../ui.js';

/** `/commands`: everything the person can do with the bot at their level in this server (the same list `commands` gives in a DM, for the servers they share with it). */
export const commandsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('commands')
    .setDescription('List what you can do with me, for your permission level in this server')
    .setContexts(InteractionContextType.Guild),

  async execute(ctx, interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = requireGuild(interaction);
    const standing = standingIn(
      ctx,
      guildId,
      interaction.guild?.name ?? 'this server',
      isAdmin(interaction),
      (id) => memberHasAnyRole(interaction, [id]),
      (id) => interaction.guild?.roles.cache.get(id)?.name ?? null,
    );
    const [first = '', ...rest] = commandsMessages([standing], await slashCommands(), { where: 'server' });
    await interaction.editReply({ content: first, allowedMentions: noPings });
    for (const text of rest) await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral, allowedMentions: noPings });
  },
};
