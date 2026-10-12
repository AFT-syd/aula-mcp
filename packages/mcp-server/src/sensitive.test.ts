/**
 * Tests for sensitive threads as a category of their own.
 *
 * What these pin down:
 *  - The listing shows a sensitive thread by subject and flag, never its text.
 *  - The ordinary message tools refuse it BEFORE fetching anything.
 *  - Reading goes through aula.sensitive.prepare_read (opens nothing) and
 *    aula.sensitive.read_thread (one-use permit).
 *  - Replying never opens the thread; confirmation comes from the listing.
 *
 * Every thread, name and id below is a fixture invented for this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AulaClient, MessageThread, ThreadMessage } from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import { findReplyInListing } from './replies.ts';
import { createThreadRefs, projectThread, registerTools } from './tools.ts';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function textOf(result: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first) throw new Error('expected content[0]');
  return JSON.parse(first.text) as Record<string, unknown>;
}

const SECRET = 'Fortroligt indhold om barnet';
const SENSITIVE_SUBJECT = 'Samtale om trivsel';
const ORDINARY_SUBJECT = 'Tur til skoven';

const SENSITIVE: MessageThread = {
  id: 2002,
  subscriptionId: 8002,
  read: false,
  subject: SENSITIVE_SUBJECT,
  sensitive: true,
  recipients: [{ fullName: 'Lærer Testesen' }, { fullName: 'Anden Voksen' }],
  latestMessage: {
    id: 'm-old',
    sendDateTime: '2026-10-09T08:00:00+00:00',
    text: { html: `<p>${SECRET}</p>` },
  },
};

const ORDINARY: MessageThread = {
  id: 1001,
  subscriptionId: 9001,
  read: true,
  subject: ORDINARY_SUBJECT,
  recipients: [{ fullName: 'Lærer Testesen' }],
};

interface Fake {
  /** Listing per getThreadsPage call, in order; the last one repeats. */
  listings: MessageThread[][];
  replyResult?: ThreadMessage | Error;
}

function setup(fake: Fake) {
  const calls = {
    listings: 0,
    messagesFor: [] as number[],
    threadData: [] as number[],
    replies: [] as Array<Record<string, unknown>>,
  };
  const client = {
    async getThreadsPage() {
      const i = Math.min(calls.listings, fake.listings.length - 1);
      calls.listings += 1;
      return { threads: fake.listings[i] ?? [], page: 0, hasMorePages: false };
    },
    async getMessagesForThread(id: number) {
      calls.messagesFor.push(id);
      return { subject: 'x', messages: [{ text: { html: `<p>${SECRET}</p>` } }] };
    },
    async getThreadData(id: number) {
      calls.threadData.push(id);
      return { id: 8002, messages: [] };
    },
    async replyToThread(args: Record<string, unknown>) {
      calls.replies.push(args);
      if (fake.replyResult instanceof Error) throw fake.replyResult;
      return fake.replyResult;
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
  const tools = new Map<string, ToolHandler>();
  registerTools(
    {
      registerTool: (name: string, _c: unknown, h: ToolHandler) => tools.set(name, h),
    } as unknown as McpServer,
    context,
  );
  const get = (name: string): ToolHandler => {
    const h = tools.get(name);
    if (!h) throw new Error(`${name} was not registered`);
    return h;
  };
  /** Lists once and returns the ref for the thread with this subject. */
  const refFor = async (subject: string): Promise<string> => {
    const listing = textOf(await get('aula.messages.list_threads')({})) as {
      threads: Array<{ thread_ref: string; subject?: string }>;
    };
    const ref = listing.threads.find((t) => t.subject === subject)?.thread_ref;
    if (!ref) throw new Error(`no thread "${subject}" in listing`);
    return ref;
  };
  /** Nothing has opened any thread. */
  const opened = () => [...calls.messagesFor, ...calls.threadData];
  return { get, calls, refFor, opened, tools };
}

describe('listing — sensitive threads by subject only', () => {
  test('subject, flag and time stay; the text does not', () => {
    const out = projectThread(SENSITIVE, createThreadRefs());
    expect(out).toMatchObject({
      subject: 'Samtale om trivsel',
      sensitive: true,
      latest: { sentAt: '2026-10-09T08:00:00+00:00' },
    });
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('an ordinary thread keeps its preview', () => {
    const out = projectThread(
      { ...ORDINARY, latestMessage: { text: { html: '<p>Husk madpakke</p>' } } },
      createThreadRefs(),
    );
    expect(out.latest).toMatchObject({ preview: 'Husk madpakke' });
  });
});

describe('ordinary message tools refuse sensitive threads before fetching', () => {
  test('get_thread', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const out = textOf(
      await s.get('aula.messages.get_thread')({ thread_ref: await s.refFor(SENSITIVE_SUBJECT) }),
    );
    expect(out.error).toBe('sensitive_thread');
    expect(s.opened()).toEqual([]);
  });

  test('get_thread by a legacy raw id', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    await s.refFor(SENSITIVE_SUBJECT);
    const out = textOf(await s.get('aula.messages.get_thread')({ threadId: 2002 }));
    expect(out.error).toBe('sensitive_thread');
    expect(s.opened()).toEqual([]);
  });

  test('get_attachment', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const out = textOf(
      await s.get('aula.messages.get_attachment')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        attachmentIndex: 0,
      }),
    );
    expect(out.error).toBe('sensitive_thread');
    expect(s.opened()).toEqual([]);
  });
});

