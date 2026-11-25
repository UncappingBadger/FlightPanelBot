/**
 * The bot's own clock. In every build but the test build it is simply `Date.now`.
 *
 * The test build (`npm run build:host -- --test`) runs it faster, so the checks that happen once a day or once an hour can be watched
 * happening: with the default scale of 288, a day is five minutes and an hour is twelve and a half seconds. Everything the bot decides
 * by the time of day or the age of something (the midnight list of flights without a pilot, a flight's window ending, a completed
 * flight leaving the panel, the hourly slot, the daily check) follows this clock, so it all stays in step. What talks to the outside
 * (Discord's own timeouts, a download's time limit, how fast Google or FsHub may be asked) keeps real time.
 */

/** Set by the build (esbuild replaces `__FPB_FAST__`): how many times faster than real time the bot's clock runs. Never set in a normal build, a dev run or a test. */
declare const __FPB_FAST__: number | undefined;

/** A clock that starts at `origin` and runs `scale` times faster than `realNow`. */
export function scaledClock(scale: number, origin: number, realNow: () => number = () => Date.now()): () => number {
  return () => origin + (realNow() - origin) * scale;
}

export const TIME_SCALE: number = typeof __FPB_FAST__ !== 'undefined' && Number(__FPB_FAST__) > 1 ? Number(__FPB_FAST__) : 1;

/** True only in the test build. */
export const TEST_BUILD: boolean = TIME_SCALE > 1;

/** The time as the bot sees it (epoch ms): the real time, or the test build's faster one. Use it where `Date.now` would do, for anything the bot decides by. */
// (`Date.now` is looked up at each call, not kept: a test that replaces it, to move time, is then followed.)
export const appNow: () => number = TEST_BUILD ? scaledClock(TIME_SCALE, Date.now()) : () => Date.now();

/** The time a duration is measured with (how long something took): always real, even in the test build, where `appNow` runs fast. */
export const realMs = (): number => performance.now();
