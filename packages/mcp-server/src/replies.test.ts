/**
 * Tests for replying in an existing thread.
 *
 * What these pin down:
 *  - Nothing is sent without a server-issued draft, and a draft sends once.
 *  - The reply goes to the thread's `id`, and only when the listing and the
 *    opened thread agree on it — the listing's `subscriptionId` is never used
 *    (believed otherwise at first; the live cross-check refused, 2026-10-10).
 *  - `verified` comes from reading the thread back, not from Aula's answer.
 *
 * Every thread, name and id below is a fixture invented for this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  AulaClient,
  MessageThread,
  ThreadMessage,
  ThreadMessagesData,
} from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import {
  buildReplyPreview,
  createReplyDrafts,
  findPostedReply,
  type ReplyDraft,
  resolveReplyTarget,
  textToHtml,
} from './replies.ts';
import { registerTools } from './tools.ts';

describe('textToHtml', () => {
  test('escapes markup so text cannot inject HTML', () => {
    expect(textToHtml('a < b & "c" > d')).toBe('<p>a &lt; b &amp; &quot;c&quot; &gt; d</p>');
  });

  test('blank lines become paragraphs, single newlines <br>, CRLF included', () => {
    expect(textToHtml('Hej\r\nmed dig\r\n\r\nMvh\nAnne')).toBe(
      '<p>Hej<br>med dig</p><p>Mvh<br>Anne</p>',
    );
  });
});

describe('resolveReplyTarget — the number a reply goes to', () => {
  const thread = (over: Partial<ThreadMessagesData> = {}): ThreadMessagesData => ({
    id: 1001,
    messages: [],
    ...over,
  });

  test('listing and opened thread agree → the thread id', () => {
    // The live shape: the opened object's id is the listing's thread id.
    expect(resolveReplyTarget({ id: 1001 }, thread())).toEqual({ ok: true, threadId: 1001 });
  });

  test('disagreement is refused and reports both numbers', () => {
    const out = resolveReplyTarget({ id: 1001 }, thread({ id: 9001 }));
    expect(out).toMatchObject({
      ok: false,
      error: 'thread_id_mismatch',
      listing: 1001,
      thread: 9001,
    });
  });

  test('a thread without an id is a mismatch, not a match', () => {
    const { id: _id, ...noId } = thread();
    expect(resolveReplyTarget({ id: 1001 }, noId)).toMatchObject({
      ok: false,
      error: 'thread_id_mismatch',
      thread: null,
    });
  });

  test('left, sensitive and shared-inbox threads are refused', () => {
    const addr = { id: 1001 };
    expect(resolveReplyTarget(addr, thread({ leaveTime: '2026-10-01T10:00:00Z' }))).toMatchObject({
      error: 'left_thread',
    });
    expect(resolveReplyTarget(addr, thread({ sensitive: true }))).toMatchObject({
      error: 'sensitive_thread',
    });
    expect(
      resolveReplyTarget(addr, thread({ mailBoxOwner: { mailBoxOwnerType: 'commonInbox' } })),
    ).toMatchObject({ error: 'shared_inbox' });
    expect(
      resolveReplyTarget(
        addr,
        thread({ mailBoxOwner: { mailBoxOwnerType: 'institutionProfile' } }),
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('buildReplyPreview', () => {
  test('counts everyone, lists names, and says how many are not listed', () => {
    const p = buildReplyPreview(
      {
        messages: [],
        subject: 'Tur',
        recipients: [{ fullName: 'Lærer Testesen' }, { fullName: 'Anden Forælder' }],
        extraRecipientsCount: 3,
      },
      'Hej',
    );
    expect(p).toEqual({
      subject: 'Tur',
      recipientCount: 5,
      recipients: ['Lærer Testesen', 'Anden Forælder'],
      moreRecipients: 3,
      text: 'Hej',
      charCount: 3,
    });
  });
});

describe('reply drafts — strukturel bekræftelse', () => {
  const draft: ReplyDraft = {
    address: { id: 1001 },
    threadId: 1001,
    html: '<p>Hej</p>',
    preview: buildReplyPreview({ messages: [] }, 'Hej'),
  };

  test('a draft is taken once; the second take says it was used', () => {
    const drafts = createReplyDrafts();
    const { draft_ref, expires_in_s } = drafts.create(draft);
    expect(draft_ref).toMatch(/^dft_/);
    expect(expires_in_s).toBe(300);
    expect(drafts.take(draft_ref)).toBe(draft);
    expect(() => drafts.take(draft_ref)).toThrow(/already been used/);
  });

  test('an expired draft is refused, and stays refused', () => {
    let t = 0;
    const drafts = createReplyDrafts({ now: () => t });
    const { draft_ref } = drafts.create(draft);
    t = 300_000;
    expect(() => drafts.take(draft_ref)).toThrow(/expired/);
    expect(() => drafts.take(draft_ref)).toThrow(/already been used/);
  });

  test('just inside the lifetime still works', () => {
    let t = 0;
    const drafts = createReplyDrafts({ now: () => t });
    const { draft_ref } = drafts.create(draft);
    t = 299_999;
    expect(drafts.take(draft_ref)).toBe(draft);
  });

  test('an invented ref is unknown', () => {
    expect(() => createReplyDrafts().take('dft_madeup')).toThrow(/prepare_reply first/);
  });
});

describe('findPostedReply', () => {
  const sentAfter = Date.parse('2026-10-10T20:00:00Z');
  const html = '<p>Tak for info</p>';

  test('matches by the id Aula returned', () => {
    const msgs: ThreadMessage[] = [
      { id: 'm-9', text: { html: '<div>noget andet</div>' }, sendDateTime: '2026-10-10T20:00:05Z' },
    ];
    expect(findPostedReply(msgs, { id: 'm-9' }, html, sentAfter)).toMatchObject({
      matchedBy: 'id',
    });
  });

  test('without an id, matches identical text sent after the request', () => {
    const msgs: ThreadMessage[] = [
      { text: { html: '<div>Tak for info</div>' }, sendDateTime: '2026-10-10T20:00:05Z' },
    ];
    expect(findPostedReply(msgs, undefined, html, sentAfter)).toMatchObject({
      matchedBy: 'text',
    });
  });

  test('the same text sent earlier is not taken as the reply', () => {
    const msgs: ThreadMessage[] = [
      { text: { html: '<p>Tak for info</p>' }, sendDateTime: '2026-10-09T08:00:00Z' },
    ];
    expect(findPostedReply(msgs, undefined, html, sentAfter)).toBeNull();
  });

  test('someone else writing in the thread right after is not taken as the reply', () => {
    const msgs: ThreadMessage[] = [
      { id: 'm-5', text: { html: '<p>Et andet svar</p>' }, sendDateTime: '2026-10-10T20:00:03Z' },
    ];
    expect(findPostedReply(msgs, undefined, html, sentAfter)).toBeNull();
  });

  test('an id that is not in the thread falls back to text, then to null', () => {
    expect(findPostedReply([], { id: 'm-9' }, html, sentAfter)).toBeNull();
  });

  test('a message that was already there before sending never confirms by text', () => {
    // Inside the clock-skew window, identical text — but it predates the send.
    const msgs: ThreadMessage[] = [
      { id: 'm-1', text: { html: '<p>Tak for info</p>' }, sendDateTime: '2026-10-10T19:59:40Z' },
    ];
    expect(findPostedReply(msgs, undefined, html, sentAfter)).not.toBeNull();
    expect(findPostedReply(msgs, undefined, html, sentAfter, new Set(['m-1']))).toBeNull();
    const fresh = [{ ...msgs[0], id: 'm-2' }] as ThreadMessage[];
    expect(findPostedReply(fresh, undefined, html, sentAfter, new Set(['m-1']))).toMatchObject({
      matchedBy: 'text',
    });
  });
});

// --- the tools ------------------------------------------------------------

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

const LISTED: MessageThread = {
  id: 1001,
  subscriptionId: 9001,
  read: true,
  subject: 'Spørgsmål om tur',
  recipients: [{ fullName: 'Lærer Testesen' }],
};

interface ReplyFake {
  /** What each getThreadData call returns, in order; the last one repeats. */
  threadReads: Array<ThreadMessagesData | Error>;
  replyResult?: ThreadMessage | Error;
  /** How the listing marks the thread — it can change between prepare and send. */
  listedSensitive?: () => boolean;
  /** getClient() calls that fail before it starts succeeding. */
  clientFailures?: number;
}

