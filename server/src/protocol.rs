use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ButtonAction {
    Down,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecialKey {
    Backspace,
    Enter,
    Esc,
    Tab,
    Up,
    Down,
    Left,
    Right,
    Delete,
    Ctrl,
    Alt,
    Shift,
    Super,
    Space,
    Home,
    End,
    #[serde(rename = "pageup")]
    PageUp,
    #[serde(rename = "pagedown")]
    PageDown,
    Insert,
    F1,
    F2,
    F3,
    F4,
    F5,
    F6,
    F7,
    F8,
    F9,
    F10,
    F11,
    F12,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Modifier {
    Ctrl,
    Alt,
    Shift,
    Super,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientMessage {
    Hello {
        token: String,
    },
    Move {
        dx: f64,
        dy: f64,
    },
    Click {
        button: MouseButton,
    },
    Button {
        button: MouseButton,
        action: ButtonAction,
    },
    Scroll {
        dx: f64,
        dy: f64,
    },
    Text {
        value: String,
    },
    Key {
        key: SpecialKey,
    },
    #[serde(rename = "modifier")]
    ModifierAction {
        key: Modifier,
        action: ButtonAction,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ServerMessage {
    Welcome,
    Error { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_message_types() {
        let cases = [
            (
                r#"{"type":"hello","token":"abc"}"#,
                ClientMessage::Hello {
                    token: "abc".into(),
                },
            ),
            (
                r#"{"type":"move","dx":1.5,"dy":-2.0}"#,
                ClientMessage::Move { dx: 1.5, dy: -2.0 },
            ),
            (
                r#"{"type":"click","button":"right"}"#,
                ClientMessage::Click {
                    button: MouseButton::Right,
                },
            ),
            (
                r#"{"type":"button","button":"left","action":"down"}"#,
                ClientMessage::Button {
                    button: MouseButton::Left,
                    action: ButtonAction::Down,
                },
            ),
            (
                r#"{"type":"scroll","dx":0,"dy":3}"#,
                ClientMessage::Scroll { dx: 0.0, dy: 3.0 },
            ),
            (
                r#"{"type":"text","value":"hi"}"#,
                ClientMessage::Text { value: "hi".into() },
            ),
            (
                r#"{"type":"key","key":"backspace"}"#,
                ClientMessage::Key {
                    key: SpecialKey::Backspace,
                },
            ),
            (
                r#"{"type":"key","key":"pageup"}"#,
                ClientMessage::Key {
                    key: SpecialKey::PageUp,
                },
            ),
            (
                r#"{"type":"key","key":"f5"}"#,
                ClientMessage::Key {
                    key: SpecialKey::F5,
                },
            ),
            (
                r#"{"type":"modifier","key":"ctrl","action":"down"}"#,
                ClientMessage::ModifierAction {
                    key: Modifier::Ctrl,
                    action: ButtonAction::Down,
                },
            ),
        ];
        for (json, expected) in cases {
            assert_eq!(
                serde_json::from_str::<ClientMessage>(json).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn rejects_unknown_type() {
        assert!(serde_json::from_str::<ClientMessage>(r#"{"type":"nope"}"#).is_err());
    }

    #[test]
    fn serializes_server_messages() {
        assert_eq!(
            serde_json::to_string(&ServerMessage::Welcome).unwrap(),
            r#"{"type":"welcome"}"#
        );
        assert_eq!(
            serde_json::to_string(&ServerMessage::Error {
                message: "bad token".into()
            })
            .unwrap(),
            r#"{"type":"error","message":"bad token"}"#
        );
    }
}
