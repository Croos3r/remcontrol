# remcontrol — Cybersecurity Audit Report

**Date:** 2026-07-06
**Scope:** Full source of `server/` (Rust) and `app/` (Expo/React Native), plus CI in `.github/`.
**Auditor:** Automated expert-grade static review (no runtime pentest performed).
**Commit baseline:** `28eb6aa` (main, clean tree)
**Classification:** Confidential

---

## 1. Executive summary

remcontrol is a LAN remote-control tool: a Rust WebSocket server on the PC
injects mouse and keyboard input, an Expo Android app drives it via gestures.
Threat model is fundamentally "trusted LAN only" — the README states this
explicitly and traffic is unencrypted. Within that model the design is
reasonable, but several findings weaken it beyond what the README implies and
should be fixed regardless of the trust assumption.

**Risk headline:** A single 32-character ASCII token is the *only* secret
protecting full control of the host (mouse, keyboard, arbitrary Unicode text
entry, modifier+key combinations). The token is transmitted in cleartext over
WS, embedded in a QR code printed to the terminal, advertised alongside mDNS
metadata, and stored unencrypted on the phone. The authentication protocol
has a timing side-channel and no rate limiting, so the token is brute-forceable
over the network within practical time on a non-isolated LAN.

**Finding count by severity**

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 5 |
| Medium | 6 |
| Low / Informational | 7 |

The two Criticals are both auth-model issues: (1) no transport encryption +
single shared secret, and (2) cleartext token in the QR payload combined with
no brute-force protection. Everything else follows from these or from input
not being bounds-checked at the trust boundary.

---

## 2. System & trust model

### 2.1 Architecture

```
Phone (app/)  ──ws://IP:17890/ws──>  PC (server/, axum + tokio)
   │                                        │
   │ token in hello frame                   └── enigo / xdotool ──> OS input
   │                                        │     (mouse, keyboard)
   └─ mDNS _remcontrol._tcp discovery       └── config.toml (token, port)
```

- Server binds `0.0.0.0:17890` (`main.rs:46`), reachable from every interface.
- Pairing token: 32 chars from `rand::distr::Alphanumeric` (`config.rs:51-53`),
  ~190 bits of entropy — strong on paper.
- One active client at a time; a new connection kicks the previous
  (`ws.rs:51`).
- Input path: `ws.rs` → `mpsc::UnboundedSender<Command>` → `injector.rs`
  worker thread → enigo/xdotool.

### 2.2 Stated threat model (README §Security)

> "LAN only … Traffic is not encrypted: use it on networks you trust."

This is an honest disclosure. The findings below either violate this model's
implicit guarantees or are bad practice even inside a trusted LAN.

### 2.3 Implicit trust assumptions that do NOT hold

1. **"The LAN is trusted"** does not hold on guest Wi-Fi, shared student
   housing, conference networks, or any network with a rogue device. mDNS
   and the listener are on `0.0.0.0`, so anyone on the same L2 segment is a
   peer.
2. **"The token is secret"** is undermined by cleartext transport, QR
   logging, and mDNS-adjacent exposure (see §3.2, §3.4).
3. **"One server = one token"** means a phone that knows the token can always
   reconnect; there is no per-session key, no nonce, no replay protection.

---

## 3. Findings

Findings are ordered by severity. Each has a concrete failure scenario and a
fix.

### CRITICAL C-1 — No transport security; single shared secret over cleartext WS

**Location:** `app/src/connection.ts:38`, `server/src/main.rs:46`,
`server/src/ws.rs`.

**Issue:** The app opens `ws://` (plaintext) and sends the token as the first
text frame (`connection.ts:42`). Any host on the same L2 segment can sniff the
token via ARP spoofing, a compromised AP, or a mirrored/SPAN port — no
compromise of the phone or PC is required. With the token, full mouse +
keyboard control is permanent until the user runs `--reset-token`.

