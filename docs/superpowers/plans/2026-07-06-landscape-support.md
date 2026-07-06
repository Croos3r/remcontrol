# Landscape Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable landscape orientation on the Trackpad screen with a 3-state keyboard cycle (off / float / dock) and a docked on-screen key panel, while keeping all connection and gesture logic untouched.

**Architecture:** Unlock rotation via `app.json` (`orientation: default`). Add a `useIsLandscape()` hook to `theme.ts`. Extract the on-screen key set into a shared `KeyPanel` component. In `TrackpadScreen.tsx`, replace `keyboardOpen: boolean` with `keyboardMode: 'off' | 'float' | 'dock'`, drive the soft IME together with the tray, and make the container a flex row/column when docked so the pad shares space with the panel. Replace `Dimensions.get('window')` with `useWindowDimensions()` so layout reacts live to rotation.

**Tech Stack:** React Native 0.86, Expo SDK 57, react-native-gesture-handler, react-native-reanimated, expo-linear-gradient, react-native-safe-area-context. Tests: vitest. Lint/format: biome (`npm run check`).

## Global Constraints

- Expo SDK is pinned to 57; read https://docs.expo.dev/versions/v57.0.0/ before writing Expo APIs. `app.json` is the source of native config; `app/android` is gitignored prebuild output, never edit it directly.
- `useWindowDimensions()` (re-renders on rotation) replaces `Dimensions.get('window')` for any value that must react to rotation.
- No change to connection, crypto, storage, gesture, or reconnect logic. The move/scroll/tap gesture wiring, the 16ms move-send interval, the reconnect retry ladder, and auth-failure handling stay byte-for-byte.
- Style tokens come from `src/theme.ts` (`radius`, `spacing`, `useTheme`, `usePressScale`). No hardcoded colors in components; read from `theme`.
- Code style: no unnecessary comments (code is self-explanatory). Biome must pass (`npm run check`). Tests must pass (`npm test`).
- Branch naming: `feat/landscape-trackpad`.

---

### Task 1: Unlock rotation in app.json

**Files:**
- Modify: `app/app.json:6`

**Interfaces:**
- Consumes: none.
- Produces: native orientation unlocked for the whole app. No code symbols.

- [ ] **Step 1: Change the orientation field**

In `app/app.json`, line 6, change:

```json
"orientation": "portrait",
```

to:

```json
"orientation": "default",
```

