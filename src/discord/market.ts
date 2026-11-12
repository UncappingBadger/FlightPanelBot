import type { Client } from 'discord.js';
import { AeroDaqError, type AeroDaqClient } from '../aerodaq/client.js';
import type { MarketBoard, Store } from '../db/store.js';
import { silentLogger, type Logger } from '../util/log.js';
import { renderMarket } from './aerodaqUi.js';
import { isMissingAccess, isUnknownMessage } from './errors.js';
import { noPings } from './ui.js';

/**
 * - `updated`: edited the existing message in place
 * - `posted`: (re)posted the board
 * - `unavailable`: AeroDAQ could not be asked; the board keeps what it last showed
 * - `no-access`: the channel is gone or the bot can't see or write in it
 * - `failed`: something else went wrong (details are in the log)
 */
export type MarketRefreshResult = 'updated' | 'posted' | 'unavailable' | 'no-access' | 'failed' | 'skipped';

/** How often a board is redrawn. AeroDAQ moves each price every few minutes, so this keeps it fresh without chasing it. */
export const MARKET_REFRESH_MS = 15 * 60_000;

/**
 * Keeps each server's AeroDAQ market board up to date. The board is one message, edited in place; if it
 * is deleted the next refresh posts it again. When AeroDAQ can't be reached the old board stays as it was.
 */
export class MarketService {
  private client: Client | null = null;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly aerodaq: Pick<AeroDaqClient, 'market'>,
    private readonly log: Logger = silentLogger,
    private readonly now: () => number = Date.now,
  ) {}

  attach(client: Client): void {
    this.client = client;
  }

  /** Redraw one server's board now. */
  async refresh(guildId: string): Promise<MarketRefreshResult> {
    const board = this.store.getMarketBoard(guildId);
    if (!board || !this.client) return 'skipped';
    this.store.updateMarketBoard(guildId, { lastAttemptAt: this.now() });

    let stocks;
    try {
      stocks = await this.aerodaq.market();
    } catch (e) {
      const why = e instanceof AeroDaqError ? e.message : 'AeroDAQ could not be asked.';
      this.note(board, why);
      return e instanceof AeroDaqError ? 'unavailable' : 'failed';
    }

    try {
      const channel = await this.client.channels.fetch(board.channelId).catch(() => null);
      if (!channel || !channel.isSendable()) {
        this.note(board, "The market channel is missing, or I can't write in it.");
        return 'no-access';
      }
      const payload = { embeds: renderMarket(stocks, this.now()), allowedMentions: noPings };

      const lookup = (id: string) => ('messages' in channel ? channel.messages.fetch({ message: id, force: true }).catch(() => null) : Promise.resolve(null));
      let result: MarketRefreshResult = 'posted';

      if ('messages' in channel && board.messageIds.length === 1) {
        const existing = await lookup(board.messageIds[0]!);
        if (existing && existing.editable) {
          try {
            await existing.edit(payload);
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
        }
        const sent = await channel.send(payload);
        this.store.updateMarketBoard(guildId, { messageIds: [sent.id] });
      }
      this.store.updateMarketBoard(guildId, { lastOkAt: this.now(), lastError: null });
      return result;
    } catch (e) {
      if (isMissingAccess(e)) {
        this.note(board, "I'm not allowed to write in the market channel.");
        return 'no-access';
      }
      this.note(board, 'Something went wrong drawing the board (it is in my log).');
      this.log.warn(`Could not refresh the market board for server ${guildId}`, e);
      return 'failed';
    }
  }

  /** Redraw every board that is due. Overlapping runs are skipped. */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const board of this.store.listMarketBoards()) {
        const last = board.lastAttemptAt;
        if (last !== null && this.now() - last < MARKET_REFRESH_MS) continue;
        await this.refresh(board.guildId).catch((e) => this.log.warn('Market board refresh failed', e));
      }
    } finally {
      this.running = false;
    }
  }

  /** Delete the board's message (best effort). The caller removes the record. */
  async deleteMessages(board: MarketBoard): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !('messages' in channel)) return;
    for (const id of board.messageIds) {
      const m = await channel.messages.fetch({ message: id, force: true }).catch(() => null);
      if (m && m.deletable) await m.delete().catch(() => undefined);
    }
  }

  /** Remember what went wrong, and log it only when it changes, so a broken channel does not fill the log every 15 minutes. */
  private note(board: MarketBoard, why: string): void {
    if (board.lastError !== why) this.log.warn(`Market board for server ${board.guildId}: ${why}`);
    this.store.updateMarketBoard(board.guildId, { lastError: why });
  }
}