describe('aula.sensitive.prepare_read / read_thread — the read gate', () => {
  test('prepare opens nothing and returns only the subject', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const out = textOf(
      await s.get('aula.sensitive.prepare_read')({ thread_ref: await s.refFor(SENSITIVE_SUBJECT) }),
    );
    expect(out.read_ref).toMatch(/^rd_/);
    expect(out.subject).toBe('Samtale om trivsel');
    expect(s.opened()).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  test('read_thread opens by the thread id, once', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const { read_ref } = textOf(
      await s.get('aula.sensitive.prepare_read')({ thread_ref: await s.refFor(SENSITIVE_SUBJECT) }),
    );
    const out = await s.get('aula.sensitive.read_thread')({ read_ref });
    expect(JSON.stringify(textOf(out))).toContain(SECRET);
    expect(s.calls.messagesFor).toEqual([2002]);
    await expect(s.get('aula.sensitive.read_thread')({ read_ref })).rejects.toThrow(
      /already been used/,
    );
    expect(s.calls.messagesFor).toEqual([2002]);
  });

  test('an invented read_ref opens nothing', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    await expect(s.get('aula.sensitive.read_thread')({ read_ref: 'rd_invented' })).rejects.toThrow(
      /prepare_read first/,
    );
    expect(s.opened()).toEqual([]);
  });

  test('an ordinary thread is pointed back to the ordinary tools', async () => {
    const s = setup({ listings: [[ORDINARY]] });
    const out = textOf(
      await s.get('aula.sensitive.prepare_read')({ thread_ref: await s.refFor(ORDINARY_SUBJECT) }),
    );
    expect(out.error).toBe('not_sensitive');
  });
});

