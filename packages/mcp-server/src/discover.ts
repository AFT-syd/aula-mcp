/**
 * The `aula.discover` tool — the central thing this MCP server exists for.
 *
 * One call returns a typed manifest of the user's children, institutions,
 * available capabilities, and which subordinate tools the agent can call. The
 * agent uses this to dynamically pick what to query next without us having to
 * hard-code a fixed tool tree.
 *
 * Per-institution provider detection (Q2 fix): we read
 * `pageConfiguration.widgetConfigurations` from `getProfileContext` and map
 * widget IDs to provider names. The capabilities block then lists the right
 * tool first for the schools you're enrolled in.
 */

import { sanitizeUrl } from '@aula-mcp/aula-auth';
import type { IntegrationContext, NormalisedWeekPlan } from '@aula-mcp/aula-client';
import { isoWeekString } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import { redactCprFromError } from './redact.ts';

/** A single child the user can act on behalf of. */
export interface DiscoveredChild {
  id: number;
  name: string;
  /** The Aula institution-profile id used by API methods like getDailyOverview.
   *  Aula returns this as either a number or an opaque string token. */
  userId?: string | number;
  institution?: {
    id: number;
    name?: string;
    code?: string;
  };
}

/** Capability description for one functional area. */
export interface DiscoveredCapability {
  /** Human description for the agent. */
  summary: string;
  /** MCP tool names the agent can call to use this capability. */
  tools: string[];
  /** Optional notes specific to this user's institutions. */
  notes?: string;
}

/** Result of actually calling one ugeplan/ugebrev provider during a probe. */
export interface ProbedSourceResult {
  /** The aula.* tool this result is for. */
  tool: string;
  /** 'content': returned at least one item. 'empty': call succeeded, no
   *  items. 'error': the call itself failed — see `error`. */
  status: 'content' | 'empty' | 'error';
  /** Item count. Only present when status is 'content'. */
  items?: number;
  /** Sanitised failure message. Only present when status is 'error'. Run
   *  through the same CPR/URL redaction as every other tool error — see
   *  redactCprFromError (tools.ts) and sanitizeUrl (aula-auth). */
  error?: string;
}

export interface DiscoverManifest {
  user: {
    name: string;
    /** MitID username (for diagnostic display). */
    username: string;
    /** Currently-selected identity name, when known. */
    identityName?: string;
  };
  children: DiscoveredChild[];
  apiVersion: number;
  tokens: {
    /** Unix epoch seconds. */
    expires_at: number;
    /** Seconds remaining (negative if expired). */
    seconds_remaining: number;
  };
  capabilities: Record<string, DiscoveredCapability>;
  /** Widget IDs the schools surfaced in pageConfiguration. Useful when
   *  diagnosing "the agent can't find my kid's ugeplan". */
  detectedWidgets: string[];
  /** Only present when called with `probe: true` — the result of actually
   *  calling every ugeplan provider + ugebrev for the current week, so the
   *  agent can see which source has real content instead of brute-forcing
   *  them one by one. */
  probed?: ProbedSourceResult[];
  /** True when AULA_MCP_RAW=1 — the aula.raw_request escape hatch is callable. */
  rawRequestEnabled: boolean;
  /** True when AULA_MCP_WRITE=1 — write tools (aula.presence.set_template) are
   *  registered. Off by default; the server is read-only unless opted in. */
  writeEnabled: boolean;
  /** Inline hints repeating server `instructions` so the agent has the
   *  workflow next to the data it just read. Cheaper to ground on this
   *  than to re-fetch context — keep tight. */
  usage: {
    cache: string;
    nameResolution: string;
    /** Which capability answers which kind of question. */
    whichSource: string;
    pickOne: string;
    timeWindows: string;
    language: string;
  };
}

/**
 * Aula widget IDs map to which third-party provider serves which capability.
 * Source: scaarup/aula client.py + the helmstedt API blog posts.
 */
const WIDGET_PROVIDER_MAP: Readonly<
  Record<string, { capability: string; provider: string; tool: string }>
