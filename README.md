# Web Streamer v2

A TypeScript application to stream a webpage with audio to an RTMPS (Real-Time Messaging Protocol Secure) endpoint.

## Features

- Stream any webpage to RTMPS
- Capture system audio along with video
- Cross-platform support (macOS, Linux, Windows)
- Configurable video resolution and frame rate
- Browser automation with Puppeteer

## Prerequisites

1. **Node.js** (v16 or higher)
2. **FFmpeg** - Must be installed and available in your PATH
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt-get install ffmpeg` (Ubuntu/Debian) or `sudo yum install ffmpeg` (CentOS/RHEL)
   - Windows: Download from [FFmpeg website](https://ffmpeg.org/download.html)

## Installation

```bash
npm install
```

## Usage

### Basic Usage

```bash
npm start <webpage-url> <rtmps-url>
```

Example:
```bash
npm start https://example.com rtmps://stream.example.com/live/your-stream-key
```

### Advanced Options

```bash
npm start <webpage-url> <rtmps-url> [options]
```

Options:
- `--width <number>` - Video width in pixels (default: 1920)
- `--height <number>` - Video height in pixels (default: 1080)
- `--fps <number>` - Frame rate (default: 30, lightweight mode default: 1)
- `--lightweight` - Enable lightweight mode (1920x1080 @ 1fps, optimized encoding)
- `--click-selector <selector>` - CSS selector to click (e.g., `button.play`, `#play-button`)
- `--click-x <number>` - X coordinate to click (requires `--click-y`)
- `--click-y <number>` - Y coordinate to click (requires `--click-x`)
- `--click-delay <ms>` - Delay after click in milliseconds (default: 1000)
- `--audio-device <id>` - Audio device ID (macOS only)
- `--video-device <id>` - Video device ID (macOS only)
- `--list-devices` - List available audio/video devices (macOS only)

### Examples

```bash
# Stream with custom resolution
npm start https://example.com rtmps://stream.example.com/live/key --width 1280 --height 720

# Stream with custom frame rate
npm start https://example.com rtmps://stream.example.com/live/key --fps 60

# List available devices (macOS)
npm start --list-devices

# Stream with specific audio device (macOS)
npm start https://example.com rtmps://stream.example.com/live/key --audio-device ":0"

# Stream in lightweight mode (1920x1080 @ 1fps, optimized encoding)
npm start https://example.com rtmps://stream.example.com/live/key --lightweight

# Click a button to start audio playback (using CSS selector)
npm start https://example.com rtmps://stream.example.com/live/key --click-selector "button.play"

# Click using aria-label attribute
npm start https://example.com rtmps://stream.example.com/live/key --click-selector "[aria-label='Play']"
npm start https://example.com rtmps://stream.example.com/live/key --click-selector "button[aria-label='Play']"

# Click at specific coordinates to start audio
npm start https://example.com rtmps://stream.example.com/live/key --click-x 960 --click-y 540

# Click with custom delay (wait 2 seconds after click)
npm start https://example.com rtmps://stream.example.com/live/key --click-selector "button.play" --click-delay 2000

# Lightweight mode with custom resolution
npm start https://example.com rtmps://stream.example.com/live/key --lightweight --width 1920 --height 1080 --fps 1

# Or with environment variable
LIGHTWEIGHT=true npm start https://example.com rtmps://stream.example.com/live/key
```

## Platform-Specific Notes

### macOS

- Uses `avfoundation` for screen and audio capture
- To list available devices: `npm start --list-devices`
- Default audio device is system audio (`:0`)
- Default video device is screen capture (`1`)

### Linux

- Uses `x11grab` for screen capture
- Uses `pulse` for audio capture
- Requires X11 display server
- Set `DISPLAY` environment variable if needed: `export DISPLAY=:0.0`

### Windows

- Uses `gdigrab` for screen capture
- Uses `dshow` (DirectShow) for audio capture
- You may need to enable "Stereo Mix" in Windows sound settings

## RTMPS URL Format

The RTMPS URL should follow this format:
```
rtmps://hostname:port/app/stream-key
```

Common platforms:
- **YouTube Live**: `rtmps://a.rtmp.youtube.com/live2/your-stream-key`
- **Twitch**: `rtmps://live.twitch.tv/app/your-stream-key`
- **Facebook Live**: `rtmps://live-api-s.facebook.com:443/rtmp/your-stream-key`

## Development

```bash
# Build TypeScript
npm run build

# Run in development mode (with ts-node)
npm run dev <webpage-url> <rtmps-url>
```

