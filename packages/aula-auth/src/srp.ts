/**
 * Aula's MitID SRP-6a variant. Ported from
 * `aula-python-reference/.../mitid_browserclient/CustomSRP.py`.
 *
 * Differences from textbook SRP-6a worth flagging:
 *   • Custom 3072-bit prime N (not any RFC 5054 group). g = 2.
 *   • The "k" multiplier (here `s` in the Python source) is
 *     SHA256(decimal_string(N).utf8 || left-padded g bytes).
 *     Note: the *decimal string* of N is hashed, not its bytes.
 *   • u = SHA256(left-padded A bytes || left-padded B bytes) mod N.
 *   • Session key K = SHA256(decimal_string(S).utf8) — again decimal of the
 *     premaster secret, not bytes.
 *   • M1 = SHA256(decimal(N_hash XOR g_hash) || I || srpSalt
 *                  || decimal(A) || decimal(B) || hex(K)) over ASCII.
 *
 * Wire format: A and B travel as Python `format(x, 'x')` — minimal lowercase
 * hex with no padding to even length. We replicate that with `n.toString(16)`.
 *
 * Pinning the random `a` via constructor is for tests only; production paths
 * must always let the constructor sample a fresh 256-bit value.
 */

import { Buffer } from 'node:buffer';
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes, sha256 } from './crypto.ts';
import { bigIntToBytesBE, bytesToBigIntBE, hexToBigInt } from './encoding.ts';

/**
 * Aula's custom 3072-bit SRP modulus, copied verbatim (as a decimal string)
 * from CustomSRP.py to eliminate any chance of hex transcription error.
 */
const N_DECIMAL =
  '4983313092069490398852700692508795473567251422586244806694940877242664573189' +
  '9031929377974469920688180999869580549980123317208691362967809360095087004877' +
  '8996242916151585354155671959334695992953115070645733842905892650581784752485' +
  '5862259333438239756474464759974189984231409170758360686392625635632084395639' +
  '1432298898620415286359069909130872458179594609483453363330867846088230847889' +
  '0668986556662101517542469153571152027378626198985136086866906710110895615953' +
  '0739641990220546209432953829448997561743719584980402874346226230488627145977' +
  '6083898587063918581382006186313852103044299028477021415874705133369054493513' +
  '2712208646472514397031305435865048824116713154469234912338133320451563760865' +
  '6643608393788598011108539679620836313915590459891513992208387515629240292926' +
  '5708943211654826085440301739754527816237918051965463269967905362073591435271' +
  '82077625412731080411108775183565594553871817639221414953634530830290393130518228654795859';
export const SRP_N: bigint = BigInt(N_DECIMAL.replace(/\s/g, ''));
export const SRP_g: bigint = 2n;

/** Byte length of N (= 384 for the 3072-bit Aula prime). */
const N_BYTE_LENGTH = Math.ceil(SRP_N.toString(16).length / 2);

/** Modular exponentiation, square-and-multiply. Handles negative bases. */
export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  if (exp < 0n) throw new Error('modPow: negative exponent not supported');
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % mod;
    e >>= 1n;
    b = (b * b) % mod;
  }
  return result;
}

/** Minimal lowercase hex (matches Python `format(n, 'x')`). */
function bigIntToHexMinimal(value: bigint): string {
  if (value < 0n) throw new Error('bigIntToHexMinimal: negative value');
  return value.toString(16);
}

export interface CustomSrpOptions {
  /** Override the random `a` value (testing only). */
  a?: bigint;
}

export interface SrpStage3Args {
  /** Server-supplied SRP salt as a hex string. */
  srpSaltHex: string;
  /** Server-supplied B as a hex string. */
  randomBHex: string;
  /** Password material — already a hex string (e.g. PBKDF2 output) for the
   * PASSWORD/CODE_TOKEN flows; the client passes whatever the spec dictates. */
  passwordHex: string;
  /** MitID authenticationSessionId — included in the M1 transcript. */
  authSessionId: string;
}

/** Result of a successful stage 3. */
export interface SrpStage3Result {
  /** Client proof. Sent to server as `m1.value`. */
  m1Hex: string;
  /** Session key K (32 bytes). Used by AuthEnc/Dec and flowValueProof. */
  K: Buffer;
}

export class CustomSrp {
  static readonly N: bigint = SRP_N;
  static readonly g: bigint = SRP_g;

  private secretA!: bigint;
  private publicA!: bigint;
  private serverB: bigint = 0n;
  private hashedPassword: bigint = 0n;
  private sessionKey?: Buffer;
  private m1Hex?: string;

  constructor(options: CustomSrpOptions = {}) {
    let a = options.a ?? bytesToBigIntBE(randomBytes(32));
    if (a < 0n) a += SRP_N; // dead code in the reference, kept for parity
    this.secretA = a;
    this.publicA = modPow(SRP_g, this.secretA, SRP_N);
  }

  /** A as the wire-format hex string. Send as `randomA.value`. */
  stage1(): string {
    return bigIntToHexMinimal(this.publicA);
  }

