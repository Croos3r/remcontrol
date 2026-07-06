# UI Redesign: Match the App Icon

Date: 2026-07-06
Status: Design (pending approval)

## Goal

Redesign the app UI so it visually belongs to the existing app icon: a vivid blue
gradient with white device shapes (monitor / keyboard / mouse), dark navy outlines,
soft depth, rounded cards, and a "wireless desktop control" feel. The current UI is
a dark `#111` / `#1d1d1d` Material-ish style with unicode glyph buttons — it does not
match the icon at all.

## Scope

In scope: `App.tsx`, `src/screens/ConnectScreen.tsx`, `src/screens/TrackpadScreen.tsx`,
and a new shared `src/theme.ts` module. Add `expo-linear-gradient` and
`@expo/vector-icons` dependencies.

Out of scope: native iOS/Windows/macOS/Linux runtime surfaces. This app is a React
Native + Expo prebuild project currently built for Android (per project memory). The
brief's "native usability on iOS, Windows, macOS, Linux" line is taken as a visual
portability goal, not a runtime target. No desktop platform wiring is added.

## Decisions (confirmed with user)

- Gradients: `expo-linear-gradient` (true gradients for headers, buttons, active
  tabs). Needs a prebuild/native module install — consistent with the existing native
  deps (expo-camera, expo-secure-store, react-native-zeroconf).
- Dark mode: system light/dark via `useColorScheme()`. Both themes defined; surfaces,
  text, and gradients swap. This matches the brief's dark-mode direction.
- Icons: `@expo/vector-icons` — `Ionicons` and `MaterialCommunityIcons` families for
  monitor, keyboard, mouse, wireless, gear, close glyphs.

## Palette

Two themes sharing the same blue brand. Defined once in `src/theme.ts`.

### Light (default)

| Token | Value | Use |
|---|---|---|
| `primary` | `#008CFF` | primary accent, gradient start |
| `deep` | `#005DE8` | gradient end, active states |
| `navy` | `#062B66` | text, outlines, icons on light |
| `softNavy` | `#123A78` | secondary text on gradients |
| `surface` | `#FFFFFF` | cards, content |
| `softSurface` | `#F3F8FF` | app background, subtle surfaces |
| `border` | `#D6E6F8` | card borders, dividers, secondary button border |
| `muted` | `#6B7C93` | secondary text, hints |
| `disabled` | `#C9D6EA` | disabled controls, inactive chips |
| `danger` | `#D64545` | error text, reauth banner |
| `warn` | `#B9770E` | reconnecting banner (light) |

### Dark

| Token | Value | Use |
|---|---|---|
| `bg` | `#06122E` | app background (deep navy gradient start) |
| `bgEnd` | `#0A1F4A` | app background gradient end |
| `surface` | `#13245A` | cards (dark blue-gray) |
| `softSurface` | `#0E1C40` | subtle surfaces |
| `border` | `#1F3A7A` | card borders |
| `text` | `#EAF2FF` | primary text |
| `muted` | `#9FB3D6` | secondary text |
| `primary` / `deep` | unchanged | brand gradients stay blue |
| `navy` (on gradient) | `#FFFFFF` | text/icons on blue gradients invert to white |
| `danger` | `#FF6B6B` | error text |
| `warn` | `#FFB347` | reconnecting banner |

## Architecture

### `src/theme.ts` (new)

Exports:

- `lightTheme`, `darkTheme` objects keyed by the tokens above.
- `type Theme` and `type ThemeKey`.
- A `useTheme()` hook wrapping `useColorScheme()` returning the active theme plus a
  `scheme: 'light'|'dark'` flag. Memoized; returns `lightTheme` as default when the
  system reports `null`.
- Shared style constants used across screens: `radius` (`{ sm: 8, md: 14, lg: 20, xl: 28, pill: 999 }`),
  `shadow` (a soft layered shadow per theme — `{ shadowColor, shadowOpacity,
  shadowRadius, elevation }`), `spacing`.
- Gradient preset arrays: `headerGradient`, `buttonGradient`, `tabActiveGradient`,
  each `[colors, start, end]` tuples per theme.

Shadows use RN `shadow*` props (iOS) plus `elevation` (Android). No extra deps.

### Shared components (new, in `src/components/`)

Keep these small and self-contained so screens stay readable.

- `GradientHeader` — `LinearGradient` (deep→primary, vertical) rounded card for the
  top area of a screen. Holds title + optional subtitle. Used on Connect screen.
- `PrimaryButton` — `LinearGradient` pill (primary→deep), white text, `Pressable`
  with a gentle scale-on-press (Reanimated `useAnimatedStyle` on `pressed`,
  `withSpring` to 0.97). Disabled state: `disabled` fill, muted text, no gradient.
- `SecondaryButton` — white fill, navy text, `border` border, same press scale.
- `Card` — white/dark surface, `radius.lg` corners, `shadow`, thin `border`.
- `Chip` — pill; inactive = soft surface + muted text; active = tabActiveGradient +
  white text. Used for sensitivity and tabs.
- `Icon` — thin wrapper over `@expo/vector-icons` so the family is set in one place.
  Props: `name`, `size`, `color` (defaults to theme navy / white-on-gradient).

### `App.tsx`

- Wrap root in the theme: read `useTheme()`, set `root` background to `softSurface`
  (light) or `bg` (dark). `StatusBar` style flips with scheme (`light` on the blue
  header / dark mode, `dark` on light content). Use `StatusBar` `translucent` and
  let the gradient header sit under it on Android.
- Restoring screen: centered `Card` with a wireless/monitor icon and the reconnecting
  text in navy/muted. Currently bare `#aaa` text on `#111`.
