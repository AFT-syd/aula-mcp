/**
 * Tests for starting a new message thread.
 *
 * What these pin down:
 *  - A person is found by name AND role; two people with the same first name
 *    are two candidates, never a silent pick.
 *  - No draft exists unless Aula's own recipient search returns the person
 *    under the id the contact list gave — and nothing is sent without a draft.
 *  - The send carries exactly the drafted payload: never sensitive, no BCC,
 *    the person's institutionProfileId, the guardian's own as creator.
 *  - Success is a read-back of the new thread with the text and every
 *    recipient in it, not Aula's answer.
 *
 * Every name, id and text below is a fixture invented for this file.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  AulaClient,
  ContactEntry,
  MessageThread,
  ThreadMessagesData,
} from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import { collectCandidates, createPersonRefs, type RecipientCandidate } from './contacts.ts';
import { textToHtml } from './replies.ts';
import {
  checkStartedThread,
  confirmRecipient,
  findStartedThread,
  pickCreator,
  type ThreadTarget,
  upstreamThreadId,
} from './threads.ts';
import { registerTools } from './tools.ts';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function textOf(result: { content: Array<{ type: string; text: string }> }) {
  const first = result.content[0];
  if (!first) throw new Error('expected content[0]');
  return JSON.parse(first.text) as Record<string, unknown>;
}

// Two parents share a first name; one mother has a child in each of two groups.
const METTE_A: ContactEntry = {
  id: 1,
  institutionProfileId: 9001,
  fullName: 'Mette Fixture Aa',
  role: 'guardian',
  relation: 'Mor',
};
const METTE_B: ContactEntry = {
  id: 2,
  institutionProfileId: 9002,
  fullName: 'Mette Fixture Bb',
  role: 'guardian',
  relation: 'Mor',
};
const FATHER: ContactEntry = {
  id: 3,
  institutionProfileId: 9003,
  fullName: 'Far Fixture Aa',
  role: 'guardian',
  relation: 'Far',
};
const CHILD_A: ContactEntry = {
  id: 11,
  institutionProfileId: 8001,
  fullName: 'Barn Aa',
  role: 'child',
  relations: [METTE_A, FATHER],
};
const CHILD_B: ContactEntry = {
  id: 12,
  institutionProfileId: 8002,
  fullName: 'Barn Bb',
  role: 'child',
  relations: [METTE_B],
};
const CHILD_A2: ContactEntry = {
  id: 13,
  institutionProfileId: 8003,
  fullName: 'Barn Aa Lillebror',
  role: 'child',
  relations: [{ ...METTE_A, id: 99 }],
};

function find(entries: ContactEntry[], q: Parameters<typeof collectCandidates>[1]) {
  const found = new Map<string, RecipientCandidate>();
  collectCandidates(entries, q, createPersonRefs(), found);
  return [...found.values()];
}

describe('collectCandidates — name AND role', () => {
  test('a first name alone that two parents share gives two candidates', () => {
    const out = find([CHILD_A, CHILD_B], { name: 'Mette', role: 'guardian' });
    expect(out.map((c) => c.name).sort()).toEqual(['Mette Fixture Aa', 'Mette Fixture Bb']);
  });

  test("relation and the child's name narrow it to one", () => {
    const out = find([CHILD_A, CHILD_B], {
      name: 'Mette',
      role: 'guardian',
      relation: 'mor',
      ofChild: 'Barn Aa',
    });
    expect(out).toEqual([
      expect.objectContaining({ name: 'Mette Fixture Aa', relation: 'Mor', of: ['Barn Aa'] }),
    ]);
  });

  test('the same mother under two children is one candidate, not two', () => {
    const out = find([CHILD_A, CHILD_A2], { name: 'Mette', role: 'guardian' });
    expect(out).toHaveLength(1);
    expect(out[0]?.of).toEqual(['Barn Aa', 'Barn Aa Lillebror']);
  });

  test('the wrong relation matches nobody', () => {
    expect(find([CHILD_A], { name: 'Mette', role: 'guardian', relation: 'Far' })).toEqual([]);
  });

  test('an alias profile never matches', () => {
    const alias = { ...CHILD_A, relations: [{ ...METTE_A, alias: true }] };
    expect(find([alias], { name: 'Mette', role: 'guardian' })).toEqual([]);
  });

  test('a child is not found when asking for a guardian of that name', () => {
    expect(find([CHILD_A], { name: 'Barn', role: 'guardian' })).toEqual([]);
    expect(find([CHILD_A], { name: 'Barn Aa', role: 'child' })).toHaveLength(1);
  });
});

const TARGET: ThreadTarget = {
  person_ref: 'per_x',
  institutionProfileId: 9001,
  name: 'Mette Fixture Aa',
  role: 'guardian',
  seenAs: ['Mor til Barn Aa (0X)'],
};

describe('confirmRecipient — the second source', () => {
  test("confirmed when Aula's search returns the same id", () => {
    expect(
      confirmRecipient(TARGET, [{ id: 9001, docType: 'Profile', name: 'Mette Fixture Aa' }]),
    ).toEqual({ ok: true });
  });

  test('the same name under another id is not the chosen person', () => {
    expect(
      confirmRecipient(TARGET, [{ id: 7777, docType: 'Profile', name: 'Mette Fixture Aa' }]),
    ).toMatchObject({ ok: false, error: 'not_confirmed_by_search' });
  });

  test('a group with that number is not a person', () => {
    expect(confirmRecipient(TARGET, [{ id: 9001, docType: 'Group' }])).toMatchObject({
      ok: false,
    });
  });

  test('a blocked profile is refused', () => {
    expect(
      confirmRecipient(TARGET, [
        { id: '9001', docType: 'Profile', name: 'Mette Fixture Aa', communicationBlock: true },
      ]),
    ).toMatchObject({ ok: false, error: 'communication_blocked' });
  });

  test('the id with another name is refused — the sources do not mean the same number', () => {
    expect(
      confirmRecipient(TARGET, [{ id: 9001, docType: 'Profile', name: 'Helt Anden Person' }]),
    ).toMatchObject({ ok: false, mismatch: 'name' });
  });

  test('a stated role that differs is refused; spacing and case in the name are not', () => {
    expect(
      confirmRecipient(TARGET, [
        { id: 9001, docType: 'Profile', name: 'Mette Fixture Aa', portalRole: 'employee' },
      ]),
    ).toMatchObject({ ok: false, mismatch: 'role' });
    expect(
      confirmRecipient(TARGET, [
        { id: 9001, docType: 'Profile', name: ' mette  fixture AA', portalRole: 'guardian' },
      ]),
    ).toEqual({ ok: true });
  });
});

describe('pickCreator', () => {
  test('one own institution profile is the sender', () => {
    expect(
      pickCreator([{ profileId: 1, displayName: 'x', institutionProfiles: [{ id: 5005 }] }]),
    ).toEqual({ ok: true, id: 5005 });
  });

  test('several are refused, not picked', () => {
    expect(
      pickCreator([
        { profileId: 1, displayName: 'x', institutionProfiles: [{ id: 5005 }, { id: 5006 }] },
      ]),
    ).toMatchObject({ ok: false, error: 'ambiguous_sender' });
  });
});

describe('finding the new thread again', () => {
  const sentAt = Date.parse('2026-10-11T18:00:00Z');
  const thread = (id: number, subject: string, startedTime: string) =>
    ({ id, subject, startedTime, read: true }) as MessageThread;

  test('same subject, started after sending', () => {
    const t = findStartedThread(
      [thread(1, 'Hej', '2026-10-01T10:00:00Z'), thread(2, 'Hej', '2026-10-11T18:00:05Z')],
      'Hej',
      sentAt,
      undefined,
      new Set(),
    );
    expect(t?.id).toBe(2);
  });

  test("two candidates are not told apart by guessing — unless Aula's id names one", () => {
    const both = [
      thread(2, 'Hej', '2026-10-11T18:00:05Z'),
      thread(3, 'Hej', '2026-10-11T18:00:06Z'),
    ];
    expect(findStartedThread(both, 'Hej', sentAt, undefined, new Set())).toBeNull();
    expect(findStartedThread(both, 'Hej', sentAt, 3, new Set())?.id).toBe(3);
  });

  test('a thread that existed before sending never confirms the send', () => {
    // A failed send right after an identical one inside the skew window.
    const earlier = thread(2, 'Hej', '2026-10-11T17:59:40Z');
    expect(findStartedThread([earlier], 'Hej', sentAt, undefined, new Set([2]))).toBeNull();
  });

  test('a sensitive thread is never taken for the new one (it would be opened)', () => {
    const sensitive = { ...thread(4, 'Hej', '2026-10-11T18:00:05Z'), sensitive: true };
    expect(findStartedThread([sensitive], 'Hej', sentAt, 4, new Set())).toBeNull();
  });

  test("Aula's id is read from data.data only", () => {
    expect(upstreamThreadId({ data: 42 })).toBe(42);
    expect(upstreamThreadId(42)).toBeUndefined();
    expect(upstreamThreadId(undefined)).toBeUndefined();
  });

  test('verified needs the text AND every recipient in the opened thread', () => {
    const html = textToHtml('Hej med dig');
    const data: ThreadMessagesData = {
      messages: [{ id: 'm1', sendDateTime: '2026-10-11T18:00:05Z', text: { html } }],
      recipients: [{ mailBoxOwner: { id: 9001 } }],
    } as ThreadMessagesData;
    expect(checkStartedThread(data, { html, recipientIds: [9001] }, sentAt)).toEqual({
      textFound: true,
      recipientsConfirmed: true,
      missingRecipients: 0,
    });
    expect(checkStartedThread(data, { html, recipientIds: [9001, 9002] }, sentAt)).toMatchObject({
      recipientsConfirmed: false,
      missingRecipients: 1,
    });
  });
});

// --- the tools ------------------------------------------------------------

interface Calls {
  lists: Array<Record<string, unknown>>;
  searches: Array<Record<string, unknown>>;
  started: Array<Record<string, unknown>>;
}

function setup(
  opts: { searchIds?: number[]; ownProfiles?: number[]; entries?: ContactEntry[] } = {},
) {
  const calls: Calls = { lists: [], searches: [], started: [] };
  let startedAt = '';
  let startedHtml = '';
  const client = {
    async getGroupsByContext() {
      return [{ displayName: 'Testskolen', groups: [{ id: 21, name: '0X' }] }];
    },
    async getContactList(args: Record<string, unknown>) {
      calls.lists.push(args);
      return opts.entries ?? [CHILD_A, CHILD_B];
    },
    async findRecipients(args: Record<string, unknown>) {
      calls.searches.push(args);
      // Aula's search answers by name, so the hit carries the searched name.
      return (opts.searchIds ?? [9001]).map((id) => ({
        id,
        docType: 'Profile',
        name: args.text as string,
      }));
    },
    async startNewThread(args: Record<string, unknown>) {
      calls.started.push(args);
      startedAt = new Date().toISOString();
      startedHtml = args.html as string;
      return { data: 777 };
    },
    async getThreads() {
      // Empty before the send, the new thread after it.
      return startedAt === ''
        ? []
        : [{ id: 777, subject: 'Legeaftale', startedTime: startedAt, read: true }];
    },
    async getThreadData() {
      return {
        id: 777,
        messages: [{ id: 'm1', sendDateTime: startedAt, text: { html: startedHtml } }],
        recipients: [{ fullName: 'Mette Fixture Aa', mailBoxOwner: { id: 9001 } }],
      };
    },
  } as unknown as AulaClient;
  const context = {
    async getClient() {
      return client;
    },
    async getGuardianUserId() {
      return 'g-1';
    },
    async getProfilesByLogin() {
      return {
        profiles: [
          {
            profileId: 1,
            displayName: 'Mig',
            children: [{ id: 101, name: 'Eget Barn' }],
            institutionProfiles: (opts.ownProfiles ?? [5005]).map((id) => ({ id })),
          },
        ],
      };
    },
  } as unknown as AulaContext;
  const tools = new Map<string, ToolHandler>();
  registerTools(
    {
      registerTool: (n: string, _c: unknown, h: ToolHandler) => tools.set(n, h),
    } as unknown as McpServer,
    context,
  );
  const get = (name: string): ToolHandler => {
    const h = tools.get(name);
    if (!h) throw new Error(`${name} was not registered`);
    return h;
  };
  return { get, calls, tools };
}

async function groupRef(s: ReturnType<typeof setup>): Promise<string> {
  const out = textOf(await s.get('aula.contacts.groups')({ child_ids: [101] })) as {
    groups: Array<{ group_ref: string }>;
  };
  return out.groups[0]?.group_ref as string;
}

describe('aula.messages.find_recipients', () => {
  test('"Mette" alone gives candidates and asks; name + relation + child gives a match', async () => {
    const s = setup();
    const group_ref = await groupRef(s);
    const loose = textOf(
      await s.get('aula.messages.find_recipients')({ group_ref, name: 'Mette', role: 'guardian' }),
    );
    expect(loose.match).toBeUndefined();
    expect(loose.candidates).toHaveLength(2);
    expect(loose.next).toMatch(/ask/i);

    const exact = textOf(
      await s.get('aula.messages.find_recipients')({
        group_ref,
        name: 'Mette',
        role: 'guardian',
        relation: 'Mor',
        of_child: 'Barn Aa',
      }),
    );
    expect(exact.match).toMatchObject({ name: 'Mette Fixture Aa', relation: 'Mor' });
    expect(s.calls.lists[0]).toEqual({ groupId: 21, filter: 'child', page: 1 });
  });

  test('registered without the write gate, unlike prepare/send', () => {
    const original = process.env.AULA_MCP_WRITE;
    delete process.env.AULA_MCP_WRITE;
    try {
      const s = setup();
      expect(s.tools.has('aula.messages.find_recipients')).toBe(true);
      expect(s.tools.has('aula.messages.prepare_thread')).toBe(false);
      expect(s.tools.has('aula.messages.send_thread')).toBe(false);
    } finally {
      if (original !== undefined) process.env.AULA_MCP_WRITE = original;
    }
  });
});

describe('aula.messages.prepare_thread / send_thread', () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.AULA_MCP_WRITE;
    process.env.AULA_MCP_WRITE = '1';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AULA_MCP_WRITE;
    else process.env.AULA_MCP_WRITE = original;
  });

  async function matchedRef(s: ReturnType<typeof setup>): Promise<string> {
    const group_ref = await groupRef(s);
    const out = textOf(
      await s.get('aula.messages.find_recipients')({
        group_ref,
        name: 'Mette',
        role: 'guardian',
        relation: 'Mor',
        of_child: 'Barn Aa',
      }),
    ) as { match: { person_ref: string } };
    return out.match.person_ref;
  }

  test('prepare sends nothing, checks the search, and previews where the person was found', async () => {
    const s = setup();
    const ref = await matchedRef(s);
    const out = textOf(
      await s.get('aula.messages.prepare_thread')({
        person_refs: [ref],
        subject: 'Legeaftale',
        text: 'Hej Mette',
      }),
    );
    expect(out.draft_ref).toMatch(/^nth_/);
    expect(out.preview).toMatchObject({
      subject: 'Legeaftale',
      sensitive: false,
      recipients: [{ name: 'Mette Fixture Aa', seenAs: ['Mor til Barn Aa (0X)'] }],
    });
    expect(s.calls.searches).toEqual([
      { text: 'Mette Fixture Aa', ownInstitutionProfileId: 5005, portalRoles: ['guardian'] },
    ]);
    expect(s.calls.started).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('9001');
  });

  test('no draft when the search returns the person under another id', async () => {
    const s = setup({ searchIds: [4444] });
    const ref = await matchedRef(s);
    const out = textOf(
      await s.get('aula.messages.prepare_thread')({
        person_refs: [ref],
        subject: 'Legeaftale',
        text: 'Hej',
      }),
    );
    expect(out).toMatchObject({ error: 'not_confirmed_by_search' });
    expect(out.draft_ref).toBeUndefined();
  });

  test('a guardian listed with only `id` is drafted only when the search returns that id', async () => {
    // Measured live 2026-10-11: relation rows carry `id`, no institutionProfileId.
    const { institutionProfileId: _drop, ...metteIdOnly } = { ...METTE_A, id: 9001 };
    const entries = [{ ...CHILD_A, relations: [metteIdOnly, FATHER] }];

    const confirmed = setup({ entries, searchIds: [9001] });
    const okRef = await matchedRef(confirmed);
    const ok = textOf(
      await confirmed.get('aula.messages.prepare_thread')({
        person_refs: [okRef],
        subject: 'S',
        text: 'T',
      }),
    );
    expect(ok.draft_ref).toMatch(/^nth_/);

    const other = setup({ entries, searchIds: [4444] });
    const badRef = await matchedRef(other);
    const refused = textOf(
      await other.get('aula.messages.prepare_thread')({
        person_refs: [badRef],
        subject: 'S',
        text: 'T',
      }),
    );
    expect(refused).toMatchObject({ error: 'not_confirmed_by_search' });
  });

  async function listedRefs(
    s: ReturnType<typeof setup>,
  ): Promise<Array<{ person_ref: string; relations?: Array<{ person_ref: string }> }>> {
    const out = textOf(await s.get('aula.contacts.list')({ group_ref: await groupRef(s) })) as {
      people: Array<{ person_ref: string; relations?: Array<{ person_ref: string }> }>;
    };
    return out.people;
  }

  test('an alias profile and a child are refused as recipients', async () => {
    const alias: ContactEntry = {
      ...METTE_A,
      fullName: 'Alias-fornavn Alias-efternavn',
      firstName: 'Alias-fornavn',
    };
    const s = setup({ entries: [{ ...CHILD_A, relations: [alias] }] });
    const [child] = await listedRefs(s);
    const aliasRef = child?.relations?.[0]?.person_ref as string;
    const prepare = s.get('aula.messages.prepare_thread');
    expect(
      textOf(await prepare({ person_refs: [aliasRef], subject: 'S', text: 'T' })),
    ).toMatchObject({ error: 'alias_profile' });
    expect(
      textOf(await prepare({ person_refs: [child?.person_ref], subject: 'S', text: 'T' })),
    ).toMatchObject({ error: 'unsupported_recipient_role' });
    expect(s.calls.searches).toEqual([]);
  });

  test('one person under two refs is one recipient', async () => {
    // Listed once with institutionProfileId, once (under a sibling) with only `id`.
    const { institutionProfileId: _drop, ...idOnly } = { ...METTE_A, id: 9001 };
    const s = setup({ entries: [CHILD_A, { ...CHILD_A2, relations: [idOnly] }] });
    const people = await listedRefs(s);
    const refs = people.map((p) => p.relations?.[0]?.person_ref as string);
    expect(refs[0]).not.toBe(refs[1]);
    const out = textOf(
      await s.get('aula.messages.prepare_thread')({ person_refs: refs, subject: 'S', text: 'T' }),
    ) as { preview: { recipients: unknown[] } };
    expect(out.preview.recipients).toHaveLength(1);
  });

  test('no draft with several own institution profiles', async () => {
    const s = setup({ ownProfiles: [5005, 5006] });
    const ref = await matchedRef(s);
    const out = textOf(
      await s.get('aula.messages.prepare_thread')({ person_refs: [ref], subject: 'S', text: 'T' }),
    );
    expect(out).toMatchObject({ error: 'ambiguous_sender' });
    expect(s.calls.searches).toEqual([]);
  });

  test('an invented person_ref drafts nothing', async () => {
    const s = setup();
    await expect(
      s.get('aula.messages.prepare_thread')({
        person_refs: ['per_made_up'],
        subject: 'S',
        text: 'T',
      }),
    ).rejects.toThrow(/Unknown person_ref/);
  });

  test('send posts exactly the draft and verifies by reading the thread back; once only', async () => {
    const s = setup();
    const ref = await matchedRef(s);
    const prepared = textOf(
      await s.get('aula.messages.prepare_thread')({
        person_refs: [ref],
        subject: 'Legeaftale',
        text: 'Hej Mette',
      }),
    ) as { draft_ref: string };
    const sent = textOf(
      await s.get('aula.messages.send_thread')({ draft_ref: prepared.draft_ref }),
    );
    expect(s.calls.started).toEqual([
      {
        subject: 'Legeaftale',
        html: '<p>Hej Mette</p>',
        recipients: [{ id: 9001, mailBoxOwnerType: 'institutionProfile' }],
        creator: { id: 5005, mailBoxOwnerType: 'institutionProfile' },
      },
    ]);
    expect(sent).toMatchObject({
      verified: true,
      stateRead: true,
      observed: { textFound: true, recipientsConfirmed: true },
    });
    expect(sent.thread_ref).toMatch(/^thr_/);
    await expect(
      s.get('aula.messages.send_thread')({ draft_ref: prepared.draft_ref }),
    ).rejects.toThrow(/already been used/);
    expect(s.calls.started).toHaveLength(1);
  });
});
