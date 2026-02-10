# YASA Development Studio Presents

# ANI-MATE

**Free Anime For All**

Stream 95% of all anime ever made. Currently airing series, classics, movies, OVAs, specials — sub and dub. New episodes appear within hours of broadcast. Built-in progress tracking, favorites, trending charts, and auto-updates.

![ANI-MATE](assets/icon.png)

## Download

Get the latest version from [Releases](../../releases).

| Platform | File | Notes |
|----------|------|-------|
| **Windows** | `ANI-MATE-Setup-x.x.x.exe` | Installer with auto-updates |
| **Android** | `ANI-MATE-x.x.x.apk` | Sideload — enable "Install unknown apps" in settings |

## Features

### All Platforms
- Search anime by name (sub/dub)
- In-app video player with HLS streaming
- Quality switching during playback (resumes from same position)
- Continue watching with resume from where you left off
- Episode tracking with watched markers
- Auto-play next episode
- Favorites list
- Daily trending and airing schedule
- Auto-fallback when a stream source fails

### Windows Only
- Download episodes (mp4 direct, m3u8 with ffmpeg)
- Animated splash intro
- Auto-updates via GitHub releases

### Android Only
- Touch controls (tap play/pause, double-tap seek ±10s)
- Full player controls (progress bar, skip, prev/next episode)
- Auto landscape lock during playback
- Screen stays awake during playback
- Android back button navigation

## Keyboard Shortcuts (Windows / Bluetooth keyboard)

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Enter` | Play selected episode |
| `Escape` | Close player |
| `Left/Right` | Seek ±5s (playing) / Previous/next episode (browsing) |
| `Space` | Play/pause |
| `f` | Fullscreen |

## Build From Source

### Windows (Electron)

```bash
git clone https://github.com/YASADevStudio/ani-mate.git
cd ani-mate
npm install
npm start
```

Build installer: `npm run build:win` → `dist/ANI-MATE Setup x.x.x.exe`

### Android (Capacitor)

```bash
git clone https://github.com/YASADevStudio/ani-mate.git
cd ani-mate/mobile
npm install
npx cap sync android
cd android && ./gradlew assembleDebug
```

APK output: `mobile/android/app/build/outputs/apk/debug/app-debug.apk`

Requires: JDK 21, Android SDK (API 36, build-tools 36.0.0)

## Tech Stack

| Component | Windows | Android |
|-----------|---------|---------|
| Framework | Electron | Capacitor 8 |
| HTTP/CORS | Node.js proxy server | CapacitorHttp (native HTTP) |
| Video | hls.js | hls.js + custom loader |
| Storage | Local filesystem | Capacitor Filesystem |
| Anime data | AllAnime GraphQL API | AllAnime GraphQL API |
| Metadata | AniList + Jikan/MAL | AniList + Jikan/MAL |

## File Locations

| Data | Windows | Android |
|------|---------|---------|
| App data | `%APPDATA%\ANI-MATE\data\` | App internal storage |
| Downloads | `Videos\ANI-MATE\` | N/A |

## License

MIT - [YASA Development Studio](https://yasa.work)
