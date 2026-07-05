# remcontrol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phone-as-trackpad: an Expo React Native app controls the PC mouse/keyboard through a Rust WebSocket server.

**Architecture:** JSON messages over a WebSocket. The Rust server parses messages into commands and forwards them over a channel to a dedicated injector thread owning `enigo`. The app is two screens (Connect, Trackpad) around a small WebSocket client wrapper.

**Tech Stack:** Rust (axum, tokio, enigo, mdns-sd, qr2term), Expo/React Native TypeScript (react-native-gesture-handler, expo-camera, react-native-zeroconf, AsyncStorage).

## Global Constraints

- Server targets Linux/X11 and Windows. No platform-specific code outside what enigo/dirs abstract; document the Windows Firewall prompt in the README.
- Protocol messages exactly as in the spec (`hello`, `move`, `click`, `button`, `scroll`, `text`, `key`; server sends only `welcome` / `error`).
- One active client; a new authenticated client replaces the previous one.
- Config in `dirs::config_dir()/remcontrol/config.toml`; default port 17890.
- App is Expo + TypeScript strict; needs a dev build (not Expo Go) because of `react-native-zeroconf`.
- Commit messages use conventional format.
- Spec: `docs/superpowers/specs/2026-07-05-remcontrol-design.md`.

---

### Task 1: Server scaffold + config module

**Files:**
- Create: `server/Cargo.toml`, `server/src/main.rs` (stub), `server/src/config.rs`
- Test: unit tests inside `server/src/config.rs`

**Interfaces:**
- Produces: `config::Config { token: String, port: u16 }`, `Config::load_or_create(path: &Path) -> anyhow::Result<Config>`, `Config::reset_token(path: &Path) -> anyhow::Result<Config>`, `config::default_path() -> PathBuf`

- [ ] **Step 1: Scaffold crate**

```bash
cd /home/dorian/Projects/remcontrol && cargo new server --name remcontrol-server
```

`server/Cargo.toml`:

```toml
[package]
name = "remcontrol-server"
version = "0.1.0"
edition = "2021"

[dependencies]
anyhow = "1"
axum = { version = "0.8", features = ["ws"] }
dirs = "6"
enigo = "0.6"
local-ip-address = "0.6"
mdns-sd = "0.13"
qr2term = "0.3"
rand = "0.9"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
toml = "0.8"
tracing = "0.1"
tracing-subscriber = "0.3"

[dev-dependencies]
tokio-tungstenite = "0.26"
futures-util = "0.3"
```

- [ ] **Step 2: Write failing tests for config**

In `server/src/config.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_config_with_token_on_first_load() {
        let dir = std::env::temp_dir().join(format!("remcontrol-test-{}", std::process::id()));
        let path = dir.join("config.toml");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = Config::load_or_create(&path).unwrap();
        assert_eq!(cfg.port, 17890);
        assert_eq!(cfg.token.len(), 32);
        let again = Config::load_or_create(&path).unwrap();
        assert_eq!(cfg.token, again.token);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reset_token_changes_token() {
        let dir = std::env::temp_dir().join(format!("remcontrol-test-reset-{}", std::process::id()));
        let path = dir.join("config.toml");
        let _ = std::fs::remove_dir_all(&dir);
        let cfg = Config::load_or_create(&path).unwrap();
        let reset = Config::reset_token(&path).unwrap();
        assert_ne!(cfg.token, reset.token);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
```

- [ ] **Step 3: Run tests, verify they fail to compile** (`cargo test` in `server/` — expected: `Config` not found)

- [ ] **Step 4: Implement config**

```rust
use anyhow::Context;
use rand::distr::{Alphanumeric, SampleString};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_PORT: u16 = 17890;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub token: String,
    pub port: u16,
}

pub fn default_path() -> PathBuf {
    dirs::config_dir()
        .expect("no config directory on this platform")
        .join("remcontrol")
        .join("config.toml")
}

impl Config {
    pub fn load_or_create(path: &Path) -> anyhow::Result<Config> {
        if path.exists() {
            let raw = std::fs::read_to_string(path)?;
            return toml::from_str(&raw).context("invalid config file");
        }
        let cfg = Config { token: new_token(), port: DEFAULT_PORT };
        cfg.save(path)?;
        Ok(cfg)
    }

    pub fn reset_token(path: &Path) -> anyhow::Result<Config> {
        let mut cfg = Config::load_or_create(path)?;
        cfg.token = new_token();
        cfg.save(path)?;
        Ok(cfg)
    }

    fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, toml::to_string_pretty(self)?)?;
        Ok(())
    }
}

fn new_token() -> String {
    Alphanumeric.sample_string(&mut rand::rng(), 32)
}
```

