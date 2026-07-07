# Bluetooth transport — design

Add a Bluetooth transport to remcontrol that runs alongside the existing
WebSocket/LAN transport. Both transports are always-on; the user picks per
situation. The phone can control the PC over BLE even when Wi-Fi/LAN is
unavailable (campus/enterprise client isolation, no shared network, etc.).

## Goals

- A second, always-on transport (Bluetooth) coexisting with WebSocket.
- No rework of the crypto or protocol layers — they are already
  transport-agnostic.
- A `Transport` boundary on both sides so the WS and BLE paths share
  handshake, replay, single-active-client, and rate-limit logic instead of
  duplicating it.
- Cross-platform BLE: Android app (client), Linux + Windows server
  (peripheral).
- The existing PSK token pairing flow reused over BLE; the QR carries the
  token so the primary flow is friction-free (no typing), same as on Wi-Fi.
  No OS-level Bluetooth bonding required.
- Strict in-order, exactly-once delivery today; a hook for a future
  "drop-stale-moves" policy left open.

## Non-goals (this design)

- OS-level Bluetooth bonding / pairing. The abstraction leaves room for a
  future bond gate, but no bonding is implemented.
- iOS app support (config strings added for correctness, no iOS BLE client).
- macOS server BLE support (release workflow still builds macOS; a stub keeps
  the crate compiling, WS still works on macOS).
- Classic SPP / RFCOMM. BLE GATT only.
- A "drop-stale-moves" lossy policy. Framing has the hook; implementation is
  strict-only.
- Token transfer over BLE. The token is carried by the QR (primary flow, no
  typing) or entered manually as a fallback (BLE scan with no QR). The server
  never grants the token to an unauthenticated client over BLE.

## Decisions (locked during brainstorming)

**Motivation — always-on second transport.**
Coexists with WS; user picks per situation.

**Bluetooth tech — BLE GATT.**
Windows has no usable Classic SPP server; BLE GATT works on all three targets
(Linux bluer, Windows WinRT, Android). Small MTU needs a framing layer, but
GATT preserves in-characteristic order.

**Pairing — reuse PSK token, no OS bond.**
Server-as-peripheral bonding is the worst-supported corner of every OS,
especially Windows. Token already provides the trust the audit fixed (C-1).
Abstraction leaves room for bonding later.

**UI surfacing — layout toggle in Settings.**
One pref flips BLE discovery between a section inside Discover (on) and a
separate Bluetooth tab (off). Same native surface behind both.

**Scope — full cross-platform.**
Android client + Linux and Windows server in one design; implementation plan
phases it.

**Reliability — strict in-order now, lossy later.**
`recv() -> None` / `onClose` on any gap; framing extensible for a future drop
policy.

**Architecture — Transport trait/interface, generic handler.**
Matches the existing `Injector` trait precedent; avoids the
`handshake-wire-format-test-gap` duplication bug.

**Pairing flow over BLE — QR carries the token (no typing).**
The QR already carries the token on the Wi-Fi path; the same payload gains a
`transport` field and optional BLE identity so a scan connects over BLE
friction-free. The token rides the QR exactly as on Wi-Fi, so no new security
risk. Typing the 32-char token remains only as the no-QR fallback (BLE scan).

## Architecture overview

A `Transport` boundary is introduced on both sides, between crypto/protocol
and the native I/O. Everything above the boundary is shared and
transport-agnostic; everything below is per-transport.

