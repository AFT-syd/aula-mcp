import { describe, expect, test } from 'bun:test';
import { type CalendarEvent, htmlToText, type TabulexChildAccess } from '@aula-mcp/aula-client';
import {
  annotateParallelEvents,
  createTabulexChildRefs,
  guardTabulex,
  redactCprFromError,
  registerTools,
  slimPost,
  stripTabulexRaw,
  validateSetTemplateArgs,
} from './tools.ts';

describe('validateSetTemplateArgs', () => {
  test('picked_up_by needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by' })[0]).toContain('pickedUpBy');
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by', pickedUpBy: 'Far' })).toEqual(
      [],
    );
  });

  test('go_home_with needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'go_home_with' })[0]).toContain('pickedUpBy');
  });

  test('self_decider needs both window times', () => {
    expect(
      validateSetTemplateArgs({ activityType: 'self_decider', selfDeciderStartTime: '14:00' })[0],
    ).toContain('self_decider');
    expect(
      validateSetTemplateArgs({
        activityType: 'self_decider',
        selfDeciderStartTime: '14:00',
        selfDeciderEndTime: '16:00',
      }),
    ).toEqual([]);
  });

  test('send_home with no extra fields is fine', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });

  test('a repeating template needs repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'weekly' })[0]).toContain(
      'repeatUntil',
    );
    expect(
      validateSetTemplateArgs({
        activityType: 'send_home',
        repeat: 'weekly',
        repeatUntil: '2026-06-30',
      }),
    ).toEqual([]);
  });

  test('a one-off (repeat never / unset) does not need repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'never' })).toEqual([]);
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });
});

/**
 * aula.messages.mark_read is registered only when AULA_MCP_WRITE=1. It takes
 * the same thread addressing as get_thread (a thread_ref from the listing, or
 * a legacy id the listing has shown), refuses sensitive threads, and resolves
 * the newest message itself. Capture the handlers off a stub McpServer rather
 * than driving the whole transport — the registration shape is all we need.
 */
