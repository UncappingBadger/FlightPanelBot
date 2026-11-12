export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = console.log): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, extra?: unknown) => {
    if (ORDER[lvl] < min) return;
    let line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${msg}`;
    if (extra instanceof Error) line += ` :: ${extra.stack ?? extra.message}`;
    else if (extra !== undefined) line += ` :: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    sink(line);
  };
  return {
    debug: (m, e) => emit('debug', m, e),
    info: (m, e) => emit('info', m, e),
    warn: (m, e) => emit('warn', m, e),
    error: (m, e) => emit('error', m, e),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