## Railway Deployment

This application is configured to run on [Railway](https://railway.app), a cloud platform for deploying applications.

### Prerequisites

1. A Railway account ([sign up here](https://railway.app))
2. Railway CLI (optional): `npm i -g @railway/cli`

### Deployment Steps

1. **Create a new Railway project:**
   - Go to [Railway Dashboard](https://railway.app/dashboard)
   - Click "New Project"
   - Select "Deploy from GitHub repo" (recommended) or "Empty Project"

2. **Set Environment Variables:**
   In your Railway project settings, add these environment variables:
   - `WEBPAGE_URL` - The URL of the webpage to stream (e.g., `https://example.com`)
   - `RTMPS_URL` - Your RTMPS streaming endpoint (e.g., `rtmps://stream.example.com/live/key`)
   - `WIDTH` (optional) - Video width in pixels (default: 1920)
   - `HEIGHT` (optional) - Video height in pixels (default: 1080)
   - `FPS` (optional) - Frame rate (default: 30, lightweight default: 1)
   - `LIGHTWEIGHT` (optional) - Set to `true` to enable lightweight mode (optimized encoding, 1fps default)
   - `CLICK_SELECTOR` (optional) - CSS selector to click (e.g., `button.play`)
   - `CLICK_X` (optional) - X coordinate to click (requires `CLICK_Y`)
   - `CLICK_Y` (optional) - Y coordinate to click (requires `CLICK_X`)
   - `CLICK_DELAY` (optional) - Delay after click in milliseconds (default: 1000)

3. **Deploy:**
   - If using GitHub: Push your code and Railway will automatically deploy
   - If using Railway CLI: Run `railway up`

### Railway-Specific Features

- **Automatic virtual display**: Uses Xvfb for headless screen capture
- **Headless browser**: Puppeteer runs in headless mode automatically
- **Silent audio**: Uses virtual audio source (anullsrc) since system audio isn't available in containers

### Railway Configuration

The project includes:
- `Dockerfile` - Container configuration with all dependencies
- `railway.json` - Railway deployment configuration
- `.dockerignore` - Files to exclude from Docker build

### Notes for Railway

- The application automatically detects Railway environment and uses virtual display
- Audio will be silent by default (virtual audio source) since Railway containers don't have access to system audio
- The stream will start automatically when the container starts

## Lightweight Mode

The application includes a **lightweight mode** that significantly reduces CPU usage through optimized encoding and low frame rates:

### Lightweight Mode Features

- **Low frame rate**: Default 1fps (instead of 30fps) - **90%+ CPU reduction**
- **Full resolution support**: Works with any resolution (1920x1080, 1280x720, etc.)
- **Ultrafast encoding**: Uses FFmpeg `ultrafast` preset
- **Optimized bitrate**: Lower bitrate for low fps streams (1.5Mbps for 1fps)
- **Blocked resources**: Images, fonts, stylesheets blocked
- **Optimized browser**: Many Chrome features disabled
- **Limited threads**: FFmpeg uses only 2 threads
- **Higher CRF**: Lower quality encoding (CRF 28) for faster processing

### Enable Lightweight Mode

```bash
# Command line flag
npm start <url> <rtmps-url> --lightweight

# Environment variable
LIGHTWEIGHT=true npm start <url> <rtmps-url>

# Railway
# Set environment variable: LIGHTWEIGHT=true
```

### Resource Comparison

| Mode | Resolution | FPS | vCPU | RAM | Use Case |
|------|-----------|-----|------|-----|----------|
| **Lightweight** | 1920x1080 | 1 | **0.5-1** | **512MB-1GB** | Static/slow pages, Railway Hobby plan |
| **Lightweight** | 1280x720 | 1 | **0.5-1** | **400-800MB** | Even lighter option |
| Standard | 1920x1080 | 30 | 2-4 | 2-4GB | Normal quality streaming |
| High Quality | 1920x1080 | 60 | 6-8 | 6-8GB | Premium streaming |

**Note**: Lightweight mode at 1fps is perfect for:
- Static webpages or dashboards
- Pages that update slowly
- Monitoring/status pages
- Slideshows or presentations

## Resource Requirements

### Estimated Resource Usage

This application is resource-intensive due to running both a headless browser (Puppeteer/Chromium) and FFmpeg encoding simultaneously.

#### Lightweight Mode (Recommended for Low Resources)
- **vCPU**: 0.5-1 vCPU (very low CPU usage at 1fps)
- **RAM**: 512 MB - 1 GB
- **Use case**: 1080p @ 1fps, static/slow-updating webpages, Railway Hobby plan
- **Enable**: `--lightweight` flag or `LIGHTWEIGHT=true`
- **Best for**: Dashboards, status pages, static content, slideshows

#### Minimum Requirements (Basic Streaming)
- **vCPU**: 2 vCPUs
- **RAM**: 2 GB
- **Use case**: 720p @ 30fps, simple webpages

#### Recommended Requirements (Standard Streaming)
- **vCPU**: 4 vCPUs
- **RAM**: 4 GB
- **Use case**: 1080p @ 30fps, moderate complexity webpages

#### High-Performance Requirements (High-Quality Streaming)
- **vCPU**: 6-8 vCPUs
- **RAM**: 6-8 GB
- **Use case**: 1080p @ 60fps, complex webpages with animations/video

### Resource Breakdown

#### Puppeteer/Chromium (Headless Browser)
- **RAM**: 150-300 MB base + 50-200 MB per page complexity
- **CPU**: 30-60% on 2 vCPU (can spike to 95% during page loads)
- **Peak usage**: During initial page load and rendering

#### FFmpeg (Video Encoding & Streaming)
- **RAM**: 200-500 MB base + 100-500 MB per resolution/quality
- **CPU**: 40-90% on 2 vCPU (depends on encoding preset and resolution)
- **Peak usage**: Continuous during streaming

#### Xvfb (Virtual Display)
- **RAM**: ~50-100 MB
- **CPU**: ~5-10% (minimal)

#### Node.js Runtime
- **RAM**: ~50-100 MB
- **CPU**: ~5-10%

### Railway Pricing Considerations

Based on Railway's pricing (as of 2024):
- **Hobby Plan**: 512 MB RAM, 1 vCPU - **Works with lightweight mode** ⚡
- **Developer Plan**: 2 GB RAM, 2 vCPU - **Minimum for standard mode**, comfortable with lightweight
- **Pro Plan**: 4-8 GB RAM, 4-8 vCPU - **Recommended** for reliable standard/high-quality streaming

**💡 Tip**: Use `LIGHTWEIGHT=true` environment variable on Railway to run on the Hobby plan!

### Optimization Tips

1. **Use lightweight mode**: Enable `--lightweight` or `LIGHTWEIGHT=true` for 60-70% resource reduction
2. **Lower resolution**: Reduce `WIDTH` and `HEIGHT` to decrease CPU/RAM usage
3. **Lower frame rate**: Reduce `FPS` (e.g., 15fps instead of 30fps)
4. **FFmpeg preset**: 
   - Lightweight mode uses `ultrafast` (lowest CPU)
   - Standard mode uses `veryfast` (good balance)
5. **Block resources**: Lightweight mode automatically blocks images/fonts/stylesheets
6. **Monitor resources**: Use Railway's metrics to track actual usage

### Actual Usage Monitoring

Monitor your Railway deployment:
- Check Railway dashboard metrics
- Watch for OOM (Out of Memory) errors
- Monitor CPU throttling warnings
- Adjust resources based on actual usage patterns

### Railway CLI Alternative

If you prefer using Railway CLI, you can also set environment variables via CLI:

```bash
railway variables set WEBPAGE_URL=https://example.com
railway variables set RTMPS_URL=rtmps://stream.example.com/live/key
railway variables set WIDTH=1920
railway variables set HEIGHT=1080
railway variables set FPS=30
```

## How It Works

1. Launches a browser (Puppeteer) and navigates to the specified webpage
   - On Railway/headless: Uses virtual display (Xvfb) and headless browser
   - On local: Uses visible browser window
2. Uses FFmpeg to capture the screen and audio
   - On Railway: Captures from virtual display with silent audio
   - On local: Captures from physical display and system audio
3. Encodes the stream using H.264 (video) and AAC (audio)
4. Streams the encoded content to the RTMPS endpoint

## Troubleshooting

### FFmpeg not found
Make sure FFmpeg is installed and available in your PATH. Test with:
```bash
ffmpeg -version
```

### Audio not captured
- On macOS: Check device list with `--list-devices` and specify the correct audio device
- On Linux: Ensure PulseAudio is running
- On Windows: Enable "Stereo Mix" in sound settings

### Connection issues
- Verify your RTMPS URL is correct
- Check firewall settings
- Ensure the streaming service accepts RTMPS connections

### Browser issues
- The browser window will open visibly (not headless) to capture the screen
- Make sure the browser window is not minimized or covered

## License

MIT

