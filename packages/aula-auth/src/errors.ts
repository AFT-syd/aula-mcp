/**
 * Base error for everything the auth package throws.
 * Subclass for distinct failure modes that callers should branch on.
 */
export class AulaAuthError extends Error {
  override readonly name: string = 'AulaAuthError';
  override readonly cause: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
  }
}

export class RedirectLoopError extends AulaAuthError {
  override readonly name: string = 'RedirectLoopError';
  constructor(
    public readonly hops: number,
    public readonly lastUrl: string,
  ) {
    super(`Exceeded ${hops} redirect hops; stuck at ${lastUrl}`);
  }
}

export class HtmlParseError extends AulaAuthError {
  override readonly name: string = 'HtmlParseError';
  constructor(
    message: string,
    public readonly snippet?: string,
  ) {
    super(message);
  }
}
