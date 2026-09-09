/**
 * Tabulex — "Fravær - forældreindberetning" (parent absence reporting),
 * Aula widget 0047. Not covered by any other integration in this package
 * (or by v1/v2 python clients) before this file.
 *
 * Unlike every other integration here (EasyIQ, Meebook, Min Uddannelse,
 * Systematic), Tabulex does not take the widget token as a per-call Bearer
 * credential. It runs a full ASP.NET WS-Federation SSO handshake, reverse
 * engineered from Aula's own DOM + network capture:
 *
 *   1. Aula's frontend builds a hidden auto-submit form (fields: sessionUUID,
 *      isMobileApp, aulaToken, assuranceLevel, userProfile, childFilter,
 *      institutionFilter, currentWeekNumber, and Aula's own Csrfp-Token) and
 *      POSTs it to a SimpleSAMLphp module at saml.borger.tabulex.dk.
 *   2. That module validates the aulaToken and starts a WS-Federation
 *      passive sign-in (`wa=wsignin1.0&wtrealm=https://foraeldre.tabulex.net/`)
 *      against an ADFS-compatible endpoint — same vendor family (IST) as the
 *      MinUddannelse SSO, different protocol.
 *   3. The chain ends with an auto-post page (`postResponse.js` — the
 *      standard ADFS/WIF "form POST binding" helper) carrying a `wresult`
 *      token back to foraeldre.tabulex.net, whose classic ASP.NET WIF
 *      middleware issues `FedAuth`/`FedAuth1` session cookies.
 *
 * `runSsoHandshake` doesn't hardcode step 3's field names: it generically
 * detects "a 200 response with a form, on a host that isn't
 * foraeldre.tabulex.net yet" and resubmits whatever hidden fields it finds —
 * the same tolerant, don't-assume-the-exact-shape technique
 * aula-saml-flow.ts already uses for Aula's own broker confirmation pages
 * (`detectConfirmationForm`). AulaHttpClient's cookie jar is multi-domain
 * (tough-cookie), so the same shared jar carries Aula's session cookies AND
 * accumulates Tabulex's FedAuth cookies without any extra plumbing.
 *
 * Once a FedAuth session exists, Tabulex behaves like an ordinary AngularJS
 * SPA backend: every call needs the FedAuth cookies (automatic, from the
 * jar) plus a CSRF double-submit (`XSRF-TOKEN` cookie mirrored into an
 * `X-XSRF-TOKEN` header — the same pattern AulaClient already uses for
 * Aula's own `Csrfp-Token`, just a different cookie name).
 *
 * CPR WARNING: the "person id" this API expects in every Fravær URL
 * (`/api/Fravaer/Idag/{cpr}` etc.) is the child's actual CPR number —
 * confirmed directly from Tabulex's own client source
 * (`vm.MeldSyg.Cpr = $rootScope.valgtBarn.Cpr`), not an opaque
 * Tabulex-internal id as first assumed. Callers must resolve it fresh via
 * `getPersonsAdgangTilBoern()` every session — never hardcode it, never
 * persist it to disk, never put it in a log line, commit, issue, or PR.
 * wire-tracer.ts redacts it automatically in both places it can appear (JSON
 * body field `Cpr`, URL path segment) so a --debug transcript stays safe to
 * share, but application code must still never format it into a message.
 *
 * TESTING STATUS (verified live 2026-09-05, two real children, one account):
 * the full SSO handshake plus all four read endpoints
 * (PersonsAdgangTilBoern/Idag/Imorgen/skoledage/Oversigt) worked on the
 * first live attempt — no fixes needed after the offline/unit-test pass.
 * `TabulexFravaerDag`'s shape is confirmed for a day with NO registered
 * absence; the shape when `dag: true` (an actual absence) has not been
 * observed, so `aarsag`/`lektioner`/etc. stay loosely typed rather than
 * guessed. `reportSick` (MeldSygIdag/MeldSygImorgen) is implemented from a
 * captured real PUT request but has deliberately NEVER been called against
 * the live API — Tabulex's own UI has no undo for this action. Do not call
 * it without an actual child to report, and only after explicit user
 * confirmation, same bar as `aula.presence.report_sick`.
 */

