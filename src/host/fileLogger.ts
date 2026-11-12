import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, type LogLevel, type Logger } from '../util/log.js';

export interface FileLogger {
  log: Logger;
  /** The most recent lines, oldest first, for the setup page. */
  tail(count: number): string[];
}

export interface FileLoggerOptions {
  file: string;
  level?: LogLevel;
  /** A log file is rolled over once it reaches this size. */
  maxBytes?: number;
  /** How many older files to keep (`bot.log.1` is the newest of them). */
  keep?: number;
  /** Lines kept in memory for `tail`. */
  recent?: number;
}

/** Logs to a file that rolls over at a fixed size, so it can never fill the disk. Never throws. */
export function createFileLogger(opts: FileLoggerOptions): FileLogger {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const keep = opts.keep ?? 3;
  const recent: string[] = [];
  const recentMax = opts.recent ?? 500;
  let size = existsSync(opts.file) ? statSync(opts.file).size : 0;

  const roll = () => {
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? opts.file : `${opts.file}.${i - 1}`;
      const to = `${opts.file}.${i}`;
      if (i === keep) rmSync(to, { force: true });
      if (existsSync(from)) renameSync(from, to);
    }
    size = 0;
  };

  const sink = (line: string) => {
    recent.push(line);
    if (recent.length > recentMax) recent.shift();
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      if (size >= maxBytes) roll();
      const text = `${line}\n`;
      appendFileSync(opts.file, text, 'utf8');
      size += Buffer.byteLength(text);
    } catch {
      // A log that can't be written must not take the bot down with it.
    }
  };

  return { log: createLogger(opts.level ?? 'info', sink), tail: (count) => recent.slice(-count) };
}
