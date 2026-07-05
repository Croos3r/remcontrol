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

/// Capacity of the bounded input channel. The WebSocket task applies
/// backpressure to the client when the injector falls behind this instead
/// of growing without bound (M-4). On overflow the connection is closed.
const CHANNEL_CAPACITY: usize = 256;

pub fn spawn<I: Injector>(mut injector: I) -> mpsc::Sender<Command> {
    let (tx, mut rx) = mpsc::channel::<Command>(CHANNEL_CAPACITY);
    std::thread::spawn(move || {
        let mut held: HashSet<MouseButton> = HashSet::new();
        let mut held_mods: HashSet<Modifier> = HashSet::new();
        // Un-applied cursor motion. Move deltas accumulate here, and a smoothing
        // tick applies a fraction of the accumulator toward zero so a burst of
        // moves arriving in ~2ms is spread smoothly over the ~50ms network gap
        // until the next burst. Without this, Windows SendInput jumps the cursor
        // instantly per call and the cursor sits still between bursts (choppy).
        let (mut rem_x, mut rem_y) = (0.0_f64, 0.0_f64);
        let (mut scroll_rem_x, mut scroll_rem_y) = (0.0_f64, 0.0_f64);
        let mut pending: std::collections::VecDeque<Command> = std::collections::VecDeque::new();
        // Fraction of the remaining motion applied each smoothing tick. 0.5 at
        // 8ms (125Hz) spreads a burst over ~6 ticks (~48ms), matching the network
        // gap so the cursor keeps moving instead of stopping.
        const SMOOTH: f64 = 0.5;
        const TICK: std::time::Duration = std::time::Duration::from_millis(8);
        let mut last_tick = std::time::Instant::now();
        loop {
            // Drain any previously-queued command first, then pull one new
            // message without blocking. If the channel is empty we fall
            // through to the smoothing tick and sleep TICK.
            let cmd = if let Some(c) = pending.pop_front() {
                Some(c)
            } else {
                match rx.try_recv() {
                    Ok(c) => Some(c),
                    Err(mpsc::error::TryRecvError::Empty) => None,
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        // Channel closed: drain any remaining motion before
                        // exiting so the cursor doesn't stop mid-move.
                        while rem_x != 0.0 || rem_y != 0.0 {
                            let ax = rem_x.trunc() as i32;
                            let ay = rem_y.trunc() as i32;
                            if ax == 0 && ay == 0 {
                                break;
                            }
                            rem_x -= ax as f64;
                            rem_y -= ay as f64;
                            injector.move_rel(ax, ay);
                        }
                        break;
                    }
                }
            };
            let had_cmd = cmd.is_some();
            if let Some(cmd) = cmd {
                match cmd {
                    Command::Input(msg) => match msg {
                        ClientMessage::Move { dx, dy } => {
                            rem_x += dx;
                            rem_y += dy;
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
            // Smoothing tick: apply a fraction of the accumulated motion at most
            // once per TICK. During a burst of messages this still paces the
            // cursor at ~125Hz instead of applying instantly per message.
            let now = std::time::Instant::now();
            if now >= last_tick + TICK {
                last_tick = now;
                if rem_x != 0.0 || rem_y != 0.0 {
                    let mut ax = (rem_x * SMOOTH).trunc() as i32;
                    let mut ay = (rem_y * SMOOTH).trunc() as i32;
                    // If the smoothed step rounds to zero but a full pixel
                    // remains, flush the integer remainder so small leftovers
                    // don't stall.
                    if ax == 0 && rem_x.trunc() != 0.0 {
                        ax = rem_x.trunc() as i32;
                    }
                    if ay == 0 && rem_y.trunc() != 0.0 {
                        ay = rem_y.trunc() as i32;
                    }
                    if ax != 0 || ay != 0 {
                        rem_x -= ax as f64;
                        rem_y -= ay as f64;
                        injector.move_rel(ax, ay);
                    }
                }
            }
            // Pacing: when the channel is empty, sleep until the next tick so
            // we don't spin. When messages are arriving we keep draining.
            if !had_cmd {
                std::thread::sleep(TICK);
            }
        }
    });
    tx
}

pub struct EnigoInjector(enigo::Enigo);

pub fn spawn_enigo() -> anyhow::Result<mpsc::Sender<Command>> {
    // Send raw relative mouse moves on Windows instead of GetCursorPos + absolute
    // move. The absolute path reads the cursor position on every event, which is
    // racy and slow during fast continuous movement and reads as laggy. Relative moves
    // are what a physical mouse sends.
    let settings = enigo::Settings {
        windows_subject_to_mouse_speed_and_acceleration_level: true,
        ..enigo::Settings::default()
    };
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
        if let Some(k) = map_key_special(key) {
            let _ = self.0.key(k, enigo::Direction::Click);
        }
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

fn map_key_special(key: SpecialKey) -> Option<enigo::Key> {
    match key {
        SpecialKey::Backspace => Some(enigo::Key::Backspace),
        SpecialKey::Enter => Some(enigo::Key::Return),
        SpecialKey::Esc => Some(enigo::Key::Escape),
        SpecialKey::Tab => Some(enigo::Key::Tab),
        SpecialKey::Up => Some(enigo::Key::UpArrow),
        SpecialKey::Down => Some(enigo::Key::DownArrow),
        SpecialKey::Left => Some(enigo::Key::LeftArrow),
        SpecialKey::Right => Some(enigo::Key::RightArrow),
        SpecialKey::Delete => Some(enigo::Key::Delete),
        SpecialKey::Ctrl => Some(enigo::Key::Control),
        SpecialKey::Alt => Some(enigo::Key::Alt),
        SpecialKey::Shift => Some(enigo::Key::Shift),
        SpecialKey::Super => Some(enigo::Key::Meta),
        SpecialKey::Space => Some(enigo::Key::Space),
        SpecialKey::Home => Some(enigo::Key::Home),
        SpecialKey::End => Some(enigo::Key::End),
        SpecialKey::PageUp => Some(enigo::Key::PageUp),
        SpecialKey::PageDown => Some(enigo::Key::PageDown),
        // enigo::Key::Insert is cfg-gated to Windows + Linux (not macOS).
        SpecialKey::Insert => cfg_insert(),
        SpecialKey::F1 => Some(enigo::Key::F1),
        SpecialKey::F2 => Some(enigo::Key::F2),
        SpecialKey::F3 => Some(enigo::Key::F3),
        SpecialKey::F4 => Some(enigo::Key::F4),
        SpecialKey::F5 => Some(enigo::Key::F5),
        SpecialKey::F6 => Some(enigo::Key::F6),
        SpecialKey::F7 => Some(enigo::Key::F7),
        SpecialKey::F8 => Some(enigo::Key::F8),
        SpecialKey::F9 => Some(enigo::Key::F9),
        SpecialKey::F10 => Some(enigo::Key::F10),
        SpecialKey::F11 => Some(enigo::Key::F11),
        SpecialKey::F12 => Some(enigo::Key::F12),
    }
}

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn cfg_insert() -> Option<enigo::Key> {
    Some(enigo::Key::Insert)
}

#[cfg(not(any(target_os = "windows", all(unix, not(target_os = "macos")))))]
fn cfg_insert() -> Option<enigo::Key> {
    None
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

    fn drain(rec: &Recorder, tx: tokio::sync::mpsc::Sender<Command>) -> Vec<String> {
        drop(tx);
        std::thread::sleep(std::time::Duration::from_millis(50));
        rec.0.lock().unwrap().clone()
    }

    #[test]
    fn dispatches_input_commands() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.blocking_send(Command::Input(ClientMessage::Move { dx: 3.0, dy: -2.0 }))
            .unwrap();
        tx.blocking_send(Command::Input(ClientMessage::Click {
            button: MouseButton::Left,
        }))
        .unwrap();
        tx.blocking_send(Command::Input(ClientMessage::Hello { token: "x".into() }))
            .unwrap();
        tx.blocking_send(Command::Input(ClientMessage::Text { value: "hi".into() }))
            .unwrap();
        let calls = drain(&rec, tx);
        // Moves are smoothed across ticks, so check the total applied motion
        // rather than a single call, plus that click/text fired exactly once.
        let (mx, my): (i32, i32) = calls
            .iter()
            .filter_map(|c| {
                c.strip_prefix("move ").and_then(|s| {
                    let mut it = s.split_whitespace();
                    Some((
                        it.next()?.parse::<i32>().ok()?,
                        it.next()?.parse::<i32>().ok()?,
                    ))
                })
            })
            .fold((0, 0), |(x, y), (a, b)| (x + a, y + b));
        assert_eq!((mx, my), (3, -2));
        assert!(calls.iter().any(|c| c == "click Left"));
        assert!(calls.iter().any(|c| c == "text hi"));
    }

    #[test]
    fn accumulates_fractional_moves() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        for _ in 0..4 {
            tx.blocking_send(Command::Input(ClientMessage::Move { dx: 0.5, dy: 0.0 }))
                .unwrap();
        }
        let calls = drain(&rec, tx);
        let total_x: i32 = calls
            .iter()
            .filter_map(|c| {
                c.strip_prefix("move ")
                    .and_then(|s| s.split_whitespace().next()?.parse::<i32>().ok())
            })
            .sum();
        // Four 0.5 moves = 2px total. Smoothing may split it across ticks but
        // the sum must match.
        assert_eq!(total_x, 2);
    }

    #[test]
    fn release_all_releases_held_buttons() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.blocking_send(Command::Input(ClientMessage::Button {
            button: MouseButton::Left,
            action: ButtonAction::Down,
        }))
        .unwrap();
        tx.blocking_send(Command::ReleaseAll).unwrap();
        let calls = drain(&rec, tx);
        assert_eq!(calls, vec!["button Left Down", "button Left Up"]);
    }

    #[test]
    fn release_all_releases_held_modifiers() {
        let rec = Recorder::default();
        let tx = spawn(rec.clone());
        tx.blocking_send(Command::Input(ClientMessage::ModifierAction {
            key: Modifier::Ctrl,
            action: ButtonAction::Down,
        }))
        .unwrap();
        tx.blocking_send(Command::ReleaseAll).unwrap();
        let calls = drain(&rec, tx);
        assert_eq!(calls, vec!["modifier Ctrl Down", "modifier Ctrl Up"]);
    }
}
