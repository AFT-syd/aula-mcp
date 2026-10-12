/**
 * Contacts — reading who is in a child's groups, without
 * spreading more of other families' data than the question needs.
 *
 * Shapes are as READ in Aula's frontend bundle and checked against live
 * responses (2026-10-11). Hence allowlists everywhere: a field Aula adds, or
 * one the bundle reading got wrong, is withheld rather than passed on.
 *
 * Rules:
 *  - No `raw`, nothing cached to disk; refs live for one MCP session.
 *  - A contact list needs a `group_ref` from the groups tool — no bulk
 *    harvest by raw group id.
 *  - Address, phone numbers and email only where Aula's own page shows them:
 *    the consent flag, plus `currentUserCanViewContactInformation` on a list
 *    row; never a child's (or a role-less row's) address; never a group
 *    home's home phone in a relation row. `hasCustody` passes when Aula sends
 *    it, which it does only to roles that may see it.
 *  - Never for an alias profile: the name is not
 *    the person's own, so neither is anything we would print next to it.
 *  - People are identified by a `person_ref` bound to their profile id, so the
 *    same person reached through two different groups gets the same ref —
 *    and that ref is what a new message thread is addressed to.
 *    A name alone never identifies anyone: two parents can share a first name.
 */

import { randomBase64Url } from '@aula-mcp/aula-auth';
import type { ContactEntry, ContactGroupBlock } from '@aula-mcp/aula-client';

/** Aula's contact pages hold up to this many; a full page means there may be more. */
export const CONTACT_PAGE_SIZE = 20;

export interface GroupRefs {
  /** Undefined when the group carries no id — such a group cannot be listed. */
  refFor(group: { id?: number; name?: string }): string | undefined;
  resolve(ref: string): { id: number; name: string | undefined };
}

export function createGroupRefs(): GroupRefs {
  const byRef = new Map<string, { id: number; name: string | undefined }>();
  const refById = new Map<number, string>();
  return {
    refFor(group) {
      if (typeof group.id !== 'number') return undefined;
      const known = refById.get(group.id);
      if (known !== undefined) return known;
      const ref = `grp_${randomBase64Url(6)}`;
      byRef.set(ref, { id: group.id, name: group.name });
      refById.set(group.id, ref);
      return ref;
    },
    resolve(ref) {
      const group = byRef.get(ref);
      if (group === undefined) {
        throw new Error(
          `Unknown group_ref "${ref}". Call aula.contacts.groups first — group refs are ` +
            'issued per MCP session.',
        );
      }
      return group;
    },
  };
}

/** Where a person has been seen in this session — what a send preview shows. */
export interface PersonSeen {
  name: string | null;
  role: string | undefined;
  /** "Mor", "Far", … when seen as a child's guardian. */
  relation?: string;
  /** The child they were listed under. */
  of?: string;
  group?: string;
  alias?: boolean;
}

export interface PersonDescription {
  name: string | null;
  role: string | undefined;
  /** Seen as an alias profile anywhere in this session. */
  alias: boolean;
  /** E.g. `Mor til Barn Hansen (0A)` — one line per place seen. */
  seenAs: string[];
}

export interface PersonRefs {
  /** Undefined when the entry carries no usable id. */
  refFor(entry: ContactEntry): string | undefined;
  /** The profile ids behind a ref — for sending, never returned by a tool. */
  resolve(ref: string): { institutionProfileId: number | undefined; id: number | undefined };
  note(ref: string, seen: PersonSeen): void;
  describe(ref: string): PersonDescription;
}

function seenLine(s: PersonSeen): string {
  const what = s.relation && s.of ? `${s.relation} til ${s.of}` : (s.role ?? 'ukendt rolle');
  return s.group ? `${what} (${s.group})` : what;
}

/**
 * Keyed on `institutionProfileId` when present, else `id`. Which of the two
 * Aula's message recipients take is not yet measured, so both are kept
 * behind the ref; the key only has to be the same for the same person.
 */
