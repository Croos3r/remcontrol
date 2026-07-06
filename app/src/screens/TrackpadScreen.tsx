import { LinearGradient } from 'expo-linear-gradient';
import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
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
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icon';
import type { Connection } from '../connection';
import { radius, spacing, useTheme } from '../theme';

interface Props {
  connection: Connection;
  onDisconnect: () => void;
}

type Status = 'connected' | 'reconnecting' | 'reauth';

const SENSITIVITIES = [
  { label: 'Slow', value: 0.8 },
  { label: 'Normal', value: 1.5 },
  { label: 'Fast', value: 2.5 },
] as const;

const SCROLL_SENSITIVITY = 0.05;
const DOUBLE_TAP_DRAG_WINDOW_MS = 300;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const KEYBOARD_SENTINEL = ' ';

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
  const theme = useTheme();
  const [status, setStatus] = useState<Status>('connected');
  const [sensitivity, setSensitivity] = useState<number>(1.5);
  const [showSettings, setShowSettings] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputValue, setInputValue] = useState(KEYBOARD_SENTINEL);
  const [heldMods, setHeldMods] = useState<Set<ModifierKey>>(new Set());
  const [trayVisible, setTrayVisible] = useState(false);
  const [trayPos, setTrayPos] = useState<{ x: number; y: number } | null>(null);

  const insets = useSafeAreaInsets();

  const moveDx = useSharedValue(0);
  const moveDy = useSharedValue(0);
  const scrollDx = useSharedValue(0);
  const scrollDy = useSharedValue(0);
  const sensitivitySV = useSharedValue(sensitivity);

  const inputRef = useRef<TextInput>(null);
  const lastTapRef = useRef(0);
  const draggingRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sensitivitySV.value = sensitivity;
  }, [sensitivity, sensitivitySV]);

  // Move send cadence is driven from the JS thread so it stays at a steady
  // ~16ms regardless of UI-thread frame bursts. The UI-thread worklet just
  // accumulates deltas into SharedValues; this interval drains and ships them.
  useEffect(() => {
    const id = setInterval(() => {
      const dx = moveDx.value;
      const dy = moveDy.value;
      if (dx !== 0 || dy !== 0) {
        moveDx.value = moveDx.value - dx;
        moveDy.value = moveDy.value - dy;
        connection.move(dx, dy);
      }
      const sx = scrollDx.value;
      const sy = scrollDy.value;
      if (sx !== 0 || sy !== 0) {
        scrollDx.value = scrollDx.value - sx;
        scrollDy.value = scrollDy.value - sy;
        connection.scroll(sx, sy);
      }
    }, 16);
    return () => clearInterval(id);
  }, [connection]);

  useEffect(() => {
    const scheduleReconnect = () => {
      if (retryRef.current >= RECONNECT_DELAYS_MS.length) {
        onDisconnect();
        return;
      }
      const delay = RECONNECT_DELAYS_MS[retryRef.current];
      retryRef.current += 1;
      retryTimerRef.current = setTimeout(() => connection.connect(), delay);
    };
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
      onAuthFailure: () => {
        // Token rotated server-side: stop hammering the server and surface a
        // re-pair prompt instead of retrying blindly (M-5).
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        setStatus('reauth');
      },
    });
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

  const onMoveStart = useCallback(() => {
    if (Date.now() - lastTapRef.current < DOUBLE_TAP_DRAG_WINDOW_MS) {
      draggingRef.current = true;
      connection.buttonDown('left');
    }
  }, [connection]);
  const onMoveEnd = useCallback(() => {
    if (draggingRef.current) {
      draggingRef.current = false;
      connection.buttonUp('left');
    }
  }, [connection]);

  const movePan = Gesture.Pan()
    .maxPointers(1)
    .activeOffsetX(3)
    .activeOffsetY(3)
    .onStart(() => {
      'worklet';
      runOnJS(onMoveStart)();
    })
    .onChange((e) => {
      'worklet';
      moveDx.value += e.changeX * sensitivitySV.value;
      moveDy.value += e.changeY * sensitivitySV.value;
    })
    .onEnd(() => {
      'worklet';
      runOnJS(onMoveEnd)();
    });

  const singleTap = Gesture.Tap()
    .maxDuration(200)
    .maxDistance(10)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (!success) return;
      lastTapRef.current = Date.now();
      connection.click('left');
    });

  const twoFingerTap = Gesture.Tap()
    .minPointers(2)
    .maxDuration(250)
    .maxDistance(15)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) connection.click('right');
    });

  const scrollPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onChange((e) => {
      'worklet';
      scrollDx.value += -e.changeX * SCROLL_SENSITIVITY;
      scrollDy.value += -e.changeY * SCROLL_SENSITIVITY;
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
    const suffix = text.startsWith(KEYBOARD_SENTINEL) ? text.slice(KEYBOARD_SENTINEL.length) : text;
    if (suffix === prevSuffix) {
      setInputValue(text);
      return;
    }
    if (suffix.length > prevSuffix.length && suffix.startsWith(prevSuffix)) {
      connection.text(suffix.slice(prevSuffix.length));
    } else if (prevSuffix.length > suffix.length && prevSuffix.startsWith(suffix)) {
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
        Math.min(win.height - h - keyboardHeight - insets.bottom, e.absoluteY - 16),
      );
      setTrayPos({ x, y });
    });

  const screen = Dimensions.get('window');
  const trayW = Math.min(screen.width - 32, 360);
  const trayH = 168;
  const resolvedTrayPos = trayPos ?? {
    x: screen.width - trayW - 16,
    y: screen.height - trayH - 132 - insets.bottom,
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.appBg }]}>
      {status === 'reconnecting' && (
        <View
          style={[
            styles.banner,
            { backgroundColor: theme.warnTint, paddingTop: insets.top + spacing.sm },
          ]}
        >
          <Icon name="refresh" size={16} color={theme.warn} />
          <Text style={[styles.bannerText, { color: theme.warn }]}>
            Connection lost, reconnecting…
          </Text>
        </View>
      )}

      {status === 'reauth' && (
        <View
          style={[
            styles.banner,
            { backgroundColor: theme.dangerTint, paddingTop: insets.top + spacing.sm },
          ]}
        >
          <Icon name="alert-circle-outline" size={16} color={theme.danger} />
          <Text style={[styles.bannerText, { color: theme.danger }]}>
            Token rejected. Re-pair on the Connect screen.
          </Text>
          <TouchableOpacity
            style={[styles.reauthButton, { backgroundColor: theme.danger }]}
            onPress={onDisconnect}
          >
            <Text style={styles.reauthButtonText}>Re-pair</Text>
          </TouchableOpacity>
        </View>
      )}

      <View
        style={[styles.topBar, { paddingTop: insets.top + spacing.sm }]}
        pointerEvents="box-none"
      >
        <Card style={[styles.controlCluster, { backgroundColor: theme.surface }]} padded={false}>
          <ControlButton
            icon="keypad-outline"
            label="Keyboard"
            active={keyboardOpen}
            onPress={toggleKeyboard}
            themeColor={theme.primary}
          />
          <ControlButton
            icon="settings-outline"
            label="Settings"
            active={showSettings}
            onPress={() => setShowSettings((v) => !v)}
            themeColor={theme.primary}
          />
          <View style={styles.spacer} />
          <View
            style={[
              styles.statusDot,
              status === 'connected'
                ? { backgroundColor: theme.ok }
                : { backgroundColor: theme.warn },
            ]}
          />
          <ControlButton
            icon="close"
            label="Disconnect"
            onPress={disconnect}
            themeColor={theme.danger}
          />
        </Card>
        {showSettings && (
          <Card style={styles.settingsCard} padded={false}>
            <Text style={[styles.settingsLabel, { color: theme.muted }]}>Speed</Text>
            {SENSITIVITIES.map((s) => (
              <Chip
                key={s.label}
                label={s.label}
                active={sensitivity === s.value}
                onPress={() => setSensitivity(s.value)}
              />
            ))}
          </Card>
        )}
      </View>

      <GestureDetector gesture={gesture}>
        <LinearGradient
          colors={theme.padGradient.colors}
          start={theme.padGradient.start}
          end={theme.padGradient.end}
          style={[styles.pad, { borderColor: theme.border }]}
        >
          <Text style={[styles.padHint, { color: theme.muted }]}>
            1 finger: move · tap: click · 2 fingers: scroll · 2-finger tap: right click · double-tap
            and hold: drag
          </Text>
        </LinearGradient>
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
            {
              left: resolvedTrayPos.x,
              top: resolvedTrayPos.y,
              backgroundColor: theme.surface,
              borderColor: theme.border,
            },
          ]}
        >
          <GestureDetector gesture={trayDrag}>
            <View style={[styles.trayHandle, { borderBottomColor: theme.border }]}>
              <Icon name="reorder-three-outline" size={20} color={theme.muted} />
              <TouchableOpacity
                style={styles.trayClose}
                onPress={() => setTrayVisible(false)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Hide keyboard tray"
              >
                <Icon name="close" size={16} color={theme.muted} />
              </TouchableOpacity>
            </View>
          </GestureDetector>

          <View style={styles.trayRow}>
            {MODIFIERS.map((m) => (
              <KeyButton
                key={m}
                label={MODIFIER_LABEL[m]}
                active={heldMods.has(m)}
                onPress={() => toggleModifier(m)}
              />
            ))}
          </View>

          <View style={styles.trayRow}>
            {TAP_KEYS.map((k) => (
              <KeyButton
                key={k.id}
                label={k.label}
                onPress={() => {
                  releaseAllModifiers();
                  connection.key(k.id);
                }}
              />
            ))}
          </View>

          <View style={[styles.trayRow, styles.fRow]}>
            {F_KEYS.map((k) => (
              <KeyButton
                key={k.id}
                label={k.label}
                small
                onPress={() => {
                  releaseAllModifiers();
                  connection.key(k.id);
                }}
              />
            ))}
          </View>
        </View>
      )}

      {!trayVisible && (
        <TouchableOpacity
          style={[
            styles.trayRestore,
            { bottom: 132 + insets.bottom, backgroundColor: theme.primary },
          ]}
          onPress={() => setTrayVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Show keyboard tray"
        >
          <Icon name="keypad-outline" size={22} color={theme.onGradient} />
        </TouchableOpacity>
      )}
    </View>
  );
}

