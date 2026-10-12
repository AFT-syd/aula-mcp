/**
 * Replying to an existing Aula message thread — the parts that decide
 * whether, where and what to send, kept apart from the tool registration so
 * each rule can be tested on its own.
 *
 * The first thing this server can send to other people. Three rules carry
 * the weight:
 *  - A reply is sent only from a draft the server issued (`draft_ref`): the
 *    model cannot send without first having been shown the exact preview.
 *  - The thread is addressed by a number two independent sources agree on —
 *    the listing's `id` and the opened thread object's own `id` — or not at
 *    all. Never the listing's `subscriptionId`: see resolveReplyTarget.
 *  - Success is what a fresh read of the thread shows, not Aula's reply.
 */

import { extractText, randomBase64Url } from '@aula-mcp/aula-auth';
import type { MessageThread, ThreadMessage, ThreadMessagesData } from '@aula-mcp/aula-client';

/** Same shape as tools.ts' ThreadAddress — restated, not imported, because
 *  tools.ts imports this module. */
export interface ThreadAddress {
  id: number;
  /** Follows the latest listing — checked again right before sending. */
  sensitive?: boolean;
}

/** Aula's own limit on a message's text without HTML (`MAX_MESSAGE_WITHOUT_HTML`). */
export const MAX_REPLY_CHARS = 6600;

/** How long a prepared reply can be sent. */
export const REPLY_DRAFT_TTL_MS = 5 * 60 * 1000;

/** Recipient names a preview lists before summarising the rest as a count. */
const PREVIEW_MAX_NAMES = 25;

/**
 * Plain text to the HTML Aula's editor produces: escaped, blank lines as
 * paragraphs, single newlines as `<br>`. Aula's frontend sends the editor's
 * HTML as `message.text`; sending raw text would lose the line breaks.
 */
