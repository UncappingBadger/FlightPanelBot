import {
  AttachmentBuilder,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  SlashCommandBuilder,
  type AutocompleteInteraction,
} from 'discord.js';
import type { Panel, ReminderMode } from '../../db/store.js';
import { matchAirline, parseAirlineRef } from '../../fshub/airlineRef.js';
import { FsHubError, type FsHubAirline } from '../../fshub/client.js';
import { MAX_IMPORT_BYTES, parseJobsFile, sampleCsv } from '../../jobs/import.js';
import { parseSheetUrl, SheetJobSource } from '../../jobs/sheet.js';
import type { AutoCompleteResult } from '../../services/autoComplete.js';
import type { FlightSyncResult, RosterSyncResult } from '../../services/fshubSync.js';
import { defaultPrefix, PANEL_DAYS_MAX, PANEL_DAYS_MIN, panelHorizonMs } from '../../services/jobs.js';
import { airlineLabel, legList, plainText, truncate, ts } from '../../util/format.js';
import type { BotContext, Command } from '../context.js';
import { UserError } from '../errors.js';
import { requireAdmin } from '../guard.js';
import type { PanelRefreshResult } from '../panel.js';
import { noPings, reminderTarget } from '../ui.js';

const REQUIRED_CHANNEL_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
] as const;

const ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

/** What to tell an admin when the panel couldn't be drawn, or an empty string if it was. */
export function panelProblem(result: PanelRefreshResult): string {
  if (result === 'no-access') {
    return "⚠️ I couldn't post the panel: I can't see or write in that channel. I need View Channel, Send Messages, Embed Links and Read Message History there.";
  }
  if (result === 'failed') return "⚠️ I couldn't post the panel because of an unexpected error (it's in my log). Try `/setup refresh` in a moment.";
  return '';
}

/**
 * What to tell an admin about whether the bot writes to a panel's linked sheet. Checks that the bot
 * can open the sheet, since that is what a missing "share with the bot" step looks like.
 */
async function writebackNote(ctx: BotContext, panel: Panel): Promise<string> {
  if (!panel.sheetId) return '';
  if (!ctx.writeback) {
    return '• I only **read** the sheet and never change it. A name in its *Pilot* column shows on the panel as taken. Reservations made through me show on the panel only; copy them into the sheet yourselves. (To have pilots\' names and completions written back, see `docs/WRITEBACK_SETUP.md`.)';
  }
  if (!panel.writeback) {
    return '• I read the sheet and never change it, because write-back is switched **off** for this panel (`/setup writeback mode:on` turns it on).';
  }
  try {
    await ctx.writeback.check(panel);
    return "• ✅ **Write-back is on.** When a pilot reserves, gives back or completes a flight here, I write their name in the *Pilot* column and tick *Flight Completed* on that flight's row, and nothing else in the sheet.";
  } catch (e) {
    const why = e instanceof Error ? e.message : 'something went wrong';
    return `• ⚠️ Write-back is on, but I can't open the sheet yet: ${why} Share it with **${ctx.writeback.accountEmail}** as an *Editor*. Until then pilots can still reserve here, but the sheet won't change.`;
  }
}

/** A panel's FsHub roster link for the `/setup panels` list: empty if it has none. */
function fshubStatus(ctx: BotContext, panel: Panel): string {
  if (panel.fshubAirlineId === null) return '';
  const who = plainText(truncate(panel.fshubAirlineName ?? `#${panel.fshubAirlineId}`, 60));
  if (!ctx.fshub) return ` · FsHub roster: ${who} (no FsHub token saved, so it isn't being read)`;
  const roster = panel.fshubNote ? `${who} ⚠️ ${truncate(panel.fshubNote, 160)}` : `${who}${panel.fshubSyncedAt ? ` (read ${ts(panel.fshubSyncedAt, 'R')})` : ''}`;
  let flights: string;
  if (!panel.fshubConfirm) flights = 'off';
  else if (panel.fshubFlightsNote) flights = `⚠️ ${truncate(panel.fshubFlightsNote, 160)}`;
  else flights = `${ctx.store.countFshubFlights(panel.id)} kept${panel.fshubFlightsAt ? `, read ${ts(panel.fshubFlightsAt, 'R')}` : ''}`;
  const auto = !panel.fshubConfirm ? '' : !panel.fshubAutoComplete ? ' · auto-complete: off' : ` · auto-complete: hourly${panel.fshubAutoCompleteAt ? ` (checked ${ts(panel.fshubAutoCompleteAt, 'R')})` : ''}`;
  return ` · FsHub roster: ${roster} · FsHub flights: ${flights}${auto}`;
}

const NO_FSHUB_TOKEN =
  "I don't have a FsHub access token. Whoever runs this bot can add one on its setup page (tray icon → Open setup → *FsHub*): create it at fshub.io/settings/integrations. Then run this again.";

/** How a roster read went, in plain words for an admin. */
function rosterSummary(r: RosterSyncResult): string {
  const rest = r.rosterSize - r.withDiscord;
  return [
    `I read **${r.rosterSize}** pilot${r.rosterSize === 1 ? '' : 's'} from the roster.`,
    r.withDiscord > 0
      ? `**${r.withDiscord}** of them have told FsHub their Discord account, so I know who they are and won't ask them for a pilot ID${r.changed > 0 ? ` (${r.changed} new or updated just now)` : ''}.`
      : 'None of them has told FsHub their Discord account yet (a pilot adds it in their FsHub profile settings), so I can\'t match anyone automatically.',
    rest > 0 && r.withDiscord > 0 ? `The other ${rest} will be asked for their pilot ID the first time they reserve a flight.` : '',
    "An ID a pilot typed themselves is never replaced by the roster's.",
  ]
    .filter(Boolean)
    .join(' ');
}

/** How reading the airline's recent flights went, in plain words for an admin. */
function flightSummary(r: FlightSyncResult): string {
  if (!r.ok) return `⚠️ I couldn't read the airline's recent flights yet: ${r.note} I'll keep trying.`;
  return r.kept > 0
    ? `I also read the airline's recent FsHub flights (${r.kept} from the last week), so a completed flight shows the aircraft that was flown and that FsHub saw it land. Switch that off with \`/setup fshub confirm:off\`.`
    : "I also read the airline's recent FsHub flights; there are none from the last week yet. Switch that off with `/setup fshub confirm:off`.";
}

