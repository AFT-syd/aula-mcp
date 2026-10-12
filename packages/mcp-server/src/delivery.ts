/**
 * Where a tool's result goes — a seam, so a new destination is not a rewrite.
 *
 * Today there is one target, `inline`: the result is returned as tool
 * content, through the model like everything else. A file or API delivery
 * later is one new DeliveryTarget and one registry entry; the tools that call
 * `deliver()` do not change. `DeliveryMeta` travels with every payload so such
 * a target can decide on, say, other families' data without the tool layer
 * being rewritten.
 */

export interface DeliveryMeta {
  kind: 'contacts' | 'messages';
  /** How many people or threads the payload describes. */
  subjectCount: number;
  /** The payload names people outside the guardian's own family. */
  containsOtherFamilies: boolean;
}

/** A type alias, not an interface: the MCP SDK's handler result has an index
 *  signature, which only a type alias satisfies implicitly. */
export type ToolContent = { content: Array<{ type: 'text'; text: string }> };

export interface DeliveryTarget {
  readonly name: string;
  deliver(payload: unknown, meta: DeliveryMeta): Promise<ToolContent>;
}

/** Returns the payload as tool content — the only target, and the default. */
export const inlineTarget: DeliveryTarget = {
  name: 'inline',
  async deliver(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  },
};

const targets: Record<string, DeliveryTarget> = { inline: inlineTarget };

/** Deliver through the named target; `inline` unless a caller says otherwise. */
export function deliver(
  payload: unknown,
  meta: DeliveryMeta,
  target = 'inline',
): Promise<ToolContent> {
  const t = targets[target];
  if (t === undefined) throw new Error(`Unknown delivery target "${target}"`);
  return t.deliver(payload, meta);
}