describe('replying in a sensitive thread — never opens it', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.AULA_MCP_WRITE;
    process.env.AULA_MCP_WRITE = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AULA_MCP_WRITE;
    else process.env.AULA_MCP_WRITE = original;
  });

  test('the ordinary prepare_reply refuses before fetching', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const out = textOf(
      await s.get('aula.messages.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Hej',
      }),
    );
    expect(out.error).toBe('sensitive_thread');
    expect(s.opened()).toEqual([]);
  });

  test('prepare builds the preview from the listing', async () => {
    const s = setup({ listings: [[SENSITIVE]] });
    const out = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Tak',
      }),
    );
    expect(out.draft_ref).toMatch(/^dft_/);
    expect(out.preview).toEqual({
      subject: 'Samtale om trivsel',
      recipientCount: 2,
      recipients: ['Lærer Testesen', 'Anden Voksen'],
      text: 'Tak',
      charCount: 3,
    });
    expect(s.opened()).toEqual([]);
    expect(s.calls.replies).toHaveLength(0);
  });

  test('an ordinary thread is refused by the sensitive tools', async () => {
    const s = setup({ listings: [[ORDINARY]] });
    const out = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(ORDINARY_SUBJECT),
        text: 'Tak',
      }),
    );
    expect(out.error).toBe('not_sensitive');
  });

  test('send posts to the thread id — never subscriptionId — verified from the listing', async () => {
    const after: MessageThread = {
      ...SENSITIVE,
      latestMessage: { id: 'm-new', sendDateTime: '2099-01-01T00:00:00+00:00' },
    };
    const s = setup({ listings: [[SENSITIVE], [after]], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Tak',
      }),
    );
    const out = textOf(await s.get('aula.sensitive.send_reply')({ draft_ref }));
    // SENSITIVE has subscriptionId 8002; it must not appear.
    expect(s.calls.replies).toEqual([{ threadId: 2002, html: '<p>Tak</p>' }]);
    expect(out).toMatchObject({
      upstream: { ok: true, messageId: 'm-new' },
      stateRead: true,
      verified: true,
      observed: { threadOnFirstPage: true, activityAfterSend: true },
    });
    expect(s.opened()).toEqual([]);
  });

  test('newer activity without the reply id is not verified', async () => {
    const after: MessageThread = {
      ...SENSITIVE,
      latestMessage: { id: 'm-other', sendDateTime: '2099-01-01T00:00:00+00:00' },
    };
    const s = setup({ listings: [[SENSITIVE], [after]], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Tak',
      }),
    );
    const out = textOf(await s.get('aula.sensitive.send_reply')({ draft_ref }));
    expect(out).toMatchObject({ verified: false, observed: { activityAfterSend: true } });
    expect(out.warning).toMatch(/Do not send again/);
  });

  test('the send result never carries the thread text', async () => {
    const s = setup({ listings: [[SENSITIVE]], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Tak',
      }),
    );
    const out = await s.get('aula.sensitive.send_reply')({ draft_ref });
    expect(JSON.stringify(textOf(out))).not.toContain(SECRET);
  });

  test('drafts do not cross between the ordinary and the sensitive send', async () => {
    const s = setup({ listings: [[SENSITIVE]], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.sensitive.prepare_reply')({
        thread_ref: await s.refFor(SENSITIVE_SUBJECT),
        text: 'Tak',
      }),
    );
    await expect(s.get('aula.messages.send_reply')({ draft_ref })).rejects.toThrow(
      /Unknown draft_ref/,
    );
    expect(s.calls.replies).toHaveLength(0);
  });

  test('sensitive reply tools are not registered without AULA_MCP_WRITE=1', () => {
    delete process.env.AULA_MCP_WRITE;
    const s = setup({ listings: [[SENSITIVE]] });
    expect(s.tools.has('aula.sensitive.prepare_reply')).toBe(false);
    expect(s.tools.has('aula.sensitive.send_reply')).toBe(false);
    // Reading stays available — it is gated by the permit, not the write flag.
    expect(s.tools.has('aula.sensitive.prepare_read')).toBe(true);
  });
});

describe('findReplyInListing', () => {
  test('a thread missing from the page is not listed and not verified', () => {
    expect(findReplyInListing([ORDINARY], 2002, { id: 'm-new' }, 0)).toEqual({
      listed: false,
      verified: false,
      activityAfterSend: false,
    });
  });

  test('no id from Aula can never verify', () => {
    const t = {
      ...SENSITIVE,
      latestMessage: { id: 'm-new', sendDateTime: '2099-01-01T00:00:00Z' },
    };
    expect(findReplyInListing([t], 2002, undefined, 0).verified).toBe(false);
  });
});
