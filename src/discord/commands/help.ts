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
          .setDescription('Your airline posts its upcoming open flights on a panel (flights further off appear once they come within the period your admin has set, up to 7 days). Reserve one so everyone can see who is flying what.')
          .addFields(
            {
              name: 'Reserving a flight',
              value:
                '1. Press **Reserve** under the panel.\n2. I\'ll DM you. The first time, I\'ll ask for your **FsHub pilot ID** (the number in your profile address, fshub.io/pilot/**1234**/overview) so managers can match you to the airline\'s roster (if the airline\'s FsHub roster already lists your Discord account, I know it and skip this). Change it any time by DMing me `fshub <your ID>`.\n3. Reply with the flight ID shown on the panel (like `DMO-004`).\n4. If the flight has several legs, I\'ll ask whether you\'re flying all of them or only some.\n5. The panel then shows your name, and your FsHub ID, next to the flight.',
            },
            {
              name: 'Changing your mind',
              value: 'Press **My flights** under the panel to see what you hold and give flights back. Say `cancel` in the DM at any point to stop.',
            },
            {
              name: 'When you have flown it',
              value:
                "Press **Complete** under the panel. If your airline's panel is linked to FsHub, I check FsHub for your landing and complete the flights it shows you flew: there is nothing to pick, and a flight FsHub hasn't shown yet is left alone (it appears about a minute after landing). Otherwise you pick the flights you have flown and confirm. Where your airline keeps its schedule in a Google Sheet and I'm set up to write to it, I put your name against the flight there and tick it off; if your name in that sheet isn't your Discord name, DM me `name <your name in the sheet>`. Completed flights are listed in a panel of their own below the open ones, and on a FsHub panel they also show the aircraft FsHub recorded. On a FsHub panel I also complete the flights FsHub shows you flew once an hour, and DM you, so you don't have to press anything.",
            },
            {
              name: 'Fuel prices',
              value:
                "Type `/fuel airport:EGLL` to see the current fuel prices at an airport, from AeroDAQ (Aeroconomy's in-game market, so the prices are game money). Add `share:True` to show everyone in the channel.",
            },
            {
              name: 'Server admins',
              value:
                '`/setup panel-add` name the airline and choose the channel for its panel, optionally with a role that may reserve\n`/setup panel-role` change that role\n`/setup sheet` read flights from your airline\'s Google Sheet schedule (every hour) · `/setup import` load flights from a CSV or JSON file instead (`/setup template` gives an example)\n`/setup window` choose how many days ahead the panel lists flights (1 to 7) · `/setup reminders` choose who is pinged when a flight has no pilot 24 hours before it starts · `/setup writeback` check or switch off writing names and completions to the sheet\n`/setup market` show the AeroDAQ in-game market in a channel · `/setup fshub` match pilots to their FsHub IDs, confirm completed flights, and complete flown flights every hour (`autocomplete:off` stops that) from your airline\'s FsHub\n`/setup release` free someone\'s reservation · `/setup panels` · `/setup refresh` · `/setup panel-remove`\nOnly people with **Manage Server** can do these.',
            },
          )
          .setFooter({ text: FOOTER }),
      ],
    });
  },
};
