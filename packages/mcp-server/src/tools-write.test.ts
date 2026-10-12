/**
 * Two things a live test (2026-10-02) showed:
 *
 * 1 — aula.presence.report_sick and aula.fravaer.tabulex_meld_syg used
 * to return upstream's bare success flag ({ok:true} / {reported:true})
 * without reading anything back. Live-tested against a child who was
 * ALREADY reported sick in both systems: both tools answered "success" even
 * though the write changed nothing — a bare flag cannot tell "wrote
 * successfully" apart from "no-op" or "silently ignored". For an
 * unforgivingly one-way action (Tabulex's meld_syg has no undo at all),
 * that is too loose. Both tools now read the state back and return it.
 *
 * 2 — aula.fravaer.tabulex_boern's `childIds` does not filter its
 * response: Tabulex always returns every child the guardian has Fravær
 * access to, because its child records carry no Aula child id to filter
 * on (confirmed in TabulexChildAccess's shape — see tools.ts). Rather than
 * build a name-matching heuristic that could silently mismatch or drop a
 * child, the fix is documentation: the tool now says explicitly that
 * childIds scopes the SSO session, not the response.
 *
 * These tests bypass the MCP SDK's JSON-RPC/Zod-validation layer entirely
 * (see server.test.ts for that style) and instead capture tool handlers
 * directly off a minimal fake `McpServer` — the same "call the pure logic
 * directly" style tools.test.ts already uses for validateSetTemplateArgs
 * etc., just one layer up. Args are passed pre-validated; Zod enforcement
 * itself is the SDK's job, not tools.ts's, and is not what's under test
 * here.
 */

import { describe, expect, test } from 'bun:test';
import type { AulaTokens } from '@aula-mcp/aula-auth';
import type { AulaClient, DailyOverviewEntry, TabulexChildAccess } from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import { registerTools } from './tools.ts';

const TOKENS: AulaTokens = {
  access_token: 'AT',
  refresh_token: 'RT',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  obtained_at: Math.floor(Date.now() / 1000),
};

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

interface CapturedTool {
  config: { title?: string; description?: string };
  handler: ToolHandler;
}

/** Minimal stand-in for McpServer — just enough of `registerTool`'s shape
 *  for registerTools() to populate it. Every tool's config + handler is
 *  captured by name so a test can invoke one directly. Cast to McpServer
 *  via `unknown` at each call site below (same pattern as fakeContext,
 *  which casts a plain object to AulaContext) — this is a test double, not
 *  a real implementation of the SDK's (overloaded, generic) registerTool. */
function fakeServer(): { tools: Map<string, CapturedTool>; registerTool: unknown } {
  const tools = new Map<string, CapturedTool>();
  return {
    tools,
    registerTool: (name: string, config: unknown, handler: ToolHandler) => {
      tools.set(name, { config: config as CapturedTool['config'], handler });
    },
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): unknown {
  const first = result.content[0];
  if (!first) throw new Error('expected content[0]');
  return JSON.parse(first.text);
}

/** Runs `fn` with AULA_MCP_WRITE=1 set, restoring whatever was there before
 *  — write tools are only registered when this env var is '1' (checked
 *  inside registerTools() at call time), and other test files in this
 *  process rely on it being unset by default (e.g. server.test.ts asserts
 *  write tools are NOT registered). */
async function withWriteEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const original = process.env.AULA_MCP_WRITE;
  process.env.AULA_MCP_WRITE = '1';
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.AULA_MCP_WRITE;
    else process.env.AULA_MCP_WRITE = original;
  }
}

interface FakeContextOptions {
  dailyOverview?: (ids: readonly number[]) => Promise<DailyOverviewEntry[]>;
  tabulex?: {
    getPersonsAdgangTilBoern?: () => Promise<TabulexChildAccess[]>;
    reportSick?: () => Promise<unknown>;
    getFravaerIdag?: () => Promise<Record<string, unknown>>;
    getFravaerImorgen?: () => Promise<Record<string, unknown>>;
  };
}