```
APP (phone)                                SERVER (PC)
┌─────────────────────────────┐           ┌──────────────────────────────────┐
│ UI (TrackpadScreen, etc.)   │           │ injector (enigo/xdotool)         │
├─────────────────────────────┤           ├──────────────────────────────────┤
│ Connection (events, send,   │           │ connection handler (generic over │
│  reconnect, replay state)   │           │  T: Transport) — handshake,      │
│  — generic over Transport   │           │  AEAD loop, replay, kick,        │
├─────────────────────────────┤           │  rate-limit, dispatch→injector  │
│ crypto.ts (unchanged)       │           ├──────────────────────────────────┤
│ protocol (unchanged)        │           │ crypto.rs (unchanged)            │
├───── Transport interface ───┤           │ protocol.rs (unchanged)          │
│  impl: WsTransport           │           ├────── Transport trait ────────────┤
│  impl: BleTransport (GATT)  │           │  impl: WsTransport (axum adapter) │
│      + framing/fragmentation│           │  impl: BleTransport (GATT)       │
│      + BLE scan (Android)   │           │      + framing/fragmentation      │
├─────────────────────────────┤           │      + GATT server (Linux/Win)   │
│ native: react-native-ble-*  │           │ native: bluer (Linux),           │
│         (Android)           │           │         windows crate (WinRT)    │
└─────────────────────────────┘           └──────────────────────────────────┘
```

- Two `impl Transport` per side. WebSocket becomes a thin adapter around the
  existing socket (axum `WebSocket` on the server, the existing
  `WebSocketLike` on the app). BLE becomes a GATT-backed transport plus a
  small framing layer. Native BLE code never touches crypto or protocol.
- The server runs both accept loops concurrently. `main.rs` keeps the axum TCP
  listener and spawns a second `tokio::task` running the BLE GATT server.
  Both feed the same `AppState` (already `Clone` + `Arc`-fielded), so the
  single-active-client kick logic spans transports.
- The framing layer carries the exact frames the `Transport` interface
  defines, over GATT, with length-prefix + fragmentation. Invisible to
  crypto/protocol.

## The `Transport` interface

Same shape in Rust and TypeScript; only the spelling differs.

### Rust (`server/src/transport.rs`, new)

```rust
pub enum Frame {
    Text(String),     // handshake JSON (hello/welcome), pre-AEAD
    Binary(Vec<u8>),   // AEAD frame: 12-byte nonce || ct || tag
}

#[async_trait]
pub trait Transport: Send {
    async fn send(&mut self, frame: Frame) -> Result<(), TransportError>;
    async fn recv(&mut self) -> Option<Frame>; // None => peer gone / closed
    fn peer(&self) -> TransportPeer;            // rate-limit key + logging
}

pub enum TransportError {
    Closed,
    Io(String),
    Framing(String),
}

pub enum TransportPeer {
    Ip(IpAddr),
    Ble(BleIdentity),
}
```

### TypeScript (`app/src/transport.ts`, new)

```ts
export type Frame =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: Uint8Array };

export interface Transport {
  send(frame: Frame): void;
  onMessage: ((frame: Frame) => void) | null;
  onClose: (() => void) | null;
  onError: ((message: string) => void) | null;
}
```

### Design notes

- `Frame` mirrors what crypto/protocol already produce/consume: a plaintext
  JSON `String` (handshake) or an AEAD `Vec<u8>` (sealed app frame). No
  `Close`/`Ping` variants — close is `recv() -> None` (Rust) / `onClose`
  (TS), matching how `ws.rs` already treats `socket.recv() -> None` as
  disconnect.
- No `readyState` in the TS interface. That was a WebSocket quirk leaking
  through `WebSocketLike`; `Connection` stops checking `readyState === 1`
  and instead tracks `welcomed` plus whether the transport is open (driven by
  `onClose`). Removes the race the audit flagged at L-1.
- `recv()` is a blocking async pull on the server (matches `ws.rs`'s
  `socket.recv()` loop). The app keeps the push model (`onMessage`) because
  that's how the existing `Connection.handleMessage` works and how RN BLE
  events arrive. Both reduce to "deliver whole frames in order."
- `TransportError` distinguishes "peer disconnected" (normal, fire reconnect)
  from "BLE stack exploded" (surface to user).

