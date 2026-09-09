/**
 * Typed errors the aula-client surface throws. Subclassing AulaAuthError
 * (re-exported here under our own namespace) keeps callers' catch blocks
 * focused on the kind of failure rather than which package raised it.
 */

import { AulaAuthError } from '@aula-mcp/aula-auth';

export class AulaClientError extends AulaAuthError {
  override readonly name: string = 'AulaClientError';
}

export class AulaApiVersionError extends AulaClientError {
  override readonly name: string = 'AulaApiVersionError';
  constructor(
    message: string,
    public readonly triedVersions: number[],
  ) {
    super(message);
  }
}

/** 403 from messaging.getMessagesForThread → user must MitID step-up. */
export class AulaStepUpRequiredError extends AulaClientError {
  override readonly name: string = 'AulaStepUpRequiredError';
}

/**
 * The Tabulex (widget 0047, "Fravær") WS-Federation SSO handshake didn't end
 * with a FedAuth session cookie — the widget token was rejected, a hop in the
 * SimpleSAMLphp/ADFS chain returned something unexpected, or the school has
 * this widget disabled. Distinct from AulaApiError because the failure can
 * happen at any of several hosts (saml.borger.tabulex.dk,
 * foraeldre.tabulex.net), not a single Aula API call.
 */
export class TabulexSessionError extends AulaClientError {
  override readonly name: string = 'TabulexSessionError';
  /** Snippet of the offending response — handy for debugging a changed hop. */
  readonly htmlSnippet?: string;
  constructor(message: string, options?: { cause?: unknown; htmlSnippet?: string }) {
    super(message, options);
    if (options?.htmlSnippet !== undefined) this.htmlSnippet = options.htmlSnippet;
  }
}

/** Catch-all for non-2xx responses that aren't otherwise typed. */
export class AulaApiError extends AulaClientError {
  override readonly name: string = 'AulaApiError';
  constructor(
    message: string,
    public readonly status: number,
    public readonly url: string,
    public readonly body?: string,
  ) {
    super(message);
  }
}
