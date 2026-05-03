/**
 * The `aula.discover` tool — the central thing this MCP server exists for.
 *
 * One call returns a typed manifest of the user's children, institutions,
 * available capabilities, and which subordinate tools the agent can call. The
 * agent uses this to dynamically pick what to query next without us having to
 * hard-code a fixed tool tree.
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
  /** True when the running server can call /api/v22/?method=raw_request escape hatch. */
  rawRequestEnabled: boolean;
}

export async function buildDiscoverManifest(context: AulaContext): Promise<DiscoverManifest> {
  const client = await context.getClient();
  const record = context.record;
  if (!record) throw new Error('AulaContext: record missing after getClient()');

  // Fetch profiles + context. getProfilesByLogin gives us the children list;
  // getProfileContext gives us the active identity's user id. Both are needed
  // for the agent to compose meaningful follow-up queries.
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

  void contextData; // currently unused but kept for future capability inference

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
    capabilities: {
      profiles: {
        summary: 'Read profile and child information for the logged-in guardian.',
        tools: ['aula.profiles.list'],
      },
      presence: {
        summary: 'Daily presence for one or more children: arrived/sick/picked up etc.',
        tools: ['aula.presence.today'],
      },
      calendar: {
        summary: 'School-schedule lessons (skoleskema) for a date range.',
        tools: ['aula.calendar.events'],
      },
      messages: {
        summary: 'Aula messaging threads. Sensitive threads require MitID step-up.',
        tools: ['aula.messages.list_threads', 'aula.messages.get_thread'],
      },
      ugeplan: {
        summary:
          'Weekly plans from third-party vendors. Different schools use different ' +
          'providers — try EasyIQ first (most common), fall back to Meebook.',
        tools: ['aula.ugeplan.easyiq', 'aula.ugeplan.meebook'],
        notes:
          'Per-school provider detection is not wired yet — the agent should try in the ' +
          'order listed and surface whichever returns non-empty.',
      },
      opgaver: {
        summary: 'Homework / task list from Min Uddannelse.',
        tools: ['aula.opgaver.minuddannelse'],
      },
      ugebrev: {
        summary: 'Weekly newsletter from Min Uddannelse.',
        tools: ['aula.ugebrev.minuddannelse'],
      },
      huskelisten: {
        summary: 'Homework reminders from Systematic.',
        tools: ['aula.huskelisten.systematic'],
      },
    },
    rawRequestEnabled: process.env['AULA_MCP_RAW'] === '1',
  };
  return manifest;
}
