import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { Connection } from '../connection';

interface Props {
  connection: Connection;
  onDisconnect: () => void;
}

type Status = 'connected' | 'reconnecting';

const SENSITIVITIES = [
  { label: 'Slow', value: 0.8 },
  { label: 'Normal', value: 1.5 },
  { label: 'Fast', value: 2.5 },
] as const;

const SCROLL_SENSITIVITY = 0.05;
const DOUBLE_TAP_DRAG_WINDOW_MS = 300;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const KEYBOARD_SENTINEL = ' ';
const SAFE_BOTTOM = 24;
const SAFE_TOP = 32;

const MODIFIERS = ['ctrl', 'alt', 'shift', 'super'] as const;
type ModifierKey = (typeof MODIFIERS)[number];
const MODIFIER_LABEL: Record<ModifierKey, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
};

interface TapKey {
  id: string;
  label: string;
}
const TAP_KEYS: TapKey[] = [
  { id: 'esc', label: 'Esc' },
  { id: 'tab', label: 'Tab' },
  { id: 'space', label: 'Space' },
  { id: 'enter', label: '⏎' },
  { id: 'backspace', label: '⌫' },
  { id: 'delete', label: 'Del' },
  { id: 'home', label: 'Home' },
  { id: 'end', label: 'End' },
  { id: 'pageup', label: 'PgUp' },
  { id: 'pagedown', label: 'PgDn' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
];
const F_KEYS: TapKey[] = Array.from({ length: 12 }, (_, i) => ({
  id: `f${i + 1}`,
  label: `F${i + 1}`,
}));

export default function TrackpadScreen({ connection, onDisconnect }: Props) {
  const [status, setStatus] = useState<Status>('connected');
  const [sensitivity, setSensitivity] = useState<number>(1.5);
  const [showSettings, setShowSettings] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputValue, setInputValue] = useState(KEYBOARD_SENTINEL);
  const [heldMods, setHeldMods] = useState<Set<ModifierKey>>(new Set());
  const [trayVisible, setTrayVisible] = useState(false);
  const [trayPos, setTrayPos] = useState<{ x: number; y: number } | null>(null);

  const inputRef = useRef<TextInput>(null);
  const lastTapRef = useRef(0);
  const draggingRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sensitivityRef = useRef(sensitivity);
  sensitivityRef.current = sensitivity;

  useEffect(() => {
    connection.setEvents({
      onClose: () => {
        setStatus('reconnecting');
        retryRef.current = 0;
        scheduleReconnect();
      },
      onOpen: () => {
        retryRef.current = 0;
        setStatus('connected');
      },
      onError: () => {
        scheduleReconnect();
      },
    });
    const scheduleReconnect = () => {
      if (retryRef.current >= RECONNECT_DELAYS_MS.length) {
        onDisconnect();
        return;
      }
      const delay = RECONNECT_DELAYS_MS[retryRef.current];
      retryRef.current += 1;
      retryTimerRef.current = setTimeout(() => connection.connect(), delay);
    };
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      connection.setEvents({});
    };
  }, [connection, onDisconnect]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: { endCoordinates?: { height?: number } }) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
      setKeyboardOpen(true);
    };
    const onHide = () => {
      setKeyboardHeight(0);
      setKeyboardOpen(false);
      inputRef.current?.blur();
    };
    const showSub = Keyboard.addListener(showEvent, onShow as never);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const movePan = Gesture.Pan()
    .maxPointers(1)
    .runOnJS(true)
    .onStart(() => {
      if (Date.now() - lastTapRef.current < DOUBLE_TAP_DRAG_WINDOW_MS) {
        draggingRef.current = true;
        connection.buttonDown('left');
      }
    })
    .onChange((e) => {
      connection.move(
        e.changeX * sensitivityRef.current,
        e.changeY * sensitivityRef.current,
      );
    })
    .onEnd(() => {
      if (draggingRef.current) {
        draggingRef.current = false;
        connection.buttonUp('left');
      }
    });

  const singleTap = Gesture.Tap()
    .maxDuration(200)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (!success) return;
      lastTapRef.current = Date.now();
      connection.click('left');
    });

  const twoFingerTap = Gesture.Tap()
    .minPointers(2)
    .maxDuration(250)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) connection.click('right');
    });

  const scrollPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .runOnJS(true)
    .onChange((e) => {
      connection.scroll(
        -e.changeX * SCROLL_SENSITIVITY,
        -e.changeY * SCROLL_SENSITIVITY,
      );
    });

  const gesture = Gesture.Race(scrollPan, twoFingerTap, movePan, singleTap);

  const toggleKeyboard = () => {
    if (keyboardOpen) {
      inputRef.current?.blur();
    } else {
      inputRef.current?.focus();
    }
  };

  const onChangeText = (text: string) => {
    const prev = inputValue;
    const prevSuffix = prev.startsWith(KEYBOARD_SENTINEL)
      ? prev.slice(KEYBOARD_SENTINEL.length)
      : prev;
    const suffix = text.startsWith(KEYBOARD_SENTINEL)
      ? text.slice(KEYBOARD_SENTINEL.length)
      : text;
    if (suffix === prevSuffix) {
      setInputValue(text);
      return;
    }
    if (suffix.length > prevSuffix.length && suffix.startsWith(prevSuffix)) {
      connection.text(suffix.slice(prevSuffix.length));
    } else if (
      prevSuffix.length > suffix.length &&
      prevSuffix.startsWith(suffix)
    ) {
      const removed = prevSuffix.length - suffix.length;
      for (let i = 0; i < removed; i++) connection.key('backspace');
    } else {
      for (let i = 0; i < prevSuffix.length; i++) connection.key('backspace');
      if (suffix.length > 0) connection.text(suffix);
    }
    setInputValue(text);
  };

  const onKeyPress = (key: string) => {
    if (key === 'Enter' || key === 'Backspace') return;
    if (key.startsWith('Arrow')) {
      connection.key(key.toLowerCase().replace('arrow', ''));
    }
  };

  const disconnect = () => {
    connection.close();
    onDisconnect();
  };

  const toggleModifier = (m: ModifierKey) => {
    setHeldMods((prev) => {
      const next = new Set(prev);
      if (next.has(m)) {
        connection.modifier(m, 'up');
        next.delete(m);
      } else {
        connection.modifier(m, 'down');
        next.add(m);
      }
      return next;
    });
  };

  const releaseAllModifiers = () => {
    setHeldMods((prev) => {
      for (const m of prev) connection.modifier(m, 'up');
      return new Set();
    });
  };

  const trayDrag = Gesture.Pan()
    .runOnJS(true)
    .blocksExternalGesture(gesture as never)
    .onUpdate((e) => {
      const win = Dimensions.get('window');
      const w = Math.min(win.width - 32, 360);
      const h = 168;
      const x = Math.max(0, Math.min(win.width - w, e.absoluteX - w / 2));
      const y = Math.max(
        0,
        Math.min(win.height - h - keyboardHeight - SAFE_BOTTOM, e.absoluteY - 16),
      );
      setTrayPos({ x, y });
    });

  const screen = Dimensions.get('window');
  const trayW = Math.min(screen.width - 32, 360);
  const trayH = 168;
  const resolvedTrayPos = trayPos ?? {
    x: screen.width - trayW - 16,
    y: screen.height - trayH - 132 - SAFE_BOTTOM,
  };

  return (
    <View style={styles.container}>
      {status === 'reconnecting' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Connection lost, reconnecting…</Text>
        </View>
      )}

      <View style={styles.topBar} pointerEvents="box-none">
        <View style={styles.controlCluster} pointerEvents="auto">
          <ControlButton
            label="⌨"
            active={keyboardOpen}
            onPress={toggleKeyboard}
          />
          <ControlButton
            label="⚙"
            active={showSettings}
            onPress={() => setShowSettings((v) => !v)}
          />
          <View style={styles.spacer} />
          <View
            style={[
              styles.statusDot,
              status === 'connected' ? styles.dotGreen : styles.dotOrange,
            ]}
          />
          <ControlButton label="✕" onPress={disconnect} />
        </View>
        {showSettings && (
          <View style={styles.settingsRow} pointerEvents="auto">
            <Text style={styles.settingsLabel}>Speed</Text>
            {SENSITIVITIES.map((s) => (
              <TouchableOpacity
                key={s.label}
                style={[styles.chip, sensitivity === s.value && styles.chipActive]}
                onPress={() => setSensitivity(s.value)}
              >
                <Text
                  style={[
                    styles.chipText,
                    sensitivity === s.value && styles.chipTextActive,
                  ]}
                >
                  {s.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      <GestureDetector gesture={gesture}>
        <View style={styles.pad}>
          <Text style={styles.padHint}>
            1 finger: move · tap: click · 2 fingers: scroll · 2-finger tap:
            right click · double-tap and hold: drag
          </Text>
        </View>
      </GestureDetector>

      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={inputValue}
        onChangeText={onChangeText}
        onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
        onSubmitEditing={() => connection.key('enter')}
        onFocus={() => setKeyboardOpen(true)}
        onBlur={() => setKeyboardOpen(false)}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType="visible-password"
        multiline={false}
        submitBehavior="submit"
      />

      {trayVisible && (
        <View
          style={[
            styles.tray,
            { left: resolvedTrayPos.x, top: resolvedTrayPos.y },
          ]}
        >
          <GestureDetector gesture={trayDrag}>
            <View style={styles.trayHandle}>
              <Text style={styles.trayHandleText}>⋮⋮</Text>
              <TouchableOpacity
                style={styles.trayClose}
                onPress={() => setTrayVisible(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.trayCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
          </GestureDetector>

          <View style={styles.trayRow}>
            {MODIFIERS.map((m) => (
              <TouchableOpacity
                key={m}
                style={[
                  styles.keyButton,
                  heldMods.has(m) && styles.keyButtonActive,
                ]}
                onPress={() => toggleModifier(m)}
              >
                <Text
                  style={[
                    styles.keyText,
                    heldMods.has(m) && styles.keyTextActive,
                  ]}
                >
                  {MODIFIER_LABEL[m]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.trayRow}>
            {TAP_KEYS.map((k) => (
              <TouchableOpacity
                key={k.id}
                style={styles.keyButton}
                onPress={() => {
                  releaseAllModifiers();
                  connection.key(k.id);
                }}
              >
                <Text style={styles.keyText}>{k.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={[styles.trayRow, styles.fRow]}>
            {F_KEYS.map((k) => (
              <TouchableOpacity
                key={k.id}
                style={[styles.keyButton, styles.fButton]}
                onPress={() => {
                  releaseAllModifiers();
                  connection.key(k.id);
                  }}
                >
                  <Text style={[styles.keyText, styles.fText]}>{k.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
      )}

      {!trayVisible && (
        <TouchableOpacity
          style={styles.trayRestore}
          onPress={() => setTrayVisible(true)}
        >
          <Text style={styles.trayRestoreText}>⋯</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function ControlButton({
  label,
  onPress,
  active = false,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.controlButton, active && styles.controlButtonActive]}
      onPress={onPress}
    >
      <Text style={styles.controlButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
  },
  banner: {
    backgroundColor: '#7a4a00',
    paddingTop: 48,
    paddingBottom: 10,
    alignItems: 'center',
  },
  bannerText: {
    color: '#ffd9a0',
    fontSize: 14,
  },
  pad: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  padHint: {
    color: '#333',
    fontSize: 12,
    textAlign: 'center',
  },
  hiddenInput: {
    position: 'absolute',
    top: -100,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  topBar: {
    paddingTop: SAFE_TOP,
    backgroundColor: '#181818',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#181818',
  },
  settingsLabel: {
    color: '#888',
    marginRight: 4,
  },
  chip: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#242424',
  },
  chipActive: {
    backgroundColor: '#4da6ff',
  },
  chipText: {
    color: '#aaa',
    fontSize: 13,
  },
  chipTextActive: {
    color: '#0a0a0a',
    fontWeight: '600',
  },
  controlCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#181818',
    gap: 6,
  },
  controlButton: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#242424',
  },
  controlButtonActive: {
    backgroundColor: '#3a3a3a',
  },
  controlButtonText: {
    color: '#ddd',
    fontSize: 16,
  },
  spacer: {
    flex: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  dotGreen: {
    backgroundColor: '#3ddc84',
  },
  dotOrange: {
    backgroundColor: '#ffb347',
  },
  tray: {
    position: 'absolute',
    width: 360,
    backgroundColor: 'rgba(24,24,24,0.95)',
    borderRadius: 12,
    padding: 6,
    gap: 4,
  },
  trayHandle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 20,
  },
  trayHandleText: {
    color: '#555',
    fontSize: 14,
  },
  trayClose: {
    position: 'absolute',
    right: 0,
    top: 0,
    padding: 4,
  },
  trayCloseText: {
    color: '#888',
    fontSize: 12,
  },
  trayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  fRow: {
    flexWrap: 'wrap',
  },
  keyButton: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    backgroundColor: '#242424',
    minWidth: 36,
    alignItems: 'center',
  },
  keyButtonActive: {
    backgroundColor: '#4da6ff',
  },
  keyText: {
    color: '#ddd',
    fontSize: 13,
  },
  keyTextActive: {
    color: '#0a0a0a',
    fontWeight: '600',
  },
  fButton: {
    minWidth: 0,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  fText: {
    fontSize: 11,
  },
  trayRestore: {
    position: 'absolute',
    right: 16,
    bottom: 132 + SAFE_BOTTOM,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#242424',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trayRestoreText: {
    color: '#ddd',
    fontSize: 20,
  },
});