function setup(fake: ReplyFake) {
  const calls = { threadData: [] as number[], replies: [] as Array<Record<string, unknown>> };
  let clientFailures = fake.clientFailures ?? 0;
  const client = {
    async getThreadsPage() {
      return {
        threads: [{ ...LISTED, sensitive: fake.listedSensitive?.() ?? false }],
        page: 0,
        hasMorePages: false,
      };
    },
    async getThreadData(id: number) {
      calls.threadData.push(id);
      const r =
        fake.threadReads[Math.min(calls.threadData.length - 1, fake.threadReads.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
    async replyToThread(args: Record<string, unknown>) {
      calls.replies.push(args);
      if (fake.replyResult instanceof Error) throw fake.replyResult;
      return fake.replyResult;
    },
  } as unknown as AulaClient;
  const context = {
    async getClient() {
      if (clientFailures > 0) {
        clientFailures -= 1;
        throw new Error('Aula unreachable');
      }
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
  const failNextClient = () => {
    clientFailures += 1;
  };
  const threadRef = async (): Promise<string> => {
    const listing = textOf(await get('aula.messages.list_threads')({})) as {
      threads: Array<{ thread_ref: string }>;
    };
    const ref = listing.threads[0]?.thread_ref;
    if (!ref) throw new Error('listing returned no thread');
    return ref;
  };
  return { get, calls, threadRef, tools, failNextClient };
}

// The live shape (measured 2026-10-10): the opened object's id is the
// listing's thread id, not its subscriptionId.
const OPENED: ThreadMessagesData = {
  id: 1001,
  subject: 'Spørgsmål om tur',
  recipients: [{ fullName: 'Lærer Testesen' }],
  messages: [],
};

describe('aula.messages.prepare_reply / send_reply', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.AULA_MCP_WRITE;
    process.env.AULA_MCP_WRITE = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AULA_MCP_WRITE;
    else process.env.AULA_MCP_WRITE = original;
  });

  test('not registered without AULA_MCP_WRITE=1', () => {
    delete process.env.AULA_MCP_WRITE;
    const { tools } = setup({ threadReads: [OPENED] });
    expect(tools.has('aula.messages.prepare_reply')).toBe(false);
    expect(tools.has('aula.messages.send_reply')).toBe(false);
  });

  test('prepare sends nothing and returns the preview', async () => {
    const s = setup({ threadReads: [OPENED] });
    const out = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    expect(s.calls.replies).toHaveLength(0);
    // Opened by the thread's own id, as reading requires.
    expect(s.calls.threadData).toEqual([1001]);
    expect(out.draft_ref).toMatch(/^dft_/);
    expect(out.preview).toMatchObject({
      subject: 'Spørgsmål om tur',
      recipientCount: 1,
      recipients: ['Lærer Testesen'],
      text: 'Hej',
    });
  });

  test('prepare refuses when the ids disagree, and issues no draft', async () => {
    const s = setup({ threadReads: [{ ...OPENED, id: 9001 }] });
    const out = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    expect(out).toMatchObject({ error: 'thread_id_mismatch', listing: 1001, thread: 9001 });
    expect(out.draft_ref).toBeUndefined();
  });

  test('prepare refuses whitespace-only text', async () => {
    const s = setup({ threadReads: [OPENED] });
    const out = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: '  \n' }),
    );
    expect(out.error).toBe('empty_text');
  });

  test('send posts to the thread id — never subscriptionId — and is verified by reading back', async () => {
    const s = setup({
      threadReads: [
        OPENED, // prepare
        OPENED, // the baseline taken right before sending
        {
          ...OPENED,
          messages: [{ id: 'm-new', text: { html: '<p>Hej &amp; tak</p>' }, sendDateTime: 'x' }],
        },
      ],
      replyResult: { id: 'm-new' },
    });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({
        thread_ref: await s.threadRef(),
        text: 'Hej & tak',
      }),
    );
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    // LISTED has subscriptionId 9001; it must not appear.
    expect(s.calls.replies).toEqual([{ threadId: 1001, html: '<p>Hej &amp; tak</p>' }]);
    expect(s.calls.threadData).toEqual([1001, 1001, 1001]);
    expect(out).toMatchObject({
      upstream: { ok: true, messageId: 'm-new' },
      stateRead: true,
      verified: true,
      observed: { matchedBy: 'id' },
    });
    expect(out.warning).toBeUndefined();
  });

  test("Aula's ok is not enough: absent from the read-back → verified false", async () => {
    const s = setup({ threadReads: [OPENED], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({ upstream: { ok: true }, stateRead: true, verified: false });
    expect(out.warning).toMatch(/Do not send again/);
  });

  test('a draft sends once — the second send never reaches Aula', async () => {
    const s = setup({ threadReads: [OPENED], replyResult: { id: 'm-new' } });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    await s.get('aula.messages.send_reply')({ draft_ref });
    await expect(s.get('aula.messages.send_reply')({ draft_ref })).rejects.toThrow(
      /already been used/,
    );
    expect(s.calls.replies).toHaveLength(1);
  });

  test('a ref the server never issued sends nothing', async () => {
    const s = setup({ threadReads: [OPENED] });
    await expect(s.get('aula.messages.send_reply')({ draft_ref: 'dft_invented' })).rejects.toThrow(
      /prepare_reply first/,
    );
    expect(s.calls.replies).toHaveLength(0);
  });

  test('a failed send is reported, still read back, and not retryable', async () => {
    const s = setup({ threadReads: [OPENED], replyResult: new Error('timeout') });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({
      upstream: { ok: false, error: 'timeout' },
      stateRead: true,
      verified: false,
    });
    await expect(s.get('aula.messages.send_reply')({ draft_ref })).rejects.toThrow(
      /already been used/,
    );
  });

  test('a failed read-back is stateRead false, never verified', async () => {
    const s = setup({ threadReads: [OPENED, OPENED, new Error('read failed')], replyResult: {} });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({
      stateRead: false,
      verified: false,
      verificationError: 'read failed',
    });
  });

  test('without a baseline read before sending, nothing is sent', async () => {
    const s = setup({ threadReads: [OPENED, new Error('baseline failed')], replyResult: {} });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({ error: 'not_sent' });
    expect(s.calls.replies).toHaveLength(0);
  });

  test('a thread made sensitive after prepare is not replied to', async () => {
    let sensitive = false;
    const s = setup({ threadReads: [OPENED], replyResult: {}, listedSensitive: () => sensitive });
    const thread_ref = await s.threadRef();
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref, text: 'Hej' }),
    );
    sensitive = true;
    await s.threadRef(); // a fresh listing now marks it sensitive
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({ error: 'sensitive_thread' });
    expect(s.calls.replies).toHaveLength(0);
  });

  test('failing to reach Aula does not use the draft up', async () => {
    const s = setup({
      threadReads: [
        OPENED,
        OPENED,
        { ...OPENED, messages: [{ id: 'm-new', text: { html: '<p>Hej</p>' }, sendDateTime: 'x' }] },
      ],
      replyResult: { id: 'm-new' },
    });
    const { draft_ref } = textOf(
      await s.get('aula.messages.prepare_reply')({ thread_ref: await s.threadRef(), text: 'Hej' }),
    );
    s.failNextClient();
    await expect(s.get('aula.messages.send_reply')({ draft_ref })).rejects.toThrow(/unreachable/);
    const out = textOf(await s.get('aula.messages.send_reply')({ draft_ref }));
    expect(out).toMatchObject({ verified: true });
    expect(s.calls.replies).toHaveLength(1);
  });
});
