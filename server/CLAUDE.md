# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
cargo run --release              # start the server; prints address, token, QR code
cargo run --release -- --reset-token
cargo run --release -- --no-mdns
cargo run --release -- --bind-addr 192.168.1.10

cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo build --release
cargo test                       # unit tests + tests/handshake.rs
cargo test select_lan_ipv4       # run tests matching a name
cargo test --test handshake      # just the wire-format integration test
```

CI (`.github/workflows/ci.yml`) runs, in order: `cargo fmt --check`, `cargo
clippy --all-targets -- -D warnings`, `cargo build --release`, `cargo test`,
`cargo audit --deny warnings`. Match this before pushing.

Linux build requires `libxdo-dev` (Debian/Ubuntu) / `xdotool`+`libxdo` (Arch);
running needs an X11 session and `xdotool` at runtime for text entry. Windows
needs no extra setup but prompts for a firewall exception on first run.

## Architecture

- `main.rs` — CLI flags, config load/create, LAN IP pick, mDNS advertise, QR
  print, axum server startup.
- `config.rs` — `~/.config/remcontrol/config.toml` (Linux) /
  `%APPDATA%\remcontrol\config.toml` (Windows), created mode `0600` on first
  run: `token`, `port`, `bind_addr`, `advertise_mdns`, `allowed_origins`.
- `crypto.rs` — PSK-ECDH handshake and the AEAD frame format shared with
  `app/src/crypto.ts`. Wire format for every encrypted frame in both
  directions: `[12-byte big-endian counter nonce][ChaCha20-Poly1305
  ciphertext+tag]`. The token is hashed into a PSK (`psk_from_token`) and
  combined with an ephemeral X25519 exchange via HKDF to derive independent
  send/receive keys; the token itself never touches the wire. A receive
  counter strictly older than the last accepted one is rejected (replay
  protection) — see `RecvCounter` and its use in `ws.rs`.
- `protocol.rs` — `ClientMessage`/`ServerMessage` enums,
  `#[serde(tag = "type", rename_all = "lowercase")]`. This is the app-level
  JSON carried inside the encrypted frames. Adding a message type means
  updating both this file and `app/src/connection.ts` — mismatched
  discriminators fail silently on one side (JSON parse succeeds, `match`
  just never hits the new variant), so prefer a wire-level test
  (`tests/handshake.rs`-style, raw bytes) over a struct round-trip test.
- `ws.rs` — the axum `/ws` route: `origin_allowed` (Origin header allowlist,
  with a self-origin exception because React Native sets `Origin` to the
  server's own address, not a browser context), `authenticate` (rate-limited
  handshake with exponential backoff per IP via `RateLimiter`, encrypted-ack
  verification), then the main receive loop that decrypts, validates
  (`MAX_TEXT_LEN`, `MAX_MESSAGE_SIZE`/`MAX_FRAME_SIZE`), and forwards
  `ClientMessage`s to the injector task via an mpsc channel with backpressure
  (`try_send` drops the connection rather than growing an unbounded queue).
  Only one active connection at a time: a new one replaces the old via a
  `oneshot` kick channel.
- `injector.rs` — receives `Command`s off the channel and calls `enigo` to
  move the mouse / send clicks / type text/keys. `Command::ReleaseAll` runs
  on disconnect so a client that drops mid-drag doesn't leave a mouse button
  stuck down.

## Testing notes

`tests/handshake.rs` drives the server over a real WebSocket
(`tokio-tungstenite`) and asserts on raw wire bytes, not just Rust struct
serialization — this is the only thing that would have caught a past
client/server `type`-discriminator mismatch, since both sides independently
"round-tripped" their own structs successfully while disagreeing with each
other. Keep new protocol tests at this level rather than only unit-testing
serde structs.