function ControlButton({
  icon,
  label,
  onPress,
  active = false,
  themeColor,
}: {
  icon: ComponentProps<typeof Icon>['name'];
  label: string;
  onPress: () => void;
  active?: boolean;
  themeColor: string;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.controlButton,
        active
          ? { backgroundColor: theme.primary }
          : { backgroundColor: theme.softSurface, borderColor: theme.border, borderWidth: 1 },
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Icon name={icon} size={20} color={active ? theme.onGradient : themeColor} />
    </TouchableOpacity>
  );
}

function KeyButton({
  label,
  onPress,
  active = false,
  small = false,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  small?: boolean;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.keyButton,
        active
          ? { backgroundColor: theme.primary, borderColor: theme.primary }
          : { backgroundColor: theme.softSurface, borderColor: theme.border },
        small && styles.keyButtonSmall,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[
          styles.keyText,
          { color: active ? theme.onGradient : theme.text },
          small && styles.fText,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  bannerText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  reauthButton: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  reauthButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  topBar: {
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  controlCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderRadius: radius.pill,
  },
  controlButton: {
    borderRadius: radius.pill,
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer: {
    flex: 1,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginHorizontal: spacing.xs,
  },
  settingsCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
  },
  settingsLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginRight: spacing.xs,
  },
  pad: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    margin: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  padHint: {
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  hiddenInput: {
    position: 'absolute',
    top: -100,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0,
  },
  tray: {
    position: 'absolute',
    width: 360,
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  trayHandle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 24,
    borderBottomWidth: 1,
    marginBottom: spacing.xs,
  },
  trayClose: {
    position: 'absolute',
    right: 0,
    top: 0,
    padding: spacing.xs,
  },
  trayRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  fRow: {
    flexWrap: 'wrap',
  },
  keyButton: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
    minWidth: 38,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  keyButtonSmall: {
    minWidth: 0,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: spacing.xs + 2,
    minHeight: 36,
  },
  keyText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  fText: {
    fontSize: 11,
  },
  trayRestore: {
    position: 'absolute',
    right: spacing.lg,
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#062B66',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
});
