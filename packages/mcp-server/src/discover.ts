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

import type { AulaContext } from './aula-context.ts';

/** A single child the user can act on behalf of. */
export interface DiscoveredChild {
  id: number;
  name: string;
  /** The Aula institution profile id used by API methods like getDailyOverview. */
  userId?: number;
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
  /** True when AULA_MCP_RAW=1 — the aula.raw_request escape hatch is callable. */
  rawRequestEnabled: boolean;
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
});

export async function buildDiscoverManifest(context: AulaContext): Promise<DiscoverManifest> {
  const client = await context.getClient();
  const record = context.record;
  if (!record) throw new Error('AulaContext: record missing after getClient()');

  const [profilesData, contextData] = await Promise.all([
    client.getProfilesByLogin(),
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
  const detectedWidgets = Array.from(
    new Set(
      (contextData?.pageConfiguration?.widgetConfigurations ?? [])
        .map((w) => w.widgetId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ).sort();

  const now = Math.floor(Date.now() / 1000);
  const manifest: DiscoverManifest = {
    user: {
      name: profilesData.profiles?.[0]?.name ?? record.username,
      username: record.username,
      ...(record.identityName ? { identityName: record.identityName } : {}),
    },
    children,
    apiVersion: client.currentApiVersion,
    tokens: {
      expires_at: record.tokens.expires_at,
      seconds_remaining: record.tokens.expires_at - now,
    },
    capabilities: buildCapabilities(detectedWidgets),
    detectedWidgets,
    rawRequestEnabled: process.env.AULA_MCP_RAW === '1',
  };
  return manifest;
}

/**
 * Build the capabilities block, prefixing the per-school detected providers
 * to each tool list so the agent picks the actually-configured one first.
 */
function buildCapabilities(detectedWidgets: string[]): Record<string, DiscoveredCapability> {
  const detectedByCapability = new Map<string, { provider: string; tool: string }[]>();
  for (const id of detectedWidgets) {
    const entry = WIDGET_PROVIDER_MAP[id];
    if (!entry) continue;
    const arr = detectedByCapability.get(entry.capability) ?? [];
    arr.push({ provider: entry.provider, tool: entry.tool });
    detectedByCapability.set(entry.capability, arr);
  }

  const ugeplanDetected = detectedByCapability.get('ugeplan') ?? [];
  const ugeplanTools = orderToolsByDetected(
    ['aula.ugeplan.easyiq', 'aula.ugeplan.meebook', 'aula.ugeplan.easyiq_skoleportal'],
    ugeplanDetected.map((d) => d.tool),
  );
  const opgaverDetected = detectedByCapability.get('opgaver') ?? [];
  const ugebrevDetected = detectedByCapability.get('ugebrev') ?? [];
  const huskelistenDetected = detectedByCapability.get('huskelisten') ?? [];

  return {
    profiles: {
      summary: 'Read profile and child information for the logged-in guardian.',
      tools: ['aula.profiles.list'],
    },
    presence: {
      summary: 'Daily presence for one or more children: arrived/sick/picked up etc.',
      tools: ['aula.presence.today'],
    },
    calendar: {
      summary:
        'School-schedule lessons (skoleskema). Pass `range: "this_week"` for the simplest call.',
      tools: ['aula.calendar.events'],
    },
    messages: {
      summary: 'Aula messaging threads. Sensitive threads require MitID step-up.',
      tools: ['aula.messages.list_threads', 'aula.messages.get_thread'],
    },
    notifications: {
      summary: 'Unread items + activity badge counts for the active guardian.',
      tools: ['aula.notifications.list'],
    },
    posts: {
      summary: 'Class-level news / posts feed (teacher updates).',
      tools: ['aula.posts.list'],
    },
    ugeplan: {
      summary:
        ugeplanDetected.length > 0
          ? `Weekly plans. Detected providers: ${ugeplanDetected
              .map((d) => d.provider)
              .join(', ')}.`
          : 'Weekly plans from third-party vendors. No provider widget detected on your institution(s) — try the tools and surface whichever returns data.',
      tools: ugeplanTools,
      ...(ugeplanDetected.length === 0
        ? {
            notes:
              'detectedWidgets is empty for ugeplan; agent should try in order and report results.',
          }
        : {}),
    },
    opgaver: {
      summary: 'Homework / task list from Min Uddannelse.',
      tools: ['aula.opgaver.minuddannelse'],
      ...(opgaverDetected.length === 0
        ? {
            notes: 'Min Uddannelse opgaver widget (0030) not detected; this tool may return empty.',
          }
        : {}),
    },
    ugebrev: {
      summary: 'Weekly newsletter from Min Uddannelse.',
      tools: ['aula.ugebrev.minuddannelse'],
      ...(ugebrevDetected.length === 0
        ? {
            notes: 'Min Uddannelse ugebrev widget (0029) not detected; this tool may return empty.',
          }
        : {}),
    },
    huskelisten: {
      summary: 'Homework reminders from Systematic.',
      tools: ['aula.huskelisten.systematic'],
      ...(huskelistenDetected.length === 0
        ? { notes: 'Systematic widget (0062) not detected; this tool may return empty.' }
        : {}),
    },
  };
}

/** Detected tools first (deduped, in detected order), then any remaining in the canonical order. */
function orderToolsByDetected(canonical: readonly string[], detected: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of detected) {
    if (canonical.includes(t) && !seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  for (const t of canonical) {
    if (!seen.has(t)) {
      out.push(t);
      seen.add(t);
    }
  }
  return out;
}
