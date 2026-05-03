/** OAuth `state` token — opaque random URL-safe string. */

import { randomBase64Url } from './crypto.ts';

export function generateState(bytes: number = 32): string {
  return randomBase64Url(bytes);
}
