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
