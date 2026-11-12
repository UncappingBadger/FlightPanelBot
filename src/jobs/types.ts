/** The airline a source is asked about: just how it is named on the panel. */
export interface SourceAirline {
  name: string;
  abbr: string | null;
}

/** One hop of a job: fly from `dep` to `arr`. A job has one or more, flown in order. */
export interface SourceLeg {
  dep: string;
  arr: string;
  /**
   * Who the source itself says is flying this leg (for example a name typed into a schedule sheet).
   * Shown on the panel and treated as taken, but it is only a name: it has no Discord account.
   */
  heldBy?: string | null;
}

/**
 * A job as a source describes it, before the bot gives it an ID. This is the seam where a real
 * Aeroconomy feed plugs in: anything that can produce these (and an airline to fetch them for)
 * can drive a panel.
 */
export interface SourceJob {
  /** The source's own stable identifier. Re-importing the same key keeps the same bot ID. */
  key: string;
  title: string | null;
  legs: SourceLeg[];
  /** Required airframe, e.g. "A20N" or "Boeing 737-800". */
  aircraft: string | null;
  /** Epoch ms (UTC) from which the job can be flown, if it has a start. */
  availableFrom: number | null;
  /** Epoch ms (UTC) by which the flight must be completed. */
  deadline: number | null;
  pay: string | null;
  notes: string | null;
  /**
   * The source says this job is finished or cancelled. It leaves the panel quietly, without telling
   * anyone who held it that it was "removed".
   */
  closed?: boolean;
  /**
   * The source says the flight was flown. It is closed like any other, but the panel keeps showing it,
   * marked completed, for a day. Implies `closed`.
   */
  completed?: boolean;
}

/** What a source returns: the jobs, plus anything an admin should hear about (rows it had to skip). */
export interface FetchedJobs {
  jobs: SourceJob[];
  warnings: string[];
}

/** Something that can list the current jobs for an airline. Polled once every 24 hours. */
export interface JobSource {
  readonly kind: string;
  fetch(airline: SourceAirline, now: number): Promise<SourceJob[] | FetchedJobs>;
}

export function normalizeFetched(result: SourceJob[] | FetchedJobs): FetchedJobs {
  return Array.isArray(result) ? { jobs: result, warnings: [] } : result;
}

export const MAX_LEGS = 12;
export const MAX_JOBS = 1000;