export function textToHtml(text: string): string {
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${para.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('');
}

/** Why a thread cannot be replied to. Each one stops the reply before it is drafted. */
export type ReplyRefusal =
  | { error: 'thread_id_mismatch'; message: string; listing: number; thread: number | null }
  | { error: 'left_thread'; message: string }
  | { error: 'sensitive_thread'; message: string }
  | { error: 'shared_inbox'; message: string; mailBoxOwnerType: string };

/**
 * Decide which number `messaging.reply` gets, or refuse.
 *
 * Aula's frontend replies with `threadId: <open thread object>.id`. It names
 * that value "subscriptionId", but it is the listing's thread `id`, not the
 * listing's `subscriptionId` field: the frontend matches a listed thread by
 * `e.id == shownSubscriptionId` and routes to it by thread id. Measured live
 * 2026-10-10 on a test thread: getMessagesForThread(<listing id>) returned
 * an object whose `id` was that same listing id, while the listing's
 * `subscriptionId` was a different number. The first version of this function
 * expected the latter and refused — before anything was sent.
 *
 * So the target is the thread id, and only when the listing and the opened
 * object agree on it. A disagreement is reported with both numbers rather
 * than resolved by picking one, because the wrong pick posts into another
 * conversation.
 */
export function resolveReplyTarget(
  address: ThreadAddress,
  thread: ThreadMessagesData,
): { ok: true; threadId: number } | ({ ok: false } & ReplyRefusal) {
  if (thread.id !== address.id) {
    return {
      ok: false,
      error: 'thread_id_mismatch',
      message:
        "The listing's thread id and the opened thread's id disagree, so it is not certain " +
        'which conversation a reply would land in. Refusing rather than picking one.',
      listing: address.id,
      thread: thread.id ?? null,
    };
  }
  if (thread.leaveTime) {
    return {
      ok: false,
      error: 'left_thread',
      message: 'You have left this thread. Aula does not allow writing in it.',
    };
  }
  if (thread.sensitive) {
    return {
      ok: false,
      error: 'sensitive_thread',
      message: 'Replies to sensitive threads are not supported (they require MitID step-up).',
    };
  }
  const ownerType = thread.mailBoxOwner?.mailBoxOwnerType;
  if (ownerType === 'commonInbox' || ownerType === 'otpInbox') {
    return {
      ok: false,
      error: 'shared_inbox',
      message: 'This thread is in a shared inbox. Only your own inbox is supported.',
      mailBoxOwnerType: ownerType,
    };
  }
  return { ok: true, threadId: address.id };
}

/** What the user must see, verbatim, before a reply is sent. */
export interface ReplyPreview {
  subject: string | null;
  /** Everyone in the thread as Aula reports it — they all receive the reply. */
  recipientCount: number;
  recipients: string[];
  /** Present when `recipients` lists fewer names than `recipientCount`. */
  moreRecipients?: number;
  text: string;
  charCount: number;
}

export function buildReplyPreview(thread: ThreadMessagesData, text: string): ReplyPreview {
  const names = (thread.recipients ?? [])
    .map((r) => r.fullName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const recipientCount = (thread.recipients?.length ?? 0) + (thread.extraRecipientsCount ?? 0);
  return previewOf(thread.subject, recipientCount, names, text);
}

/**
 * The same preview built from the listing alone — for a sensitive thread,
 * which may not be opened to find out who is in it.
 */
export function buildListingReplyPreview(
  listing: { subject: string | undefined; recipientCount: number; recipients: string[] },
  text: string,
): ReplyPreview {
  return previewOf(listing.subject, listing.recipientCount, listing.recipients, text);
}

function previewOf(
  subject: string | undefined,
  recipientCount: number,
  names: string[],
  text: string,
): ReplyPreview {
  const listed = names.slice(0, PREVIEW_MAX_NAMES);
  return {
    subject: subject ?? null,
    recipientCount,
    recipients: listed,
    ...(recipientCount > listed.length ? { moreRecipients: recipientCount - listed.length } : {}),
    text,
    charCount: text.length,
  };
}

/**
 * Confirm a sensitive reply from the thread listing — the thread itself is
 * not opened (a design decision for this category). Weaker than reading it back, and says so:
 * only the latest message's id matching the id Aula returned for the reply
 * counts as `verified`. A newer latest message without that id is reported
 * as activity, not as the reply — someone else may have written at the same
 * moment. Reads ids and timestamps only, never the text.
 */
export function findReplyInListing(
  threads: readonly MessageThread[],
  threadId: number,
  posted: ThreadMessage | undefined,
  sentAfterMs: number,
): { listed: boolean; verified: boolean; activityAfterSend: boolean; latestAt?: string } {
  const thread = threads.find((t) => t.id === threadId);
  if (thread === undefined) return { listed: false, verified: false, activityAfterSend: false };
  const latest = thread.latestMessage;
  const at = Date.parse(latest?.sendDateTime ?? '');
  return {
    listed: true,
    verified:
      posted?.id !== undefined &&
      latest?.id !== undefined &&
      String(latest.id) === String(posted.id),
    activityAfterSend: !Number.isNaN(at) && at >= sentAfterMs - 60_000,
    ...(latest?.sendDateTime !== undefined ? { latestAt: latest.sendDateTime } : {}),
  };
}

/**
 * One-use, short-lived permission to read one sensitive thread. Issued by
 * aula.sensitive.prepare_read, which shows nothing but the subject; the
 * content is fetched only by aula.sensitive.read_thread with this ref —
 * after the user has said yes. Same store semantics as a reply draft.
 */
export function createReadPermits(opts: { ttlMs?: number; now?: () => number } = {}): {
  create(threadId: number): { read_ref: string; expires_in_s: number };
  take(ref: string): number;
} {
  const store = createOneUseStore<number>({
    prefix: 'rd_',
    refName: 'read_ref',
    usedMessage: 'A read permit opens the thread once — ask the user again for a new one.',
    prepareTool: 'aula.sensitive.prepare_read',
    expiredMessage: 'call aula.sensitive.prepare_read again and ask the user again.',
    ...opts,
  });
  return {
    create(threadId) {
      const { ref, expires_in_s } = store.create(threadId);
      return { read_ref: ref, expires_in_s };
    },
    take: store.take,
  };
}

export interface ReplyDraft {
  /** The thread as the listing knows it — reading takes `id`. */
  address: ThreadAddress;
  /** What `messaging.reply` gets as its `threadId`. */
  threadId: number;
  html: string;
  preview: ReplyPreview;
}

export interface ReplyDrafts {
  create(draft: ReplyDraft): { draft_ref: string; expires_in_s: number };
  /**
   * Hand out a draft once. It is gone from the store BEFORE the caller
   * sends, so a send that fails halfway — where Aula may or may not have
   * posted — cannot be retried into a duplicate with the same ref.
   */
  take(ref: string): ReplyDraft;
}

/**
 * Drafts live in this process's memory only — never on disk, never in a tool
 * result beyond the opaque ref — for five minutes, and can be sent once.
 * A model cannot invent a ref, so it cannot send without having called
 * prepare, which is what puts the exact preview in front of the user.
 */
export function createReplyDrafts(
  opts: {
    ttlMs?: number;
    now?: () => number;
    /** The tool that issues these drafts — named in the errors. */
    prepareTool?: string;
    /** How to check whether a used draft arrived. */
    checkHint?: string;
  } = {},
): ReplyDrafts {
  const prepareTool = opts.prepareTool ?? 'aula.messages.prepare_reply';
  const store = createOneUseStore<ReplyDraft>({
    prefix: 'dft_',
    refName: 'draft_ref',
    usedMessage:
      'A draft sends once — ' +
      (opts.checkHint ?? 'call aula.messages.get_thread to see whether it arrived') +
      ' before preparing a new one.',
    prepareTool,
    expiredMessage: `call ${prepareTool} again and show the user the new preview.`,
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    create(draft) {
      const { ref, expires_in_s } = store.create(draft);
      return { draft_ref: ref, expires_in_s };
    },
    take: store.take,
  };
}

/**
 * The store behind drafts and read permits: process memory only, a fixed
 * lifetime, one use. Taking a value removes it before the caller acts on it.
 */
export function createOneUseStore<T>(o: {
  prefix: string;
  refName: string;
  usedMessage: string;
  prepareTool: string;
  expiredMessage: string;
  ttlMs?: number;
  now?: () => number;
}): { create(value: T): { ref: string; expires_in_s: number }; take(ref: string): T } {
  const ttlMs = o.ttlMs ?? REPLY_DRAFT_TTL_MS;
  const now = o.now ?? Date.now;
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const spent = new Set<string>();
  return {
    create(value) {
      // Expired entries are swept here rather than on a timer.
      for (const [ref, entry] of entries) {
        if (entry.expiresAt <= now()) entries.delete(ref);
      }
      const ref = `${o.prefix}${randomBase64Url(9)}`;
      entries.set(ref, { value, expiresAt: now() + ttlMs });
      return { ref, expires_in_s: Math.round(ttlMs / 1000) };
    },
    take(ref) {
      const entry = entries.get(ref);
      entries.delete(ref);
      if (entry === undefined) {
        throw new Error(
          spent.has(ref)
            ? `${o.refName} "${ref}" has already been used. ${o.usedMessage}`
            : `Unknown ${o.refName} "${ref}". Call ${o.prepareTool} first.`,
        );
      }
      spent.add(ref);
      if (entry.expiresAt <= now()) {
        throw new Error(
          `${o.refName} "${ref}" expired. It lasts ${Math.round(ttlMs / 1000)} s — ${o.expiredMessage}`,
        );
      }
      return entry.value;
    },
  };
}

/** Text of a message for comparison — whitespace-normalised plain text. */
function plain(html: string | undefined): string {
  if (!html) return '';
  const spaced = html.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ');
  return (extractText(`<body>${spaced}</body>`, 'body') ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the reply in a fresh read of the thread.
 *
 * By id when Aula's reply carried one; otherwise by identical text in a
 * message sent no earlier than `sentAfterMs` minus a minute of clock skew. A
 * message that matches neither way is not evidence of anything, so the
 * caller reports `verified: false` rather than trusting the upstream answer.
 *
 * `before` is the message ids the thread held before sending. With it, a
 * text match must be a message that was not there — otherwise an earlier
 * identical message (someone's "Ok", or our own previous attempt inside the
 * skew window) would confirm a send that never landed.
 */
export function findPostedReply(
  messages: readonly ThreadMessage[],
  posted: ThreadMessage | undefined,
  html: string,
  sentAfterMs: number,
  before?: ReadonlySet<string>,
): { message: ThreadMessage; matchedBy: 'id' | 'text' } | null {
  if (posted?.id !== undefined) {
    const byId = messages.find((m) => m.id !== undefined && String(m.id) === String(posted.id));
    if (byId) return { message: byId, matchedBy: 'id' };
  }
  const wanted = plain(html);
  const byText = messages.find((m) => {
    if (before && (m.id === undefined || before.has(String(m.id)))) return false;
    const at = Date.parse(m.sendDateTime ?? '');
    return !Number.isNaN(at) && at >= sentAfterMs - 60_000 && plain(m.text?.html) === wanted;
  });
  return byText ? { message: byText, matchedBy: 'text' } : null;
}