import type { AulaHttpClient } from '@aula-mcp/aula-auth';
import { extractFormAction, extractHiddenInputs } from '@aula-mcp/aula-auth';
import { TabulexSessionError } from '../errors.ts';
import type { WidgetTokenManager } from '../widget-token-manager.ts';
import type { IntegrationContext } from './types.ts';

const WIDGET_FRAVAER = '0047';
const AULA_BASE = 'https://www.aula.dk';
const TABULEX_SSO_START =
  'https://saml.borger.tabulex.dk/simplesaml/module.php/tabulexaulalogin/aula.php?appid=fravaerforaeldre';
const TABULEX_BASE = 'https://foraeldre.tabulex.net';
const TABULEX_HOST = 'foraeldre.tabulex.net';

/**
 * AngularJS's own `$http` GET defaults, replicated for fidelity with the
 * real frontend — `if-modified-since` pinned to an ancient date is Angular's
 * built-in cache-buster, not something we invented. Matching the real
 * client's fingerprint is one less thing that could look anomalous to a
 * school-data vendor's API.
 */
const AJAX_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'application/json, text/plain, */*',
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  'if-modified-since': 'Mon, 26 Jul 1997 05:00:00 GMT',
  'x-requested-with': 'XMLHttpRequest',
  referer: `${TABULEX_BASE}/`,
});

/** `PersonsAdgangTilBoern` entry, camelCased. `raw` keeps the untouched
 *  upstream object for anything not mapped here. */
export interface TabulexChildAccess {
  fornavn?: string;
  efternavn?: string;
  /** The child's CPR number. Never log, cache to disk, or quote verbatim in
   *  an issue/PR — see the module docstring. */
  cpr?: string;
  foedselsdato?: string;
  klasse?: string;
  skoleNavn?: string;
  skoleKode?: string;
  /** False when the institution has disabled parent absence-reporting for
   *  this specific child — same "institution can withhold this" pattern
   *  `aula.presence.report_sick` already documents for Aula itself. */
  skoleFravaerAdgang?: boolean;
  /** Unrelated Tabulex feature (school-board election access) — surfaced for
   *  completeness, not used by any tool here. */
  skoleBestyrelsesValgAdgang?: boolean;
  pige?: boolean;
  raw: unknown;
}

/**
 * `Fravaer/Idag` / `Fravaer/Imorgen` response, confirmed live 2026-09-05
 * against two real children on a day with no registered absence (`dag:
 * false`, every `*Aarsag` field null). The shape of an actual absence day
 * (`dag: true` and populated `Aarsag`/`Lektioner`/lesson-level fields) has
 * not been observed — fields most likely to change shape then are typed
 * loosely (`unknown`) rather than guessed.
 */
export interface TabulexFravaerDag {
  harHalvdagsFravaerSetting?: boolean;
  lektioner?: unknown;
  trin?: number;
  foersteLektionAarsag?: unknown;
  sidsteLektionAarsag?: unknown;
  lektion?: unknown;
  /** True when the child has a registered absence for this day. */
  dag?: boolean;
  aarsag?: unknown;
  /** ISO datetime with offset, e.g. "2026-09-05T00:00:00+02:00". */
  dato?: string;
  note?: string | null;
  raw: unknown;
}

/** `Fravaer/skoledage` entry — one upcoming school day and whether it is one. */
export interface TabulexSkoledag {
  dato?: string;
  skoleDag?: boolean;
}

/** `Fravaer/Oversigt` entry — one absence category's quarterly tally.
 *  `dage`/`procent` come back as strings from the API (e.g. "2,7" with a
 *  comma decimal), not numbers — kept as-is rather than parsed, since a
 *  wrong locale-parse would be worse than passing the string through. */
export interface TabulexOversigtEntry {
  aarsag?: string;
  dage?: string;
  procent?: string;
  erFravaer?: boolean;
}

export interface TabulexOptions {
  http: AulaHttpClient;
  widgets: WidgetTokenManager;
  widgetId?: string;
}

