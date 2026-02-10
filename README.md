# YASA Development Studio Presents

# ANI-MATE

**Free Anime For All**

A cyberpunk-themed desktop app for searching, streaming, and downloading anime. No external player needed.

![ANI-MATE](assets/icon.png)

## Download

Get the latest installer from [Releases](../../releases).

Download `ANI-MATE Setup 0.2.0.exe`, run it, and you're good to go.

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
- Cyberpunk UI with animated splash intro

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Focus search bar |
| `Enter` | Play selected episode |
| `Escape` | Close player |
| `Left/Right` | Previous/next episode |
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

Output: `dist/ANI-MATE Setup 0.2.0.exe`

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
