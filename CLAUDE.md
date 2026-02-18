# ANI-MATE — MANDATORY RELEASE CHECKLIST

## RELEASE = ONE ATOMIC COMMIT. NO EXCEPTIONS.

Every release MUST update ALL of the following in a SINGLE commit before push + tag:

1. **`package.json`** — `"version": "X.Y.Z"`
2. **`ui/ani-mate-ui.html`** — `const APP_VERSION = 'X.Y.Z'`
3. **`ui/ani-mate-ui.html`** — `player-splash-ver` div: `vX.Y.Z // YASA SYSTEMS ACTIVE`
4. **`ui/ani-mate-ui.html`** — `CHANGELOG` array with new features
5. **`mobile/www/js/ani-mate-ui.js`** — `const APP_VERSION = 'X.Y.Z'`
6. **`mobile/www/js/ani-mate-ui.js`** — `CHANGELOG` array with new features
7. **GitHub Release Notes** — After push+tag, run `gh release edit vX.Y.Z --notes "..."` with human-readable changelog. NO code links, NO commit hashes, NO auto-generated notes. Plain English list of what changed.

## COMMIT MEANS THE FULL PIPELINE

When YASA says "commit" he means: commit + push + tag + release notes. Always. Don't be pedantic.

## WHY THIS EXISTS

Forgetting the version bump causes:
- NSIS installer installs ALONGSIDE old version instead of replacing it
- Changelog popup doesn't show (localStorage already has old version)
- Splash screen shows wrong version
- Users end up with duplicate installs
- Makes YASA look bad

This happened on v0.3.1. Never again.
