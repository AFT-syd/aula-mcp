import { describe, expect, test } from 'bun:test';
import { validateSetTemplateArgs } from './tools.ts';

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
