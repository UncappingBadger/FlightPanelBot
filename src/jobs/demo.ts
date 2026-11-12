import type { JobSource, SourceAirline, SourceJob } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Template {
  title: string;
  chain: string[];
  aircraft: string;
  pay: string;
  notes: string | null;
}

const TEMPLATES: Template[] = [
  { title: 'Gatwick hop', chain: ['EGLL', 'EGKK'], aircraft: 'A20N', pay: '12,500', notes: null },
  { title: 'Northern rotation', chain: ['EGLL', 'EGCC', 'EGPH'], aircraft: 'A320', pay: '28,000', notes: 'Two legs, can be shared' },
  { title: 'US three-leg loop', chain: ['KJFK', 'KBOS', 'KORD', 'KJFK'], aircraft: 'B738', pay: '41,000', notes: 'Three legs, take any' },
  { title: 'Rhine shuttle', chain: ['EDDF', 'EHAM'], aircraft: 'A320', pay: '14,200', notes: null },
  { title: 'Transatlantic', chain: ['EGLL', 'KJFK'], aircraft: 'B789', pay: '96,000', notes: 'Heavy' },
  { title: 'Iberia tour', chain: ['LFPG', 'LEMD', 'EGLL'], aircraft: 'A21N', pay: '33,500', notes: 'Two legs' },
];

/**
 * Fictional jobs for demo mode. Each day brings a fresh batch, and yesterday's batch stays until
 * its deadlines pass, so the daily refresh visibly adds new jobs without yanking live ones away.
 * Keys are stable within a day, so refreshing twice doesn't change any job's ID.
 */
export class DemoJobSource implements JobSource {
  readonly kind = 'demo';

  async fetch(_airline: SourceAirline, now: number): Promise<SourceJob[]> {
    const today = Math.floor(now / DAY);
    const jobs: SourceJob[] = [];
    for (const day of [today - 1, today]) {
      TEMPLATES.forEach((t, i) => {
        const deadline = (day + 1) * DAY + (12 + 8 * i) * HOUR;
        if (deadline <= now) return;
        jobs.push({
          key: `demo-d${day}-${i}`,
          title: t.title,
          legs: t.chain.slice(0, -1).map((dep, k) => ({ dep, arr: t.chain[k + 1] as string })),
          aircraft: t.aircraft,
          availableFrom: day * DAY,
          deadline,
          pay: t.pay,
          notes: t.notes,
        });
      });
    }
    return jobs;
  }
}
