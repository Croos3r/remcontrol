---
name: release
description: Use when cutting a remcontrol release — pushing a version tag, watching the release workflow, or publishing the drafted GitHub Release for this repo.
---

# remcontrol release

## Overview

A release = an annotated `vX.Y.Z` tag pushed to `origin`, which triggers
`.github/workflows/release.yml` (builds server binaries for
Linux/Windows/macOS + the Android APK, then drafts a GitHub Release). The tag
push is the one irreversible-ish trigger — everything before it is prep,
everything after it is watching CI and publishing.

Version numbers in `server/Cargo.toml`, `app/package.json`, and
`app/app.json` are **not** kept in lockstep with release tags historically
(e.g. tags reached only v0.1.0 while the app files already say 1.0.0) — the
workflow doesn't read them, only the tag matters. Still sync them as part of
a release so they don't drift further; treat mismatches you find as
pre-existing, not something to silently "fix" mid-release.

## Steps

1. **Preflight.** `git status` clean, on `main`, `git fetch && git log
   origin/main..main` empty (nothing unpushed left behind).

2. **Pick the version.** `git describe --tags --abbrev=0` for the last tag.
   Scan commits since then (`git log <last-tag>..HEAD --oneline`) for bump
   signal: any `!` or `BREAKING CHANGE` → major, any `feat` → minor,
   otherwise patch. State the proposed `vX.Y.Z` and the reasoning; this is a
   judgment call, don't silently pick without saying so.

3. **Mirror CI locally before tagging** — a failed release run means
   deleting the tag and re-pushing, so catch it now:
   ```sh
   (cd server && cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings && cargo test)
   (cd app && npx @biomejs/biome ci && npx tsc --noEmit && npm test)
   ```

4. **Sync version fields** to the new version: `server/Cargo.toml`
   (`version = "..."`), `app/package.json` (`version`), `app/app.json`
   (`expo.version`). Then regenerate the server lockfile so it doesn't
   stay pinned to the old version (this is what broke the v1.2.0 release
   — the lockfile still referenced 1.1.0):
   ```sh
   (cd server && cargo update -p remcontrol-server)
   ```
   Verify before committing: `rg '^name = "remcontrol-server"' -A1
   server/Cargo.lock` must show the new version. Commit as
   `chore(release): vX.Y.Z` if anything changed.

5. **Tag and push** — confirm with the user before this step, it's the
   trigger:
   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main   # only if step 4 committed something
   git push origin vX.Y.Z
   ```

6. **Watch the run:**
   ```sh
   gh run list --workflow=release.yml --limit 1
   gh run watch <run-id>
   ```

7. **On success**, the release is a **draft** with a static binaries blurb
   plus GitHub's auto-generated commit list — it has no human-readable
   summary of what changed. Write one before asking to publish:
   - From the commit list gathered in step 2, group into `Highlights`
     (`feat`), `Fixes` (`fix`), and skip pure `chore`/`docs`/`style` unless
     user-visible. Keep it to a few bullets in plain language, not a raw
     commit dump.
   - Fetch the current body and prepend your summary above it:
     ```sh
     gh release view vX.Y.Z --json body -q .body > /tmp/notes.md
     ```
     Insert a `## Highlights` section at the top of that file with your
     bullets, then:
     ```sh
     gh release edit vX.Y.Z --notes-file /tmp/notes.md
     ```
   - Do not publish it yourself. Tell the user it's ready at
     `gh release view vX.Y.Z --web` and that `gh release edit vX.Y.Z
     --draft=false` publishes it once they've reviewed the artifacts and
     notes.

## If the workflow fails

The tag already exists on origin; GitHub won't let a new push reuse it
cleanly for a retry. Clean up before re-tagging:
```sh
git push origin :refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```
Fix the root cause, then restart from step 3 (re-run the local CI mirror,
don't just re-tag blind).

## Quick reference

| Question | Command |
|---|---|
| Last released version | `git describe --tags --abbrev=0` |
| Commits since last release | `git log <last-tag>..HEAD --oneline` |
| Is a release running | `gh run list --workflow=release.yml --limit 1` |
| Draft release URL | `gh release view vX.Y.Z --web` |
| Publish (user-confirmed only) | `gh release edit vX.Y.Z --draft=false` |
