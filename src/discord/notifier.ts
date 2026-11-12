import type { Client } from 'discord.js';
import type { Logger } from '../util/log.js';
import type { JobEvent, JobEvents, ReleasedNotice } from '../services/events.js';
import { legList } from '../util/format.js';
import type { PanelService } from './panel.js';
import { noPings } from './ui.js';

const REASON: Record<ReleasedNotice['reason'], string> = {
  removed: 'is no longer listed, so your reservation was released',
  changed: 'changed (different route), so your reservation was released. Check the panel and reserve again if you still want it',
  admin: 'was released by a server admin',
};

/** Redraws panels when jobs change, and tells people when a reservation of theirs is taken away. */
export class Notifier {
  constructor(
    private readonly client: Client,
    private readonly panels: PanelService,
    private readonly log: Logger,
  ) {}

  subscribe(events: JobEvents): () => void {
    return events.subscribe((e) => this.handle(e));
  }

  async handle(event: JobEvent): Promise<void> {
    if (event.type === 'changed') {
      this.panels.schedule(event.panelId);
      return;
    }
    const n = event.notice;
    try {
      const user = await this.client.users.fetch(n.discordId);
      const legs = n.legNos.length === 1 ? `leg ${n.legNos[0]}` : `legs ${legList(n.legNos)}`;
      await user.send({ content: `Heads up: flight **${n.jobCode}** (${legs}) ${REASON[n.reason]}.`, allowedMentions: noPings });
    } catch (e) {
      // Closed DMs or an unknown user; the panel is already right, so this is only a courtesy.
      this.log.debug(`Could not tell ${n.discordId} about a released reservation`, e);
    }
  }
}
