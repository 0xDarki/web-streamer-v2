import puppeteer, { Browser, Page } from 'puppeteer';
import { spawn, ChildProcess } from 'child_process';

interface StreamConfig {
  url: string;
  rtmpsUrl: string;
  width?: number;
  height?: number;
  fps?: number;
  audioDevice?: string;
  videoDevice?: string;
  useVirtualDisplay?: boolean;
  lightweight?: boolean;
  clickSelector?: string;
  clickX?: number;
  clickY?: number;
  clickDelay?: number;
}

class WebStreamer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private xvfbProcess: ChildProcess | null = null;
  private wmProcess: ChildProcess | null = null;
  private pulseAudioProcess: ChildProcess | null = null;
  private displayNumber: number = 99;

  /**
   * Start streaming a webpage to RTMPS
   */
  async startStream(config: StreamConfig): Promise<void> {
    const {
      url,
      rtmpsUrl,
      width = 1920,
      height = 1080,
      fps = 30,
      audioDevice,
      videoDevice,
      useVirtualDisplay: configUseVirtualDisplay = false,
      lightweight = process.env.LIGHTWEIGHT === 'true',
      clickSelector,
      clickX,
      clickY,
      clickDelay = 1000,
    } = config;

    // Apply lightweight defaults if enabled
    // Lightweight mode keeps custom resolution but defaults to 1fps for minimal CPU usage
    const finalWidth = width;
    const finalHeight = height;
    const finalFps = lightweight ? (fps === 30 ? 1 : fps) : fps;

    // Determine if we need virtual display (always needed on Linux without DISPLAY)
    const useVirtualDisplay = configUseVirtualDisplay || 
                             (process.platform === 'linux' && !process.env.DISPLAY) ||
                             (process.platform === 'linux' && process.env.DISPLAY === ':99');

    console.log(`Starting stream: ${url} -> ${rtmpsUrl}`);
    console.log(`Platform: ${process.platform}, Virtual display: ${useVirtualDisplay}, Lightweight: ${lightweight}`);
    if (lightweight) {
      console.log(`Lightweight mode: ${finalWidth}x${finalHeight} @ ${finalFps}fps (optimized encoding)`);
    }

    // Setup virtual display if needed (for Railway/headless environments)
    if (useVirtualDisplay && process.platform === 'linux') {
      await this.setupVirtualDisplay(finalWidth, finalHeight);
      // Start PulseAudio for audio capture
      await this.startPulseAudio();
      // Start a simple window manager to position the browser window
      await this.startWindowManager();
    }

    // Launch browser with optimizations
    const browserArgs = [
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=' + finalWidth + ',' + finalHeight,
      '--start-fullscreen',
      '--kiosk', // Kiosk mode - hides browser UI completely
      '--window-position=0,0', // Position window at top-left
      '--disable-infobars', // Hide info bars
      '--disable-session-crashed-bubble', // Hide crash notifications
      // Set PulseAudio sink for browser audio (if using virtual display)
      ...(useVirtualDisplay && process.platform === 'linux' 
        ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
        : []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-extensions',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-notifications',
      '--disable-offer-store-unmasked-wallet-cards',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-setuid-sandbox',
      '--disable-speech-api',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--ignore-gpu-blacklist',
      '--metrics-recording-only',
      // '--mute-audio', // Don't mute - we want to capture audio
      '--no-first-run',
      '--no-pings',
      '--no-zygote',
      '--safebrowsing-disable-auto-update',
      '--enable-automation',
      '--password-store=basic',
      '--use-mock-keychain',
    ];

    // Additional lightweight optimizations
    if (lightweight) {
      browserArgs.push(
        '--disable-plugins',
        '--disable-plugins-discovery',
        '--disable-preconnect',
        '--disable-web-security',
        '--aggressive-cache-discard'
      );
    }

    // Set DISPLAY environment variable for virtual display
    if (useVirtualDisplay && process.platform === 'linux') {
      process.env.DISPLAY = `:${this.displayNumber}`;
      browserArgs.push('--display=:' + this.displayNumber);
    }

    // When using virtual display, we need headless: false so browser renders to X display
    // FFmpeg will capture from the virtual display
    this.browser = await puppeteer.launch({
      headless: false,
      args: browserArgs,
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: finalWidth, height: finalHeight });

    // Lightweight optimizations: block some resources but keep stylesheets for design
    if (lightweight) {
      await this.page.setRequestInterception(true);
      this.page.on('request', (req) => {
        const resourceType = req.resourceType();
        // Block images and media, but keep stylesheets, fonts, and essential resources
        // This ensures the web design is visible while reducing load
        if (['image', 'media'].includes(resourceType)) {
          req.abort().catch(() => {}); // Ignore errors
        } else {
          req.continue().catch(() => {}); // Ignore errors
        }
      });
    }

    // Navigate to the webpage
    console.log(`Navigating to ${url}...`);
    await this.page.goto(url, { 
      waitUntil: lightweight ? 'domcontentloaded' : 'networkidle2',
      timeout: lightweight ? 10000 : 30000 
    });

    // Wait a bit for page to fully load (less time in lightweight mode)
    await new Promise((resolve) => setTimeout(resolve, lightweight ? 1000 : 2000));

    // Kiosk mode should already hide browser UI completely
    // The --kiosk flag removes all browser chrome (tabs, address bar, etc.)

    // Perform click action if specified (to enable audio playback)
    if (clickSelector || (clickX !== undefined && clickY !== undefined)) {
      await this.performClick(clickSelector, clickX, clickY, clickDelay);
    }

    // Additional wait to ensure page is fully rendered before capturing
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Position browser window at 0,0 in virtual display (if using virtual display)
    if (useVirtualDisplay && process.platform === 'linux') {
      // Wait a bit for browser to fully start, then position window
      setTimeout(() => {
        const { exec } = require('child_process');
        exec(`DISPLAY=:${this.displayNumber} xdotool search --name "Chromium" windowmove 0 0 windowsize ${finalWidth} ${finalHeight} windowraise 2>/dev/null || true`, (error: any) => {
          if (error) {
            console.log('Window positioning attempted (xdotool may not be available)');
          } else {
            console.log('Browser window positioned at 0,0');
          }
        });
      }, 1000);
    }

    // Start FFmpeg streaming
    await this.startFFmpegStream(rtmpsUrl, finalWidth, finalHeight, finalFps, audioDevice, videoDevice, useVirtualDisplay, lightweight);

    console.log('Stream started successfully!');
  }

  /**
   * Perform a click action on the page (to enable audio playback)
   */
  private async performClick(
    selector?: string,
    x?: number,
    y?: number,
    delay: number = 1000
  ): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    try {
      if (selector) {
        console.log(`Clicking element with selector: ${selector}`);
        await this.page.waitForSelector(selector, { timeout: 5000 });
        await this.page.click(selector);
        console.log('Click performed successfully');
      } else if (x !== undefined && y !== undefined) {
        console.log(`Clicking at coordinates: (${x}, ${y})`);
        await this.page.mouse.click(x, y);
        console.log('Click performed successfully');
      }

      // Wait a bit after clicking (for audio to start)
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.warn(`Warning: Click action failed: ${error}`);
      // Don't throw - continue anyway as click might not be critical
    }
  }

  /**
   * Start PulseAudio for audio capture
   */
  private async startPulseAudio(): Promise<void> {
    return new Promise((resolve) => {
      console.log('Starting PulseAudio for audio capture...');
      
      // Start PulseAudio daemon
      this.pulseAudioProcess = spawn('pulseaudio', [
        '--start',
        '--exit-idle-time=-1',
        '--system=false',
        '--disallow-exit',
      ]);

      this.pulseAudioProcess.on('error', (error) => {
        console.warn(`PulseAudio start warning: ${error.message}`);
        // Continue anyway - audio might not be critical
      });

      // Wait for PulseAudio to start, then create a virtual sink
      setTimeout(() => {
        console.log('PulseAudio started, creating virtual sink...');
        
        // Create a null sink (virtual audio device) that we can monitor
        const { exec } = require('child_process');
        exec('pactl load-module module-null-sink sink_name=stream_sink sink_properties=device.description="StreamSink"', (error: any) => {
          if (error) {
            console.warn('Could not create virtual sink, audio capture may not work');
          } else {
            console.log('Virtual sink created successfully');
          }
          resolve();
        });
      }, 2000);
    });
  }

  /**
   * Start a simple window manager to position browser window
   */
  private async startWindowManager(): Promise<void> {
    return new Promise((resolve) => {
      // Use openbox or fluxbox if available, otherwise use xdotool to position window
      // For simplicity, we'll use xdotool after browser starts
      console.log('Window manager will position browser window after launch');
      setTimeout(() => resolve(), 500);
    });
  }

  /**
   * Setup virtual display (Xvfb) for headless environments
   */
  private async setupVirtualDisplay(width: number, height: number): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`Setting up virtual display :${this.displayNumber} (${width}x${height})`);
      
      this.xvfbProcess = spawn('Xvfb', [
        `:${this.displayNumber}`,
        '-screen', '0', `${width}x${height}x24`,
        '-ac',
        '+extension', 'GLX',
        '+render',
        '-noreset',
      ]);

      this.xvfbProcess.stdout?.on('data', (data: Buffer) => {
        console.log(`Xvfb stdout: ${data.toString()}`);
      });

      this.xvfbProcess.stderr?.on('data', (data: Buffer) => {
        // Xvfb outputs to stderr, but it's usually not an error
        const output = data.toString();
        if (output.includes('error') || output.includes('Error')) {
          console.error(`Xvfb error: ${output}`);
        }
      });

      this.xvfbProcess.on('error', (error: Error) => {
        console.error('Xvfb process error:', error);
        reject(new Error(`Failed to start Xvfb: ${error.message}. Make sure Xvfb is installed.`));
      });

      // Wait a moment for Xvfb to start
      setTimeout(() => {
        if (this.xvfbProcess && !this.xvfbProcess.killed) {
          console.log('Virtual display started successfully');
          resolve();
        } else {
          reject(new Error('Xvfb process failed to start'));
        }
      }, 1000);
    });
  }

  /**
   * Retry FFmpeg with silent audio if audio capture fails
   */
  private async retryWithSilentAudio(
    rtmpsUrl: string,
    width: number,
    height: number,
    fps: number,
    useVirtualDisplay: boolean,
    lightweight: boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const platform = process.platform;
      let inputOptions: string[] = [];
      const display = process.env.DISPLAY || ':0.0';
      const videoInput = `${display}+0,0`;
      
      inputOptions = [
        '-f', 'x11grab',
        '-framerate', fps.toString(),
        '-video_size', `${width}x${height}`,
        '-i', videoInput,
        '-f', 'lavfi',
        '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      ];

      const preset = lightweight ? 'ultrafast' : 'veryfast';
      const crf = lightweight ? '28' : '23';
      const maxrate = lightweight ? '1500k' : '4000k';
      const bufsize = lightweight ? '3000k' : '8000k';
      const audioBitrate = lightweight ? '64k' : '128k';
      const audioSampleRate = lightweight ? '22050' : '44100';
      const gopSize = fps <= 1 ? fps.toString() : (2 * fps).toString();

      const outputOptions = [
        '-c:v', 'libx264',
        '-preset', preset,
        '-tune', 'zerolatency',
        '-crf', crf,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-pix_fmt', 'yuv420p',
        '-g', gopSize,
        '-threads', lightweight ? '2' : '0',
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-ar', audioSampleRate,
        '-ac', '2',
        '-f', 'flv',
        rtmpsUrl,
      ];

      const ffmpegArgs = [...inputOptions, ...outputOptions];
      console.log('Retrying FFmpeg with silent audio:', ffmpegArgs.join(' '));

      this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      if (this.ffmpegProcess.stdout) {
        this.ffmpegProcess.stdout.on('data', (data: Buffer) => {
          console.log(`FFmpeg stdout: ${data.toString()}`);
        });
      }

      if (this.ffmpegProcess.stderr) {
        this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          if (output.includes('error') || output.includes('Error')) {
            console.error(`FFmpeg error: ${output}`);
          } else {
            console.log(`FFmpeg: ${output}`);
          }
        });
      }

      // Track if we've already retried
      let hasRetried = false;
      
      this.ffmpegProcess.on('close', (code: number) => {
        console.log(`FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
          // If audio capture fails and we haven't retried, try with silent audio
          if (useVirtualDisplay && !hasRetried) {
            hasRetried = true;
            console.log('Audio capture failed, retrying with silent audio...');
            this.retryWithSilentAudio(rtmpsUrl, width, height, fps, useVirtualDisplay, lightweight)
              .then(resolve)
              .catch((retryError) => {
                reject(new Error(`FFmpeg exited with code ${code}. Retry also failed: ${retryError.message}`));
              });
          } else {
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        }
      });

      this.ffmpegProcess.on('error', (error: Error) => {
        reject(error);
      });

      setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
          resolve();
        }
      }, 2000);
    });
  }

  /**
   * Start FFmpeg process to capture screen/audio and stream to RTMPS
   */
  private async startFFmpegStream(
    rtmpsUrl: string,
    width: number,
    height: number,
    fps: number,
    audioDevice?: string,
    videoDevice?: string,
    useVirtualDisplay: boolean = false,
    lightweight: boolean = false
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Detect platform for screen capture
      const platform = process.platform;
      let inputOptions: string[] = [];
      let videoInput = '';
      let audioInput = '';

      if (platform === 'darwin') {
        // macOS - use avfoundation
        // List available devices: ffmpeg -f avfoundation -list_devices true -i ""
        videoInput = videoDevice || '1'; // Default screen capture
        audioInput = audioDevice || ':0'; // Default system audio
        inputOptions = [
          '-f', 'avfoundation',
          '-framerate', fps.toString(),
          '-video_size', `${width}x${height}`,
          '-i', `${videoInput}:${audioInput}`,
        ];
      } else if (platform === 'linux') {
        // Linux - use x11grab for video
        const display = process.env.DISPLAY || ':0.0';
        videoInput = `${display}+0,0`;
        inputOptions = [
          '-f', 'x11grab',
          '-framerate', fps.toString(),
          '-video_size', `${width}x${height}`,
          '-i', videoInput,
        ];

        // For Railway/headless: try to capture audio from PulseAudio
        if (useVirtualDisplay) {
          // Try to use PulseAudio to capture browser audio
          // Use the monitor of our virtual sink (stream_sink.monitor)
          const audioSource = audioDevice || 'stream_sink.monitor';
          inputOptions.push(
            '-f', 'pulse',
            '-ac', '2',
            '-ar', '44100',
            '-i', audioSource
          );
          // Note: This requires PulseAudio to be running
          // If it fails, FFmpeg will show an error but continue with video only
        } else {
          // Try to use pulse audio if available
          inputOptions.push(
            '-f', 'pulse',
            '-ac', '2',
            '-i', audioDevice || 'default'
          );
        }
      } else if (platform === 'win32') {
        // Windows - use gdigrab for video and dshow for audio
        inputOptions = [
          '-f', 'gdigrab',
          '-framerate', fps.toString(),
          '-video_size', `${width}x${height}`,
          '-i', 'desktop',
          '-f', 'dshow',
          '-i', audioDevice || 'audio="Stereo Mix (Realtek Audio)"',
        ];
      } else {
        reject(new Error(`Unsupported platform: ${platform}`));
        return;
      }

      // RTMPS output options - optimized for lightweight mode
      const preset = lightweight ? 'ultrafast' : 'veryfast';
      const crf = lightweight ? '28' : '23'; // Higher CRF = lower quality, lower CPU
      const maxrate = lightweight ? '1500k' : '4000k';
      const bufsize = lightweight ? '3000k' : '8000k';
      const audioBitrate = lightweight ? '64k' : '128k';
      const audioSampleRate = lightweight ? '22050' : '44100';

      const outputOptions = [
        '-c:v', 'libx264',
        '-preset', preset,
        '-tune', 'zerolatency',
        '-crf', crf,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-pix_fmt', 'yuv420p',
        '-g', (2 * fps).toString(), // GOP size
        '-threads', lightweight ? '2' : '0', // Limit threads in lightweight mode
        '-c:a', 'aac',
        '-b:a', audioBitrate,
        '-ar', audioSampleRate,
        '-ac', '2',
        '-f', 'flv',
        rtmpsUrl,
      ];

      // Build FFmpeg command
      const ffmpegArgs = [...inputOptions, ...outputOptions];

      console.log('Starting FFmpeg with args:', ffmpegArgs.join(' '));

      // Spawn FFmpeg process
      this.ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

      if (this.ffmpegProcess.stdout) {
        this.ffmpegProcess.stdout.on('data', (data: Buffer) => {
          console.log(`FFmpeg stdout: ${data.toString()}`);
        });
      }

      if (this.ffmpegProcess.stderr) {
        this.ffmpegProcess.stderr.on('data', (data: Buffer) => {
          const output = data.toString();
          // FFmpeg outputs to stderr by default
          if (output.includes('error') || output.includes('Error')) {
            console.error(`FFmpeg error: ${output}`);
          } else {
            console.log(`FFmpeg: ${output}`);
          }
        });
      }

      this.ffmpegProcess.on('close', (code: number) => {
        console.log(`FFmpeg process exited with code ${code}`);
        if (code !== 0 && code !== null) {
          // Check if it's an audio error and we're using virtual display
          // If so, retry with silent audio
          if (useVirtualDisplay) {
            console.log('FFmpeg failed, may be audio issue. Retrying with silent audio...');
            this.retryWithSilentAudio(rtmpsUrl, width, height, fps, useVirtualDisplay, lightweight)
              .then(resolve)
              .catch((retryError) => {
                reject(new Error(`FFmpeg exited with code ${code}. Retry also failed: ${retryError.message}`));
              });
          } else {
            reject(new Error(`FFmpeg exited with code ${code}`));
          }
        }
      });

      this.ffmpegProcess.on('error', (error: Error) => {
        console.error('FFmpeg process error:', error);
        reject(error);
      });

      // Wait a moment to see if FFmpeg starts successfully
      setTimeout(() => {
        if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
          resolve();
        }
      }, 2000);
    });
  }

  /**
   * Stop the stream
   */
  async stopStream(): Promise<void> {
    console.log('Stopping stream...');

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGTERM');
      this.ffmpegProcess = null;
    }

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }

    if (this.wmProcess) {
      this.wmProcess.kill('SIGTERM');
      this.wmProcess = null;
    }

    if (this.pulseAudioProcess) {
      this.pulseAudioProcess.kill('SIGTERM');
      this.pulseAudioProcess = null;
    }

    if (this.xvfbProcess) {
      this.xvfbProcess.kill('SIGTERM');
      this.xvfbProcess = null;
    }

    console.log('Stream stopped.');
  }

  /**
   * List available audio/video devices (macOS only)
   */
  static async listDevices(): Promise<void> {
    if (process.platform !== 'darwin') {
      console.log('Device listing is only available on macOS');
      return;
    }

    return new Promise((resolve) => {
      const process = spawn('ffmpeg', [
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', '',
      ]);

      process.stderr.on('data', (data: Buffer) => {
        console.log(data.toString());
      });

      process.on('close', () => {
        resolve();
      });
    });
  }
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  // Check for list-devices flag
  if (args.includes('--list-devices')) {
    await WebStreamer.listDevices();
    process.exit(0);
  }

  // Support environment variables for Railway deployment
  const url = process.env.WEBPAGE_URL || args[0];
  const rtmpsUrl = process.env.RTMPS_URL || args[1];

  if (!url || !rtmpsUrl) {
    console.log('Usage: npm start <webpage-url> <rtmps-url> [options]');
    console.log('');
    console.log('Or set environment variables:');
    console.log('  WEBPAGE_URL - The webpage URL to stream');
    console.log('  RTMPS_URL - The RTMPS streaming endpoint');
    console.log('');
    console.log('Options:');
    console.log('  --width <number>     Video width (default: 1920)');
    console.log('  --height <number>    Video height (default: 1080)');
    console.log('  --fps <number>       Frame rate (default: 30, lightweight default: 1)');
    console.log('  --lightweight        Enable lightweight mode (optimized encoding, 1fps default)');
    console.log('  --click-selector <s> CSS selector to click (e.g., "button.play")');
    console.log('  --click-x <number>   X coordinate to click (requires --click-y)');
    console.log('  --click-y <number>   Y coordinate to click (requires --click-x)');
    console.log('  --click-delay <ms>   Delay after click in milliseconds (default: 1000)');
    console.log('  --audio-device <id>  Audio device ID (macOS only)');
    console.log('  --video-device <id>  Video device ID (macOS only)');
    console.log('  --list-devices       List available devices (macOS only)');
    console.log('');
    console.log('Examples:');
    console.log('  npm start https://example.com rtmps://stream.example.com/live/streamkey');
    console.log('  npm start https://example.com rtmps://... --lightweight');
    console.log('  LIGHTWEIGHT=true npm start https://example.com rtmps://...');
    process.exit(1);
  }

  // Parse options (command line args take precedence over env vars)
  const widthIndex = args.indexOf('--width');
  const heightIndex = args.indexOf('--height');
  const fpsIndex = args.indexOf('--fps');
  const clickSelectorIndex = args.indexOf('--click-selector');
  const clickXIndex = args.indexOf('--click-x');
  const clickYIndex = args.indexOf('--click-y');
  const clickDelayIndex = args.indexOf('--click-delay');
  const audioDeviceIndex = args.indexOf('--audio-device');
  const videoDeviceIndex = args.indexOf('--video-device');
  const lightweight = args.includes('--lightweight') || process.env.LIGHTWEIGHT === 'true';

  const config: StreamConfig = {
    url,
    rtmpsUrl,
    width: widthIndex !== -1 
      ? parseInt(args[widthIndex + 1]) 
      : parseInt(process.env.WIDTH || '1920'),
    height: heightIndex !== -1 
      ? parseInt(args[heightIndex + 1]) 
      : parseInt(process.env.HEIGHT || '1080'),
    fps: fpsIndex !== -1 
      ? parseInt(args[fpsIndex + 1]) 
      : parseInt(process.env.FPS || '30'),
    clickSelector: clickSelectorIndex !== -1 
      ? args[clickSelectorIndex + 1] 
      : process.env.CLICK_SELECTOR,
    clickX: clickXIndex !== -1 
      ? parseInt(args[clickXIndex + 1]) 
      : process.env.CLICK_X ? parseInt(process.env.CLICK_X) : undefined,
    clickY: clickYIndex !== -1 
      ? parseInt(args[clickYIndex + 1]) 
      : process.env.CLICK_Y ? parseInt(process.env.CLICK_Y) : undefined,
    clickDelay: clickDelayIndex !== -1 
      ? parseInt(args[clickDelayIndex + 1]) 
      : parseInt(process.env.CLICK_DELAY || '1000'),
    audioDevice: audioDeviceIndex !== -1 ? args[audioDeviceIndex + 1] : undefined,
    videoDevice: videoDeviceIndex !== -1 ? args[videoDeviceIndex + 1] : undefined,
    useVirtualDisplay: process.env.USE_VIRTUAL_DISPLAY === 'true' || 
                       (process.platform === 'linux' && (!process.env.DISPLAY || process.env.DISPLAY === ':99')),
    lightweight,
  };

  const streamer = new WebStreamer();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nReceived SIGINT, shutting down...');
    await streamer.stopStream();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\nReceived SIGTERM, shutting down...');
    await streamer.stopStream();
    process.exit(0);
  });

  try {
    await streamer.startStream(config);
    console.log('Stream is running. Press Ctrl+C to stop.');
  } catch (error) {
    console.error('Error starting stream:', error);
    await streamer.stopStream();
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { WebStreamer, StreamConfig };

