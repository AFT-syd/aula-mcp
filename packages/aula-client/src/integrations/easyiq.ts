/**
 * EasyIQ — Danish learning-platform vendor providing weekly plans (ugeplaner)
 * for many municipalities. Auth: Aula widget 0001 → bearer token via the
 * widget token manager.
 *
 * POST https://api.easyiqcloud.dk/api/aula/weekplaninfo
 *   Headers: Authorization Bearer, accept: application/json,
 *            x-aula-institutionfilter (CSV institution codes),
 *            x-aula-userprofile: guardian, origin / referer aula.dk
 *   Body:    { sessionId, currentWeekNr, userProfile, institutionFilter, childFilter }
 *   Returns: { Events: [{ start, end, itemType, title, ownername, description, ... }] }
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import type { IntegrationContext, NormalisedWeekPlan, NormalisedWeekPlanItem } from './types.ts';

const EASYIQ_WEEKPLAN_URL = 'https://api.easyiqcloud.dk/api/aula/weekplaninfo';
const EASYIQ_WIDGET_ID = '0001';

interface EasyIqEvent {
  start?: string;
  end?: string;
  itemType?: number;
  title?: string;
  ownername?: string;
  description?: string;
}

interface EasyIqResponse {
  Events?: EasyIqEvent[];
}

export interface EasyIqOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  /** Override the widget ID (Aula occasionally renames; making this
   *  configurable means a config tweak rather than a code patch). */
  widgetId?: string;
}

export class EasyIqClient {
  static readonly id = 'easyiq' as const;
  static readonly capabilities = ['ugeplan'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: EasyIqOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? EASYIQ_WIDGET_ID;
  }

  async getWeekPlan(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const result = await this.widgets.withRetry(this.widgetId, async (token) => {
      const res = await this.http.request(EASYIQ_WEEKPLAN_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'content-type': 'application/json',
          origin: 'https://www.aula.dk',
          referer: 'https://www.aula.dk/',
          'x-aula-institutionfilter': ctx.institutionCodes.join(','),
          'x-aula-userprofile': 'guardian',
        },
        body: JSON.stringify({
          sessionId: ctx.guardianId,
          currentWeekNr: ctx.isoWeek,
          userProfile: 'guardian',
          institutionFilter: ctx.institutionCodes,
          childFilter: ctx.childIds,
        }),
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `EasyIQ weekplaninfo failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as EasyIqResponse;
    });

    const items: NormalisedWeekPlanItem[] = [];
    for (const ev of result.Events ?? []) {
      const item: NormalisedWeekPlanItem = {};
      if (ev.start) item.date = ev.start;
      if (ev.title) item.title = ev.title;
      if (ev.description) item.content = ev.description;
      if (ev.ownername) item.subject = ev.ownername;
      item.kind = ev.itemType === 5 ? 'note' : 'event';
      items.push(item);
    }
    return { items, raw: result };
  }
}