Add `mod config;` to `main.rs` (leave `main` as the default hello-world for now).

- [ ] **Step 5: `cargo test` passes; commit** (`feat: scaffold server with persisted config and pairing token`)

---

### Task 2: Protocol types

**Files:**
- Create: `server/src/protocol.rs` (tests inline)

**Interfaces:**
- Produces:

```rust
pub enum MouseButton { Left, Right, Middle }
pub enum ButtonAction { Down, Up }
pub enum SpecialKey { Backspace, Enter, Esc, Tab, Up, Down, Left, Right, Delete }
pub enum ClientMessage {
    Hello { token: String },
    Move { dx: f64, dy: f64 },
    Click { button: MouseButton },
    Button { button: MouseButton, action: ButtonAction },
    Scroll { dx: f64, dy: f64 },
    Text { value: String },
    Key { key: SpecialKey },
}
pub enum ServerMessage { Welcome, Error { message: String } }
```

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_message_types() {
        let cases = [
            (r#"{"type":"hello","token":"abc"}"#, ClientMessage::Hello { token: "abc".into() }),
            (r#"{"type":"move","dx":1.5,"dy":-2.0}"#, ClientMessage::Move { dx: 1.5, dy: -2.0 }),
            (r#"{"type":"click","button":"right"}"#, ClientMessage::Click { button: MouseButton::Right }),
            (r#"{"type":"button","button":"left","action":"down"}"#, ClientMessage::Button { button: MouseButton::Left, action: ButtonAction::Down }),
            (r#"{"type":"scroll","dx":0,"dy":3}"#, ClientMessage::Scroll { dx: 0.0, dy: 3.0 }),
            (r#"{"type":"text","value":"hi"}"#, ClientMessage::Text { value: "hi".into() }),
            (r#"{"type":"key","key":"backspace"}"#, ClientMessage::Key { key: SpecialKey::Backspace }),
        ];
        for (json, expected) in cases {
            assert_eq!(serde_json::from_str::<ClientMessage>(json).unwrap(), expected);
        }
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"nope"}"#).is_err());
    }

    #[test]
    fn serializes_server_messages() {
        assert_eq!(serde_json::to_string(&ServerMessage::Welcome).unwrap(), r#"{"type":"welcome"}"#);
        assert_eq!(
            serde_json::to_string(&ServerMessage::Error { message: "bad token".into() }).unwrap(),
            r#"{"type":"error","message":"bad token"}"#
        );
    }
}
```

- [ ] **Step 2: Run, verify compile failure**

- [ ] **Step 3: Implement**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton { Left, Right, Middle }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonAction { Down, Up }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecialKey { Backspace, Enter, Esc, Tab, Up, Down, Left, Right, Delete }

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMessage {
    Hello { token: String },
    Move { dx: f64, dy: f64 },
    Click { button: MouseButton },
    Button { button: MouseButton, action: ButtonAction },
    Scroll { dx: f64, dy: f64 },
    Text { value: String },
    Key { key: SpecialKey },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMessage {
    Welcome,
    Error { message: String },
}
```

Add `mod protocol;` to `main.rs`.

- [ ] **Step 4: `cargo test` passes; commit** (`feat: add wire protocol types`)

---

### Task 3: Injector thread

**Files:**
- Create: `server/src/injector.rs`

**Interfaces:**
- Consumes: `protocol::{ClientMessage, MouseButton, ButtonAction, SpecialKey}`
- Produces:

```rust
pub enum Command { Input(ClientMessage), ReleaseAll }
pub trait Injector: Send + 'static {
    fn move_rel(&mut self, dx: i32, dy: i32);
    fn button(&mut self, button: MouseButton, action: ButtonAction);
    fn click(&mut self, button: MouseButton);
    fn scroll(&mut self, dx: i32, dy: i32);
    fn text(&mut self, value: &str);
    fn key(&mut self, key: SpecialKey);
}
pub fn spawn<I: Injector>(injector: I) -> tokio::sync::mpsc::UnboundedSender<Command>
pub fn spawn_enigo() -> anyhow::Result<tokio::sync::mpsc::UnboundedSender<Command>>
```

The thread tracks held buttons: `Button{action:Down}` inserts into a set, `Up` removes, `ReleaseAll` sends `Up` for every held button (sent by the ws layer on disconnect). Fractional `dx/dy` accumulate a remainder so slow trackpad movements are not truncated to zero.

- [ ] **Step 1: Write failing tests** with a mock injector recording calls into an `Arc<Mutex<Vec<String>>>`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl Injector for Recorder {
        fn move_rel(&mut self, dx: i32, dy: i32) { self.0.lock().unwrap().push(format!("move {dx} {dy}")); }
        fn button(&mut self, b: MouseButton, a: ButtonAction) { self.0.lock().unwrap().push(format!("button {b:?} {a:?}")); }
        fn click(&mut self, b: MouseButton) { self.0.lock().unwrap().push(format!("click {b:?}")); }
        fn scroll(&mut self, dx: i32, dy: i32) { self.0.lock().unwrap().push(format!("scroll {dx} {dy}")); }
        fn text(&mut self, v: &str) { self.0.lock().unwrap().push(format!("text {v}")); }
        fn key(&mut self, k: SpecialKey) { self.0.lock().unwrap().push(format!("key {k:?}")); }
    }

    fn drain(rec: &Recorder, tx: &tokio::sync::mpsc::UnboundedSender<Command>) -> Vec<String> {
        drop(tx.clone());
        std::thread::sleep(std::time::Duration::from_millis(50));
        rec.0.lock().unwrap().clone()
    }

    #[test]
    fn dispatches_input_commands() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.send(Command::Input(ClientMessage::Move { dx: 3.0, dy: -2.0 })).unwrap();
        tx.send(Command::Input(ClientMessage::Click { button: MouseButton::Left })).unwrap();
        tx.send(Command::Input(ClientMessage::Text { value: "hi".into() })).unwrap();
        let calls = drain(&rec, &tx);
        assert_eq!(calls, vec!["move 3 -2", "click Left", "text hi"]);
    }

    #[test]
    fn accumulates_fractional_moves() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        for _ in 0..4 { tx.send(Command::Input(ClientMessage::Move { dx: 0.5, dy: 0.0 })).unwrap(); }
        let calls = drain(&rec, &tx);
        // 0.5 accumulates: emits move 1 0 on the 2nd and 4th message
        assert_eq!(calls.iter().filter(|c| *c == &"move 1 0".to_string()).count(), 2);
    }

    #[test]
    fn release_all_releases_held_buttons() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.send(Command::Input(ClientMessage::Button { button: MouseButton::Left, action: ButtonAction::Down })).unwrap();
        tx.send(Command::ReleaseAll).unwrap();
        let calls = drain(&rec, &tx);
        assert_eq!(calls, vec!["button Left Down", "button Left Up"]);
    }
}
```

(Hello messages reaching the injector are ignored — assert nothing is recorded for them inside `dispatches_input_commands` if convenient.)

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement**

```rust
use crate::protocol::{ButtonAction, ClientMessage, MouseButton, SpecialKey};
use std::collections::HashSet;
use tokio::sync::mpsc;

pub enum Command {
    Input(ClientMessage),
    ReleaseAll,
}

pub trait Injector: Send + 'static {
    fn move_rel(&mut self, dx: i32, dy: i32);
    fn button(&mut self, button: MouseButton, action: ButtonAction);
    fn click(&mut self, button: MouseButton);
    fn scroll(&mut self, dx: i32, dy: i32);
    fn text(&mut self, value: &str);
    fn key(&mut self, key: SpecialKey);
}

pub fn spawn<I: Injector>(mut injector: I) -> mpsc::UnboundedSender<Command> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
    std::thread::spawn(move || {
        let mut held: HashSet<MouseButton> = HashSet::new();
        let (mut rem_x, mut rem_y) = (0.0_f64, 0.0_f64);
        let (mut scroll_rem_x, mut scroll_rem_y) = (0.0_f64, 0.0_f64);
        while let Some(cmd) = rx.blocking_recv() {
            match cmd {
                Command::Input(msg) => match msg {
                    ClientMessage::Move { dx, dy } => {
                        rem_x += dx;
                        rem_y += dy;
                        let (ix, iy) = (rem_x.trunc() as i32, rem_y.trunc() as i32);
                        if ix != 0 || iy != 0 {
                            rem_x -= ix as f64;
                            rem_y -= iy as f64;
                            injector.move_rel(ix, iy);
                        }
                    }
                    ClientMessage::Click { button } => injector.click(button),
                    ClientMessage::Button { button, action } => {
                        match action {
                            ButtonAction::Down => { held.insert(button); }
                            ButtonAction::Up => { held.remove(&button); }
                        }
                        injector.button(button, action);
                    }
                    ClientMessage::Scroll { dx, dy } => {
                        scroll_rem_x += dx;
                        scroll_rem_y += dy;
                        let (ix, iy) = (scroll_rem_x.trunc() as i32, scroll_rem_y.trunc() as i32);
                        if ix != 0 || iy != 0 {
                            scroll_rem_x -= ix as f64;
                            scroll_rem_y -= iy as f64;
                            injector.scroll(ix, iy);
                        }
                    }
                    ClientMessage::Text { value } => injector.text(&value),
                    ClientMessage::Key { key } => injector.key(key),
                    ClientMessage::Hello { .. } => {}
                },
                Command::ReleaseAll => {
                    for button in held.drain() {
                        injector.button(button, ButtonAction::Up);
                    }
                }
            }
        }
    });
    tx
}
```

`MouseButton` needs `Hash` — add `Hash` to its derive list in `protocol.rs`.

Enigo implementation (same file):

```rust
pub struct EnigoInjector(enigo::Enigo);