- Keep all connection restore logic unchanged.

### `ConnectScreen.tsx`

Layout: a `GradientHeader` ("remcontrol" + subtitle "Connect a computer"), a pill
`TabBar` below it, then white content `Card` filling the rest.

- Tabs: rounded pill bar on `softSurface`. Active tab gets `tabActiveGradient` fill +
  white text; inactive = transparent + navy text. Replaces the current underline tabs.
- Scan tab: `Card` containing the camera frame with a `radius.lg` corner and a navy
  outline border; a wireless/scan icon above the hint. "Allow camera" button is a
  `PrimaryButton`. Hint text muted.
- Discover tab: list of `Card` rows (server name navy bold, address muted), soft
  shadow. Pending-token form uses `Card` + `SecondaryButton` "Back". List empty
  state uses a monitor icon + muted hint.
- Recent tab: `Card` rows like Discover; the forget `✕` becomes an `Icon`
  `close` in muted, large hitSlop, inside a small circular `softSurface` button.
- Manual tab: `Card` form with rounded `TextInput`s (white fill light / surface
  dark, `border` border, navy text, muted placeholder), `PrimaryButton` "Connect".
- Errors: a `Card`-styled banner with `danger` text and a `close` icon.
- Busy: replace plain text with a small inline spinner row (`ActivityIndicator` brand
  blue) + "Connecting…" muted text, or a translucent overlay on the form.

### `TrackpadScreen.tsx`

This is the gesture-heavy screen. The redesign keeps all gesture wiring and
connection logic byte-for-byte; only presentation changes.

- Container background: light = `softSurface`; dark = `bg` gradient.
- Top control cluster: becomes a floating rounded `Card` pill (white/surface) with
  `shadow`, holding icon `ControlButton`s (keyboard, gear, disconnect). Icons via
  `Icon`: `Ionicons` `keypad` / `MaterialCommunityIcons` `keyboard`, `Ionicons`
  `settings-outline`, `Ionicons` `close`. Active state = brand blue icon color.
- Status dot: keep, recolor to brand green / `warn`. Same logic.
- Settings row: a `Card` with `Chip`s (Slow/Normal/Fast) using the shared `Chip`.
- Reconnecting banner: `warn`-tinted `Card` strip under the top bar.
- Reauth banner: `danger`-tinted `Card` strip with a `SecondaryButton` "Re-pair".
- The gesture pad: a large `Card`-like rounded surface filling the middle. Light
  mode: white surface with `border` and `softSurface`-tinted inner area so the white
  "device" reads. Hint text muted, smaller, centered. Dark mode: dark surface with
  a subtle blue inner gradient to echo the icon. The pad is the "monitor" surface.
- Keyboard tray: restyle to a rounded `Card` (surface color), key buttons become
  `softSurface`/`border` rounded chips with navy text; active modifier keys use
  `buttonGradient` + white. Tray handle icon `drag-vertical` (`MaterialCommunityIcons`)
  in muted; close icon `close`. F-keys row smaller chips.
- Tray restore FAB: circular `PrimaryButton`-gradient pill with a `dots-horizontal`
  icon, shadowed.
- Hidden `TextInput` stays exactly as-is (off-screen, drives the IME).

### Motion

- `PrimaryButton` / `SecondaryButton` / `Chip` / `ControlButton`: press scale to
  0.97 via Reanimated `withSpring` (damping 18, stiffness 300). One small reusable
  `usePressScale` hook in `theme.ts` or a `PressableCard` helper.
- Panel transitions: tab content cross-fade. Use a light `Animated.FadeIn` /
  `LayoutAnimation` on tab switch. Keep it calm, no slide.
- Loading: `ActivityIndicator` (brand blue) — no bouncy spinners.
- Hover glow on desktop is out of scope (no desktop runtime).

### Accessibility

- All icon-only `ControlButton`s get an `accessibilityLabel` (Keyboard, Settings,
  Disconnect, Forget, etc.) and `accessibilityRole="button"`. Not color-only: status
  dot paired with text in banners; chips show their label text.
- Touch targets: control buttons ≥ 44pt, key buttons ≥ 44pt height (bump padding
  where the current 36/8pt falls short). Tabs ≥ 44pt.
- Contrast: navy `#062B66` on white surface = ~11:1 (passes AAA). White on
  `primary`/`deep` gradient passes AA. Muted `#6B7C93` on `softSurface` ~5:1 (AA).

## Data flow / behavior

No change to connection, crypto, storage, gesture, or reconnect logic. Pure
presentation refactor plus new theme + 3 small shared components. All existing tests
in `src/*.test.ts` are unaffected (they test non-UI modules).

## Testing / verification

- `npm run check` (biome) and `npm test` must pass — no logic change expected.
- `tsc` no new errors (no explicit `tsc` script; biome + expo type-check on build).
- Manual: build Android dev build, confirm: Connect screen light + dark, scan/
  discover/manual/recent tabs, connect flow, trackpad gestures, keyboard tray,
  settings chips, reconnecting + reauth banners, tray drag/restore.
- Since this is visual, the `verify` skill (drive the app, screenshot) is the real
  acceptance check before commit.

## Risks / notes

- `expo-linear-gradient` + `@expo/vector-icons` add native/asset weight. Both are
  standard Expo modules; prebuild handles them. Needs a fresh dev build.
- System dark mode toggle means testing two palettes. I'll keep gradients defined
  per-theme in `theme.ts` so both are auditable in one place.
- The brief's desktop-platform line is not a runtime target for this app; called out
  in Scope so the design stays honest.
- Prebuild output (`app/android`) is gitignored (per memory). Native module
  additions go through `package.json` + `npx expo prebuild`, not direct android
  edits.
