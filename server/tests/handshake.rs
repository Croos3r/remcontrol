use futures_util::{SinkExt, StreamExt};
use remcontrol_server::injector::Command;
use remcontrol_server::ws::{AppState, router};
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
    ws.send(Message::text(r#"{"type":"hello","token":"wrong"}"#))
        .await
        .unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert!(reply.to_text().unwrap().contains("error"));
    assert!(matches!(
        ws.next().await,
        Some(Ok(Message::Close(_))) | None
    ));
}

#[tokio::test]
async fn good_token_gets_welcome_and_commands_flow() {
    let (url, mut rx) = start_server("secret").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws.send(Message::text(r#"{"type":"hello","token":"secret"}"#))
        .await
        .unwrap();
    let reply = ws.next().await.unwrap().unwrap();
    assert_eq!(reply.to_text().unwrap(), r#"{"type":"welcome"}"#);
    ws.send(Message::text(r#"{"type":"move","dx":1,"dy":2}"#))
        .await
        .unwrap();
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::Input(_)));
}

#[tokio::test]
async fn new_client_replaces_previous() {
    let (url, mut rx) = start_server("secret").await;
    let (mut ws1, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws1.send(Message::text(r#"{"type":"hello","token":"secret"}"#))
        .await
        .unwrap();
    ws1.next().await.unwrap().unwrap();
    let (mut ws2, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    ws2.send(Message::text(r#"{"type":"hello","token":"secret"}"#))
        .await
        .unwrap();
    ws2.next().await.unwrap().unwrap();
    assert!(matches!(
        ws1.next().await,
        Some(Ok(Message::Close(_))) | None
    ));
    let cmd = rx.recv().await.unwrap();
    assert!(matches!(cmd, Command::ReleaseAll));
}
