/**
 * Starting a new Aula message thread — the rules that decide
 * who receives it and whether it arrived, kept apart from the tool
 * registration so each can be tested on its own.
 *
 * The first send path where the recipient is not given by an existing thread,
 * so the first one that can reach the wrong family. What carries the weight:
 *  - Recipients are `person_ref`s from a group's contact list, where the
 *    person was identified by name AND role. Never a raw id, never a group:
 *    how Aula addresses a group is unverified, and a mistake there reaches a
 *    whole class.
 *  - Each recipient's id must be confirmed by a second, independent source
 *    before a draft exists: Aula's own recipient search has to return that
 *    person under the same institutionProfileId the contact list gave.
 *  - Sent only from a draft the user has seen (`draft_ref`), and confirmed by
 *    reading the new thread back, not by Aula's answer.
 */

import type {
  AulaProfile,
  MessageThread,
  RecipientSearchResult,
  ThreadMessagesData,
} from '@aula-mcp/aula-client';
import { createOneUseStore, findPostedReply } from './replies.ts';

/** At most this many people per new thread — a slip should not reach a class. */
export const MAX_THREAD_RECIPIENTS = 5;

/** Our own cap on the subject line, not Aula's. */
export const MAX_SUBJECT_CHARS = 200;

/** A recipient as the contact list identified it. */
export interface ThreadTarget {
  person_ref: string;
  institutionProfileId: number;
  name: string | null;
  role: string | undefined;
  seenAs: string[];
}

export type RecipientCheck =
  | { ok: true }
  | {
      ok: false;
      error: 'not_confirmed_by_search' | 'communication_blocked';
      /** Which part of the cross-check failed — never the values themselves. */
      mismatch?: 'id' | 'name' | 'role';
      person_ref: string;
      message: string;
    };

const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.replace(/\s+/g, ' ').trim().toLocaleLowerCase('da') ===
    b.replace(/\s+/g, ' ').trim().toLocaleLowerCase('da');

/**
 * Aula's recipient search must return this person under the same
 * institutionProfileId the contact list gave, with the same name, and with
 * the same role when both sources state one. A hit with the same name but
 * another id is a different person (or a different reading of the id); a hit
 * with the id but another name means the two sources do not mean the same
 * number. Either way it is not who was chosen, so nothing is drafted.
 */
export function confirmRecipient(
  target: ThreadTarget,
  results: readonly RecipientSearchResult[],
): RecipientCheck {
  const refuse = (mismatch: 'id' | 'name' | 'role'): RecipientCheck => ({
    ok: false,
    error: 'not_confirmed_by_search',
    mismatch,
    person_ref: target.person_ref,
    message:
      "Aula's recipient search and the contact list do not agree on this person (" +
      `${mismatch}), so it is not certain who would receive the message. Nothing was drafted.`,
  });
  const hit = results.find(
    (r) =>
      (r.docType === undefined || r.docType.toLowerCase() === 'profile') &&
      Number(r.id) === target.institutionProfileId,
  );
  if (hit === undefined) return refuse('id');
  if (!sameName(hit.name, target.name)) return refuse('name');
  if (hit.portalRole !== undefined && target.role !== undefined && hit.portalRole !== target.role) {
    return refuse('role');
  }
  if (hit.communicationBlock) {
    return {
      ok: false,
      error: 'communication_blocked',
      person_ref: target.person_ref,
      message: 'Aula blocks messages between you and this person. Nothing was drafted.',
    };
  }
  return { ok: true };
}

/**
 * The guardian's own institutionProfileId — what the recipient search is run
 * as and what the thread is sent from. Exactly one is used; several are
 * refused rather than picked, since the choice decides which institution the
 * message comes from.
 */
export function pickCreator(
  profiles: readonly AulaProfile[],
): { ok: true; id: number } | { ok: false; error: 'ambiguous_sender'; message: string } {
  const ids = [
    ...new Set(profiles.flatMap((p) => (p.institutionProfiles ?? []).map((ip) => ip.id))),
  ];
  if (ids.length === 1) return { ok: true, id: ids[0] as number };
  return {
    ok: false,
    error: 'ambiguous_sender',
    message:
      ids.length === 0
        ? 'Could not find your own institution profile to send from.'
        : 'You have several institution profiles and it is not clear which one to send from.',
  };
}