export class TabulexClient {
  static readonly id = 'tabulex' as const;
  static readonly capabilities = ['fravaer'] as const;

  private readonly http: AulaHttpClient;
  private readonly widgets: WidgetTokenManager;
  private readonly widgetId: string;
  private sessionEstablished = false;

  constructor(opts: TabulexOptions) {
    this.http = opts.http;
    this.widgets = opts.widgets;
    this.widgetId = opts.widgetId ?? WIDGET_FRAVAER;
  }

  /** Guardian's own list of children with Fravær access. The only place a
   *  child's CPR is obtained — resolve it here every session, never cache
   *  it across sessions or hardcode it. */
  async getPersonsAdgangTilBoern(ctx: IntegrationContext): Promise<TabulexChildAccess[]> {
    await this.ensureSession(ctx);
    const body = await this.getJson<Record<string, unknown>[]>(
      `${TABULEX_BASE}/api/PersonsAdgangTilBoern`,
    );
    return body.map((raw) => normaliseChildAccess(raw));
  }

  /** Today's absence status for one child. */
  async getFravaerIdag(ctx: IntegrationContext, cpr: string): Promise<TabulexFravaerDag> {
    await this.ensureSession(ctx);
    const raw = await this.getJson<Record<string, unknown>>(
      `${TABULEX_BASE}/api/Fravaer/Idag/${encodeURIComponent(cpr)}`,
    );
    return normaliseFravaerDag(raw);
  }

  /** Tomorrow's absence status for one child. */
  async getFravaerImorgen(ctx: IntegrationContext, cpr: string): Promise<TabulexFravaerDag> {
    await this.ensureSession(ctx);
    const raw = await this.getJson<Record<string, unknown>>(
      `${TABULEX_BASE}/api/Fravaer/Imorgen/${encodeURIComponent(cpr)}`,
    );
    return normaliseFravaerDag(raw);
  }

  /** Absence over the coming school days. */
  async getFravaerSkoledage(ctx: IntegrationContext, cpr: string): Promise<TabulexSkoledag[]> {
    await this.ensureSession(ctx);
    const raw = await this.getJson<Record<string, unknown>[]>(
      `${TABULEX_BASE}/api/Fravaer/skoledage/${encodeURIComponent(cpr)}`,
    );
    return raw.map((d) => ({
      ...(typeof d.Dato === 'string' ? { dato: d.Dato } : {}),
      ...(typeof d.SkoleDag === 'boolean' ? { skoleDag: d.SkoleDag } : {}),
    }));
  }

  /** Quarterly absence statistics + history. `kvartal` is 1-4. */
  async getFravaerOversigt(
    ctx: IntegrationContext,
    cpr: string,
    aar: number,
    kvartal: number,
  ): Promise<TabulexOversigtEntry[]> {
    await this.ensureSession(ctx);
    const params = new URLSearchParams({ aar: String(aar), kvartal: String(kvartal) });
    const raw = await this.getJson<Record<string, unknown>[]>(
      `${TABULEX_BASE}/api/Fravaer/Oversigt/${encodeURIComponent(cpr)}?${params.toString()}`,
    );
    return raw.map((e) => ({
      ...(typeof e.Aarsag === 'string' ? { aarsag: e.Aarsag } : {}),
      ...(typeof e.Dage === 'string' ? { dage: e.Dage } : {}),
      ...(typeof e.Procent === 'string' ? { procent: e.Procent } : {}),
      ...(typeof e.ErFravaer === 'boolean' ? { erFravaer: e.ErFravaer } : {}),
    }));
  }

  /**
   * WRITE. Marks the child sick for today or tomorrow. Tabulex's UI has no
   * undo for this action — the caller (the MCP tool layer) must confirm the
   * child with the user before calling, exactly like
   * `aula.presence.report_sick`. See the module docstring: this method has
   * never been exercised against the live API.
   */
  async reportSick(
    ctx: IntegrationContext,
    cpr: string,
    when: 'today' | 'tomorrow',
  ): Promise<unknown> {
    await this.ensureSession(ctx);
    const path = when === 'today' ? 'MeldSygIdag' : 'MeldSygImorgen';
    return this.putJson(`${TABULEX_BASE}/api/Fravaer/${path}/`, { Cpr: cpr });
  }