> = Object.freeze({
  '0001': { capability: 'ugeplan', provider: 'easyiq', tool: 'aula.ugeplan.easyiq' },
  '0004': { capability: 'ugeplan', provider: 'meebook', tool: 'aula.ugeplan.meebook' },
  '0029': { capability: 'ugebrev', provider: 'minuddannelse', tool: 'aula.ugebrev.minuddannelse' },
  '0030': { capability: 'opgaver', provider: 'minuddannelse', tool: 'aula.opgaver.minuddannelse' },
  '0062': {
    capability: 'huskelisten',
    provider: 'systematic',
    tool: 'aula.huskelisten.systematic',
  },
  '0128': {
    capability: 'ugeplan',
    provider: 'easyiq_skoleportal',
    tool: 'aula.ugeplan.easyiq_skoleportal',
  },
  '0142': {
    capability: 'lektier',
    provider: 'easyiq_lektier',
    tool: 'aula.lektier.easyiq',
  },
  '0047': {
    capability: 'fravaer',
    provider: 'tabulex',
    tool: 'aula.fravaer.tabulex_boern',
  },
});

export interface BuildDiscoverManifestOptions {
  /** When true, actually call every ugeplan provider + ugebrev for the
   *  current week and report which has content (see `probeUgeplanAndUgebrev`
   *  below). Off by default — this makes real upstream calls and costs time,
   *  which is exactly what a plain `aula.discover` is meant to avoid. */
  probe?: boolean;
}

