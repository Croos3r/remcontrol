# remcontrol — design

Control a PC's mouse and keyboard from a phone. Two applications in one monorepo:

- `server/` — Rust WebSocket server running on the PC (Linux/X11 and Windows)
- `app/` — Expo React Native app (TypeScript), Android first

## Goals

- Phone acts as a trackpad for the PC pointer, with tap/scroll/drag gestures.
- Phone soft keyboard types on the PC, plus special keys (Esc, Tab, Enter, arrows).
- Connecting is low friction: QR scan, mDNS discovery, or manual IP, and both
  sides remember the last pairing so reconnects are automatic.
- LAN only, protected by a pairing token.

## Non-goals (v1)

- iOS builds (Expo keeps the door open, not verified in v1)
- TLS / use over untrusted networks
- Multiple simultaneous clients
- macOS server support
- Screen streaming, file transfer, media keys

## Protocol

JSON messages over a WebSocket at `ws://<ip>:<port>/ws`.

Rationale: on a LAN, mouse-move traffic at 60-120 Hz is tiny in any encoding.
JSON is natively handled on both sides and trivially debuggable. Binary
encodings (msgpack) and WebRTC data channels were considered and rejected as
complexity without perceivable latency gain locally.

Client → server:

| Message | Fields | Meaning |
|---|---|---|
| `hello` | `token: string` | Must be the first message. Server closes the socket on a bad token. |
| `move` | `dx, dy: number` | Relative pointer motion (client applies sensitivity before sending). |
| `click` | `button: "left"\|"right"\|"middle"` | Press + release. |
| `button` | `button, action: "down"\|"up"` | Held button, used for drag. |
| `scroll` | `dx, dy: number` | Scroll ticks. |
| `text` | `value: string` | Characters to type, sent as the user types. |
| `key` | `key: string` | Special key: `backspace`, `enter`, `esc`, `tab`, `up`, `down`, `left`, `right`, `delete`. |

Server → client: `{type:"welcome"}` on successful hello, `{type:"error", message}` before closing on failure. Nothing else.

Connection policy: one active client; a new authenticated client replaces the
previous one (newest wins). Invalid JSON or unknown message types are logged
and ignored. On disconnect the server releases any held buttons.

## Rust server

Crates:

- `axum` + `tokio` — HTTP server with the `/ws` WebSocket endpoint
- `enigo` — input injection; SendInput on Windows, XTest on Linux/X11
- `mdns-sd` — advertise `_remcontrol._tcp.local.` with the port and instance name
- `qr2term` — print a QR code in the terminal at startup
- `dirs`, `serde`, `toml`, `rand` — config and token handling

Behavior:

- On first run, generate a random pairing token and persist it with the port in
  the config file: `~/.config/remcontrol/config.toml` on Linux,
  `%APPDATA%\remcontrol\config.toml` on Windows (via `dirs::config_dir()`).
- On every start, print the LAN IP, port, and a QR code encoding
  `{"ip", "port", "token"}` as JSON.
- `--reset-token` flag rotates the token.
- Input injection sits behind an `Injector` trait implemented with enigo, so
  message dispatch is unit-testable with a mock.

Platform notes:

- Linux: X11 targeted (user's session). enigo/XTest works out of the box.
- Windows: no special permissions; first run triggers the Windows Firewall
  prompt, which must be accepted (documented in README).

## Expo app

Expo (TypeScript) with a dev build (`expo run:android` / EAS). Expo Go is not
sufficient because `react-native-zeroconf` is a native module; QR and manual IP
would work in Expo Go, mDNS discovery would not.

Libraries: `react-native-gesture-handler`, `expo-camera` (QR scan),
`react-native-zeroconf` (mDNS), `@react-native-async-storage/async-storage`.

### Connect screen

Three entry paths:

1. Scan QR — parses `{ip, port, token}` and connects.
2. Discovered servers — live list from mDNS; selecting one prompts for the
   token unless one is already stored for that server.
3. Manual — IP, port, token fields.

On successful connect, `{ip, port, token}` is saved to AsyncStorage. On app
launch, the app tries the stored connection automatically (short timeout) and
goes straight to the trackpad on success; on failure it falls back to the
connect screen without clearing the stored entry.

### Trackpad screen

Full-screen gesture surface (`react-native-gesture-handler`):

- 1-finger pan → `move` (with sensitivity multiplier, adjustable in a small settings sheet)
- tap → left `click`
- 2-finger tap → right `click`
- 2-finger pan → `scroll`
- double-tap-and-hold → drag (`button down`, moves, `button up` on release)

Bottom toolbar:

- Keyboard toggle button — focuses a hidden `TextInput` to open the soft
  keyboard (a trackpad surface has no real input to tap, so the manual button
  is the mechanism). Typed characters send `text`, backspace/enter send `key`.
- Special keys: Esc, Tab, Enter, arrow keys.
- Disconnect button, connection status dot.

Socket drops show a reconnect banner and the app retries automatically with
backoff; a failed reconnect returns to the connect screen.

## Testing

- Rust: unit tests for message parsing and dispatch against a mock `Injector`;
  integration test for the hello/token handshake over a real WebSocket.
- App: TypeScript strict; manual end-to-end verification of gestures and
  keyboard (gesture semantics are not meaningfully unit-testable).
- Cross-platform: manual smoke test of the server on Windows (build + control).