describe('aula.messages.mark_read', () => {
  type ToolHandler = (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
  }>;

  /** `state.pages` models Aula's 20-per-page paging: one array per page. It
   *  can be swapped between the listing and the write. */
  function register(pages: unknown[][]): {
    list: (args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    markRead: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    state: { pages: unknown[][] };
    calls: Array<[number, string]>;
    pagesRequested: number[];
  } {
    const state = { pages };
    const calls: Array<[number, string]> = [];
    const pagesRequested: number[] = [];
    const fakeClient = {
      async getThreadsPage({ page = 0 }: { page?: number } = {}) {
        pagesRequested.push(page);
        return {
          threads: state.pages[page] ?? [],
          page,
          hasMorePages: page + 1 < state.pages.length,
        };
      },
      async setLastReadMessage(threadId: number, messageId: string) {
        calls.push([threadId, messageId]);
        return { ok: true };
      },
    };
    const context = {
      async getClient() {
        return fakeClient;
      },
      async getGuardianUserId() {
        return '5000';
      },
    };
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool(name: string, _config: unknown, fn: ToolHandler) {
        handlers.set(name, fn);
      },
    };
    const previous = process.env.AULA_MCP_WRITE;
    process.env.AULA_MCP_WRITE = '1';
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural stubs for McpServer/AulaContext
      registerTools(server as any, context as any);
    } finally {
      if (previous === undefined) delete process.env.AULA_MCP_WRITE;
      else process.env.AULA_MCP_WRITE = previous;
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`${name} was not registered`);
      const res = await handler(args);
      const [first] = res.content;
      if (!first) throw new Error('tool returned no content');
      return JSON.parse(first.text) as Record<string, unknown>;
    };
    return {
      list: (args = {}) => call('aula.messages.list_threads', args),
      markRead: (args) => call('aula.messages.mark_read', args),
      state,
      calls,
      pagesRequested,
    };
  }

  /** The thread_ref the listing gave the thread with `subject`. */
  function refOf(listing: Record<string, unknown>, subject: string): string {
    const threads = listing.threads as Array<{ subject?: string; thread_ref: string }>;
    const found = threads.find((t) => t.subject === subject);
    if (!found) throw new Error(`no listed thread with subject ${subject}`);
    return found.thread_ref;
  }

  test('marks the newest message of the thread a thread_ref points at', async () => {
    const { list, markRead, calls } = register([
      [
        { id: 7, subject: 'a', latestMessage: { id: 'aaa.1' } },
        { id: 42, subject: 'b', latestMessage: { id: 'bbb.2' } },
      ],
    ]);
    const ref = refOf(await list(), 'b');
    const out = await markRead({ thread_ref: ref });
    expect(calls).toEqual([[42, 'bbb.2']]);
    expect(out.ok).toBe(true);
    expect(out.thread_ref).toBe(ref);
    // The raw id stays out of the answer when the caller used a ref.
    expect(out.threadId).toBeUndefined();
  });

  test('pages past the first 20 to find an older thread', async () => {
    const { list, markRead, calls, pagesRequested } = register([
      [{ id: 7, subject: 'a', latestMessage: { id: 'aaa.1' } }],
      [{ id: 8, subject: 'b', latestMessage: { id: 'bbb.2' } }],
      [{ id: 42, subject: 'c', latestMessage: { id: 'ccc.3' } }],
    ]);
    const ref = refOf(await list({ page: 2 }), 'c');
    pagesRequested.length = 0;
    await markRead({ thread_ref: ref });
    expect(pagesRequested).toEqual([0, 1, 2]);
    expect(calls).toEqual([[42, 'ccc.3']]);
  });

  test('stops paging when Aula says there are no more pages, and writes nothing', async () => {
    const { list, markRead, state, calls, pagesRequested } = register([
      [{ id: 42, subject: 'x', latestMessage: { id: 'xxx.1' } }],
    ]);
    const ref = refOf(await list(), 'x');
    // The thread has since dropped out of the listing.
    state.pages = [
      [{ id: 7, subject: 'a', latestMessage: { id: 'aaa.1' } }],
      [{ id: 8, subject: 'b', latestMessage: { id: 'bbb.2' } }],
    ];
    pagesRequested.length = 0;
    const out = await markRead({ thread_ref: ref });
    expect(pagesRequested).toEqual([0, 1]);
    expect(calls).toEqual([]);
    expect(out.error).toBe('message_id_unresolved');
  });

  test('reports message_id_unresolved rather than writing a bogus marker', async () => {
    const { list, markRead, calls } = register([[{ id: 42, subject: 'x' }]]);
    const out = await markRead({ thread_ref: refOf(await list(), 'x') });
    expect(calls).toEqual([]);
    expect(out.error).toBe('message_id_unresolved');
  });

  test('refuses a thread the listing marked sensitive, before any lookup', async () => {
    const { list, markRead, calls, pagesRequested } = register([
      [{ id: 42, subject: 'fortroligt', sensitive: true, latestMessage: { id: 'sss.1' } }],
    ]);
    const ref = refOf(await list(), 'fortroligt');
    pagesRequested.length = 0;
    const out = await markRead({ thread_ref: ref });
    expect(out.error).toBe('sensitive_thread');
    expect(calls).toEqual([]);
    expect(pagesRequested).toEqual([]);
  });

  test('refuses when the thread turns sensitive between listing and write', async () => {
    const { list, markRead, state, calls } = register([
      [{ id: 42, subject: 'x', latestMessage: { id: 'xxx.1' } }],
    ]);
    const ref = refOf(await list(), 'x');
    state.pages = [[{ id: 42, subject: 'x', sensitive: true, latestMessage: { id: 'xxx.1' } }]];
    const out = await markRead({ thread_ref: ref });
    expect(out.error).toBe('sensitive_thread');
    expect(calls).toEqual([]);
  });

  test('a legacy threadId works only once a listing has shown the thread', async () => {
    const { list, markRead, calls } = register([
      [{ id: 42, subject: 'x', latestMessage: { id: 'xxx.1' } }],
    ]);
    await expect(markRead({ threadId: 42 })).rejects.toThrow(/list_threads/);
    expect(calls).toEqual([]);
    await list();
    const out = await markRead({ threadId: 42 });
    expect(calls).toEqual([[42, 'xxx.1']]);
    expect(out.threadId).toBe(42);
  });

  test('is not registered without AULA_MCP_WRITE=1', () => {
    let seen = false;
    const server = {
      registerTool(name: string) {
        if (name === 'aula.messages.mark_read') seen = true;
      },
    };
    const previous = process.env.AULA_MCP_WRITE;
    delete process.env.AULA_MCP_WRITE;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: structural stub for McpServer
      registerTools(server as any, {} as any);
    } finally {
      if (previous !== undefined) process.env.AULA_MCP_WRITE = previous;
    }
    expect(seen).toBe(false);
  });
});

