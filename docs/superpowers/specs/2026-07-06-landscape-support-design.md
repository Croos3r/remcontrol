# Landscape Support for the Trackpad Screen

Date: 2026-07-06
Status: Design (pending approval)

## Goal

Support landscape orientation so the trackpad surface gives more room for mouse
and keyboard input. The Connect screen is a setup screen and works fine in
portrait, so landscape is enabled only where it helps: the Trackpad screen.
Portrait stays available; the user can rotate freely.

## Scope

In scope: `app/app.json` (orientation), `app/src/theme.ts` (new `useIsLandscape`
hook), `app/src/screens/TrackpadScreen.tsx` (responsive layout, 3-state
keyboard cycle, docked key panel), and a new `app/src/components/KeyPanel.tsx`
shared by the floating tray and the docked panel.

Out of scope: Connect screen reflow (its vertical card stack already tolerates
landscape without changes). No native iOS/Windows/macOS/Linux runtime work.
No change to connection, crypto, storage, gesture, or reconnect logic.

## Decisions (confirmed with user)

- Orientation scope: Trackpad only; both orientations allowed. Connect stays
  usable in either orientation but is not reflowed.
- Trackpad layout in landscape: two switchable modes via the Keyboard button.
- Keyboard button cycles 3 states: `off -> float -> dock -> off`. The button
  drives the on-screen tray; the soft IME opens and closes together with it.
- Soft IME: kept. The on-screen tray (modifiers, F-keys, arrows, special keys)
  and the system soft keyboard (letters) open together. Tray sits above the
  IME.
- Docked geometry (landscape): pad on the left filling most of the width; key
  panel on the right as a fixed-width column with modifiers row, tap-keys
  grid, F-keys grid.
- Docked geometry (portrait): pad on top; key panel below, content reflows.

## Architecture

### `app/app.json`

Change `"orientation": "portrait"` to `"orientation": "default"`. This unlocks
rotation at the native level app-wide. No per-screen lock is added; Connect
simply tolerates landscape as-is.

### `app/src/theme.ts` (new hook)

Add `useIsLandscape()`:

```ts
import { useWindowDimensions } from 'react-native';
export function useIsLandscape() {
  const { width, height } = useWindowDimensions();
  return width >= height;
}
```

`useWindowDimensions` re-renders on rotation, so layouts using it react live.

### `app/src/components/KeyPanel.tsx` (new)

Renders the on-screen key set shared by the floating tray and the docked
panel, so both surfaces show identical keys with identical behavior.

Props:
- `onModifier(m, isDown)`: toggle a modifier down/up.
- `onKey(id)`: fire a tap-key or F-key; releases all held modifiers first.
- `heldMods: Set<ModifierKey>`: which modifiers are active (for styling).
- `variant: 'float' | 'dock'`: `float` uses the current roomy chip sizing;
  `dock` uses a denser grid (smaller chips, tighter gaps) so the column/strip
  fits.

Contents, in order: modifiers row (`Ctrl Alt Shift Super`), tap-keys grid (the
14 `TAP_KEYS`), F-keys grid (the 12 `F_KEYS`, small). The `MODIFIERS`,
`TAP_KEYS`, `F_KEYS`, `MODIFIER_LABEL` constants move from
`TrackpadScreen.tsx` into `KeyPanel.tsx` (or a shared `keys.ts`) and are
imported by the screen for state typing.

### `app/src/screens/TrackpadScreen.tsx`

#### State changes

- Replace `keyboardOpen: boolean` with `keyboardMode: 'off' | 'float' | 'dock'`.
- Keep `keyboardHeight` and the `Keyboard` show/hide listeners; track the soft
  IME separately as `imeOpen`, driven by the existing `keyboardDidShow/Hide`
  events. The hidden `TextInput` `onFocus/onBlur` also set `imeOpen`.
  `keyboardHeight` feeds the floating tray's drag clamp so it stays above the
  IME. In docked mode the IME overlays the pad/panel from the bottom and does
  not resize them.
- Keep `trayPos` for the floating tray; it is now only used when
  `keyboardMode === 'float'`.
- Remove `trayVisible`; the tray is gated by `keyboardMode === 'float'`.
- Remove the tray-restore FAB (its render and its style block).

#### `toggleKeyboard()` cycle