pub fn spawn_enigo() -> anyhow::Result<mpsc::UnboundedSender<Command>> {
    let enigo = enigo::Enigo::new(&enigo::Settings::default())?;
    Ok(spawn(EnigoInjector(enigo)))
}

impl Injector for EnigoInjector {
    fn move_rel(&mut self, dx: i32, dy: i32) {
        use enigo::Mouse;
        let _ = self.0.move_mouse(dx, dy, enigo::Coordinate::Rel);
    }
    fn button(&mut self, button: MouseButton, action: ButtonAction) {
        use enigo::Mouse;
        let dir = match action { ButtonAction::Down => enigo::Direction::Press, ButtonAction::Up => enigo::Direction::Release };
        let _ = self.0.button(map_button(button), dir);
    }
    fn click(&mut self, button: MouseButton) {
        use enigo::Mouse;
        let _ = self.0.button(map_button(button), enigo::Direction::Click);
    }
    fn scroll(&mut self, dx: i32, dy: i32) {
        use enigo::Mouse;
        if dx != 0 { let _ = self.0.scroll(dx, enigo::Axis::Horizontal); }
        if dy != 0 { let _ = self.0.scroll(dy, enigo::Axis::Vertical); }
    }
    fn text(&mut self, value: &str) {
        use enigo::Keyboard;
        let _ = self.0.text(value);
    }
    fn key(&mut self, key: SpecialKey) {
        use enigo::Keyboard;
        let k = match key {
            SpecialKey::Backspace => enigo::Key::Backspace,
            SpecialKey::Enter => enigo::Key::Return,
            SpecialKey::Esc => enigo::Key::Escape,
            SpecialKey::Tab => enigo::Key::Tab,
            SpecialKey::Up => enigo::Key::UpArrow,
            SpecialKey::Down => enigo::Key::DownArrow,
            SpecialKey::Left => enigo::Key::LeftArrow,
            SpecialKey::Right => enigo::Key::RightArrow,
            SpecialKey::Delete => enigo::Key::Delete,
        };
        let _ = self.0.key(k, enigo::Direction::Click);
    }
}

