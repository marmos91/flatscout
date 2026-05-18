import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifySignature } from '../src/agency-registry/verify.js';

// Node's built-in crypto generates Ed25519 keypairs — we use it for the test
// rather than importing @noble/ed25519 here, so we exercise our verifier
// against a known-good external implementation.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

describe('verifySignature', () => {
  it('returns true for a valid Ed25519 signature over the payload', async () => {
    const payload = 'version: 1\nsource: test\nagencies: []\n';
    const sig = sign(null, Buffer.from(payload), privateKey).toString('hex');
    await expect(verifySignature(payload, sig, pubHex)).resolves.toBe(true);
  });
  it('returns false when payload is mutated', async () => {
    const payload = 'version: 1\nsource: test\nagencies: []\n';
    const sig = sign(null, Buffer.from(payload), privateKey).toString('hex');
    await expect(verifySignature(`${payload}tampered`, sig, pubHex)).resolves.toBe(false);
  });
});
