import { MessageFlags, type Client, type ModalSubmitInteraction } from 'discord.js';
import type { Store, WeatherBoard } from '../db/store.js';
import { MetarError, type MetarClient } from '../metar/client.js';
import {
  DEFAULT_WEATHER_AIRPORTS,
  flightAirports,
  flightsInWindow,
  MAX_BOARD_FLIGHTS,
  MAX_FLIGHT_AIRPORTS,
  parseAirportList,
} from '../services/weatherAirports.js';
import { silentLogger, type Logger } from '../util/log.js';
import type { BotContext, ComponentHandler } from './context.js';
import { isMissingAccess, isUnknownMessage, UserError } from './errors.js';
import { noPings } from './ui.js';
import { metarBlocks, renderWeather, searchModal, WEATHER_FOOTER, weatherButtons } from './weatherUi.js';

/**
 * - `updated`: edited the existing messages in place
 * - `posted`: (re)posted the board
 * - `unavailable`: VATSIM could not be asked; the board keeps what it last showed
 * - `no-access`: the channel is gone or the bot can't see or write in it
 * - `failed`: something else went wrong (details are in the log)
 */
export type WeatherRefreshResult = 'updated' | 'posted' | 'unavailable' | 'no-access' | 'failed' | 'skipped';

/** How often a board is redrawn: VATSIM's weather service asks that an answer be kept for ten minutes, so there is nothing newer to show sooner. */
export const WEATHER_REFRESH_MS = 10 * 60_000;
/** A redraw asks for reports younger than this, so the one it would reuse is never the one from its own previous redraw. */
const FRESH_ENOUGH_MS = WEATHER_REFRESH_MS - 60_000;
/** How many reports are asked for at once. */
const CONCURRENCY = 4;
/** A search by one person, and how many airports it may name. */
export const SEARCH_COOLDOWN_MS = 3_000;
export const MAX_SEARCH_AIRPORTS = 5;

/** What the board says for an airport that VATSIM has no report for, or whose report could not be read. */
const none = (code: string): string => `${code} no METAR available`;
const unreadable = (code: string): string => `${code} report could not be read`;

/**
 * Keeps each server's weather board up to date. The board is a few messages in one channel, edited in place while their number stays the
 * same (posted again if it changes, or if one is deleted). When VATSIM can't be reached the old board stays as it was.
 */
export class WeatherBoardService {
  private client: Client | null = null;
  private running = false;
  /** The redraw of each server's board that is under way or queued. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** What each message of a board says, so an edit that would change nothing is not sent. */
  private readonly shown = new Map<string, string>();
  private current: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly metar: Pick<MetarClient, 'report'>,
    private readonly log: Logger = silentLogger,
    private readonly now: () => number = Date.now,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  /**
   * Redraw one server's board now. Redraws of one board never overlap (the schedule and `/setup weather` can ask at the same moment, and
   * two at once would each post the board, leaving a copy nothing knows about): one waits for the other.
   */
  refresh(guildId: string): Promise<WeatherRefreshResult> {
    const after = this.chains.get(guildId) ?? Promise.resolve();
    const run = after.then(() => this.redraw(guildId));
    const done = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(guildId, done);
    void done.then(() => {
      if (this.chains.get(guildId) === done) this.chains.delete(guildId);
    });
    return run;
  }