fn map_button(b: MouseButton) -> enigo::Button {
    match b {
        MouseButton::Left => enigo::Button::Left,
        MouseButton::Right => enigo::Button::Right,
        MouseButton::Middle => enigo::Button::Middle,
    }
}
```

Add `mod injector;` to `main.rs`. If `enigo::Enigo` is not `Send`, construct it inside the spawned thread instead (adjust `spawn_enigo` to pass a constructor closure); verify with `cargo build` and adapt.

- [ ] **Step 4: `cargo test` passes; commit** (`feat: add injector thread with enigo backend`)

---

### Task 4: WebSocket handler with token handshake and newest-wins

**Files:**
- Create: `server/src/ws.rs`
- Test: `server/tests/handshake.rs`

**Interfaces:**
- Consumes: `injector::Command`, `protocol::*`
- Produces:

```rust
pub struct AppState {
    pub token: String,
    pub commands: tokio::sync::mpsc::UnboundedSender<Command>,
    pub active: std::sync::Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
}
pub fn router(state: AppState) -> axum::Router
```

`AppState` derives/impls `Clone` (wrap in `Arc` or make fields cheap to clone).

Handler logic:
1. Upgrade, wait (10 s timeout) for the first text message; it must parse to `Hello` with the right token, else send `{"type":"error",...}` and close.
2. On success: take `active` lock, fire the stored oneshot (kicks previous client), store a new one, send `welcome`.
3. Loop with `tokio::select!` over the socket and the kick receiver. Socket messages that parse to `ClientMessage` (except `hello`) are forwarded as `Command::Input`. Invalid JSON is logged with `tracing::warn!` and ignored.
4. On exit (disconnect or kick): send `Command::ReleaseAll`.

- [ ] **Step 1: Write failing integration test** `server/tests/handshake.rs`:

```rust
use futures_util::{SinkExt, StreamExt};
use remcontrol_server::injector::Command;
use remcontrol_server::ws::{router, AppState};
use tokio_tungstenite::tungstenite::Message;

