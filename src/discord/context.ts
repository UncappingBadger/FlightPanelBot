import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { AeroDaqClient } from '../aerodaq/client.js';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import type { FsHubApi } from '../fshub/client.js';
import type { AutoCompleter } from '../services/autoComplete.js';
import type { FsHubSync } from '../services/fshubSync.js';
import type { JobService } from '../services/jobs.js';
import type { SourceRefresher } from '../services/refresh.js';
import type { SheetWriteBack } from '../services/writeback.js';
import type { Logger } from '../util/log.js';
import type { MarketService } from './market.js';
import type { PanelService } from './panel.js';

/** Everything a command handler needs, created once at startup. */
export interface BotContext {
  config: Config;
  store: Store;
  jobs: JobService;
  panels: PanelService;
  refresher: SourceRefresher;
  /** AeroDAQ's in-game market and fuel prices (public, read-only). */
  aerodaq: AeroDaqClient;
  /** Keeps each server's market board up to date. */
  market: MarketService;
  /** Writes pilots' names and completions into a linked Google Sheet; null when the bot has no Google credentials. */
  writeback: SheetWriteBack | null;
  /** FsHub, for checking pilot IDs and reading an airline's roster; null when the host saved no FsHub token. */
  fshub: FsHubApi | null;
  /** Reads linked airlines' FsHub rosters; null together with `fshub`. */
  fshubSync: FsHubSync | null;
  /** Completes flights FsHub shows flown, once an hour; null together with `fshub`. */
  autoComplete: AutoCompleter | null;
  log: Logger;
  now: () => number;
  /** For downloading admin-uploaded files; replaceable in tests. */
  fetchFn: typeof fetch;
}

export interface Command {
  data: { name: string; toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody };
  execute(ctx: BotContext, interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(ctx: BotContext, interaction: AutocompleteInteraction): Promise<void>;
}

export type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

export interface ComponentHandler {
  /** Matches custom IDs that start with `${prefix}:`. */
  prefix: string;
  handle(ctx: BotContext, interaction: ComponentInteraction): Promise<void>;
}