The WS adapter on each side becomes a thin `impl Transport` wrapping the
existing socket. `ws.rs::handle`/`authenticate`/`send_sealed`/`send_plain`
are rewritten generic over `T: Transport`, with the `Message::Binary`/
`Message::Text` matching moved into the WS adapter. The app's `Connection` is
rewritten to hold a `Transport` and call `transport.send({kind:"binary",...})`
instead of `ws.send(...)`.

## GATT service + framing protocol

The BLE transport carries the exact frames the `Transport` interface defines,
over a custom GATT service.

### Service

One custom 128-bit service UUID, assigned in this spec and pinned on both
sides (the implementation plan fixes the concrete value). Three
characteristics:

- **Write** (phone -> server): phone writes framed handshake JSON and AEAD
  binary frames here. Write-without-response for small frequent frames;
  write-with-response for the handshake where delivery confirmation matters.
- **Notify** (server -> phone): server pushes framed handshake JSON and AEAD
  binary frames here. Phone enables CCCD notifications after connect.
- **Control** (optional): a flag characteristic for clean close
  (`0x01` = disconnect intent) so the peer distinguishes "user disconnected"
  from "radio dropped." Deferrable; default treats any GATT disconnect as
  transport-close.

### Framing protocol (inside `BleTransport`, invisible to crypto/protocol)

Every fragment on the wire has the same shape:

```
[u8 kind][u8 flags][u16 big-endian fragment length L][L bytes fragment payload]
  kind   = 0x01 text (handshake JSON, UTF-8) | 0x02 binary (AEAD)
  flags  = bit 0: 1 = more fragments follow for this frame, 0 = final/only
```

A logical frame is one or more fragments. The first fragment carries the
`kind`; subsequent fragments of the same frame carry the same `kind` and
`flags & 0x01 == 1`. The receiver accumulates fragment payloads until a
fragment arrives with `flags & 0x01 == 0`, then delivers one complete
`Frame` (`Text(accumulated)` or `Binary(accumulated)`) up to the transport.
The `kind` byte is what lets the framing layer reproduce the
text-vs-binary distinction that crypto/protocol's `Frame` enum (Rust) /
`kind` discriminant (TS) requires.

- Each logical frame = one hello/welcome JSON, or one AEAD `nonce||ct||tag`.
  Handshake JSON frames are tiny and never fragment; AEAD `move` frames at
  60-120 Hz are ~30-40 bytes and usually fit in one packet. Text-entry bursts
  can exceed MTU and will fragment.
- The whole `kind|flags|length|payload` header plus payload must fit in one
  GATT write/notify, sized to the negotiated ATT MTU minus ATT overhead. If a
  frame's payload exceeds the per-fragment capacity, the sender splits it into
  N fragments, each with its own `u16` length, all but the last flagged
  "more fragments follow."
- Strict in-order, exactly-once. GATT preserves in-order delivery within a
  characteristic, so the framing layer only adds fragmentation/reassembly and
  a reassembly buffer per direction. If a fragment arrives for a different
  `kind` than the in-progress frame, or a fragment is lost (GATT reports a
  failure), the transport closes itself and signals disconnect — no
  retransmit, no reordering. Satisfies the strict in-order contract.
- MTU negotiation: on connect, both sides request ATT MTU up to a cap (512 on
  Android, 185+ on Linux/Windows) and size fragments to the negotiated value
  minus framing overhead.
- Future lossy policy: the framing layer's per-direction queue is where a
  "drop stale moves" policy hooks in. The spec defines the hook (a
  `DropPolicy` enum defaulting to `Strict`); the implementation starts
  `Strict`-only.

### BLE connection lifecycle

The phone arrives at the GATT connect with the token already in hand —
either from the scanned QR (primary flow, no typing) or entered manually
(fallback for a bare BLE scan with no QR). The token never travels over the
BLE link except inside the PSK-ECDH handshake that derives session keys.

1. Phone scans, finds the `remcontrol` service advertising, connects GATT.
2. Phone discovers characteristics, enables notifications on Notify.
3. Phone writes the `hello` JSON (framed) to Write; server reads it, runs
   `Handshake::new()`, sends `welcome` JSON (framed) via Notify.