export async function buildDiscoverManifest(
  context: AulaContext,
  options: BuildDiscoverManifestOptions = {},
): Promise<DiscoverManifest> {
  const client = await context.getClient();
  const record = context.record;
  if (!record) throw new Error('AulaContext: record missing after getClient()');

  // forceRefresh: discover is the tool callers are told to re-run on
  // "children or widgets unknown" — that instruction has to mean "fetch
  // current data", so it bypasses AulaContext's profiles cache rather than
  // potentially serving a stale answer back to the same prompt that asked
  // for a refresh.
  const [profilesData, contextData] = await Promise.all([
    context.getProfilesByLogin({ forceRefresh: true }),
    client.getProfileContext('guardian').catch(() => undefined),
  ]);

  const children: DiscoveredChild[] = [];
  for (const profile of profilesData.profiles ?? []) {
    for (const child of profile.children ?? []) {
      const inst = child.institutionProfile;
      const item: DiscoveredChild = { id: child.id, name: child.name };
      if (child.userId !== undefined) item.userId = child.userId;
      if (inst) {
        const institution: DiscoveredChild['institution'] = { id: inst.id };
        if (inst.institutionName !== undefined) institution.name = inst.institutionName;
        if (inst.institutionCode !== undefined) institution.code = inst.institutionCode;
        item.institution = institution;
      }
      children.push(item);
    }
  }

  // Capability detection from widget configs.
  // Aula nests the widget id under `widget.widgetId` in the live API; older
  // shape was flat (`w.widgetId`). Support both — Python does too.
  const detectedWidgets = Array.from(
    new Set(
      (contextData?.pageConfiguration?.widgetConfigurations ?? [])
        .map((w) => w.widget?.widgetId ?? w.widgetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ).sort();

  const writeEnabled = process.env.AULA_MCP_WRITE === '1';
  const now = Math.floor(Date.now() / 1000);
  const manifest: DiscoverManifest = {
    user: {
      name: profilesData.profiles?.[0]?.displayName ?? record.username,
      username: record.username,
      ...(record.identityName ? { identityName: record.identityName } : {}),
    },
    children,
    apiVersion: client.currentApiVersion,
    tokens: {
      expires_at: record.tokens.expires_at,
      seconds_remaining: record.tokens.expires_at - now,
    },
    capabilities: buildCapabilities(detectedWidgets, writeEnabled),
    detectedWidgets,
    rawRequestEnabled: process.env.AULA_MCP_RAW === '1',
    writeEnabled,
    usage: {
      cache:
        'Reuse this manifest for the rest of the session. Do not call aula.discover again unless a tool reports unknown children/widgets.',
      nameResolution:
        'Match kid names from the user prompt against children[].name (case-insensitive, partial). E.g. "luk" matches "Lukas". Use the matched child.id for BOTH childIds and profileIds — both take the numeric id. children[].userId is a string used only internally by the integration tools.',
      whichSource:
        'Danish users mix these up, and they are different sources. "Skoleskema", "lektioner", "hvornår har de matematik" → aula.calendar.events. "Ugeplan", "ugeskema", "ugebrev", "hvad sker der i klassen denne uge" → the teacher-written text in ugeplan/ugebrev. If the wording could mean either, check both before answering.',
      pickOne:
        'For ugeplan/ugebrev/opgaver/huskelisten, start with capabilities[area].tools[0] — the provider this user most likely has. But if it errors OR returns empty, work through the remaining tools in the list, then try the neighbouring capability: a school with nothing in ugeplan often has the real content in ugebrev, and the other way round. Only report "nothing found" once ugeplan AND ugebrev have both come back empty. If you are about to brute-force several ugeplan tools plus ugebrev by hand (3+ calls, all empty so far), call aula.discover again with probe:true instead — it makes those same calls once, server-side, and returns a `probed` list with each source\'s status (content/empty/error) and item count, so you can go straight to the one that actually has content.',
      timeWindows:
        'For calendar/ugeplan: "denne uge"→range:"this_week", "næste uge"→"next_week", "i dag"→"today", "i morgen"→"tomorrow". Request windows are Europe/Copenhagen wall-clock, but aula.calendar.events RETURNS UTC timestamps — convert before showing a time (+2h summer, +1h winter).',
      language:
        'Reply in the user\'s language. Format dates as "mandag 12. maj" for Danish output.',
    },
  };
  if (options.probe) {
    manifest.probed = await probeUgeplanAndUgebrev(context, children);
  }
  return manifest;
}

/**
 * Actually call every ugeplan provider + ugebrev for the current week and
 * report which one has content — instead of the agent brute-forcing all
 * three ugeplan tools the way a real session was observed to do:
 * `detectedWidgets` can omit a widget that
 * works, and an empty 200 from ugeplan doesn't mean ugebrev is empty too.
 *
 * Uses the children/institution codes `buildDiscoverManifest` already
 * resolved — the caller never has to supply them. Each provider is probed
 * independently (`Promise.allSettled`) so one failing integration can never
 * take the others, or the rest of `aula.discover`, down with it.
 */
async function probeUgeplanAndUgebrev(
  context: AulaContext,
  children: DiscoveredChild[],
): Promise<ProbedSourceResult[]> {
  const ctx = await buildProbeIntegrationContext(context, children);

  const probes: ReadonlyArray<{ tool: string; run: () => Promise<NormalisedWeekPlan> }> = [
    {
      tool: 'aula.ugeplan.meebook',
      run: async () => (await context.getMeebook()).getWeekPlan(ctx),
    },
    {
      tool: 'aula.ugeplan.easyiq',
      run: async () => (await context.getEasyIq()).getWeekPlan(ctx),
    },
    {
      tool: 'aula.ugeplan.easyiq_skoleportal',
      run: async () => (await context.getEasyIqSkoleportal()).getWeekPlan(ctx),
    },
    {
      tool: 'aula.ugebrev.minuddannelse',
      run: async () => (await context.getMinUddannelse()).getUgebrev(ctx),
    },
  ];

  const settled = await Promise.allSettled(probes.map((p) => p.run()));
  return settled.map((outcome, i): ProbedSourceResult => {
    // Guarded by construction: `settled` has one entry per `probes` element.
    const tool = probes[i]?.tool ?? 'unknown';
    if (outcome.status === 'fulfilled') {
      const items = outcome.value.items.length;
      return items > 0 ? { tool, status: 'content', items } : { tool, status: 'empty' };
    }
    return { tool, status: 'error', error: sanitizeProbeError(outcome.reason) };
  });
}

/** Build the shared IntegrationContext every ugeplan/ugebrev provider takes,
 *  from data `buildDiscoverManifest` already fetched — mirrors tools.ts's
 *  `buildIntegrationCtx`, but a probe has no caller-supplied childIds /
 *  institutionCodes to start from, only the manifest's own `children`. */
async function buildProbeIntegrationContext(
  context: AulaContext,
  children: DiscoveredChild[],
): Promise<IntegrationContext> {
  const record = context.record;
  if (!record) throw new Error('AulaContext: record missing after getClient()');
  const guardianId = await context.getGuardianUserId();
  const institutionCodes = Array.from(
    new Set(
      children
        .map((c) => c.institution?.code)
        .filter((code): code is string => typeof code === 'string' && code.length > 0),
    ),
  );
  return {
    isoWeek: isoWeekString(),
    sessionId: record.username,
    guardianId,
    childIds: children.map((c) => c.id),
    childUserIds: children.map((c) => (c.userId !== undefined ? String(c.userId) : '')),
    institutionCodes,
  };
}

/**
 * Sanitise a probe failure the same way every other tool error is sanitised
 * before it can reach the model (see `redactCprFromError` and `guardTabulex`
 * in tools.ts, `sanitizeUrl` in aula-auth) — a probe calls real upstream
 * integrations, so its failures can carry the same CPR-in-URL or
 * token-in-URL risk as any other integration call.
 */
function sanitizeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Redact any embedded URL wholesale first — sanitizeUrl only understands
  // whole URLs, and a failure message sometimes embeds the request URL
  // verbatim (access_token / widget-token query params, or a Tabulex-style
  // CPR path segment).
  const urlSanitised = message.replace(/https?:\/\/\S+/g, (url) => sanitizeUrl(url));
  // Then redact any CPR-shaped digits left outside of a URL.
  return redactCprFromError(new Error(urlSanitised)).message;
}

/**
 * Build the capabilities block, prefixing the per-school detected providers
 * to each tool list so the agent picks the actually-configured one first.
 */
function buildCapabilities(
  detectedWidgets: string[],
  writeEnabled: boolean,
): Record<string, DiscoveredCapability> {
  const detectedByCapability = new Map<string, { provider: string; tool: string }[]>();
  for (const id of detectedWidgets) {
    const entry = WIDGET_PROVIDER_MAP[id];
    if (!entry) continue;
    const arr = detectedByCapability.get(entry.capability) ?? [];
    arr.push({ provider: entry.provider, tool: entry.tool });
    detectedByCapability.set(entry.capability, arr);
  }

  const ugeplanDetected = detectedByCapability.get('ugeplan') ?? [];
  const opgaverDetected = detectedByCapability.get('opgaver') ?? [];
  const ugebrevDetected = detectedByCapability.get('ugebrev') ?? [];
  const huskelistenDetected = detectedByCapability.get('huskelisten') ?? [];
  const lektierDetected = detectedByCapability.get('lektier') ?? [];
  const fravaerDetected = detectedByCapability.get('fravaer') ?? [];

  // When detection picked a provider for a third-party capability, expose
  // ONLY that tool. Listing alternates as fallbacks invites Claude to fan
  // out and call all three "just to be sure", which is wasteful and noisy
  // — `pickOne` in usage tells it not to, but a one-element array is more
  // load-bearing than a hint.
  const ugeplanCanonical = [
    'aula.ugeplan.meebook',
    'aula.ugeplan.easyiq',
    'aula.ugeplan.easyiq_skoleportal',
  ];
  const ugeplanTools =
    ugeplanDetected.length > 0 ? dedupe(ugeplanDetected.map((d) => d.tool)) : ugeplanCanonical;

  return {
    profiles: {
      summary: 'Read profile and child information for the logged-in guardian.',
      tools: ['aula.profiles.list'],
    },
    presence: {
      summary: writeEnabled
        ? 'Daily presence (arrived/sick/picked up), the recurring komme/gå schedule, ' +
          'setting drop-off/pickup times, and reporting a child sick.'
        : 'Daily presence (arrived/sick/picked up) and the recurring komme/gå ' +
          '(drop-off/pickup) schedule.',
      tools: writeEnabled
        ? [
            'aula.presence.today',
            'aula.presence.templates',
            'aula.presence.set_template',
            'aula.presence.report_sick',
          ]
        : ['aula.presence.today', 'aula.presence.templates'],
      ...(writeEnabled
        ? {
            notes:
              'aula.presence.report_sick notifies the institution and applies to today. ' +
              'Confirm the child and the intent with the user before calling it — do not ' +
              'infer a sick report from a passing mention that a child is unwell.',
          }
        : {
            notes:
              'aula.presence.set_template (writing komme/gå times) and ' +
              'aula.presence.report_sick (reporting a child sick) are available only ' +
              'when the server runs with AULA_MCP_WRITE=1.',
          }),
    },
    calendar: {
      summary:
        'The lesson timetable (skoleskema) — subjects, times, rooms. Not the teacher-written weekly letter; that is ugeplan/ugebrev. Pass `range: "this_week"` for the simplest call. Returns UTC timestamps, and the same lesson often appears twice (subject plus support staff or a parallel group) — surface both.',
      tools: ['aula.calendar.events'],
    },
    messages: {
      summary:
        'Aula messaging threads. list_threads gives a compact inbox (unread_only, child_ids); ' +
        'new_since answers "anything new since X"; get_thread reads one thread by its ' +
        'thread_ref. Reading never marks a thread as read in Aula' +
        (writeEnabled ? ' — only mark_read does' : '') +
        '. Sensitive threads require MitID step-up.',
      tools: [
        'aula.messages.list_threads',
        'aula.messages.new_since',
        'aula.messages.get_thread',
        'aula.messages.find_recipients',
        ...(writeEnabled
          ? [
              'aula.messages.prepare_reply',
              'aula.messages.send_reply',
              'aula.messages.prepare_thread',
              'aula.messages.send_thread',
              'aula.messages.mark_read',
            ]
          : []),
      ],
      notes:
        'Threads marked `sensitive: true` are a separate category: listed by subject only, ' +
        'refused by the aula.messages.* tools, and handled through the sensitive capability. ' +
        'find_recipients finds a person in a group by name AND role; several matches mean ' +
        'asking the user, never picking.' +
        (writeEnabled
          ? ' Replying and writing a new thread are two steps each: prepare_reply / ' +
            'prepare_thread send nothing and return a preview; send_reply / send_thread send ' +
            'it. Show the preview verbatim and get an explicit yes in between — never send a ' +
            'message the user has not seen. aula.messages.mark_read is irreversible — Aula ' +
            'offers no way to set a thread back to unread. Only call it for threads the user ' +
            'has actually seen.'
          : ' aula.messages.mark_read (marking a thread read) is available only when the ' +
            'server runs with AULA_MCP_WRITE=1.'),
    },
    contacts: {
      summary:
        "Who is in your children's groups. groups(child_ids) → group_refs; list(group_ref) → " +
        'the children with their guardians (`relation`: Mor/Far…), or the guardians, or the ' +
        'staff; parents() → kontaktforældre. Read-only. Identify a person by name AND ' +
        'relation — names repeat. Each person has a session-stable `person_ref`.',
      tools: ['aula.contacts.groups', 'aula.contacts.list', 'aula.contacts.parents'],
    },
    sensitive: {
      summary:
        'Sensitive message threads. Reading is gated: prepare_read opens nothing and returns ' +
        'the subject; read_thread opens the thread only after the user explicitly agreed.' +
        (writeEnabled
          ? ' Replies are prepared from the listing and sent without opening the thread.'
          : ''),
      tools: [
        'aula.sensitive.prepare_read',
        'aula.sensitive.read_thread',
        ...(writeEnabled ? ['aula.sensitive.prepare_reply', 'aula.sensitive.send_reply'] : []),
      ],
    },
    notifications: {
      summary: 'Unread items + activity badge counts for the active guardian.',
      tools: ['aula.notifications.list'],
    },
    posts: {
      summary:
        'Class-level news / posts feed (teacher updates), across school and club. ' +
        'Attachments can be downloaded, and PDFs read as text.',
      tools: ['aula.posts.list', 'aula.posts.get_attachment', 'aula.utils.extract_pdf_text'],
      notes:
        'Omit profileIds on aula.posts.list — the default covers every institution ' +
        'the family belongs to, and is the only way club posts appear.',
    },
    ugeplan: {
      summary:
        ugeplanDetected.length > 0
          ? `Weekly plans. Detected provider${ugeplanDetected.length > 1 ? 's' : ''}: ${ugeplanDetected
              .map((d) => d.provider)
              .join(', ')}.`
          : 'Weekly plans. No provider widget detected — try in order and surface the first that returns data.',
      tools: ugeplanTools,
      notes: ugeplanProviderNotes(ugeplanDetected.map((d) => d.provider)),
    },
    opgaver: {
      summary: 'Homework / task list from Min Uddannelse.',
      tools: ['aula.opgaver.minuddannelse'],
      ...(opgaverDetected.length === 0
        ? {
            notes:
              'Min Uddannelse opgaver widget (0030) not in detectedWidgets. That list comes from the page configuration Aula returns and has been observed to omit widgets that work, so treat it as a hint, not an inventory — the call is cheap, so make it anyway when the user asked for opgaver.',
          }
        : {}),
    },
    ugebrev: {
      summary: 'Weekly newsletter from Min Uddannelse.',
      tools: ['aula.ugebrev.minuddannelse'],
      ...(ugebrevDetected.length === 0
        ? {
            notes:
              'Min Uddannelse ugebrev widget (0029) not in detectedWidgets. That list comes from the page configuration Aula returns and has been observed to omit widgets that work, so treat it as a hint, not an inventory — the call is cheap, so make it anyway when the user asked for ugebrev.',
          }
        : {}),
    },
    huskelisten: {
      summary: 'Homework reminders from Systematic.',
      tools: ['aula.huskelisten.systematic'],
      ...(huskelistenDetected.length === 0
        ? {
            notes:
              'Systematic widget (0062) not in detectedWidgets. That list comes from the page configuration Aula returns and has been observed to omit widgets that work, so treat it as a hint, not an inventory — the call is cheap, so make it anyway when the user asked for huskelisten.',
          }
        : {}),
    },
    lektier: {
      summary: 'Homework items from EasyIQ Lektier (widget 0142).',
      tools: ['aula.lektier.easyiq'],
      ...(lektierDetected.length === 0
        ? {
            notes:
              'EasyIQ Lektier widget (0142) not in detectedWidgets. That list comes from the page configuration Aula returns and has been observed to omit widgets that work, so treat it as a hint, not an inventory — the call is cheap, so make it anyway when the user asked for lektier.',
          }
        : {}),
    },
    fravaer: {
      summary:
        'Absence reporting ("Fravær - forældreindberetning", widget 0047) via Tabulex — ' +
        "separate from Aula's own presence/komme-gå system. Call aula.fravaer.tabulex_boern " +
        "first to get each child's `child_ref`, then pass that to the other " +
        'aula.fravaer.tabulex_* tools. Refs are valid for the current MCP session only.',
      tools: writeEnabled
        ? [
            'aula.fravaer.tabulex_boern',
            'aula.fravaer.tabulex_idag',
            'aula.fravaer.tabulex_imorgen',
            'aula.fravaer.tabulex_skoledage',
            'aula.fravaer.tabulex_oversigt',
            'aula.fravaer.tabulex_meld_syg',
          ]
        : [
            'aula.fravaer.tabulex_boern',
            'aula.fravaer.tabulex_idag',
            'aula.fravaer.tabulex_imorgen',
            'aula.fravaer.tabulex_skoledage',
            'aula.fravaer.tabulex_oversigt',
          ],
      notes:
        (fravaerDetected.length === 0
          ? 'Widget 0047 is not in detectedWidgets — a hint, not an inventory. Try it anyway if the user asked about ' +
            'specifically ask about Tabulex fravær. '
          : '') +
        (writeEnabled
          ? 'aula.fravaer.tabulex_meld_syg cannot be undone — Tabulex has no equivalent of ' +
            'un-reporting sick. Confirm the exact child and day with the user before calling.'
          : 'aula.fravaer.tabulex_meld_syg (reporting a child sick via Tabulex) is available ' +
            'only when the server runs with AULA_MCP_WRITE=1.'),
    },
  };
}

/** Vendor-specific gotchas for ugeplan. Surface real prerequisites so the
 *  agent can tell the user up-front instead of after a failed call. */
function ugeplanProviderNotes(providers: string[]): string {
  if (providers.includes('meebook')) {
    return (
      'Meebook requires a one-time browser SSO from app.aula.dk → click any ' +
      'Meebook widget once — before programmatic access works. If the call ' +
      'returns "first time you use this function with unilogin … log in to ' +
      'Meebook first", relay that instruction verbatim and stop.'
    );
  }
  if (providers.includes('easyiq')) {
    return 'EasyIQ Ugeplan (widget 0001) — uses Aula widget tokens; no extra setup.';
  }
  return '';
}

function dedupe(arr: readonly string[]): string[] {
  return Array.from(new Set(arr));
}
