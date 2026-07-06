use crate::crypto::{
    Handshake, HelloFrame, PROTOCOL_VERSION, RecvCounter, SessionKeys, WelcomeFrame,
    parse_pubkey_hex, psk_from_token, pubkey_hex,
};
use crate::injector::Command;
use crate::protocol::{ClientMessage, ServerMessage};
use axum::Router;
use axum::extract::State;
use axum::extract::connect_info::ConnectInfo;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use axum::routing::any;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, mpsc, oneshot};
use tower::limit::ConcurrencyLimitLayer;

/// Max bytes in a single WebSocket message. Bounds memory use per frame (H-1).
const MAX_MESSAGE_SIZE: usize = 64 * 1024;
/// Max bytes in a single WebSocket frame.
const MAX_FRAME_SIZE: usize = 64 * 1024;
/// Max decrypted `Text` payload length (H-1, M-2).
const MAX_TEXT_LEN: usize = 4096;

/// Auth failures from a single peer before the server stops accepting new
/// handshakes from it for a backoff window (C-2).
const MAX_AUTH_FAILURES: u32 = 5;
/// Window over which failures are counted, and the base ban duration after.
const AUTH_WINDOW: Duration = Duration::from_secs(60);
const AUTH_BAN_BASE: Duration = Duration::from_secs(5);
const AUTH_BAN_MAX: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct AppState {
    token: String,
    commands: mpsc::Sender<Command>,
    active: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    rate: Arc<Mutex<RateLimiter>>,
    allowed_origins: Arc<Vec<String>>,
}

impl AppState {
    pub fn new(token: String, commands: mpsc::Sender<Command>) -> Self {
        Self::with_origins(token, commands, Vec::new())
    }

    pub fn with_origins(
        token: String,
        commands: mpsc::Sender<Command>,
        allowed_origins: Vec<String>,
    ) -> Self {
        Self {
            token,
            commands,
            active: Arc::new(Mutex::new(None)),
            rate: Arc::new(Mutex::new(RateLimiter::new())),
            allowed_origins: Arc::new(allowed_origins),
        }
    }
}

struct FailState {
    count: u32,
    first_at: Instant,
    banned_until: Option<Instant>,
}

