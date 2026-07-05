use crate::protocol::{ButtonAction, ClientMessage, Modifier, MouseButton, SpecialKey};
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
    fn modifier(&mut self, key: Modifier, action: ButtonAction);
}

pub fn spawn<I: Injector>(mut injector: I) -> mpsc::UnboundedSender<Command> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Command>();
    std::thread::spawn(move || {
        let mut held: HashSet<MouseButton> = HashSet::new();
        let mut held_mods: HashSet<Modifier> = HashSet::new();
        let (mut rem_x, mut rem_y) = (0.0_f64, 0.0_f64);
        let (mut scroll_rem_x, mut scroll_rem_y) = (0.0_f64, 0.0_f64);
        let mut pending: std::collections::VecDeque<Command> = std::collections::VecDeque::new();
        loop {
            let cmd = if let Some(c) = pending.pop_front() {
                c
            } else {
                match rx.blocking_recv() {
                    Some(c) => c,
                    None => break,
                }
            };
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
                            ButtonAction::Down => {
                                held.insert(button);
                            }
                            ButtonAction::Up => {
                                held.remove(&button);
                            }
                        }
                        injector.button(button, action);
                    }
                    ClientMessage::Scroll { dx, dy } => {
                        scroll_rem_x += dx;
                        scroll_rem_y += dy;
                        let (ix, iy) =
                            (scroll_rem_x.trunc() as i32, scroll_rem_y.trunc() as i32);
                        if ix != 0 || iy != 0 {
                            scroll_rem_x -= ix as f64;
                            scroll_rem_y -= iy as f64;
                            injector.scroll(ix, iy);
                        }
                    }
                    ClientMessage::Text { value } => {
                        let mut buf = value;
                        let mut idle = std::time::Duration::ZERO;
                        while buf.len() < 4096 && idle < std::time::Duration::from_millis(25) {
                            match rx.try_recv() {
                                Ok(Command::Input(ClientMessage::Text { value: more })) => {
                                    buf.push_str(&more);
                                    idle = std::time::Duration::ZERO;
                                }
                                Ok(other) => {
                                    pending.push_back(other);
                                    break;
                                }
                                Err(_) => {
                                    std::thread::sleep(std::time::Duration::from_millis(5));
                                    idle += std::time::Duration::from_millis(5);
                                }
                            }
                        }
                        injector.text(&buf);
                    }
                    ClientMessage::Key { key } => injector.key(key),
                    ClientMessage::ModifierAction { key, action } => {
                        match action {
                            ButtonAction::Down => {
                                held_mods.insert(key);
                            }
                            ButtonAction::Up => {
                                held_mods.remove(&key);
                            }
                        }
                        injector.modifier(key, action);
                    }
                    ClientMessage::Hello { .. } => {}
                },
                Command::ReleaseAll => {
                    for button in held.drain() {
                        injector.button(button, ButtonAction::Up);
                    }
                    for m in held_mods.drain() {
                        injector.modifier(m, ButtonAction::Up);
                    }
                }
            }
        }
    });
    tx
}

pub struct EnigoInjector(enigo::Enigo);

pub fn spawn_enigo() -> anyhow::Result<mpsc::UnboundedSender<Command>> {
    let mut settings = enigo::Settings::default();
    // Send raw relative mouse moves on Windows instead of GetCursorPos + absolute
    // move. The absolute path reads the cursor position on every event, which is
    // racy and slow during fast continuous movement and reads as laggy. Relative moves
    // are what a physical mouse sends.
    settings.windows_subject_to_mouse_speed_and_acceleration_level = true;
    let enigo = enigo::Enigo::new(&settings)?;
    Ok(spawn(EnigoInjector(enigo)))
}

