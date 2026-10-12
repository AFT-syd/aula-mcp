/**
 * Shared MCP server construction. Both transports (HTTP in `server.ts`,
 * stdio in `server-stdio.ts`) wire the same tool surface, instructions,
 * and AulaContext. Keeping the construction here means only one place
 * to edit when capabilities or instructions change.
 */

import type { Logger } from '@aula-mcp/aula-auth';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AulaContext } from './aula-context.ts';
import { registerTools } from './tools.ts';
import { VERSION } from './version.ts';

// Exported (only this constant — createMcpApp/registerTools are untouched)
// so a cheap test can assert it stays consistent with discover.ts's usage
// text instead of silently drifting again, the way it did here: the model
// reads server `instructions` before it ever sees an individual tool's
// inputSchema description, so a stale line here overrides a fixed one there.
export const INSTRUCTIONS = [
  'This server exposes the Danish school platform Aula to AI agents.',
  '',
  'Workflow:',
  '1. Call `aula.discover` ONCE per session and reuse the manifest. It returns',
  '   children (with names + ids), institutions, the current API version, and',
  "   `detectedWidgets` — the widget IDs this user's schools actually have.",
  '2. Resolve any kid names mentioned in the user prompt against',
  '   `manifest.children[].name` (case-insensitive, partial — e.g. `luk`',
  "   matches `Lukas`). Use the matching child's `id` for BOTH `childIds` and",
  '   `profileIds` — `profileIds` is the same numeric id despite its name,',
  '   never `userId` (a string, used only internally by the integration tools).',
  '3. Pick ONE subordinate tool, not many. `manifest.capabilities[area].tools[0]`',
  '   is the right one for this user — only fall back to alternatives, then a',
  '   neighbouring capability (ugeplan/ugebrev, opgaver/lektier/huskelisten), if',
  '   the first errors OR returns no items. `detectedWidgets` can be incomplete —',
  '   a widget missing from it is not proof the tool will fail; call it anyway',
  '   if the expected source came back empty. If several such calls are all',
  '   turning up empty, call `aula.discover` again with `probe: true` instead of',
  '   continuing by hand — it makes those calls once, server-side.',
  "4. Default time windows: when the user says 'denne uge' / 'this week' use",
  "   `range: 'this_week'`; 'næste uge' → 'next_week'; 'i dag' → 'today'.",
  '   Request windows are Europe/Copenhagen wall-clock, but',
  '   `aula.calendar.events` RETURNS UTC timestamps — convert before showing a',
  '   time to the user (+2h in summer, +1h in winter).',
  "5. Reply in the user's language (Danish if they wrote Danish). Dates as",
  '   `mandag 12. maj`-style, not ISO, unless they ask.',
  '',
  "Never re-call `aula.discover` mid-session unless a tool returns 'children",
  "or widgets unknown' — token refresh is handled server-side, you don't need",
  'to poll for it.',
].join('\n');

export interface McpAppOptions {
  logger: Logger;
  /**
   * Share one AulaContext across MCP sessions. Each context de-duplicates its
   * own token refresh; separate contexts per session could refresh Aula's
   * tokens concurrently and, if the refresh token rotates, invalidate each
   * other.
   */
  context?: AulaContext;
}

export interface McpApp {
  mcp: McpServer;
  context: AulaContext;
}

export function createMcpApp({ logger, context: shared }: McpAppOptions): McpApp {
  const context = shared ?? new AulaContext({ logger });
  const mcp = new McpServer(
    {
      name: 'aula-mcp',
      version: VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions: INSTRUCTIONS,
    },
  );
  registerTools(mcp, context);
  return { mcp, context };
}
