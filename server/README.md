# remcontrol server

WebSocket server that receives trackpad and keyboard events from the remcontrol
mobile app and injects them as mouse/keyboard input on this machine.

## Requirements

- **Linux**: an X11 session (`echo $XDG_SESSION_TYPE` should print `x11`).
  Building needs `libxdo-dev` on Debian/Ubuntu (`xdotool`/`libxdo` on Arch).
- **Windows**: no special requirements. On first run, Windows Firewall asks to
  allow the app on private networks: accept it, otherwise the phone cannot
  connect.

## Run

```sh
cargo run --release
```

On startup the server prints its address, the pairing token, and a QR code.
Scan the QR code with the remcontrol app, pick the server from the discovered
list, or type the IP/port/token manually.

The server is also advertised on the LAN over mDNS as `_remcontrol._tcp`.

## Configuration

Created on first run:

- Linux: `~/.config/remcontrol/config.toml`
- Windows: `%APPDATA%\remcontrol\config.toml`

Contains the pairing `token` and the `port` (default `17890`).

Rotate the pairing token (previously paired phones must re-pair):

```sh
cargo run --release -- --reset-token
```

## Notes

- One phone at a time: a new connection replaces the current one.
- Held mouse buttons are released automatically when the client disconnects.