export function createPersonRefs(): PersonRefs {
  const byRef = new Map<
    string,
    { institutionProfileId: number | undefined; id: number | undefined }
  >();
  const refByKey = new Map<string, string>();
  const seen = new Map<
    string,
    { name: string | null; role: string | undefined; alias: boolean; lines: string[] }
  >();
  return {
    note(ref, s) {
      const known = seen.get(ref) ?? { name: s.name, role: s.role, alias: false, lines: [] };
      known.name = s.name ?? known.name;
      known.role = s.role ?? known.role;
      known.alias = known.alias || s.alias === true;
      const line = seenLine(s);
      if (!known.lines.includes(line)) known.lines.push(line);
      seen.set(ref, known);
    },
    describe(ref) {
      if (!byRef.has(ref)) throw new Error(`Unknown person_ref "${ref}".`);
      const s = seen.get(ref);
      return {
        name: s?.name ?? null,
        role: s?.role,
        alias: s?.alias ?? false,
        seenAs: [...(s?.lines ?? [])],
      };
    },
    refFor(entry) {
      const key =
        typeof entry.institutionProfileId === 'number'
          ? `ip:${entry.institutionProfileId}`
          : typeof entry.id === 'number'
            ? `id:${entry.id}`
            : undefined;
      if (key === undefined) return undefined;
      const known = refByKey.get(key);
      if (known !== undefined) return known;
      const ref = `per_${randomBase64Url(6)}`;
      byRef.set(ref, { institutionProfileId: entry.institutionProfileId, id: entry.id });
      refByKey.set(key, ref);
      return ref;
    },
    resolve(ref) {
      const ids = byRef.get(ref);
      if (ids === undefined) throw new Error(`Unknown person_ref "${ref}".`);
      return ids;
    },
  };
}

/** The groups as a flat list with refs. Blocks without groups are dropped. */
export function projectGroups(blocks: readonly ContactGroupBlock[], refs: GroupRefs) {
  const out: Array<{
    group_ref: string;
    name: string | null;
    default?: true;
    heading?: string;
  }> = [];
  for (const block of blocks) {
    // The label Aula's group menu shows above the block's groups.
    const heading = block.displayName;
    for (const group of block.groups ?? []) {
      const ref = refs.refFor(group);
      if (ref === undefined) continue;
      out.push({
        group_ref: ref,
        name: group.name ?? null,
        ...(group.showAsDefault ? { default: true as const } : {}),
        ...(nonEmpty(heading) ? { heading } : {}),
      });
    }
  }
  return out;
}

function displayName(e: ContactEntry): string | null {
  if (e.fullName) return e.fullName;
  if (e.name) return e.name;
  const joined = [e.firstName, e.lastName].filter(Boolean).join(' ');
  return joined.length > 0 ? joined : null;
}

/**
 * An alias profile: Aula's own `alias` flag, or — because the contact list
 * was measured (2026-10-11) to send such a person without that flag — the
 * placeholder name it shows instead ("Alias-fornavn Alias-efternavn").
 */
export function isAlias(e: ContactEntry): boolean {
  if (e.alias === true) return true;
  return (
    e.firstName === 'Alias-fornavn' ||
    e.lastName === 'Alias-efternavn' ||
    [e.fullName, e.name].some((n) => typeof n === 'string' && n.startsWith('Alias-fornavn'))
  );
}