  /** Public A as a bigint. Useful for tests. */
  get publicAValue(): bigint {
    return this.publicA;
  }

  /** Derive K and M1 given the server response. */
  stage3(args: SrpStage3Args): SrpStage3Result {
    const B = hexToBigInt(args.randomBHex);
    if (B === 0n || B % SRP_N === 0n) {
      throw new Error('SRP stage 3: server B failed safety check');
    }
    this.serverB = B;

    // x = SHA256(srpSalt || password) interpreted as int
    this.hashedPassword = hexToBigInt(sha256(args.srpSaltHex + args.passwordHex).toString('hex'));

    // S = (B - g^x * k_eq)^(u*x + a) mod N
    const S = this.computeSessionSecret();

    // K = SHA256(decimal(S))
    this.sessionKey = sha256(S.toString());

    // I = SHA256(authSessionId).hex
    const iHex = sha256(args.authSessionId).toString('hex');

    this.m1Hex = this.computeM1(iHex, args.srpSaltHex);
    return { m1Hex: this.m1Hex, K: this.sessionKey };
  }

  /** Verify the server's M2 against our local M1/K/A. */
  stage5(m2Hex: string): boolean {
    if (!this.sessionKey || !this.m1Hex) {
      throw new Error('SRP stage 5 called before stage 3');
    }
    const m1Int = hexToBigInt(this.m1Hex);
    const transcript = this.publicA.toString() + m1Int.toString() + this.sessionKey.toString('hex');
    const m2Verify = sha256(transcript).toString('hex');
    return m2Verify === m2Hex;
  }

  /** AES-GCM encrypt with K. Output: iv (16) || ciphertext || tag (16). */
  authEnc(plaintext: Buffer): Buffer {
    if (!this.sessionKey) throw new Error('SRP: K not derived');
    const iv = randomBytes(16);
    const { ciphertext, tag } = aesGcmEncrypt(this.sessionKey, iv, plaintext);
    return Buffer.concat([iv, ciphertext, tag]);
  }

  /** Decrypt a base64-encoded `iv || ciphertext || tag` blob. */
  authDec(base64Message: string): Buffer {
    if (!this.sessionKey) throw new Error('SRP: K not derived');
    return decryptIvCipherTag(base64Message, this.sessionKey);
  }

  /** Decrypt with the PIN-derived key (SHA256(hex(K) || "PIN")). */
  authDecPin(base64Message: string): Buffer {
    if (!this.sessionKey) throw new Error('SRP: K not derived');
    const pinKey = sha256(
      Buffer.concat([Buffer.from(this.sessionKey.toString('hex')), Buffer.from('PIN')]),
    );
    return decryptIvCipherTag(base64Message, pinKey);
  }

  /** Exposed for tests; mirrors Python's `K_bits`. */
  get K(): Buffer | undefined {
    return this.sessionKey;
  }

  // --- internals ---------------------------------------------------------

  private computeLittleS(): bigint {
    // SHA256(decimal_str(N).utf8 || g_bytes_left_padded_to_N_length)
    const gBytes = bigIntToBytesBE(SRP_g, N_BYTE_LENGTH);
    const input = Buffer.concat([Buffer.from(SRP_N.toString(), 'utf8'), gBytes]);
    return hexToBigInt(sha256(input).toString('hex'));
  }

  private computeU(): bigint {
    const aBytes = bigIntToBytesBE(this.publicA, N_BYTE_LENGTH);
    const bBytes = bigIntToBytesBE(this.serverB, N_BYTE_LENGTH);
    const u = hexToBigInt(sha256(Buffer.concat([aBytes, bBytes])).toString('hex')) % SRP_N;
    return u;
  }

  private computeSessionSecret(): bigint {
    const u = this.computeU();
    const k = this.computeLittleS();
    const exponent = u * this.hashedPassword + this.secretA;
    const gToX = modPow(SRP_g, this.hashedPassword, SRP_N);
    const base = this.serverB - gToX * k; // can be negative; modPow normalizes
    return modPow(base, exponent, SRP_N);
  }

  private computeM1(iHex: string, srpSaltHex: string): string {
    const nHashInt = hexToBigInt(sha256(SRP_N.toString()).toString('hex'));
    const gHashInt = hexToBigInt(sha256(SRP_g.toString()).toString('hex'));
    const xorInt = nHashInt ^ gHashInt;

    const transcript =
      xorInt.toString() +
      iHex +
      srpSaltHex +
      this.publicA.toString() +
      this.serverB.toString() +
      // biome-ignore lint/style/noNonNullAssertion: invariant — sessionKey set in stage3 before this is called
      this.sessionKey!.toString('hex');
    return sha256(transcript).toString('hex');
  }
}

function decryptIvCipherTag(base64Message: string, key: Buffer): Buffer {
  const blob = Buffer.from(base64Message, 'base64');
  const iv = blob.subarray(0, 16);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(16, blob.length - 16);
  return aesGcmDecrypt(key, iv, ciphertext, tag);
}
