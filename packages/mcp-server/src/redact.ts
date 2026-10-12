/**
 * CPR redaction shared by `tools.ts` (Tabulex error messages) and
 * `discover.ts` (probe error messages). Split out of `tools.ts` so
 * `discover.ts` can reuse it without an import cycle — `tools.ts` already
 * imports `buildDiscoverManifest` from `./discover.ts`.
 */

/** Anything shaped like a Danish CPR number, with or without the dash. */
const CPR_PATTERN = /\b\d{6}-?\d{4}\b/g;

/**
 * Rebuild an error so its message is safe to hand to the model.
 *
 * A tool handler that throws has its `error.message` returned to the client as
 * the tool result, verbatim — so a failure whose message embedded a child's
 * CPR would deliver it into the conversation. This is the boundary where data
 * leaves the machine, so a future message format cannot reopen the hole.
 */
export function redactCprFromError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(CPR_PATTERN, '<redacted-cpr>'));
}
