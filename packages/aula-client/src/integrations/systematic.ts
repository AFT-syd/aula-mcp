/**
 * Systematic / Huskelisten — homework reminders. Widget 0062.
 *
 * GET https://systematic-momo.dk/api/aula/reminders/v1
 *   Headers: Aula-Authorization: Bearer (note the unusual prefix).
 *   Query:   children, institutions, from, dueNoLaterThan, widgetVersion=1.10,
 *            userProfile=guardian, sessionId
 *   Returns: array of person objects with teamReminders / courseReminders /
 *            assignmentReminders entries.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import type { IntegrationContext, NormalisedWeekPlan, NormalisedWeekPlanItem } from './types.ts';

const SYSTEMATIC_URL = 'https://systematic-momo.dk/api/aula/reminders/v1';
const SYSTEMATIC_WIDGET_ID = '0062';

interface SystematicReminder {
  id?: number;
  institutionName?: string;
  institutionId?: string;
  dueDate?: string;
  teamId?: number;
  teamName?: string;
  reminderText?: string;
  createdBy?: string;
  lastEditBy?: string;
  subjectName?: string;
}

interface SystematicPerson {
  userName?: string;
  userId?: number;
  teamReminders?: SystematicReminder[];
  courseReminders?: SystematicReminder[];
  assignmentReminders?: SystematicReminder[];
}

export interface SystematicOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class SystematicClient {
  static readonly id = 'systematic' as const;
  static readonly capabilities = ['huskelisten'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: SystematicOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? SYSTEMATIC_WIDGET_ID;
  }

  async getReminders(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const result = await this.widgets.withRetry(this.widgetId, async (token) => {
      const params = new URLSearchParams({
        children: ctx.childIds.join(','),
        institutions: ctx.institutionCodes.join(','),
        from: ctx.fromDate ?? new Date().toISOString().slice(0, 10),
        dueNoLaterThan:
          ctx.toDate ?? new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        widgetVersion: '1.10',
        userProfile: 'guardian',
        sessionId: ctx.sessionId,
      });
      const res = await this.http.request(`${SYSTEMATIC_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
          'aula-authorization': `Bearer ${token}`,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'en-US,en;q=0.9,da;q=0.8',
          origin: 'https://www.aula.dk',
          referer: 'https://www.aula.dk/',
          zone: 'Europe/Copenhagen',
        },
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(`Systematic reminders failed (status ${res.status})`);
      }
      return JSON.parse(res.body) as SystematicPerson[];
    });

    const items: NormalisedWeekPlanItem[] = [];
    for (const person of result) {
      const buckets: Array<[string, SystematicReminder[] | undefined]> = [
        ['team', person.teamReminders],
        ['course', person.courseReminders],
        ['assignment', person.assignmentReminders],
      ];
      for (const [kind, reminders] of buckets) {
        for (const r of reminders ?? []) {
          const item: NormalisedWeekPlanItem = { kind: `huskelisten:${kind}` };
          if (person.userName) item.childName = person.userName;
          if (r.dueDate) item.date = r.dueDate;
          if (r.subjectName) item.subject = r.subjectName;
          if (r.teamName) item.title = r.teamName;
          if (r.reminderText) item.content = r.reminderText;
          items.push(item);
        }
      }
    }
    return { items, raw: result };
  }
}