/** What the user must see, verbatim, before a new thread is sent. */
export interface ThreadPreview {
  subject: string;
  recipients: Array<{ name: string | null; seenAs: string[] }>;
  text: string;
  charCount: number;
  sensitive: false;
}

export function buildThreadPreview(
  subject: string,
  targets: readonly ThreadTarget[],
  text: string,
): ThreadPreview {
  return {
    subject,
    recipients: targets.map((t) => ({ name: t.name, seenAs: t.seenAs })),
    text,
    charCount: text.length,
    sensitive: false,
  };
}

export interface ThreadDraft {
  subject: string;
  html: string;
  creatorId: number;
  recipientIds: number[];
  preview: ThreadPreview;
}

export function createThreadDrafts(opts: { ttlMs?: number; now?: () => number } = {}): {
  create(draft: ThreadDraft): { draft_ref: string; expires_in_s: number };
  take(ref: string): ThreadDraft;
} {
  const store = createOneUseStore<ThreadDraft>({
    prefix: 'nth_',
    refName: 'draft_ref',
    usedMessage:
      'A draft sends once — look for the thread with aula.messages.list_threads before ' +
      'preparing a new one.',
    prepareTool: 'aula.messages.prepare_thread',
    expiredMessage: 'call aula.messages.prepare_thread again and show the user the new preview.',
    ...opts,
  });
  return {
    create(draft) {
      const { ref, expires_in_s } = store.create(draft);
      return { draft_ref: ref, expires_in_s };
    },
    take: store.take,
  };
}

/** The new thread's id as Aula's frontend reads it (`data.data`) — a hint only. */
export function upstreamThreadId(data: unknown): number | undefined {
  const inner = (data as { data?: unknown } | null | undefined)?.data;
  return typeof inner === 'number' ? inner : undefined;
}

/**
 * The new thread in a fresh listing: not in the listing taken before sending
 * (`before`), not sensitive (a thread this server starts never is, and the
 * read-back must not open one), same subject, started no earlier than
 * `sentAfterMs` minus a minute of clock skew. Aula's own id wins when it
 * names one of those; otherwise only a single candidate counts — two threads
 * with the same subject in the same minute are not told apart by guessing.
 */
export function findStartedThread(
  threads: readonly MessageThread[],
  subject: string,
  sentAfterMs: number,
  upstreamId: number | undefined,
  before: ReadonlySet<number>,
): MessageThread | null {
  const recent = threads.filter((t) => {
    if (before.has(t.id) || t.sensitive === true) return false;
    const at = Date.parse(t.startedTime ?? '');
    return t.subject === subject && !Number.isNaN(at) && at >= sentAfterMs - 60_000;
  });
  if (upstreamId !== undefined) {
    const byId = recent.find((t) => t.id === upstreamId);
    if (byId) return byId;
  }
  return recent.length === 1 ? (recent[0] as MessageThread) : null;
}

/**
 * The opened thread holds the text, and every intended recipient is among
 * its participants. `missing` lists the ids that are not — reported as a
 * count, never as ids.
 */
export function checkStartedThread(
  thread: ThreadMessagesData,
  draft: Pick<ThreadDraft, 'html' | 'recipientIds'>,
  sentAfterMs: number,
): { textFound: boolean; recipientsConfirmed: boolean; missingRecipients: number } {
  const textFound = findPostedReply(thread.messages, undefined, draft.html, sentAfterMs) !== null;
  const present = new Set(
    (thread.recipients ?? [])
      .map((r) => r.mailBoxOwner?.id)
      .filter((id): id is number => typeof id === 'number'),
  );
  const missing = draft.recipientIds.filter((id) => !present.has(id)).length;
  return { textFound, recipientsConfirmed: missing === 0, missingRecipients: missing };
}
