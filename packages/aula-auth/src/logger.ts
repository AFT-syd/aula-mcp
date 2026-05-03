/**
 * Minimal structured logger interface. Callers pass their own (pino, console,
 * MCP transport, etc.). Default is silent so tests + libraries don't spam.
 */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export function consoleLogger(prefix = 'aula-auth'): Logger {
  return {
    debug: (m, meta) => console.debug(`[${prefix}] ${m}`, meta ?? ''),
    info: (m, meta) => console.info(`[${prefix}] ${m}`, meta ?? ''),
    warn: (m, meta) => console.warn(`[${prefix}] ${m}`, meta ?? ''),
    error: (m, meta) => console.error(`[${prefix}] ${m}`, meta ?? ''),
  };
}