  /** The reports for these airports, as one line each. A report that VATSIM could not give at all throws (the board is then left as it was). */
  private async reports(codes: string[]): Promise<Map<string, string>> {
    const lines = new Map<string, string>();
    const failed: { error: MetarError | null } = { error: null };
    const queue = [...new Set(codes)];
    const worker = async () => {
      for (let code = queue.shift(); code !== undefined; code = queue.shift()) {
        try {
          const report = await this.metar.report(code, FRESH_ENOUGH_MS);
          lines.set(code, report === null ? none(code) : report);
        } catch (e) {
          if (!(e instanceof MetarError)) throw e;
          if (e.kind === 'bad-response') lines.set(code, unreadable(code));
          else failed.error ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    if (failed.error) throw failed.error;
    return lines;
  }

  private async redraw(guildId: string): Promise<WeatherRefreshResult> {
    const board = this.store.getWeatherBoard(guildId);
    if (!board || !this.client) return 'skipped';
    const now = this.now();
    this.store.updateWeatherBoard(guildId, { lastAttemptAt: now });

    const top = board.airports.length > 0 ? board.airports : [...DEFAULT_WEATHER_AIRPORTS];
    // The flights of every panel in this server whose landing window is in the next 24 hours.
    const views = this.store.listPanels(guildId).flatMap((p) => this.store.listOpenJobViews(p.id));
    const inWindow = flightsInWindow(views, now);
    const shown = inWindow.slice(0, MAX_BOARD_FLIGHTS);
    const { codes, skipped } = flightAirports(shown, top);
    const wanted = codes.slice(0, MAX_FLIGHT_AIRPORTS);

    let lines: Map<string, string>;
    try {
      lines = await this.reports([...top, ...wanted]);
    } catch (e) {
      if (e instanceof MetarError) {
        this.note(board, e.message);
        return 'unavailable';
      }
      this.note(board, 'Something went wrong asking for the weather (it is in my log).');
      this.log.warn(`Could not read the weather for server ${guildId}`, e);
      return 'failed';
    }
    const lineOf = (code: string) => lines.get(code) ?? none(code);

    const texts = renderWeather({
      now,
      top: top.map(lineOf),
      flights: shown,
      moreFlights: inWindow.length - shown.length,
      flightAirports: wanted.map(lineOf),
      moreAirports: codes.length - wanted.length,
      skipped,
      everyMinutes: WEATHER_REFRESH_MS / 60_000,
    });
    const payloads = texts.map((content, i) => ({ content, components: i === texts.length - 1 ? [weatherButtons()] : [], allowedMentions: noPings }));

    try {
      const channel = await this.client.channels.fetch(board.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.note(board, "The weather channel is missing, or I can't write in it.");
        return 'no-access';
      }
      const lookup = (id: string) => ('messages' in channel ? channel.messages.fetch({ message: id, force: true }).catch(() => null) : Promise.resolve(null));
      let result: WeatherRefreshResult = 'posted';

      if ('messages' in channel && board.messageIds.length === payloads.length) {
        const existing = [];
        for (const id of board.messageIds) existing.push(await lookup(id));
        if (existing.every((m) => m && m.editable)) {
          try {
            for (let i = 0; i < payloads.length; i++) {
              const id = board.messageIds[i]!;
              if (this.shown.get(id) === texts[i]) continue; // already says exactly this
              await existing[i]!.edit(payloads[i]!);
              this.shown.set(id, texts[i]!);
            }
            result = 'updated';
          } catch (e) {
            if (!isUnknownMessage(e)) throw e; // deleted between the look and the edit: post it again
          }
        }
      }
      if (result !== 'updated') {
        for (const id of board.messageIds) {
          const m = await lookup(id);
          if (m && m.deletable) await m.delete().catch(() => undefined);
          this.shown.delete(id);
        }
        this.store.updateWeatherBoard(guildId, { messageIds: [] });
        const fresh: string[] = [];
        try {
          for (const [i, payload] of payloads.entries()) {
            const sent = await channel.send(payload);
            fresh.push(sent.id);
            this.shown.set(sent.id, texts[i]!);
          }
        } finally {
          // Even if posting stops halfway, what was posted is remembered, so the next redraw clears it away.
          this.store.updateWeatherBoard(guildId, { messageIds: fresh });
        }
      }
      this.store.updateWeatherBoard(guildId, { lastOkAt: now, lastError: null });
      return result;
    } catch (e) {
      if (isMissingAccess(e)) {
        this.note(board, "I'm not allowed to write in the weather channel.");
        return 'no-access';
      }
      this.note(board, 'Something went wrong drawing the board (it is in my log).');
      this.log.warn(`Could not refresh the weather board for server ${guildId}`, e);
      return 'failed';
    }
  }

  /** Redraw every board that is due. Overlapping runs are skipped. */
  run(): Promise<void> {
    if (this.running) return this.current;
    this.running = true;
    this.current = (async () => {
      try {
        for (const board of this.store.listWeatherBoards()) {
          const last = board.lastAttemptAt;
          if (last !== null && this.now() - last < WEATHER_REFRESH_MS) continue;
          await this.refresh(board.guildId).catch((e) => this.log.warn('Weather board refresh failed', e));
        }
      } finally {
        this.running = false;
      }
    })();
    return this.current;
  }

  /** Resolves once the redraw that is under way (if any) has finished. */
  idle(): Promise<void> {
    return this.current;
  }

  /** Delete the board's messages (best effort). The caller removes the record. */
  async deleteMessages(board: WeatherBoard): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return;
    for (const id of board.messageIds) {
      const m = await channel.messages.fetch({ message: id, force: true }).catch(() => null);
      if (m && m.deletable) await m.delete().catch(() => undefined);
      this.shown.delete(id);
    }
  }

  /** Remember what went wrong, and log it only when it changes, so a broken channel does not fill the log every 10 minutes. */
  private note(board: WeatherBoard, why: string): void {
    if (board.lastError !== why) this.log.warn(`Weather board for server ${board.guildId}: ${why}`);
    this.store.updateWeatherBoard(board.guildId, { lastError: why });
  }
}

/* ------------------------------------------------------------------ the Search button */

const lastSearch = new Map<string, number>();

/** The search form was sent: answer privately with the METAR of each airport asked for, as written. */
async function runSearch(ctx: BotContext, interaction: ModalSubmitInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const typed = interaction.fields.getTextInputValue('codes');
  const { codes, refused } = parseAirportList(typed);
  const quote = (list: string[]) => list.map((c) => `\`${c}\``).join(', ');
  if (codes.length === 0) {
    throw new UserError(
      `${refused.length > 0 ? `I couldn't use ${quote(refused)} as an airport code. ` : ''}I need the four-letter ICAO code, like \`EGLL\` for London Heathrow or \`KJFK\` for New York JFK (US airports start with a K, so JFK is KJFK).`,
    );
  }
  const now = ctx.now();
  const last = lastSearch.get(interaction.user.id);
  if (last !== undefined && now - last < SEARCH_COOLDOWN_MS) throw new UserError('One moment, then search again.');
  lastSearch.set(interaction.user.id, now);
  if (lastSearch.size > 5000) for (const [k, t] of lastSearch) if (now - t > SEARCH_COOLDOWN_MS) lastSearch.delete(k);

  const asked = codes.slice(0, MAX_SEARCH_AIRPORTS);
  const lines: string[] = [];
  for (const code of asked) {
    try {
      const report = await ctx.metar.report(code);
      lines.push(report === null ? none(code) : report);
    } catch (e) {
      if (e instanceof MetarError) {
        if (e.kind === 'bad-response') lines.push(unreadable(code));
        else throw new UserError(e.message);
      } else throw e;
    }
  }
  const notes: string[] = [];
  if (refused.length > 0) notes.push(`I skipped ${quote(refused)}: not four-letter airport codes.`);
  if (codes.length > asked.length) notes.push(`I looked up the first ${asked.length}. Search again for the rest.`);
  if (lines.some((l) => l.endsWith('no METAR available'))) notes.push('Small airfields often have no weather station, so VATSIM has no report for them.');
  await interaction.editReply({
    content: [...metarBlocks(lines), ...notes, `Want it in plain words? Send me a DM: \`metar ${asked[0] ?? 'EGLL'}\`.`, `*${WEATHER_FOOTER}*`].join('\n'),
    allowedMentions: noPings,
  });
}

/** `weather:search` (the board's button, which opens the form) and `weather:searchgo` (the form sent). */
export const weatherHandler: ComponentHandler = {
  prefix: 'weather',
  async handle(ctx, interaction) {
    const action = interaction.customId.split(':')[1];
    if (action === 'search' && interaction.isButton()) {
      await interaction.showModal(searchModal());
      return;
    }
    if (action === 'searchgo' && interaction.isModalSubmit()) return runSearch(ctx, interaction);
    throw new UserError('That button is out of date.');
  },
};
