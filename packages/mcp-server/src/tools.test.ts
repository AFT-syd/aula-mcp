import { describe, expect, test } from 'bun:test';
import type { TabulexChildAccess } from '@aula-mcp/aula-client';
import { createTabulexChildRefs, stripTabulexRaw, validateSetTemplateArgs } from './tools.ts';

describe('validateSetTemplateArgs', () => {
  test('picked_up_by needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by' })[0]).toContain('pickedUpBy');
    expect(validateSetTemplateArgs({ activityType: 'picked_up_by', pickedUpBy: 'Far' })).toEqual(
      [],
    );
  });

  test('go_home_with needs pickedUpBy', () => {
    expect(validateSetTemplateArgs({ activityType: 'go_home_with' })[0]).toContain('pickedUpBy');
  });

  test('self_decider needs both window times', () => {
    expect(
      validateSetTemplateArgs({ activityType: 'self_decider', selfDeciderStartTime: '14:00' })[0],
    ).toContain('self_decider');
    expect(
      validateSetTemplateArgs({
        activityType: 'self_decider',
        selfDeciderStartTime: '14:00',
        selfDeciderEndTime: '16:00',
      }),
    ).toEqual([]);
  });

  test('send_home with no extra fields is fine', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });

  test('a repeating template needs repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'weekly' })[0]).toContain(
      'repeatUntil',
    );
    expect(
      validateSetTemplateArgs({
        activityType: 'send_home',
        repeat: 'weekly',
        repeatUntil: '2026-06-30',
      }),
    ).toEqual([]);
  });

  test('a one-off (repeat never / unset) does not need repeatUntil', () => {
    expect(validateSetTemplateArgs({ activityType: 'send_home', repeat: 'never' })).toEqual([]);
    expect(validateSetTemplateArgs({ activityType: 'send_home' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/** A child entry shaped like Tabulex's, with an obviously fake CPR. */
function tabulexChild(overrides: Partial<TabulexChildAccess> = {}): TabulexChildAccess {
  return {
    fornavn: 'Barn',
    efternavn: 'Testesen',
    cpr: '0101209999',
    foedselsdato: '2020-01-01',
    klasse: '3A',
    skoleNavn: 'Testskolen',
    skoleKode: 'T1',
    skoleFravaerAdgang: true,
    skoleBestyrelsesValgAdgang: false,
    pige: false,
    // Tabulex's untouched response — the second place the CPR appears.
    raw: { Cpr: '0101209999', Fornavn: 'Barn', Noget: 'ukendt felt' },
    ...overrides,
  };
}

describe('Tabulex child refs — keeping CPR off the tool surface', () => {
  test('a child entry carries a ref and no CPR, in any field', () => {
    const refs = createTabulexChildRefs();
    const entry = refs.publicEntry(tabulexChild());

    expect(JSON.stringify(entry)).not.toContain('0101209999');
    expect(entry.child_ref).toMatch(/^tbx_/);
    expect(entry.cpr).toBeUndefined();
    expect(entry.raw).toBeUndefined();
  });

  test('the ref round-trips back to the CPR Tabulex needs', () => {
    const refs = createTabulexChildRefs();
    const entry = refs.publicEntry(tabulexChild());
    expect(refs.cprFor(entry.child_ref as string)).toBe('0101209999');
  });

  test('the same child keeps the same ref, different children do not share one', () => {
    const refs = createTabulexChildRefs();
    const first = refs.publicEntry(tabulexChild());
    const again = refs.publicEntry(tabulexChild());
    const sibling = refs.publicEntry(tabulexChild({ cpr: '0202215555', fornavn: 'Soskende' }));

    expect(again.child_ref).toBe(first.child_ref);
    expect(sibling.child_ref).not.toBe(first.child_ref);
    expect(refs.cprFor(sibling.child_ref as string)).toBe('0202215555');
  });

  test('refs from one server run mean nothing to another', () => {
    const first = createTabulexChildRefs();
    const entry = first.publicEntry(tabulexChild());
    const afterRestart = createTabulexChildRefs();

    expect(() => afterRestart.cprFor(entry.child_ref as string)).toThrow(/tabulex_boern/);
  });

  test('an unknown ref is refused rather than passed through as a CPR', () => {
    const refs = createTabulexChildRefs();
    expect(() => refs.cprFor('tbx_madeup')).toThrow(/Unknown child_ref/);
    // Nor may a caller smuggle a real CPR in through the ref parameter.
    expect(() => refs.cprFor('0101209999')).toThrow(/Unknown child_ref/);
  });

  test('fields with no role in absence reporting are withheld', () => {
    const entry = createTabulexChildRefs().publicEntry(tabulexChild());
    // A birth date is the first six digits of the CPR.
    expect(entry.foedselsdato).toBeUndefined();
    expect(entry.pige).toBeUndefined();
    expect(entry.skoleBestyrelsesValgAdgang).toBeUndefined();
    // What the model actually needs survives.
    expect(entry.fornavn).toBe('Barn');
    expect(entry.klasse).toBe('3A');
    expect(entry.skoleFravaerAdgang).toBe(true);
  });

  test('a child without a CPR gets no ref instead of a broken one', () => {
    // Omitted rather than set to undefined: `cpr?: string` under
    // exactOptionalPropertyTypes is "absent", not "present and undefined".
    const { cpr: _cpr, ...noCpr } = tabulexChild();
    const entry = createTabulexChildRefs().publicEntry(noCpr);
    expect(entry.child_ref).toBeUndefined();
    expect(entry.fornavn).toBe('Barn');
  });

  test('stripTabulexRaw drops the unfiltered passthrough but keeps the mapped fields', () => {
    const day = {
      dag: false,
      dato: '2026-09-10T00:00:00+02:00',
      note: null,
      aarsag: null,
      raw: { Dag: false, Cpr: '0101209999' },
    };
    const stripped = stripTabulexRaw(day);

    expect(JSON.stringify(stripped)).not.toContain('0101209999');
    expect('raw' in stripped).toBe(false);
    expect(stripped.dag).toBe(false);
    expect(stripped.dato).toBe('2026-09-10T00:00:00+02:00');
  });
});
