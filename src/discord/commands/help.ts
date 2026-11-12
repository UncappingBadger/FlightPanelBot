import { EmbedBuilder, InteractionContextType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { Command } from '../context.js';
import { COLORS, FOOTER } from '../ui.js';

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('How to reserve flights, and how admins set the bot up')
    .setContexts(InteractionContextType.Guild),

  async execute(_ctx, interaction) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.panel)
          .setTitle('✈️ Flight reservations')
          .setDescription('Your airline posts its open flights on a panel. Reserve one so everyone can see who is flying what.')
          .addFields(
            {
              name: 'Reserving a flight',
              value:
                '1. Press **Reserve** under the panel.\n2. I\'ll DM you. The first time, I\'ll ask for your **FsHub pilot ID** (the number in your profile address, fshub.io/pilot/**1234**/overview) so managers can match you to the airline\'s roster. Change it any time by DMing me `fshub <your ID>`.\n3. Reply with the flight ID shown on the panel (like `DMO-004`).\n4. If the flight has several legs, I\'ll ask whether you\'re flying all of them or only some.\n5. The panel then shows your name, and your FsHub ID, next to the flight.',
            },
            {
              name: 'Changing your mind',
              value: 'Press **My flights** under the panel to see what you hold and give flights back. Say `cancel` in the DM at any point to stop.',
            },
            {
              name: 'When you have flown it',
              value:
                "Press **Complete** under the panel, pick the flights you have flown and confirm. If your airline keeps its schedule in a Google Sheet and I'm set up to write to it, I'll put your name against the flight there and tick it off. If your name in that sheet isn't your Discord name, DM me `name <your name in the sheet>`.",
            },
            {
              name: 'Fuel prices',
              value:
                "Type `/fuel airport:EGLL` to see the current fuel prices at an airport, from AeroDAQ (Aeroconomy's in-game market, so the prices are game money). Add `share:True` to show everyone in the channel.",
            },
            {
              name: 'Server admins',
              value:
                '`/setup panel-add` name the airline and choose the channel for its panel, optionally with a role that may reserve\n`/setup panel-role` change that role\n`/setup sheet` read flights from your airline\'s Google Sheet schedule (every hour) · `/setup import` load flights from a CSV or JSON file instead (`/setup template` gives an example)\n`/setup reminders` choose who is pinged when a flight has no pilot 24 hours before it starts · `/setup writeback` check or switch off writing names and completions to the sheet\n`/setup market` show the AeroDAQ in-game market in a channel\n`/setup release` free someone\'s reservation · `/setup panels` · `/setup refresh` · `/setup panel-remove`\nOnly people with **Manage Server** can do these.',
            },
          )
          .setFooter({ text: FOOTER }),
      ],
    });
  },
};