/** What the check that completes flown flights did, in plain words for an admin. */
function autoCompleteSummary(r: AutoCompleteResult): string {
  if (!r.ok) return `⚠️ I couldn't check the pilots' flights against FsHub: ${r.note}`;
  if (r.completed.length > 0) {
    const codes = r.completed.map((c) => `**${c.view.job.code}**`).join(', ');
    return `Auto-complete: I looked at ${r.checked} flight${r.checked === 1 ? '' : 's'} pilots hold and completed ${codes} (FsHub shows ${r.completed.length === 1 ? 'it' : 'them'} flown). I do this check every hour.`;
  }
  return r.checked > 0
    ? `Auto-complete: I looked at ${r.checked} flight${r.checked === 1 ? '' : 's'} pilots hold; none has been flown yet according to FsHub. I check every hour.`
    : 'Auto-complete: no pilot holds a flight that has started, so there was nothing to check. I check every hour.';
}

/**
 * `/setup fshub`: link a panel to its airline's FsHub roster, read it now, unlink it, or switch the reading of the
 * airline's flights (which confirms completed flights) on or off. Returns what to tell the admin.
 */
async function fshubSetup(ctx: BotContext, panelIn: Panel, rawLink: string | null, confirm: string | null, autoComplete: string | null = null): Promise<string> {
  let panel = panelIn;
  const link = rawLink?.trim() ?? '';
  const notes: string[] = [];

  if (autoComplete === 'on' || autoComplete === 'off') {
    ctx.store.updatePanel(panel.id, { fshubAutoComplete: autoComplete === 'on', ...(autoComplete === 'on' ? { fshubAutoCompleteAt: null } : {}) });
    panel = ctx.store.getPanel(panel.id) as Panel;
    ctx.panels.schedule(panel.id);
    notes.push(
      autoComplete === 'on'
        ? `Every hour I'll complete the flights FsHub shows pilots flew on the **${panel.airlineName}** panel, and tell each pilot in a DM. Pilots can still press **Complete** to do it at once.`
        : `I've stopped completing flights automatically on the **${panel.airlineName}** panel. Pilots can still press **Complete**, and FsHub's record still shows on completed flights.`,
    );
    if (!link && confirm !== 'on' && confirm !== 'off') {
      if (autoComplete === 'off' || !ctx.fshub || panel.fshubAirlineId === null || !panel.fshubConfirm) return notes.join('\n');
    }
  }

  if (confirm === 'on' || confirm === 'off') {
    ctx.store.updatePanel(panel.id, { fshubConfirm: confirm === 'on' });
    // Off means off: what was kept is deleted, and the panel stops showing what FsHub recorded.
    if (confirm === 'off') ctx.store.clearFshubFlights(panel.id);
    panel = ctx.store.getPanel(panel.id) as Panel;
    ctx.panels.schedule(panel.id);
    notes.push(
      confirm === 'on'
        ? `I'll read the airline's recent FsHub flights for the **${panel.airlineName}** panel, so completed flights show the aircraft that was flown.`
        : `I've stopped reading the airline's FsHub flights for the **${panel.airlineName}** panel and deleted the ones I had kept. Completed flights no longer show what FsHub recorded.`,
    );
    if (confirm === 'off' && !link) return notes.join('\n');
  }

  if (/^(none|off|remove|clear|unlink)$/i.test(link)) {
    ctx.store.updatePanel(panel.id, { fshubAirlineId: null, fshubAirlineName: null, fshubSyncedAt: null, fshubNote: null });
    ctx.store.clearFshubFlights(panel.id);
    ctx.panels.schedule(panel.id);
    return [...notes, `Stopped reading a FsHub roster and flights for the **${panel.airlineName}** panel. Pilots already matched keep their saved IDs.`].join('\n');
  }

  if (!ctx.fshub || !ctx.fshubSync) throw new UserError(NO_FSHUB_TOKEN);

  // No link given: read the roster (and flights) now, if the panel has one.
  if (!link) {
    if (panel.fshubAirlineId === null) {
      return [...notes, `The **${panel.airlineName}** panel isn't linked to a FsHub airline. Link it with \`/setup fshub link:\` and the airline's short name (for example \`SKY\`), its FsHub number, or the link to its page on fshub.io.`].join('\n');
    }
    const r = await ctx.fshubSync.syncPanel(panel);
    const who = plainText(truncate(panel.fshubAirlineName ?? `#${panel.fshubAirlineId}`, 60));
    if (!r.ok) return [...notes, `⚠️ **${who}** is linked, but I couldn't read its roster: ${r.note}`].join('\n');
    const f = panel.fshubConfirm ? await ctx.fshubSync.syncFlights(ctx.store.getPanel(panel.id) as Panel) : null;
    // Look at the pilots' flights now too, rather than leaving an admin to wait for the hourly check.
    const fresh = ctx.store.getPanel(panel.id) as Panel;
    const auto = f?.ok && ctx.autoComplete && fresh.fshubAutoComplete ? await ctx.autoComplete.runPanel(fresh) : null;
    return [...notes, `✅ **${who}** is linked to the **${panel.airlineName}** panel. ${rosterSummary(r)}`, f ? flightSummary(f) : '', auto ? autoCompleteSummary(auto) : ''].filter(Boolean).join('\n');
  }

  const ref = parseAirlineRef(link);
  if (!ref) throw new UserError("I couldn't tell which FsHub airline that is. Give its short name (like `SKY`), its FsHub number, or a link to its page on fshub.io.");

  let airline: FsHubAirline | null;
  try {
    if (ref.kind === 'id') {
      airline = await ctx.fshub.airline(ref.id);
      if (!airline) throw new UserError(`FsHub has no airline with the number **${ref.id}**.`);
    } else {
      // FsHub is asked by number, so a name is looked up among the airlines the saved token's own account belongs to.
      const mine = await ctx.fshub.myAirlines();
      airline = matchAirline(mine, ref.text);
      if (!airline) {
        const known = mine.map((a) => `${plainText(a.name)}${a.abbr ? ` (${plainText(a.abbr)})` : ''} — number ${a.id}`);
        throw new UserError(
          `The FsHub account behind my token doesn't belong to an airline called "${truncate(plainText(ref.text), 40)}".${known.length > 0 ? ` It belongs to: ${known.join('; ')}. Use one of those, or the airline's number.` : ' It doesn\'t belong to any airline, so give me the airline\'s number instead.'}`,
        );
      }
    }
  } catch (e) {
    if (e instanceof FsHubError) throw new UserError(e.message);
    throw e;
  }

  const before = { fshubAirlineId: panel.fshubAirlineId, fshubAirlineName: panel.fshubAirlineName, fshubSyncedAt: panel.fshubSyncedAt, fshubNote: panel.fshubNote };
  ctx.store.updatePanel(panel.id, { fshubAirlineId: airline.id, fshubAirlineName: airline.name, fshubSyncedAt: null, fshubNote: null });
  const r = await ctx.fshubSync.syncPanel(ctx.store.getPanel(panel.id) as Panel);
  if (!r.ok) {
    // Never leave a panel linked to a roster that can't be read; the admin can fix the cause and link it again.
    ctx.store.updatePanel(panel.id, before);
    throw new UserError(`I couldn't read the roster of **${fshubLabel(airline)}**: ${r.note}`);
  }
  // Flights kept for another airline are no use for this one.
  if (before.fshubAirlineId !== airline.id) ctx.store.clearFshubFlights(panel.id);
  const f = panel.fshubConfirm ? await ctx.fshubSync.syncFlights(ctx.store.getPanel(panel.id) as Panel) : null;
  return [
    ...notes,
    `✅ The **${panel.airlineName}** panel is linked to **${fshubLabel(airline)}** on FsHub. ${rosterSummary(r)} I read the roster again every hour; \`/setup fshub\` with no link reads it right now.`,
    f ? flightSummary(f) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** A FsHub airline as text for an admin: its name and short name, which come from outside and so are shown as plain text. */
const fshubLabel = (a: { name: string; abbr: string | null }) => `${plainText(truncate(a.name, 60))}${a.abbr ? ` (${plainText(a.abbr)})` : ''}`;

/** The longest an airline name can be. */
const MAX_AIRLINE_NAME = 60;

/** Tidy an airline name an admin typed: one line, no control characters, and no `@` (so it can never ping anyone). */
export function cleanAirlineName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2) throw new UserError('Type the airline\'s name (at least 2 characters), for example `Demo Air`.');
  if (name.length > MAX_AIRLINE_NAME) throw new UserError(`That name is too long. Keep it to ${MAX_AIRLINE_NAME} characters or fewer.`);
  if (name.includes('@')) throw new UserError("The airline name can't contain an @.");
  return name;
}

/** Which panel an admin means: by name, abbreviation or flight prefix, or the only one if there is just one. */
function pickPanel(ctx: BotContext, guildId: string, input: string | null): Panel {
  const panels = ctx.store.listPanels(guildId);
  if (panels.length === 0) throw new UserError('This server has no flight panel yet. Create one with `/setup panel-add`.');
  if (!input) {
    if (panels.length === 1) return panels[0] as Panel;
    throw new UserError(`This server has several panels, so say which one with the \`airline\` option: ${panels.map((p) => p.airlineName).join(', ')}.`);
  }
  const q = input.trim().toLowerCase();
  const match = panels.find((p) => p.prefix.toLowerCase() === q) ?? panels.find((p) => p.airlineName.toLowerCase() === q || p.airlineAbbr?.toLowerCase() === q);
  if (!match) throw new UserError(`I don't have a panel for "${truncate(input, 60)}" here. See \`/setup panels\`.`);
  return match;
}

export const setupCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Server admins: set up and manage flight panels')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s
        .setName('panel-add')
        .setDescription('Name the airline for this server and post its flight panel in a channel')
        .addStringOption((o) =>
          o
            .setName('airline')
            .setDescription('The airline\'s name as it should appear on the panel (pick an existing one to change its panel)')
            .setRequired(true)
            .setMaxLength(MAX_AIRLINE_NAME)
            .setAutocomplete(true),
        )
        .addChannelOption((o) =>
          o
            .setName('channel')
            .setDescription('Channel for the panel')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true),
        )
        .addStringOption((o) => o.setName('prefix').setDescription('Letters for flight IDs, e.g. DMO gives DMO-001 (default: made from the airline name)').setMinLength(2).setMaxLength(6))
        .addRoleOption((o) => o.setName('role').setDescription('Only members with this role can reserve (default: anyone who can see the channel)')),
    )
    .addSubcommand((s) =>
      s
        .setName('panel-role')
        .setDescription('Choose which role can reserve on a panel (leave the role empty to open it to everyone)')
        .addRoleOption((o) => o.setName('role').setDescription('The role that may reserve'))
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('panel-remove')
        .setDescription("Remove an airline's panel and all its flights and reservations")
        .addStringOption((o) => o.setName('airline').setDescription('Which panel').setRequired(true).setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('panels').setDescription("List this server's panels"))
    .addSubcommand((s) =>
      s
        .setName('import')
        .setDescription("Replace a panel's flights from a CSV or JSON file (see /setup template)")
        .addAttachmentOption((o) => o.setName('file').setDescription('CSV or JSON file of flights').setRequired(true))
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('sheet')
        .setDescription("Read a panel's flights from your airline's Google Sheet schedule (re-read every hour)")
        .addStringOption((o) =>
          o
            .setName('link')
            .setDescription('Link to the sheet tab, shared as "Anyone with the link can view". Type none to stop using a sheet.')
            .setRequired(true)
            .setMaxLength(400),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('writeback')
        .setDescription("Whether pilots' names and completions are written to the panel's Google Sheet (leave empty to check)")
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Turn writing to the sheet on or off')
            .addChoices({ name: 'On: write names and completions to the sheet', value: 'on' }, { name: 'Off: only read the sheet', value: 'off' }),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('fshub')
        .setDescription("Match pilots to their FsHub IDs from your airline's FsHub roster (leave empty to read it now)")
        .addStringOption((o) =>
          o
            .setName('link')
            .setDescription("The airline's FsHub short name (e.g. SKY), number or page link. Type none to stop.")
            .setMaxLength(200),
        )
        .addStringOption((o) =>
          o
            .setName('confirm')
            .setDescription("Show the aircraft flown on completed flights, from the airline's FsHub flights")
            .addChoices({ name: 'On: read the airline\'s FsHub flights and confirm completed ones', value: 'on' }, { name: 'Off: do not read flights', value: 'off' }),
        )
        .addStringOption((o) =>
          o
            .setName('autocomplete')
            .setDescription('Complete the flights FsHub shows pilots flew, once an hour, without anyone pressing Complete')
            .addChoices({ name: 'On: complete flown flights every hour', value: 'on' }, { name: 'Off: only when a pilot presses Complete', value: 'off' }),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('reminders')
        .setDescription('Who is pinged when a flight still has no pilot 24 hours before it starts')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Who to ping')
            .addChoices(
              { name: 'Auto: the role that can reserve, or @here if anyone can', value: 'auto' },
              { name: 'A role I choose (pick it in the role option)', value: 'role' },
              { name: 'Off: no reminders', value: 'off' },
            ),
        )
        .addRoleOption((o) => o.setName('role').setDescription('The role to ping'))
        .addStringOption((o) =>
          o
            .setName('cleanup')
            .setDescription('Delete each announcement at midnight (UTC) to keep the channel tidy')
            .addChoices({ name: 'On: delete announcements at midnight UTC (default)', value: 'on' }, { name: 'Off: leave them in the channel', value: 'off' }),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('window')
        .setDescription('Choose how many days ahead a panel lists flights (1 to 7)')
        .addIntegerOption((o) =>
          o
            .setName('days')
            .setDescription('List flights open now or starting within this many days (leave empty to see the setting)')
            .setMinValue(PANEL_DAYS_MIN)
            .setMaxValue(PANEL_DAYS_MAX),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('completed')
        .setDescription('Show completed flights in a channel of their own (leave empty to check)')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel for the completed flights').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addStringOption((o) =>
          o.setName('mode').setDescription('Put them back on the panel itself').addChoices({ name: 'Panel: show them on the panel, below the open flights (the default)', value: 'panel' }),
        )
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('market')
        .setDescription('Show the AeroDAQ in-game market in a channel, kept up to date (leave empty to check)')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Turn the market board on or off')
            .addChoices({ name: 'On: post the market board and keep it up to date', value: 'on' }, { name: 'Off: remove the board', value: 'off' }),
        )
        .addChannelOption((o) => o.setName('channel').setDescription('Channel for the board').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s
        .setName('refresh')
        .setDescription('Re-fetch flights now (when a panel has an automatic source) and redraw the panel')
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('release')
        .setDescription("Free someone's reservation on a flight (they are told)")
        .addStringOption((o) => o.setName('code').setDescription('Flight ID, e.g. DMO-004').setRequired(true).setMaxLength(20))
        .addIntegerOption((o) => o.setName('leg').setDescription('Only this leg (default: every leg)').setMinValue(1).setMaxValue(12))
        .addStringOption((o) => o.setName('airline').setDescription('Which panel (optional if there is only one)').setAutocomplete(true)),
    )
    .addSubcommand((s) => s.setName('template').setDescription('Get an example flights file to fill in')),

  async execute(ctx, interaction) {
    const guildId = requireAdmin(interaction);
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const airlineOpt = () => interaction.options.getString('airline');

    switch (sub) {
      case 'panel-add': {
        const guild = interaction.guild;
        if (!guild) throw new UserError('This only works inside a server.');
        const name = cleanAirlineName(interaction.options.getString('airline', true));

        const picked = interaction.options.getChannel('channel', true);
        const channel = await guild.channels.fetch(picked.id);
        if (!channel) throw new UserError("I can't see that channel.");
        const me = guild.members.me ?? (await guild.members.fetchMe());
        const perms = channel.permissionsFor(me);
        const missing = REQUIRED_CHANNEL_PERMS.filter((p) => !perms?.has(p));
        if (missing.length > 0) {
          throw new UserError(`I'm missing permissions in <#${channel.id}>: ${new PermissionsBitField(missing).toArray().join(', ')}. Grant those and run this again.`);
        }

        const requested = interaction.options.getString('prefix')?.trim().toUpperCase() ?? null;
        if (requested !== null && !/^[A-Z0-9]{2,6}$/.test(requested)) throw new UserError('The prefix can only use letters and numbers (2 to 6 characters).');
        const existing = ctx.store.getPanelByName(guildId, name);
        if (existing && requested && requested !== existing.prefix) {
          throw new UserError(`${existing.airlineName} already uses the prefix **${existing.prefix}**, and changing it would break the IDs people know. Remove the panel and add it again to start fresh.`);
        }
        const prefix = existing?.prefix ?? requested ?? defaultPrefix({ name, abbr: null });
        if (!existing && ctx.store.listPanels(guildId).some((p) => p.prefix === prefix)) {
          throw new UserError(`Another panel here already uses the prefix **${prefix}**. Choose a different one with the \`prefix\` option.`);
        }

        // A role given here sets it; leaving it out keeps what the panel already has. @everyone means "anyone".
        const pickedRole = interaction.options.getRole('role');
        const roleChange: string | null | undefined = pickedRole ? (pickedRole.id === guildId ? null : pickedRole.id) : undefined;

        let panel: Panel;
        if (existing) {
          if (existing.channelId !== channel.id) await ctx.panels.deleteMessages(existing);
          ctx.store.updatePanel(existing.id, {
            channelId: channel.id,
            ...(existing.channelId !== channel.id ? { messageIds: [], completedMessageIds: [] } : {}),
            ...(roleChange !== undefined ? { requiredRoleId: roleChange } : {}),
          });
          panel = ctx.store.getPanel(existing.id) as Panel;
        } else {
          panel = ctx.store.createPanel({ guildId, name, prefix, channelId: channel.id, requiredRoleId: roleChange ?? null, now: ctx.now() });
        }

        let listed = '';
        if (ctx.refresher.hasSource(panel)) {
          await ctx.refresher.refresh(panel);
          const n = ctx.jobs.open(panel.id).length;
          listed = ` It lists ${n} open flight${n === 1 ? '' : 's'}.`;
        }
        const result = await ctx.panels.refresh(panel.id);
        await interaction.editReply({
          content: [
            `✅ ${existing ? 'Updated' : 'Created'} the **${airlineLabel({ name: panel.airlineName, abbr: panel.airlineAbbr })}** panel in <#${channel.id}> (flight IDs look like \`${prefix}-001\`).${listed}`,
            panel.requiredRoleId ? `Only members with <@&${panel.requiredRoleId}> can reserve.` : 'Anyone who can see the channel can reserve (use `/setup panel-role` to require a role).',
            panelProblem(result),
            existing ? '' : `A flight with no pilot 24 hours before it starts will be announced in the channel, pinging ${reminderTarget(panel)?.text}, and the announcement is deleted at midnight UTC. Change that with \`/setup reminders\`.`,
            ctx.refresher.hasSource(panel)
              ? 'Flights refresh automatically every 24 hours.'
              : "Next: if your airline keeps its schedule in a Google Sheet, link it with `/setup sheet`. Otherwise get a file of flights with `/setup template`, fill it in, and load it with `/setup import`.",
          ]
            .filter(Boolean)
            .join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'panel-role': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const role = interaction.options.getRole('role');
        const roleId = role && role.id !== guildId ? role.id : null;
        ctx.store.updatePanel(panel.id, { requiredRoleId: roleId });
        const result = await ctx.panels.refresh(panel.id);
        await interaction.editReply({
          content: [
            roleId ? `✅ Only members with <@&${roleId}> can reserve on the **${panel.airlineName}** panel now (server admins always can).` : `✅ Anyone who can see the channel can reserve on the **${panel.airlineName}** panel now.`,
            panelProblem(result),
          ]
            .filter(Boolean)
            .join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'panel-remove': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        await ctx.panels.deleteMessages(panel);
        await ctx.panels.deleteReminderMessages(panel);
        await ctx.panels.deleteListMessages(panel);
        ctx.store.deletePanel(panel.id);
        await interaction.editReply({ content: `Removed the **${panel.airlineName}** panel, with its flights and reservations.` });
        return;
      }

      case 'panels': {
        const panels = ctx.store.listPanels(guildId);
        if (panels.length === 0) {
          await interaction.editReply({ content: 'No panels yet. Create one with `/setup panel-add`.' });
          return;
        }
        const lines = panels.map((p) => {
          const open = ctx.jobs.open(p.id);
          const legs = open.reduce((n, v) => n + v.legs.length, 0);
          const taken = open.reduce((n, v) => n + v.legs.filter((l) => l.holder).length, 0);
          const named = open.reduce((n, v) => n + v.legs.filter((l) => !l.holder && l.sheetHolder).length, 0);
          const updated = p.lastRefreshAt ? `updated ${ts(p.lastRefreshAt, 'R')}` : 'no flights loaded yet';
          const err = p.lastRefreshError ? ` ⚠️ last refresh failed: ${truncate(p.lastRefreshError, 80)}` : '';
          const note = p.lastRefreshNote ? `\n   ↳ ⚠️ ${truncate(p.lastRefreshNote, 300)}` : '';
          const who = p.requiredRoleId ? `role <@&${p.requiredRoleId}>` : 'anyone with channel access';
          const from = p.sheetId ? 'Google Sheet' : ctx.refresher.hasSource(p) ? 'automatic' : 'file import';
          const ping = reminderTarget(p)?.text ?? 'off';
          const writes = !p.sheetId ? '' : !ctx.writeback ? ' · sheet write-back: unavailable' : ` · sheet write-back: ${p.writeback ? 'on' : 'off'}`;
          return `• **${airlineLabel({ name: p.airlineName, abbr: p.airlineAbbr })}** in <#${p.channelId}> · \`${p.prefix}-…\` · flights from: ${from} · reserving: ${who} · ${open.length} open flights, ${taken}/${legs} legs reserved${named > 0 ? `, ${named} named in the sheet` : ''} · panel shows the next ${p.showDays} day${p.showDays === 1 ? '' : 's'} · completed flights: ${p.completedChannelId ? `in <#${p.completedChannelId}>` : 'on the panel'} · pilot reminders: ${ping}${writes}${fshubStatus(ctx, p)} · ${updated}${err}${note}`;
        });
        await interaction.editReply({ content: lines.join('\n'), allowedMentions: noPings });
        return;
      }

      case 'import': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        if (panel.sheetId) {
          throw new UserError(`The **${panel.airlineName}** panel reads its flights from a Google Sheet, and a file import would be overwritten by the next refresh. To use a file instead, run \`/setup sheet link:none\` first.`);
        }
        const file = interaction.options.getAttachment('file', true);
        if (file.size > MAX_IMPORT_BYTES) throw new UserError(`That file is larger than ${MAX_IMPORT_BYTES / 1024} KB.`);
        let host = '';
        try {
          host = new URL(file.url).hostname;
        } catch {
          /* handled below */
        }
        if (!ATTACHMENT_HOSTS.has(host)) throw new UserError('Please attach the file directly to the command (I only read files uploaded to Discord).');

        const res = await ctx.fetchFn(file.url, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
        if (!res || !res.ok) throw new UserError("I couldn't download that file. Try uploading it again.");
        const jobs = parseJobsFile(await res.text(), file.name ?? 'jobs.csv');

        const r = ctx.jobs.sync(panel.id, jobs);
        ctx.store.updatePanel(panel.id, { lastRefreshAt: ctx.now(), lastRefreshError: null, lastRefreshNote: null });
        await ctx.panels.refresh(panel.id);
        await interaction.editReply({
          content: [
            `✅ Imported **${jobs.length}** flights into the **${panel.airlineName}** panel: ${r.added} new, ${r.updated} changed, ${r.removed} closed (no longer in the file).`,
            r.released.length > 0 ? `${r.released.length} pilot${r.released.length === 1 ? ' was' : 's were'} told their reservation was released because a flight changed or was removed.` : '',
            'Flights not in the file are closed, so import the full list each time. Flights keep their IDs when their `id` stays the same.',
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return;
      }

      case 'sheet': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const raw = interaction.options.getString('link', true).trim();

        if (/^(none|off|remove|clear|unlink)$/i.test(raw)) {
          ctx.store.updatePanel(panel.id, { sheetId: null, sheetGid: null, lastRefreshNote: null });
          await interaction.editReply({ content: `Stopped reading a sheet for the **${panel.airlineName}** panel. It keeps the flights it has; load new ones with \`/setup import\`.` });
          return;
        }

        const ref = parseSheetUrl(raw);
        if (!ref) {
          throw new UserError("That isn't a Google Sheets link. Open the sheet, then copy the address from your browser; it starts with `https://docs.google.com/spreadsheets/d/`.");
        }
        // Read it before saving anything, so a bad link or an unshared sheet is reported straight away.
        await new SheetJobSource(ref, ctx.fetchFn).fetch({ name: panel.airlineName, abbr: panel.airlineAbbr }, ctx.now());

        ctx.store.updatePanel(panel.id, { sheetId: ref.id, sheetGid: ref.gid, lastRefreshNote: null });
        const linked = ctx.store.getPanel(panel.id) as Panel;
        const r = await ctx.refresher.refresh(linked);
        const result = await ctx.panels.refresh(panel.id);
        const open = ctx.jobs.open(panel.id).length;
        await interaction.editReply({
          content: [
            `✅ The **${panel.airlineName}** panel now reads its flights from your sheet: ${open} open flight${open === 1 ? '' : 's'} (${r.added} new, ${r.updated} changed, ${r.removed} closed${r.completed > 0 ? `, ${r.completed} shown as completed` : ''}). It is read again every hour, or on \`/setup refresh\`.`,
            await writebackNote(ctx, linked),
            '• Windows are read as Zulu (UTC) and shown in each pilot\'s own timezone. A row with *Flight Completed* ticked is shown on the panel as ✅ completed for a day, then dropped. Cancelled rows are left off.',
            r.warnings.length > 0 ? `⚠️ I skipped or guessed at some rows:\n${r.warnings.map((w) => `  • ${w}`).join('\n')}` : '',
            r.released.length > 0 ? `${r.released.length} pilot${r.released.length === 1 ? ' was' : 's were'} told their reservation was released because a flight changed or was removed.` : '',
            panelProblem(result),
          ]
            .filter(Boolean)
            .join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'writeback': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const mode = interaction.options.getString('mode');
        if (mode === 'on' || mode === 'off') ctx.store.updatePanel(panel.id, { writeback: mode === 'on' });
        const current = ctx.store.getPanel(panel.id) as Panel;

        let status: string;
        if (!current.sheetId) status = 'This panel has no Google Sheet linked, so there is nothing to write to. Link one with `/setup sheet`.';
        else if (!ctx.writeback) {
          status = `This bot has no Google credentials, so it can only read the sheet. To let it write, follow \`docs/WRITEBACK_SETUP.md\`${current.writeback ? '' : ' (the setting here is off as well)'}.`;
        } else status = (await writebackNote(ctx, current)).replace(/^• /, '');
        await interaction.editReply({
          content: [`**${panel.airlineName}** write-back is **${current.writeback ? 'on' : 'off'}**.`, status].join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'fshub': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        await interaction.editReply({
          content: await fshubSetup(ctx, panel, interaction.options.getString('link'), interaction.options.getString('confirm'), interaction.options.getString('autocomplete')),
          allowedMentions: noPings,
        });
        return;
      }

      case 'reminders': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const mode = interaction.options.getString('mode') as ReminderMode | null;
        const role = interaction.options.getRole('role');
        if (role && role.id === guildId) throw new UserError('Pick a specific role. To ping everyone online, use the **Auto** mode on a panel that anyone can reserve on.');
        if (role && (mode === 'auto' || mode === 'off')) throw new UserError('A role only applies to the "A role I choose" mode. Leave the mode empty, or choose that one.');

        let current = panel;
        if (mode !== null || role) {
          const next: ReminderMode = mode ?? 'role';
          if (next === 'role' && !role && !panel.reminderRoleId) throw new UserError('Choose which role to ping with the `role` option.');
          ctx.store.updatePanel(panel.id, { reminderMode: next, ...(role ? { reminderRoleId: role.id } : {}) });
          current = ctx.store.getPanel(panel.id) as Panel;
        }
        const cleanup = interaction.options.getString('cleanup');
        if (cleanup === 'on' || cleanup === 'off') {
          ctx.store.updatePanel(panel.id, { reminderCleanup: cleanup === 'on' });
          current = ctx.store.getPanel(panel.id) as Panel;
        }

        const target = reminderTarget(current);
        let warning = '';
        if (target) {
          const channel = await interaction.guild?.channels.fetch(current.channelId).catch(() => null);
          const me = interaction.guild?.members.me ?? (await interaction.guild?.members.fetchMe().catch(() => null));
          const canPing = Boolean(me && channel?.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone));
          const pinged = target.allowed.roles?.[0];
          const pingedRole = pinged ? await interaction.guild?.roles?.fetch(pinged).catch(() => null) : null;
          const mentionable = pingedRole ? pingedRole.mentionable : true;
          if (!canPing && target.text === '@here') {
            warning = `⚠️ I don't have the **Mention Everyone** permission in <#${current.channelId}>, so an @here would appear without notifying anyone. Grant it, or pick a role.`;
          } else if (!canPing && !mentionable) {
            warning = `⚠️ That role isn't mentionable and I don't have **Mention Everyone** in <#${current.channelId}>, so it may not notify anyone. Make the role mentionable, or grant me the permission.`;
          }
        }

        const who =
          current.reminderMode === 'off'
            ? 'Off. Flights without a pilot are not announced.'
            : `A flight with no pilot 24 hours before it starts is announced in <#${current.channelId}> once, pinging ${target?.text}.`;
        const tidy =
          current.reminderMode === 'off'
            ? ''
            : current.reminderCleanup
              ? 'Each announcement is deleted at midnight UTC, so the channel stays tidy (`/setup reminders cleanup:off` keeps them).'
              : 'Announcements stay in the channel until someone deletes them (`/setup reminders cleanup:on` clears them at midnight UTC).';
        await interaction.editReply({
          content: [`**${panel.airlineName}** reminders: ${who}`, tidy, warning].filter(Boolean).join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'window': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const days = interaction.options.getInteger('days');
        let current = panel;
        if (days !== null) {
          if (!Number.isInteger(days) || days < PANEL_DAYS_MIN || days > PANEL_DAYS_MAX) throw new UserError(`Choose a number of days from ${PANEL_DAYS_MIN} to ${PANEL_DAYS_MAX}.`);
          ctx.store.updatePanel(panel.id, { showDays: days });
          current = ctx.store.getPanel(panel.id) as Panel;
          ctx.panels.schedule(panel.id); // the panel redraws with the new period
        }
        const span = `${current.showDays} day${current.showDays === 1 ? '' : 's'}`;
        const now = ctx.now();
        const horizon = panelHorizonMs(current.showDays);
        const later = ctx.jobs.open(current.id).filter((v) => v.job.availableFrom !== null && v.job.availableFrom > now + horizon).length;
        await interaction.editReply({
          content: [
            `${days !== null ? 'Done. ' : ''}The **${panel.airlineName}** panel lists the flights that are open now or start within the next **${span}**.`,
            later > 0
              ? `${later} open flight${later === 1 ? ' starts' : 's start'} later than that and ${later === 1 ? 'is' : 'are'} left off the panel until ${later === 1 ? 'it comes' : 'they come'} within ${span}. Pilots can still reserve ${later === 1 ? 'it' : 'one'} by typing its flight ID.`
              : 'Every open flight is listed.',
            `Change it with \`/setup window days:\` (${PANEL_DAYS_MIN} to ${PANEL_DAYS_MAX}).`,
          ].join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'completed': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const mode = interaction.options.getString('mode');
        const picked = interaction.options.getChannel('channel');
        const name = `**${panel.airlineName}**`;
        if (mode === 'panel' && picked) throw new UserError('Choose a channel, or `panel` to show completed flights on the panel itself, but not both.');

        if (mode === 'panel') {
          if (panel.completedChannelId === null) {
            await interaction.editReply({ content: `The completed flights of ${name} are already shown on the panel itself, below the open flights.` });
            return;
          }
          const was = panel.completedChannelId;
          await ctx.panels.deleteCompletedMessages(panel);
          ctx.store.updatePanel(panel.id, { completedChannelId: null });
          const result = await ctx.panels.refresh(panel.id);
          await interaction.editReply({
            content: [`✅ The completed flights of ${name} are back on the panel, below the open flights, and the ones in <#${was}> are gone.`, panelProblem(result)].filter(Boolean).join('\n'),
            allowedMentions: noPings,
          });
          return;
        }

        if (picked) {
          const guild = interaction.guild;
          if (!guild) throw new UserError('This only works inside a server.');
          if (picked.id === panel.channelId) {
            throw new UserError(`<#${picked.id}> is where the ${name} panel is. To keep completed flights on the panel, use \`/setup completed mode:panel\`; for a channel of their own, choose a different one.`);
          }
          const channel = await guild.channels.fetch(picked.id);
          if (!channel) throw new UserError("I can't see that channel.");
          const me = guild.members.me ?? (await guild.members.fetchMe());
          const perms = channel.permissionsFor(me);
          const missing = REQUIRED_CHANNEL_PERMS.filter((p) => !perms?.has(p));
          if (missing.length > 0) {
            throw new UserError(`I'm missing permissions in <#${channel.id}>: ${new PermissionsBitField(missing).toArray().join(', ')}. Grant those and run this again.`);
          }
          // Moving them from one channel to another: the old messages go, and the new channel gets the whole board.
          if (panel.completedChannelId !== null && panel.completedChannelId !== channel.id) await ctx.panels.deleteCompletedMessages(panel);
          ctx.store.updatePanel(panel.id, { completedChannelId: channel.id });
          const result = await ctx.panels.refresh(panel.id);
          await interaction.editReply({
            content: [
              `✅ The completed flights of ${name} are now posted in <#${channel.id}>, and the panel in <#${panel.channelId}> lists only the flights that can still be flown. They stay up for 24 hours after they are completed, as before.`,
              "A pilot's own list (the **List view** button) leaves them out too. Put them back on the panel with `/setup completed mode:panel`.",
              panelProblem(result),
            ]
              .filter(Boolean)
              .join('\n'),
            allowedMentions: noPings,
          });
          return;
        }

        await interaction.editReply({
          content:
            panel.completedChannelId !== null
              ? `The completed flights of ${name} are posted in <#${panel.completedChannelId}>. Change the channel with \`/setup completed channel:\`, or put them back on the panel with \`/setup completed mode:panel\`.`
              : `The completed flights of ${name} are shown on the panel itself, below the open flights. To give them a channel of their own and keep the panel shorter, use \`/setup completed channel:\`.`,
          allowedMentions: noPings,
        });
        return;
      }

      case 'market': {
        const mode = interaction.options.getString('mode');
        const picked = interaction.options.getChannel('channel');
        const board = ctx.store.getMarketBoard(guildId);

        if (mode === 'off') {
          if (!board) {
            await interaction.editReply({ content: 'The AeroDAQ market board is already off.' });
            return;
          }
          await ctx.market.deleteMessages(board);
          ctx.store.deleteMarketBoard(guildId);
          await interaction.editReply({ content: 'Removed the AeroDAQ market board. Turn it back on with `/setup market mode:on`.' });
          return;
        }

        if (mode === 'on' || picked) {
          const guild = interaction.guild;
          if (!guild) throw new UserError('This only works inside a server.');
          const channelId = picked?.id ?? board?.channelId;
          if (!channelId) throw new UserError('Choose the channel for the board with the `channel` option.');
          const channel = await guild.channels.fetch(channelId);
          if (!channel) throw new UserError("I can't see that channel.");
          const me = guild.members.me ?? (await guild.members.fetchMe());
          const perms = channel.permissionsFor(me);
          const missing = REQUIRED_CHANNEL_PERMS.filter((p) => !perms?.has(p));
          if (missing.length > 0) {
            throw new UserError(`I'm missing permissions in <#${channel.id}>: ${new PermissionsBitField(missing).toArray().join(', ')}. Grant those and run this again.`);
          }
          if (board && board.channelId !== channel.id) await ctx.market.deleteMessages(board);
          ctx.store.setMarketBoard(guildId, channel.id, ctx.now());

          const result = await ctx.market.refresh(guildId);
          let line: string;
          if (result === 'updated' || result === 'posted') {
            line = `✅ The AeroDAQ market board is in <#${channel.id}>. I redraw it every 15 minutes. Turn it off with \`/setup market mode:off\`.`;
          } else if (result === 'unavailable') {
            line = `⚠️ I couldn't get the market from AeroDAQ just now (${ctx.store.getMarketBoard(guildId)?.lastError ?? 'no answer'}). The board will appear in <#${channel.id}> once it answers; I try again every 15 minutes.`;
          } else if (result === 'no-access') {
            line = `⚠️ I couldn't post in <#${channel.id}>: ${ctx.store.getMarketBoard(guildId)?.lastError ?? 'no access'} I need View Channel, Send Messages, Embed Links and Read Message History there.`;
          } else {
            line = "⚠️ I couldn't draw the board because of an unexpected error (it's in my log). It will be tried again in 15 minutes.";
          }
          await interaction.editReply({
            content: [line, "This is AeroDAQ's *in-game* market, not real stocks or money. Pilots can also look up fuel prices with `/fuel`."].join('\n'),
            allowedMentions: noPings,
          });
          return;
        }

        // Nothing to change: say how it stands.
        if (!board) {
          await interaction.editReply({ content: 'The AeroDAQ market board is **off**. Turn it on with `/setup market mode:on channel:#your-channel`.' });
          return;
        }
        await interaction.editReply({
          content: [
            `The AeroDAQ market board is **on** in <#${board.channelId}>${board.lastOkAt ? `, last drawn ${ts(board.lastOkAt, 'R')}` : ', not drawn yet'}. It is redrawn every 15 minutes.`,
            board.lastError ? `⚠️ The last try failed: ${board.lastError}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          allowedMentions: noPings,
        });
        return;
      }

      case 'refresh': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        let note = '';
        if (ctx.refresher.hasSource(panel)) {
          const r = await ctx.refresher.refresh(panel);
          note = ` Fetched: ${r.added} new, ${r.updated} changed, ${r.removed} closed${r.completed > 0 ? `, ${r.completed} newly completed` : ''}.`;
          if (r.warnings.length > 0) note += `\n⚠️ ${r.warnings.join('; ')}`;
        } else {
          ctx.jobs.expireDue();
          note = ' (This panel takes flights from `/setup import`, so there is nothing to fetch.)';
        }
        // Always a full redraw: every message is sent again, so a panel posted by an older version picks up whatever is new
        // (new buttons, a new look) from this, with no need to remove and re-add it.
        const result = await ctx.panels.refresh(panel.id, { force: true });
        const problem = panelProblem(result);
        await interaction.editReply({ content: problem ? `${problem}${note}` : `Redrew the **${panel.airlineName}** panel (${result}).${note}` });
        return;
      }

      case 'release': {
        const panel = pickPanel(ctx, guildId, airlineOpt());
        const code = interaction.options.getString('code', true);
        const leg = interaction.options.getInteger('leg') ?? undefined;
        // Note the names the bot wrote in the sheet for these reservations, so they can be taken off again.
        const before = ctx.jobs.findByCode(panel, code);
        const written = (before?.legs ?? []).filter((l) => (leg === undefined || l.legNo === leg) && l.holder?.sheetName).map((l) => l.holder!.sheetName as string);
        const notices = ctx.jobs.adminRelease(panel, code, leg);
        let sheetNote = '';
        if (notices.length > 0 && before && written.length > 0 && ctx.writeback?.enabledFor(panel)) {
          let cleared = 0;
          for (const name of written) {
            try {
              if (await ctx.writeback.unclaim(panel, before.job.sourceKey, name)) cleared++;
            } catch (e) {
              ctx.log.warn(`Could not take ${name} off the sheet: ${e instanceof Error ? e.message : e}`);
              sheetNote = " ⚠️ I couldn't take their name off the airline's sheet, so you'll need to.";
            }
          }
          if (cleared > 0 && !sheetNote) sheetNote = " I've taken their name off the airline's sheet too.";
        }
        await interaction.editReply({
          content: notices.length === 0 ? `Nobody holds ${leg ? `leg ${leg} of ` : ''}${code.toUpperCase()}.` : `Released ${notices.map((n) => `<@${n.discordId}> (leg${n.legNos.length > 1 ? 's' : ''} ${legList(n.legNos)})`).join(', ')} on ${code.toUpperCase()}. They have been told.${sheetNote}`,
          allowedMentions: noPings,
        });
        return;
      }

      case 'template': {
        const csv = sampleCsv(ctx.now());
        await interaction.editReply({
          content: [
            "Here's an example. Columns (only `legs` is required):",
            '• `id`: your own reference for the flight (keeps its bot ID when you re-import)',
            '• `legs`: airports in order, e.g. `EGLL-EGKK-EGCC` is two legs',
            '• `aircraft`: required airframe · `from` and `deadline`: UTC times, e.g. `2026-11-12 18:30` · `pay`, `notes`, `title`: optional',
            'JSON works too: a list of objects with the same fields. Import the full list each time; flights missing from it are closed.',
          ].join('\n'),
          files: [new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: 'sample-flights.csv' })],
        });
        return;
      }
    }
  },

  async autocomplete(ctx, interaction: AutocompleteInteraction) {
    const q = interaction.options.getFocused().trim().toLowerCase();
    // Every `airline` option offers this server's own panels. (For panel-add you can also just type a new name.)
    const panels = interaction.guildId ? ctx.store.listPanels(interaction.guildId) : [];
    const forAdd = interaction.options.getSubcommand(false) === 'panel-add';
    await interaction.respond(
      panels
        .filter((p) => !q || p.airlineName.toLowerCase().includes(q) || p.airlineAbbr?.toLowerCase().includes(q) || p.prefix.toLowerCase().includes(q))
        .slice(0, 25)
        .map((p) => ({ name: truncate(airlineLabel({ name: p.airlineName, abbr: p.airlineAbbr }), 100), value: truncate(forAdd ? p.airlineName : p.prefix, 100) })),
    );
  },
};