`off -> float -> dock -> off`:
- `off -> float`: set `keyboardMode = 'float'`, focus the hidden input (IME
  rises).
- `float -> dock`: set `keyboardMode = 'dock'` (IME stays; the tray becomes a
  docked panel).
- `dock -> off`: set `keyboardMode = 'off'`, blur the hidden input (IME
  closes), clear `trayPos`.

The `Keyboard` `ControlButton` is `active` when `keyboardMode !== 'off'`.

#### Layout

Container is a `View` (current `styles.container`). Its `flexDirection` is
`'row'` when `keyboardMode === 'dock'` and landscape, `'column'` when docked
and portrait, and unchanged (default column) otherwise.

- The pad (`LinearGradient` inside `GestureDetector`) keeps `flex: 1` and
  `margin: spacing.lg`. In docked mode it shares the flex row/column with the
  key panel; `flex: 1` makes it take the remaining space.
- The docked key panel: a `Card`-style container with fixed width (landscape,
  ~30% width capped at 300) or full width (portrait, fixed height ~40% of
  window). Holds `<KeyPanel variant="dock" .../>`.

The banners, top control cluster, settings card, and hidden input are
unchanged and stay outside the row/column flex (they are siblings of the
pad/panel, positioned as today: banners at top, control cluster floating,
hidden input off-screen).

#### Floating tray (`keyboardMode === 'float'`)

Renders when `keyboardMode === 'float'`. Wraps `<KeyPanel variant="float" />`
in the existing draggable card with the drag handle and close button. The
close button sets `keyboardMode = 'off'` (and blurs the input). Drag clamping
uses `useWindowDimensions()` values so it stays correct on rotation.

#### Responsive sizing

- Replace `Dimensions.get('window')` reads with a single
  `useWindowDimensions()` call at the top of the component. Use its `width`
  /`height` in the `trayDrag` clamp and the `trayW`/`trayPos` defaults.
- `trayW = Math.min(width - 32, 360)` (already responsive).
- `trayH = 168` (constant; tray content is the same in both orientations).
- Default `trayPos` when entering `float`: `x = width - trayW - 16`,
  `y = height - trayH - 16 - keyboardHeight - insets.bottom`. (Replaces the
  old `132` FAB offset with `16`.)

#### Rotation

Because `useWindowDimensions()` and `useIsLandscape()` re-render on rotate,
the docked panel reflows (row <-> column) and the floating tray clamp updates.
Gesture handler closures are rebuilt on re-render with fresh window values,
so no stale reads. The hidden `TextInput` retains focus across rotation (RN
preserves it); the IME stays up.

## Data flow / behavior

No change to connection, crypto, storage, gesture, or reconnect logic. The
move/scroll/tap gesture wiring, the 16ms move-send interval, the reconnect
retry ladder, and the auth-failure handling are untouched. Only presentation
and the keyboard-mode state machine change.

## Testing / verification

- `npm run check` (biome) and `npm test` pass. Existing tests target
  non-UI modules and are unaffected.
- Manual + `verify` skill (drive the app, screenshot) on an Android dev build:
  - Rotate to landscape on the trackpad; confirm pad + docked key panel.
  - Cycle the Keyboard button: off -> float -> dock -> off; confirm soft IME
    opens/closes with the tray in each transition.
  - In `float`, drag the tray; confirm clamping keeps it on-screen and above
    the IME.
  - Rotate while `float` is open; confirm tray re-clamps and stays visible.
  - Rotate while `dock` is active; confirm panel reflows row <-> column.
  - Confirm reconnecting and reauth banners still render in both orientations.
  - Confirm modifier/F-key/arrow keys still fire (dock and float).
- `tsc`: no explicit script; biome + expo type-check on build catches new
  type errors.

## Risks / notes

- `expo-linear-gradient` inside a flex row (docked landscape) needs `flex: 1`
  to size; if it renders zero-size, give the pad an explicit `width`/`height`
  via `useWindowDimensions`. Verify on device.
- Removing the tray-restore FAB changes the existing entry point for the
  keyboard tray. Accepted: the Keyboard button is now the single, clearer
  entry.
- `app/android` is gitignored prebuild output (per project memory); the
  `app.json` orientation change flows through `npx expo prebuild`, not direct
  Android edits.
- Landscape on a phone is short vertically; the docked panel's fixed height in
  portrait (~40%) is a starting value to tune on device.
