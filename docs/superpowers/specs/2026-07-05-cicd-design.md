# CI/CD Design — remcontrol

Date: 2026-07-05

Add GitHub Actions CI and a tag-driven release pipeline. Produce server binaries
(Linux, macOS x86_64, macOS aarch64, Windows) and an Android APK as draft
release artifacts. Lint, format-check, and build on every push/PR.

## Project shape (from exploration)

- `server/` — Rust, edition 2024 (needs Rust ≥ 1.85). `enigo` 0.6 is pure Rust,
  no build-time system deps. Linux code shells out to `xdotool` at *runtime*
  (no build-time dep). Builds for Linux, macOS, Windows via `#[cfg(target_os)]`.
- `app/` — Expo 57 / React Native 0.86, TypeScript, strict. Uses
  `react-native-zeroconf` (native module → needs a dev build, no Expo Go).
  Android package `fr.dorianmoy.remcontrol`. No `eas.json`, no Biome config.
  Existing code: single quotes, semicolons, 2-space indent.
- No `.github/` exists yet.

## Triggers

- **`ci.yml`** — on `push` (any branch) and `pull_request`.
- **`release.yml`** — on tag push matching `v*` (e.g. `v1.0.0`).

Tag name is the source of truth for the release. Versions in `app/app.json`
and `server/Cargo.toml` are independent; no sync step (YAGNI).

Releases are **drafts**: `softprops/action-gh-release` with `draft: true` and
`generate_release_notes: true`. Publish is manual.

## CI workflow (`ci.yml`)

Two jobs, parallel.

### `server` (ubuntu-latest)

- `dtolnay/rust-toolchain@stable` (stable toolchain).
- `cargo fmt --all -- --check`
- `cargo clippy --all-targets -- -D warnings`
- `cargo build --release`
- `cargo test` (there is `server/tests/handshake.rs`)

### `app` (ubuntu-latest)

- `actions/setup-node@v4` with Node 20 + `npm` cache.
- `npm ci`
- `npx @biomejs/biome ci` (format + lint, exits non-zero on issues)
- `npx tsc --noEmit`

No Gradle build in CI. PR feedback stays fast; the Gradle build is proven in
the release workflow.

## Release workflow (`release.yml`)

Three build jobs + one publish job. `concurrency` group `release-${{ github.ref }}`,
`cancel-in-progress: false`.

### `server` (ubuntu-latest, cross-compilation)

- `dtolnay/rust-toolchain@stable`.
- `cargo install cross`.
- Matrix of targets, each via `cross build --release --target <target>`:
  - `x86_64-unknown-linux-gnu` → `remcontrol-server-x86_64-linux`
  - `x86_64-apple-darwin` → `remcontrol-server-x86_64-macos`
  - `aarch64-apple-darwin` → `remcontrol-server-aarch64-macos`
  - `x86_64-pc-windows-gnu` → `remcontrol-server-x86_64-windows.exe`
- Copy each release binary to its release name; strip symbols where possible.
- Upload each via `actions/upload-artifact`.

Windows uses `pc-windows-gnu` (MinGW) so it cross-compiles from a Linux runner
without a Windows host or `cargo-xwin`. Trade-off: depends on the MinGW runtime.
If MSVC-quality binaries are wanted later, switch that target to `cargo-xwin`.

macOS binaries are unsigned. Users must run `xattr -dr com.apple.quarantine
<binary>` (documented in the release body).

### `app` (ubuntu-latest, local Gradle build)

- `actions/setup-node@v4` Node 20 + `npm` cache.
- Setup JDK 17 (Android Gradle Plugin requirement), explicit `JAVA_HOME`.
- Runner image ships Android SDK; set `ANDROID_HOME`.
- `npm ci`.
- `npx expo prebuild --platform android` (generates `android/`).
- `./android/gradlew assembleRelease` →
  `android/app/build/outputs/apk/release/app-release.apk`.
- Debug-sign the APK (debug keystore, generated/used by Gradle by default).
  Output: `remcontrol-app-android.apk`.
- Upload via `actions/upload-artifact`.

### `release` (needs `server` + `app`)

- Download all artifacts.
- `softprops/action-gh-release@v2` with `draft: true`,
  `generate_release_notes: true`, attaching:
  - `remcontrol-server-x86_64-linux`
  - `remcontrol-server-x86_64-macos`
  - `remcontrol-server-aarch64-macos`
  - `remcontrol-server-x86_64-windows.exe`
  - `remcontrol-app-android.apk`

## Skipped (acknowledged)

- iOS IPA — needs macOS runner + Apple signing infra.
- macOS *app* bundle — n/a (server is a CLI).
- Server binary signing / notarization — unsigned, documented.
- APK release signing / Play Store AAB — debug-signed sideload APK only.

## Source changes outside `.github/`

- `app/biome.json` — new, minimal config matching existing style:
  single quotes, semicolons, 2-space, lineWidth 100.
- `app/package.json` — add `@biomejs/biome` to devDependencies, add scripts:
  `lint`, `format`, `check`.

## Risks

- First release run ~15-25 min (Rust cross-compiles are the long pole).
- macOS binaries unsigned → Gatekeeper friction, mitigated by release notes.
- Windows `gnu` binary depends on MinGW runtime; documented alternative is
  `cargo-xwin` for MSVC.
- Gradle APK build needs JDK 17; ubuntu runner ships it, `JAVA_HOME` set
  explicitly.
