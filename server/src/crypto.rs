//! PSK-ECDH transport: the long-lived pairing token is used as a pre-shared
//! key to authenticate an ephemeral X25519 handshake. The token itself is
//! never sent on the wire. Each session derives a symmetric key via
//! HKDF(token, ecdh_shared) and encrypts every subsequent frame with
//! ChaCha20-Poly1305 and a monotonically increasing counter nonce.
//!
//! Threats closed vs. the previous cleartext-hello design:
//!   - Sniffing the hello no longer leaks the token (C-1).
//!   - Without the token, an active MITM cannot derive the session key, so
//!     the handshake is authenticated by the PSK.
//!   - Per-frame nonces with a monotonic counter give replay protection (M-1).
//!
//! Wire format for an encrypted frame (both directions):
//!   [nonce: 12 bytes][ciphertext+tag: N bytes]
//! The nonce is a 96-bit big-endian counter starting at 0 per direction.
//! Receiving a counter strictly older than the last accepted one is rejected.

use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce, aead::Aead};
use hkdf::Hkdf;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use x25519_dalek::{EphemeralSecret, PublicKey};

/// Protocol version embedded in hello/welcome and the QR payload (M-3).
pub const PROTOCOL_VERSION: u32 = 1;

pub const SESSION_KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 12;

/// 32 raw bytes derived from the pairing token for use as the HKDF salt.
/// Hashing the token fixes its length regardless of the alphanumeric length
/// and avoids any partial-token timing path.
pub fn psk_from_token(token: &str) -> [u8; SESSION_KEY_LEN] {
    let digest = sha2::Sha256::digest(token.as_bytes());
    let mut out = [0u8; SESSION_KEY_LEN];
    out.copy_from_slice(&digest);
    out
}

/// Constant-time comparison of two byte slices. Returns false if the lengths
/// differ (length is not secret here, but we avoid short-circuiting on
/// content). Used for the legacy token field only; the encrypted transport
/// authenticates via AEAD tag.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    bool::from(a.ct_eq(b))
}

pub struct SessionKeys {
    encrypt: ChaCha20Poly1305,
    decrypt: ChaCha20Poly1305,
}

impl SessionKeys {
    /// Derive both direction keys from the ECDH shared secret and the PSK.
    /// `client` direction = client→server, `server` = server→client.
    pub fn derive(shared: &[u8], psk: &[u8]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(psk), shared);
        let mut client_key = [0u8; SESSION_KEY_LEN];
        let mut server_key = [0u8; SESSION_KEY_LEN];
        hk.expand(b"remcontrol c2s", &mut client_key)
            .expect("hkdf expand");
        hk.expand(b"remcontrol s2c", &mut server_key)
            .expect("hkdf expand");
        Self {
            // Server decrypts client frames with the client key, encrypts
            // server frames with the server key.
            decrypt: ChaCha20Poly1305::new_from_slice(&client_key).expect("key"),
            encrypt: ChaCha20Poly1305::new_from_slice(&server_key).expect("key"),
        }
    }

    /// Mirror of [`SessionKeys::derive`] with the role swapped: the client
    /// encrypts with the c2s key and decrypts with the s2c key. Both sides
    /// pass the same `(shared, psk)` so the keys line up across the pair.
    pub fn derive_client(shared: &[u8], psk: &[u8]) -> Self {
        let hk = Hkdf::<Sha256>::new(Some(psk), shared);
        let mut client_key = [0u8; SESSION_KEY_LEN];
        let mut server_key = [0u8; SESSION_KEY_LEN];
        hk.expand(b"remcontrol c2s", &mut client_key)
            .expect("hkdf expand");
        hk.expand(b"remcontrol s2c", &mut server_key)
            .expect("hkdf expand");
        Self {
            encrypt: ChaCha20Poly1305::new_from_slice(&client_key).expect("key"),
            decrypt: ChaCha20Poly1305::new_from_slice(&server_key).expect("key"),
        }
    }

    /// Encrypt a plaintext frame with the given counter as the nonce.
    /// Output is nonce || ciphertext+tag.
    pub fn seal(&self, counter: u64, plaintext: &[u8]) -> Vec<u8> {
        let nonce = nonce_for(counter);
        let ct = self.encrypt.encrypt(&nonce, plaintext).expect("encrypt");
        let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&ct);
        out
    }

    /// Decrypt a nonce||ciphertext+tag frame. `counter` is validated against
    /// the expected monotonic value by the caller (see [`RecvCounter`]).
    pub fn open(&self, frame: &[u8]) -> Result<Vec<u8>, &'static str> {
        if frame.len() < NONCE_LEN + 16 {
            return Err("frame too short");
        }
        let (nonce_bytes, ct) = frame.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        self.decrypt
            .decrypt(nonce, ct)
            .map_err(|_| "decrypt failed")
    }
}

fn nonce_for(counter: u64) -> Nonce {
    let mut n = [0u8; NONCE_LEN];
    // 4-byte zero prefix + 8-byte big-endian counter.
    n[4..].copy_from_slice(&counter.to_be_bytes());
    *Nonce::from_slice(&n)
}

/// Tracks the last accepted nonce counter for one direction and rejects
/// replays or out-of-order frames. The counter must strictly increase.
pub struct RecvCounter {
    last: Option<u64>,
}

impl Default for RecvCounter {
    fn default() -> Self {
        Self::new()
    }
}

impl RecvCounter {
    pub const fn new() -> Self {
        Self { last: None }
    }