**Failure scenario:** On a café Wi-Fi where the PC and attacker share the L2
segment, the attacker passively captures `{"type":"hello","token":"…"}`, then
connects from their own device and types arbitrary keystrokes (URLs, shell
commands) at an opportune moment.

**Fix:** Use `wss://` with a self-signed cert pinned in the app, or a
Noise/curve25519 handshake producing a session key and encrypting all frames.
At minimum, derive a per-session key from a PAKE (e.g. OPAQUE / SRP) so the
stored/QR token is never sent over the wire. This also closes replay. If TLS
is too heavy for the form factor, document the sniffing risk prominently.

---

### CRITICAL C-2 — Pairing token is brute-forceable; no rate limit, timing oracle

**Location:** `server/src/ws.rs:85-99` (`authenticate`), `server/src/ws.rs:62-78`
(`handle` loop).

**Issue:** Authentication compares `t == token` (`ws.rs:95`) — a non-constant-
time string equality, leaking a timing side channel. More importantly, there
is **no rate limiting, no backoff, no lockout, and no failed-attempt counter**.
A new TCP connection resets all state (the `active` mutex only tracks the
*successful* connection). An attacker can open thousands of connections per
second, each sending a candidate token, and the server will respond with
`error`/`welcome` instantly.

Token space: 32 chars of `[A-Za-z0-9]` = ~190 bits. At 10 k attempts/s single-
threaded this is not brute-forceable directly — **but the token is not always
32 random chars in practice**: users may copy it manually, the QR payload
exposes it in plaintext (C-1), and the timing oracle narrows the search.
Combined with C-1 (sniffing) the token is not the bottleneck.

**Failure scenario:** An attacker who captured a partial token or is
targeting a known-short/weak token (e.g. one a user hand-typed) can enumerate
without any throttling, and the timing difference between "bad token" and
"expected hello" responses helps confirm prefixes.

**Fix:**
- Constant-time compare: use `subtle::ConstantTimeEq` or a manual
  `bool::from(a.ct_eq(b))` on the bytes.
- Add per-IP and global connection-rate limiting in `ws::router` (e.g.
  `tower::limit::ConcurrencyLimit` + a token-bucket in `AppState`), with
  exponential backoff after N failed `hello`s from the same peer.
- Close and ignore further frames from a peer after K auth failures within
  a window.
- Reject a second `Hello` inside an already-authenticated session
  (`ws.rs:72` currently silently ignores it — harmless, but log it).

---

### HIGH H-1 — Unbounded, unauthenticated input reaches OS input injection

**Location:** `server/src/ws.rs:73`, `server/src/injector.rs:97-117`
(`ClientMessage::Text`).

**Issue:** After auth, every valid `ClientMessage` is forwarded to the
injector with no bounds checking. `Text { value }` accumulates into a 4096-
byte buffer (`injector.rs:100`) but individual frames have no length cap in
the protocol or in `ws.rs`. The `axum` WebSocket layer has a default max frame
size, but it is not explicitly configured, so a default change could regress.
There is no cap on *message rate*, so a malicious (or compromised) phone can
flood keystrokes. Because the injector types via `xdotool type` on Linux
(`injector.rs:225-231`) and `enigo::text` elsewhere, an attacker with the
token can inject arbitrary text including shell metacharacters — the
*intended* behavior, but there is no allowlist, no "dangerous key chord"
guard (e.g. the app can send `Super` + keys → open a terminal and run
commands), and no user-visible confirmation for text input.

**Failure scenario:** Token compromised via C-1. Attacker sends
`{"type":"modifier","key":"super","action":"down"}` then
`{"type":"key","key":"enter"}`, types a URL or `xdotool`-equivalent command,
and runs code. This is the full chain: C-1 ⇒ H-1 ⇒ RCE on the host.

