# Couchcast

**Watch, clip, record and live-stream your PS5 from any browser on your home network: no capture card, no console mods.**

[Version française](README.fr.md) · 🌐 [glomepe.github.io/couchcast](https://glomepe.github.io/couchcast/)

> [!WARNING]
> **This project was vibe-coded.** It was built in a few sessions of pair-programming with an AI assistant, tested on exactly one setup (Apple Silicon Mac + PS5 over Wi-Fi), and has no automated test suite worth the name. It works on that setup. It may not work on yours. Read the code before you trust it, and expect rough edges.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Download](#download)
- [Requirements](#requirements)
- [Build from source](#build-from-source)
- [First run: pairing](#first-run-pairing)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Latency tips](#latency-tips)
- [Security & privacy](#security--privacy)
- [Known limitations](#known-limitations)
- [Credits](#credits)
- [License & trademarks](#license--trademarks)

Couchcast speaks the PS5's own **Remote Play** protocol (through [chiaki-ng](https://github.com/streetpea/chiaki-ng)'s library). It forwards the console's video **as-is** over WebRTC, with no re-encoding, so the extra latency is a few milliseconds and the Mac barely notices. The sound is decoded the way PS Remote Play does it (without Opus phase inversion, which otherwise makes it sound hollow), then re-encoded in high-bitrate Opus.

## Features

- **Low-latency player.** 1080p60 in H.264, H.265 or **H.265 HDR**, typically 2 ms of browser buffering plus network ping. Built-in latency breakdown and tips.
- **Picture calibration** like in games: one test pattern per setting (black level, white level, colour, sharpness).
- **Replay buffer & clips.** The last N minutes stay in RAM. Hit <kbd>C</kbd> (or <kbd>⌃⌥C</kbd> from anywhere) to save the last 30 s; clips from 15 s to 5 min are available.
- **Recording** with no quality loss: the PS5 stream is copied straight to disk.
- **Vertical 9:16 exports** for TikTok, Reels and Shorts: *blurred background* or *cropped* (adjustable position), encoded with VideoToolbox.
- **Live streaming** to Twitch, YouTube, TikTok LIVE or any RTMP server, landscape or vertical, to several destinations at once.
- **Library** with thumbnails, preview, download, vertical export and Finder integration.
- **Phone remote**: a mobile page to start the session, record and clip without looking away from the TV.
- **OBS source**: a clean URL (picture + sound, no UI) to add as a browser source.
- **macOS desktop app**: menu-bar icon, global shortcuts, notifications, sleep prevention.
- **French / English** interface, switchable in-app.

## How it works

```
PS5 ──Remote Play (H.264 + Opus)──► couchcast-bridge (C, chiaki-ng lib)
                                         │ binary pipe
                                         ▼
                              couchcast-server (Go, Pion WebRTC) ──WebRTC──► browser / desktop app
                                         │
                                         ├─ replay buffer (RAM) ─► clips (MP4, ffmpeg remux)
                                         ├─ recorder ─► Matroska ─► MP4
                                         └─ live outputs ─► ffmpeg (VideoToolbox) ─► RTMP
```

| Path | What |
|---|---|
| `gateway/bridge/` | C program: discovery, wake-up, pairing and streaming using chiaki-ng (built from source, patched for spectator mode). |
| `gateway/server/` | Go server: HTTP API, WebRTC (Pion), replay buffer, Matroska writer, ffmpeg jobs, live outputs, PSN account-ID helper. |
| `gateway/web/` | React UI (Vite): player, settings drawer, library, phone remote, pairing wizard. |
| `desktop/` | Electron shell: runs the server, menu-bar icon, global shortcuts. |

## Download

Grab the latest build from the **[Releases page](https://github.com/glomepe/couchcast/releases/latest)**:

| System | File |
|---|---|
| macOS (Apple Silicon, M1 and later) | [`Couchcast-mac-arm64.dmg`](https://github.com/glomepe/couchcast/releases/latest/download/Couchcast-mac-arm64.dmg) |

ffmpeg and every library are bundled. There is nothing else to install.

### Opening the app the first time

The app is **not signed** with an Apple certificate (that costs money), so macOS warns you the first time. Open the `.dmg` and drag *Couchcast* into *Applications*. Launch it once: macOS refuses. Then go to **System Settings › Privacy & Security**, scroll down to the message about Couchcast and click **Open Anyway**. If macOS says the app “is damaged”, run this once in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Couchcast.app
```

## Requirements

- **macOS on Apple Silicon** (M1 and later). Windows is not supported.
- A **PS5** with Remote Play enabled (*Settings › System › Remote Play*).
- A **secondary PSN account**, signed in on the PS5. See below.
- For vertical exports and re-encoded live streams, the Mac's hardware encoder (VideoToolbox) is used, with x264 on the CPU as a fallback.

## Build from source

**macOS**: needs [Homebrew](https://brew.sh), Node.js 22+ and the Xcode command-line tools.

```sh
git clone https://github.com/glomepe/couchcast && cd couchcast
desktop/build-app.sh --install    # builds everything and copies Couchcast.app to /Applications
```

**Server only** (no desktop app, any browser): `cd gateway && ./build.sh && ./run.sh`, then open `http://<computer-ip>:8765/`. ffmpeg must then be installed and on the PATH (`brew install ffmpeg`).

Releases are produced by the [Build & release](.github/workflows/release.yml) workflow: push a `v*` tag, or run it by hand from the *Actions* tab.

## First run: pairing

1. **Use a second PSN account.** The PS5 ends a Remote Play session as soon as a controller signed in to *the same account* wakes up on the console. If you want to keep playing on the TV while Couchcast streams, pair Couchcast with another (free) account added as a user on the PS5, and play with your main account.
2. **PSN account ID.** Click *Open Sony sign-in*, sign in **on Sony's website** with that secondary account, then paste the URL of the blank “redirect” page into the wizard. Couchcast only receives a one-time code and exchanges it for the numeric account ID, using the same public Remote Play client credentials as chiaki-ng.
3. **Pair the console.** On the PS5, signed in with the secondary account: *Settings › System › Remote Play › Pair Device*, then type the 8-digit code.

Pairing keys and stream keys are stored locally in `~/Library/Application Support/Couchcast/config.json` (file mode 600).

## Keyboard shortcuts

| In the window | | Anywhere (desktop app) | |
|---|---|---|---|
| Start stream | <kbd>Space</kbd> | Clip last 30 s | <kbd>⌃⌥C</kbd> |
| Clip last 30 s / 2 min | <kbd>C</kbd> / <kbd>⇧C</kbd> | Clip last 2 min | <kbd>⌃⌥⇧C</kbd> |
| Record | <kbd>R</kbd> | Record / stop | <kbd>⌃⌥R</kbd> |
| Fullscreen / mute | <kbd>F</kbd> / <kbd>M</kbd> | Show window | <kbd>⌃⌥S</kbd> |
| Stats / settings / library | <kbd>T</kbd> / <kbd>,</kbd> / <kbd>L</kbd> | | |
| Stop session | <kbd>⇧X</kbd> | | |
| All shortcuts | <kbd>?</kbd> | | |

## Latency tips

The app and browser add almost nothing: about 2 ms of jitter buffer and about 1 ms of decode, measured. Two things make that possible: an RTP `playout-delay` of 0 (render frames immediately, as cloud-gaming services do) and separate audio/video streams, so Chrome does not delay the picture for lip-sync. What remains is your **local network**. The UI shows a live PS5 ping.

1. **Plug the PS5 into your router with a cable.** This is by far the biggest win: from about 7 ms with spikes over Wi-Fi to under 1 ms.
2. Put the Mac on Ethernet, or on 5/6 GHz Wi-Fi close to the router.
3. While playing, `sudo ifconfig awdl0 down` stops AirDrop/Handoff from hopping the Wi-Fi radio off-channel. Re-enable with `up`, or reboot.
4. Over Wi-Fi, keep the bitrate around 15–20 Mbit/s.
5. **Sound**: Couchcast plays audio through its own low-latency path (~30 ms buffer instead of ~60 ms), but your output device adds its own delay. Display speakers (e.g. Apple Studio Display) and Bluetooth add 80–200 ms; the Mac's speakers or wired headphones stay under 20 ms. The stats show “Sound behind picture by …”.

## Security & privacy

- **There is no authentication.** Anyone on your local network who opens `http://<mac>:8765` can watch the console, start a live stream, and (if *Control the PS5* is enabled) send controller input. Only run it on a network you trust.
- Your PSN password is only typed on Sony's website. Couchcast never sees it.
- Stream keys are never sent back to the UI; only the last 4 characters are shown.

## Known limitations

- **1080p max.** Tested: asking the PS5 for 1440p or 4K, in H.264 or H.265, is refused by the console itself (`AvCap failed to initialize video`). The limit is in the PS5 firmware.
- **H.265 and HDR** are available (Settings › Stream › Codec): sharper at the same bitrate, and HDR10 on an HDR display. They need the desktop app or a recent Chrome/Edge; H.264 plays everywhere.
- DRM-protected apps (Netflix…) are not transmitted by Remote Play.
- Some server-side error messages are only in French.
- Daily use and testing on macOS 26 / M4 Pro. macOS only: Windows support was dropped.

## Credits

- [chiaki-ng](https://github.com/streetpea/chiaki-ng) (AGPL-3.0) does the actual Remote Play work. Huge thanks to its authors and to the original Chiaki project.
- [Pion WebRTC](https://github.com/pion/webrtc) (MIT), [lucide](https://lucide.dev) icons (ISC), fonts Bricolage Grotesque, IBM Plex Sans and JetBrains Mono (SIL OFL), [Electron](https://www.electronjs.org) (MIT), [ffmpeg](https://ffmpeg.org).

## License & trademarks

Couchcast is licensed under the **GNU AGPL-3.0** (see [LICENSE](LICENSE)), because it links against chiaki-ng.

Couchcast is an independent project. It is **not affiliated with, endorsed or sponsored by Sony Interactive Entertainment**. “PlayStation”, “PS5”, “DualSense” and “Remote Play” are trademarks of Sony Interactive Entertainment Inc. They are used here only to describe compatibility. Use at your own risk.