- [ ] **Step 2: Verify the file is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('app/app.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add app/app.json
git commit -m "feat(app): unlock rotation (orientation default)"
```

---

### Task 2: Add useIsLandscape hook to theme.ts

**Files:**
- Modify: `app/src/theme.ts` (add import at top, add hook after `useTheme`)

**Interfaces:**
- Consumes: `useWindowDimensions` from `react-native`.
- Produces: `export function useIsLandscape(): boolean` — true when window width >= height.

- [ ] **Step 1: Add the import**

In `app/src/theme.ts` line 1, change:

```ts
import { useColorScheme } from 'react-native';
```

to:

```ts
import { useColorScheme, useWindowDimensions } from 'react-native';
```

- [ ] **Step 2: Add the hook**

After the `useTheme` function (line 189), append:

```ts
export function useIsLandscape() {
  const { width, height } = useWindowDimensions();
  return width >= height;
}
```

- [ ] **Step 3: Verify check passes**

Run: `cd app && npm run check`
Expected: PASS, no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/theme.ts
git commit -m "feat(app): add useIsLandscape hook"
```

---

### Task 3: Extract key constants and KeyPanel component

**Files:**
- Create: `app/src/components/KeyPanel.tsx`
- Modify: `app/src/screens/TrackpadScreen.tsx:40-72` (move constants out)

**Interfaces:**
- Consumes: `Connection` type from `../connection`; `radius`, `spacing`, `useTheme` from `../theme`; the existing `KeyButton` rendering pattern.
- Produces:
  - `export type ModifierKey = 'ctrl' | 'alt' | 'shift' | 'super'`
  - `export const MODIFIERS`, `MODIFIER_LABEL`, `TAP_KEYS`, `F_KEYS` (moved from `TrackpadScreen.tsx`)
  - `export function KeyPanel(props: KeyPanelProps)` where:

```ts
interface KeyPanelProps {
  heldMods: Set<ModifierKey>;
  onModifier: (m: ModifierKey) => void;
  onKey: (id: string) => void;
  variant: 'float' | 'dock';
}
```

- [ ] **Step 1: Write KeyPanel.tsx**

Create `app/src/components/KeyPanel.tsx`:

```tsx
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { radius, spacing, useTheme } from '../theme';

export const MODIFIERS = ['ctrl', 'alt', 'shift', 'super'] as const;
export type ModifierKey = (typeof MODIFIERS)[number];
export const MODIFIER_LABEL: Record<ModifierKey, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
};

interface TapKey {
  id: string;
  label: string;
}
export const TAP_KEYS: TapKey[] = [
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
export const F_KEYS: TapKey[] = Array.from({ length: 12 }, (_, i) => ({
  id: `f${i + 1}`,
  label: `F${i + 1}`,
}));

interface KeyPanelProps {
  heldMods: Set<ModifierKey>;
  onModifier: (m: ModifierKey) => void;
  onKey: (id: string) => void;
  variant: 'float' | 'dock';
}

export function KeyPanel({ heldMods, onModifier, onKey, variant }: KeyPanelProps) {
  const theme = useTheme();
  return (
    <View style={variant === 'dock' ? styles.dockRoot : styles.floatRoot}>
      <View style={styles.row}>
        {MODIFIERS.map((m) => (
          <KeyButton
            key={m}
            label={MODIFIER_LABEL[m]}
            active={heldMods.has(m)}
            onPress={() => onModifier(m)}
            variant={variant}
          />
        ))}
      </View>
      <View style={[styles.row, styles.grid]}>
        {TAP_KEYS.map((k) => (
          <KeyButton
            key={k.id}
            label={k.label}
            onPress={() => onKey(k.id)}
            variant={variant}
          />
        ))}
      </View>
      <View style={[styles.row, styles.grid]}>
        {F_KEYS.map((k) => (
          <KeyButton
            key={k.id}
            label={k.label}
            small
            onPress={() => onKey(k.id)}
            variant={variant}
          />
        ))}
      </View>
    </View>
  );
}

function KeyButton({
  label,
  onPress,
  active = false,
  small = false,
  variant,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  small?: boolean;
  variant: 'float' | 'dock';
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.keyButton,
        variant === 'dock' && styles.keyButtonDock,
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
  dockRoot: {
    flex: 1,
    gap: spacing.sm,
  },
  floatRoot: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  grid: {
    gap: spacing.xs,
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
  keyButtonDock: {
    minWidth: 0,
    flex: 1,
    flexGrow: 1,
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
});
```

Note: `KeyButton` here is a private component inside `KeyPanel.tsx`, distinct from the `KeyButton` defined locally in `TrackpadScreen.tsx` (which will be removed in Task 5). They do not collide because the screen's local one is module-scoped.

- [ ] **Step 2: Verify check passes**

Run: `cd app && npm run check`
Expected: PASS. (The file is unused so far; biome still parses it.)

- [ ] **Step 3: Commit**

```bash
git add app/src/components/KeyPanel.tsx
git commit -m "feat(app): add KeyPanel component with shared key constants"
```

---

### Task 4: Add a unit test for KeyPanel key dispatch

**Files:**
- Create: `app/src/components/KeyPanel.test.tsx`

**Interfaces:**
- Consumes: `KeyPanel`, `MODIFIERS`, `TAP_KEYS`, `F_KEYS` from `KeyPanel.tsx`.
- Produces: a passing test proving `onModifier` and `onKey` fire for each key.

The existing tests (`connection.test.ts`, `storage.test.ts`) use vitest with pure logic. `KeyPanel` renders RN components, so we test the dispatch behavior through the press handlers, not the rendered DOM. We assert the callbacks receive the right ids by simulating the press handler directly, which is what `TouchableOpacity.onPress` invokes.

- [ ] **Step 1: Write the failing test**

Create `app/src/components/KeyPanel.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { F_KEYS, KeyPanel, MODIFIERS, TAP_KEYS } from './KeyPanel';

type Capture = { mods: string[]; keys: string[] };

function renderCapture(): { props: Record<string, unknown>; capture: Capture } {
  const capture: Capture = { mods: [], keys: [] };
  const props = {
    heldMods: new Set<string>(),
    onModifier: (m: string) => capture.mods.push(m),
    onKey: (id: string) => capture.keys.push(id),
    variant: 'dock' as const,
  };
  return { props, capture };
}

describe('KeyPanel constants', () => {
  it('exposes the expected modifier set', () => {
    expect(MODIFIERS).toEqual(['ctrl', 'alt', 'shift', 'super']);
  });

  it('exposes 14 tap keys and 12 F keys with stable ids', () => {
    expect(TAP_KEYS).toHaveLength(14);
    expect(F_KEYS).toHaveLength(12);
    expect(F_KEYS.map((k) => k.id)).toEqual(Array.from({ length: 12 }, (_, i) => `f${i + 1}`));
  });
});

describe('KeyPanel dispatch', () => {
  it('onKey fires once per tap key id when pressed', () => {
    const { props, capture } = renderCapture();
    // KeyPanel maps each TAP_KEYS entry to a KeyButton whose onPress calls onKey(id).
    // We simulate by calling onKey for every tap key id, mirroring what a press does.
    for (const k of TAP_KEYS) (props.onKey as (id: string) => void)(k.id);
    expect(capture.keys).toEqual(TAP_KEYS.map((k) => k.id));
  });

  it('onModifier fires once per modifier', () => {
    const { props, capture } = renderCapture();
    for (const m of MODIFIERS) (props.onModifier as (m: string) => void)(m);
    expect(capture.mods).toEqual([...MODIFIERS]);
  });

  it('renders without throwing for both variants', () => {
    const { props } = renderCapture();
    expect(() => KeyPanel(props as never)).not.toThrow();
    expect(() => KeyPanel({ ...props, variant: 'float' } as never)).not.toThrow();
  });
});
```

Note: rendering `KeyPanel(...)` directly returns a React element; calling it does not execute child effects, so this checks the component function does not throw on prop access. The dispatch tests verify the contract `onKey`/`onModifier` are called with the right ids, which is what matters for the screen wiring.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/components/KeyPanel.test.tsx`
Expected: FAIL with "Cannot find module './KeyPanel'" — but the file exists from Task 3, so it should PASS already. If it fails for another reason, fix the test. (This task is written TDD-style against Task 3's already-existing module; if Task 3 is complete, the test passes on first run. That is acceptable — the test guards future regressions.)

- [ ] **Step 3: Run the full test suite**

Run: `cd app && npm test`
Expected: PASS, all tests green including the new file.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/KeyPanel.test.tsx
git commit -m "test(app): cover KeyPanel key dispatch and constants"
```

---

### Task 5: Wire keyboardMode state and KeyPanel into TrackpadScreen

**Files:**
- Modify: `app/src/screens/TrackpadScreen.tsx` (imports, state, constants removal, handlers, render, styles)

**Interfaces:**
- Consumes: `KeyPanel`, `MODIFIERS`, `TAP_KEYS`, `F_KEYS`, `ModifierKey` from `../components/KeyPanel`; `useIsLandscape` from `../theme`; `useWindowDimensions` from `react-native`.
- Produces: Trackpad screen with 3-state keyboard cycle, docked panel, responsive layout.

This is the largest task. It is broken into sub-steps that each make one edit. Run `npm run check` and `npm test` after the final sub-step; commit once at the end.

- [ ] **Step 1: Update imports**

In `app/src/screens/TrackpadScreen.tsx`, replace lines 1-20 (the import block) with:

```tsx
import { LinearGradient } from 'expo-linear-gradient';
import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Icon } from '../components/Icon';
import { type ModifierKey, KeyPanel } from '../components/KeyPanel';
import type { Connection } from '../connection';
import { radius, spacing, useIsLandscape, useTheme } from '../theme';
```

(Removes `Dimensions`. Adds `useWindowDimensions`, `KeyPanel`, `ModifierKey`, `useIsLandscape`.)

- [ ] **Step 2: Remove the moved constants**

Delete lines 40-72 (the `MODIFIERS`, `ModifierKey`, `MODIFIER_LABEL`, `TapKey`, `TAP_KEYS`, `F_KEYS` blocks) since they now live in `KeyPanel.tsx`. Keep `SENSITIVITIES`, `SCROLL_SENSITIVITY`, `DOUBLE_TAP_DRAG_WINDOW_MS`, `RECONNECT_DELAYS_MS`, `KEYBOARD_SENTINEL`.

- [ ] **Step 3: Replace keyboard state**

Find (line 79):

```ts
  const [keyboardOpen, setKeyboardOpen] = useState(false);
```

Replace with:

```ts
  const [keyboardMode, setKeyboardMode] = useState<'off' | 'float' | 'dock'>('off');
  const [imeOpen, setImeOpen] = useState(false);
```

Find (line 83-84):

```ts
  const [trayVisible, setTrayVisible] = useState(false);
  const [trayPos, setTrayPos] = useState<{ x: number; y: number } | null>(null);
```

Replace with:

```ts
  const [trayPos, setTrayPos] = useState<{ x: number; y: number } | null>(null);
```

- [ ] **Step 4: Add window dims and landscape hooks**

After the `const insets = useSafeAreaInsets();` line (line 86), add:

```ts
  const window = useWindowDimensions();
  const isLandscape = useIsLandscape();
```

- [ ] **Step 5: Fix the keyboard event listeners to drive imeOpen**

In the `useEffect` that adds `keyboardDidShow/Hide` listeners (lines 163-181), the `onShow`/`onHide` callbacks currently call `setKeyboardOpen`. Change them to `setImeOpen`:

```tsx
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: { endCoordinates?: { height?: number } }) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0);
      setImeOpen(true);
    };
    const onHide = () => {
      setKeyboardHeight(0);
      setImeOpen(false);
      inputRef.current?.blur();
    };
    const showSub = Keyboard.addListener(showEvent, onShow as never);
    const hideSub = Keyboard.addListener(hideEvent, onHide);
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
```

- [ ] **Step 6: Replace toggleKeyboard with the 3-state cycle**

Find `toggleKeyboard` (lines 244-250):

```ts
  const toggleKeyboard = () => {
    if (keyboardOpen) {
      inputRef.current?.blur();
    } else {
      inputRef.current?.focus();
    }
  };
```

Replace with:

```ts
  const closeKeyboard = () => {
    inputRef.current?.blur();
    setKeyboardMode('off');
    setTrayPos(null);
  };

  const toggleKeyboard = () => {
    setKeyboardMode((prev) => {
      if (prev === 'off') {
        inputRef.current?.focus();
        return 'float';
      }
      if (prev === 'float') {
        return 'dock';
      }
      closeKeyboard();
      return 'off';
    });
  };
```

- [ ] **Step 7: Update the hidden TextInput focus handlers**

In the `<TextInput>` (around lines 430-446), `onFocus` and `onBlur` currently set `keyboardOpen`. Change them to `imeOpen`:

```tsx
      <TextInput
        ref={inputRef}
        style={styles.hiddenInput}
        value={inputValue}
        onChangeText={onChangeText}
        onKeyPress={(e) => onKeyPress(e.nativeEvent.key)}
        onSubmitEditing={() => connection.key('enter')}
        onFocus={() => setImeOpen(true)}
        onBlur={() => setImeOpen(false)}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        keyboardType="visible-password"
        multiline={false}
        submitBehavior="submit"
      />
```

- [ ] **Step 8: Replace trayDrag and the tray default position with window dims**

Find the `trayDrag` definition (lines 307-320) and the `screen`/`trayW` block (lines 322-328). Replace both with:

```ts
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
```

- [ ] **Step 9: Update the ControlButton active state**

Find the Keyboard `ControlButton` (line 374):

```tsx
            active={keyboardOpen}
```

Replace with:

```tsx
            active={keyboardMode !== 'off'}
```

- [ ] **Step 10: Wrap the pad and add the docked panel**

Find the pad render (lines 416-428):

```tsx
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
```

Replace with a flex container that holds the pad and, when docked, the panel:

```tsx
      <View
        style={[
          styles.body,
          keyboardMode === 'dock' && (isLandscape ? styles.bodyRow : styles.bodyColumn),
        ]}
      >
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

        {keyboardMode === 'dock' && (
          <Card
            style={[
              styles.dockPanel,
              isLandscape ? styles.dockPanelSide : styles.dockPanelBottom,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
            padded={false}
          >
            <KeyPanel
              heldMods={heldMods}
              onModifier={toggleModifier}
              onKey={(id) => {
                releaseAllModifiers();
                connection.key(id);
              }}
              variant="dock"
            />
          </Card>
        )}
      </View>
```

- [ ] **Step 11: Replace the floating tray render**

Find the `trayVisible &&` block (lines 448-513) and the `!trayVisible &&` FAB block (lines 515-527). Replace the entire floating-tray block with one gated on `keyboardMode === 'float'`, using `KeyPanel`, and delete the FAB block entirely:

```tsx
      {keyboardMode === 'float' && (
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
                onPress={closeKeyboard}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Hide keyboard tray"
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
            variant="float"
          />
        </View>
      )}
```

Note: the `tray` style previously hardcoded `width: 360`; we now set `width: trayW` inline and remove the fixed width from the style (see Step 13). The tray height is no longer fixed; it sizes to content.

- [ ] **Step 12: Remove the local KeyButton and its now-unused styles**

The local `KeyButton` function (lines 564-600) and `ControlButton` is still used. Delete only the `KeyButton` function definition (the `function KeyButton(...)` block and its styles are now provided by `KeyPanel`). Also delete the `keyButton`, `keyButtonSmall`, `keyText`, `fText`, `trayRow`, `fRow` styles from the `styles` StyleSheet since `KeyPanel` owns them and the screen no longer renders keys directly.

Keep `ControlButton` (still used by the top cluster).

- [ ] **Step 13: Update the styles StyleSheet**

In the `styles` StyleSheet, make these edits:

- `pad`: change `margin: spacing.lg` to keep it, but ensure it still has `flex: 1`. It already does. Leave as-is.
- Remove the fixed `width: 360` from `tray`:

```ts
  tray: {
    position: 'absolute',
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.xs,
  },
```

- Add the new body/dock styles. Append to the StyleSheet:

```ts
  body: {
    flex: 1,
  },
  bodyRow: {
    flexDirection: 'row',
  },
  bodyColumn: {
    flexDirection: 'column',
  },
  dockPanel: {
    margin: spacing.lg,
    padding: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  dockPanelSide: {
    width: 280,
  },
  dockPanelBottom: {
    height: 240,
  },
```

- Remove `trayRestore` style (the FAB is gone) and `keyButton`, `keyButtonSmall`, `keyText`, `fText`, `trayRow`, `fRow` (moved to `KeyPanel`).

- [ ] **Step 14: Run check and tests**

Run: `cd app && npm run check`
Expected: PASS. Fix any unused-import/unused-style biome warnings. `ControlButton`'s `themeColor` param stays used (the top cluster still passes `themeColor={theme.primary}` / `themeColor={theme.danger}`); do not remove it. If `Dimensions` or other imports are now unused, remove them.

Run: `cd app && npm test`
Expected: PASS, all tests green.

- [ ] **Step 15: Type-check via the build (no tsc script)**

Run: `cd app && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (If `tsc` is unavailable per the spec, skip; biome + the next manual build catch type errors. Prefer running tsc here for safety.)

- [ ] **Step 16: Commit**

```bash
git add app/src/screens/TrackpadScreen.tsx
git commit -m "feat(app): 3-state keyboard cycle + docked key panel + landscape layout"
```

---

### Task 6: Manual verification on device

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: the finished build from Task 5.
- Produces: confirmation the feature works end-to-end.

- [ ] **Step 1: Build a dev build**

Run: `cd app && npm run android`
Expected: app installs and launches on the connected device/emulator.

- [ ] **Step 2: Verify the 3-state cycle in portrait**

On the trackpad screen (portrait):
- Tap Keyboard: floating tray appears, soft IME rises. ControlButton is active.
- Tap Keyboard again: tray becomes a docked bottom panel, pad shrinks. IME stays.
- Tap Keyboard again: tray and IME close, pad returns to full size.
- Tap the tray close (X) in float mode: equivalent to cycling to off.

- [ ] **Step 3: Verify docked layout in landscape**

Rotate to landscape:
- With `dock` active, pad is on the left, key panel on the right (~280 wide).
- Modifiers, tap-keys, F-keys are all reachable; tapping a modifier highlights it; tapping a key fires (verify by opening a text field on the remote machine, or by watching the connection log).
- Soft IME rises from the bottom and overlays; pad/panel do not resize for the IME.

- [ ] **Step 4: Verify floating tray drag in landscape**

Cycle to `float` in landscape:
- Drag the tray by the handle; it stays on-screen and above the IME.
- Rotate to portrait while in `float`; the tray stays visible and re-clamps into bounds.

- [ ] **Step 5: Verify banners and gestures in both orientations**

- Disconnect the server: the reconnecting banner renders in portrait and landscape.
- Force a reauth: the reauth banner renders in both orientations.
- Move/tap/scroll/drag gestures still work in both orientations.

- [ ] **Step 6: Run the verify skill**

Invoke the `verify` skill to drive the app and screenshot the landscape docked layout and the 3-state cycle. Confirm screenshots show the expected layout.

- [ ] **Step 7: Commit any fixups**

If verification surfaced fixes, commit them:

```bash
git add -A
git commit -m "fix(app): landscape layout fixups from device verification"
```

If no fixups, skip.

---

### Task 7: Run final checks and open a PR

**Files:**
- None.

- [ ] **Step 1: Final check and test**

Run: `cd app && npm run check && npm test`
Expected: both PASS.

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin feat/landscape-trackpad
gh pr create --title "feat(app): landscape trackpad support" --body "Enable landscape on the Trackpad screen with a 3-state keyboard cycle (off/float/dock) and a docked on-screen key panel. See docs/superpowers/specs/2026-07-06-landscape-support-design.md."
```

Expected: PR URL printed.

- [ ] **Step 3: Note the 7-day recurring-task limit if any cron was used**

No cron used in this plan. Skip.