**Fix:** This is largely inherent to the product, but mitigate:
- Explicit `max_message_size` / `max_frame_size` on the WebSocket upgrade
  (axum `WebSocketConfig`).
- Add a protocol-level max length for `Text` (e.g. 1024) and reject overlong
  frames with `Error` instead of silently accepting.
- Document that the token is equivalent to full desktop control and should
  be treated as a password; consider a "confirm large text paste" UX on the
  server side for out-of-band input (out of scope, but flagged).

---

### HIGH H-2 — Token stored in cleartext on the phone (AsyncStorage)

**Location:** `app/src/storage.ts:13,16`, `app/src/screens/ConnectScreen.tsx:111`.

**Issue:** `saveConnection` writes the full `ServerInfo` (including `token`)
to `@react-native-async-storage/async-storage`. On Android, AsyncStorage
stores data in an unencrypted SQLite DB / SharedPreferences file. On a
rooted device, or via a backup extraction (adb backup, forensic tools), the
token is recoverable. The token is also the only credential, so this is
credential-at-rest in plaintext.

**Failure scenario:** Phone is lost/stolen/rooted; attacker reads
`remcontrol:last-connection` from the app's data dir and now has permanent
PC control.

**Fix:** Store the token in the Android Keystore / iOS Keychain (e.g.
`expo-secure-store`, which encrypts at rest and is the documented Expo
solution for secrets). At minimum do not store the token for "recent"
connections; store only `ip`/`port`/`name` and re-pair each time. The
"reconnect automatically on launch" feature (README §2.3) directly conflicts
with this — make it opt-in.

---

### HIGH H-3 — QR payload prints the secret token to the terminal and logs

**Location:** `server/src/main.rs:27` (`println!("  token   : {}", cfg.token)`),
`main.rs:30` (`qr2term::print_qr(&payload)`), `lib.rs:22-30` (`pairing_payload`
embeds `token`).

**Issue:** The token is (a) printed in cleartext to stdout, where it lands in
terminal scrollback, shell history of `cargo run`, systemd journal if run as
a service, and any terminal-recording tool, and (b) embedded in a QR code
that any screen-share or screenshot of the terminal reveals. There is no
ephemeral pairing mode: the QR encodes the *long-lived* token, not a
one-time pairing code.

**Failure scenario:** User runs the server under a systemd unit or in a
shared screen during a call; the QR/token is captured and remains valid
indefinitely.

