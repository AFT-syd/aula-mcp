/**
 * MCP tool registrations. Each tool delegates to AulaContext / AulaClient.
 * Inputs are validated by Zod 4 schemas registered with McpServer.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractText, randomBase64Url } from '@aula-mcp/aula-auth';
import type { AulaPost } from '@aula-mcp/aula-client';
import {
  AulaStepUpRequiredError,
  type CalendarEvent,
  htmlToText,
  isoDate,
  isoWeekString,
  isoWeekToMonday,
  type MessageThread,
  PRESENCE_STATUS_CODE,
  type TabulexChildAccess,
} from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AulaContext } from './aula-context.ts';
import { resolveCalendarRange } from './calendar-range.ts';
import {
  CONTACT_PAGE_SIZE,
  collectCandidates,
  createGroupRefs,
  createPersonRefs,
  filterForRole,
  projectContact,
  projectGroups,
  type RecipientCandidate,
  type RecipientQuery,
} from './contacts.ts';
import { deliver } from './delivery.ts';
import { buildDiscoverManifest } from './discover.ts';
import { redactCprFromError } from './redact.ts';
import {
  buildListingReplyPreview,
  buildReplyPreview,
  createReadPermits,
  createReplyDrafts,
  findPostedReply,
  findReplyInListing,
  MAX_REPLY_CHARS,
  resolveReplyTarget,
  textToHtml,
} from './replies.ts';
import {
  buildThreadPreview,
  checkStartedThread,
  confirmRecipient,
  createThreadDrafts,
  findStartedThread,
  MAX_SUBJECT_CHARS,
  MAX_THREAD_RECIPIENTS,
  pickCreator,
  type ThreadTarget,
  upstreamThreadId,
} from './threads.ts';

/** Contact-list pages find_recipients reads (20 each) before calling a group too large. */
const FIND_RECIPIENTS_MAX_PAGES = 5;

// Re-exported for tools.test.ts and any other existing caller — the
// implementation moved to redact.ts so discover.ts's probe can use it too
// without an import cycle (tools.ts already imports discover.ts).
export { redactCprFromError } from './redact.ts';

const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Download a CloudFront presigned attachment to a local file and return a
 * result payload. Shared by aula.messages.get_attachment and
 * aula.posts.get_attachment — the two differ only in how they arrive at a
 * URL, not in what they do with it.
 *
 * Deliberately plain `fetch`, not AulaHttpClient: the signature in the URL
 * IS the auth, and Aula cookies / Authorization headers can interfere.
 */
async function downloadAttachmentToDisk(args: {
  url: string;
  filename: string;
  /** Prefixed onto the on-disk name to keep sources from colliding. */
  prefix: string;
  mediaType?: string;
}): Promise<Record<string, unknown>> {
  const res = await fetch(args.url);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    return { error: 'download_failed', httpStatus: res.status, filename: args.filename, body };
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > ATTACHMENT_MAX_BYTES) {
    return {
      error: 'attachment_too_large',
      filename: args.filename,
      bytes: declared,
      maxBytes: ATTACHMENT_MAX_BYTES,
    };
  }

  // content-length is advisory — re-check against what actually arrived.
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
    return {
      error: 'attachment_too_large',
      filename: args.filename,
      bytes: buf.byteLength,
      maxBytes: ATTACHMENT_MAX_BYTES,
    };
  }

  const baseDir = process.env.AULA_MCP_ATTACHMENTS_DIR ?? join(tmpdir(), 'aula-attachments');
  await mkdir(baseDir, { recursive: true });
  // `\w` is ASCII-only, so it mangled every Danish attachment it touched —
  // "Bålhytten.pdf" landed on disk as "B_lhytten.pdf". Match Unicode letters
  // and digits instead. Path separators, `..` traversal and control
  // characters are still replaced, so this is no less strict: it stops
  // punishing æ, ø and å for not being ASCII.
  const safeName = args.filename.replace(/[^\p{L}\p{N}.\-_ ]+/gu, '_');
  const path = join(baseDir, `${args.prefix}-${safeName}`);
  await writeFile(path, buf, { mode: 0o600 });

  return {
    ok: true,
    path,
    filename: args.filename,
    bytes: buf.length,
    ...(args.mediaType ? { mediaType: args.mediaType } : {}),
  };
}

function jsonContent(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Monday..Sunday of the current ISO week as `YYYY-MM-DD` strings. */
function currentWeekRange(): { from: string; to: string } {
  const monday = isoWeekToMonday(isoWeekString());
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: isoDate(monday), to: isoDate(sunday) };
}

type ConsentEntry = {
  institutionProfile?: {
    id?: number;
    role?: string; // "guardian" | "child"
  };
};

/**
 * Every institution profile (guardian + child, across all institutions) for
 * the authenticated guardian, read from consents.getConsentResponses — the
 * only endpoint that surfaces the club child identity that profiles.list and
 * discover both omit. Returns a guardian id first so the posts call is
 * authorized. Only the logged-in user's own profiles appear here, so the
 * other parent can never leak in.
 */
async function resolveFamilyProfileIds(
  client: Awaited<ReturnType<AulaContext['getClient']>>,
): Promise<number[]> {
  // rawRequest unwraps the Aula envelope to `.data`, so this is the
  // consent-entry array directly. Guard against either shape regardless.
  const raw = (await client.rawRequest('consents.getConsentResponses', {
    returnOnlyPendingConsentResponses: 'false',
  })) as { data?: ConsentEntry[] } | ConsentEntry[] | null;

  const entries: ConsentEntry[] = Array.isArray(raw) ? raw : (raw?.data ?? []);

  const guardianIds: number[] = [];
  const childIds: number[] = [];
  for (const { institutionProfile: ip } of entries) {
    if (!ip?.id) continue;
    (ip.role === 'guardian' ? guardianIds : childIds).push(ip.id);
  }

  if (guardianIds.length === 0) {
    throw new Error(
      'resolveFamilyProfileIds: consents.getConsentResponses returned no guardian ' +
        'profile to authorize the request.',
    );
  }
  // Guardian(s) first, then children; dedupe.
  return [...new Set([...guardianIds, ...childIds])];
}

interface PdfTextResult {
  text: string;
  total: number;
  info: unknown;
}

/** Keep only what a reader (and the attachment-download tool) needs. Exported for tests. */
export function slimPost(post: AulaPost) {
  const attachments = (post.attachments ?? [])
    .map((a) => ({
      name: a.file?.name ?? a.name,
      url: a.file?.url ?? a.url, // get_attachment needs the exact URL
      ...(a.file?.mediaType ? { mediaType: a.file.mediaType } : {}),
    }))
    .filter((a) => a.url);

  return {
    id: post.id, // needed for aula.posts.get_attachment's postId
    title: post.title,
    date: post.publishAt ?? post.timestamp,
    author: post.ownerProfile?.fullName,
    // institutionName is the one bit of that block worth keeping —
    // it tells you school vs club at a glance.
    institution: post.ownerProfile?.institution?.institutionName,
    ...(post.isImportant ? { isImportant: true } : {}),
    content: htmlToText(post.content?.html ?? ''),
    ...(attachments.length ? { attachments } : {}),
  };
}

/** `YYYY-MM-DD`. */
const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** 24-hour `HH:mm`. */
const HH_MM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Komme/gå "henteform" values the write tool accepts. */
const SET_TEMPLATE_ACTIVITY_TYPES = [
  'picked_up_by',
  'self_decider',
  'send_home',
  'go_home_with',
] as const;

/**
 * Subset of aula.presence.set_template's args that has cross-field rules.
 * Optional fields spell out `| undefined` so the tool's Zod-inferred args
 * (which carry explicit `undefined` under `exactOptionalPropertyTypes`)
 * assign cleanly.
 */
export interface SetTemplateArgs {
  activityType: (typeof SET_TEMPLATE_ACTIVITY_TYPES)[number];
  pickedUpBy?: string | undefined;
  selfDeciderStartTime?: string | undefined;
  selfDeciderEndTime?: string | undefined;
  repeat?: 'never' | 'weekly' | 'every_2_weeks' | undefined;
  repeatUntil?: string | undefined;
}

/**
 * Cross-field checks for aula.presence.set_template — the rules a flat Zod
 * schema can't express (a field required only for certain activityTypes).
 * Returns human-readable problems; an empty array means the args cohere.
 */
export function validateSetTemplateArgs(args: SetTemplateArgs): string[] {
  const problems: string[] = [];
  if (
    (args.activityType === 'picked_up_by' || args.activityType === 'go_home_with') &&
    !args.pickedUpBy
  ) {
    problems.push(
      `activityType "${args.activityType}" requires pickedUpBy (who collects the child).`,
    );
  }
  if (
    args.activityType === 'self_decider' &&
    (!args.selfDeciderStartTime || !args.selfDeciderEndTime)
  ) {
    problems.push(
      'activityType "self_decider" requires selfDeciderStartTime and selfDeciderEndTime.',
    );
  }
  const repeat = args.repeat ?? 'never';
  if (repeat !== 'never' && !args.repeatUntil) {
    problems.push(`repeat "${repeat}" requires repeatUntil (the last date the repeat applies).`);
  }
  return problems;
}

/** The subset of a parallel calendar event worth naming it by. */
export interface ParallelEventRef {
  id?: CalendarEvent['id'];
  title?: string;
}

/** A calendar event, additively annotated with its parallel siblings. */
export type AnnotatedCalendarEvent = CalendarEvent & { parallelWith?: ParallelEventRef[] };

/**
 * Flag calendar events that share the exact same start/end time for the same
 * child(ren). Observed in real use: the same lesson typically appears twice
 * with different `id`s and `title`s (subject plus support staff or a
 * parallel group). The user wants both SHOWN, not silently deduped, so this
 * only adds a `parallelWith` field pointing at the sibling(s); nothing is
 * merged or dropped, and every existing field is untouched.
 *
 * Grouping key is start + end + the sorted `belongsToProfiles` set, not just
 * start + end — two different children who happen to have class at the same
 * time are not "parallel", and conflating them would be a wrong claim about
 * data, not a formatting choice. An event with no `belongsToProfiles` at all
 * can't be scoped to a child, so it is never grouped with anything.
 */
export function annotateParallelEvents(events: readonly CalendarEvent[]): AnnotatedCalendarEvent[] {
  const keyFor = (event: CalendarEvent, index: number): string => {
    const profiles = event.belongsToProfiles;
    if (!profiles || profiles.length === 0) return `unscoped-${index}`;
    const sortedProfiles = [...profiles].sort((a, b) => a - b).join(',');
    return `${event.startDateTime}|${event.endDateTime}|${sortedProfiles}`;
  };

  const groups = new Map<string, CalendarEvent[]>();
  events.forEach((event, index) => {
    const key = keyFor(event, index);
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  });

  return events.map((event, index) => {
    const group = groups.get(keyFor(event, index)) ?? [event];
    if (group.length <= 1) return event;
    const others = group.filter((other) => other !== event);
    return {
      ...event,
      parallelWith: others.map((other) => ({
        ...(other.id !== undefined ? { id: other.id } : {}),
        ...(other.title !== undefined ? { title: other.title } : {}),
      })),
    };
  });
}

/**
 * Strip the passthrough `raw` object from a Tabulex record.
 *
 * `raw` is TabulexClient keeping faith with the upstream response, which is
 * right for a library and wrong for a tool result: what it contains on an
 * actual absence day has never been observed, so it cannot be said to be
 * CPR-free. The mapped fields carry everything the model needs.
 */
export function stripTabulexRaw<T extends { raw: unknown }>(value: T): Omit<T, 'raw'> {
  const { raw: _raw, ...rest } = value;
  return rest;
}

/**
 * Wrap a TabulexClient so every method's failure passes through
 * `redactCprFromError`. A proxy rather than per-tool try/catch, so a tool added
 * later is covered without anyone remembering to add the catch.
 */
export function guardTabulex<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const method = value as (...args: unknown[]) => unknown;
      return async (...args: unknown[]) => {
        try {
          return await method.apply(target, args);
        } catch (e) {
          throw redactCprFromError(e);
        }
      };
    },
  });
}

/** What `messaging.*` needs to address one thread. */
export interface ThreadAddress {
  /** For reading (`messaging.getMessagesForThread`) AND replying
   *  (`messaging.reply`'s `threadId`). */
  id: number;
  /** Kept from the listing; NOT a reply target — see MessageThread.subscriptionId. */
  subscriptionId: number | undefined;
  /**
   * As the latest listing reported it. Sensitive threads are a category of
   * their own: the ordinary message tools must not open
   * them, so this is decided from the listing BEFORE anything is fetched.
   */
  sensitive: boolean;
  /** Listing metadata — what a sensitive reply previews, since it may not
   *  open the thread to find out. */
  subject: string | undefined;
  recipientCount: number;
  recipients: string[];
}