    /// Validate the nonce of an incoming frame against this counter.
    /// Returns the parsed counter on success.
    pub fn check(&mut self, frame: &[u8]) -> Result<u64, &'static str> {
        if frame.len() < NONCE_LEN {
            return Err("frame too short");
        }
        let counter = u64::from_be_bytes(frame[4..NONCE_LEN].try_into().unwrap());
        if let Some(prev) = self.last
            && counter <= prev
        {
            return Err("replay or out-of-order frame");
        }
        self.last = Some(counter);
        Ok(counter)
    }
}

/// An ephemeral X25519 keypair for one handshake.
pub struct Handshake {
    secret: EphemeralSecret,
}

impl Default for Handshake {
    fn default() -> Self {
        Self::new()
    }
}

impl Handshake {
    pub fn new() -> Self {
        Self {
            secret: EphemeralSecret::random_from_rng(OsRng),
        }
    }

    pub fn public(&self) -> PublicKey {
        PublicKey::from(&self.secret)
    }

    /// Compute the raw ECDH shared secret from our secret and the peer's
    /// public key. Returns None if the peer's key yields the all-zero point
    /// (a degenerate handshake). The caller mixes this with the PSK via
    /// [`SessionKeys::derive`] (server) or [`SessionKeys::derive_client`]
    /// (client).
    pub fn shared_secret(self, peer: &PublicKey) -> Option<[u8; 32]> {
        let shared = self.secret.diffie_hellman(peer);
        let bytes = shared.to_bytes();
        if bytes.iter().all(|&b| b == 0) {
            return None;
        }
        Some(bytes)
    }

    /// Server-side convenience: derive server-role session keys.
    pub fn finish_server(self, peer: &PublicKey, psk: &[u8]) -> Option<SessionKeys> {
        self.shared_secret(peer)
            .map(|s| SessionKeys::derive(&s, psk))
    }
}

/// Serialize a public key as lowercase hex for the JSON handshake frames.
pub fn pubkey_hex(pk: &PublicKey) -> String {
    hex::encode(pk.as_bytes())
}

/// Parse a 32-byte public key from hex.
pub fn parse_pubkey_hex(s: &str) -> Option<PublicKey> {
    let bytes = hex::decode(s).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Some(PublicKey::from(arr))
}

/// Handshake frame sent by the client as the first message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloFrame {
    pub v: u32,
    #[serde(rename = "pubkey")]
    pub pubkey: String,
}

/// Handshake frame sent by the server in reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WelcomeFrame {
    pub v: u32,
    #[serde(rename = "pubkey")]
    pub pubkey: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_matching_keys_both_sides() {
        // Real two-party structure: server and client each compute the same
        // shared secret from their own secret and the peer's public key, then
        // derive keys with mirrored roles so server.encrypt == client.decrypt.
        let client = Handshake::new();
        let server = Handshake::new();
        let client_pub = client.public();
        let server_pub = server.public();
        let psk = psk_from_token("pairing-token");
        let server_shared = server.shared_secret(&client_pub).unwrap();
        let client_shared = client.shared_secret(&server_pub).unwrap();
        assert_eq!(server_shared, client_shared, "ECDH must agree");
        let server_keys = SessionKeys::derive(&server_shared, &psk);
        let client_keys = SessionKeys::derive_client(&client_shared, &psk);

        // Server encrypts (server→client), client decrypts.
        let s2c = server_keys.seal(0, b"hello from server");
        assert_eq!(client_keys.open(&s2c).unwrap(), b"hello from server");
        // Client encrypts (client→server), server decrypts.
        let c2s = client_keys.seal(0, b"hello from client");
        assert_eq!(server_keys.open(&c2s).unwrap(), b"hello from client");
    }

    #[test]
    fn ct_eq_handles_lengths() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn pubkey_hex_roundtrips() {
        let h = Handshake::new();
        let pk = h.public();
        let s = pubkey_hex(&pk);
        let parsed = parse_pubkey_hex(&s).unwrap();
        assert_eq!(pk.as_bytes(), parsed.as_bytes());
    }

    #[test]
    fn parse_pubkey_rejects_bad_hex() {
        assert!(parse_pubkey_hex("nothex").is_none());
        assert!(parse_pubkey_hex(&"a".repeat(63)).is_none());
        assert!(parse_pubkey_hex(&"a".repeat(64)).is_some());
    }

    #[test]
    fn recv_counter_rejects_replay() {
        let mut c = RecvCounter::new();
        let frame = nonce_for(5);
        assert_eq!(c.check(&frame).unwrap(), 5);
        assert!(c.check(&frame).is_err()); // replay same counter
        let frame_next = nonce_for(6);
        assert_eq!(c.check(&frame_next).unwrap(), 6);
        let frame_old = nonce_for(4);
        assert!(c.check(&frame_old).is_err()); // older than last
    }

    #[test]
    fn wrong_psk_produces_different_keys() {
        let server = Handshake::new();
        let client = Handshake::new();
        let client_pub = client.public();
        let server_pub = server.public();
        let shared = server.shared_secret(&client_pub).unwrap();
        let shared_c = client.shared_secret(&server_pub).unwrap();
        let keys_server = SessionKeys::derive(&shared, &psk_from_token("a"));
        let keys_client = SessionKeys::derive_client(&shared_c, &psk_from_token("a"));
        let frame = keys_server.seal(0, b"secret");
        assert_eq!(keys_client.open(&frame).unwrap(), b"secret");
        // A client key derived with a different PSK cannot open it.
        let keys_client_b = SessionKeys::derive_client(&shared_c, &psk_from_token("b"));
        assert!(keys_client_b.open(&frame).is_err());
    }
}
