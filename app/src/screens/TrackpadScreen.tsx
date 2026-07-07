import { LinearGradient } from 'expo-linear-gradient';
import { NavigationBar } from 'expo-navigation-bar';
import { type ComponentProps, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card } from '../components/Card';
import { Icon } from '../components/Icon';
import { KeyPanel, type ModifierKey } from '../components/KeyPanel';
import { Slider } from '../components/Slider';
import type { Connection } from '../connection';
import {
  DEFAULT_SENSITIVITY,
  MAX_SENSITIVITY,
  MIN_SENSITIVITY,
  SENSITIVITY_STEP,
} from '../sensitivity';
import { radius, spacing, useTheme } from '../theme';
import { INITIAL_TOP_BAR_STATE, reduceTopBar } from '../topBarVisibility';

interface Props {
  connection: Connection;
  onDisconnect: () => void;
  initialSensitivity?: number;
  initialFabPosition?: { x: number; y: number } | null;
  floatingKeyboard?: boolean;
  onFabPositionChange?: (pos: { x: number; y: number }) => void;
}

type Status = 'connected' | 'reconnecting' | 'reauth';

const SCROLL_SENSITIVITY = 0.05;
// Extra upward travel when retracted so the Card's soft shadow clears the clip.
const DRAWER_HIDE_CLEARANCE = 16;
const DOUBLE_TAP_DRAG_WINDOW_MS = 300;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const KEYBOARD_SENTINEL = ' ';
const FAB_SIZE = 52;
const FAB_DRAG_THRESHOLD = 8;