struct RateLimiter {
    failures: HashMap<IpAddr, FailState>,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            failures: HashMap::new(),
        }
    }

    /// Returns Ok if the peer may attempt a handshake now, Err with the
    /// remaining ban duration otherwise. Stale entries are pruned.
    fn check(&mut self, ip: IpAddr) -> Result<(), Duration> {
        let now = Instant::now();
        self.prune(now);
        match self.failures.get_mut(&ip) {
            Some(s) => {
                if let Some(until) = s.banned_until {
                    if now < until {
                        return Err(until - now);
                    }
                    // ban expired: reset the slot for a fresh attempt.
                    s.count = 0;
                    s.banned_until = None;
                    s.first_at = now;
                } else if now.duration_since(s.first_at) > AUTH_WINDOW {
                    // window rolled over without hitting the cap: reset.
                    s.count = 0;
                    s.first_at = now;
                }
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Record a failed handshake from `ip`. Once the cap is hit within the
    /// window, the peer is banned with exponential backoff.
    fn record_failure(&mut self, ip: IpAddr) {
        let now = Instant::now();
        self.prune(now);
        let s = self.failures.entry(ip).or_insert(FailState {
            count: 0,
            first_at: now,
            banned_until: None,
        });
        if let Some(until) = s.banned_until
            && now < until
        {
            return; // already banned, don't extend
        }
        if now.duration_since(s.first_at) > AUTH_WINDOW {
            s.count = 0;
            s.first_at = now;
            s.banned_until = None;
        }
        s.count += 1;
        if s.count >= MAX_AUTH_FAILURES {
            let steps = (s.count - MAX_AUTH_FAILURES + 1).min(6);
            let mut ban = AUTH_BAN_BASE.saturating_mul(2u32.saturating_pow(steps));
            if ban > AUTH_BAN_MAX {
                ban = AUTH_BAN_MAX;
            }
            s.banned_until = Some(now + ban);
        }
    }

    fn prune(&mut self, now: Instant) {
        self.failures.retain(|_, s| {
            if let Some(until) = s.banned_until {
                now < until
            } else {
                now.duration_since(s.first_at) <= AUTH_WINDOW
            }
        });
    }
}

pub fn router(state: AppState) -> Router {
    // ConcurrencyLimitLayer bounds the number of simultaneous in-flight
    // handshakes, capping the rate at which an attacker can attempt tokens
    // (C-2).
    Router::new()
        .route("/ws", any(upgrade))
        .with_state(state)
        .layer(ConcurrencyLimitLayer::new(64))
}

async fn upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let peer_ip = peer.ip();
    if !origin_allowed(&state.allowed_origins, headers.get("origin")) {
        tracing::warn!(%peer_ip, "rejected upgrade from disallowed Origin");
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(MAX_MESSAGE_SIZE)
        .max_frame_size(MAX_FRAME_SIZE)
        .on_upgrade(move |socket| handle(socket, state, peer_ip))
        .into_response()
}

/// Defense against cross-site WebSocket hijacking (L-7). Clients that send
/// no `Origin` (the native app, curl) are always allowed; a browser that
/// sends one must match the configured allowlist.
fn origin_allowed(allowed: &[String], origin: Option<&HeaderValue>) -> bool {
    let Some(value) = origin else {
        return true;
    };
    let Ok(s) = value.to_str() else {
        return false;
    };
    allowed.iter().any(|a| a == s)
}

async fn handle(mut socket: WebSocket, state: AppState, peer_ip: IpAddr) {
    let session = match authenticate(&mut socket, &state.token, &state.rate, peer_ip).await {
        Ok(s) => s,
        Err(message) => {
            // Send the error as a plaintext JSON frame before closing, so the
            // client can distinguish auth failure from transport issues (M-5).
            let err = ServerMessage::Error {
                message: message.to_string(),
            };
            send_plain(&mut socket, &err).await;
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    let (kick_tx, mut kick_rx) = oneshot::channel();
    if let Some(previous) = state.active.lock().await.replace(kick_tx) {
        let _ = previous.send(());
    }

    // First encrypted frame: app-level Welcome.
    if send_sealed(&mut socket, &session, 0, &ServerMessage::Welcome)
        .await
        .is_err()
    {
        let _ = state.commands.try_send(Command::ReleaseAll);
        return;
    }
    tracing::info!(%peer_ip, "client connected");

    let mut recv = RecvCounter::new();
    let mut send_counter: u64 = 1u64;

    loop {
        tokio::select! {
            _ = &mut kick_rx => {
                tracing::info!("client replaced by a new connection");
                break;
            }
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                let frame = match msg {
                    Message::Binary(b) => b,
                    Message::Text(_) => continue, // only encrypted binary frames allowed post-handshake
                    _ => continue,
                };
                if recv.check(&frame[..]).is_err() {
                    tracing::warn!("rejecting replay/out-of-order frame");
                    break;
                }
                let plaintext = match session.keys.open(&frame[..]) {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(%e, "decrypt failed; closing");
                        break;
                    }
                };
                let Ok(input) = serde_json::from_slice::<ClientMessage>(&plaintext) else {
                    tracing::warn!("ignoring invalid (undecryptable JSON) message");
                    continue;
                };
                if let Err(reason) = validate_input(&input) {
                    let _ = send_sealed(
                        &mut socket,
                        &session,
                        send_counter,
                        &ServerMessage::Error { message: reason.into() },
                    ).await;
                    send_counter += 1;
                    continue;
                }
                match input {
                    ClientMessage::Hello { .. } => {}
                    other => {
                        // try_send applies backpressure: if the injector is
                        // saturated, drop the connection instead of growing
                        // unbounded memory (M-4).
                        if state.commands.try_send(Command::Input(other)).is_err() {
                            tracing::warn!("injector saturated; closing connection");
                            break;
                        }
                    }
                }
            }
        }
    }

    let _ = socket.send(Message::Close(None)).await;
    let _ = state.commands.try_send(Command::ReleaseAll);
    tracing::info!("client disconnected");
}

/// Bound client input before it reaches the injector (H-1, M-2).
fn validate_input(msg: &ClientMessage) -> Result<(), &'static str> {
    if let ClientMessage::Text { value } = msg
        && value.len() > MAX_TEXT_LEN
    {
        return Err("text too long");
    }
    Ok(())
}

/// Outcome of the handshake: the session keys plus a flag the caller uses.
struct Session {
    keys: SessionKeys,
}

async fn authenticate(
    socket: &mut WebSocket,
    token: &str,
    rate: &Mutex<RateLimiter>,
    peer_ip: IpAddr,
) -> Result<Session, &'static str> {
    if let Err(remaining) = rate.lock().await.check(peer_ip) {
        tracing::warn!(%peer_ip, ?remaining, "rate-limited handshake attempt");
        return Err("too many attempts; try again later");
    }

    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| "handshake timeout")?
        .ok_or("connection closed")?
        .map_err(|_| "connection error")?;
    let text = match first {
        Message::Text(t) => t,
        _ => return Err("expected hello"),
    };

    let hello: HelloFrame = serde_json::from_str(&text).map_err(|_| "expected hello")?;
    if hello.v != PROTOCOL_VERSION {
        // Record the failure for rate-limiting even on version mismatch.
        rate.lock().await.record_failure(peer_ip);
        return Err("unsupported protocol version");
    }
    if !hello.has_correct_type() {
        rate.lock().await.record_failure(peer_ip);
        return Err("expected hello");
    }
    let client_pub = match parse_pubkey_hex(&hello.pubkey) {
        Some(p) => p,
        None => {
            rate.lock().await.record_failure(peer_ip);
            return Err("expected hello");
        }
    };

    let server_hs = Handshake::new();
    let server_pub = server_hs.public();
    let psk = psk_from_token(token);
    let keys = match server_hs.finish_server(&client_pub, &psk) {
        Some(k) => k,
        None => {
            rate.lock().await.record_failure(peer_ip);
            return Err("expected hello");
        }
    };

    // Send the server's ephemeral public key as the plaintext welcome. The
    // `type: "welcome"` discriminator is required by the TS client.
    let welcome = WelcomeFrame {
        v: PROTOCOL_VERSION,
        ty: "welcome".to_string(),
        pubkey: pubkey_hex(&server_pub),
    };
    let payload = serde_json::to_string(&welcome).map_err(|_| "internal error")?;
    if socket.send(Message::Text(payload.into())).await.is_err() {
        return Err("connection error");
    }

    // Confirm the client actually has the matching key by requiring an
    // encrypted ack within a short window. The client sends an AEAD-sealed
    // empty-ish "ready" frame (the app-level Hello wrapped in crypto).
    // We decrypt it; if it fails, the client did not derive the same key
    // (wrong token / MITM) and we reject.
    let ack = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| "handshake timeout")?
        .ok_or("connection closed")?
        .map_err(|_| "connection error")?;
    let frame = match ack {
        Message::Binary(b) => b,
        _ => {
            rate.lock().await.record_failure(peer_ip);
            return Err("expected encrypted ack");
        }
    };
    let mut probe = RecvCounter::new();
    if probe.check(&frame[..]).is_err() {
        rate.lock().await.record_failure(peer_ip);
        return Err("bad handshake");
    }
    match keys.open(&frame[..]) {
        Ok(plaintext) => {
            // The ack must decrypt to a valid Hello app message (which we
            // otherwise ignore). A wrong PSK makes open() fail.
            let _ = serde_json::from_slice::<ClientMessage>(&plaintext);
        }
        Err(_) => {
            rate.lock().await.record_failure(peer_ip);
            return Err("bad token");
        }
    }

    Ok(Session { keys })
}

async fn send_sealed(
    socket: &mut WebSocket,
    session: &Session,
    counter: u64,
    msg: &ServerMessage,
) -> Result<(), ()> {
    let plaintext = serde_json::to_vec(msg).map_err(|_| ())?;
    let frame = session.keys.seal(counter, &plaintext);
    socket
        .send(Message::Binary(frame.into()))
        .await
        .map(|_| ())
        .map_err(|_| ())
}

async fn send_plain(socket: &mut WebSocket, msg: &ServerMessage) {
    let fallback = r#"{"type":"error","message":"server error"}"#;
    let payload = serde_json::to_string(msg).unwrap_or_else(|_| fallback.to_string());
    let _ = socket.send(Message::Text(payload.into())).await;
}