  // -- session handshake ----------------------------------------------------

  private async ensureSession(ctx: IntegrationContext): Promise<void> {
    if (this.sessionEstablished) return;
    await this.establishSession(ctx);
  }

  private async establishSession(ctx: IntegrationContext): Promise<void> {
    const token = await this.widgets.get(this.widgetId);
    await this.runSsoHandshake(ctx, token);
    if (await this.hasFedAuthCookie()) {
      this.sessionEstablished = true;
      return;
    }
    // Widget tokens are short-lived (~1 min for the other integrations in
    // this package) — one forced refresh before giving up. Not
    // WidgetTokenManager.withRetry's pattern (that retries a single call
    // against a detected "expired" response body); here the token is
    // consumed once, inside a multi-hop handshake, so we just redo the
    // whole handshake with a guaranteed-fresh token.
    const fresh = await this.widgets.refresh(this.widgetId);
    await this.runSsoHandshake(ctx, fresh);
    if (!(await this.hasFedAuthCookie())) {
      throw new TabulexSessionError(
        'Tabulex SSO handshake completed without a FedAuth session cookie',
      );
    }
    this.sessionEstablished = true;
  }

  private async hasFedAuthCookie(): Promise<boolean> {
    return (await this.http.jar.getCookieValue(TABULEX_BASE, 'FedAuth')) !== undefined;
  }

  private async runSsoHandshake(ctx: IntegrationContext, aulaToken: string): Promise<void> {
    const csrf = (await this.http.jar.getCookieValue(AULA_BASE, 'Csrfp-Token')) ?? '';
    const childFilterIds = ctx.childUserIds?.some(Boolean)
      ? ctx.childUserIds
      : ctx.childIds.map(String);

    const form = new URLSearchParams({
      sessionUUID: ctx.guardianId,
      isMobileApp: 'false',
      aulaToken,
      assuranceLevel: '3',
      userProfile: 'guardian',
      childFilter: childFilterIds.join(','),
      institutionFilter: ctx.institutionCodes.join(','),
      group: '',
      currentWeekNumber: ctx.isoWeek,
      'Csrfp-Token': csrf,
    });

    let response = (
      await this.http.followRedirects(TABULEX_SSO_START, {
        method: 'POST',
        body: form,
        maxHops: 10,
      })
    ).final;

    // The WS-Federation chain ends with an auto-post ("postResponse.js")
    // HTML page carrying `wresult` back to foraeldre.tabulex.net — a 200,
    // not a redirect, so followRedirects alone can't cross it. Detect it
    // generically (a form, on a host that isn't the destination yet) and
    // resubmit whatever hidden fields it carries — same technique
    // aula-saml-flow.ts uses for Aula's own "200 with confirmation form"
    // pages, deliberately not hardcoding wresult/wctx/etc. by name in case
    // ADFS renames or adds fields.
    for (let hop = 0; hop < 5 && !isTabulexHost(response.url); hop++) {
      const fields = extractHiddenInputs(response.body);
      if (Object.keys(fields).length === 0) {
        throw new TabulexSessionError(
          `Tabulex SSO handshake stalled at ${response.url} (status ${response.status}) with no form to continue`,
          { htmlSnippet: response.body.slice(0, 500) },
        );
      }
      const action = extractFormAction(response.body) ?? '';
      const nextUrl = new URL(action || response.url, response.url).toString();
      response = (
        await this.http.followRedirects(nextUrl, {
          method: 'POST',
          body: new URLSearchParams(fields),
          maxHops: 10,
        })
      ).final;
    }
  }

