# ANI-MATE — MANDATORY RELEASE CHECKLIST

## RELEASE = ONE ATOMIC COMMIT. NO EXCEPTIONS.

Every release MUST update ALL of the following in a SINGLE commit before push + tag:

1. **`package.json`** — `"version": "X.Y.Z"`
2. **`ui/ani-mate-ui.html`** — `const APP_VERSION = 'X.Y.Z'`
3. **`ui/ani-mate-ui.html`** — `player-splash-ver` div: `vX.Y.Z // YASA SYSTEMS ACTIVE`
4. **`ui/ani-mate-ui.html`** — `CHANGELOG` array with new features
5. **`mobile/www/js/ani-mate-ui.js`** — `const APP_VERSION = 'X.Y.Z'`
6. **`mobile/www/js/ani-mate-ui.js`** — `CHANGELOG` array with new features
7. **`mobile/android/app/src/main/assets/public/js/` and `.../assets/public/css/`** — **COPY `mobile/www/js/*.js` AND `mobile/www/css/*.css` OVER.** This is what the APK actually ships. It is build output, it is NOT in git, and nothing copies it for you locally. On 2026-10-05 it still said `0.4.7` after every other file said `0.5.0`, so the APK would have gone out reporting the wrong version with none of the fixes. `npx cap sync android` does it, or `cp` the files.
8. **`mobile/android/app/build.gradle`** — **VERIFY, DO NOT EDIT.** It reads the version out of `package.json` and derives a date-based `versionCode` itself, so bumping item 1 is enough. Confirm it still contains `versionName project.ext.animateVersionName`. It used to be hardcoded `versionCode 1` / `versionName "1.0"`, which is why every APK ever built was named `ANI-MATE-1.0-mobile.apk` while `package.json` said something else.
   > ⚠ **`versionCode` MUST ONLY EVER INCREASE.** It is `date +%Y%m%d` because that is the scheme already in users' hands. A semver-derived number (0.5.0 → 500) is LOWER than an installed 20260825 build, and Android refuses a lower `versionCode` as a downgrade — every existing install would silently stop updating. Do not "tidy" this.
9. **GitHub Release Notes** — After push+tag, WAIT for the GitHub Actions workflow to finish (~4 min), THEN run `gh release edit vX.Y.Z --notes "..."`. NO code links, NO commit hashes, NO auto-generated notes. Plain English list of what changed.

## COMMIT MEANS THE FULL PIPELINE

When YASA says "commit" he means: commit + push + tag + release notes. Always. Don't be pedantic.

## RELEASE ORDER — DO NOT CREATE RELEASE BEFORE WORKFLOW

**NEVER** run `gh release create` before the workflow finishes. The workflow (electron-builder) needs to create the release itself as a draft, then upload the .exe. If a release already exists, electron-builder skips the .exe upload and the auto-updater breaks.

**CORRECT ORDER:**
1. `git commit` + `git push` + `git tag` + `git push origin <tag>`
2. **WAIT** for GitHub Actions workflow to complete (~4 min)
3. `gh release edit` to add human-readable notes

**NEVER:**
- `gh release create` before the workflow runs
- Creating the release manually in any way before the workflow

**WHY:** electron-builder publishes as draft type. If a release already exists as release type, it skips publishing the .exe. The auto-updater then downloads `latest.yml`, sees the new version, tries to download the .exe, gets a 404, and crashes. Users have to manually uninstall and reinstall.

This happened on v0.3.2. Never again.

## WHY THIS EXISTS

Forgetting the version bump causes:
- NSIS installer installs ALONGSIDE old version instead of replacing it
- Changelog popup doesn't show (localStorage already has old version)
- Splash screen shows wrong version
- Users end up with duplicate installs
- Makes YASA look bad

This happened on v0.3.1. Never again.
