import * as ed from '@noble/ed25519';

/**
 * Verifies an Ed25519 signature over a UTF-8 payload.
 *
 * @param payload  The exact UTF-8 string that was signed.
 * @param sigHex   Hex-encoded 64-byte Ed25519 signature.
 * @param pubKeyHex Hex-encoded 32-byte Ed25519 public key.
 * @returns true if the signature is valid, false otherwise (incl. malformed inputs).
 */
export async function verifySignature(payload: string, sigHex: string, pubKeyHex: string): Promise<boolean> {
  try {
    const sig = hexToBytes(sigHex);
    const pub = hexToBytes(pubKeyHex);
    const msg = new TextEncoder().encode(payload);
    return await ed.verifyAsync(sig, msg, pub);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('bad hex');
    out[i] = byte;
  }
  return out;
}