4. Both derive `SessionKeys`. Phone sends the encrypted `{type:"hello",token:""}`
   ack (framed AEAD) to Write; server sends the encrypted `Welcome` (framed
   AEAD) via Notify.
5. Steady state: phone writes framed AEAD `ClientMessage`s; server replies
   with framed AEAD `ServerMessage`s (only `error` is expected today).
6. Close: either side stops responding, the GATT link drops, or Control sends
   disconnect intent. `recv() -> None` / `onClose` fires.

## App side (Android, BLE client)

### Native module

A BLE module exposing scan + connect + read/write/notify to JS. Candidate
libraries:

- `react-native-ble-plx` (recommended) — actively maintained, MIT, Android 12+
  permissions, exposes write/notify and MTU negotiation in JS.
- `react-native-ble-manager` — older API, more boilerplate, stable.

The implementation plan picks `react-native-ble-plx` unless it finds a
blocker. Expo dev build required (same as `react-native-zeroconf` today).

### `BleTransport` (TS, `impl Transport`)

- `connect(deviceId)`: connects GATT, discovers services, enables
  notifications, negotiates MTU, wires `onMessage` to the Notify
  characteristic's subscription.
- `send(frame)`: frames the frame, fragments to MTU, writes fragments to the
  Write characteristic (write-without-response for small frequent AEAD frames,
  write-with-response for the handshake).
- Notify handler: reassembles fragments; on a complete frame, calls
  `onMessage({kind, data})`. On GATT disconnect or framing error, calls
  `onClose` / `onError`.
- `close()`: writes disconnect-intent to Control if implemented, then closes
  GATT.

### Discovery / scan

A new `bleScan.ts` wraps the native module's scan, filtering for the
`remcontrol` service UUID, returning `{ deviceId, name, rssi }[]`. It surfaces
availability (Bluetooth off / permission denied) the way `zeroconf` surfaces
`setZeroconfAvailable(false)`.

### Permissions (via `app.json`; `android/` is generated)

- Android 12+: `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (runtime permissions).
- Android 6-11 (if supported; minSdk decided in impl plan): `BLUETOOTH`,
  `BLUETOOTH_ADMIN`, `ACCESS_FINE_LOCATION`.
- A runtime-permission flow before scan/connect.
- iOS strings (`NSBluetoothAlwaysUsageDescription`) added for config
  correctness even though iOS isn't a v1 app target.

### Connection screen UI

A layout pref (`showBluetoothInDiscover: boolean`, persisted via the existing
prefs module) toggles between:

- **On:** Discover screen renders two sections — the existing mDNS section
  and a new BLE section consuming `bleScan`. Each row tagged with transport.
- **Off:** a separate `BluetoothTab` renders the BLE scan results.

Both modes consume the same `bleScan` API and the same `BleTransport`; only
the rendering component differs.

### `ServerInfo` extension

Today `{ip, port, token, name?}`. BLE entries have no `ip`/`port`. The type
becomes a discriminated union:

```ts
type ServerInfo =
  | { transport: "ws"; ip: string; port: number; token: string; name?: string }
  | { transport: "ble"; deviceId: string; token: string; name?: string };
