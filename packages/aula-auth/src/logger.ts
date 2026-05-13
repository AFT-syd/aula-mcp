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

/**
 * Logger that writes every level to stderr. Use this in stdio MCP
 * servers — stdout is the JSON-RPC channel and `console.info`/`debug`
 * default to stdout in Node/Bun, which would corrupt the protocol.
 */
export function stderrLogger(prefix = 'aula-auth'): Logger {
  const write = (level: string, m: string, meta?: Record<string, unknown>): void => {
    const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    process.stderr.write(`[${prefix}] ${level} ${m}${suffix}\n`);
  };
  return {
    debug: (m, meta) => write('DEBUG', m, meta),
    info: (m, meta) => write('INFO', m, meta),
    warn: (m, meta) => write('WARN', m, meta),
    error: (m, meta) => write('ERROR', m, meta),
  };
}