impl Injector for EnigoInjector {
    fn move_rel(&mut self, dx: i32, dy: i32) {
        use enigo::Mouse;
        let _ = self.0.move_mouse(dx, dy, enigo::Coordinate::Rel);
    }
    fn button(&mut self, button: MouseButton, action: ButtonAction) {
        use enigo::Mouse;
        let dir = match action {
            ButtonAction::Down => enigo::Direction::Press,
            ButtonAction::Up => enigo::Direction::Release,
        };
        let _ = self.0.button(map_button(button), dir);
    }
    fn click(&mut self, button: MouseButton) {
        use enigo::Mouse;
        let _ = self.0.button(map_button(button), enigo::Direction::Click);
    }
    fn scroll(&mut self, dx: i32, dy: i32) {
        use enigo::Mouse;
        if dx != 0 {
            let _ = self.0.scroll(dx, enigo::Axis::Horizontal);
        }
        if dy != 0 {
            let _ = self.0.scroll(dy, enigo::Axis::Vertical);
        }
    }
    fn text(&mut self, value: &str) {
        if value.is_empty() {
            return;
        }
        #[cfg(target_os = "linux")]
        {
            if value.is_ascii() {
                let mut cmd = std::process::Command::new("xdotool");
                cmd.args(["type", "--clearmodifiers", "--delay", "0", value]);
                if let Err(e) = cmd.status() {
                    tracing::warn!("xdotool type failed: {e}");
                }
                return;
            }
            for ch in value.chars() {
                let code = ch as u32;
                let arg = format!("0x{code:04X}");
                let status = std::process::Command::new("xdotool")
                    .args(["key", "--clearmodifiers", &arg])
                    .status();
                if let Err(e) = status {
                    tracing::warn!(?ch, "xdotool key failed: {e}");
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            use enigo::Keyboard;
            if let Err(e) = self.0.text(value) {
                tracing::warn!("enigo text failed: {e:?}");
            }
        }
    }
    fn key(&mut self, key: SpecialKey) {
        use enigo::Keyboard;
        let _ = self.0.key(map_key_special(key), enigo::Direction::Click);
    }
    fn modifier(&mut self, key: Modifier, action: ButtonAction) {
        use enigo::Keyboard;
        let dir = match action {
            ButtonAction::Down => enigo::Direction::Press,
            ButtonAction::Up => enigo::Direction::Release,
        };
        let _ = self.0.key(map_key_modifier(key), dir);
    }
}

fn map_key_special(key: SpecialKey) -> enigo::Key {
    match key {
        SpecialKey::Backspace => enigo::Key::Backspace,
        SpecialKey::Enter => enigo::Key::Return,
        SpecialKey::Esc => enigo::Key::Escape,
        SpecialKey::Tab => enigo::Key::Tab,
        SpecialKey::Up => enigo::Key::UpArrow,
        SpecialKey::Down => enigo::Key::DownArrow,
        SpecialKey::Left => enigo::Key::LeftArrow,
        SpecialKey::Right => enigo::Key::RightArrow,
        SpecialKey::Delete => enigo::Key::Delete,
        SpecialKey::Ctrl => enigo::Key::Control,
        SpecialKey::Alt => enigo::Key::Alt,
        SpecialKey::Shift => enigo::Key::Shift,
        SpecialKey::Super => enigo::Key::Meta,
        SpecialKey::Space => enigo::Key::Space,
        SpecialKey::Home => enigo::Key::Home,
        SpecialKey::End => enigo::Key::End,
        SpecialKey::PageUp => enigo::Key::PageUp,
        SpecialKey::PageDown => enigo::Key::PageDown,
        SpecialKey::Insert => enigo::Key::Insert,
        SpecialKey::F1 => enigo::Key::F1,
        SpecialKey::F2 => enigo::Key::F2,
        SpecialKey::F3 => enigo::Key::F3,
        SpecialKey::F4 => enigo::Key::F4,
        SpecialKey::F5 => enigo::Key::F5,
        SpecialKey::F6 => enigo::Key::F6,
        SpecialKey::F7 => enigo::Key::F7,
        SpecialKey::F8 => enigo::Key::F8,
        SpecialKey::F9 => enigo::Key::F9,
        SpecialKey::F10 => enigo::Key::F10,
        SpecialKey::F11 => enigo::Key::F11,
        SpecialKey::F12 => enigo::Key::F12,
    }
}

fn map_key_modifier(key: Modifier) -> enigo::Key {
    match key {
        Modifier::Ctrl => enigo::Key::Control,
        Modifier::Alt => enigo::Key::Alt,
        Modifier::Shift => enigo::Key::Shift,
        Modifier::Super => enigo::Key::Meta,
    }
}

fn map_button(b: MouseButton) -> enigo::Button {
    match b {
        MouseButton::Left => enigo::Button::Left,
        MouseButton::Right => enigo::Button::Right,
        MouseButton::Middle => enigo::Button::Middle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Recorder(Arc<Mutex<Vec<String>>>);

    impl Injector for Recorder {
        fn move_rel(&mut self, dx: i32, dy: i32) {
            self.0.lock().unwrap().push(format!("move {dx} {dy}"));
        }
        fn button(&mut self, b: MouseButton, a: ButtonAction) {
            self.0.lock().unwrap().push(format!("button {b:?} {a:?}"));
        }
        fn click(&mut self, b: MouseButton) {
            self.0.lock().unwrap().push(format!("click {b:?}"));
        }
        fn scroll(&mut self, dx: i32, dy: i32) {
            self.0.lock().unwrap().push(format!("scroll {dx} {dy}"));
        }
        fn text(&mut self, v: &str) {
            self.0.lock().unwrap().push(format!("text {v}"));
        }
        fn key(&mut self, k: SpecialKey) {
            self.0.lock().unwrap().push(format!("key {k:?}"));
        }
        fn modifier(&mut self, k: Modifier, a: ButtonAction) {
            self.0.lock().unwrap().push(format!("modifier {k:?} {a:?}"));
        }
    }

    fn drain(rec: &Recorder, tx: tokio::sync::mpsc::UnboundedSender<Command>) -> Vec<String> {
        drop(tx);
        std::thread::sleep(std::time::Duration::from_millis(50));
        rec.0.lock().unwrap().clone()
    }

    #[test]
    fn dispatches_input_commands() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.send(Command::Input(ClientMessage::Move { dx: 3.0, dy: -2.0 }))
            .unwrap();
        tx.send(Command::Input(ClientMessage::Click {
            button: MouseButton::Left,
        }))
        .unwrap();
        tx.send(Command::Input(ClientMessage::Hello {
            token: "x".into(),
        }))
        .unwrap();
        tx.send(Command::Input(ClientMessage::Text { value: "hi".into() }))
            .unwrap();
        let calls = drain(&rec, tx);
        assert_eq!(calls, vec!["move 3 -2", "click Left", "text hi"]);
    }

    #[test]
    fn accumulates_fractional_moves() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        for _ in 0..4 {
            tx.send(Command::Input(ClientMessage::Move { dx: 0.5, dy: 0.0 }))
                .unwrap();
        }
        let calls = drain(&rec, tx);
        assert_eq!(
            calls.iter().filter(|c| c.as_str() == "move 1 0").count(),
            2
        );
    }

    #[test]
    fn release_all_releases_held_buttons() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.send(Command::Input(ClientMessage::Button {
            button: MouseButton::Left,
            action: ButtonAction::Down,
        }))
        .unwrap();
        tx.send(Command::ReleaseAll).unwrap();
        let calls = drain(&rec, tx);
        assert_eq!(calls, vec!["button Left Down", "button Left Up"]);
    }

    #[test]
    fn release_all_releases_held_modifiers() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.send(Command::Input(ClientMessage::ModifierAction {
            key: Modifier::Ctrl,
            action: ButtonAction::Down,
        }))
        .unwrap();
        tx.send(Command::ReleaseAll).unwrap();
        let calls = drain(&rec, tx);
        assert_eq!(calls, vec!["modifier Ctrl Down", "modifier Ctrl Up"]);
    }
}