```

Storage helpers (`tokenKey`, `sameServer`, `serverKey` in `storage.ts`)
extend to handle the BLE variant keyed by `deviceId`. `Connection` is
constructed with the matching transport: WS path builds `WsTransport`
(wrapping the existing `WebSocketLike`), BLE path builds `BleTransport`.
The QR path produces either variant (see "QR payload" below); the bare BLE
scan path produces `transport: "ble"` with a token typed as the fallback.

### QR payload

The server's pairing payload (today `{v, ip, port, token, name}` in
`server/src/lib.rs::pairing_payload`) gains a `transport` field and an
optional BLE identity. Scanning it is the primary, friction-free flow for
both transports — the token rides the QR, no typing, exactly as on the
Wi-Fi path today. The server prints one QR; the phone picks the transport
the QR indicates:

```json
{
  "v": 1,
  "transport": "ws" | "ble",
  "ip": "192.168.1.10",     // present when transport = "ws"
  "port": 17890,            // present when transport = "ws"
  "bleName": "dorian-pc",   // present when transport = "ble"; advertised name
  "token": "...",
  "name": "dorian-pc"
}
```

The server advertises both itself over mDNS/LAN and the `remcontrol` GATT
service over BLE, and chooses which transport the QR points at based on a
config/CLI preference (default `ws`; `--qr-transport ble` for the no-LAN
case). A future single-QR-covers-both format is possible (the phone scans
once and tries the transport it can reach) but is left to the implementation
plan; v1 of this feature picks one transport per QR.

The phone's QR scan (in `ConnectScreen`'s `onBarcode` handler) already
`JSON.parse`s the payload and validates the known fields; it gains handling
for `transport` and produces the matching `ServerInfo` variant. The token
comes from the QR in both cases.

### `probe.ts`

The reachability probe currently opens a throwaway WS. It gains a BLE
variant: a cheap GATT service-presence check (scan for the device's
advertised service, no full connect) for `transport: "ble"` recent entries.

## Server side (Linux + Windows, BLE peripheral)

The PC acts as a GATT **server** (peripheral role): it advertises the
`remcontrol` service and accepts an incoming phone connection. This is the
harder direction and the main native complexity.

### Linux (`bluer` crate, async/tokio-native)

- `bluer::Adapter` — power on, set discoverable, advertise the `remcontrol`
  GATT service via `AdvertisingAdvertisement`.
- Register a `bluer::gatt::Application` with the three characteristics.
  `Write`'s `write` callback hands bytes to the framing/reassembly layer,
  which delivers whole frames up to the transport. `Notify` sends frames
  down: the transport fragments and pushes fragments via `notify_value`.
- MTU: `bluer` exposes MTU negotiation; fragment to the negotiated value.
- Platform gate: `#[cfg(target_os = "linux")]`. A
  `#[cfg(not(target_os = "linux"))]` stub compiles on Windows/macOS so the
  crate builds cross-platform.

### Windows (`windows` crate, WinRT `Windows.Devices.Bluetooth`)

- `BluetoothLEAdvertisementPublisher` — advertise the service.
- `GattServiceProvider` — register the GATT server with the three
  characteristics. `Write`'s `WriteRequested` event hands bytes to framing;
  `Notify`'s `NotifyValue` pushes frames.
- WinRT's peripheral-role GATT server is supported (unlike Classic SPP),
  which is why BLE was chosen.
- Platform gate: `#[cfg(target_os = "windows")]`.

### macOS

The release workflow builds macOS, but there's no CoreBluetooth GATT-server
code in this design. A `#[cfg(target_os = "macos")]` stub keeps the crate
building; Bluetooth on macOS is out of scope (WS still works). Documented as
unsupported.

### Connection handler (transport-agnostic)

`handle<T: Transport>(transport: T, state: AppState, peer: TransportPeer)` is
the single connection task, extracted from today's `ws.rs::handle`. It runs
`authenticate`, registers the kick channel, sends the sealed `Welcome`, and
loops on `transport.recv()` — the current logic, generic. Both the WS
adapter (from the axum upgrade) and the BLE transport call into it.

### Rate limiting

Today keyed on `IpAddr`. BLE has no IP. `TransportPeer::Ble(BleIdentity)`
carries the best available identity. BLE MACs rotate (Android privacy), so
`BleIdentity` is a best-effort key (advertising name + a session-stable
identifier if the GATT exchange exposes one). The spec acknowledges the
limitation: BLE rate-limiting is per-connection-attempt with a short window,
weaker than the WS per-IP limiter. Acceptable: the token is still required
and the connection is proximity-bound.

### `main.rs` launch

