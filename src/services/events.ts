import { silentLogger, type Logger } from '../util/log.js';

/** Someone's reservation was taken away (the job changed, was removed, or an admin released it). */
export interface ReleasedNotice {
  panelId: number;
  discordId: string;
  jobCode: string;
  legNos: number[];
  reason: 'removed' | 'changed' | 'admin';
}

export type JobEvent =
  /** Something on a panel changed, so its message needs redrawing. */
  | { type: 'changed'; panelId: number }
  | { type: 'released'; notice: ReleasedNotice };

export type JobListener = (event: JobEvent) => void | Promise<void>;

/**
 * Tiny in-process pub/sub so the job logic can announce what happened without knowing anything
 * about Discord. A listener that throws never affects the others or the caller.
 */
export class JobEvents {
  private readonly listeners: JobListener[] = [];

  constructor(private readonly log: Logger = silentLogger) {}

  subscribe(listener: JobListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  emit(event: JobEvent): void {
    for (const l of this.listeners) {
      try {
        const out = l(event);
        if (out && typeof (out as Promise<void>).catch === 'function') {
          (out as Promise<void>).catch((e) => this.log.error(`Job listener failed for ${event.type}`, e));
        }
      } catch (e) {
        this.log.error(`Job listener failed for ${event.type}`, e);
      }
    }
  }
}

/** Combine notices for the same person, job and reason into one (legs merged). */
export function mergeNotices(notices: ReleasedNotice[]): ReleasedNotice[] {
  const byKey = new Map<string, ReleasedNotice>();
  for (const n of notices) {
    const key = `${n.panelId}|${n.discordId}|${n.jobCode}|${n.reason}`;
    const existing = byKey.get(key);
    if (existing) existing.legNos = [...new Set([...existing.legNos, ...n.legNos])].sort((a, b) => a - b);
    else byKey.set(key, { ...n, legNos: [...n.legNos].sort((a, b) => a - b) });
  }
  return [...byKey.values()];
}
