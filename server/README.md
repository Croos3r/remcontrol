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

The server is advertised on the LAN over mDNS as `_remcontrol._tcp` unless you
disable it (see below).

## Flags

- `--reset-token` — rotate the pairing token; previously paired phones must
  re-pair.
- `--no-mdns` — do not advertise the service over mDNS for this run, even if
  `advertise_mdns` is true in the config. Useful on networks where multicast
  is blocked or unwanted.

## Configuration

Created on first run:

- Linux: `~/.config/remcontrol/config.toml`
- Windows: `%APPDATA%\remcontrol\config.toml`

```toml
token        = "..."            # pairing token (32 random chars)
port         = 17890           # WebSocket port
bind_addr    = "192.168.1.10"  # bind address; defaults to the LAN IP
advertise_mdns = true          # set false to disable mDNS permanently
allowed_origins = []           # WebSocket Origin allowlist (see below)
```

The config file is created with mode `0600` on Unix.

### Bind address

By default the server binds to the discovered LAN IP, so it is reachable from
the phone but not exposed on every interface. Set `bind_addr` to bind elsewhere
(for example `"127.0.0.1"` for local-only, or `"0.0.0.0"` for all interfaces).

### mDNS discovery

mDNS advertisement is on by default. Disable it for a single run with
`--no-mdns`, or permanently by setting `advertise_mdns = false` in the config.
When mDNS is off, pair by scanning the QR code or entering the IP and token
manually.

### Origin allowlist

To defend against cross-site WebSocket hijacking from a browser, the server
rejects WebSocket upgrades whose `Origin` header is not in `allowed_origins`.
Clients that send no `Origin` (the native app, curl) are always allowed. With
an empty list (the default) every browser origin is rejected. Add an origin
only if you build a web-based client:

```toml
allowed_origins = ["https://app.example"]
```

## Notes

- One phone at a time: a new connection replaces the current one.
- Held mouse buttons are released automatically when the client disconnects.