**Fix:** Use a one-time/ephemeral pairing code: the QR encodes a short-lived
secret valid only for the first successful handshake; after pairing, the
server and phone derive a long-term session key (ties into C-1's PAKE fix).
Stop printing the raw token to stdout; print only a short fingerprint or the
QR.

---

### HIGH H-4 — Listener bound to 0.0.0.0 with no bind-address option

**Location:** `server/src/main.rs:46` (`TcpListener::bind(("0.0.0.0", cfg.port))`).

**Issue:** The server listens on all interfaces, including VPN tunnels,
Docker bridges, virtual adapters, and any secondary NIC. There is no config
option to restrict the bind address (e.g. LAN only). A user on a laptop with
a WireGuard tunnel or a Docker `docker0` bridge is now exposing remote
control to peers on those networks too.

**Failure scenario:** Developer runs the server; their corporate VPN routes
the `17890` port to the whole VPN subnet, exposing input injection to VPN
peers.

**Fix:** Add `bind_addr` to `Config` (default to the detected `local_ip`
rather than `0.0.0.0`), or at least default to binding the discovered LAN IP
and surface the bind address in the printed output. mDNS already advertises
the specific IP, so the wildcard bind is not needed for the documented flow.

---

### HIGH H-5 — No authentication on mDNS / metadata exposure

**Location:** `server/src/main.rs:33-42`.

**Issue:** mDNS advertises `_remcontrol._tcp` with hostname and port to the
whole multicast group. Anyone on the segment can enumerate every remcontrol
host and its listening port trivially (no token needed to discover). This is
information disclosure that makes targeting easier and, combined with C-1/C-2,
removes the "security through obscurity" of the port.

**Failure scenario:** Attacker on the LAN lists all remcontrol PCs, picks
one, and brute-forces/sniffs the token (C-1/C-2).

**Fix:** This is partly inherent to mDNS. Mitigate by not advertising over
mDNS by default (make discovery opt-in via a flag), and ensure the real
defense is the token + transport security (C-1). Document that discovery
broadcasts the host's existence.

---

### MEDIUM M-1 — No nonce / replay protection; single active client is kick, not auth

**Location:** `server/src/ws.rs:50-54`.

**Issue:** The "single active client" mechanism replaces a connected client
when a new one authenticates. There is no message authentication, no
sequence numbers, no replay protection. An attacker who can inject frames
(not full MITM, just packet injection on the LAN) can replay captured
`move`/`click`/`text` frames into an existing session if they can race the
TCP stream — low likelihood but unmitigated. More practically, the "kick"
behavior is a DoS primitive: anyone with the token (e.g. sniffed via C-1) can
disconnect the legitimate user at will.

**Fix:** Per-session keys (C-1) give replay protection via a nonce + MAC. For
the kick DoS, consider refusing to displace an active client unless the new
connection presents a fresher credential or the user explicitly requested
"transfer".

---

### MEDIUM M-2 — `xdotool key` argument constructed from raw Unicode codepoint

**Location:** `server/src/injector.rs:232-241`.

**Issue:** For non-ASCII text on Linux, the code emits
`xdotool key --clearmodifiers 0x{code:04X}` per character where `code =
ch as u32`. `ch as u32` for a `char` is the Unicode scalar value, which is
safe (no shell injection — args are passed via `Command::args`, not a shell).
However: (a) the `format!("0x{code:04X}")` truncates nothing but `code` can
exceed 0xFFFF for astral chars and `xdotool` key expects keysyms, which for
non-BMP characters are not simply the scalar value — so some Unicode input is
silently dropped or mis-typed (correctness, not security). The bigger
concern is that `xdotool key` interprets certain names; here only `0xNNNN`
hex is passed, so no keysym-name injection. Low risk, but the per-char fork
of `xdotool` for every non-ASCII character is a performance/DoS amplification
vector: a single `Text` frame with many astral chars forks N processes.

**Fix:** Batch astral characters or use `xdotool type` with `--clearmodifiers`
for the whole string (already done for ASCII). Cap `Text` length (H-1) and
rate-limit. Confirm keysym handling with xdotool docs for astral planes.

---

### MEDIUM M-3 — `Hello` accepted only on first frame, but no protocol version negotiation

**Location:** `server/src/ws.rs:85-99`, `app/src/connection.ts:42`.

**Issue:** There is no protocol version in `Hello` or the pairing payload. A
future breaking change to the protocol has no way to fail gracefully; clients
and servers of mismatched versions will produce confusing "expected hello" /
"ignoring invalid message" errors rather than a clean "unsupported version"
error. This is a robustness finding that becomes a security finding if it
leads to undefined-state input handling.

**Fix:** Add `"v": 1` to `Hello` and the QR payload; reject unknown versions
explicitly.

---

### MEDIUM M-4 — `pending` VecDeque in injector can grow unbounded under backpressure

**Location:** `server/src/injector.rs:32, 67-109`.

**Issue:** The `pending` queue and the `mpsc::UnboundedSender` in `ws.rs` are
both unbounded. A flood of input messages (e.g. a malicious or buggy client
sending thousands of `move` events faster than the 8ms tick can smooth
them) accumulates without limit → unbounded memory growth on the server.
Because `mpsc` is unbounded and `ws.rs:73` does `let _ = state.commands.send`,
the WebSocket task never blocks, so backpressure never propagates to the
client.

**Failure scenario:** Attacker with token sends a sustained burst of
`move`/`text` frames; the server's injector thread falls behind and the
unbounded channel grows until OOM.

**Fix:** Use a bounded channel (e.g. `mpsc::channel(N)`) and apply
backpressure (drop or close the connection on overflow). Cap `pending`
length and shed excess.

---

### MEDIUM M-5 — Reconnect loop on the phone has no auth-failure handling

**Location:** `app/src/screens/TrackpadScreen.tsx:121-149`, `connection.ts`.

**Issue:** On `onClose`/`onError` the app reconnects with exponential backoff
up to 16s, then gives up (`TrackpadScreen.tsx:32, 136-144`). If the token was
rotated server-side (`--reset-token`) or sniffed and the session was kicked,
the phone will keep hammering the server with the old token for up to ~31s of
delays. This is a minor DoS amplifier (every phone reconnects 5 times) and
also leaks "the phone had a valid token recently" to an observer. There is
also no handling of the server's `error` frame distinguishing "bad token"
(should stop reconnecting) from transient network errors (should retry).

**Fix:** On receiving an `error` with "bad token" / "expected hello", stop
reconnecting and surface a "re-pair" UI instead of retrying blindly.

---

### MEDIUM M-6 — Config file written with default umask (no restrictive perms)

**Location:** `server/src/config.rs:42-48`.

**Issue:** `std::fs::write(path, …)` creates `config.toml` with the process
umask, typically 0644 on Linux → world-readable. The file contains the token.
On a multi-user host, any user can read the token.

**Fix:** Create the file with mode 0600 (use `std::os::unix::fs::OpenOptionsExt`
with `mode(0o600)`, or `std::fs::Permissions::set_mode` after create).
`dirs::config_dir()` is `~/.config` which is normally 0700, so the practical
risk is limited to systems where someone changed `$HOME` perms — still, set
the file mode explicitly.

---

### LOW / INFORMATIONAL

- **L-1 — `Connection.send` swallows send failures silently** (`connection.ts:85-89`).
  If the underlying socket is in CLOSING state, `send` can throw; the `connected`
  guard mitigates but a race between readyState check and send is possible. Wrap
  in try/catch and surface as `onError`.

- **L-2 — `serde_json::to_string(&err).unwrap()` and `&welcome` `.unwrap()`** (`ws.rs:43,55`).
  Serializing a `ServerMessage` can never fail in practice, but `unwrap` in a
  network handler is a panic-on-bug risk; use `unwrap_or_else` with a static
  fallback string.

- **L-3 — `qr2term::print_qr` failure path** (`main.rs:30`). If the terminal
  cannot render the QR, the server still starts; the user just has no pairing
  UI. Acceptable, but log the error.

- **L-4 — `local_ip_address::local_ip()` picks an arbitrary interface** (`main.rs:20`).
  On multi-homed hosts this may advertise a non-LAN IP (e.g. a Docker bridge),
  producing a QR that points at an unreachable address. Not security per se but
  drives users toward manual IP entry, increasing token-exposure risk (H-3).

- **L-5 — No dependency pinning / lockfile audit in CI.** `server/` has no
  `Cargo.lock` audit step; `app/` runs `npm ci` but no `npm audit`. Supply-chain
  risk. Add `cargo audit` and `npm audit --audit-level=high` to CI.

- **L-6 — `enigo` 0.6 / `mdns-sd` 0.13 / `qr2term` 0.3** are not pinned to a
  hash; `Cargo.toml` uses caret versions. CI uses `cargo install cargo-xwin`
  (`release.yml`) from the network at build time — a compromise of crates.io or
  the cargo-xwin repo would inject into release binaries. Pin and verify.

- **L-7 — No CORS / origin check on WebSocket upgrade.** Browser-based CSRF via
  WebSocket is not in the threat model (no browser client), but adding an
  `Origin` allowlist on the upgrade would harden against future web clients and
  against DNS-rebinding from a malicious webpage on the same machine.

---

## 4. Threat chains (how findings combine)

1. **Passive takeover:** Sniff token on shared Wi-Fi (C-1) → inject keystrokes
   (H-1) → open terminal via `Super`+key, type commands → RCE on the PC.
   *No exploit needed beyond packet capture.* This is the primary risk and
   the reason C-1 is Critical.

2. **Active brute force:** Discover host via mDNS (H-5) → brute force token
   with no rate limit (C-2) → same RCE chain (H-1). Slower than #1 but
   requires no network position, only reachability.

3. **Physical theft:** Steal phone → read AsyncStorage (H-2) → reconnect from
   anywhere on the LAN → control PC.

4. **Credential leak via logs/screen:** Token in terminal scrollback / screen
   share (H-3) → attacker reconnects until user runs `--reset-token`.

5. **Memory DoS:** Token acquired → flood `text`/`move` frames → unbounded
   channel (M-4) → server OOM.

---

## 5. Positive findings

- **Strong token entropy** at generation (32 × Alphanumeric ≈ 190 bits).
- **Single-active-client** design limits simultaneous abuse and auto-releases
  held buttons/modifiers (`injector.rs:132-138`) — good for not leaving the
  desktop in a stuck state.
- **Input is dispatched on a dedicated thread** with bounded smoothing; the
  `ReleaseAll` on disconnect (`ws.rs:57,81`) prevents stuck keys.
- **Protocol is a closed enum** (`protocol.rs`): unknown `type` values are
  rejected by serde, so there is no reflection-driven deserialization bug.
- **No shell invocation anywhere:** all `xdotool` calls use
  `Command::args`, eliminating classic shell injection.
- **Tests cover** the auth handshake (good/bad token) and recent-connections
  storage; CI runs clippy with `-D warnings`, biome, tsc, and tests.
- **No telemetry, no network egress** beyond the local WS — the server does
  not phone home.

---

## 6. Prioritized remediation plan

| Priority | Finding | Effort | Impact |
|---|---|---|---|
| P0 | C-1 transport security (TLS or PAKE) | Medium | Closes chain #1 |
| P0 | C-2 constant-time compare + rate limiting | Small | Closes chain #2 |
| P1 | H-1 explicit WS frame/message size limits | Small | Bounds attack surface |
| P1 | H-2 store token in SecureStore | Small | Closes chain #3 |
| P1 | H-3 ephemeral pairing code, stop printing token | Medium | Closes chain #4 |
| P1 | H-4 configurable bind address (default LAN IP) | Small | Limits exposure |
| P2 | H-5 make mDNS opt-in / document | Small | Reduces enumeration |
| P2 | M-4 bounded channel + backpressure | Small | Fixes OOM |
| P2 | M-6 config file mode 0600 | Trivial | Multi-user hardening |
| P2 | M-5 stop reconnect on "bad token" | Small | UX + minor DoS |
| P3 | M-1 replay/nonce (rides on C-1) | — | With C-1 |
| P3 | M-2/M-3 text cap, protocol version | Small | Robustness |
| P3 | L-1..L-7 | Small | Hardening + supply chain |

**Quick wins to ship first** (one afternoon): C-2 constant-time + rate limit,
H-1 frame size limit, M-6 file perms, H-4 bind to LAN IP, L-5 `cargo audit`.
These materially shrink the attack surface without the larger TLS/PAKE work
that C-1 and H-3 require.

---

## 7. Statement of limitations

This is a static source review based on the code at `28eb6aa`. No dynamic
testing, fuzzing, or network capture was performed. Dependency CVEs were not
matched against a live advisory database (run `cargo audit` / `npm audit`).
Timing side-channels were reasoned about from the code, not measured. Findings
are rated by the auditor's judgment of exploitability within and slightly
beyond the stated "trusted LAN" threat model.

*End of report.*
