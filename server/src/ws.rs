use crate::injector::Command;
use crate::protocol::{ClientMessage, ServerMessage};
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::any;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, mpsc, oneshot};

#[derive(Clone)]
pub struct AppState {
    token: String,
    commands: mpsc::UnboundedSender<Command>,
    active: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl AppState {
    pub fn new(token: String, commands: mpsc::UnboundedSender<Command>) -> Self {
        Self {
            token,
            commands,
            active: Arc::new(Mutex::new(None)),
        }
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
            let _ = socket
                .send(Message::text(serde_json::to_string(&err).unwrap()))
                .await;
            let _ = socket.send(Message::Close(None)).await;
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

    let _ = socket.send(Message::Close(None)).await;
    let _ = state.commands.send(Command::ReleaseAll);
    tracing::info!("client disconnected");
}

async fn authenticate(socket: &mut WebSocket, token: &str) -> Result<(), String> {
    let first = tokio::time::timeout(Duration::from_secs(10), socket.recv())
        .await
        .map_err(|_| "handshake timeout".to_string())?
        .ok_or("connection closed")?
        .map_err(|_| "connection error".to_string())?;
    let Message::Text(text) = first else {
        return Err("expected hello".into());
    };
    match serde_json::from_str::<ClientMessage>(&text) {
        Ok(ClientMessage::Hello { token: t }) if t == token => Ok(()),
        Ok(ClientMessage::Hello { .. }) => Err("bad token".into()),
        _ => Err("expected hello".into()),
    }
}
