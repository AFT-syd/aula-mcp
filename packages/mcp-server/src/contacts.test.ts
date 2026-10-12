/**
 * Tests for the contacts tools.
 *
 * What these pin down:
 *  - Only an allowlist of a contact's fields leaves the server, and contact
 *    details only where Aula itself shows them (the consent flag).
 *  - The same person reached through two groups gets the same person_ref —
 *    a parent of two children is one person, not two.
 *  - Groups are reachable only from the guardian's own children, and a
 *    contact list only from a group_ref.
 *
 * Every name, id and number below is a fixture invented for this file.
 */

import { describe, expect, test } from 'bun:test';
import type { AulaClient, ContactEntry } from '@aula-mcp/aula-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AulaContext } from './aula-context.ts';
import {
  createGroupRefs,
  createPersonRefs,
  isAlias,
  projectContact,
  projectGroups,
} from './contacts.ts';
import { deliver } from './delivery.ts';
import { registerTools } from './tools.ts';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
}>;

function textOf(result: {
  content: Array<{ type: string; text: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (!first) throw new Error('expected content[0]');
  return JSON.parse(first.text) as Record<string, unknown>;
}

const MOTHER: ContactEntry = {
  id: 501,
  institutionProfileId: 70017001,
  fullName: 'Mor Fixture',
  role: 'guardian',
  relation: 'Mor',
  hasCustody: true,
  userHasGivenConsentToShowContactInformation: true,
  mobilePhoneNumber: '11223344',
  email: 'mor@example.invalid',
  address: { street: 'Testvej 1', postalCode: 7100, postalDistrict: 'Vejle' },
};

const OTHER_PARENT: ContactEntry = {
  id: 502,
  institutionProfileId: 7002,
  fullName: 'Anden Forælder',
  role: 'guardian',
  relation: 'Far',
  userHasGivenConsentToShowContactInformation: false,
  mobilePhoneNumber: '99887766',
  email: 'skjult@example.invalid',
  address: { street: 'Skjultvej 2' },
};

const CHILD: ContactEntry = {
  id: 601,
  institutionProfileId: 80018001,
  fullName: 'Barn Fixture',
  role: 'child',
  relations: [MOTHER],
  // Fields that must never travel, whatever Aula sends.
  ...({ profilePicture: { url: 'https://media.example/x?Signature=SECRET' } } as object),
  ...({ birthday: '2019-01-01' } as object),
};

describe('projectContact — an allowlist', () => {
  test('keeps name, role, relation and consented contact details', () => {
    const out = projectContact(CHILD, createPersonRefs());
    expect(out).toMatchObject({ name: 'Barn Fixture', role: 'child' });
    expect(out.relations).toEqual([
      expect.objectContaining({
        name: 'Mor Fixture',
        relation: 'Mor',
        hasCustody: true,
        phones: { mobile: '11223344' },
        email: 'mor@example.invalid',
        address: 'Testvej 1, 7100 Vejle',
      }),
    ]);
  });

  test('drops fields outside the allowlist — signed URLs, birthdays, raw ids', () => {
    const json = JSON.stringify(projectContact(CHILD, createPersonRefs()));
    expect(json).not.toContain('Signature');
    expect(json).not.toContain('2019-01-01');
    expect(json).not.toContain('80018001');
    expect(json).not.toContain('70017001');
  });

  test("without consent, no phone, email or address — as on Aula's own page", () => {
    const out = projectContact(OTHER_PARENT, createPersonRefs());
    const json = JSON.stringify(out);
    expect(json).not.toContain('99887766');
    expect(json).not.toContain('skjult@');
    expect(json).not.toContain('Skjultvej');
    expect(out).toMatchObject({ name: 'Anden Forælder', relation: 'Far' });
  });

  test('consent is required on its own — the view flag or a relation row does not stand in for it', () => {
    // A list row the viewer may see, but whose owner has not consented.
    const listRow = JSON.stringify(
      projectContact(
        { ...OTHER_PARENT, currentUserCanViewContactInformation: true },
        createPersonRefs(),
      ),
    );
    expect(listRow).not.toContain('99887766');
    expect(listRow).not.toContain('skjult@');
    // A relation row (which needs consent only) without consent.
    const relation = JSON.stringify(
      projectContact({ ...CHILD, relations: [OTHER_PARENT] }, createPersonRefs()),
    );
    expect(relation).not.toContain('99887766');
    expect(relation).not.toContain('skjult@');
    expect(relation).not.toContain('Skjultvej');
  });

  test('an alias profile keeps its ref and name but loses every contact detail', () => {
    const alias: ContactEntry = { ...MOTHER, fullName: 'Alias Fixture', alias: true };
    const out = projectContact({ ...CHILD, relations: [alias] }, createPersonRefs()) as {
      relations: Array<Record<string, unknown>>;
    };
    expect(out.relations[0]).toMatchObject({ name: 'Alias Fixture', alias: true, relation: 'Mor' });
    expect(out.relations[0]?.person_ref).toMatch(/^per_/);
    const json = JSON.stringify(out);
    expect(json).not.toContain('11223344');
    expect(json).not.toContain('mor@');
    expect(json).not.toContain('Testvej');
  });

  test("Aula's placeholder name marks an alias even without the flag (measured live)", () => {
    const placeholder: ContactEntry = {
      ...MOTHER,
      fullName: 'Alias-fornavn Alias-efternavn',
      firstName: 'Alias-fornavn',
      lastName: 'Alias-efternavn',
    };
    const out = projectContact({ ...CHILD, relations: [placeholder] }, createPersonRefs()) as {
      relations: Array<Record<string, unknown>>;
    };
    expect(out.relations[0]).toMatchObject({ alias: true, relation: 'Mor' });
    expect(JSON.stringify(out)).not.toContain('11223344');
    expect(isAlias({ ...MOTHER, fullName: 'Alias-fornavn X' })).toBe(true);
    expect(isAlias(MOTHER)).toBe(false);
  });

  test("a list row needs currentUserCanViewContactInformation, and never shows a child's address", () => {
    const row: ContactEntry = {
      ...CHILD,
      userHasGivenConsentToShowContactInformation: true,
      mobilePhoneNumber: '55667788',
      address: { street: 'Barnevej 3' },
    };
    const hidden = JSON.stringify(projectContact(row, createPersonRefs()));
    expect(hidden).not.toContain('55667788');
    const visible = projectContact(
      { ...row, currentUserCanViewContactInformation: true },
      createPersonRefs(),
    );
    expect(visible).toMatchObject({ phones: { mobile: '55667788' } });
    expect(JSON.stringify(visible)).not.toContain('Barnevej');
  });

  test('a row without a role is not assumed to be an adult — no address', () => {
    const { role: _role, ...roleless } = MOTHER;
    const out = projectContact({ ...CHILD, relations: [roleless] }, createPersonRefs()) as {
      relations: Array<Record<string, unknown>>;
    };
    expect(out.relations[0]?.address).toBeUndefined();
    expect(out.relations[0]?.phones).toEqual({ mobile: '11223344' });
  });

  test("a relation row hides a group home's home phone, not its mobile", () => {
    const home: ContactEntry = { ...MOTHER, contactType: 'groupHome', homePhoneNumber: '44332211' };
    const out = projectContact({ ...CHILD, relations: [home] }, createPersonRefs()) as {
      relations: Array<Record<string, unknown>>;
    };
    expect(out.relations[0]?.phones).toEqual({ mobile: '11223344' });
  });

  test('relations go one level deep, not further', () => {
    const deep: ContactEntry = { ...CHILD, relations: [{ ...MOTHER, relations: [CHILD] }] };
    const out = projectContact(deep, createPersonRefs()) as {
      relations: Array<Record<string, unknown>>;
    };
    expect(out.relations[0]?.relations).toBeUndefined();
  });
});

describe('person_ref — the same person, the same ref', () => {
  test('the mother reached through two groups gets one ref', () => {
    // Child A→group A→mother and child B→group B→mother must meet.
    const refs = createPersonRefs();
    const viaGroupA = refs.refFor({ ...MOTHER });
    const viaGroupB = refs.refFor({ ...MOTHER, id: 999 }); // another row, same profile
    expect(viaGroupA).toMatch(/^per_/);
    expect(viaGroupB).toBe(viaGroupA);
    expect(refs.resolve(viaGroupA as string)).toEqual({ institutionProfileId: 70017001, id: 501 });
  });

  test('two people with the same first name stay two refs', () => {
    const refs = createPersonRefs();
    const a = refs.refFor({ ...MOTHER, fullName: 'Mette A' });
    const b = refs.refFor({ ...OTHER_PARENT, fullName: 'Mette B' });
    expect(a).not.toBe(b);
  });

  test('an entry without ids gets no ref', () => {
    expect(createPersonRefs().refFor({ fullName: 'Ingen Id' })).toBeUndefined();
  });
});

describe('projectGroups', () => {
  test('flattens blocks, keeps name/default/heading, skips id-less groups', () => {
    const out = projectGroups(
      [
        {
          displayName: 'Testskolen',
          profileId: 4242,
          groups: [{ id: 11, name: '0A', showAsDefault: true }, { name: 'uden id' }],
        },
      ],
      createGroupRefs(),
    );
    expect(out).toEqual([
      {
        group_ref: expect.stringMatching(/^grp_/),
        name: '0A',
        default: true,
        heading: 'Testskolen',
      },
    ]);
  });
});

describe('deliver — the inline target', () => {
  test('returns the payload as JSON tool content', async () => {
    const out = await deliver(
      { a: 1 },
      { kind: 'contacts', subjectCount: 1, containsOtherFamilies: false },
    );
    expect(textOf(out)).toEqual({ a: 1 });
  });

  test('an unknown target is an error, not a silent fallback', () => {
    expect(() =>
      deliver({}, { kind: 'contacts', subjectCount: 0, containsOtherFamilies: false }, 'file'),
    ).toThrow(/Unknown delivery target/);
  });
});

// --- the tools ------------------------------------------------------------

function setup(listPage: ContactEntry[] = [CHILD]) {
  const calls = {
    groups: [] as number[][],
    lists: [] as Array<Record<string, unknown>>,
    parents: [] as number[],
  };
  const client = {
    async getGroupsByContext(ids: number[]) {
      calls.groups.push(ids);
      return [{ displayName: 'Testskolen', groups: [{ id: 11, name: '0A' }] }];
    },
    async getContactList(args: Record<string, unknown>) {
      calls.lists.push(args);
      return listPage;
    },
    async getContactParents(page: number) {
      calls.parents.push(page);
      return [MOTHER];
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
      return { profiles: [{ children: [{ id: 101, name: 'Eget Barn' }] }] };
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
  return { get, calls };
}

describe('aula.contacts.* tools', () => {
  test('groups refuses a child that is not your own, before calling Aula', async () => {
    const s = setup();
    const out = textOf(await s.get('aula.contacts.groups')({ child_ids: [101, 555] }));
    expect(out).toMatchObject({ error: 'unknown_child', unknownIds: [555] });
    expect(s.calls.groups).toEqual([]);
  });

  test('groups → list: the group_ref resolves to the group id, page 1, filter child', async () => {
    const s = setup();
    const groups = textOf(await s.get('aula.contacts.groups')({ child_ids: [101] })) as {
      groups: Array<{ group_ref: string }>;
    };
    const ref = groups.groups[0]?.group_ref;
    const out = textOf(await s.get('aula.contacts.list')({ group_ref: ref }));
    expect(s.calls.lists).toEqual([{ groupId: 11, filter: 'child', page: 1 }]);
    expect(out).toMatchObject({ group: '0A', filter: 'child', page: 1, morePages: false });
  });

  test('a full page of 20 says there may be more', async () => {
    const page = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, fullName: `P${i}` }));
    const s = setup(page);
    const groups = textOf(await s.get('aula.contacts.groups')({ child_ids: [101] })) as {
      groups: Array<{ group_ref: string }>;
    };
    const out = textOf(
      await s.get('aula.contacts.list')({ group_ref: groups.groups[0]?.group_ref }),
    );
    expect(out.morePages).toBe(true);
  });

  test('a raw or invented group_ref lists nothing', async () => {
    const s = setup();
    await expect(s.get('aula.contacts.list')({ group_ref: '11' })).rejects.toThrow(
      /aula.contacts.groups first/,
    );
    expect(s.calls.lists).toEqual([]);
  });

  test('parents and list share person_refs', async () => {
    const s = setup();
    const groups = textOf(await s.get('aula.contacts.groups')({ child_ids: [101] })) as {
      groups: Array<{ group_ref: string }>;
    };
    const list = textOf(
      await s.get('aula.contacts.list')({ group_ref: groups.groups[0]?.group_ref }),
    ) as { people: Array<{ relations: Array<{ person_ref: string }> }> };
    const parents = textOf(await s.get('aula.contacts.parents')({})) as {
      people: Array<{ person_ref: string }>;
    };
    expect(parents.people[0]?.person_ref).toBe(list.people[0]?.relations[0]?.person_ref);
    expect(s.calls.parents).toEqual([1]);
  });
});
