# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

remcontrol turns a phone into a trackpad/keyboard for a PC. Two independent
projects in one repo, talking over a custom encrypted WebSocket protocol:

- `server/` — Rust WebSocket server (Linux/X11, Windows) that injects mouse/keyboard
  input. See `server/CLAUDE.md`.
- `app/` — Expo React Native app (TypeScript, Android). See `app/CLAUDE.md`.

Each side has its own CLAUDE.md with build/test/lint commands and architecture
notes; read those before working inside `app/` or `server/`.

## Wire protocol (spans both sides)

The client and server must agree on the handshake and message shapes. If you
change one side's `crypto`/`protocol` module, check the other:

- App: `app/src/crypto.ts`, `app/src/connection.ts`
- Server: `server/src/crypto.rs`, `server/src/protocol.rs`, `server/src/ws.rs`
- Server integration test against real wire bytes: `server/tests/handshake.rs`

Handshake: PSK-ECDH. Client and server derive ChaCha20-Poly1305 session keys
from the pairing token plus an ephemeral X25519 exchange. After the encrypted
`welcome`, all frames are binary and counter-tagged (replay protection) — the
JS side tracks `sendCounter`/`recvLast`, the Rust side has matching logic in
`ws.rs`. `ClientMessage`/`ServerMessage` in `protocol.rs` are `#[serde(tag =
"type", rename_all = "lowercase")]`; any new message type must be added on
both sides with matching field names, or the two ends silently stop
understanding each other (see `handshake-wire-format-test-gap` class of bug —
prefer testing raw JSON/bytes over the wire, not just struct round-trips).

## CI

`.github/workflows/ci.yml` runs two independent jobs, `server` and `app`, each
scoped to its own directory (`working-directory`). Mirror those exact
commands locally before pushing — see the per-directory CLAUDE.md files.

## Releases

Pushing a `v*` tag triggers `.github/workflows/release.yml`: builds server
binaries for Linux/macOS(Intel+ARM)/Windows and the Android APK, then drafts
a GitHub Release (not auto-published — review and publish manually).

## Specs

Design specs live under `docs/superpowers/specs/`. When writing or reviewing
one, follow the `spec-formatting` skill: prefer definition lists over tables
when any cell holds a paragraph, align table pipes when you do use a table,
and keep type signatures / wire formats / payloads in fenced code blocks.