async fn start_server(token: &str) -> (String, tokio::sync::mpsc::UnboundedReceiver<Command>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let state = AppState::new(token.to_string(), tx);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(axum::serve(listener, router(state)).into_future());
    (format!("ws://{addr}/ws"), rx)
}

#[tokio::test]
async fn wrong_token_gets_error_and_close() {
    let (url, _rx) = start_server("secret").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws.send(Message::text(r#"{"type":"hello","token":"wrong"}"#)).await.unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert!(reply.to_text().unwrap().contains("error"));
    assert!(matches!(ws.next().await, Some(Ok(Message::Close(_))) | None));
}

#[tokio::test]
async fn good_token_gets_welcome_and_commands_flow() {
    let (url, mut rx) = start_server("secret").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws.send(Message::text(r#"{"type":"hello","token":"secret"}"#)).await.unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert_eq!(reply.to_text().unwrap(), r#"{"type":"welcome"}"#);
    ws.send(Message::text(r#"{"type":"move","dx":1,"dy":2}"#)).await.unwrap();
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::Input(_)));
}

#[tokio::test]
async fn new_client_replaces_previous() {
    let (url, mut rx) = start_server("secret").await;
    let (mut ws1, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws1.send(Message::text(r#"{"type":"hello","token":"secret"}"#)).await.unwrap();
    ws1.next().await.unwrap().unwrap();
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws2.send(Message::text(r#"{"type":"hello","token":"secret"}"#)).await.unwrap();
    ws2.next().await.unwrap().unwrap();
    // ws1 gets closed (kicked); its disconnect triggers ReleaseAll
    assert!(matches!(ws1.next().await, Some(Ok(Message::Close(_))) | None));
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::ReleaseAll));
}
```

Requires a lib target: create `server/src/lib.rs` with `pub mod config; pub mod injector; pub mod protocol; pub mod ws;` and make `main.rs` use `remcontrol_server::...` instead of local mods. Give `AppState` a `new(token, commands)` constructor.

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** `server/src/ws.rs`:

```rust
use crate::injector::Command;
use crate::protocol::{ClientMessage, ServerMessage};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Clone)]
pub struct AppState {
    token: String,
    commands: mpsc::UnboundedSender<Command>,
    active: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl AppState {
    pub fn new(token: String, commands: mpsc::UnboundedSender<Command>) -> Self {
        Self { token, commands, active: Arc::new(Mutex::new(None)) }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new().route("/ws", any(upgrade)).with_state(state)
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, state))
}

async fn handle(mut socket: WebSocket, state: AppState) {
    match authenticate(&mut socket, &state.token).await {
        Ok(()) => {}
        Err(message) => {
            let err = ServerMessage::Error { message };
            let _ = socket.send(Message::text(serde_json::to_string(&err).unwrap())).await;
            let _ = socket.close().await;
            return;
        }
    }

    let (kick_tx, mut kick_rx) = oneshot::channel();
    if let Some(previous) = state.active.lock().await.replace(kick_tx) {
        let _ = previous.send(());
    }

    let welcome = serde_json::to_string(&ServerMessage::Welcome).unwrap();
    if socket.send(Message::text(welcome)).await.is_err() {
        let _ = state.commands.send(Command::ReleaseAll);
        return;
    }
    tracing::info!("client connected");

    loop {
        tokio::select! {
            _ = &mut kick_rx => {
                tracing::info!("client replaced by a new connection");
                let _ = socket.close().await;
                break;
            }
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                let Message::Text(text) = msg else { continue };
                match serde_json::from_str::<ClientMessage>(&text) {
                    Ok(ClientMessage::Hello { .. }) => {}
                    Ok(input) => { let _ = state.commands.send(Command::Input(input)); }
                    Err(err) => tracing::warn!(%err, "ignoring invalid message"),
                }
            }
        }
    }

    let _ = state.commands.send(Command::ReleaseAll);
    tracing::info!("client disconnected");
}

async fn authenticate(socket: &mut WebSocket, token: &str) -> Result<(), String> {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| "handshake timeout".to_string())?
        .ok_or("connection closed")?
        .map_err(|_| "connection error".to_string())?;
    let Message::Text(text) = first else { return Err("expected hello".into()) };
    match serde_json::from_str::<ClientMessage>(&text) {
        Ok(ClientMessage::Hello { token: t }) if t == token => Ok(()),
        Ok(ClientMessage::Hello { .. }) => Err("bad token".into()),
        _ => Err("expected hello".into()),
    }
}
```

- [ ] **Step 4: `cargo test` passes (unit + integration); commit** (`feat: add websocket handler with token handshake`)

---

### Task 5: main.rs — QR, mDNS, serve

**Files:**
- Modify: `server/src/main.rs`
- Create: `server/README.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Implement main** (no unit test — thin wiring; verified by running):

```rust
use remcontrol_server::{config, injector, ws};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "info".into()),
    ).init();

    let config_path = config::default_path();
    let cfg = if std::env::args().any(|a| a == "--reset-token") {
        let cfg = config::Config::reset_token(&config_path)?;
        println!("Token reset.");
        cfg
    } else {
        config::Config::load_or_create(&config_path)?
    };

    let ip = local_ip_address::local_ip()?;
    let payload = serde_json::json!({ "ip": ip.to_string(), "port": cfg.port, "token": cfg.token }).to_string();

    println!("remcontrol server");
    println!("  address : ws://{ip}:{}/ws", cfg.port);
    println!("  token   : {}", cfg.token);
    println!("  config  : {}", config_path.display());
    println!("\nScan with the remcontrol app:\n");
    qr2term::print_qr(&payload)?;

    let mdns = mdns_sd::ServiceDaemon::new()?;
    let service = mdns_sd::ServiceInfo::new(
        "_remcontrol._tcp.local.",
        "remcontrol",
        "remcontrol.local.",
        ip,
        cfg.port,
        None,
    )?;
    mdns.register(service)?;

    let commands = injector::spawn_enigo()?;
    let state = ws::AppState::new(cfg.token.clone(), commands);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    axum::serve(listener, ws::router(state)).await?;
    Ok(())
}
```

- [ ] **Step 2: `cargo build` + `cargo test` pass; run the binary briefly and check the banner + QR print** (`timeout 3 cargo run` — expected: banner, QR, then timeout kill)

- [ ] **Step 3: Write `server/README.md`**: build/run instructions for Linux and Windows, `--reset-token`, note that Windows Firewall prompts on first run and must be allowed, X11 requirement on Linux.

- [ ] **Step 4: Commit** (`feat: wire up server startup with QR code and mDNS`)

---

### Task 6: Expo app scaffold + storage + connection modules

**Files:**
- Create: `app/` via `npx create-expo-app@latest app --template blank-typescript`
- Create: `app/src/types.ts`, `app/src/storage.ts`, `app/src/connection.ts`
- Modify: `app/tsconfig.json` (strict), `app/app.json` (name "remcontrol", camera permission via expo-camera plugin)

**Interfaces:**
- Produces:

```typescript
// types.ts
export interface ServerInfo { ip: string; port: number; token: string }

// storage.ts
export async function saveLastConnection(info: ServerInfo): Promise<void>
export async function loadLastConnection(): Promise<ServerInfo | null>

// connection.ts
export type ConnectionEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
};
export class Connection {
  constructor(info: ServerInfo, events?: ConnectionEvents)
  connect(): void           // opens ws://ip:port/ws, sends hello, resolves state on welcome
  close(): void
  move(dx: number, dy: number): void
  click(button: 'left' | 'right' | 'middle'): void
  buttonDown(button: 'left' | 'right' | 'middle'): void
  buttonUp(button: 'left' | 'right' | 'middle'): void
  scroll(dx: number, dy: number): void
  text(value: string): void
  key(key: string): void
}
```

- [ ] **Step 1: Scaffold**

```bash
cd /home/dorian/Projects/remcontrol && npx create-expo-app@latest app --template blank-typescript
cd app && npx expo install expo-camera react-native-gesture-handler @react-native-async-storage/async-storage react-native-zeroconf
```

Set `"strict": true` in `tsconfig.json`. In `app.json`, add the `expo-camera` plugin with a camera permission message ("Scan the server QR code").

- [ ] **Step 2: Implement `types.ts` and `storage.ts`**

```typescript
// src/storage.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerInfo } from './types';

const KEY = 'remcontrol:last-connection';

export async function saveLastConnection(info: ServerInfo): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(info));
}

export async function loadLastConnection(): Promise<ServerInfo | null> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.ip === 'string' && typeof parsed.port === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
  } catch {}
  return null;
}
```

- [ ] **Step 3: Implement `connection.ts`**

```typescript
import { ServerInfo } from './types';

export type ConnectionEvents = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (message: string) => void;
};

export class Connection {
  private ws: WebSocket | null = null;
  private welcomed = false;

  constructor(private info: ServerInfo, private events: ConnectionEvents = {}) {}

  connect(): void {
    const ws = new WebSocket(`ws://${this.info.ip}:${this.info.port}/ws`);
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.info.token }));
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === 'welcome') {
          this.welcomed = true;
          this.events.onOpen?.();
        } else if (msg.type === 'error') {
          this.events.onError?.(msg.message ?? 'server error');
        }
      } catch {}
    };
    ws.onerror = () => this.events.onError?.('connection failed');
    ws.onclose = () => {
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      if (wasWelcomed) this.events.onClose?.();
    };
  }

  close(): void {
    this.welcomed = false;
    this.ws?.close();
    this.ws = null;
  }

  private send(payload: object): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.welcomed) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  move(dx: number, dy: number) { this.send({ type: 'move', dx, dy }); }
  click(button: 'left' | 'right' | 'middle') { this.send({ type: 'click', button }); }
  buttonDown(button: 'left' | 'right' | 'middle') { this.send({ type: 'button', button, action: 'down' }); }
  buttonUp(button: 'left' | 'right' | 'middle') { this.send({ type: 'button', button, action: 'up' }); }
  scroll(dx: number, dy: number) { this.send({ type: 'scroll', dx, dy }); }
  text(value: string) { this.send({ type: 'text', value }); }
  key(key: string) { this.send({ type: 'key', key }); }
}
```

- [ ] **Step 4: `npx tsc --noEmit` passes; commit** (`feat: scaffold expo app with connection and storage modules`)

---

### Task 7: Connect screen

**Files:**
- Create: `app/src/screens/ConnectScreen.tsx`
- Modify: `app/App.tsx`

**Interfaces:**
- Consumes: `Connection`, `storage`, `ServerInfo`
- Produces: `ConnectScreen({ onConnected }: { onConnected: (conn: Connection, info: ServerInfo) => void })`. `App.tsx` holds `screen: 'connect' | 'trackpad'` state, wraps everything in `GestureHandlerRootView`, auto-tries the stored connection on mount.

Behavior:
- Three tabs: **Scan** (expo-camera `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}`, parses the JSON payload `{ip, port, token}`), **Discover** (react-native-zeroconf `scan('remcontrol', 'tcp')`, lists resolved services; tapping one uses its ip/port and the stored token for that ip if present, else prompts for token), **Manual** (ip/port/token inputs, port defaults 17890).
- Any path builds a `ServerInfo`, creates a `Connection`, connects; `onOpen` → `saveLastConnection(info)` then `onConnected(conn, info)`; `onError` → show the message inline.
- On App mount: `loadLastConnection()`; if present, silently try it (5 s guard timer); success goes straight to trackpad, failure shows ConnectScreen (stored entry kept).
- Zeroconf import must be guarded (`try/require`) so the app still runs in environments without the native module; the Discover tab then shows "discovery unavailable in this build".

- [ ] **Step 1: Implement ConnectScreen and App wiring** (full code — tabs as simple state, StyleSheet styles, dark background `#111`)
- [ ] **Step 2: `npx tsc --noEmit` passes**
- [ ] **Step 3: Commit** (`feat: add connect screen with QR, mDNS and manual entry`)