function fakeContext(opts: FakeContextOptions = {}): AulaContext {
  const profiles = {
    profiles: [
      {
        profileId: 1,
        displayName: 'Casper',
        children: [{ id: 1001, name: 'Emilie', userId: 2001 }],
      },
    ],
  };
  const fakeClient = {
    // Also served at client level so these tests exercise the handlers'
    // own logic regardless of whether they read profiles via the client or
    // via AulaContext's profiles cache.
    async getProfilesByLogin() {
      return profiles;
    },
    async getProfileContext() {
      return { userId: 5000 };
    },
    async updatePresenceStatus() {
      return { marker: 'updatePresenceStatus-result' };
    },
    async getDailyOverview(ids: readonly number[]) {
      if (opts.dailyOverview) return opts.dailyOverview(ids);
      return ids.map((id) => ({ institutionProfile: { id }, status: 1 }) as DailyOverviewEntry);
    },
  };

  const fakeTabulex = {
    async getPersonsAdgangTilBoern() {
      if (opts.tabulex?.getPersonsAdgangTilBoern) return opts.tabulex.getPersonsAdgangTilBoern();
      return [
        {
          fornavn: 'Barn',
          efternavn: 'Testesen',
          cpr: '0101209999',
          klasse: '3A',
          skoleNavn: 'Testskolen',
          skoleKode: 'T1',
          skoleFravaerAdgang: true,
          raw: {},
        } satisfies TabulexChildAccess,
      ];
    },
    async reportSick() {
      if (opts.tabulex?.reportSick) return opts.tabulex.reportSick();
      return { ok: true };
    },
    async getFravaerIdag() {
      if (opts.tabulex?.getFravaerIdag) return opts.tabulex.getFravaerIdag();
      return {
        dag: true,
        dato: '2026-10-02T00:00:00+02:00',
        note: null,
        aarsag: 'Sygdom',
        raw: {},
      };
    },
    async getFravaerImorgen() {
      if (opts.tabulex?.getFravaerImorgen) return opts.tabulex.getFravaerImorgen();
      return { dag: false, dato: '2026-10-03T00:00:00+02:00', note: null, raw: {} };
    },
  };

  return {
    record: {
      version: 1 as const,
      username: 'cj',
      tokens: TOKENS,
      identityName: 'Forælder',
      saved_at: Math.floor(Date.now() / 1000),
    },
    async getClient(): Promise<AulaClient> {
      return fakeClient as unknown as AulaClient;
    },
    async getGuardianUserId(): Promise<string> {
      return '5000';
    },
    async getProfilesByLogin() {
      return profiles;
    },
    async getTabulex() {
      return fakeTabulex;
    },
  } as unknown as AulaContext;
}

