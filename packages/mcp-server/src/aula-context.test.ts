import { describe, expect, test } from 'bun:test';
import {
  noopTracer,
  type StoredTokenRecord,
  silentLogger,
  type TokenStore,
  type WireTracer,
} from '@aula-mcp/aula-auth';
import { AulaContext } from './aula-context.ts';

class EmptyStore implements TokenStore {
  async load(): Promise<StoredTokenRecord | null> {
    return null;
  }
  async save(): Promise<void> {}
  async clear(): Promise<void> {}
}

describe('AulaContext — tracer', () => {
  test('a tracer passed at construction is the one on the shared HTTP client', () => {
    const tracer: WireTracer = { record() {} };
    const context = new AulaContext({ store: new EmptyStore(), logger: silentLogger, tracer });
    expect(context.http.tracer).toBe(tracer);
  });

  test('without a tracer option the client keeps its noop default', () => {
    const context = new AulaContext({ store: new EmptyStore(), logger: silentLogger });
    expect(context.http.tracer).toBe(noopTracer);
  });
});