  // -- plumbing ---------------------------------------------------------

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.http.request(url, {
      method: 'GET',
      headers: { ...AJAX_HEADERS, 'x-xsrf-token': await this.xsrfToken() },
    });
    if (res.status !== 200) {
      throw new TabulexSessionError(`Tabulex GET ${url} failed (status ${res.status})`, {
        htmlSnippet: res.body.slice(0, 500),
      });
    }
    return JSON.parse(res.body) as T;
  }

  private async putJson<T>(url: string, body: unknown): Promise<T> {
    const res = await this.http.request(url, {
      method: 'PUT',
      headers: {
        ...AJAX_HEADERS,
        'x-xsrf-token': await this.xsrfToken(),
        'content-type': 'application/json;charset=UTF-8',
        origin: TABULEX_BASE,
      },
      body: JSON.stringify(body),
    });
    if (res.status !== 200) {
      throw new TabulexSessionError(`Tabulex PUT ${url} failed (status ${res.status})`, {
        htmlSnippet: res.body.slice(0, 500),
      });
    }
    return JSON.parse(res.body) as T;
  }

  /** CSRF double-submit: mirror the XSRF-TOKEN cookie into a header, the
   *  AngularJS `$http` convention Tabulex's own frontend uses. */
  private async xsrfToken(): Promise<string> {
    return (await this.http.jar.getCookieValue(TABULEX_BASE, 'XSRF-TOKEN')) ?? '';
  }
}

function isTabulexHost(url: string): boolean {
  try {
    return new URL(url).host === TABULEX_HOST;
  } catch {
    return false;
  }
}

function normaliseChildAccess(raw: Record<string, unknown>): TabulexChildAccess {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const out: TabulexChildAccess = { raw };
  const fornavn = str(raw.Fornavn);
  if (fornavn !== undefined) out.fornavn = fornavn;
  const efternavn = str(raw.Efternavn);
  if (efternavn !== undefined) out.efternavn = efternavn;
  const cpr = str(raw.Cpr);
  if (cpr !== undefined) out.cpr = cpr;
  const foedselsdato = str(raw.Foedselsdato);
  if (foedselsdato !== undefined) out.foedselsdato = foedselsdato;
  const klasse = str(raw.Klasse);
  if (klasse !== undefined) out.klasse = klasse;
  const skoleNavn = str(raw.SkoleNavn);
  if (skoleNavn !== undefined) out.skoleNavn = skoleNavn;
  const skoleKode = str(raw.SkoleKode);
  if (skoleKode !== undefined) out.skoleKode = skoleKode;
  const skoleFravaerAdgang = bool(raw.SkoleFravaerAdgang);
  if (skoleFravaerAdgang !== undefined) out.skoleFravaerAdgang = skoleFravaerAdgang;
  const skoleBestyrelsesValgAdgang = bool(raw.SkoleBestyrelsesValgAdgang);
  if (skoleBestyrelsesValgAdgang !== undefined)
    out.skoleBestyrelsesValgAdgang = skoleBestyrelsesValgAdgang;
  const pige = bool(raw.Pige);
  if (pige !== undefined) out.pige = pige;
  return out;
}

function normaliseFravaerDag(raw: Record<string, unknown>): TabulexFravaerDag {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const out: TabulexFravaerDag = { raw };
  const harHalvdagsFravaerSetting = bool(raw.HarHalvdagsFravaerSetting);
  if (harHalvdagsFravaerSetting !== undefined)
    out.harHalvdagsFravaerSetting = harHalvdagsFravaerSetting;
  if ('Lektioner' in raw) out.lektioner = raw.Lektioner;
  const trin = num(raw.Trin);
  if (trin !== undefined) out.trin = trin;
  if ('FoersteLektionAarsag' in raw) out.foersteLektionAarsag = raw.FoersteLektionAarsag;
  if ('SidsteLektionAarsag' in raw) out.sidsteLektionAarsag = raw.SidsteLektionAarsag;
  if ('Lektion' in raw) out.lektion = raw.Lektion;
  const dag = bool(raw.Dag);
  if (dag !== undefined) out.dag = dag;
  if ('Aarsag' in raw) out.aarsag = raw.Aarsag;
  const dato = str(raw.Dato);
  if (dato !== undefined) out.dato = dato;
  out.note = str(raw.Note) ?? null;
  return out;
}
