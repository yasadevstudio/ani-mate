# YASA Development Studio Presents

# ANI-MATE

**Free Anime For All**

Stream 95% of all anime ever made. Currently airing series, classics, movies, OVAs, specials — sub and dub. New episodes appear within hours of broadcast. Built-in progress tracking, favorites, trending charts, and auto-updates.

![ANI-MATE](assets/icon.png)

## Download

Get the latest installer from [Releases](../../releases).

Download the latest `ANI-MATE-Setup-x.x.x.exe`, run it, and you're good to go. The app auto-updates on new releases.

## Features

- Search anime by name (sub/dub)
- In-app video player with HLS streaming
- Quality switching during playback
- Continue watching with resume from where you left off
- Episode tracking with watched markers
- Auto-play next episode
- Favorites list
- Daily trending and airing schedule
- Download episodes (mp4 direct, m3u8 with ffmpeg)
- Animated splash intro

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Enter` | Play selected episode |
| `Escape` | Close player |
| `Left/Right` | Seek ±5s (playing) / Previous/next episode (browsing) |
| `Space` | Play/pause |
| `f` | Fullscreen |

## Build From Source

```bash
git clone https://github.com/YASADevStudio/ani-mate.git
cd ani-mate
npm install
npm start
```

To build the Windows installer:

```bash
npm run build:win
```

Output: `dist/ANI-MATE Setup x.x.x.exe`

## Tech Stack

- **Electron** — Desktop app framework
- **Node.js** — Backend HTTP server (zero npm runtime dependencies)
- **hls.js** — HLS video playback
- **AllAnime API** — Anime search and streaming
- **AniList API** — Cover art and airing schedule

## File Locations

| Data | Location |
|------|----------|
| App data | `%APPDATA%\ANI-MATE\data\` |
| Downloads | `Videos\ANI-MATE\` |

## License

MIT - [YASA Development Studio](https://yasa.work)
