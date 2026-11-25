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
                '1. Press **Reserve** under the panel and I\'ll DM you, or skip the button and DM me the flight ID yourself (`reserve DMO-004`, or several: `DMO-004, DMO-007`).\n2. The first time, I\'ll ask for your **FsHub pilot ID** (the number in your profile address, fshub.io/pilot/**1234**/overview) so managers can match you to the airline\'s roster (if the airline\'s FsHub roster already lists your Discord account, I skip this). Change it any time by DMing me `fshub <your ID>`.\n3. If you pressed the button, reply with the flight ID shown on the panel.\n4. If the flight has several legs, I\'ll ask whether you\'re flying all of them or only some.\n5. The panel then shows your name, and your FsHub ID, next to the flight.',
            },
            {
              name: 'Finding a flight, or standing by',
              value:
                'Press **Search** under the panel and type where you want to fly from, to, a date and/or an aircraft type (airport codes like `EGLL`; `EG` finds every airport starting EG; dates like `tomorrow`, `sat`, `14 Nov`, in Zulu time; types like `A320`, and `B73` finds every B73x). I show the matching flights the panel lists. Press **Backup pilot** (or DM me `backup DMO-004`) with the ID of a flight that is already taken, to be its backup; I tell you if it is given back.',
            },
            {
              name: 'A list instead of cards',
              value:
                "Press **List view** under the panel and I'll post the panel as a plain list in your DMs, and keep it up to date there whenever the panel changes. **Stop updates** under the list ends it. `/hideunavailable` hides the flights that are already taken, and the completed ones, from your list and your searches (flights you hold stay); it only changes your view.",
            },
            {
              name: 'If your server uses the button grid',
              value:
                'Each flight is a button: 🟡 open, 🔵 taken, 🟢 completed, ⚪ not open yet, with its aircraft, route, the date it opens (UTC) and who has it. Press one to see its card and ID (only you see it). **Collapse** and **Expand** fold a message for everyone; it unfolds after 10 minutes.',
            },
            {
              name: 'What your flights made',
              value:
                "DM me `my contributions` to see what the flights you completed in the last 7 days made for the airline, worked out from your airline's Google Sheet (the Profit Made column). A flight a manager hasn't entered the profit for yet is named by ID, and the total is what I can see so far.",
            },
            {
              name: 'Changing your mind',
              value: 'Press **My flights** under the panel to see what you hold and give flights back, or DM me `flights`. Say `cancel` in the DM to stop. `/commands` (or `commands` in a DM) lists all I can do.',
            },
            {
              name: 'A heads-up before it is too late',
              value:
                "If you hold a flight (or are its backup), I DM you shortly before the latest time you could take off and still land inside its window, with the time I used for the flight and where it came from. I don't send it if FsHub's live feed shows you already flying; otherwise ignore it if you are. DM me `notifications` to switch it, or the completed-flight DM, off.",
            },
            {
              name: 'Landing times',
              value: "A flight in the air shows its expected landing time on its card. `/eta` lists them all, or one (`/eta flight:DMO-004`).",
            },
            {
              name: 'When you have flown it',
              value:
                "Press **Complete** under the panel. If your airline's panel is linked to FsHub, I check FsHub for your landing and complete the flights it shows you flew: there is nothing to pick, and a flight FsHub hasn't shown yet is left alone (it appears about a minute after landing). Otherwise you pick the flights you have flown and confirm. Where your airline keeps its schedule in a Google Sheet and I'm set up to write to it, I put your name against the flight there and tick it off; if your name in that sheet isn't your Discord name, DM me `name <your name in the sheet>`.",
            },
            {
              name: 'Weather reports (METAR)',
              value:
                "DM me `metar EGLL` (any airport code, up to 3 at once) and I fetch the current report from VATSIM and explain it in plain language. Paste a METAR after `metar`, or on its own, and I translate that instead.",
            },
            {
              name: 'Fuel prices',
              value:
                "Type `/fuel airport:EGLL` to see the current fuel prices at an airport, from AeroDAQ (Aeroconomy's in-game market, so the prices are game money). Add `share:True` to show everyone in the channel.",
            },
            {
              name: 'Server admins',
              value:
                'Setting me up is done on my **settings page**, not in Discord. It is on the computer that runs me: right-click my tray icon (near the clock) and choose **Open settings**.\nIt has a tab for each thing: adding a panel, who can reserve, the layout, days shown, completed flights, the Google Sheet, write-back, importing flights, flight numbers, the FsHub roster, live tracking, departure warnings, reminders, profit and pay, landing safety, and the market and weather boards. Whoever runs the bot (usually the server owner) sets them there.\nIn Discord, only these three stay: `/setup settings` (says where), `/setup refresh` (redraw a panel now) and `/setup id-add` (set a pilot\'s FsHub ID by hand). Members with a role chosen in the **Staff roles** tab can use the last two. Only people with **Manage Server**, or such a role, can use `/setup`.',
            },
          )
          .setFooter({ text: FOOTER }),
      ],
    });
  },
};