export default function TrackpadScreen({
  connection,
  onDisconnect,
  initialSensitivity,
  initialFabPosition,
  floatingKeyboard = true,
  onFabPositionChange,
}: Props) {
  const theme = useTheme();
  const [status, setStatus] = useState<Status>('connected');
  const [sensitivity, setSensitivity] = useState<number>(initialSensitivity ?? DEFAULT_SENSITIVITY);
  const [topBarState, dispatchTopBar] = useReducer(reduceTopBar, INITIAL_TOP_BAR_STATE);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [keysPanelOpen, setKeysPanelOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [inputValue, setInputValue] = useState(KEYBOARD_SENTINEL);
  const [heldMods, setHeldMods] = useState<Set<ModifierKey>>(new Set());
  const [trayPos, setTrayPos] = useState<{ x: number; y: number } | null>(null);
  const [fabPos, setFabPos] = useState<{ x: number; y: number } | null>(initialFabPosition ?? null);

  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();

  const moveDx = useSharedValue(0);
  const moveDy = useSharedValue(0);
  const scrollDx = useSharedValue(0);
  const scrollDy = useSharedValue(0);
  const sensitivitySV = useSharedValue(sensitivity);
  const drawerProgress = useSharedValue(1);
  const dragStartProgress = useSharedValue(1);
  const drawerContentSV = useSharedValue(56);

  const drawerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -(drawerContentSV.value + DRAWER_HIDE_CLEARANCE) * (1 - drawerProgress.value) },
    ],
  }));

  const onDrawerContentLayout = useCallback(
    (e: { nativeEvent: { layout: { height: number } } }) => {
      drawerContentSV.value = e.nativeEvent.layout.height;
    },
    [drawerContentSV],
  );

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

  useEffect(() => {
    if (!topBarState.visible || topBarState.settingsOpen) return;
    const id = setTimeout(() => dispatchTopBar({ type: 'IDLE_TIMEOUT' }), 3000);
    return () => clearTimeout(id);
  }, [topBarState.visible, topBarState.settingsOpen]);

  useEffect(() => {
    drawerProgress.value = withTiming(topBarState.visible ? 1 : 0, { duration: 180 });
  }, [topBarState.visible, drawerProgress]);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // setHidden natively applies swipe-to-reveal (BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE).
    NavigationBar.setHidden(true);
    return () => NavigationBar.setHidden(false);
  }, []);

  const onMoveStart = useCallback(() => {
    dispatchTopBar({ type: 'DRAG_START' });
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
    .activeOffsetX([-3, 3])
    .activeOffsetY([-3, 3])
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

  const onScrollStart = useCallback(() => {
    dispatchTopBar({ type: 'DRAG_START' });
  }, []);

  const scrollPan = Gesture.Pan()
    .minPointers(2)
    .maxPointers(2)
    .onStart(() => {
      'worklet';
      runOnJS(onScrollStart)();
    })
    .onChange((e) => {
      'worklet';
      scrollDx.value += -e.changeX * SCROLL_SENSITIVITY;
      scrollDy.value += -e.changeY * SCROLL_SENSITIVITY;
    });

  const gesture = Gesture.Race(scrollPan, twoFingerTap, movePan, singleTap);

  const drawerPan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      dragStartProgress.value = drawerProgress.value;
    })
    .onUpdate((e) => {
      'worklet';
      const span = drawerContentSV.value || 1;
      const next = dragStartProgress.value + e.translationY / span;
      drawerProgress.value = Math.min(1, Math.max(0, next));
    })
    .onEnd((e) => {
      'worklet';
      const span = drawerContentSV.value || 1;
      const projected = drawerProgress.value + (e.velocityY / span) * 0.1;
      const open = projected >= 0.5;
      drawerProgress.value = withTiming(open ? 1 : 0, { duration: 160 });
      runOnJS(dispatchTopBar)(open ? { type: 'DRAWER_OPEN' } : { type: 'DRAWER_CLOSE' });
    });

  const drawerTap = Gesture.Tap()
    .maxDuration(250)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) {
        dispatchTopBar(topBarState.visible ? { type: 'DRAWER_CLOSE' } : { type: 'DRAWER_OPEN' });
      }
    });

  const drawerGesture = Gesture.Exclusive(drawerPan, drawerTap);

  const toggleKeyboard = () => {
    setKeyboardOpen((prev) => {
      if (!prev) {
        inputRef.current?.focus();
        return true;
      }
      inputRef.current?.blur();
      return false;
    });
  };

  const toggleKeysPanel = () => {
    setKeysPanelOpen((prev) => {
      if (prev) setTrayPos(null);
      return !prev;
    });
  };

  const closeKeysPanel = () => {
    setKeysPanelOpen(false);
    setTrayPos(null);
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

  const trayW = Math.min(window.width - 32, 360);
  const trayH = 168;

  const trayDrag = Gesture.Pan()
    .runOnJS(true)
    .blocksExternalGesture(gesture as never)
    .onUpdate((e) => {
      const x = Math.max(0, Math.min(window.width - trayW, e.absoluteX - trayW / 2));
      const y = Math.max(
        0,
        Math.min(window.height - trayH - keyboardHeight - insets.bottom, e.absoluteY - 16),
      );
      setTrayPos({ x, y });
    });

  const resolvedTrayPos = trayPos ?? {
    x: window.width - trayW - 16,
    y: window.height - trayH - 16 - keyboardHeight - insets.bottom,
  };

  const clampFabPos = (pos: { x: number; y: number }) => ({
    x: Math.max(spacing.sm, Math.min(window.width - FAB_SIZE - spacing.sm, pos.x)),
    y: Math.max(
      insets.top + spacing.lg,
      Math.min(window.height - FAB_SIZE - keyboardHeight - insets.bottom - spacing.sm, pos.y),
    ),
  });

  const fabPan = Gesture.Pan()
    .runOnJS(true)
    .blocksExternalGesture(gesture as never)
    .activeOffsetX([-FAB_DRAG_THRESHOLD, FAB_DRAG_THRESHOLD])
    .activeOffsetY([-FAB_DRAG_THRESHOLD, FAB_DRAG_THRESHOLD])
    .onUpdate((e) => {
      setFabPos(clampFabPos({ x: e.absoluteX - FAB_SIZE / 2, y: e.absoluteY - FAB_SIZE / 2 }));
    })
    .onEnd((e) => {
      const pos = clampFabPos({ x: e.absoluteX - FAB_SIZE / 2, y: e.absoluteY - FAB_SIZE / 2 });
      setFabPos(pos);
      onFabPositionChange?.(pos);
    });

  const fabTap = Gesture.Tap()
    .maxDuration(250)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) toggleKeyboard();
    });

  const fabGesture = Gesture.Exclusive(fabPan, fabTap);

  const resolvedFabPos = fabPos
    ? clampFabPos(fabPos)
    : {
        x: window.width - FAB_SIZE - spacing.lg,
        y: window.height - FAB_SIZE - spacing.lg - keyboardHeight - insets.bottom,
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

      <View style={[styles.drawerRoot, { paddingTop: insets.top }]} pointerEvents="box-none">
        <GestureDetector gesture={drawerGesture}>
          <View
            style={styles.drawerHandle}
            accessibilityRole="button"
            accessibilityLabel={topBarState.visible ? 'Hide controls' : 'Show controls'}
            accessibilityHint="Double tap to toggle the trackpad controls"
          >
            <View style={[styles.drawerHandlePill, { backgroundColor: theme.border }]} />
          </View>
        </GestureDetector>
        <View style={styles.drawerClip} pointerEvents="box-none">
          <Animated.View
            onLayout={onDrawerContentLayout}
            style={drawerAnimatedStyle}
            pointerEvents={topBarState.visible ? 'auto' : 'box-none'}
          >
            <Card
              style={[styles.controlCluster, { backgroundColor: theme.surface }]}
              padded={false}
            >
              {!floatingKeyboard && (
                <ControlButton
                  icon="keypad-outline"
                  label="Keyboard"
                  active={keyboardOpen}
                  onPress={toggleKeyboard}
                  themeColor={theme.primary}
                />
              )}
              <ControlButton
                icon="apps-outline"
                label="Special keys"
                active={keysPanelOpen}
                onPress={toggleKeysPanel}
                themeColor={theme.primary}
              />
              <ControlButton
                icon="settings-outline"
                label="Settings"
                active={topBarState.settingsOpen}
                onPress={() => dispatchTopBar({ type: 'SETTINGS_TOGGLE' })}
                themeColor={theme.primary}
              />
              <View style={styles.spacer} />
              <ControlButton
                icon="close"
                label="Disconnect"
                onPress={disconnect}
                themeColor={theme.danger}
              />
            </Card>
            {topBarState.settingsOpen && (
              <Card style={styles.settingsCard} padded={false}>
                <View style={styles.settingsRow}>
                  <Text style={[styles.settingsLabel, { color: theme.muted }]}>Speed</Text>
                  <Text style={[styles.settingsValue, { color: theme.text }]}>
                    {sensitivity.toFixed(1)}x
                  </Text>
                </View>
                <Slider
                  accessibilityLabel="Pointer speed"
                  value={sensitivity}
                  min={MIN_SENSITIVITY}
                  max={MAX_SENSITIVITY}
                  step={SENSITIVITY_STEP}
                  onValueChange={setSensitivity}
                />
              </Card>
            )}
          </Animated.View>
        </View>
      </View>

      <View style={styles.body}>
        <GestureDetector gesture={gesture}>
          <LinearGradient
            colors={theme.padGradient.colors}
            start={theme.padGradient.start}
            end={theme.padGradient.end}
            style={[styles.pad, { borderColor: theme.border }]}
          >
            <Text style={[styles.padHint, { color: theme.muted }]}>
              1 finger: move · tap: click · 2 fingers: scroll · 2-finger tap: right click ·
              double-tap and hold: drag
            </Text>
          </LinearGradient>
        </GestureDetector>
      </View>

      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={inputValue}
        onChangeText={onChangeText}
        onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
        onSubmitEditing={() => connection.key('enter')}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType="visible-password"
        multiline={false}
        submitBehavior="submit"
      />

      {keysPanelOpen && (
        <View
          style={[
            styles.tray,
            {
              left: resolvedTrayPos.x,
              top: resolvedTrayPos.y,
              width: trayW,
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
                onPress={closeKeysPanel}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Hide special keys tray"
              >
                <Icon name="close" size={16} color={theme.muted} />
              </TouchableOpacity>
            </View>
          </GestureDetector>
          <KeyPanel
            heldMods={heldMods}
            onModifier={toggleModifier}
            onKey={(id) => {
              releaseAllModifiers();
              connection.key(id);
            }}
          />
        </View>
      )}

      {floatingKeyboard && (
        <GestureDetector gesture={fabGesture}>
          <View
            style={[
              styles.fab,
              theme.shadow,
              {
                left: resolvedFabPos.x,
                top: resolvedFabPos.y,
                width: FAB_SIZE,
                height: FAB_SIZE,
                backgroundColor: keyboardOpen ? theme.primary : theme.surface,
                borderColor: keyboardOpen ? theme.primary : theme.border,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={keyboardOpen ? 'Hide keyboard' : 'Show keyboard'}
            accessibilityState={{ selected: keyboardOpen }}
          >
            <Icon
              name={keyboardOpen ? 'chevron-down' : 'keypad-outline'}
              size={22}
              color={keyboardOpen ? theme.onGradient : theme.primary}
            />
          </View>
        </GestureDetector>
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
      hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Icon name={icon} size={16} color={active ? theme.onGradient : themeColor} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
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
  drawerRoot: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    paddingHorizontal: spacing.md,
  },
  drawerClip: {
    overflow: 'hidden',
  },
  drawerHandle: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  drawerHandlePill: {
    width: 44,
    height: 5,
    borderRadius: 3,
  },
  controlCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
    borderRadius: radius.pill,
  },
  controlButton: {
    borderRadius: radius.pill,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer: {
    flex: 1,
  },
  settingsCard: {
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingsValue: {
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  settingsLabel: {
    fontSize: 14,
    fontWeight: '600',
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
  fab: {
    position: 'absolute',
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 15,
  },
  body: {
    flex: 1,
  },
});
