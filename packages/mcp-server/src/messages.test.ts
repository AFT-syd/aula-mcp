/**
 * Tests for the message-reading tools after the 2026-10-10 rework.
 *
 * What these pin down, all measured against the live API before being built:
 *  - A thread carries two different ids. Reading takes `id`; replying takes
 *    `subscriptionId`. The model only ever sees an opaque `thread_ref`.
 *  - The raw listing was ~5.7 KB per thread, half of it other families'
 *    names and read receipts, plus signed profile-picture URLs. The listing
 *    is now an allowlist.
 *  - Aula ignores `pageSize` and fixes the page at 20.
 *
 * Every thread, name and id below is a fixture invented for this file.
 */

import { describe, expect, test } from 'bun:test';
import type { AulaClient, MessageThread } from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import { createThreadRefs, previewFromHtml, projectThread, registerTools } from './tools.ts';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function fakeServer(): { tools: Map<string, ToolHandler>; registerTool: unknown } {
  const tools = new Map<string, ToolHandler>();
  return {
    tools,
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
}

function textOf(result: { content: Array<{ type: string; text: string }> }): unknown {
  const first = result.content[0];
  if (!first) throw new Error('expected content[0]');
  return JSON.parse(first.text);
}

/** A thread shaped like the live response, including the parts that must
 *  NOT reach the model. */
function rawThread(over: Partial<MessageThread> = {}): MessageThread {
  return {
    id: 1001,
    subscriptionId: 9001,
    subscriptionType: 'unbundled',
    read: false,
    subject: 'Tur til skoven',
    startedTime: '2026-10-09T07:00:00+00:00',
    creator: {
      fullName: 'Lærer Testesen',
      mailBoxOwner: { id: 5, profileId: 50, portalRole: 'employee' },
    },
    regardingChildren: [
      {
        profileId: 77,
        displayName: 'Barn Fixture',
        shortName: 'BF',
        // The live shape carries a signed media URL here.
        ...({
          profilePicture: { url: 'https://media.example/x.jpg?Expires=1&Signature=SECRETSIG' },
        } as object),
      },
    ],
    recipients: [
      {
        fullName: 'Anden Forælder',
        lastReadTimestamp: '2026-10-09T18:12:00+00:00',
        lastReadMessageId: 'm-1',
        mailBoxOwner: { id: 6, profileId: 60, portalRole: 'guardian' },
      },
      { fullName: 'Tredje Forælder', lastReadTimestamp: '2026-10-09T19:00:00+00:00' },
    ],
    extraRecipientsCount: 4,
    latestMessage: {
      id: 'm-2',
      sendDateTime: '2026-10-09T08:00:00+00:00',
      text: { html: '<p>Husk madpakke</p><p>og gummist&oslash;vler</p>' },
    },
    ...over,
  };
}

interface Calls {
  threadsPage: Array<Record<string, unknown>>;
  messagesFor: number[];
}

/** `pages[n]` is what getThreadsPage({ page: n }) returns. A single array is
 *  one page with nothing after it. */
function fakeContext(pages: MessageThread[] | MessageThread[][]): {
  context: AulaContext;
  calls: Calls;
} {
  const paged: MessageThread[][] = Array.isArray(pages[0])
    ? (pages as MessageThread[][])
    : [pages as MessageThread[]];
  const calls: Calls = { threadsPage: [], messagesFor: [] };
  const client = {
    async getThreadsPage(opts: Record<string, unknown>) {
      calls.threadsPage.push(opts);
      const n = typeof opts.page === 'number' ? opts.page : 0;
      return { threads: paged[n] ?? [], page: n, hasMorePages: n + 1 < paged.length };
    },
    async getMessagesForThread(id: number) {
      calls.messagesFor.push(id);
      return { messages: [], subject: 'x' };
    },
  } as unknown as AulaClient;
  const context = {
    async getClient() {
      return client;
    },
    async getGuardianUserId() {
      return 'g-1';
    },
  } as unknown as AulaContext;
  return { context, calls };
}

function tools(pages: MessageThread[] | MessageThread[][]) {
  const srv = fakeServer();
  const { context, calls } = fakeContext(pages);
  registerTools(srv as unknown as McpServer, context);
  const get = (name: string): ToolHandler => {
    const h = srv.tools.get(name);
    if (!h) throw new Error(`${name} was not registered`);
    return h;
  };
  return { get, calls };
}

describe('thread_ref — one handle instead of two ids', () => {
  test('the same thread always gets the same ref, and resolves to both ids', () => {
    const refs = createThreadRefs();
    const a = refs.refFor({ id: 1001, subscriptionId: 9001 });
    expect(refs.refFor({ id: 1001, subscriptionId: 9001 })).toBe(a);
    expect(a).toMatch(/^thr_/);
    expect(refs.resolve(a)).toMatchObject({ id: 1001, subscriptionId: 9001, sensitive: false });
  });

  test('a later listing fills in a subscriptionId an earlier one lacked', () => {
    const refs = createThreadRefs();
    const ref = refs.refFor({ id: 1001 });
    refs.refFor({ id: 1001, subscriptionId: 9001 });
    expect(refs.resolve(ref).subscriptionId).toBe(9001);
  });

  test('sensitivity follows the latest listing — a thread can become sensitive', () => {
    const refs = createThreadRefs();
    const ref = refs.refFor({ id: 1001, subscriptionId: 9001 });
    refs.refFor({ id: 1001, subscriptionId: 9001, sensitive: true });
    expect(refs.resolve(ref).sensitive).toBe(true);
    expect(refs.byThreadId(1001)?.sensitive).toBe(true);
  });

  test('an unknown ref is rejected with a pointer back to the listing', () => {
    expect(() => createThreadRefs().resolve('thr_nope')).toThrow(/list_threads/);
  });
});

describe('previewFromHtml', () => {
  test('block boundaries become spaces instead of gluing words together', () => {
    // This is the test that catches a silent regex failure: had the `\b` in
    // the tag pattern been written as a literal backspace (it was, once,
    // through a Python escape), no tag would match and this would read
    // "Husk madpakkeog gummistøvler".
    expect(previewFromHtml('<p>Husk madpakke</p><p>og gummistøvler</p>')).toBe(
      'Husk madpakke og gummistøvler',
    );
  });

  test('entities are decoded and <br> splits lines', () => {
    expect(previewFromHtml('Hej&nbsp;alle<br/>Mvh &amp; tak')).toBe('Hej alle Mvh & tak');
  });

  test('long text is truncated with an ellipsis', () => {
    const out = previewFromHtml(`<p>${'a'.repeat(500)}</p>`, 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });

  test('no body means an empty preview, not "undefined"', () => {
    expect(previewFromHtml(undefined)).toBe('');
  });
});

describe('projectThread — the listing is an allowlist', () => {
  test('keeps what an inbox needs', () => {
    const out = projectThread(rawThread(), createThreadRefs());
    expect(out).toMatchObject({
      subject: 'Tur til skoven',
      unread: true,
      startedBy: 'Lærer Testesen',
      startedByRole: 'employee',
      regardingChildren: ['Barn Fixture'],
      latest: { sentAt: '2026-10-09T08:00:00+00:00', preview: 'Husk madpakke og gummistøvler' },
      // 2 listed + 4 extra
      recipientCount: 6,
    });
    expect(out.thread_ref).toMatch(/^thr_/);
  });

  test("drops other families' names, read receipts and signed URLs", () => {
    const json = JSON.stringify(projectThread(rawThread(), createThreadRefs()));
    expect(json).not.toContain('Anden Forælder');
    expect(json).not.toContain('Tredje Forælder');
    expect(json).not.toContain('lastReadTimestamp');
    expect(json).not.toContain('Signature=');
    expect(json).not.toContain('SECRETSIG');
  });

  test('exposes neither raw id — only the thread_ref', () => {
    const out = projectThread(rawThread(), createThreadRefs()) as Record<string, unknown>;
    expect(out.id).toBeUndefined();
    expect(out.subscriptionId).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('9001');
  });

  test('is a fraction of the raw size', () => {
    const raw = JSON.stringify(rawThread()).length;
    const projected = JSON.stringify(projectThread(rawThread(), createThreadRefs())).length;
    expect(projected).toBeLessThan(raw);
  });
});

describe('aula.messages.list_threads', () => {
  test("maps unread_only and child_ids to Aula's filters", async () => {
    const { get, calls } = tools([rawThread()]);
    await get('aula.messages.list_threads')({ unread_only: true, child_ids: [6460000] });
    expect(calls.threadsPage[0]).toEqual({ filterOn: 'Unread', activeChildren: [6460000] });
  });

  test('sends no filters when none are asked for', async () => {
    const { get, calls } = tools([rawThread()]);
    await get('aula.messages.list_threads')({});
    expect(calls.threadsPage[0]).toEqual({});
  });

  test('returns projected threads with a page marker', async () => {
    const { get } = tools([rawThread()]);
    const data = textOf(await get('aula.messages.list_threads')({})) as {
      page: number;
      threads: Array<Record<string, unknown>>;
    };
    expect(data.page).toBe(0);
    expect(data.threads).toHaveLength(1);
    expect(data.threads[0]?.thread_ref).toMatch(/^thr_/);
    expect(JSON.stringify(data)).not.toContain('lastReadTimestamp');
  });
});

describe('aula.messages.get_thread — thread_ref resolves to the READ id', () => {
  test('a thread_ref from the listing reads the thread by `id`, not `subscriptionId`', async () => {
    // The whole reason thread_ref exists. getMessagesForThread takes `id`;
    // passing subscriptionId would read nothing or the wrong thread.
    const { get, calls } = tools([rawThread({ id: 1001, subscriptionId: 9001 })]);
    const list = textOf(await get('aula.messages.list_threads')({})) as {
      threads: Array<{ thread_ref: string }>;
    };
    const ref = list.threads[0]?.thread_ref;
    await get('aula.messages.get_thread')({ thread_ref: ref });
    expect(calls.messagesFor).toEqual([1001]);
  });

  test('a legacy threadId still works once a listing has shown the thread', async () => {
    const { get, calls } = tools([rawThread({ id: 4242, subscriptionId: 9242 })]);
    await get('aula.messages.list_threads')({});
    await get('aula.messages.get_thread')({ threadId: 4242 });
    expect(calls.messagesFor).toEqual([4242]);
  });

  test('a legacy threadId no listing has shown is refused before fetching', async () => {
    // Without a listing nobody has said whether the thread is sensitive.
    const { get, calls } = tools([]);
    await expect(get('aula.messages.get_thread')({ threadId: 4242 })).rejects.toThrow(
      /list_threads first/,
    );
    expect(calls.messagesFor).toEqual([]);
  });

  test('neither given is an error, not a silent no-op', async () => {
    const { get } = tools([]);
    await expect(get('aula.messages.get_thread')({})).rejects.toThrow(/thread_ref/);
  });

  test('a thread_ref from another session is rejected', async () => {
    const { get } = tools([]);
    await expect(get('aula.messages.get_thread')({ thread_ref: 'thr_stale' })).rejects.toThrow(
      /list_threads/,
    );
  });
});

describe('aula.messages.get_attachment — reachable from a thread_ref', () => {
  test('resolves the thread_ref to `id` before fetching the thread', async () => {
    // Without this the listing, which no longer exposes raw ids, would be a
    // dead end for attachments.
    const { get, calls } = tools([rawThread({ id: 1001, subscriptionId: 9001 })]);
    const list = textOf(await get('aula.messages.list_threads')({})) as {
      threads: Array<{ thread_ref: string }>;
    };
    const out = textOf(
      await get('aula.messages.get_attachment')({
        thread_ref: list.threads[0]?.thread_ref,
        attachmentIndex: 0,
      }),
    ) as { error?: string };
    expect(calls.messagesFor).toEqual([1001]);
    // The fixture thread has no attachments — the point is which id was used.
    expect(out.error).toBe('attachment_not_found');
  });
});

describe('aula.messages.new_since — built on getThreads, not getNewThreads', () => {
  /** A thread whose latest message arrived at `at` (UTC ISO). */
  function at(id: number, iso: string): MessageThread {
    return rawThread({
      id,
      subscriptionId: 9000 + id,
      latestMessage: { id: `m-${id}`, sendDateTime: iso, text: { html: `<p>t${id}</p>` } },
    });
  }
  type Out = { since: string; truncated?: boolean; threads: Array<{ thread_ref: string }> };

  test('finds threads whose latest message is after `since` (the live false negative)', async () => {
    // Reproduces the 2026-10-10 live failure in shape: activity the day after
    // `since` exists. The old implementation asked getNewThreads and got [];
    // this one must find both newer threads and leave out the older one.
    const { get } = tools([
      at(1, '2026-10-09T14:58:20+00:00'),
      at(2, '2026-10-09T07:07:56+00:00'),
      at(3, '2026-10-08T07:53:08+00:00'),
    ]);
    const data = textOf(
      await get('aula.messages.new_since')({ since: '2026-10-09T00:00:00+02:00' }),
    ) as Out;
    expect(data.threads).toHaveLength(2);
    expect(data.truncated).toBeUndefined();
  });

  test('`since` is compared as an instant, offset included', async () => {
    // 08:30 UTC is 10:30 in Copenhagen — after 10:00+02:00, before 11:00+02:00.
    const { get } = tools([at(1, '2026-10-09T08:30:00+00:00')]);
    const after = textOf(
      await get('aula.messages.new_since')({ since: '2026-10-09T10:00:00+02:00' }),
    ) as Out;
    expect(after.threads).toHaveLength(1);
    const { get: get2 } = tools([at(1, '2026-10-09T08:30:00+00:00')]);
    const before = textOf(
      await get2('aula.messages.new_since')({ since: '2026-10-09T11:00:00+02:00' }),
    ) as Out;
    expect(before.threads).toHaveLength(0);
  });

  test('walks to the next page while a whole page is newer, and stops at the first older one', async () => {
    const { get, calls } = tools([
      [at(1, '2026-10-09T12:00:00+00:00'), at(2, '2026-10-09T11:00:00+00:00')],
      [at(3, '2026-10-09T10:00:00+00:00'), at(4, '2026-10-01T10:00:00+00:00')],
      [at(5, '2026-09-01T10:00:00+00:00')],
    ]);
    const data = textOf(
      await get('aula.messages.new_since')({ since: '2026-10-05T00:00:00+02:00' }),
    ) as Out;
    expect(data.threads).toHaveLength(3);
    // Page 2 (index 2) is never fetched: page 1 already held an older thread.
    expect(calls.threadsPage.map((c) => c.page)).toEqual([0, 1]);
  });

  test('reports truncated instead of pretending to be complete', async () => {
    const recent = (p: number) => [0, 1].map((i) => at(p * 10 + i, '2026-10-09T12:00:00+00:00'));
    const { get } = tools([recent(0), recent(1), recent(2), recent(3), recent(4), recent(5)]);
    const data = textOf(
      await get('aula.messages.new_since')({ since: '2026-10-01T00:00:00+02:00' }),
    ) as Out;
    expect(data.truncated).toBe(true);
    expect(data.threads).toHaveLength(10);
  });

  test('passes child_ids through as the per-child filter', async () => {
    const { get, calls } = tools([at(1, '2026-10-09T12:00:00+00:00')]);
    await get('aula.messages.new_since')({
      since: '2026-10-09T00:00:00+02:00',
      child_ids: [6460000],
    });
    expect(calls.threadsPage[0]).toEqual({ page: 0, activeChildren: [6460000] });
  });

  test('projects like the listing and issues refs that work in get_thread', async () => {
    const { get, calls } = tools([at(1001, '2026-10-09T12:00:00+00:00')]);
    const data = textOf(
      await get('aula.messages.new_since')({ since: '2026-10-09T00:00:00+02:00' }),
    ) as Out;
    expect(JSON.stringify(data)).not.toContain('Anden Forælder');
    await get('aula.messages.get_thread')({ thread_ref: data.threads[0]?.thread_ref });
    expect(calls.messagesFor).toEqual([1001]);
  });
});