function nonEmpty(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function formatAddress(a: ContactEntry['address']): string | undefined {
  if (!a) return undefined;
  const line = [a.street, [a.postalCode, a.postalDistrict].filter(Boolean).join(' ')]
    .filter((p) => nonEmpty(typeof p === 'string' ? p : undefined))
    .join(', ');
  return line.length > 0 ? line : undefined;
}

/**
 * One person, allowlisted. `relations` are projected one level deep — a
 * child's guardians, a guardian's children — and not further.
 *
 * Contact details follow the two templates of Aula's contacts page: a list
 * row (depth 0) needs `currentUserCanViewContactInformation` as well as
 * consent; a relation row needs consent only and hides a group home's home
 * phone. Neither shows a child's address.
 */
export function projectContact(
  e: ContactEntry,
  refs: PersonRefs,
  depth = 0,
  /** The group being listed, and — for a relation — the person it hangs under. */
  ctx: { group?: string | null; of?: ContactEntry } = {},
): Record<string, unknown> {
  const ref = refs.refFor(e);
  const alias = isAlias(e);
  if (ref !== undefined) {
    const of = ctx.of && ctx.of.role === 'child' ? displayName(ctx.of) : null;
    refs.note(ref, {
      name: displayName(e),
      role: nonEmpty(e.role) ? e.role : undefined,
      ...(depth > 0 && nonEmpty(e.relation) ? { relation: e.relation } : {}),
      ...(depth > 0 && of ? { of } : {}),
      ...(nonEmpty(ctx.group) ? { group: ctx.group } : {}),
      ...(alias ? { alias: true } : {}),
    });
  }
  const shown =
    !alias &&
    e.userHasGivenConsentToShowContactInformation === true &&
    (depth > 0 || e.currentUserCanViewContactInformation === true);
  const homeShown = shown && !(depth > 0 && e.contactType === 'groupHome');
  const phones = {
    ...(shown && nonEmpty(e.mobilePhoneNumber) ? { mobile: e.mobilePhoneNumber } : {}),
    ...(homeShown && nonEmpty(e.homePhoneNumber) ? { home: e.homePhoneNumber } : {}),
    ...(shown && nonEmpty(e.workPhoneNumber) ? { work: e.workPhoneNumber } : {}),
  };
  // Only for a known role that is not a child — a row without a role is not
  // assumed to be an adult's.
  const address =
    shown && nonEmpty(e.role) && e.role !== 'child' ? formatAddress(e.address) : undefined;
  const relations =
    depth === 0
      ? (e.relations ?? []).map((r) => projectContact(r, refs, depth + 1, { ...ctx, of: e }))
      : [];
  return {
    ...(ref !== undefined ? { person_ref: ref } : {}),
    name: displayName(e),
    ...(alias ? { alias: true } : {}),
    ...(nonEmpty(e.role) ? { role: e.role } : {}),
    ...(nonEmpty(e.relation) ? { relation: e.relation } : {}),
    ...(typeof e.hasCustody === 'boolean' ? { hasCustody: e.hasCustody } : {}),
    ...(Object.keys(phones).length > 0 ? { phones } : {}),
    ...(shown && nonEmpty(e.email) ? { email: e.email } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(relations.length > 0 ? { relations } : {}),
  };
}

// --- finding a recipient by name AND role -----------------------------------

/** Who to look for. A name alone is never enough: two parents can share a first name. */
export interface RecipientQuery {
  name: string;
  role: 'guardian' | 'employee' | 'child';
  /** "Mor", "Far", … — guardians only. */
  relation?: string;
  /** Part of the child's name — guardians only. */
  ofChild?: string;
}

export interface RecipientCandidate {
  person_ref: string;
  name: string | null;
  role: string;
  relation?: string;
  /** The children they were found under, for a guardian. */
  of?: string[];
}

/** Every whitespace-separated part of `query` occurs in `name`, ignoring case. */
export function nameMatches(name: string | null, query: string): boolean {
  if (!name) return false;
  const hay = name.toLocaleLowerCase('da');
  const parts = query.toLocaleLowerCase('da').split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => hay.includes(p));
}

/**
 * The contact-list filter a query is answered from. Guardians are read off
 * the children's list, because only there do they carry their `relation`.
 */
export function filterForRole(role: RecipientQuery['role']): 'child' | 'employee' {
  return role === 'employee' ? 'employee' : 'child';
}

/**
 * The people on one contact-list page who match the query on name AND role
 * (and relation / child when given), merged into `found` by person_ref.
 * Alias profiles never match: their name is not the person's own.
 */
export function collectCandidates(
  entries: readonly ContactEntry[],
  q: RecipientQuery,
  refs: PersonRefs,
  found: Map<string, RecipientCandidate>,
): void {
  const add = (e: ContactEntry, of?: string) => {
    if (isAlias(e)) return;
    const ref = refs.refFor(e);
    if (ref === undefined) return;
    const known = found.get(ref);
    if (known) {
      if (of && !known.of?.includes(of)) known.of = [...(known.of ?? []), of];
      return;
    }
    found.set(ref, {
      person_ref: ref,
      name: displayName(e),
      role: q.role,
      ...(nonEmpty(e.relation) && q.role === 'guardian' ? { relation: e.relation } : {}),
      ...(of ? { of: [of] } : {}),
    });
  };
  for (const e of entries) {
    if (q.role === 'guardian') {
      const child = displayName(e);
      if (q.ofChild !== undefined && !nameMatches(child, q.ofChild)) continue;
      for (const r of e.relations ?? []) {
        if (r.role !== 'guardian' || !nameMatches(displayName(r), q.name)) continue;
        if (
          q.relation !== undefined &&
          r.relation?.toLocaleLowerCase('da') !== q.relation.toLocaleLowerCase('da')
        ) {
          continue;
        }
        add(r, child ?? undefined);
      }
    } else if (e.role === q.role && nameMatches(displayName(e), q.name)) {
      add(e);
    }
  }
}
