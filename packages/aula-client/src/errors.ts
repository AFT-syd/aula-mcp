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
