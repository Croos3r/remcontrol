use futures_util::{SinkExt, StreamExt};
use remcontrol_server::crypto::{
    Handshake, HelloFrame, PROTOCOL_VERSION, RecvCounter, SessionKeys, WelcomeFrame,
    parse_pubkey_hex, psk_from_token, pubkey_hex,
};
use remcontrol_server::injector::Command;
use remcontrol_server::protocol::{ClientMessage, ServerMessage};
use remcontrol_server::ws::{AppState, router};
use tokio_tungstenite::tungstenite::Message as TsMessage;

async fn start_server(token: &str) -> (String, tokio::sync::mpsc::Receiver<Command>) {
    start_server_with(token, Vec::new()).await
}

async fn start_server_with(
    token: &str,
    allowed_origins: Vec<String>,
) -> (String, tokio::sync::mpsc::Receiver<Command>) {
    let (tx, rx) = tokio::sync::mpsc::channel(64);
    let state = AppState::with_origins(token.to_string(), tx, allowed_origins);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(
        axum::serve(
            listener,
            router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .into_future(),
    );
    (format!("ws://{addr}/ws"), rx)
}

/// A minimal encrypted client for integration tests: performs the PSK-ECDH
/// handshake and exposes seal/open helpers.
struct EncClient {
    ws: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    keys: SessionKeys,
    send_counter: u64,
    recv: RecvCounter,
}

impl EncClient {
    async fn connect(url: &str, token: &str) -> Self {
        let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let hs = Handshake::new();
        let pubkey = pubkey_hex(&hs.public());
        let hello = HelloFrame {
            v: PROTOCOL_VERSION,
            pubkey,
        };
        ws.send(TsMessage::Text(
            serde_json::to_string(&hello).unwrap().into(),
        ))
        .await
        .unwrap();

        let welcome_raw = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let welcome: WelcomeFrame = serde_json::from_str(&welcome_raw).unwrap();
        assert_eq!(welcome.v, PROTOCOL_VERSION);
        let server_pub = parse_pubkey_hex(&welcome.pubkey).unwrap();
        let psk = psk_from_token(token);
        let shared = hs.shared_secret(&server_pub).unwrap();
        let keys = SessionKeys::derive_client(&shared, &psk);

        let mut client = Self {
            ws,
            keys,
            send_counter: 0,
            recv: RecvCounter::new(),
        };
        // Send the encrypted ack (an app-level Hello) to confirm the key.
        client
            .send_encrypted(&ClientMessage::Hello {
                token: String::new(),
            })
            .await;
        // First encrypted server frame is the app-level Welcome.
        let welcome_msg = client.recv_encrypted().await.unwrap();
        assert!(matches!(welcome_msg, ServerMessage::Welcome));
        client
    }

    async fn send_encrypted(&mut self, msg: &ClientMessage) {
        let pt = serde_json::to_vec(msg).unwrap();
        let frame = self.keys.seal(self.send_counter, &pt);
        self.send_counter += 1;
        self.ws.send(TsMessage::Binary(frame.into())).await.unwrap();
    }

    async fn recv_encrypted(&mut self) -> Option<ServerMessage> {
        loop {
            match self.ws.next().await {
                Some(Ok(TsMessage::Binary(b))) => {
                    if self.recv.check(&b).is_err() {
                        return None;
                    }
                    let pt = self.keys.open(&b).ok()?;
                    return Some(serde_json::from_slice(&pt).unwrap());
                }
                Some(Ok(TsMessage::Close(_))) | None => return None,
                _ => continue,
            }
        }
    }
}

#[tokio::test]
async fn wrong_token_handshake_fails() {
    let (url, _rx) = start_server("secret").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hs = Handshake::new();
    let hello = HelloFrame {
        v: PROTOCOL_VERSION,
        pubkey: pubkey_hex(&hs.public()),
    };
    ws.send(TsMessage::Text(
        serde_json::to_string(&hello).unwrap().into(),
    ))
    .await
    .unwrap();
    // Server sends its ephemeral pubkey back...
    let _welcome = ws.next().await.unwrap().unwrap();
    // ...then the encrypted ack with a wrong-PSK-derived key fails to
    // decrypt, so the server sends a plaintext error and closes.
    let psk = psk_from_token("wrong-token");
    let server_pub = {
        let w: WelcomeFrame = serde_json::from_str(&_welcome.into_text().unwrap()).unwrap();
        parse_pubkey_hex(&w.pubkey).unwrap()
    };
    let shared = hs.shared_secret(&server_pub).unwrap();
    let keys = SessionKeys::derive_client(&shared, &psk);
    let frame = keys.seal(0, b"{}");
    ws.send(TsMessage::Binary(frame.into())).await.unwrap();
    // Expect either a plaintext error frame or a close.
    let mut saw_error_or_close = false;
    for _ in 0..3 {
        match ws.next().await {
            Some(Ok(TsMessage::Text(t))) if t.contains("error") => {
                saw_error_or_close = true;
                break;
            }
            Some(Ok(TsMessage::Close(_))) | None => {
                saw_error_or_close = true;
                break;
            }
            _ => continue,
        }
    }
    assert!(
        saw_error_or_close,
        "server should reject a wrong-PSK handshake"
    );
}

#[tokio::test]
async fn good_token_gets_welcome_and_commands_flow() {
    let (url, mut rx) = start_server("secret").await;
    let mut client = EncClient::connect(&url, "secret").await;
    client
        .send_encrypted(&ClientMessage::Move { dx: 1.0, dy: 2.0 })
        .await;
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::Input(ClientMessage::Move { .. })));
}