export interface ThreadRefs {
  refFor(
    thread: Pick<
      MessageThread,
      'id' | 'subscriptionId' | 'sensitive' | 'subject' | 'recipients' | 'extraRecipientsCount'
    >,
  ): string;
  resolve(ref: string): ThreadAddress;
  /** A legacy raw thread id, only if a listing in this session has seen it. */
  byThreadId(id: number): ThreadAddress | undefined;
}

function addressOf(thread: Parameters<ThreadRefs['refFor']>[0]): ThreadAddress {
  const recipients = (thread.recipients ?? [])
    .map((r) => (r as { fullName?: unknown }).fullName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return {
    id: thread.id,
    subscriptionId: thread.subscriptionId,
    sensitive: thread.sensitive === true,
    subject: thread.subject,
    recipientCount: (thread.recipients?.length ?? 0) + (thread.extraRecipientsCount ?? 0),
    recipients,
  };
}

/**
 * Opaque per-session handles for message threads — the `child_ref` pattern
 * applied to a different problem.
 *
 * A thread carries two ids, `id` and `subscriptionId`, measured 2026-10-10 as
 * different numbers in every thread sampled. Both reading and replying take
 * `id` — this was first believed to be `subscriptionId` for replies, and the
 * reply path's cross-check caught it live before anything was sent.
 * Exposing raw numbers would leave the model to pick, and the wrong pick on a
 * reply sends a message into a different conversation. One handle that the
 * server resolves removes that choice entirely.
 */
export function createThreadRefs(): ThreadRefs {
  const byRef = new Map<string, ThreadAddress>();
  const refById = new Map<number, string>();
  return {
    refFor(thread) {
      const fresh = addressOf(thread);
      const known = refById.get(thread.id);
      if (known !== undefined) {
        const addr = byRef.get(known);
        if (addr) {
          // A later listing may carry a subscriptionId an earlier one lacked.
          const subscriptionId = addr.subscriptionId ?? fresh.subscriptionId;
          // Everything else follows the latest listing — a thread can be made
          // sensitive after it was first listed.
          Object.assign(addr, fresh, { subscriptionId });
        }
        return known;
      }
      const ref = `thr_${randomBase64Url(6)}`;
      byRef.set(ref, fresh);
      refById.set(thread.id, ref);
      return ref;
    },
    byThreadId(id) {
      const ref = refById.get(id);
      return ref === undefined ? undefined : byRef.get(ref);
    },
    resolve(ref) {
      const addr = byRef.get(ref);
      if (addr === undefined) {
        throw new Error(
          `Unknown thread_ref "${ref}". Call aula.messages.list_threads first — thread refs ` +
            'are issued per MCP session and do not carry over to a new one.',
        );
      }
      return addr;
    },
  };
}

/** Longest preview of a thread's latest message that the listing carries. */
const THREAD_PREVIEW_CHARS = 300;

/**
 * How many 20-thread pages aula.messages.new_since walks before giving up and
 * reporting `truncated`. 100 threads covers weeks of a normal school inbox;
 * a `since` far enough back to exceed it is better served by list_threads.
 */
const NEW_SINCE_MAX_PAGES = 5;

/** HTML message body to a short plain-text preview. */
export function previewFromHtml(html: string | undefined, max = THREAD_PREVIEW_CHARS): string {
  if (!html) return '';
  // Block boundaries become spaces first; cheerio's .text() would otherwise
  // glue "<p>Hej</p><p>Mvh</p>" into "HejMvh".
  const spaced = html.replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, ' ');
  const text = (extractText(`<body>${spaced}</body>`, 'body') ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One thread as the listing returns it.
 *
 * An allowlist, deliberately. Measured 2026-10-10, Aula's raw thread is ~5.7
 * KB and about half of it is `recipients`: every participant's full name,
 * role and — via `lastReadTimestamp` — when each of them last read the
 * thread. Twenty threads came to 116,051 characters, more than a tool result
 * may carry, and named 21 people from other families. None of that is needed
 * to show an inbox, so the listing reduces recipients to a count and drops
 * the signed profile-picture URLs (time-limited access tokens) entirely.
 * The full thread is still one `aula.messages.get_thread` away.
 */
export function projectThread(t: MessageThread, refs: ThreadRefs) {
  const regarding = (t.regardingChildren ?? [])
    .map((c) => c.displayName)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return {
    thread_ref: refs.refFor(t),
    ...(t.subject !== undefined ? { subject: t.subject } : {}),
    unread: t.read === false,
    ...(t.startedTime !== undefined ? { startedAt: t.startedTime } : {}),
    ...(t.creator?.fullName !== undefined ? { startedBy: t.creator.fullName } : {}),
    ...(t.creator?.mailBoxOwner?.portalRole !== undefined
      ? { startedByRole: t.creator.mailBoxOwner.portalRole }
      : {}),
    ...(regarding.length > 0 ? { regardingChildren: regarding } : {}),
    ...(t.latestMessage
      ? {
          latest: {
            ...(t.latestMessage.sendDateTime !== undefined
              ? { sentAt: t.latestMessage.sendDateTime }
              : {}),
            // A sensitive thread lists by subject only — its text is read
            // through aula.sensitive.* or not at all.
            ...(t.sensitive ? {} : { preview: previewFromHtml(t.latestMessage.text?.html) }),
          },
        }
      : {}),
    recipientCount: (t.recipients?.length ?? 0) + (t.extraRecipientsCount ?? 0),
    ...(t.sensitive ? { sensitive: true } : {}),
    ...(t.marked ? { marked: true } : {}),
    ...(t.muted ? { muted: true } : {}),
  };
}

export interface TabulexChildRefs {
  /** The subset of a child entry that may leave this server. */
  publicEntry(child: TabulexChildAccess): Record<string, unknown>;
  /** Resolve a ref back to the CPR Tabulex wants. Throws if unknown. */
  cprFor(ref: string): string;
}

/**
 * Opaque child handles for the Tabulex tools.
 *
 * Tabulex identifies a child by their real CPR number — it is the path segment
 * in every Fravaer URL and the one field `meld_syg` PUTs. That is fine inside
 * this process; it is not fine on the tool surface. Everything a tool returns
 * travels to whichever model is driving the server and lands in a conversation
 * history the operator does not control, and a child's CPR is a different
 * category of data from "was he away on Tuesday". Nothing in absence reporting
 * needs the number itself, only the ability to name *which* child — so the
 * tools trade in a ref and the CPR stays behind this boundary.
 *
 * Refs live for one MCP session and are deliberately never persisted: a ref
 * that outlived its session would be a CPR cache in all but name.
 */
export function createTabulexChildRefs(): TabulexChildRefs {
  const byRef = new Map<string, string>();

  const refFor = (cpr: string): string => {
    for (const [ref, known] of byRef) {
      if (known === cpr) return ref;
    }
    const ref = `tbx_${randomBase64Url(6)}`;
    byRef.set(ref, cpr);
    return ref;
  };

  return {
    // An allowlist rather than a "delete the CPR" filter, so a field added
    // upstream is withheld until someone decides it should travel. `cpr` and
    // `raw` (which carries `Cpr` verbatim) are the reason this exists.
    // `foedselsdato`, `pige` and `skoleBestyrelsesValgAdgang` are left out
    // too: a birth date is the first six digits of the CPR, and none of the
    // three does anything for absence reporting.
    publicEntry(child) {
      return {
        ...(child.cpr !== undefined ? { child_ref: refFor(child.cpr) } : {}),
        ...(child.fornavn !== undefined ? { fornavn: child.fornavn } : {}),
        ...(child.efternavn !== undefined ? { efternavn: child.efternavn } : {}),
        ...(child.klasse !== undefined ? { klasse: child.klasse } : {}),
        ...(child.skoleNavn !== undefined ? { skoleNavn: child.skoleNavn } : {}),
        ...(child.skoleKode !== undefined ? { skoleKode: child.skoleKode } : {}),
        ...(child.skoleFravaerAdgang !== undefined
          ? { skoleFravaerAdgang: child.skoleFravaerAdgang }
          : {}),
      };
    },
    cprFor(ref) {
      const cpr = byRef.get(ref);
      if (cpr === undefined) {
        throw new Error(
          `Unknown child_ref "${ref}". Call aula.fravaer.tabulex_boern first — child refs are ` +
            'issued per MCP session and do not carry over to a new one.',
        );
      }
      return cpr;
    },
  };
}

export function registerTools(server: McpServer, context: AulaContext): void {
  // --- aula.discover -------------------------------------------------------

  server.registerTool(
    'aula.discover',
    {
      title: 'Discover Aula context',
      description:
        'Returns a typed manifest of the logged-in guardian: children (with names + ids), ' +
        'institutions, API version, detected widgets, and which subordinate aula.* tools to ' +
        'call. Includes a `usage` block with name-resolution and tool-selection rules. ' +
        'Call ONCE per session and reuse the result — do not re-call mid-session, unless you ' +
        'need `probe: true` after already calling it once plain.',
      inputSchema: {
        probe: z
          .boolean()
          .optional()
          .describe(
            'Default false. When true, also calls every ugeplan provider (Meebook, EasyIQ, ' +
              'EasyIQ SkolePortal) and ugebrev.minuddannelse for the current week, for the ' +
              'children this manifest already found, and returns a `probed` array with each ' +
              "source's real status (content/empty/error, plus item count). Costs 4 upstream " +
              "calls and some latency, so only set it when the plain manifest's detectedWidgets " +
              'is inconclusive and you would otherwise be about to try several ugeplan/ugebrev ' +
              'tools by hand — this replaces that brute-force with one server-side round-trip.',
          ),
      },
    },
    async (args) => {
      const manifest = await buildDiscoverManifest(context, { probe: args.probe ?? false });
      return jsonContent(manifest);
    },
  );

  // --- aula.profiles.list --------------------------------------------------

  server.registerTool(
    'aula.profiles.list',
    {
      title: 'List Aula profiles',
      description: 'Raw profiles.getProfilesByLogin response — every child + institution.',
      inputSchema: {},
    },
    async () => {
      return jsonContent(await context.getProfilesByLogin());
    },
  );

  // --- aula.presence.today -------------------------------------------------

  server.registerTool(
    'aula.presence.today',
    {
      title: 'Daily presence overview',
      description:
        'Returns presence/check-in/check-out info for the given child IDs. Status codes: ' +
        '0=IKKE_KOMMET (not arrived), 1=SYG (reported sick), 2=FERIE_FRI (holiday/not ' +
        'enrolled), 3=KOMMET (arrived/present), 4=PAA_TUR (on a trip), 5=SOVER (sleeping), ' +
        '6=FRITIDSAKTIVITET, 7=FYSISK_PLACERING, 8=GAAET (picked up/left).',
      inputSchema: {
        childIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe('Aula child IDs (from aula.discover.children[].id)'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      return jsonContent(await client.getDailyOverview(args.childIds));
    },
  );

  // --- aula.presence.templates ---------------------------------------------

  server.registerTool(
    'aula.presence.templates',
    {
      title: 'Komme/gå templates (drop-off & pickup schedule)',
      description:
        'Recurring komme/gå (presence) templates for the given children — the drop-off ' +
        'and pickup times a guardian has registered per day. Pass the same child IDs as ' +
        '`aula.presence.today`. `from`/`to` bound the window (YYYY-MM-DD); they default ' +
        'to the current week. Each returned template carries the `institutionProfile.id` ' +
        'that `aula.presence.set_template` needs. Read this before changing a schedule.',
      inputSchema: {
        childIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe('Aula child IDs (from aula.discover.children[].id)'),
        from: ISO_DATE.optional().describe('Window start YYYY-MM-DD. Defaults to this Monday.'),
        to: ISO_DATE.optional().describe('Window end YYYY-MM-DD. Defaults to this Sunday.'),
      },
    },
    async (args) => {
      const window = args.from && args.to ? { from: args.from, to: args.to } : currentWeekRange();
      const client = await context.getClient();
      return jsonContent(
        await client.getPresenceTemplates({
          institutionProfileIds: args.childIds,
          fromDate: window.from,
          toDate: window.to,
        }),
      );
    },
  );

  // --- aula.presence.set_template (gated, write) ---------------------------
  //
  // The first and only tool that *writes* to Aula. Gated behind
  // AULA_MCP_WRITE=1 so a server stays read-only by default — rescheduling a
  // child's pickup is not something an agent should be able to do unasked.

  if (process.env.AULA_MCP_WRITE === '1') {
    server.registerTool(
      'aula.presence.set_template',
      {
        title: 'Set a komme/gå template (drop-off & pickup time)',
        description:
          "Register or overwrite a child's komme/gå template for one day. WRITES to " +
          'Aula — enabled when AULA_MCP_WRITE=1. Covers one child and one date per call; ' +
          'call once per day to fill a week. Read `aula.presence.templates` first to see ' +
          'the current schedule and confirm the child id. `activityType` picks how the ' +
          'child leaves: picked_up_by ("Hentes af", a named person collects), ' +
          'self_decider ("Selvbestemmer", may leave alone between two times), ' +
          'send_home ("Sendes hjem", leaves alone at exitTime), go_home_with ' +
          '("Går hjem med", leaves with a named person). Set `repeat` to make it recur ' +
          'on that weekday until `repeatUntil`.',
        inputSchema: {
          institutionProfileId: z
            .number()
            .int()
            .positive()
            .describe(
              'Child institution-profile id — the same id passed to aula.presence.today ' +
                'as childIds, and the institutionProfile.id from aula.presence.templates.',
            ),
          date: ISO_DATE.describe(
            'Day the template applies to (YYYY-MM-DD). With repeat set, this is the ' +
              'first occurrence and fixes the weekday.',
          ),
          activityType: z
            .enum(SET_TEMPLATE_ACTIVITY_TYPES)
            .describe('How the child leaves the institution.'),
          entryTime: HH_MM.optional().describe('Drop-off time, HH:mm.'),
          exitTime: HH_MM.optional().describe(
            'Pickup / go-home time, HH:mm. Used by picked_up_by, send_home, go_home_with.',
          ),
          pickedUpBy: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Name of the person collecting the child. Required for ' +
                'picked_up_by and go_home_with.',
            ),
          selfDeciderStartTime: HH_MM.optional().describe(
            'Earliest the child may leave, HH:mm. Required for self_decider.',
          ),
          selfDeciderEndTime: HH_MM.optional().describe(
            'Latest the child may leave, HH:mm. Required for self_decider.',
          ),
          comment: z.string().optional().describe('Free-text note shown to staff.'),
          repeat: z
            .enum(['never', 'weekly', 'every_2_weeks'])
            .optional()
            .describe('Repeat cadence. Defaults to never (the single day only).'),
          repeatUntil: ISO_DATE.optional().describe(
            'Last date the repeat applies (YYYY-MM-DD). Required when repeat is ' +
              'weekly or every_2_weeks.',
          ),
        },
      },
      async (args) => {
        // Cross-field prerequisites Zod can't express — fail here with an
        // actionable message rather than letting Aula reject a half-built
        // template after the round-trip.
        const problems = validateSetTemplateArgs(args);
        if (problems.length > 0) {
          return jsonContent({ error: 'invalid_arguments', problems });
        }
        const repeat = args.repeat ?? 'never';

        const client = await context.getClient();
        const result = await client.updatePresenceTemplate({
          institutionProfileId: args.institutionProfileId,
          date: args.date,
          activityType: args.activityType,
          repeatPattern: repeat,
          ...(args.entryTime ? { entryTime: args.entryTime } : {}),
          ...(args.exitTime ? { exitTime: args.exitTime } : {}),
          ...(args.pickedUpBy ? { pickedUpBy: args.pickedUpBy } : {}),
          ...(args.selfDeciderStartTime ? { selfDeciderStartTime: args.selfDeciderStartTime } : {}),
          ...(args.selfDeciderEndTime ? { selfDeciderEndTime: args.selfDeciderEndTime } : {}),
          ...(args.comment !== undefined ? { comment: args.comment } : {}),
          ...(args.repeatUntil ? { repeatUntil: args.repeatUntil } : {}),
        });
        return jsonContent({ ok: true, result });
      },
    );

    // --- aula.presence.report_sick (gated, write) --------------------------
    //
    // Same gate, and for the same reason: telling a daycare a child is ill is
    // not something an agent should be able to do unasked.
    //
    // One tool for both directions, because Aula has one endpoint for both:
    // reporting sick and taking it back are the same call with a different
    // status.

    server.registerTool(
      'aula.presence.report_sick',
      {
        title: 'Report a child sick (or well again)',
        description:
          'Mark a child as sick for today, or take the report back. WRITES to Aula — ' +
          'enabled when AULA_MCP_WRITE=1. The institution is notified. Applies to today; ' +
          'Aula has no future-dated sick report — use aula.presence.set_template or a ' +
          'vacation registration for a planned absence. An institution can withhold this ' +
          'from guardians, in which case Aula rejects the call. The reply reads the state ' +
          'back: `stateRead` says the read succeeded, `verified` says every requested child ' +
          'now reports `expectedStatus`. Only `verified: true` confirms the change — on ' +
          'false, tell the user what `observedStatus` actually shows (a null status means ' +
          'the child was missing from the overview) instead of reporting success.',
        inputSchema: {
          institutionProfileIds: z
            .array(z.number().int().positive())
            .min(1)
            .describe(
              'Child institution-profile ids — the same ids passed to aula.presence.today ' +
                'as childIds, i.e. aula.discover children[].id. Must belong to the ' +
                'logged-in guardian; anything else is rejected. Confirm the child with ' +
                'the user before calling.',
            ),
          sick: z
            .boolean()
            .describe(
              'true reports the child sick. false takes the report back, which sets the ' +
                'child to "ikke kommet" (not arrived) — so it is rejected unless Aula ' +
                'currently reports that child as sick.',
            ),
        },
      },
      async (args) => {
        const client = await context.getClient();

        // Scope the write to this login's own children.
        //
        // Aula happily accepts any institution-profile id the caller has rights
        // to, and the schema takes an array, so a single hallucinated number is
        // enough to tell the wrong institution that someone else's child is
        // ill. Resolve the guardian's actual children first and refuse anything
        // that isn't one of them — a local error beats a phone call from a
        // daycare.
        const profilesData = await context.getProfilesByLogin();
        const ownChildren = new Map<number, string>();
        for (const profile of profilesData.profiles ?? []) {
          for (const child of profile.children ?? []) {
            ownChildren.set(child.id, child.name);
          }
        }
        const unknownIds = args.institutionProfileIds.filter((id) => !ownChildren.has(id));
        if (unknownIds.length > 0) {
          return jsonContent({
            error: 'unknown_child',
            message:
              'Refusing to write: these institution-profile ids are not children of the ' +
              'logged-in guardian. Call aula.discover and use children[].id.',
            unknownIds,
            knownChildren: [...ownChildren].map(([id, name]) => ({ id, name })),
          });
        }

        // Un-reporting is not a free action.
        //
        // Aula's own UI only offers "take the sick report back" from a sick
        // state, so status 0 is safe there. Here nothing constrains it: calling
        // sick:false on a child who is currently checked in would silently flip
        // them to "ikke kommet" and still report ok. Only allow it for a child
        // Aula currently reports as sick.
        if (!args.sick) {
          const overview = await client.getDailyOverview(args.institutionProfileIds);
          const statusById = new Map<number, number>();
          for (const entry of overview) {
            const id = entry.institutionProfile?.id;
            if (id !== undefined) statusById.set(id, entry.status);
          }
          const notSick = args.institutionProfileIds.filter(
            (id) => statusById.get(id) !== PRESENCE_STATUS_CODE.SICK,
          );
          if (notSick.length > 0) {
            return jsonContent({
              error: 'not_reported_sick',
              message:
                'Refusing to write: taking a sick report back sets the child to ' +
                '"ikke kommet" (0), so it is only safe for a child Aula currently reports ' +
                'as sick. These are not. Use aula.presence.today to see the current status.',
              children: notSick.map((id) => ({
                id,
                name: ownChildren.get(id),
                currentStatus: statusById.get(id) ?? null,
              })),
            });
          }
        }

        const result = await client.updatePresenceStatus({
          institutionProfileIds: args.institutionProfileIds,
          status: args.sick ? PRESENCE_STATUS_CODE.SICK : PRESENCE_STATUS_CODE.NOT_PRESENT,
        });

        // Read the state back rather than trusting upstream's bare ok:true.
        // Live-tested 2026-10-02: a child already reported sick got
        // `{ok: true}` from an update that changed nothing — the flag alone
        // cannot distinguish "wrote successfully" from "no-op" from "silently
        // ignored". For an action this consequential, the tool's answer has
        // to be what Aula now reports, not what the write endpoint claimed.
        let observedStatus: Array<{
          id: number;
          name: string | undefined;
          status: number | null;
        }> | null = null;
        let verificationError: string | undefined;
        try {
          const overview = await client.getDailyOverview(args.institutionProfileIds);
          const statusById = new Map<number, number>();
          for (const entry of overview) {
            const id = entry.institutionProfile?.id;
            if (id !== undefined) statusById.set(id, entry.status);
          }
          observedStatus = args.institutionProfileIds.map((id) => ({
            id,
            name: ownChildren.get(id),
            status: statusById.get(id) ?? null,
          }));
        } catch (e) {
          // A failed verification read must never look like a confirmed
          // write — say so explicitly rather than falling back to the
          // upstream flag silently.
          verificationError = e instanceof Error ? e.message : String(e);
        }

        // `verified` has to mean "Aula now reports what we asked for", not
        // "the read came back". The weaker reading is actively misleading:
        // a child missing from the overview yields status null, and a write
        // that was accepted but changed nothing yields the old status —
        // both would pass a mere `observedStatus !== null` check and tell
        // the model the write was confirmed. The expectation is the exact
        // value updatePresenceStatus sent above, not a second guess at it.
        const expectedStatus = args.sick
          ? PRESENCE_STATUS_CODE.SICK
          : PRESENCE_STATUS_CODE.NOT_PRESENT;
        const stateRead = observedStatus !== null;
        const confirmed = observedStatus?.every((o) => o.status === expectedStatus) ?? false;
        return jsonContent({
          upstream: { ok: true, result },
          /** The read succeeded. Says nothing about what it found. */
          stateRead,
          /** Every requested child now reports `expectedStatus`. */
          verified: confirmed,
          expectedStatus,
          observedStatus,
          ...(verificationError ? { verificationError } : {}),
          ...(stateRead && !confirmed
            ? {
                verificationMismatch:
                  'Aula accepted the write but does not report the expected status for every ' +
                  'child. Report the observed status to the user rather than confirming the ' +
                  'change; a null status means the child was absent from the overview.',
              }
            : {}),
        });
      },
    );

    // --- aula.messages.mark_read (gated, write) ----------------------------
    //
    // Lives here rather than next to the other aula.messages.* tools so every
    // write stays behind the one AULA_MCP_WRITE gate. Aula has no "mark as
    // read" verb; see AulaClient.setLastReadMessage for what actually happens.

    server.registerTool(
      'aula.messages.mark_read',
      {
        title: 'Mark a message thread as read',
        description:
          'Move the read marker in a thread to its newest message, clearing the unread ' +
          'badge. WRITES to Aula — enabled when AULA_MCP_WRITE=1. Pass the `thread_ref` ' +
          'from aula.messages.list_threads. Marking read is not reversible through this ' +
          'API — Aula offers no way to set a thread back to unread, so only call this for ' +
          'threads the user has actually seen. Sensitive threads are refused.',
        inputSchema: {
          thread_ref: z
            .string()
            .min(1)
            .optional()
            .describe('From aula.messages.list_threads. Valid for the current MCP session only.'),
          threadId: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Legacy: a raw thread id. Prefer thread_ref.'),
        },
      },
      async (args) => {
        // Same gate as get_thread: resolved from the listing before anything
        // is written, and a sensitive thread is refused. Marking one read
        // would change it in Aula without the user's explicit yes, which is
        // what the aula.sensitive.* category exists to require.
        const target = openableThread(args);
        if (!target.ok) return jsonContent(target.refusal);
        const threadId = target.id;
        const client = await context.getClient();
        // Messaging endpoints 403 until the guardian profile is activated
        // server-side — same priming as aula.messages.get_thread.
        await context.getGuardianUserId();

        // The compact listing does not carry message ids, so the newest one is
        // looked up here. Aula pages threads 20 at a time and ignores pageSize,
        // so walk pages until the thread turns up — bounded.
        const MAX_PAGES = 10;
        let messageId: string | undefined;
        let pagesRead = 0;
        for (let page = 0; page < MAX_PAGES; page++) {
          const { threads, hasMorePages } = await client.getThreadsPage({ page });
          pagesRead = page + 1;
          const found = threads.find((t) => t.id === threadId);
          if (found?.sensitive === true) {
            // The listing changed its mind since the thread_ref was issued.
            return jsonContent({
              error: 'sensitive_thread',
              message: 'This thread is now marked sensitive; it was not marked read.',
            });
          }
          if (found?.latestMessage?.id != null) {
            messageId = String(found.latestMessage.id);
            break;
          }
          if (!hasMorePages) break;
        }
        if (messageId === undefined) {
          return jsonContent({
            error: 'message_id_unresolved',
            message:
              `The thread was not found in the first ${pagesRead} pages ` +
              `(~${pagesRead * 20} threads), or carries no latest message. Nothing was ` +
              'marked read.',
          });
        }

        const result = await client.setLastReadMessage(threadId, messageId);
        return jsonContent({
          ok: true,
          ...(args.thread_ref !== undefined ? { thread_ref: args.thread_ref } : { threadId }),
          result,
        });
      },
    );
  }

  // --- aula.calendar.events ------------------------------------------------

  server.registerTool(
    'aula.calendar.events',
    {
      title: 'Calendar events (school schedule)',
      description:
        'The lesson timetable (skoleskema): subjects, times and rooms. This is NOT ' +
        'the weekly letter a teacher writes — that is aula.ugebrev.* / aula.ugeplan.*. ' +
        'Pass `range` for a preset window (today/tomorrow/this_week/next_week) ' +
        'OR `start`+`end` for a specific window, formatted as Aula expects: ' +
        '"YYYY-MM-DD HH:MM:SS.0000+ZZZZ" in Europe/Copenhagen wall-clock time. ' +
        'IMPORTANT: the returned startDateTime/endDateTime are UTC ("+00:00"), so ' +
        'convert to Europe/Copenhagen before showing a time to the user (+2h in ' +
        'summer, +1h in winter). The same lesson often appears twice with different ' +
        'ids and titles (e.g. the subject plus support staff or a parallel group) — ' +
        'events at the exact same start/end for the same child carry a `parallelWith` ' +
        'field naming the sibling(s); show all of them rather than silently picking one.',
      inputSchema: {
        profileIds: z
          .array(z.number().int().positive())
          .min(1)
          .describe(
            "The children's NUMERIC ids — aula.discover's children[].id, the same " +
              'values other tools call childIds. Despite the name this is not ' +
              'children[].userId (a string like "abcd1234").',
          ),
        range: z.enum(['today', 'tomorrow', 'this_week', 'next_week']).optional(),
        start: z.string().min(1).optional(),
        end: z.string().min(1).optional(),
        resourceIds: z.array(z.number().int().positive()).optional(),
      },
    },
    async (args) => {
      let start: string;
      let end: string;
      if (args.start && args.end) {
        start = args.start;
        end = args.end;
      } else {
        const window = resolveCalendarRange(args.range ?? 'this_week');
        start = window.start;
        end = window.end;
      }
      const client = await context.getClient();
      const events = await client.getCalendarEvents({
        profileIds: args.profileIds,
        start,
        end,
        ...(args.resourceIds ? { resourceIds: args.resourceIds } : {}),
      });
      return jsonContent(annotateParallelEvents(events));
    },
  );

  // --- aula.notifications.list ---------------------------------------------

  server.registerTool(
    'aula.notifications.list',
    {
      title: 'Aula notifications',
      description: 'Unread items + activity for the active guardian profile.',
      inputSchema: {},
    },
    async () => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — guardian profile must be
      // primed or Aula's `*ForActiveProfile` endpoints 403.
      await context.getGuardianUserId();
      return jsonContent(await client.getNotifications());
    },
  );

  // --- aula.posts.list -----------------------------------------------------

  server.registerTool(
    'aula.posts.list',
    {
      title: 'Aula posts (class news feed)',
      description:
        'Teacher posts and class-level updates, across every institution the ' +
        'family belongs to (school and club).',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional(),
        index: z.number().int().min(0).optional(),
        profileIds: z
          .array(z.number())
          .min(1)
          .optional()
          .describe(
            'Optional. Omit to cover the whole family across all institutions ' +
              'automatically — recommended, and the only way to guarantee club ' +
              'posts appear. Set this only to deliberately narrow the feed.',
          ),
        onlyUnread: z
          .boolean()
          .optional()
          .describe('Only return unread posts. Defaults to false (all posts).'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // Profile-scoped feed needs the guardian profile activated, or Aula 403s.
      await context.getGuardianUserId();

      const institutionProfileIds = args.profileIds ?? (await resolveFamilyProfileIds(client));

      const result = await client.getPosts({
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
        index: args.index ?? 0,
        onlyUnread: args.onlyUnread === true,
        institutionProfileIds,
      });

      const rawPosts = result?.posts ?? [];
      return jsonContent({
        count: rawPosts.length,
        ...(typeof result?.moreMessagesExist === 'boolean'
          ? { moreMessagesExist: result.moreMessagesExist }
          : {}),
        posts: rawPosts.map(slimPost),
      });
    },
  );

  // --- aula.raw_request (gated) --------------------------------------------

  if (process.env.AULA_MCP_RAW === '1') {
    server.registerTool(
      'aula.raw_request',
      {
        title: 'Raw Aula API call (escape hatch)',
        description:
          'Call any Aula API method directly. Enabled when AULA_MCP_RAW=1. The CSRF token + ' +
          'access_token are added automatically; the response envelope is unwrapped to its ' +
          '`data` field. Use sparingly — most needs have a typed tool.',
        inputSchema: {
          method: z.string().min(1).describe('e.g. "profiles.getProfileContext"'),
          query: z.record(z.string(), z.string()).optional(),
          body: z.unknown().optional(),
        },
      },
      async (args) => {
        const client = await context.getClient();
        return jsonContent(await client.rawRequest(args.method, args.query ?? {}, args.body));
      },
    );
  }

  // --- aula.messages.list_threads ------------------------------------------

  // One registry per registerTools() call, i.e. per MCP session — the same
  // lifetime as child_ref. A thread_ref from an earlier session is rejected
  // with a pointer back to list_threads rather than guessed at.
  const threadRefs = createThreadRefs();

  /**
   * The thread an ordinary message tool may open — decided from the listing,
   * before anything is fetched. A sensitive thread is refused with a pointer
   * to aula.sensitive.*; a legacy raw id is accepted only once a listing in
   * this session has said whether it is sensitive. Whether Aula's own
   * thread object carries a `sensitive` flag has not been measured, so a
   * check after fetching could not stand on its own.
   */
  function openableThread(args: {
    thread_ref?: string | undefined;
    threadId?: number | undefined;
  }): { ok: true; id: number } | { ok: false; refusal: Record<string, unknown> } {
    let address: ThreadAddress | undefined;
    if (args.thread_ref !== undefined) {
      address = threadRefs.resolve(args.thread_ref);
    } else if (args.threadId !== undefined) {
      address = threadRefs.byThreadId(args.threadId);
      if (address === undefined) {
        throw new Error(
          `Unknown threadId ${args.threadId}. Call aula.messages.list_threads first and use ` +
            'the thread_ref — a raw id is only accepted once a listing has shown the thread.',
        );
      }
    } else {
      throw new Error('Pass a thread_ref from aula.messages.list_threads (or a legacy threadId).');
    }
    if (address.sensitive) {
      return {
        ok: false,
        refusal: {
          error: 'sensitive_thread',
          message:
            'This thread is marked sensitive. The ordinary message tools do not open it. To ' +
            'read it, use aula.sensitive.prepare_read and get an explicit yes from the user; ' +
            'to reply, use aula.sensitive.prepare_reply.',
          ...(address.subject !== undefined ? { subject: address.subject } : {}),
        },
      };
    }
    return { ok: true, id: address.id };
  }

  server.registerTool(
    'aula.messages.list_threads',
    {
      title: 'List Aula message threads',
      description:
        'Most recent first, 20 per page (Aula fixes the page size). When `morePages` is ' +
        'true there are older threads you have not seen, so keep calling with `page` + 1 ' +
        'before concluding anything about the mailbox as a whole (e.g. "no unread ' +
        'messages"). Each thread has a ' +
        '`thread_ref` — pass it to aula.messages.get_thread to read the whole thread. The ' +
        'listing is deliberately compact: subject, who started it, which of your children it ' +
        'concerns, unread state, and a short preview of the latest message. Other ' +
        'participants are summarised as `recipientCount`; their names and read receipts are ' +
        'only in get_thread. Use `unread_only` for "do I have new messages", and `child_ids` ' +
        "(aula.discover children[].id) for one child's threads. Threads marked " +
        '`sensitive: true` are listed by subject without a preview, and only the ' +
        'aula.sensitive.* tools act on them.',
      inputSchema: {
        page: z.number().int().min(0).default(0).optional(),
        unread_only: z
          .boolean()
          .optional()
          .describe('Only threads you have not read. Maps to Aula\'s own "Unread" filter.'),
        child_ids: z
          .array(z.number().int().positive())
          .min(1)
          .optional()
          .describe('Only threads concerning these children — aula.discover children[].id.'),
      },
    },
    async (args) => {
      const client = await context.getClient();
      // See aula.messages.get_thread below — messaging endpoints 403
      // until the guardian profile is activated server-side.
      await context.getGuardianUserId();
      const page = await client.getThreadsPage({
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.unread_only ? { filterOn: 'Unread' as const } : {}),
        ...(args.child_ids ? { activeChildren: args.child_ids } : {}),
      });
      return jsonContent({
        page: args.page ?? 0,
        morePages: page.hasMorePages,
        threads: page.threads.map((t) => projectThread(t, threadRefs)),
      });
    },
  );

  server.registerTool(
    'aula.messages.new_since',
    {
      title: 'Message threads with activity since a point in time',
      description:
        'Threads whose latest message arrived after `since` — "anything new since this ' +
        'morning / since I last checked". Same compact shape and `thread_ref`s as ' +
        'aula.messages.list_threads. Pass an ISO 8601 timestamp with offset, e.g. ' +
        '"2026-10-10T08:00:00+02:00". An empty list means nothing arrived. If `truncated` is ' +
        'true, there may be more than were returned — say so rather than calling it complete.',
      inputSchema: {
        since: z
          .string()
          .datetime({ offset: true })
          .describe('ISO 8601 with offset, e.g. "2026-10-10T08:00:00+02:00".'),
        child_ids: z
          .array(z.number().int().positive())
          .min(1)
          .optional()
          .describe('Only threads concerning these children — aula.discover children[].id.'),
      },
    },
    async (args) => {
      // Built on messaging.getThreads, NOT messaging.getNewThreads. Measured
      // live 2026-10-10: getNewThreads with a timestamp from the day before
      // returned an empty list although three threads had messages that day
      // and one had been created that day. Aula's frontend sends it more
      // parameters (mailbox owner, folder) as part of its own polling loop,
      // and an empty answer is indistinguishable from "nothing new" — a
      // silent false negative. getThreads is verified, and filtering on the
      // latest message's own timestamp states exactly what "new" means.
      const client = await context.getClient();
      await context.getGuardianUserId();
      const sinceMs = Date.parse(args.since);
      const found: MessageThread[] = [];
      let truncated = false;
      let page = 0;
      for (;;) {
        const res = await client.getThreadsPage({
          page,
          ...(args.child_ids ? { activeChildren: args.child_ids } : {}),
        });
        let reachedOlder = false;
        for (const t of res.threads) {
          const at = Date.parse(t.latestMessage?.sendDateTime ?? t.startedTime ?? '');
          if (Number.isNaN(at)) continue;
          if (at > sinceMs) found.push(t);
          else reachedOlder = true;
        }
        // The listing is newest-activity-first, so once a page holds a
        // thread older than `since`, later pages hold only older ones. The
        // whole page is still filtered first, so a thread slightly out of
        // order within it is not lost.
        if (reachedOlder || !res.hasMorePages || res.threads.length === 0) break;
        page += 1;
        if (page >= NEW_SINCE_MAX_PAGES) {
          truncated = true;
          break;
        }
      }
      return jsonContent({
        since: args.since,
        ...(truncated ? { truncated: true } : {}),
        threads: found.map((t) => projectThread(t, threadRefs)),
      });
    },
  );

  // --- aula.messages.prepare_reply / send_reply (gated, write) -------------
  //
  // The first tools that send something other people read. Same gate as the
  // presence writes, plus a second one the model cannot set itself: send
  // takes only a draft_ref, and only prepare issues one — after building the
  // exact preview the user has to see. Registered here rather than in the
  // gated block above because they resolve thread_refs.

  if (process.env.AULA_MCP_WRITE === '1') {
    const replyDrafts = createReplyDrafts();

    server.registerTool(
      'aula.messages.prepare_reply',
      {
        title: 'Prepare a reply in an existing thread (sends nothing)',
        description:
          'Step 1 of 2 for replying in an Aula thread. Sends NOTHING — it checks the thread can ' +
          'be replied to and returns a `draft_ref` plus a `preview`: subject, everyone in the ' +
          'thread (they all receive the reply) and the exact text. Show the preview to the user ' +
          'verbatim, including `recipientCount`, and ask for an explicit yes before calling ' +
          'aula.messages.send_reply. The draft expires after `expires_in_s` and sends once. ' +
          'Enabled when AULA_MCP_WRITE=1.',
        inputSchema: {
          thread_ref: z
            .string()
            .min(1)
            .describe('From aula.messages.list_threads or new_since. This session only.'),
          text: z
            .string()
            .min(1)
            .max(MAX_REPLY_CHARS)
            .describe(
              `Plain text, at most ${MAX_REPLY_CHARS} characters. Blank lines separate ` +
                'paragraphs. No attachments.',
            ),
        },
      },
      async (args) => {
        const text = args.text.trim();
        if (text.length === 0) {
          return jsonContent({ error: 'empty_text', message: 'The reply text is empty.' });
        }
        const address = threadRefs.resolve(args.thread_ref);
        // Decided from the listing: this path opens the thread to check it,
        // which a sensitive thread must not be.
        if (address.sensitive) {
          return jsonContent({
            error: 'sensitive_thread',
            message:
              'This thread is marked sensitive and is not opened by the ordinary tools. Use ' +
              'aula.sensitive.prepare_reply to reply without opening it.',
          });
        }
        const client = await context.getClient();
        await context.getGuardianUserId();
        let thread: Awaited<ReturnType<typeof client.getThreadData>>;
        try {
          thread = await client.getThreadData(address.id);
        } catch (e) {
          if (e instanceof AulaStepUpRequiredError) {
            return jsonContent({ error: 'step_up_required', message: e.message });
          }
          throw e;
        }
        const target = resolveReplyTarget(address, thread);
        if (!target.ok) {
          const { ok: _ok, ...refusal } = target;
          return jsonContent(refusal);
        }
        const html = textToHtml(text);
        const preview = buildReplyPreview(thread, text);
        const { draft_ref, expires_in_s } = replyDrafts.create({
          address,
          threadId: target.threadId,
          html,
          preview,
        });
        return jsonContent({
          draft_ref,
          expires_in_s,
          preview,
          next:
            'Nothing has been sent. Show `preview` to the user word for word and send only ' +
            'after an explicit yes.',
        });
      },
    );

    server.registerTool(
      'aula.messages.send_reply',
      {
        title: 'Send a prepared reply',
        description:
          'Step 2 of 2. SENDS the reply prepared by aula.messages.prepare_reply to everyone in ' +
          'the thread. Call this ONLY after showing the user that preview verbatim and getting ' +
          'an explicit yes in this conversation — never on your own initiative. A draft_ref ' +
          'works once and expires. The answer reads the thread back: `stateRead` says the read ' +
          'succeeded, `verified` says the reply is now in the thread. Only `verified: true` ' +
          'confirms it was sent. On false or an error, do NOT prepare and send again — tell ' +
          'the user and check with aula.messages.get_thread first, or the thread may get the ' +
          'message twice. Enabled when AULA_MCP_WRITE=1.',
        inputSchema: {
          draft_ref: z.string().min(1).describe('From aula.messages.prepare_reply.'),
        },
      },
      async (args) => {
        // Connected first, so a failure to reach Aula does not use up the draft.
        const client = await context.getClient();
        await context.getGuardianUserId();
        // Taken out of the store before anything is sent: from here on this
        // ref cannot send again, whatever happens below.
        const draft = replyDrafts.take(args.draft_ref);
        // The address follows the latest listing; a thread can have been made
        // sensitive since the draft was prepared.
        if (draft.address.sensitive) {
          return jsonContent({
            error: 'sensitive_thread',
            message:
              'This thread is now marked sensitive. Nothing was sent. Use ' +
              'aula.sensitive.prepare_reply to reply without opening it.',
          });
        }
        // What the thread held before sending, so the read-back can only be
        // confirmed by a message that is new. Without it nothing is sent.
        let before: Set<string>;
        try {
          const prior = await client.getThreadData(draft.address.id);
          before = new Set(
            prior.messages.flatMap((m) => (m.id === undefined ? [] : [String(m.id)])),
          );
        } catch (e) {
          return jsonContent({
            error: 'not_sent',
            message:
              'Could not read the thread before sending, so a send could not be confirmed ' +
              'afterwards. Nothing was sent — prepare the reply again.',
            detail: e instanceof Error ? e.message : String(e),
          });
        }

        const sentAfterMs = Date.now();
        let posted: Awaited<ReturnType<typeof client.replyToThread>>;
        let sendError: string | undefined;
        try {
          posted = await client.replyToThread({ threadId: draft.threadId, html: draft.html });
        } catch (e) {
          // Not rethrown: a failed request may still have been posted
          // (a timeout after Aula accepted it), so the read-back below is
          // the only honest answer either way.
          sendError = e instanceof Error ? e.message : String(e);
        }

        // Read the thread back rather than trusting the reply's answer.
        // A municipality can block communication between profiles, and an
        // accepted request is not the same as a message in the thread.
        let found: ReturnType<typeof findPostedReply> = null;
        let stateRead = false;
        let verificationError: string | undefined;
        try {
          const thread = await client.getThreadData(draft.address.id);
          stateRead = true;
          found = findPostedReply(thread.messages, posted, draft.html, sentAfterMs, before);
        } catch (e) {
          verificationError = e instanceof Error ? e.message : String(e);
        }

        return jsonContent({
          upstream: sendError
            ? { ok: false, error: sendError }
            : { ok: true, ...(posted?.id !== undefined ? { messageId: posted.id } : {}) },
          /** The read-back succeeded. Says nothing about what it found. */
          stateRead,
          /** The reply is in the thread now. */
          verified: found !== null,
          ...(found
            ? {
                observed: {
                  matchedBy: found.matchedBy,
                  ...(found.message.sendDateTime !== undefined
                    ? { sentAt: found.message.sendDateTime }
                    : {}),
                },
              }
            : {}),
          subject: draft.preview.subject,
          recipientCount: draft.preview.recipientCount,
          ...(verificationError ? { verificationError } : {}),
          ...(found === null
            ? {
                warning:
                  'Not confirmed. Do not send again: tell the user, and check the thread with ' +
                  'aula.messages.get_thread before preparing a new reply.',
              }
            : {}),
        });
      },
    );
  }

  // --- aula.sensitive.* -----------------------------------------------------
  //
  // Sensitive threads are a category of their own. The
  // listing shows them by subject and flag like any other thread, but the
  // ordinary message tools refuse to open them. Reading goes through a gate
  // of its own — a one-use read permit issued only after the user has seen
  // the subject and said yes — and replying never opens the thread at all.

  const readPermits = createReadPermits();

  /** A thread_ref that the listing marked sensitive, or a refusal. */
  function sensitiveAddress(
    ref: string,
  ): { ok: true; address: ThreadAddress } | { ok: false; refusal: Record<string, unknown> } {
    const address = threadRefs.resolve(ref);
    if (!address.sensitive) {
      return {
        ok: false,
        refusal: {
          error: 'not_sensitive',
          message:
            'This thread is not marked sensitive. Use the ordinary aula.messages.* tools for it.',
        },
      };
    }
    return { ok: true, address };
  }

  server.registerTool(
    'aula.sensitive.prepare_read',
    {
      title: 'Ask to read a sensitive thread (opens nothing)',
      description:
        'Step 1 of 2 for reading a thread the listing marks `sensitive: true`. Opens NOTHING — ' +
        'returns the subject and a one-use `read_ref`. Ask the user explicitly whether to open ' +
        'this sensitive thread, naming the subject, and call aula.sensitive.read_thread only ' +
        'after a yes in this conversation. The ordinary aula.messages.get_thread refuses ' +
        'sensitive threads.',
      inputSchema: {
        thread_ref: z.string().min(1).describe('From aula.messages.list_threads or new_since.'),
      },
    },
    async (args) => {
      const target = sensitiveAddress(args.thread_ref);
      if (!target.ok) return jsonContent(target.refusal);
      const { read_ref, expires_in_s } = readPermits.create(target.address.id);
      return jsonContent({
        read_ref,
        expires_in_s,
        subject: target.address.subject ?? null,
        next:
          'Nothing has been opened. Ask the user whether to open this sensitive thread, and ' +
          'call aula.sensitive.read_thread only after an explicit yes.',
      });
    },
  );

  server.registerTool(
    'aula.sensitive.read_thread',
    {
      title: 'Read a sensitive thread (after the user said yes)',
      description:
        'Step 2 of 2. Opens the sensitive thread a `read_ref` from aula.sensitive.prepare_read ' +
        'was issued for, and returns its subject and messages. Call ONLY after the user ' +
        'explicitly agreed to open that thread. A read_ref works once and expires. Aula may ' +
        'require MitID step-up for sensitive threads; that comes back as `step_up_required`.',
      inputSchema: {
        read_ref: z.string().min(1).describe('From aula.sensitive.prepare_read.'),
      },
    },
    async (args) => {
      const threadId = readPermits.take(args.read_ref);
      const client = await context.getClient();
      await context.getGuardianUserId();
      try {
        return jsonContent(await client.getMessagesForThread(threadId));
      } catch (e) {
        if (e instanceof AulaStepUpRequiredError) {
          return jsonContent({ error: 'step_up_required', message: e.message });
        }
        throw e;
      }
    },
  );

  if (process.env.AULA_MCP_WRITE === '1') {
    const sensitiveDrafts = createReplyDrafts({
      prepareTool: 'aula.sensitive.prepare_reply',
      checkHint: 'check aula.messages.list_threads for new activity in the thread',
    });

    server.registerTool(
      'aula.sensitive.prepare_reply',
      {
        title: 'Prepare a reply in a sensitive thread (sends nothing, opens nothing)',
        description:
          'Step 1 of 2 for replying in a thread the listing marks `sensitive: true`. Sends ' +
          'nothing and does NOT open the thread: the preview (subject, recipients, your text) ' +
          'comes from the listing. Show it to the user verbatim and ask for an explicit yes ' +
          'before calling aula.sensitive.send_reply. Enabled when AULA_MCP_WRITE=1.',
        inputSchema: {
          thread_ref: z.string().min(1).describe('From aula.messages.list_threads or new_since.'),
          text: z
            .string()
            .min(1)
            .max(MAX_REPLY_CHARS)
            .describe(`Plain text, at most ${MAX_REPLY_CHARS} characters. No attachments.`),
        },
      },
      async (args) => {
        const text = args.text.trim();
        if (text.length === 0) {
          return jsonContent({ error: 'empty_text', message: 'The reply text is empty.' });
        }
        const target = sensitiveAddress(args.thread_ref);
        if (!target.ok) return jsonContent(target.refusal);
        const { address } = target;
        // Without opening the thread there is no second source to check the
        // id against, so the listing's thread id is used alone. It is the
        // number the ordinary path cross-checks: measured 2026-10-10, the
        // opened object's id equals the listing id. Never subscriptionId.
        const preview = buildListingReplyPreview(address, text);
        const { draft_ref, expires_in_s } = sensitiveDrafts.create({
          address,
          threadId: address.id,
          html: textToHtml(text),
          preview,
        });
        return jsonContent({
          draft_ref,
          expires_in_s,
          preview,
          next:
            'Nothing has been sent. Show `preview` to the user word for word and send only ' +
            'after an explicit yes.',
        });
      },
    );

    server.registerTool(
      'aula.sensitive.send_reply',
      {
        title: 'Send a prepared reply in a sensitive thread',
        description:
          'Step 2 of 2. SENDS the reply from aula.sensitive.prepare_reply to everyone in the ' +
          'sensitive thread. Call ONLY after showing that preview verbatim and getting an ' +
          'explicit yes. The thread is not opened afterwards either: confirmation comes from ' +
          'the thread listing, and `verified: true` only when the latest message there has the ' +
          'id Aula returned for the reply. `activityAfterSend` without `verified` means ' +
          'something newer is there but it is not proven to be this reply. On false or an ' +
          'error, do NOT send again — tell the user. Enabled when AULA_MCP_WRITE=1.',
        inputSchema: {
          draft_ref: z.string().min(1).describe('From aula.sensitive.prepare_reply.'),
        },
      },
      async (args) => {
        // Connected first, so a failure to reach Aula does not use up the draft.
        const client = await context.getClient();
        await context.getGuardianUserId();
        const draft = sensitiveDrafts.take(args.draft_ref);

        const sentAfterMs = Date.now();
        let posted: Awaited<ReturnType<typeof client.replyToThread>>;
        let sendError: string | undefined;
        try {
          posted = await client.replyToThread({ threadId: draft.threadId, html: draft.html });
        } catch (e) {
          sendError = e instanceof Error ? e.message : String(e);
        }

        // The listing, not the thread: a replied-to thread moves to the top
        // of page 0, and the listing carries the latest message's id.
        let observed: ReturnType<typeof findReplyInListing> | null = null;
        let verificationError: string | undefined;
        try {
          const page = await client.getThreadsPage({ page: 0 });
          observed = findReplyInListing(page.threads, draft.address.id, posted, sentAfterMs);
        } catch (e) {
          verificationError = e instanceof Error ? e.message : String(e);
        }

        const verified = observed?.verified ?? false;
        return jsonContent({
          upstream: sendError
            ? { ok: false, error: sendError }
            : { ok: true, ...(posted?.id !== undefined ? { messageId: posted.id } : {}) },
          /** The listing was read. Says nothing about what it showed. */
          stateRead: observed !== null,
          verified,
          ...(observed
            ? {
                observed: {
                  threadOnFirstPage: observed.listed,
                  activityAfterSend: observed.activityAfterSend,
                  ...(observed.latestAt !== undefined ? { latestAt: observed.latestAt } : {}),
                },
              }
            : {}),
          subject: draft.preview.subject,
          recipientCount: draft.preview.recipientCount,
          ...(verificationError ? { verificationError } : {}),
          ...(verified
            ? {}
            : {
                warning:
                  'Not confirmed. Do not send again: tell the user. The thread can be checked ' +
                  'in the Aula app, or here only through aula.sensitive.prepare_read with the ' +
                  "user's yes.",
              }),
        });
      },
    );
  }

  // --- aula.contacts.* (read) ----------------------------------------------
  //
  // Reading only, so no write gate — but the
  // data is other families', so: allowlisted fields, group refs instead of raw
  // ids, and only the guardian's own children as the way in.

  const groupRefs = createGroupRefs();
  const personRefs = createPersonRefs();

  server.registerTool(
    'aula.contacts.groups',
    {
      title: "A child's groups (classes, SFO, …)",
      description:
        'The groups the given children belong to, each with a `group_ref` for ' +
        'aula.contacts.list. `child_ids` are aula.discover children[].id and must be your own ' +
        'children.',
      inputSchema: {
        child_ids: z
          .array(z.number().int().positive())
          .min(1)
          .describe('aula.discover children[].id — your own children only.'),
      },
    },
    async (args) => {
      // Only the guardian's own children are a way in — a guessed id must not
      // open another child's groups.
      const profilesData = await context.getProfilesByLogin();
      const own = new Set<number>();
      for (const profile of profilesData.profiles ?? []) {
        for (const child of profile.children ?? []) own.add(child.id);
      }
      const unknown = args.child_ids.filter((id) => !own.has(id));
      if (unknown.length > 0) {
        return jsonContent({
          error: 'unknown_child',
          message: 'These ids are not children of the logged-in guardian. Use aula.discover.',
          unknownIds: unknown,
        });
      }
      const client = await context.getClient();
      await context.getGuardianUserId();
      const groups = projectGroups(await client.getGroupsByContext(args.child_ids), groupRefs);
      return deliver(
        { groups },
        { kind: 'contacts', subjectCount: groups.length, containsOtherFamilies: false },
      );
    },
  );

  server.registerTool(
    'aula.contacts.list',
    {
      title: 'People in a group',
      description:
        'One page (up to 20, sorted by name) of the people in a group from ' +
        'aula.contacts.groups. `filter: "child"` (default) lists the children, each with ' +
        '`relations` — their guardians with `relation` ("Mor", "Far", …). `"guardian"` lists ' +
        'the guardians with their children; `"employee"` the staff. Every person has a ' +
        '`person_ref` that stays the same for the same person across groups in this session. ' +
        'Identify a person by name AND relation/role — names repeat (there can be two parents ' +
        'with the same first name). Phone, email and address appear only where Aula shows them, ' +
        'and never for a person marked `alias: true` (the name shown is not their own). ' +
        'If `morePages` is true, ask for `page + 1`.',
      inputSchema: {
        group_ref: z.string().min(1).describe('From aula.contacts.groups.'),
        filter: z.enum(['child', 'guardian', 'employee']).optional(),
        page: z.number().int().min(1).optional().describe('Starts at 1.'),
      },
    },
    async (args) => {
      const group = groupRefs.resolve(args.group_ref);
      const filter = args.filter ?? 'child';
      const page = args.page ?? 1;
      const client = await context.getClient();
      await context.getGuardianUserId();
      const entries = await client.getContactList({ groupId: group.id, filter, page });
      const people = entries.map((e) =>
        projectContact(e, personRefs, 0, { group: group.name ?? null }),
      );
      return deliver(
        {
          group: group.name ?? null,
          filter,
          page,
          morePages: entries.length >= CONTACT_PAGE_SIZE,
          people,
        },
        { kind: 'contacts', subjectCount: people.length, containsOtherFamilies: true },
      );
    },
  );

  server.registerTool(
    'aula.contacts.parents',
    {
      title: 'Contact parents (kontaktforældre)',
      description:
        'One page of the "Kontaktforældre" view across your children\'s groups, with ' +
        '`person_ref`s like aula.contacts.list. Pages start at 1; ask for the next page while ' +
        'it returns people.',
      inputSchema: {
        page: z.number().int().min(1).optional().describe('Starts at 1.'),
      },
    },
    async (args) => {
      const page = args.page ?? 1;
      const client = await context.getClient();
      await context.getGuardianUserId();
      const entries = await client.getContactParents(page);
      const people = entries.map((e) => projectContact(e, personRefs));
      return deliver(
        // Aula's frontend keeps loading while a page is non-empty.
        { page, morePages: entries.length > 0, people },
        { kind: 'contacts', subjectCount: people.length, containsOtherFamilies: true },
      );
    },
  );

  // --- aula.messages.find_recipients / prepare_thread / send_thread ---------
  //
  // A new thread to people who have not written to us. Finding
  // is read-only and ungated; preparing and sending sit behind the write gate
  // and a draft, like replies. Recipients are person_refs only — a person is
  // found in a group by name AND role, never by name alone, and a group is
  // never a recipient (see threads.ts).

  server.registerTool(
    'aula.messages.find_recipients',
    {
      title: 'Find a message recipient by name and role in a group',
      description:
        'Looks for a person in a group from aula.contacts.groups by name AND role, never by ' +
        'name alone — names repeat (there can be two parents with the same first name). For a ' +
        'parent give `role: "guardian"` and, when known, `relation` ("Mor", "Far") and ' +
        '`of_child`. Answers `match` (exactly one person — use its `person_ref`), `candidates` ' +
        '(several — show them and ASK the user which one; never pick), or `none`. Read-only.',
      inputSchema: {
        group_ref: z.string().min(1).describe('From aula.contacts.groups.'),
        name: z.string().min(1).describe('All or part of the name, e.g. "Anne Hansen".'),
        role: z.enum(['guardian', 'employee', 'child']),
        relation: z.string().min(1).optional().describe('Guardians only: "Mor", "Far", …'),
        of_child: z
          .string()
          .min(1)
          .optional()
          .describe("Guardians only: all or part of the child's name."),
      },
    },
    async (args) => {
      const name = args.name.trim();
      if (name.length === 0) {
        return jsonContent({ error: 'empty_name', message: 'Give a name to search for.' });
      }
      const group = groupRefs.resolve(args.group_ref);
      const query: RecipientQuery = {
        name,
        role: args.role,
        ...(args.relation !== undefined ? { relation: args.relation.trim() } : {}),
        ...(args.of_child !== undefined ? { ofChild: args.of_child.trim() } : {}),
      };
      const filter = filterForRole(args.role);
      const client = await context.getClient();
      await context.getGuardianUserId();
      const found = new Map<string, RecipientCandidate>();
      let complete = false;
      for (let page = 1; page <= FIND_RECIPIENTS_MAX_PAGES; page++) {
        const entries = await client.getContactList({ groupId: group.id, filter, page });
        // Projected for the side effect only: it records where each person was
        // seen, which is what prepare_thread's preview shows.
        for (const e of entries) projectContact(e, personRefs, 0, { group: group.name ?? null });
        collectCandidates(entries, query, personRefs, found);
        if (entries.length < CONTACT_PAGE_SIZE) {
          complete = true;
          break;
        }
      }
      const candidates = [...found.values()];
      const base = { group: group.name ?? null, ...(complete ? {} : { incomplete: true }) };
      if (candidates.length === 1 && complete) {
        return jsonContent({ ...base, match: candidates[0] });
      }
      if (candidates.length === 0) {
        return jsonContent({ ...base, none: true });
      }
      return jsonContent({
        ...base,
        candidates,
        next: complete
          ? 'Several people match. Show them to the user and ask which one — do not pick.'
          : 'The group is larger than was searched, so this may not be everyone. Ask the user.',
      });
    },
  );

  if (process.env.AULA_MCP_WRITE === '1') {
    const threadDrafts = createThreadDrafts();

    server.registerTool(
      'aula.messages.prepare_thread',
      {
        title: 'Prepare a new message thread (sends nothing)',
        description:
          'Step 1 of 2 for writing a new Aula message. Sends NOTHING. Recipients are ' +
          '`person_ref`s from aula.messages.find_recipients or aula.contacts.list (at most ' +
          `${MAX_THREAD_RECIPIENTS}; no groups). Each one is checked against Aula's own ` +
          'recipient search before a draft exists. Returns a `draft_ref` and a `preview` — ' +
          'subject, each recipient with where they were found ("Mor til … (0A)"), and the exact ' +
          'text. Show the preview to the user verbatim and get an explicit yes before calling ' +
          'aula.messages.send_thread. Never sensitive, no attachments. Enabled when ' +
          'AULA_MCP_WRITE=1.',
        inputSchema: {
          person_refs: z
            .array(z.string().min(1))
            .min(1)
            .max(MAX_THREAD_RECIPIENTS)
            .describe(
              'From aula.messages.find_recipients or aula.contacts.list. This session only.',
            ),
          subject: z.string().min(1).max(MAX_SUBJECT_CHARS),
          text: z
            .string()
            .min(1)
            .max(MAX_REPLY_CHARS)
            .describe(
              `Plain text, at most ${MAX_REPLY_CHARS} characters. Blank lines separate paragraphs.`,
            ),
        },
      },
      async (args) => {
        const subject = args.subject.trim();
        const text = args.text.trim();
        if (subject.length === 0 || text.length === 0) {
          return jsonContent({ error: 'empty', message: 'Subject and text must not be empty.' });
        }
        const refs = [...new Set(args.person_refs)];
        const targets: ThreadTarget[] = [];
        for (const ref of refs) {
          const ids = personRefs.resolve(ref);
          // Measured 2026-10-11: a guardian under a child in the contact list
          // carries only `id`. Whether that is their institutionProfileId is
          // exactly what confirmRecipient settles — Aula's search must return
          // the person under this same number, or there is no draft.
          const candidateId = ids.institutionProfileId ?? ids.id;
          if (candidateId === undefined) {
            return jsonContent({
              error: 'no_profile_id',
              person_ref: ref,
              message: 'This person carries no id, so they cannot be addressed.',
            });
          }
          const d = personRefs.describe(ref);
          if (d.alias) {
            return jsonContent({
              error: 'alias_profile',
              person_ref: ref,
              message: 'This person is shown under an alias and is not addressed by this tool.',
            });
          }
          if (d.role !== 'guardian' && d.role !== 'employee') {
            return jsonContent({
              error: 'unsupported_recipient_role',
              person_ref: ref,
              message: 'Only parents and staff can be recipients of a new thread here.',
            });
          }
          // The same person can hold two refs (one keyed on each id field);
          // they are one recipient.
          if (targets.some((t) => t.institutionProfileId === candidateId)) continue;
          targets.push({
            person_ref: ref,
            institutionProfileId: candidateId,
            name: d.name,
            role: d.role,
            seenAs: d.seenAs,
          });
        }
        const creator = pickCreator((await context.getProfilesByLogin()).profiles ?? []);
        if (!creator.ok) {
          const { ok: _ok, ...refusal } = creator;
          return jsonContent(refusal);
        }
        const client = await context.getClient();
        await context.getGuardianUserId();
        for (const t of targets) {
          if (!t.name) {
            return jsonContent({
              error: 'no_name',
              person_ref: t.person_ref,
              message: "This person has no name to check against Aula's recipient search.",
            });
          }
          const check = confirmRecipient(
            t,
            await client.findRecipients({
              text: t.name,
              ownInstitutionProfileId: creator.id,
              portalRoles: t.role ? [t.role] : [],
            }),
          );
          if (!check.ok) {
            const { ok: _ok, ...refusal } = check;
            return jsonContent(refusal);
          }
        }
        const preview = buildThreadPreview(subject, targets, text);
        const { draft_ref, expires_in_s } = threadDrafts.create({
          subject,
          html: textToHtml(text),
          creatorId: creator.id,
          recipientIds: targets.map((t) => t.institutionProfileId),
          preview,
        });
        return jsonContent({
          draft_ref,
          expires_in_s,
          preview,
          next:
            'Nothing has been sent. Show `preview` to the user word for word and send only ' +
            'after an explicit yes.',
        });
      },
    );

    server.registerTool(
      'aula.messages.send_thread',
      {
        title: 'Send a prepared new thread',
        description:
          'Step 2 of 2. SENDS the new thread prepared by aula.messages.prepare_thread. Call this ' +
          'ONLY after showing the user that preview verbatim and getting an explicit yes in this ' +
          'conversation — never on your own initiative. A draft_ref works once and expires. The ' +
          'answer reads the new thread back: `verified: true` means it is in your inbox with the ' +
          'text and every intended recipient. On false or an error, do NOT send again — tell the ' +
          'user and look for it with aula.messages.list_threads first. Enabled when ' +
          'AULA_MCP_WRITE=1.',
        inputSchema: {
          draft_ref: z.string().min(1).describe('From aula.messages.prepare_thread.'),
        },
      },
      async (args) => {
        // Connected first, so a failure to reach Aula does not use up the draft.
        const client = await context.getClient();
        await context.getGuardianUserId();
        // Out of the store before anything is sent — this ref cannot send twice.
        const draft = threadDrafts.take(args.draft_ref);
        // The threads that existed before sending: the read-back may only
        // confirm one that is new. Without that baseline nothing is sent.
        let before: Set<number>;
        try {
          before = new Set((await client.getThreads({ page: 0 })).map((t) => t.id));
        } catch (e) {
          return jsonContent({
            error: 'not_sent',
            message:
              'Could not read the inbox before sending, so a send could not be confirmed ' +
              'afterwards. Nothing was sent — prepare the thread again.',
            detail: e instanceof Error ? e.message : String(e),
          });
        }

        const sentAfterMs = Date.now();
        let upstreamId: number | undefined;
        let sendError: string | undefined;
        try {
          upstreamId = upstreamThreadId(
            await client.startNewThread({
              subject: draft.subject,
              html: draft.html,
              recipients: draft.recipientIds.map((id) => ({
                id,
                mailBoxOwnerType: 'institutionProfile' as const,
              })),
              creator: { id: draft.creatorId, mailBoxOwnerType: 'institutionProfile' },
            }),
          );
        } catch (e) {
          // Not rethrown: a failed request may still have created the thread.
          sendError = e instanceof Error ? e.message : String(e);
        }

        let stateRead = false;
        let threadFound = false;
        let checked: ReturnType<typeof checkStartedThread> | undefined;
        let verificationError: string | undefined;
        let thread_ref: string | undefined;
        try {
          const listing = await client.getThreads({ page: 0 });
          stateRead = true;
          const started = findStartedThread(
            listing,
            draft.subject,
            sentAfterMs,
            upstreamId,
            before,
          );
          if (started) {
            threadFound = true;
            thread_ref = threadRefs.refFor(started);
            checked = checkStartedThread(
              await client.getThreadData(started.id),
              draft,
              sentAfterMs,
            );
          }
        } catch (e) {
          verificationError = e instanceof Error ? e.message : String(e);
        }
        const verified = checked?.textFound === true && checked.recipientsConfirmed;

        return jsonContent({
          upstream: sendError ? { ok: false, error: sendError } : { ok: true },
          /** The read-back succeeded. Says nothing about what it found. */
          stateRead,
          /** The thread is in the inbox with the text and every intended recipient. */
          verified,
          ...(thread_ref ? { thread_ref } : {}),
          ...(checked
            ? {
                observed: {
                  matchedBy:
                    upstreamId !== undefined && threadFound ? 'listing+upstream id' : 'listing',
                  textFound: checked.textFound,
                  recipientsConfirmed: checked.recipientsConfirmed,
                  ...(checked.missingRecipients > 0
                    ? { missingRecipients: checked.missingRecipients }
                    : {}),
                },
              }
            : {}),
          subject: draft.subject,
          recipients: draft.preview.recipients.map((r) => r.name),
          ...(verificationError ? { verificationError } : {}),
          ...(!verified
            ? {
                warning:
                  'Not confirmed. Do not send again: tell the user, and look for the thread with ' +
                  'aula.messages.list_threads before preparing a new one.',
              }
            : {}),
        });
      },
    );
  }

  // --- aula.ugeplan.* ------------------------------------------------------
  //
  // Each provider has its own tool. The agent picks the right one based on
  // the institution-to-provider mapping (currently: try whichever the
  // school uses; long term, plumb this into discover).

  const integrationContextShape = {
    childIds: z.array(z.number().int().positive()).min(1),
    institutionCodes: z.array(z.string().min(1)).min(1),
    isoWeek: z
      .string()
      .regex(/^\d{4}-W\d{2}$/)
      .optional()
      .describe('ISO week, e.g. "2026-W18". Defaults to the current week.'),
  } as const;

  async function buildIntegrationCtx(args: {
    childIds: number[];
    institutionCodes: string[];
    isoWeek?: string | undefined;
  }) {
    // Ensures context.record is populated (buildClient() sets it) before the
    // read below — the returned client itself isn't needed here, both calls
    // further down (getGuardianUserId, getProfilesByLogin) fetch it again
    // from AulaContext's own cache.
    await context.getClient();
    const record = context.record;
    if (!record) throw new Error('AulaContext: no token record loaded');
    // EasyIQ / MU / Meebook want the numeric guardian user-id (from
    // getProfileContext). Systematic uses the literal MitID username for its
    // sessionId — that's the only integration where `sessionId` and the
    // numeric id differ. SystematicClient currently reads `ctx.sessionId`
    // (= username), so we keep that field as the username and put the
    // numeric id under `guardianId` for the other plugins.
    const guardianUserId = await context.getGuardianUserId();

    // SkolePortal's `x-childfilter` header takes the opaque per-child userId
    // (alphanumeric token), not the numeric child profile id. Look it up
    // from the profiles list, aligned with childIds by index. Missing → "".
    const profilesData = await context.getProfilesByLogin();
    const userIdByChildId = new Map<number, string>();
    for (const profile of profilesData.profiles ?? []) {
      for (const child of profile.children ?? []) {
        if (child.userId != null) {
          userIdByChildId.set(child.id, String(child.userId));
        }
      }
    }
    const childUserIds = args.childIds.map((id) => userIdByChildId.get(id) ?? '');

    return {
      isoWeek: args.isoWeek ?? isoWeekString(),
      sessionId: record.username,
      guardianId: guardianUserId,
      childIds: args.childIds,
      childUserIds,
      institutionCodes: args.institutionCodes,
    };
  }

  server.registerTool(
    'aula.ugeplan.easyiq',
    {
      title: 'EasyIQ weekly plan',
      description:
        'Weekly plan from EasyIQ for the given children. Use when the school is on EasyIQ.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const easyiq = await context.getEasyIq();
      return jsonContent(await easyiq.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugeplan.meebook',
    {
      title: 'Meebook weekly plan',
      description:
        'Weekly plan from Meebook for the given children. Use when the school is on Meebook.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const meebook = await context.getMeebook();
      return jsonContent(await meebook.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugeplan.easyiq_skoleportal',
    {
      title: 'EasyIQ SkolePortal weekly plan',
      description:
        'Weekly plan from EasyIQ SkolePortal (widget 0128) — a different EasyIQ product than ' +
        '`aula.ugeplan.easyiq` (widget 0001). Use when discover.detectedWidgets contains "0128".',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const sp = await context.getEasyIqSkoleportal();
      return jsonContent(await sp.getWeekPlan(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.lektier.easyiq',
    {
      title: 'EasyIQ Lektier (homework)',
      description:
        'Homework items from EasyIQ Lektier (widget 0142) — same vendor as ' +
        '`aula.ugeplan.easyiq_skoleportal` but a separate "Lektier" product. ' +
        'Use when discover.detectedWidgets contains "0142".',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const lektier = await context.getEasyIqLektier();
      return jsonContent(await lektier.getLektier(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.opgaver.minuddannelse',
    {
      title: 'Min Uddannelse opgaveliste',
      description:
        'Homework / task list from Min Uddannelse for the given children. `content` holds ' +
        "the forløb name plus the teacher's description as plain text, fetched through a " +
        'minuddannelse.net session; if that fails the items come back title-only with a warning.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getOpgaver(await buildIntegrationCtx(args)));
    },
  );

  server.registerTool(
    'aula.ugebrev.minuddannelse',
    {
      title: 'Min Uddannelse ugebrev',
      description: 'Weekly newsletter (ugebrev) from Min Uddannelse.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const mu = await context.getMinUddannelse();
      return jsonContent(await mu.getUgebrev(await buildIntegrationCtx(args)));
    },
  );

  // --- aula.fravaer.tabulex_* -----------------------------------------------
  //
  // "Fravær - forældreindberetning" (widget 0047) — parent absence reporting
  // via Tabulex. Unlike the ugeplan/opgaver/ugebrev providers above, Tabulex
  // is session-based (WS-Federation → FedAuth cookies), not a per-call
  // Bearer token — see TabulexClient's module docstring for the full
  // handshake.
  //
  // Tabulex identifies a child by their real CPR number — it is the path
  // segment in every Fravær URL, and the one field `meld_syg` PUTs. That is
  // fine inside this process; it is not fine on the tool surface. Everything
  // a tool returns travels to whichever model is driving the server and lands
  // in a conversation history the operator does not control, and a child's CPR
  // is a different category of data from "was he away on Tuesday". Nothing in
  // absence reporting actually needs the number itself — only the ability to
  // name *which* child — so the tools trade in an opaque `child_ref` and the
  // CPR stays here.
  //
  // Refs are per server run and deliberately not persisted: they are minted by
  // aula.fravaer.tabulex_boern, which the caller has to go through anyway, and
  // a ref that outlived a restart would be a CPR cache on disk in all but name.

  const childRefs = createTabulexChildRefs();

  const tabulexChildRefShape = {
    ...integrationContextShape,
    child_ref: z
      .string()
      .min(1)
      .describe(
        "An opaque reference to the child, from aula.fravaer.tabulex_boern's `child_ref` " +
          'field. Valid only for the current MCP session — call tabulex_boern again if it ' +
          'is rejected.',
      ),
  } as const;

  server.registerTool(
    'aula.fravaer.tabulex_boern',
    {
      title: 'Tabulex Fravær — children with access',
      description:
        'List the guardian\'s children with access to Tabulex "Fravær - ' +
        'forældreindberetning" (absence reporting, widget 0047). Each entry has a ' +
        '`child_ref` — an opaque handle required by every other aula.fravaer.tabulex_* ' +
        'call. Also reports `skoleFravaerAdgang`: false if the institution has disabled ' +
        'parent absence-reporting for that child. ' +
        'IMPORTANT: `childIds` here is a lookup/scope set for the Tabulex SSO session, ' +
        "NOT a filter on this response — Tabulex's own API returns every child the " +
        "guardian has Fravær access to regardless of which ids were passed, and Tabulex's " +
        'child records carry no Aula child id to filter on. This always returns ALL of ' +
        "the guardian's children with access; match the returned `fornavn`/`efternavn` " +
        'against the child you mean before using its `child_ref`.',
      inputSchema: integrationContextShape,
    },
    async (args) => {
      const tabulex = guardTabulex(await context.getTabulex());
      const children = await tabulex.getPersonsAdgangTilBoern(await buildIntegrationCtx(args));
      return jsonContent(children.map((child) => childRefs.publicEntry(child)));
    },
  );

  server.registerTool(
    'aula.fravaer.tabulex_idag',
    {
      title: 'Tabulex Fravær — today',
      description: "Today's absence status for one child, from Tabulex.",
      inputSchema: tabulexChildRefShape,
    },
    async (args) => {
      const cpr = childRefs.cprFor(args.child_ref);
      const tabulex = guardTabulex(await context.getTabulex());
      return jsonContent(
        stripTabulexRaw(await tabulex.getFravaerIdag(await buildIntegrationCtx(args), cpr)),
      );
    },
  );

  server.registerTool(
    'aula.fravaer.tabulex_imorgen',
    {
      title: 'Tabulex Fravær — tomorrow',
      description: "Tomorrow's absence status for one child, from Tabulex.",
      inputSchema: tabulexChildRefShape,
    },
    async (args) => {
      const cpr = childRefs.cprFor(args.child_ref);
      const tabulex = guardTabulex(await context.getTabulex());
      return jsonContent(
        stripTabulexRaw(await tabulex.getFravaerImorgen(await buildIntegrationCtx(args), cpr)),
      );
    },
  );

  server.registerTool(
    'aula.fravaer.tabulex_skoledage',
    {
      title: 'Tabulex Fravær — upcoming school days',
      description: 'Absence over the coming school days for one child, from Tabulex.',
      inputSchema: tabulexChildRefShape,
    },
    async (args) => {
      const cpr = childRefs.cprFor(args.child_ref);
      const tabulex = guardTabulex(await context.getTabulex());
      return jsonContent(await tabulex.getFravaerSkoledage(await buildIntegrationCtx(args), cpr));
    },
  );

  server.registerTool(
    'aula.fravaer.tabulex_oversigt',
    {
      title: 'Tabulex Fravær — quarterly overview',
      description: 'Quarterly absence statistics and history for one child, from Tabulex.',
      inputSchema: {
        ...tabulexChildRefShape,
        aar: z.number().int().min(2000).describe('Year, e.g. 2026.'),
        kvartal: z.number().int().min(1).max(4).describe('Quarter, 1-4.'),
      },
    },
    async (args) => {
      const cpr = childRefs.cprFor(args.child_ref);
      const tabulex = guardTabulex(await context.getTabulex());
      return jsonContent(
        await tabulex.getFravaerOversigt(
          await buildIntegrationCtx(args),
          cpr,
          args.aar,
          args.kvartal,
        ),
      );
    },
  );

  // --- aula.fravaer.tabulex_meld_syg (gated, write) -------------------------
  //
  // Same gate and the same reason as aula.presence.report_sick — and a
  // stricter one: Tabulex's own UI has no undo for this action at all
  // (Aula's report_sick can at least be taken back with sick:false; there is
  // no equivalent "un-meld" call here). NEVER exercised against the live API
  // during development — see TabulexClient's module docstring.

  if (process.env.AULA_MCP_WRITE === '1') {
    server.registerTool(
      'aula.fravaer.tabulex_meld_syg',
      {
        title: 'Report a child sick via Tabulex Fravær (CANNOT be undone)',
        description:
          'Report a child sick for today or tomorrow via Tabulex "Fravær - ' +
          'forældreindberetning" (widget 0047). WRITES to Tabulex — enabled when ' +
          'AULA_MCP_WRITE=1. Tabulex has NO way to undo or cancel this once sent — unlike ' +
          'aula.presence.report_sick there is no false/take-it-back equivalent. Confirm ' +
          'the exact child and day with the user before calling; never call this from an ' +
          'inferred or ambiguous mention that a child might be unwell. The reply reads the ' +
          'day back as `observed`, but `stateRead: true` only means the read succeeded — ' +
          'Tabulex has no documented field that confirms a report, so compare `observed` ' +
          'against what the user asked for instead of treating it as a confirmation.',
        inputSchema: {
          ...tabulexChildRefShape,
          when: z.enum(['today', 'tomorrow']).describe('Which day to report sick for.'),
        },
      },
      async (args) => {
        const cpr = childRefs.cprFor(args.child_ref);
        const tabulex = guardTabulex(await context.getTabulex());
        const ctx = await buildIntegrationCtx(args);
        // Tabulex's response to MeldSyg has never been observed, so none of it is
        // passed on: a confirmation that echoed the CPR back would otherwise go
        // straight to the model. Success is simply the absence of a throw.
        await tabulex.reportSick(ctx, cpr, args.when);

        // Read the state back rather than trusting the absence of a throw.
        // Live-tested 2026-10-02: a child already reported sick got
        // `{reported: true}` from a write that changed nothing — a PUT that
        // 200s proves the request was accepted, not that it changed
        // anything. Tabulex has NO undo for this call, so the tool's answer
        // has to be what Tabulex now reports for the day, not an inference
        // from the write succeeding. Reuses `ctx` — no extra SSO handshake.
        let observed: Record<string, unknown> | null = null;
        let verificationError: string | undefined;
        try {
          const dag =
            args.when === 'today'
              ? await tabulex.getFravaerIdag(ctx, cpr)
              : await tabulex.getFravaerImorgen(ctx, cpr);
          observed = stripTabulexRaw(dag);
        } catch (e) {
          // A failed verification read must never look like a confirmed
          // write — say so explicitly rather than falling back to the
          // upstream flag silently. guardTabulex has already redacted any
          // CPR from e's message.
          verificationError = e instanceof Error ? e.message : String(e);
        }

        // Deliberately `stateRead`, not `verified`. Aula documents its
        // status codes, so there we can say whether the state matches the
        // request — Tabulex documents nothing, and the one live observation
        // we have (2026-10-02) was of a child ALREADY reported sick, so it
        // cannot tell us which field a fresh report moves. Asserting
        // confirmation from that would be inventing semantics from a single
        // uncontrolled measurement. The model gets the observed day and
        // judges for itself.
        return jsonContent({
          upstreamReported: true,
          when: args.when,
          /** The day was read back. Tabulex has no documented field that
           *  confirms a report, so this is NOT a confirmation — compare
           *  `observed` against what the user asked for. */
          stateRead: observed !== null,
          observed,
          ...(verificationError ? { verificationError } : {}),
        });
      },
    );
  }

  server.registerTool(
    'aula.huskelisten.systematic',
    {
      title: 'Systematic Huskelisten reminders',
      description:
        'Homework reminders from Systematic. Args may include `from`/`to` ISO YYYY-MM-DD dates.',
      inputSchema: {
        ...integrationContextShape,
        fromDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        toDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      },
    },
    async (args) => {
      const sys = await context.getSystematic();
      const baseCtx = await buildIntegrationCtx(args);
      return jsonContent(
        await sys.getReminders({
          ...baseCtx,
          ...(args.fromDate ? { fromDate: args.fromDate } : {}),
          ...(args.toDate ? { toDate: args.toDate } : {}),
        }),
      );
    },
  );

  // --- aula.messages.get_thread --------------------------------------------

  server.registerTool(
    'aula.messages.get_thread',
    {
      title: 'Read a single thread',
      description:
        'Returns subject + every message in the thread. Pass the `thread_ref` from ' +
        'aula.messages.list_threads or aula.messages.new_since. Reading does NOT mark the ' +
        'thread as read in Aula — it stays unread in the app until the user opens it there. ' +
        'Threads the listing marks `sensitive: true` are refused here — they are read only ' +
        "through aula.sensitive.prepare_read with the user's explicit yes.",
      inputSchema: {
        thread_ref: z
          .string()
          .min(1)
          .optional()
          .describe('From aula.messages.list_threads. Valid for the current MCP session only.'),
        threadId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Legacy: a raw thread id. Prefer thread_ref.'),
        page: z.number().int().min(0).default(0).optional(),
      },
    },
    async (args) => {
      // thread_ref wins when both are given: it is the handle the listing
      // issues, and resolving it server-side is the point of having it.
      const target = openableThread(args);
      if (!target.ok) return jsonContent(target.refusal);
      const threadId = target.id;
      const client = await context.getClient();
      // Prime the guardian profile before fetching. Aula's
      // messaging.getMessagesForThread returns HTTP 403 if the
      // guardian profile hasn't been activated on the server side
      // this session, even with a fully step-up'd bearer. aula.discover
      // implicitly primes via getGuardianUserId() — but if the agent
      // calls get_thread directly (cached threadId from a prior turn,
      // skipping discover), no priming has happened. getGuardianUserId
      // memoises after the first call, so this is a no-op once primed.
      await context.getGuardianUserId();
      try {
        return jsonContent(
          await client.getMessagesForThread(threadId, {
            ...(args.page !== undefined ? { page: args.page } : {}),
          }),
        );
      } catch (e) {
        if (e instanceof AulaStepUpRequiredError) {
          return jsonContent({
            error: 'step_up_required',
            message: e.message,
            hint: 'Run `aula login` again to refresh your session, then retry.',
          });
        }
        throw e;
      }
    },
  );

  // --- aula.messages.get_attachment ----------------------------------------
  //
  // Download a message attachment server-side and return a local file path.
  // Necessary because Aula attachment URLs are CloudFront presigned links
  // with long opaque signatures; LLMs frequently corrupt them when echoing
  // the URL into other tool calls (the typical symptom is a chain of
  // MalformedSignature / AccessDenied 403s from S3 even though the URL is
  // still within its 1h validity window). Returning a local path keeps the
  // URL out of the model's emit path entirely.

  server.registerTool(
    'aula.messages.get_attachment',
    {
      title: 'Download a thread attachment to local disk',
      description:
        'Download an attachment from a thread message and write it to a ' +
        'local temporary file, returning the file path. Prefer this over ' +
        'passing Aula attachment URLs through the model — CloudFront ' +
        'presigned URLs are long opaque blobs that LLMs often mangle when ' +
        'echoing into tool calls (MalformedSignature / AccessDenied 403). ' +
        '`attachmentIndex` is zero-based across all attachments in the ' +
        'thread, flattened message-by-message in the order returned by ' +
        '`aula.messages.get_thread`. Pass the same `thread_ref` you used there.',
      inputSchema: {
        thread_ref: z
          .string()
          .min(1)
          .optional()
          .describe('From aula.messages.list_threads. Valid for the current MCP session only.'),
        threadId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Legacy: a raw thread id. Prefer thread_ref.'),
        attachmentIndex: z.number().int().min(0),
      },
    },
    async (args) => {
      // Same resolution as get_thread: the listing no longer exposes raw
      // ids, so without this a model could never get from a thread_ref to
      // its attachments. A sensitive thread's attachments are refused too.
      const target = openableThread(args);
      if (!target.ok) return jsonContent(target.refusal);
      const threadId = target.id;
      const client = await context.getClient();
      await context.getGuardianUserId();
      // Re-fetch the thread to get a fresh URL; presigned URLs age out
      // within ~1h and we never want to download against a cached one.
      const { messages } = await client.getMessagesForThread(threadId);
      const flat = messages.flatMap((m) => m.attachments ?? []);
      const att = flat[args.attachmentIndex];
      // Images (and other media) arrive with `file: null` and the real envelope
      // under `media.file`.
      const file = att?.file ?? att?.media?.file;
      if (!file?.url) {
        return jsonContent({
          error: 'attachment_not_found',
          ...(args.thread_ref !== undefined ? { thread_ref: args.thread_ref } : { threadId }),
          attachmentIndex: args.attachmentIndex,
          totalAttachments: flat.length,
        });
      }
      const result = await downloadAttachmentToDisk({
        url: file.url,
        filename: file.name ?? `attachment-${args.attachmentIndex}.bin`,
        // The resolved id, not args.threadId — that is unset when the caller
        // passed a thread_ref.
        prefix: `${threadId}-${args.attachmentIndex}`,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      });
      return jsonContent(result);
    },
  );

  // --- aula.posts.get_attachment -------------------------------------------
  //
  // Same rationale as aula.messages.get_attachment above: keep the presigned
  // URL out of the model's emit path. Posts differ only in that the caller
  // already holds the URL, from the attachments array in aula.posts.list.

  server.registerTool(
    'aula.posts.get_attachment',
    {
      title: 'Download a post attachment to local disk',
      description:
        'Download an attachment from a news feed post and write it to a local ' +
        'temporary file, returning the path. Pass `url` and `name` exactly as ' +
        'they appear in the attachments array from `aula.posts.list` — the ' +
        'CloudFront signature is part of the URL, so altering a single ' +
        'character produces a MalformedSignature 403.',
      inputSchema: {
        postId: z.number().int().describe('The post the attachment belongs to (names the file).'),
        url: z.string().url().describe('The exact presigned URL from the posts feed.'),
        filename: z.string().describe("e.g. 'Kostplan_juni_2026.pdf'"),
      },
    },
    async (args) => {
      return jsonContent(
        await downloadAttachmentToDisk({
          url: args.url,
          filename: args.filename,
          prefix: `post-${args.postId}`,
        }),
      );
    },
  );

  // --- aula.utils.extract_pdf_text ------------------------------------------
  //
  // Aula sends a lot of what parents actually need as PDF attachments —
  // menus, packing lists, trip letters — so downloading one is only half the
  // job. pdf-parse is imported lazily: it pulls in pdf.js, and a server whose
  // user never opens a PDF should not pay for that at boot.

  server.registerTool(
    'aula.utils.extract_pdf_text',
    {
      title: 'Extract text from a local PDF file',
      description:
        'Read a PDF from a local absolute path — typically one returned by ' +
        'aula.posts.get_attachment or aula.messages.get_attachment — and ' +
        'return its text so it can be read or summarised.',
      inputSchema: {
        path: z.string().describe('Absolute local path to the PDF.'),
      },
    },
    async (args) => {
      let parser: { getText(): Promise<PdfTextResult>; destroy?(): Promise<void> } | undefined;
      try {
        const { PDFParse } = (await import('pdf-parse')) as unknown as {
          PDFParse: new (opts: {
            data: Buffer;
          }) => {
            getText(): Promise<PdfTextResult>;
            destroy?(): Promise<void>;
          };
        };
        parser = new PDFParse({ data: await readFile(args.path) });
        const result = await parser.getText();
        return jsonContent({
          ok: true,
          text: result.text,
          pages: result.total,
          info: result.info,
        });
      } catch (error) {
        return jsonContent({
          ok: false,
          error: 'failed_to_read_pdf',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        // v2 holds pdf.js resources open; release them even on the error path.
        if (parser?.destroy) await parser.destroy();
      }
    },
  );
}
