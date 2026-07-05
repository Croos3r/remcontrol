import { useEffect, useRef, useState } from 'react';
import {
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

export default function TrackpadScreen({ connection, onDisconnect }: Props) {
  const [status, setStatus] = useState<Status>('connected');
  const [sensitivity, setSensitivity] = useState<number>(1.5);
  const [showSettings, setShowSettings] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

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
    if (text.length > KEYBOARD_SENTINEL.length) {
      connection.text(text.slice(KEYBOARD_SENTINEL.length));
    }
    inputRef.current?.setNativeProps({ text: KEYBOARD_SENTINEL });
  };

  const onKeyPress = (key: string) => {
    if (key === 'Backspace') connection.key('backspace');
  };

  const disconnect = () => {
    connection.close();
    onDisconnect();
  };

  return (
    <View style={styles.container}>
      {status === 'reconnecting' && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>Connection lost, reconnecting…</Text>
        </View>
      )}
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
        defaultValue={KEYBOARD_SENTINEL}
        onChangeText={onChangeText}
        onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
        onSubmitEditing={() => connection.key('enter')}
        onFocus={() => setKeyboardOpen(true)}
        onBlur={() => setKeyboardOpen(false)}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        multiline={false}
        submitBehavior="submit"
      />

      {showSettings && (
        <View style={styles.settingsRow}>
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

      <View style={styles.toolbar}>
        <ToolbarButton
          label="⌨"
          active={keyboardOpen}
          onPress={toggleKeyboard}
        />
        <ToolbarButton label="Esc" onPress={() => connection.key('esc')} />
        <ToolbarButton label="Tab" onPress={() => connection.key('tab')} />
        <ToolbarButton label="↑" onPress={() => connection.key('up')} />
        <ToolbarButton label="↓" onPress={() => connection.key('down')} />
        <ToolbarButton label="←" onPress={() => connection.key('left')} />
        <ToolbarButton label="→" onPress={() => connection.key('right')} />
        <ToolbarButton label="⏎" onPress={() => connection.key('enter')} />
        <ToolbarButton
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
        <ToolbarButton label="✕" onPress={disconnect} />
      </View>
    </View>
  );
}

function ToolbarButton({
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
      style={[styles.toolbarButton, active && styles.toolbarButtonActive]}
      onPress={onPress}
    >
      <Text style={styles.toolbarButtonText}>{label}</Text>
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
    justifyContent: 'flex-end',
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
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    paddingBottom: 24,
    backgroundColor: '#181818',
    gap: 4,
  },
  toolbarButton: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#242424',
  },
  toolbarButtonActive: {
    backgroundColor: '#3a3a3a',
  },
  toolbarButtonText: {
    color: '#ddd',
    fontSize: 14,
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
});