#[tokio::test]
async fn new_client_replaces_previous() {
    let (url, mut rx) = start_server("secret").await;
    let mut c1 = EncClient::connect(&url, "secret").await;
    let c2 = EncClient::connect(&url, "secret").await;
    // c1 should be displaced; its socket closes.
    let displaced = tokio::time::timeout(std::time::Duration::from_millis(500), c1.ws.next()).await;
    assert!(
        matches!(displaced, Ok(Some(Ok(TsMessage::Close(_)))) | Ok(None)),
        "previous client should be kicked"
    );
    // The previous client's ReleaseAll is dispatched on its disconnect path.
    // Drain: expect at least one ReleaseAll eventually.
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::ReleaseAll));
    // keep c2 alive until end.
    drop(c2);
}

/// Connect with a browser-style `Origin` header. Returns the HTTP status
/// (for a rejected upgrade, tungstenite surfaces it as a handshake error).
async fn connect_with_origin(
    url: &str,
    origin: &str,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut req = url.into_client_request().unwrap();
    req.headers_mut()
        .insert("origin", origin.try_into().unwrap());
    tokio_tungstenite::connect_async(req).await.map(|_| ())
}

#[tokio::test]
async fn origin_allowlist_rejects_unlisted_browser_origin() {
    let (url, _rx) = start_server_with("secret", vec!["https://app.example".into()]).await;
    let err = connect_with_origin(&url, "https://evil.example").await;
    assert!(err.is_err(), "an unlisted Origin must be rejected");
}

#[tokio::test]
async fn origin_allowlist_accepts_listed_origin() {
    let (url, _rx) = start_server_with("secret", vec!["https://app.example".into()]).await;
    connect_with_origin(&url, "https://app.example")
        .await
        .expect("a listed Origin should be accepted");
}

#[tokio::test]
async fn no_origin_allowlist_rejects_any_browser_origin() {
    let (url, _rx) = start_server("secret").await;
    let err = connect_with_origin(&url, "https://evil.example").await;
    assert!(
        err.is_err(),
        "with an empty allowlist, any browser Origin must be rejected"
    );
}

#[tokio::test]
async fn origin_allowlist_lets_originless_native_client_through() {
    // A non-empty allowlist must still accept the native app, which sends no
    // Origin header. tokio_tungstenite without a custom request sends none.
    let (url, _rx) = start_server_with("secret", vec!["https://app.example".into()]).await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = HelloFrame {
        v: PROTOCOL_VERSION,
        pubkey: pubkey_hex(&Handshake::new().public()),
    };
    ws.send(TsMessage::Text(
        serde_json::to_string(&hello).unwrap().into(),
    ))
    .await
    .unwrap();
    // A welcome frame proves the upgrade was accepted and the handshake started.
    let next = tokio::time::timeout(std::time::Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(
        matches!(next.into_text(), Ok(t) if serde_json::from_str::<WelcomeFrame>(&t).is_ok()),
        "native (Origin-less) client must be accepted even with a non-empty allowlist"
    );
}

/// Repeated bad-token handshakes from one peer must eventually be banned by the
/// rate limiter (C-2). The ban surfaces as a fast auth error, not a 403.
#[tokio::test]
async fn rate_limit_bans_after_repeated_bad_handshakes() {
    let (url, _rx) = start_server("secret").await;
    // MAX_AUTH_FAILURES is 5: the 5th failure trips the ban. Send several
    // wrong-token attempts and assert that a later attempt is rejected with
    // the rate-limit message rather than progressing the handshake.
    for i in 0..5 {
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let hs = Handshake::new();
        let hello = HelloFrame {
            v: PROTOCOL_VERSION,
            pubkey: pubkey_hex(&hs.public()),
        };
        ws.send(TsMessage::Text(
            serde_json::to_string(&hello).unwrap().into(),
        ))
        .await
        .unwrap();
        let welcome = ws.next().await.unwrap().unwrap().into_text().unwrap();
        let server_pub = parse_pubkey_hex(
            &serde_json::from_str::<WelcomeFrame>(&welcome)
                .unwrap()
                .pubkey,
        )
        .unwrap();
        let shared = hs.shared_secret(&server_pub).unwrap();
        let keys = SessionKeys::derive_client(&shared, &psk_from_token("wrong"));
        ws.send(TsMessage::Binary(keys.seal(0, b"{}").into()))
            .await
            .unwrap();
        // Drain the error/close so the connection fully terminates before the
        // next attempt; this also records the failure in the rate limiter.
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
        drop(ws);
        let _ = i;
    }
    // 6th attempt from the same IP: banned, so authenticate() returns the
    // rate-limit error and the server closes without a welcome.
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = HelloFrame {
        v: PROTOCOL_VERSION,
        pubkey: pubkey_hex(&Handshake::new().public()),
    };
    ws.send(TsMessage::Text(
        serde_json::to_string(&hello).unwrap().into(),
    ))
    .await
    .unwrap();
    let mut saw_rate_limit = false;
    for _ in 0..4 {
        match tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(TsMessage::Text(t)))) if t.contains("too many") => {
                saw_rate_limit = true;
                break;
            }
            Ok(Some(Ok(TsMessage::Close(_)))) | Ok(None) | Err(_) => break,
            _ => continue,
        }
    }
    assert!(
        saw_rate_limit,
        "a banned peer must receive the rate-limit error, not a fresh welcome"
    );
}