describe('aula.presence.report_sick — returns observed state, not just upstream ok', () => {
  test('a no-op write (child already sick) is reported with the observed status, not a bare ok:true', async () => {
    await withWriteEnabled(async () => {
      const srv = fakeServer();
      registerTools(srv as unknown as McpServer, fakeContext());
      const tool = srv.tools.get('aula.presence.report_sick');
      if (!tool) throw new Error('aula.presence.report_sick was not registered');

      const result = await tool.handler({ institutionProfileIds: [1001], sick: true });
      const data = textOf(result) as {
        upstream: { ok: boolean };
        verified: boolean;
        observedStatus: Array<{ id: number; name: string; status: number | null }> | null;
      };

      expect(data.upstream.ok).toBe(true);
      // The fix: the tool now reports what Aula's own daily overview says
      // after the write, not just that the write endpoint didn't throw.
      expect(data.verified).toBe(true);
      expect(data.observedStatus).toEqual([{ id: 1001, name: 'Emilie', status: 1 }]);
    });
  });

  test('a read that contradicts the write is NOT reported as verified', async () => {
    // `verified` used to mean only "the read came back".
    // Here Aula accepts the write and then still reports status 0 (not
    // arrived) — the write demonstrably did not take effect, yet the old
    // flag would have said verified:true and the model would have told the
    // user the child was marked sick.
    await withWriteEnabled(async () => {
      const srv = fakeServer();
      registerTools(
        srv as unknown as McpServer,
        fakeContext({
          dailyOverview: async () => [
            {
              institutionProfile: { id: 1001, name: 'Emilie' },
              status: 0,
            },
          ],
        }),
      );
      const tool = srv.tools.get('aula.presence.report_sick');
      if (!tool) throw new Error('aula.presence.report_sick was not registered');

      const result = await tool.handler({ institutionProfileIds: [1001], sick: true });
      const data = textOf(result) as {
        stateRead: boolean;
        verified: boolean;
        expectedStatus: number;
        observedStatus: Array<{ status: number | null }> | null;
        verificationMismatch?: string;
      };

      // `stateRead`, not `verified`: Tabulex documents no field that
      // confirms a report, so the tool reads the day back and leaves the
      // judgement to the model. See the tool's own description.
      expect(data.stateRead).toBe(true);
      expect(data.verified).toBe(false);
      expect(data.expectedStatus).toBe(1);
      expect(data.observedStatus?.[0]?.status).toBe(0);
      expect(data.verificationMismatch).toContain('does not report the expected status');
    });
  });

  test('a child missing from the overview is NOT reported as verified', async () => {
    // Same class: the read succeeded but says nothing about this child.
    await withWriteEnabled(async () => {
      const srv = fakeServer();
      registerTools(srv as unknown as McpServer, fakeContext({ dailyOverview: async () => [] }));
      const tool = srv.tools.get('aula.presence.report_sick');
      if (!tool) throw new Error('aula.presence.report_sick was not registered');

      const result = await tool.handler({ institutionProfileIds: [1001], sick: true });
      const data = textOf(result) as {
        stateRead: boolean;
        verified: boolean;
        observedStatus: Array<{ status: number | null }> | null;
      };

      expect(data.stateRead).toBe(true);
      expect(data.verified).toBe(false);
      expect(data.observedStatus?.[0]?.status).toBeNull();
    });
  });

  test('a failed verification read is surfaced explicitly, never silently as a confirmed write', async () => {
    await withWriteEnabled(async () => {
      const srv = fakeServer();
      registerTools(
        srv as unknown as McpServer,
        fakeContext({
          dailyOverview: async () => {
            throw new Error('getDailyOverview boom');
          },
        }),
      );
      const tool = srv.tools.get('aula.presence.report_sick');
      if (!tool) throw new Error('aula.presence.report_sick was not registered');

      const result = await tool.handler({ institutionProfileIds: [1001], sick: true });
      const data = textOf(result) as {
        upstream: { ok: boolean };
        stateRead: boolean;
        verified: boolean;
        observedStatus: unknown;
        verificationError?: string;
      };

      expect(data.upstream.ok).toBe(true);
      expect(data.stateRead).toBe(false);
      expect(data.verified).toBe(false);
      expect(data.observedStatus).toBeNull();
      expect(data.verificationError).toContain('getDailyOverview boom');
    });
  });
});

