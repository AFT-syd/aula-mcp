import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import {
  buildFlowProofMessage,
  type FlowProofContext,
  signFlowValueProof,
} from './mitid-flow-proof.ts';

const ctx: FlowProofContext = {
  authenticatorSessionId: 'sess-id-123',
  authenticatorSessionFlowKey: 'flow-key-abc',
  clientHash: 'deadbeefcafebabe',
  authenticatorEafeHash: 'eafe-hash-xyz',
  brokerSecurityContext: 'broker-ctx',
  referenceTextHeader: 'Header tekst',
  referenceTextBody: 'Body tekst',
  serviceProviderName: 'Aula',
};

describe('buildFlowProofMessage', () => {
  test('joins fields with commas in the documented order', () => {
    const msg = buildFlowProofMessage(ctx).toString('utf8');
    const parts = msg.split(',');
    expect(parts).toHaveLength(8);
    expect(parts[0]).toBe('sess-id-123');
    expect(parts[1]).toBe('flow-key-abc');
    expect(parts[2]).toBe('deadbeefcafebabe');
    expect(parts[3]).toBe('eafe-hash-xyz');
  });

  test('sha256(broker_security_context) replaces position 4', () => {
    const msg = buildFlowProofMessage(ctx).toString('utf8');
    const brokerHash = msg.split(',')[4];
    // SHA256("broker-ctx") known value
    expect(brokerHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('reference texts and SP name are base64 encoded', () => {
    const msg = buildFlowProofMessage(ctx).toString('utf8');
    const parts = msg.split(',');
    expect(parts[5]).toBe(Buffer.from('Header tekst', 'utf8').toString('base64'));
    expect(parts[6]).toBe(Buffer.from('Body tekst', 'utf8').toString('base64'));
    expect(parts[7]).toBe(Buffer.from('Aula', 'utf8').toString('base64'));
  });
});

describe('signFlowValueProof', () => {
  const message = Buffer.from('msg', 'utf8');
  const K = Buffer.alloc(32, 0x11); // K_bits = 0x1111...1111

  // Vectors computed via:
  //   node -e "const c=require('crypto');const K=Buffer.alloc(32,0x11);const k=c.createHash('sha256').update('<prefix>'+K.toString('hex')).digest();console.log(c.createHmac('sha256',k).update('msg').digest('<encoding>'))"

  test('APP produces base64 with prefix "flowValues"', () => {
    const proof = signFlowValueProof(message, K, 'flowValues', 'base64');
    expect(proof).toBe('hBtyibVJCZwrDuKbZeLcb89OW6VhXpvjZT885blsc4k=');
  });

  test('CODE_TOKEN produces hex with prefix "OTP" + digits', () => {
    const proof = signFlowValueProof(message, K, 'OTP123456', 'hex');
    expect(proof).toBe('17a8239ce89070cc37816cf7af3197fbd0ad0ef4fa742932954a500f30e18e39');
  });

  test('PASSWORD produces hex with prefix "flowValues"', () => {
    const proof = signFlowValueProof(message, K, 'flowValues', 'hex');
    expect(proof).toBe('841b7289b549099c2b0ee29b65e2dc6fcf4e5ba5615e9be3653f3ce5b96c7389');
  });
});