/// A replayed encrypted frame (same nonce/counter) must be dropped by the
/// server's RecvCounter, closing the connection instead of injecting twice.
#[tokio::test]
async fn replayed_encrypted_frame_drops_connection() {
    let (url, mut rx) = start_server("secret").await;
    let mut client = EncClient::connect(&url, "secret").await;
    // Send a Move, then replay the exact same sealed frame (same counter).
    let frame = {
        let pt = serde_json::to_vec(&ClientMessage::Move { dx: 1.0, dy: 0.0 }).unwrap();
        client.keys.seal(client.send_counter, &pt)
    };
    client
        .ws
        .send(TsMessage::Binary(frame.clone().into()))
        .await
        .unwrap();
    // Replay the identical frame.
    client
        .ws
        .send(TsMessage::Binary(frame.into()))
        .await
        .unwrap();
    // The first Move is injected exactly once.
    let first = rx.recv().await.unwrap();
    assert!(matches!(first, Command::Input(ClientMessage::Move { .. })));
    // No second Move arrives: the replay closes the connection. The only thing
    // that may follow on the channel is the disconnect ReleaseAll cleanup, not
    // a duplicate Move.
    let second = tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await;
    match second {
        Err(_) | Ok(None) | Ok(Some(Command::ReleaseAll)) => {}
        Ok(Some(Command::Input(other))) => panic!(
            "replayed frame must not be injected again; got Move/Input {:?}",
            other
        ),
    }
    // Connection is torn down.
    let closed =
        tokio::time::timeout(std::time::Duration::from_millis(500), client.ws.next()).await;
    assert!(
        matches!(closed, Ok(Some(Ok(TsMessage::Close(_)))) | Ok(None)),
        "server must close after a replayed frame"
    );
}

/// Text over the 4096-byte cap is rejected before reaching the injector (M-2):
/// the server sends an encrypted Error and never dispatches the Text command.
#[tokio::test]
async fn oversized_text_is_rejected_before_injection() {
    let (url, mut rx) = start_server("secret").await;
    let mut client = EncClient::connect(&url, "secret").await;
    let too_long = "x".repeat(4097);
    client
        .send_encrypted(&ClientMessage::Text {
            value: too_long.clone(),
        })
        .await;
    // The server must reject with an Error, and must NOT inject the Text.
    let err = client.recv_encrypted().await.unwrap();
    assert!(
        matches!(err, ServerMessage::Error { ref message } if message.contains("too long")),
        "oversized Text must yield an error, got {err:?}"
    );
    // Nothing reaches the injector within a short window.
    let leaked = tokio::time::timeout(std::time::Duration::from_millis(300), rx.recv()).await;
    assert!(
        leaked.is_err() || matches!(leaked, Ok(None)),
        "oversized Text must never be dispatched to the injector"
    );
    // Connection survives the rejection (validation error does not close).
    client
        .send_encrypted(&ClientMessage::Move { dx: 1.0, dy: 1.0 })
        .await;
    let cmd = rx.recv().await.unwrap();
    assert!(
        matches!(cmd, Command::Input(ClientMessage::Move { .. })),
        "connection must still work after a validation error"
    );
}