describe('aula.fravaer.tabulex_meld_syg — returns observed Tabulex state, not just the absence of a throw', () => {
  async function registerAndGetChildRef(context: AulaContext): Promise<{
    srv: ReturnType<typeof fakeServer>;
    childRef: string;
  }> {
    const srv = fakeServer();
    registerTools(srv as unknown as McpServer, context);
    const boernTool = srv.tools.get('aula.fravaer.tabulex_boern');
    if (!boernTool) throw new Error('aula.fravaer.tabulex_boern was not registered');
    const boernResult = await boernTool.handler({
      childIds: [1001],
      institutionCodes: ['G12345'],
    });
    const children = textOf(boernResult) as Array<{ child_ref: string }>;
    const childRef = children[0]?.child_ref;
    if (!childRef) throw new Error('expected a child_ref from tabulex_boern');
    return { srv, childRef };
  }

  test('a no-op write (child already reported sick) is reported with the observed day, not a bare reported:true', async () => {
    await withWriteEnabled(async () => {
      const context = fakeContext({
        tabulex: {
          // Already sick before the write — same shape the live test found.
          getFravaerIdag: async () => ({
            dag: true,
            dato: '2026-10-02T00:00:00+02:00',
            note: null,
            aarsag: 'Sygdom',
            raw: { Dag: true },
          }),
        },
      });
      const { srv, childRef } = await registerAndGetChildRef(context);
      const meldSygTool = srv.tools.get('aula.fravaer.tabulex_meld_syg');
      if (!meldSygTool) throw new Error('aula.fravaer.tabulex_meld_syg was not registered');

      const result = await meldSygTool.handler({
        childIds: [1001],
        institutionCodes: ['G12345'],
        child_ref: childRef,
        when: 'today',
      });
      const data = textOf(result) as {
        upstreamReported: boolean;
        when: string;
        stateRead: boolean;
        observed: { dag: boolean; dato: string } | null;
      };

      expect(data.upstreamReported).toBe(true);
      expect(data.when).toBe('today');
      // The fix: the tool now reports what Tabulex's own Fravaer/Idag says
      // after the write, not just that the PUT didn't throw.
      expect(data.stateRead).toBe(true);
      expect(data.observed?.dag).toBe(true);
      expect(data.observed?.dato).toBe('2026-10-02T00:00:00+02:00');
      // raw must never reach the tool surface (CPR boundary — see tools.ts).
      expect(JSON.stringify(data.observed)).not.toContain('"raw"');
    });
  });

  test('a failed verification read is surfaced explicitly, never silently as a confirmed write', async () => {
    await withWriteEnabled(async () => {
      const context = fakeContext({
        tabulex: {
          getFravaerIdag: async () => {
            throw new Error('Tabulex GET boom (status 500)');
          },
        },
      });
      const { srv, childRef } = await registerAndGetChildRef(context);
      const meldSygTool = srv.tools.get('aula.fravaer.tabulex_meld_syg');
      if (!meldSygTool) throw new Error('aula.fravaer.tabulex_meld_syg was not registered');

      const result = await meldSygTool.handler({
        childIds: [1001],
        institutionCodes: ['G12345'],
        child_ref: childRef,
        when: 'today',
      });
      const data = textOf(result) as {
        upstreamReported: boolean;
        stateRead: boolean;
        observed: unknown;
        verificationError?: string;
      };

      expect(data.upstreamReported).toBe(true);
      expect(data.stateRead).toBe(false);
      expect(data.observed).toBeNull();
      expect(data.verificationError).toContain('status 500');
    });
  });
});

describe('aula.fravaer.tabulex_boern — childIds is documented as a lookup set, not a filter', () => {
  test('the tool description explicitly says childIds does not filter the response', () => {
    const srv = fakeServer();
    registerTools(srv as unknown as McpServer, fakeContext());
    const tool = srv.tools.get('aula.fravaer.tabulex_boern');
    if (!tool) throw new Error('aula.fravaer.tabulex_boern was not registered');

    const description = tool.config.description ?? '';
    expect(description).toMatch(/NOT a filter/i);
    expect(description.toUpperCase()).toContain('ALL');
  });

  test('(documented, unchanged behaviour) a request for one child still returns every child with access', async () => {
    const srv = fakeServer();
    registerTools(
      srv as unknown as McpServer,
      fakeContext({
        tabulex: {
          getPersonsAdgangTilBoern: async () => [
            { fornavn: 'Barn', efternavn: 'Fixture', cpr: '0101209999', raw: {} },
            { fornavn: 'Andet', efternavn: 'Fixture', cpr: '0202215555', raw: {} },
          ],
        },
      }),
    );
    const tool = srv.tools.get('aula.fravaer.tabulex_boern');
    if (!tool) throw new Error('aula.fravaer.tabulex_boern was not registered');

    // Asking for one child (by Aula id, which Tabulex's own records don't
    // carry) still returns both — this is the behaviour the description
    // above now documents rather than silently leaving unexplained.
    const result = await tool.handler({ childIds: [1001], institutionCodes: ['G12345'] });
    const children = textOf(result) as Array<{ fornavn?: string }>;
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.fornavn).sort()).toEqual(['Andet', 'Barn']);
  });
});
