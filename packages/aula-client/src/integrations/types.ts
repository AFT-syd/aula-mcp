/**
 * Common types used by every integration plugin (EasyIQ, Meebook, Min
 * Uddannelse, Systematic).
 *
 * Each plugin maps a third-party API into a normalised shape so the MCP
 * agent doesn't have to know which provider the school is on. The raw
 * response is also surfaced (under `raw`) for advanced use.
 */

export interface IntegrationContext {
  /** ISO week, e.g. "2026-W18". */
  isoWeek: string;
  /** MitID username — used by some integrations as a session id. */
  sessionId: string;
  /** Aula user/profile id for the active guardian (numeric, stringified). */
  guardianId: string;
  /** Children to query (numeric Aula child / user IDs). */
  childIds: number[];
  /** Institution codes (e.g. "G12345"). */
  institutionCodes: string[];
  /** Date range for plugins that take from/to instead of week (ISO YYYY-MM-DD). */
  fromDate?: string;
  /** ISO YYYY-MM-DD upper bound (inclusive). */
  toDate?: string;
}

export interface IntegrationPluginInfo {
  id: 'easyiq' | 'meebook' | 'minuddannelse' | 'systematic';
  /** Aula widget IDs this plugin uses (configurable to survive Aula renames). */
  widgetIds: string[];
  /** Capability tags this plugin claims to provide. */
  capabilities: ReadonlyArray<'ugeplan' | 'opgaver' | 'huskelisten' | 'ugebrev'>;
}

/** A normalised "weekly plan" entry — what every ugeplan provider produces. */
export interface NormalisedWeekPlanItem {
  childName?: string;
  /** Free-form date label, often Danish ("mandag 28. nov."). */
  date?: string;
  /** Subject / class / hold name. */
  subject?: string;
  title?: string;
  /** Plain text content; HTML entities decoded but markup kept (the agent
   *  can format as it likes). */
  content?: string;
  /** Item kind (e.g. comment, task, assignment). */
  kind?: string;
  /** When the upstream API gives us a deep link, surface it. */
  url?: string;
}

export interface NormalisedWeekPlan {
  items: NormalisedWeekPlanItem[];
  /** Raw upstream JSON for debugging / advanced use. */
  raw?: unknown;
  /** Soft errors per child (network ok, but parsing produced something off). */
  warnings?: string[];
}

/** Helper to build the ISO week string. */
export function isoWeekString(date: Date = new Date()): string {
  // Algorithm from RFC 8601 — Thursday-of-the-week trick.
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
