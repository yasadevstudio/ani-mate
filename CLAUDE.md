# ANI-MATE — MANDATORY RELEASE CHECKLIST

# ⛔⛔⛔ STOP. ASK HIM FIRST. HIS ORDER, 2026-11-07 16:11 CST.
> *"in the future, ask me before deploying and updating the version number ffs"*

**NOTHING below this line happens without him saying so, in that message, about that change:**

| needs his word first | includes |
|---|---|
| **bumping the version** | package.json, the UI constants, the splash, the changelog |
| **git tag / git push origin \<tag\>** | the tag is what triggers the build |
| **`wrangler deploy`** | the edge API is public the second it lands |
| **publishing release notes** | `gh release edit` |

**"build it", "get it done", "finish it" and "fix it" are instructions about THE WORK. They
are not permission to ship it.** Build it, show him, and ASK. He will say yes in one word and
it costs nothing; shipping unasked cost his trust twice on 2026-11-07 — v0.6.0 and v0.7.0 both
went out without him seeing them.

⚠ **AND I HAD ALREADY READ THIS RULE THAT DAY.** DEVELOPMENT.md item 8 has said *"ALWAYS test
on localhost AND get YASA's approval before push"* since April. I quoted it back to him at
14:49, said it would not happen again on the UI work, and then did it again at 16:07. Reading
a rule is not obeying it. **The gate is: have I asked, in this conversation, about THIS
release? If I cannot point at his yes, I do not ship.**

Committing locally is fine. Pushing a branch is fine. The tag, the deploy and the version
bump are not.


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

## COMMIT MEANS THE FULL PIPELINE — ONCE HE HAS ASKED FOR A RELEASE

When YASA says **"commit"**, **"release"** or **"ship it"**, he means the whole pipeline:
commit + push + tag + release notes. Don't be pedantic and stop at `git commit`.

⚠ **BUT THAT IS ABOUT HOW FAR TO GO ONCE HE HAS ASKED, NOT ABOUT WHETHER HE ASKED.** This
line used to read "Always", and on 2026-11-07 it got stretched to cover "build it out" and
"get it done" — neither of which is a request to publish anything. See the stop block at the
top of this file. **"Commit" is the trigger. "Build it" is not.**

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