Keeps the axum TCP listener and adds a second `tokio::spawn` running the BLE
GATT server's accept loop. Both share `AppState`. Two new CLI flags (same
hand-rolled style as `--no-mdns`/`--bind-addr`):

- `--no-ble` disables BLE advertising, for environments where it's unwanted.
- `--qr-transport ws|ble` selects which transport the printed QR points at
  (default `ws`; `ble` for the no-LAN case). See "QR payload".

The server advertises itself over mDNS/LAN and the GATT service over BLE
regardless of which the QR points at; the flag only affects the QR.

## Error handling, edge cases, testing

### Error handling

- **GATT disconnect mid-frame:** reassembly buffer discarded,
  `recv() -> None` / `onClose` fires, app reconnects. No half-frames
  delivered.
- **Framing error** (bad length, truncated fragment): transport closes itself
  and signals disconnect. Never delivers a malformed frame to crypto (which
  would AEAD-fail anyway, but we fail earlier).
- **MTU too small:** negotiate up; if the peer refuses below a floor
  (e.g. 23-byte default ATT MTU leaves ~17 bytes payload after framing), the
  transport refuses to connect and surfaces an error.
- **BLE off / permission denied:** scan surfaces unavailable (matching
  `setZeroconfAvailable(false)`), UI shows the fallback message.
- **Token wrong over BLE:** identical to WS — `authenticate` fails, server
  sends a plaintext error via Notify, closes the GATT connection, app fires
  `onAuthFailure` and stops reconnecting (fixes the audit's M-5 for both
  transports).
- **Both transports connected:** single-active-client kick spans transports
  via shared `AppState`. Newest wins; the loser gets `recv() -> None`.
  ReleaseAll fires on the loser so no stuck keys.

### Edge cases

- Phone connects via BLE while WS client active — kick the WS client.
- User toggles `showBluetoothInDiscover` while scanning — stop the active
  scan, switch rendering.
- BLE entry in recents but PC off — probe fails, row marked unreachable, no
  auto-reconnect over BLE unless `autoReconnect` pref is on.
- Server restarts (new ephemeral X25519 key) — phone's stored keys are
  invalid; handshake re-runs with the same PSK token, which still works
  (token is long-lived, keys are per-session). Same as WS today.

### Testing

Per the `handshake-wire-format-test-gap` lesson — test raw bytes over the
new transport, not just struct round-trips.

- **Server unit tests:** framing/fragmentation round-trip (split a frame at
  every possible MTU boundary, reassemble, assert equality). `Transport`
  trait mocked for the connection handler, same as `Injector` is mocked
  today.
- **Server integration test:** a parallel to `tests/handshake.rs` that runs
  the full handshake + a few sealed frames over a pair of in-memory
  `Transport` impls (no real BLE radio). Pins the wire format on both sides
  of the abstraction.
- **App unit tests:** `BleTransport` against a mocked native module — feed
  fragments, assert `onMessage` fires with whole frames; feed a bad
  fragment, assert `onClose`. Extend `connection.test.ts` to run the
  handshake over a fake `Transport` (replacing the fake socket), proving
  the refactor doesn't change behavior.
- **Cross-platform wire test:** a small Rust test that produces a sealed
  frame and asserts the byte layout matches what `crypto.ts` produces,
  against a known vector. Makes the existing implicit crypto parity
  explicit for the framed transport.
- **Manual:** real Android-phone-to-Linux-PC and to-Windows-PC smoke tests;
  gestures + keyboard over BLE. mDNS campus-isolation scenarios now have a
  working path.

## Open items (resolved by the implementation plan)

- Concrete 128-bit service / characteristic UUIDs.
- minSdk decision (Android 6-11 BLE support vs. 12+ only).
- `react-native-ble-plx` vs `react-native-ble-manager` (pl recommended).
- Whether the Control characteristic ships in phase 1 or is deferred.
- Implementation phasing (e.g. abstraction + WS refactor first, then Linux
  BLE, then Windows BLE, then UI).