---

### Task 8: Trackpad screen

**Files:**
- Create: `app/src/screens/TrackpadScreen.tsx`
- Modify: `app/App.tsx` (render it when connected)

**Interfaces:**
- Consumes: `Connection`
- Produces: `TrackpadScreen({ connection, onDisconnect }: { connection: Connection; onDisconnect: () => void })`

Gesture composition (react-native-gesture-handler v2, `Gesture.Race`/`Simultaneous` as needed):
- `Gesture.Pan().maxPointers(1)` → `onChange(e => connection.move(e.changeX * sensitivity, e.changeY * sensitivity))`. Before starting, if a tap ended < 300 ms ago (ref timestamp), send `buttonDown('left')` first and `buttonUp('left')` on end (drag mode).
- `Gesture.Tap().maxDuration(200)` → left click (and record timestamp for drag detection).
- `Gesture.Tap().minPointers(2)` → right click.
- `Gesture.Pan().minPointers(2)` → scroll: `connection.scroll(-e.changeX * scrollSensitivity, -e.changeY * scrollSensitivity)` (natural direction).
- Sensitivity: state slider-free v1 — three preset buttons (slow/normal/fast → 0.8/1.5/2.5) in a settings row toggled from the toolbar.

Keyboard: hidden `TextInput` (1×1, opacity 0), `value=" "` (single space so Backspace fires), `blurOnSubmit={false}`, `autoCorrect={false}`, `autoCapitalize="none"`:
- `onKeyPress`: `key === 'Backspace'` → `connection.key('backspace')`
- `onChangeText`: `text.length > 1` → `connection.text(text.slice(1))`, then reset value to `' '`
- `onSubmitEditing`: `connection.key('enter')`

Toolbar (bottom row): keyboard toggle (focus/blur the hidden input), Esc, Tab, ↑ ↓ ← →, Enter, sensitivity toggle, disconnect (calls `connection.close()` then `onDisconnect()`). Status dot: green when connected; on `onClose` show a "reconnecting…" banner, retry `connect()` with 1 s/2 s/4 s backoff ×5, then give up and `onDisconnect()`.

- [ ] **Step 1: Implement TrackpadScreen** (full code)
- [ ] **Step 2: Wire into `App.tsx`**; `npx tsc --noEmit` passes
- [ ] **Step 3: Commit** (`feat: add trackpad screen with gestures and keyboard`)

---

### Task 9: Root README + final verification

**Files:**
- Create: `README.md` (root)

- [ ] **Step 1: Write root README**: what remcontrol is, quick start for the server (Linux/X11 + Windows, firewall note) and the app (`npx expo run:android`, why Expo Go is insufficient), connection methods, gesture reference table.
- [ ] **Step 2: Full verification**: `cargo test` + `cargo build` in `server/`, `npx tsc --noEmit` in `app/`.
- [ ] **Step 3: Commit** (`docs: add project README`)
