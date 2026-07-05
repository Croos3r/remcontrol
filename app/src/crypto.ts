import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand as hkdfExpand, extract as hkdfExtract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';

export const PROTOCOL_VERSION = 1;
const NONCE_LEN = 12;
const KEY_LEN = 32;

export type SessionKeys = {
  encrypt: (counter: u64, plaintext: Uint8Array) => Uint8Array;
  decrypt: (counter: u64, frame: Uint8Array) => Uint8Array;
};

type u64 = number;

function pskFromToken(token: string): Uint8Array {
  return sha256(new TextEncoder().encode(token));
}

function deriveBoth(shared: Uint8Array, psk: Uint8Array) {
  const prk = hkdfExtract(sha256, shared, psk);
  const clientKey = hkdfExpand(sha256, prk, new TextEncoder().encode('remcontrol c2s'), KEY_LEN);
  const serverKey = hkdfExpand(sha256, prk, new TextEncoder().encode('remcontrol s2c'), KEY_LEN);
  return { clientKey, serverKey };
}

function buildNonce(counter: number): Uint8Array {
  const n = new Uint8Array(NONCE_LEN);
  // Bytes 0..4 are zero, bytes 4..12 are the 8-byte big-endian counter.
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  const dv = new DataView(n.buffer);
  dv.setUint32(4, hi, false);
  dv.setUint32(8, lo, false);
  return n;
}

export type HandshakeResult = {
  keys: SessionKeys;
  helloFrame: string;
};

/**
 * Build the client side of the PSK-ECDH handshake. Returns the plaintext
 * hello frame to send and a function to finalize once the server's welcome
 * is received.
 */
export function beginHandshake(_token: string): {
  clientPriv: Uint8Array;
  clientPubHex: string;
  helloFrame: string;
} {
  const clientPriv = x25519.utils.randomSecretKey();
  const clientPub = x25519.getPublicKey(clientPriv);
  const clientPubHex = bytesToHex(clientPub);
  const helloFrame = JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'hello',
    pubkey: clientPubHex,
  });
  return { clientPriv, clientPubHex, helloFrame };
}

/**
 * Complete the handshake using the server's welcome frame. Returns the
 * session keys (client encrypts, server decrypts mirrored).
 */
export function finishHandshake(
  clientPriv: Uint8Array,
  serverPubHex: string,
  token: string,
): SessionKeys {
  const serverPub = hexToBytes(serverPubHex);
  const shared = x25519.getSharedSecret(clientPriv, serverPub);
  const psk = pskFromToken(token);
  const { clientKey, serverKey } = deriveBoth(shared, psk);

  const seal = (counter: number, plaintext: Uint8Array): Uint8Array => {
    const nonce = buildNonce(counter);
    const cipher = chacha20poly1305(clientKey, nonce);
    const ct = cipher.encrypt(plaintext);
    const out = new Uint8Array(NONCE_LEN + ct.length);
    out.set(nonce, 0);
    out.set(ct, NONCE_LEN);
    return out;
  };
  const open = (_counter: number, frame: Uint8Array): Uint8Array => {
    if (frame.length < NONCE_LEN + 16) throw new Error('frame too short');
    const nonce = frame.slice(0, NONCE_LEN);
    const ct = frame.slice(NONCE_LEN);
    const cipher = chacha20poly1305(serverKey, nonce);
    return cipher.decrypt(ct);
  };
  return { encrypt: seal, decrypt: open };
}

/** Parse the counter out of an incoming frame's nonce (bytes 4..12, BE u64). */
export function frameCounter(frame: Uint8Array): number {
  if (frame.length < NONCE_LEN) return -1;
  const dv = new DataView(frame.buffer, frame.byteOffset + 4, 8);
  const hi = dv.getUint32(0, false);
  const lo = dv.getUint32(4, false);
  return hi * 0x100000000 + lo;
}

export { randomBytes };
