/**
 * EasyIQ SkolePortal (widget `0128`).
 *
 * NOTE: this is a *different* product from the existing EasyIQ Ugeplan
 * widget (`0001` → EasyIqClient). Same vendor, distinct SaaS backend
 * (`skoleportal.easyiqcloud.dk` vs `api.easyiqcloud.dk`), different auth
 * flow, different (PascalCase) event JSON.
 *
 * Bake-in for upstream PR scaarup/aula#352 ("Add EasyIQ SkolePortal support").
 *
 * Flow per call:
 *   1. Get a widget token for 0128 (via WidgetTokenManager).
 *   2. POST /Aula/AuthenticateAulaUser per-child with x-childfilter +
 *      x-institutionfilter + x-login headers; receive `{ loginId, ... }`.
 *   3. GET /Calendar/CalendarGetWeekplanEvents?loginId=…&date=YYYY-MM-DD;
 *      receive an array of events with PascalCase fields.
 *
 * Multi-child: the PR iterates per child because each child's loginId is
 * tied to that child's filters. We do the same.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import { isWidgetTokenExpiredResponse } from '../widget-token-manager.ts';
import {
  decodeHtmlEntities,
  type IntegrationContext,
  isoDate,
  isoWeekToMonday,
  type NormalisedWeekPlan,
  type NormalisedWeekPlanItem,
} from './types.ts';

const SP_AUTH_URL = 'https://skoleportal.easyiqcloud.dk/Aula/AuthenticateAulaUser';
const SP_WEEKPLAN_URL = 'https://skoleportal.easyiqcloud.dk/Calendar/CalendarGetWeekplanEvents';
const SP_WIDGET_ID = '0128';

interface SpAuthResponse {
  loginId?: string;
  child?: string;
  childName?: string;
  schoolName?: string;
  schoolId?: string | number;
}

interface SpEvent {
  StartTime?: string;
  StartTimeISO?: string;
  EndTime?: string;
  CoursesDisplay?: string;
  ActivitiesDisplay?: string;
  ChapterTitle?: string;
  Description?: string;
}

export interface EasyIqSkoleportalOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class EasyIqSkoleportalClient {
  static readonly id = 'easyiq_skoleportal' as const;
  static readonly capabilities = ['ugeplan'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;

  constructor(opts: EasyIqSkoleportalOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? SP_WIDGET_ID;
  }

  async getWeekPlan(ctx: IntegrationContext): Promise<NormalisedWeekPlan> {
    const monday = isoWeekToMonday(ctx.isoWeek);
    const date = isoDate(monday);
    const items: NormalisedWeekPlanItem[] = [];
    const warnings: string[] = [];
    const rawByChild: Record<string, unknown> = {};

    for (const childId of ctx.childIds) {
      try {
        const childResult = await this.fetchOneChild(ctx, childId, date);
        rawByChild[String(childId)] = childResult.raw;
        for (const item of childResult.items) items.push(item);
      } catch (e) {
        warnings.push(`child ${childId}: ${(e as Error).message}`);
      }
    }

    return { items, raw: rawByChild, ...(warnings.length ? { warnings } : {}) };
  }

  private async fetchOneChild(
    ctx: IntegrationContext,
    childId: number,
    date: string,
  ): Promise<{
    items: NormalisedWeekPlanItem[];
    raw: { auth: SpAuthResponse; events: SpEvent[] };
  }> {
    const auth = await this.authenticate(ctx, childId);
    if (!auth.loginId) {
      throw new Error('SkolePortal authentication response missing loginId');
    }
    const events = await this.fetchEvents(auth.loginId, date);
    const childName = decodeHtmlEntities(auth.childName ?? '');
    const items: NormalisedWeekPlanItem[] = [];
    for (const ev of events) {
      const item: NormalisedWeekPlanItem = { kind: 'event' };
      if (childName) item.childName = childName;
      const dateStr = ev.StartTimeISO ?? ev.StartTime;
      if (dateStr) item.date = dateStr;
      const subject = decodeHtmlEntities(ev.CoursesDisplay ?? '');
      const cls = decodeHtmlEntities(ev.ActivitiesDisplay ?? '');
      if (subject || cls) item.subject = [subject, cls].filter(Boolean).join(' / ');
      const title = decodeHtmlEntities(ev.ChapterTitle ?? '');
      if (title) item.title = title;
      const desc = decodeHtmlEntities(ev.Description ?? '');
      if (desc) item.content = desc;
      items.push(item);
    }
    return { items, raw: { auth, events } };
  }

  private async authenticate(ctx: IntegrationContext, childId: number): Promise<SpAuthResponse> {
    return this.widgets.withRetry(this.widgetId, async (token) => {
      const res = await this.http.request(SP_AUTH_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-childfilter': String(childId),
          'x-institutionfilter': ctx.institutionCodes.join(','),
          'x-login': ctx.sessionId,
          origin: 'https://www.aula.dk',
          referer: 'https://www.aula.dk/',
        },
      });
      if (isWidgetTokenExpiredResponse(res.body, res.status)) {
        return { _expired: true as const, status: res.status, bodySnippet: res.body.slice(0, 200) };
      }
      if (res.status !== 200) {
        throw new Error(
          `SkolePortal AuthenticateAulaUser failed (status ${res.status}): ${res.body.slice(0, 200)}`,
        );
      }
      return JSON.parse(res.body) as SpAuthResponse;
    });
  }

  private async fetchEvents(loginId: string, date: string): Promise<SpEvent[]> {
    const url = `${SP_WEEKPLAN_URL}?loginId=${encodeURIComponent(loginId)}&date=${encodeURIComponent(date)}`;
    const res = await this.http.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        origin: 'https://www.aula.dk',
        referer: 'https://www.aula.dk/',
      },
    });
    if (res.status !== 200) {
      throw new Error(
        `SkolePortal CalendarGetWeekplanEvents failed (status ${res.status}): ${res.body.slice(0, 200)}`,
      );
    }
    const parsed = JSON.parse(res.body) as unknown;
    return Array.isArray(parsed) ? (parsed as SpEvent[]) : [];
  }
}
