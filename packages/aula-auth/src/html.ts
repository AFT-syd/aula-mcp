/**
 * HTML parsing helpers built on cheerio. Used to walk the SAML / MitID /
 * broker forms that the auth flow dumps into HTML responses.
 *
 * Functions are tolerant: they return null/empty rather than throwing, so
 * callers can decide what counts as a failure (per upstream issue #310 we
 * sometimes get pages without RelayState, and that's not always fatal).
 */

import * as cheerio from 'cheerio';

export type HtmlInput = string | cheerio.CheerioAPI;

function load(input: HtmlInput): cheerio.CheerioAPI {
  return typeof input === 'string' ? cheerio.load(input) : input;
}

/** All `<input type="hidden">` (or any unspecified type) values inside a form. */
export function extractHiddenInputs(
  input: HtmlInput,
  formSelector: string = 'form',
): Record<string, string> {
  const $ = load(input);
  const out: Record<string, string> = {};
  $(formSelector)
    .find('input')
    .each((_, el) => {
      const $el = $(el);
      const name = $el.attr('name');
      const type = ($el.attr('type') ?? 'hidden').toLowerCase();
      if (!name) return;
      if (type !== 'hidden' && type !== 'text') return;
      out[name] = $el.attr('value') ?? '';
    });
  return out;
}

/** Form `action` attribute, or null if no matching form. */
export function extractFormAction(input: HtmlInput, formSelector: string = 'form'): string | null {
  const $ = load(input);
  const action = $(formSelector).attr('action');
  return action ?? null;
}

/** First matching attribute value, or null. */
export function extractAttr(input: HtmlInput, selector: string, attr: string): string | null {
  const $ = load(input);
  return $(selector).first().attr(attr) ?? null;
}

/** All matching attribute values (e.g. every `data-loginoptions` JSON blob). */
export function extractAllAttr(input: HtmlInput, selector: string, attr: string): string[] {
  const $ = load(input);
  const values: string[] = [];
  $(selector).each((_, el) => {
    const v = $(el).attr(attr);
    if (v != null) values.push(v);
  });
  return values;
}

/** First matching element's text content (trimmed), or null. */
export function extractText(input: HtmlInput, selector: string): string | null {
  const $ = load(input);
  const el = $(selector).first();
  if (el.length === 0) return null;
  return el.text().trim();
}

/**
 * Extract a `<meta http-equiv="refresh" content="0;url=...">` URL.
 * Returns the URL the page intends to redirect to via meta-refresh, or null
 * if no such tag exists or the content has no `url=` part.
 *
 * The Python OAuth chain walker uses this as a fallback when a 200 response
 * carries a redirect via meta-refresh instead of an HTTP Location header.
 */
export function extractMetaRefreshUrl(input: HtmlInput): string | null {
  const $ = load(input);
  const content = $('meta[http-equiv="refresh"], meta[http-equiv="Refresh"]')
    .first()
    .attr('content');
  if (!content) return null;
  const match = /url\s*=\s*['"]?([^'"]+)['"]?/i.exec(content);
  return match?.[1] ?? null;
}