describe('htmlToText', () => {
  test('block-level tags become line breaks, inline markup is dropped', () => {
    expect(htmlToText('<p>Husk badetøj</p><p>og håndklæde</p>')).toBe('Husk badetøj\nog håndklæde');
    expect(htmlToText('Line one<br/>Line two')).toBe('Line one\nLine two');
    expect(htmlToText('<div><strong>Fed</strong> tekst</div>')).toBe('Fed tekst');
  });

  test('decodes the entities Aula actually emits', () => {
    expect(htmlToText('Mor &amp; far')).toBe('Mor & far');
    expect(htmlToText('a&nbsp;b')).toBe('a b');
    expect(htmlToText('&lt;ikke en tag&gt;')).toBe('<ikke en tag>');
  });

  test('collapses runs of blank lines and trims', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>')).toBe('a\n\nb');
  });

  test('empty content is empty, not "undefined"', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('slimPost', () => {
  test('keeps the fields a reader and get_attachment need', () => {
    const slim = slimPost({
      id: 42,
      title: 'Sommerfest',
      publishAt: '2026-06-01T10:00:00+02:00',
      isImportant: true,
      content: { html: '<p>Kom glad</p>' },
      ownerProfile: {
        fullName: 'Lærer Hansen',
        institution: { institutionName: 'Klub Solsikken' },
      },
      attachments: [
        { file: { name: 'plan.pdf', url: 'https://cdn/plan.pdf', mediaType: 'application/pdf' } },
      ],
    });

    expect(slim.id).toBe(42);
    expect(slim.title).toBe('Sommerfest');
    expect(slim.date).toBe('2026-06-01T10:00:00+02:00');
    expect(slim.author).toBe('Lærer Hansen');
    // institutionName is what tells school and club apart at a glance.
    expect(slim.institution).toBe('Klub Solsikken');
    expect(slim.isImportant).toBe(true);
    expect(slim.content).toBe('Kom glad');
    expect(slim.attachments?.[0]?.url).toBe('https://cdn/plan.pdf');
  });

  test('falls back to timestamp when publishAt is absent', () => {
    expect(slimPost({ timestamp: '2026-05-05T08:00:00Z' }).date).toBe('2026-05-05T08:00:00Z');
  });

  test('omits isImportant and attachments rather than emitting empty values', () => {
    const slim = slimPost({ id: 1, content: { html: '<p>hej</p>' } });
    expect('isImportant' in slim).toBe(false);
    expect('attachments' in slim).toBe(false);
  });

  test('drops attachments with no usable URL', () => {
    const slim = slimPost({
      id: 1,
      attachments: [{ name: 'ingen-url.pdf' }, { file: { name: 'ok.pdf', url: 'https://cdn/ok' } }],
    });
    expect(slim.attachments).toHaveLength(1);
    expect(slim.attachments?.[0]?.name).toBe('ok.pdf');
  });
});

// ---------------------------------------------------------------------------

/** A child entry shaped like Tabulex's, with an obviously fake CPR. */
function tabulexChild(overrides: Partial<TabulexChildAccess> = {}): TabulexChildAccess {
  return {
    fornavn: 'Barn',
    efternavn: 'Testesen',
    cpr: '0101209999',
    foedselsdato: '2020-01-01',
    klasse: '3A',
    skoleNavn: 'Testskolen',
    skoleKode: 'T1',
    skoleFravaerAdgang: true,
    skoleBestyrelsesValgAdgang: false,
    pige: false,
    // Tabulex's untouched response — the second place the CPR appears.
    raw: { Cpr: '0101209999', Fornavn: 'Barn', Noget: 'ukendt felt' },
    ...overrides,
  };
}

describe('Tabulex child refs — keeping CPR off the tool surface', () => {
  test('a child entry carries a ref and no CPR, in any field', () => {
    const refs = createTabulexChildRefs();
    const entry = refs.publicEntry(tabulexChild());

    expect(JSON.stringify(entry)).not.toContain('0101209999');
    expect(entry.child_ref).toMatch(/^tbx_/);
    expect(entry.cpr).toBeUndefined();
    expect(entry.raw).toBeUndefined();
  });

  test('the ref round-trips back to the CPR Tabulex needs', () => {
    const refs = createTabulexChildRefs();
    const entry = refs.publicEntry(tabulexChild());
    expect(refs.cprFor(entry.child_ref as string)).toBe('0101209999');
  });

  test('the same child keeps the same ref, different children do not share one', () => {
    const refs = createTabulexChildRefs();
    const first = refs.publicEntry(tabulexChild());
    const again = refs.publicEntry(tabulexChild());
    const sibling = refs.publicEntry(tabulexChild({ cpr: '0202215555', fornavn: 'Soskende' }));

    expect(again.child_ref).toBe(first.child_ref);
    expect(sibling.child_ref).not.toBe(first.child_ref);
    expect(refs.cprFor(sibling.child_ref as string)).toBe('0202215555');
  });

  test('refs from one server run mean nothing to another', () => {
    const first = createTabulexChildRefs();
    const entry = first.publicEntry(tabulexChild());
    const afterRestart = createTabulexChildRefs();

    expect(() => afterRestart.cprFor(entry.child_ref as string)).toThrow(/tabulex_boern/);
  });

  test('an unknown ref is refused rather than passed through as a CPR', () => {
    const refs = createTabulexChildRefs();
    expect(() => refs.cprFor('tbx_madeup')).toThrow(/Unknown child_ref/);
    // Nor may a caller smuggle a real CPR in through the ref parameter.
    expect(() => refs.cprFor('0101209999')).toThrow(/Unknown child_ref/);
  });

  test('fields with no role in absence reporting are withheld', () => {
    const entry = createTabulexChildRefs().publicEntry(tabulexChild());
    // A birth date is the first six digits of the CPR.
    expect(entry.foedselsdato).toBeUndefined();
    expect(entry.pige).toBeUndefined();
    expect(entry.skoleBestyrelsesValgAdgang).toBeUndefined();
    // What the model actually needs survives.
    expect(entry.fornavn).toBe('Barn');
    expect(entry.klasse).toBe('3A');
    expect(entry.skoleFravaerAdgang).toBe(true);
  });

  test('a child without a CPR gets no ref instead of a broken one', () => {
    // Omitted rather than set to undefined: `cpr?: string` under
    // exactOptionalPropertyTypes is "absent", not "present and undefined".
    const { cpr: _cpr, ...noCpr } = tabulexChild();
    const entry = createTabulexChildRefs().publicEntry(noCpr);
    expect(entry.child_ref).toBeUndefined();
    expect(entry.fornavn).toBe('Barn');
  });

  test('stripTabulexRaw drops the unfiltered passthrough but keeps the mapped fields', () => {
    const day = {
      dag: false,
      dato: '2026-09-10T00:00:00+02:00',
      note: null,
      aarsag: null,
      raw: { Dag: false, Cpr: '0101209999' },
    };
    const stripped = stripTabulexRaw(day);

    expect(JSON.stringify(stripped)).not.toContain('0101209999');
    expect('raw' in stripped).toBe(false);
    expect(stripped.dag).toBe(false);
    expect(stripped.dato).toBe('2026-09-10T00:00:00+02:00');
  });
});

describe('Tabulex failures — CPR stays out of the error the model sees', () => {
  // Review finding: a tool handler that throws has its message returned to the
  // client verbatim, and Tabulex errors embedded the request URL — CPR included.
  const leaky =
    'Tabulex GET https://foraeldre.tabulex.net/api/Fravaer/Idag/0101209999 failed (status 500)';

  test('redactCprFromError removes CPR-shaped numbers, dashed or not', () => {
    expect(redactCprFromError(new Error(leaky)).message).not.toContain('0101209999');
    expect(redactCprFromError('child 010120-9999 failed').message).not.toContain('010120-9999');
    expect(redactCprFromError(new Error(leaky)).message).toContain('status 500');
  });

  test('guardTabulex rewrites a thrown failure and passes successes through', async () => {
    const client = {
      async fail(): Promise<never> {
        throw new Error(leaky);
      },
      async ok(): Promise<string> {
        return 'fine';
      },
    };
    const guarded = guardTabulex(client);
    let message = '';
    try {
      await guarded.fail();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('status 500');
    expect(message).not.toContain('0101209999');
    expect(await guarded.ok()).toBe('fine');
  });
});

describe('parallel calendar events', () => {
  const lesson = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
    type: 'lesson',
    startDateTime: '2026-09-16T06:00:00.0000+00:00',
    endDateTime: '2026-09-16T07:30:00.0000+00:00',
    belongsToProfiles: [1000],
    ...over,
  });

  test('two entries in the same slot point at each other, and nothing is dropped', () => {
    const out = annotateParallelEvents([
      lesson({ id: 1, title: 'DAN' }),
      lesson({ id: 2, title: 'PÆD' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.parallelWith).toEqual([{ id: 2, title: 'PÆD' }]);
    expect(out[1]?.parallelWith).toEqual([{ id: 1, title: 'DAN' }]);
    // The original fields survive untouched — this annotates, it does not merge.
    expect(out[0]?.title).toBe('DAN');
  });

  test('a lesson that stands alone is left unannotated', () => {
    const out = annotateParallelEvents([
      lesson({ id: 1, title: 'DAN' }),
      lesson({
        id: 2,
        title: 'MAT',
        startDateTime: '2026-09-16T08:00:00.0000+00:00',
        endDateTime: '2026-09-16T09:00:00.0000+00:00',
      }),
    ]);
    expect(out[0]?.parallelWith).toBeUndefined();
    expect(out[1]?.parallelWith).toBeUndefined();
  });

  test('three in one slot each name the other two', () => {
    const out = annotateParallelEvents([
      lesson({ id: 1, title: 'DAN' }),
      lesson({ id: 2, title: 'PÆD' }),
      lesson({ id: 3, title: 'UDESK' }),
    ]);
    expect(out[0]?.parallelWith).toHaveLength(2);
    expect(out[2]?.parallelWith).toEqual([
      { id: 1, title: 'DAN' },
      { id: 2, title: 'PÆD' },
    ]);
  });

  test('two children with class at the same time are NOT parallel', () => {
    // Conflating them would be a false claim about the data, not a display choice.
    const out = annotateParallelEvents([
      lesson({ id: 1, title: 'DAN', belongsToProfiles: [1000] }),
      lesson({ id: 2, title: 'MAT', belongsToProfiles: [1001] }),
    ]);
    expect(out[0]?.parallelWith).toBeUndefined();
    expect(out[1]?.parallelWith).toBeUndefined();
  });

  test('entries that belong to no child are never grouped', () => {
    const out = annotateParallelEvents([
      lesson({ id: 1, title: 'A', belongsToProfiles: [] }),
      lesson({ id: 2, title: 'B', belongsToProfiles: [] }),
    ]);
    expect(out[0]?.parallelWith).toBeUndefined();
    expect(out[1]?.parallelWith).toBeUndefined();
  });
});
