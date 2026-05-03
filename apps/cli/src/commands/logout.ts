/**
 * `aula logout` — clears stored tokens. The encryption key file is left in
 * place so we re-use it on the next login.
 */

import { ok } from '../io.ts';
import { defaultStore } from '../store.ts';

export async function runLogout(): Promise<void> {
  const store = defaultStore();
  await store.clear();
  ok('Logged out. Tokens cleared.');
}
