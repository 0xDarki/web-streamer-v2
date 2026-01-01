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
  streamWidth?: number;
  streamHeight?: number;
}

class WebStreamer {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private ffmpegProcess: ChildProcess | null = null;
  private xvfbProcess: ChildProcess | null = null;
  private wmProcess: ChildProcess | null = null;
  private pulseAudioProcess: ChildProcess | null = null;
  private parecProcess: ChildProcess | null = null;
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
      streamWidth,
      streamHeight,
    } = config;

    // Apply lightweight defaults if enabled
    // Lightweight mode keeps custom resolution but defaults to 1fps for minimal CPU usage
    const finalWidth = width;
    const finalHeight = height;
    const finalFps = lightweight ? (fps === 30 ? 1 : fps) : fps;
    
    // Stream resolution (can be different from browser resolution)
    // If not specified, use browser resolution
    const streamWidthFinal = streamWidth !== undefined ? streamWidth : width;
    const streamHeightFinal = streamHeight !== undefined ? streamHeight : height;

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
      '--start-maximized',
      '--window-position=0,0', // Position window at top-left
      '--disable-infobars', // Hide info bars
      '--disable-session-crashed-bubble', // Hide crash notifications
      // Note: Using --app mode would load URL automatically, but we'll navigate manually for better control
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
      // Configure PulseAudio environment for browser to use stream_sink
      if (useVirtualDisplay && process.platform === 'linux') {
        // Set PulseAudio environment variables so browser uses stream_sink
        process.env.PULSE_RUNTIME_PATH = process.env.HOME ? `${process.env.HOME}/.config/pulse` : '/tmp/pulse';
        process.env.PULSE_STATE_PATH = process.env.HOME ? `${process.env.HOME}/.config/pulse` : '/tmp/pulse';
        // Force browser to use stream_sink
        process.env.PULSE_SINK = 'stream_sink';
        // Force browser to use PulseAudio instead of ALSA
        process.env.PULSE_SERVER = 'unix:/tmp/pulse-socket';
        // Disable ALSA fallback
        delete process.env.ALSA_CARD;
        delete process.env.ALSA_DEVICE;
        
        // Create pulse directory if it doesn't exist
        const { execSync } = require('child_process');
        try {
          execSync('mkdir -p /tmp/pulse 2>/dev/null || true');
        } catch (e) {
          // Ignore errors
        }
      }

    // Use app mode to hide browser UI - launch with URL directly
    // Pass PulseAudio environment to browser process
    const browserEnv = { ...process.env };
    if (useVirtualDisplay && process.platform === 'linux') {
      browserEnv.PULSE_SINK = 'stream_sink';
      browserEnv.PULSE_RUNTIME_PATH = process.env.PULSE_RUNTIME_PATH || '/tmp/pulse';
      browserEnv.PULSE_STATE_PATH = process.env.PULSE_STATE_PATH || '/tmp/pulse';
    }
    
    this.browser = await puppeteer.launch({
      headless: false,
      args: [...browserArgs, `--app=${url}`], // App mode hides browser UI
      env: browserEnv, // Pass environment variables to browser
    });

    // In app mode, the page is already loaded, so get it
    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();
    await this.page.setViewport({ width: finalWidth, height: finalHeight });

    // Lightweight optimizations: block some resources but keep stylesheets, fonts, and audio for design and sound
    if (lightweight) {
      await this.page.setRequestInterception(true);
      this.page.on('request', (req) => {
        const resourceType = req.resourceType();
        const url = req.url();
        
        // Block images and video, but keep:
        // - stylesheets (for design)
        // - fonts (for text rendering)
        // - media/audio files (for sound - check if it's audio)
        // This ensures the web design is visible and audio works while reducing load
        
        // Check if it's an audio file by extension or MIME type
        const isAudio = url.match(/\.(mp3|wav|ogg|aac|m4a|flac|opus|webm)(\?|$)/i) || 
                       req.headers()['content-type']?.match(/audio\//i);
        
        if (resourceType === 'image') {
          req.abort().catch(() => {}); // Block images
        } else if (resourceType === 'media' && !isAudio) {
          req.abort().catch(() => {}); // Block video but allow audio
        } else {
          req.continue().catch(() => {}); // Allow everything else (including audio)
        }
      });
    }

    // In app mode, page is already loaded, just wait for it to be ready
    const currentUrl = this.page.url();
    if (currentUrl && currentUrl !== 'about:blank' && currentUrl.includes(url.split('?')[0])) {
      console.log(`Page already loaded in app mode (no browser UI)`);
      // Wait for page to be fully ready
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } else {
      // Navigate to the webpage (fallback if app mode didn't work)
      console.log(`Navigating to ${url}...`);
      await this.page.goto(url, { 
        waitUntil: lightweight ? 'domcontentloaded' : 'networkidle2',
        timeout: lightweight ? 10000 : 30000 
      });
    }

    // Wait a bit for page to fully load (less time in lightweight mode)
    await new Promise((resolve) => setTimeout(resolve, lightweight ? 1000 : 2000));

    // Kiosk mode should already hide browser UI completely
    // The --kiosk flag removes all browser chrome (tabs, address bar, etc.)

    // Perform click action if specified (to enable audio playback)
    if (clickSelector || (clickX !== undefined && clickY !== undefined)) {
      // Wait a bit more in lightweight mode for page to be ready
      if (lightweight) {
        console.log('Waiting for page to be fully ready before clicking...');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
      await this.performClick(clickSelector, clickX, clickY, clickDelay, lightweight);
    }

    // After click, wait for audio to start and verify it's in stream_sink
    // Since stream_sink is the default sink, new audio should automatically go there
    if (useVirtualDisplay && process.platform === 'linux') {
      console.log('Waiting for audio to start and appear in stream_sink...');
      await new Promise((resolve) => setTimeout(resolve, 5000)); // Wait longer for audio to start after click
      
      const { exec } = require('child_process');
      
      // Wait for audio to appear in stream_sink (it should be there automatically since it's default)
      await new Promise<void>((resolve) => {
        let attempts = 0;
        const maxAttempts = 20; // Increased to 20 attempts (40 seconds total)
        
        const checkAudio = () => {
          attempts++;
          console.log(`Checking for audio (attempt ${attempts}/${maxAttempts})...`);
          
          // First, check if there are any sink inputs at all
          exec('pactl list short sink-inputs', (error2: any, stdout2: any) => {
            if (!error2 && stdout2 && stdout2.trim()) {
              const lines = stdout2.trim().split('\n');
              console.log(`Found ${lines.length} sink input(s) in PulseAudio`);
              
              // Check each sink input to see where it's going
              let movedAny = false;
              lines.forEach((line: string) => {
                const parts = line.split('\t');
                const inputId = parts[0];
                const sinkName = parts[1] || 'unknown';
                console.log(`  Sink input ${inputId} -> ${sinkName}`);
                
                // If it's not in stream_sink, move it
                if (!sinkName.includes('stream_sink')) {
                  exec(`pactl move-sink-input ${inputId} stream_sink`, (moveError: any) => {
                    if (!moveError) {
                      console.log(`  ✓ Moved sink input ${inputId} to stream_sink`);
                      movedAny = true;
                    } else {
                      console.warn(`  ✗ Failed to move sink input ${inputId}: ${moveError}`);
                    }
                  });
                } else {
                  console.log(`  ✓ Sink input ${inputId} already in stream_sink`);
                  movedAny = true;
                }
              });
              
              // If we found any sink inputs, wait a moment then verify they're in stream_sink
              if (lines.length > 0) {
                setTimeout(() => {
                  // Verify they're actually in stream_sink now
                  exec('pactl list sink-inputs | grep -A5 "Sink:" | grep -A5 "stream_sink" | grep "Sink Input"', (verifyError: any, verifyStdout: any) => {
                    if (!verifyError && verifyStdout && verifyStdout.trim()) {
                      console.log('✓ Audio confirmed in stream_sink, ready for FFmpeg');
                      resolve();
                    } else {
                      console.log('Audio found but not yet in stream_sink, waiting a bit more...');
                      if (attempts < maxAttempts) {
                        setTimeout(checkAudio, 2000);
                      } else {
                        console.warn('Audio found but could not verify it\'s in stream_sink');
                        resolve();
                      }
                    }
                  });
                }, 2000);
                return;
              }
            }
            
            // No sink inputs found yet
            if (attempts < maxAttempts) {
              console.log(`No audio yet, waiting 2 seconds... (${attempts}/${maxAttempts})`);
              setTimeout(checkAudio, 2000);
            } else {
              console.warn('No audio sink inputs found after multiple attempts');
              console.warn('This may mean:');
              console.warn('  1. Audio is not playing in the browser');
              console.warn('  2. Browser is not using PulseAudio');
              console.warn('  3. Audio started before stream_sink was set as default');
              console.warn('Continuing anyway - FFmpeg will try to capture from stream_sink.monitor');
              resolve();
            }
          });
        };
        
        checkAudio();
      });
      
      // Additional wait to ensure audio is playing
      console.log('Final wait before starting FFmpeg...');
      await new Promise((resolve) => setTimeout(resolve, 3000));
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

    // Before starting FFmpeg, ensure PulseAudio is running and sink exists
    if (useVirtualDisplay && process.platform === 'linux') {
      const { execSync } = require('child_process');
      
      // First, ensure PulseAudio is running
      try {
        execSync('pactl info > /dev/null 2>&1', { stdio: 'ignore' });
        console.log('✓ PulseAudio is running');
      } catch (e) {
        console.warn('✗ PulseAudio not responding! Restarting...');
        try {
          execSync('pulseaudio --kill 2>/dev/null || true', { stdio: 'ignore' });
          execSync('pulseaudio --start --exit-idle-time=-1 --system=false --disallow-exit 2>/dev/null &', { stdio: 'ignore' });
          await new Promise((resolve) => setTimeout(resolve, 2000));
          console.log('✓ PulseAudio restarted');
        } catch (e2) {
          console.error('Failed to restart PulseAudio:', e2);
        }
      }
      
      // Check if sink still exists
      try {
        execSync('pactl list sinks | grep -q "stream_sink"', { stdio: 'ignore' });
        console.log('✓ stream_sink still exists before FFmpeg start');
      } catch (e) {
        console.warn('✗ stream_sink not found! Recreating...');
        // Recreate the sink
        try {
          execSync('pactl load-module module-null-sink sink_name=stream_sink sink_properties=device.description="StreamSink"', { stdio: 'ignore' });
          execSync('pactl set-default-sink stream_sink', { stdio: 'ignore' });
          console.log('✓ stream_sink recreated');
          
          // Wait a moment for monitor to be created
          await new Promise((resolve) => setTimeout(resolve, 500));
          
          // Verify monitor exists
          try {
            execSync('pactl list sources | grep -q "stream_sink.monitor"', { stdio: 'ignore' });
            console.log('✓ Monitor stream_sink.monitor confirmed');
          } catch (e3) {
            console.warn('✗ Monitor still not found after recreation');
          }
        } catch (e2) {
          console.error('Failed to recreate stream_sink:', e2);
        }
      }
    }

    // Start FFmpeg streaming
    // Browser is at finalWidth x finalHeight, but stream can be at different resolution
    await this.startFFmpegStream(
      rtmpsUrl, 
      finalWidth, 
      finalHeight, 
      streamWidthFinal, 
      streamHeightFinal,
      finalFps, 
      audioDevice, 
      videoDevice, 
      useVirtualDisplay, 
      lightweight
    );

    console.log('Stream started successfully!');
  }

  /**
   * Perform a click action on the page (to enable audio playback)
   */
  private async performClick(
    selector?: string,
    x?: number,
    y?: number,
    delay: number = 1000,
    lightweight: boolean = false
  ): Promise<void> {
    if (!this.page) {
      throw new Error('Page not initialized');
    }

    try {
      if (selector) {
        console.log(`Clicking element with selector: ${selector}`);
        
        // Wait longer in lightweight mode as page loads slower
        const timeout = lightweight ? 30000 : 10000;
        console.log(`Waiting for selector (timeout: ${timeout}ms)...`);
        
        // Try multiple selector variations
        const selectorVariations = [
          selector,
          selector.replace(/'/g, '"'), // Try with double quotes
          selector.replace(/"/g, "'"), // Try with single quotes
          selector.replace(/\[aria-label=['"]Play['"]\]/, '[aria-label="Play"]'), // Normalize quotes
          selector.replace(/\[aria-label=['"]Play['"]\]/, "[aria-label='Play']"), // Normalize quotes
        ];
        
        let elementFound = false;
        let foundSelector = selector;
        
        for (const sel of selectorVariations) {
          try {
            console.log(`Trying selector variation: ${sel}`);
            await this.page.waitForSelector(sel, { timeout: timeout / selectorVariations.length, visible: false });
            foundSelector = sel;
            elementFound = true;
            console.log(`✓ Found element with selector: ${sel}`);
            break;
          } catch (e) {
            // Try next variation
            continue;
          }
        }
        
        if (!elementFound) {
          // Last attempt: try to find any element with aria-label containing "Play" or any button/clickable element
          try {
            console.log('Trying to find any element with aria-label containing "Play"...');
            const playElements = await this.page.$$eval('[aria-label*="Play"], [aria-label*="play"], [aria-label*="PLAY"]', (elements) => {
              return elements.map((el, i) => ({
                index: i,
                ariaLabel: el.getAttribute('aria-label'),
                tagName: el.tagName,
                id: el.id,
                className: el.className,
                textContent: (el as any).textContent?.substring(0, 50) || ''
              }));
            });
            
            if (playElements.length > 0) {
              console.log(`Found ${playElements.length} element(s) with aria-label containing "Play":`);
              playElements.forEach((el: any) => {
                console.log(`  - ${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''} (aria-label: "${el.ariaLabel}", text: "${el.textContent}")`);
              });
              
              // Try to click the first one
              foundSelector = '[aria-label*="Play"]';
              elementFound = true;
            } else {
              // Check if there's a "Pause" button (audio is already playing)
              console.log('No "Play" button found. Checking if audio is already playing (looking for "Pause" button)...');
              const pauseElements = await this.page.$$eval('[aria-label*="Pause"], [aria-label*="pause"], [aria-label*="PAUSE"]', (elements) => {
                return elements.map((el, i) => ({
                  index: i,
                  ariaLabel: el.getAttribute('aria-label'),
                  tagName: el.tagName,
                  id: el.id,
                  className: el.className,
                  textContent: (el as any).textContent?.substring(0, 50) || ''
                }));
              });
              
              if (pauseElements.length > 0) {
                console.log(`Found ${pauseElements.length} "Pause" button(s) - audio is already playing!`);
                pauseElements.forEach((el: any) => {
                  console.log(`  - ${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''} (aria-label: "${el.ariaLabel}")`);
                });
                
                // Click pause then play to force audio restart and sink input creation
                console.log('Clicking Pause then Play to force audio sink creation...');
                foundSelector = '[aria-label*="Pause"]';
                elementFound = true;
                
                // We'll click pause first, then wait and click play
                try {
                  await this.page.click('[aria-label*="Pause"]');
                  console.log('✓ Clicked Pause');
                  await new Promise((resolve) => setTimeout(resolve, 1500));
                  
                  // Now look for Play button
                  const playAfterPause = await this.page.$$eval('[aria-label*="Play"], [aria-label*="play"]', (elements) => {
                    return elements.length > 0;
                  });
                  
                  if (playAfterPause) {
                    await this.page.click('[aria-label*="Play"]');
                    console.log('✓ Clicked Play after Pause - audio should restart and create sink input');
                    foundSelector = '[aria-label*="Play"]';
                    // Wait a bit for audio to start and create sink input
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                  } else {
                    console.warn('Play button not found after clicking Pause');
                  }
                } catch (e) {
                  console.warn('Could not click Pause/Play sequence:', e);
                }
              }
            }
            
            if (!elementFound) {
              // Try to find ALL elements with aria-label to see what's available
              console.log('No elements with "Play" found. Searching for all elements with aria-label...');
              const allAriaElements = await this.page.$$eval('[aria-label]', (elements) => {
                return elements.map((el, i) => ({
                  index: i,
                  ariaLabel: el.getAttribute('aria-label'),
                  tagName: el.tagName,
                  id: el.id,
                  className: el.className,
                  textContent: (el as any).textContent?.substring(0, 50) || ''
                }));
              });
              
              if (allAriaElements.length > 0) {
                console.log(`Found ${allAriaElements.length} element(s) with aria-label:`);
                allAriaElements.slice(0, 10).forEach((el: any) => {
                  console.log(`  - ${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''} (aria-label: "${el.ariaLabel}", text: "${el.textContent}")`);
                });
              }
              
              // Also try to find buttons or clickable elements
              console.log('Searching for buttons and clickable elements...');
              const buttons = await this.page.$$eval('button, [role="button"], [onclick], a[href]', (elements) => {
                return elements.slice(0, 20).map((el, i) => ({
                  index: i,
                  tagName: el.tagName,
                  id: el.id,
                  className: el.className,
                  textContent: (el as any).textContent?.substring(0, 50) || '',
                  ariaLabel: el.getAttribute('aria-label') || ''
                }));
              });
              
              if (buttons.length > 0) {
                console.log(`Found ${buttons.length} button/clickable element(s):`);
                buttons.forEach((el: any) => {
                  const label = el.ariaLabel || el.textContent || 'no label';
                  console.log(`  - ${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''} (label: "${label}")`);
                });
              }
            }
          } catch (e) {
            console.warn('Could not search for elements:', e);
          }
        }
        
        if (elementFound) {
          // Try to click, with retry
          let clicked = false;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await this.page.click(foundSelector);
              clicked = true;
              break;
            } catch (e) {
              if (attempt < 2) {
                console.log(`Click attempt ${attempt + 1} failed, retrying...`);
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } else {
                // Try with evaluateHandle as last resort
                try {
                  const elementHandle = await this.page.$(foundSelector);
                  if (elementHandle) {
                    await elementHandle.click();
                    clicked = true;
                    await elementHandle.dispose();
                  }
                } catch (evalError) {
                  throw e;
                }
              }
            }
          }
          
          if (clicked) {
            console.log('Click performed successfully');
          }
        } else {
          throw new Error(`Could not find element with selector: ${selector}`);
        }
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
      const { exec, execSync } = require('child_process');
      
      // First, check if PulseAudio is already running
      let pulseRunning = false;
      try {
        execSync('pulseaudio --check', { stdio: 'ignore' });
        pulseRunning = true;
        console.log('✓ PulseAudio is already running');
      } catch (e) {
        console.log('PulseAudio is not running, starting it...');
      }
      
      // If not running, start it
      if (!pulseRunning) {
        // Kill any existing PulseAudio processes
        try {
          execSync('pkill -9 pulseaudio 2>/dev/null || true', { stdio: 'ignore' });
        } catch (e) {
          // Ignore errors
        }
        
        // Start PulseAudio daemon
        this.pulseAudioProcess = spawn('pulseaudio', [
          '--start',
          '--exit-idle-time=-1',
          '--system=false',
          '--disallow-exit',
        ], {
          env: {
            ...process.env,
            PULSE_RUNTIME_PATH: process.env.PULSE_RUNTIME_PATH || '/tmp/pulse',
            PULSE_STATE_PATH: process.env.PULSE_STATE_PATH || '/tmp/pulse',
          }
        });
        
        // Capture PulseAudio output for debugging
        this.pulseAudioProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          if (output.includes('error') || output.includes('Error') || output.includes('failed')) {
            console.warn(`PulseAudio stderr: ${output}`);
          }
        });

        this.pulseAudioProcess.on('error', (error) => {
          console.warn(`PulseAudio start warning: ${error.message}`);
          // Continue anyway - audio might not be critical
        });
      }

      // Wait for PulseAudio to be ready, then create a virtual sink
      let attempts = 0;
      const maxAttempts = 10;
      
      const checkPulse = () => {
        attempts++;
        try {
          execSync('pulseaudio --check', { stdio: 'ignore' });
          console.log('✓ PulseAudio is running and accessible');
          
          // Create virtual sink
          console.log('Creating virtual sink...');
          
          // First, unload any existing sink with the same name
          exec('pactl unload-module module-null-sink 2>/dev/null || true', () => {
            // Create a null sink (virtual audio device) that we can monitor
            exec('pactl load-module module-null-sink sink_name=stream_sink sink_properties=device.description="StreamSink"', (error: any, stdout: any, stderr: any) => {
              if (error) {
                console.warn('Could not create virtual sink, audio capture may not work');
                console.warn(`Error: ${stderr}`);
                resolve(); // Continue anyway
              } else {
                const moduleId = stdout?.toString().trim();
                console.log(`✓ Virtual sink created successfully (module ID: ${moduleId})`);
                
                // Wait a moment for the monitor to be created
                setTimeout(() => {
                  // Verify monitor exists
                  exec('pactl list sources | grep -q "stream_sink.monitor"', (monitorError: any) => {
                    if (monitorError) {
                      console.warn('Monitor not found, but sink exists');
                    } else {
                      console.log('✓ Monitor stream_sink.monitor confirmed');
                    }
                    
                    // Set stream_sink as default sink for new applications
                    exec('pactl set-default-sink stream_sink', (setError: any) => {
                      if (setError) {
                        console.warn('Could not set stream_sink as default, but sink exists');
                      } else {
                        console.log('✓ stream_sink set as default sink');
                      }
                      
                      // Also create a loopback from default source to stream_sink
                      // This will route any audio going to the default sink to stream_sink
                      setTimeout(() => {
                        exec('pactl load-module module-loopback source=@DEFAULT_SOURCE@ sink=stream_sink latency_msec=1', (loopbackError: any, loopbackStdout: any) => {
                          if (loopbackError) {
                            console.warn('Could not create loopback (may not be needed):', loopbackError.message);
                          } else {
                            const loopbackId = loopbackStdout?.toString().trim();
                            console.log(`✓ Loopback created (module ID: ${loopbackId}) - routing default source to stream_sink`);
                          }
                          resolve();
                        });
                      }, 500);
                    });
                  });
                }, 500);
              }
            });
          });
        } catch (e) {
          if (attempts < maxAttempts) {
            console.log(`Waiting for PulseAudio to be ready (attempt ${attempts}/${maxAttempts})...`);
            setTimeout(checkPulse, 500);
          } else {
            console.error('✗ PulseAudio failed to start after multiple attempts');
            resolve(); // Continue anyway
          }
        }
      };
      
      // Start checking after a short delay
      setTimeout(checkPulse, pulseRunning ? 500 : 2000);
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
    captureWidth: number,
    captureHeight: number,
    streamWidth: number,
    streamHeight: number,
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
        '-video_size', `${captureWidth}x${captureHeight}`,
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

      // Scale video if stream resolution is different from capture resolution
      const needsScaling = streamWidth !== captureWidth || streamHeight !== captureHeight;
      const scaleFilter = needsScaling ? `scale=${streamWidth}:${streamHeight}` : null;

      const outputOptions = [
        '-c:v', 'libx264',
        ...(scaleFilter ? ['-vf', scaleFilter] : []), // Add scale filter if needed
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
            this.retryWithSilentAudio(rtmpsUrl, captureWidth, captureHeight, streamWidth, streamHeight, fps, useVirtualDisplay, lightweight)
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
    captureWidth: number,
    captureHeight: number,
    streamWidth: number,
    streamHeight: number,
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
          '-video_size', `${captureWidth}x${captureHeight}`,
          '-i', `${videoInput}:${audioInput}`,
        ];
      } else if (platform === 'linux') {
        // Linux - use x11grab for video
        // Capture from 0,0 at capture resolution (e.g., 1080p)
        const display = process.env.DISPLAY || ':0.0';
        videoInput = `${display}+0,0`;
        inputOptions = [
          '-f', 'x11grab',
          '-framerate', fps.toString(),
          '-video_size', `${captureWidth}x${captureHeight}`,
          '-i', videoInput,
        ];

        // For Railway/headless: try to capture audio from PulseAudio
        if (useVirtualDisplay) {
          // Try to use PulseAudio to capture browser audio
          // Since browser may not create sink input, try to capture from default sink monitor
          // or use combine-sink to route all audio to stream_sink
          const { execSync, exec } = require('child_process');
          
          // Strategy: Since browser may not create sink input, we'll use module-null-sink differently
          // Create a loopback from all possible sources to stream_sink
          try {
            // Get all available sinks
            const allSinks = execSync('pactl list sinks short | cut -f2', { encoding: 'utf8' }).trim().split('\n');
            console.log(`Available sinks: ${allSinks.join(', ')}`);
            
            // Get default sink
            let defaultSink = 'auto_null';
            try {
              defaultSink = execSync('pactl info | grep "Default Sink" | cut -d: -f2 | xargs', { encoding: 'utf8' }).trim();
              console.log(`Default sink: ${defaultSink}`);
            } catch (e) {
              console.warn('Could not get default sink, using auto_null');
            }
            
            // Since stream_sink is the only sink, browser audio must be going elsewhere (likely ALSA)
            // Try to create an ALSA source to capture system audio and route it to stream_sink
            console.log('Browser may be using ALSA directly. Creating ALSA source...');
            
            // First, verify PulseAudio is running and accessible
            try {
              execSync('pulseaudio --check', { stdio: 'ignore' });
              console.log('✓ PulseAudio is running');
            } catch (e) {
              console.error('✗ PulseAudio is not running! Cannot create ALSA source.');
              console.warn('Audio capture will likely fail');
            }
            
            // Wait a bit for PulseAudio to be fully ready
            setTimeout(() => {
              try {
                // First, try to create an ALSA source from the default ALSA device
                // This will capture audio from ALSA and make it available in PulseAudio
                exec('pactl load-module module-alsa-source device=hw:0,0 source_name=alsa_source', (alsaError: any, alsaStdout: any) => {
                  if (!alsaError && alsaStdout) {
                    const alsaId = alsaStdout.toString().trim();
                    console.log(`✓ ALSA source created (module ID: ${alsaId}) - capturing from hw:0,0`);
                    
                    // Wait a moment for the source to be ready
                    setTimeout(() => {
                      // Route the ALSA source to stream_sink via loopback
                      exec('pactl load-module module-loopback source=alsa_source sink=stream_sink latency_msec=1', (loopbackError: any, loopbackStdout: any) => {
                        if (!loopbackError && loopbackStdout) {
                          const loopbackId = loopbackStdout.toString().trim();
                          console.log(`✓ Loopback created (module ID: ${loopbackId}) - routing alsa_source to stream_sink`);
                        } else {
                          console.warn('Could not create loopback from ALSA source');
                        }
                      });
                    }, 1000);
                  } else {
                    console.warn('Could not create ALSA source:', alsaError?.message || 'Unknown error');
                    console.warn('Trying alternative method...');
                    
                    // Alternative: Try to create loopback from all available sources
                    try {
                      const allSources = execSync('pactl list sources short 2>/dev/null | cut -f2', { encoding: 'utf8' }).trim().split('\n').filter((s: string) => s);
                      if (allSources.length > 0) {
                        console.log(`Available sources: ${allSources.join(', ')}`);
                        
                        // Try to create loopback from each source to stream_sink
                        allSources.forEach((source: string) => {
                          if (source.includes('.monitor') && !source.includes('stream_sink')) {
                            exec(`pactl load-module module-loopback source=${source} sink=stream_sink latency_msec=1`, (loopbackError: any, loopbackStdout: any) => {
                              if (!loopbackError && loopbackStdout) {
                                const loopbackId = loopbackStdout.toString().trim();
                                console.log(`Loopback created (module ID: ${loopbackId}) - routing ${source} to stream_sink`);
                              }
                            });
                          }
                        });
                        
                        // Also try to create loopback from default source
                        try {
                          const defaultSource = execSync('pactl info 2>/dev/null | grep "Default Source" | cut -d: -f2 | xargs', { encoding: 'utf8' }).trim();
                          if (defaultSource && !defaultSource.includes('stream_sink')) {
                            exec(`pactl load-module module-loopback source=${defaultSource} sink=stream_sink latency_msec=1`, (loopbackError: any, loopbackStdout: any) => {
                              if (!loopbackError && loopbackStdout) {
                                const loopbackId = loopbackStdout.toString().trim();
                                console.log(`Loopback from default source created (module ID: ${loopbackId}) - routing ${defaultSource} to stream_sink`);
                              }
                            });
                          }
                        } catch (e) {
                          console.warn('Could not get default source');
                        }
                      } else {
                        console.warn('No sources available in PulseAudio');
                      }
                    } catch (e) {
                      console.warn('Could not list sources for loopback:', e);
                    }
                  }
                });
              } catch (e) {
                console.warn('Could not setup ALSA source:', e);
              }
            }, 2000); // Wait 2 seconds for PulseAudio to be ready
          } catch (e) {
            console.warn('Could not setup audio routing:', e);
          }
          
          // Always try to capture from stream_sink.monitor
          // The loopback should route audio there even if browser doesn't create sink input directly
          const audioSource = audioDevice || 'stream_sink.monitor';
          console.log(`Capturing audio from: ${audioSource}`);
          
          inputOptions.push(
            '-f', 'pulse',
            '-ac', '2',
            '-ar', '44100',
            '-i', audioSource
          );
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
          '-video_size', `${captureWidth}x${captureHeight}`,
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
            this.retryWithSilentAudio(rtmpsUrl, captureWidth, captureHeight, streamWidth, streamHeight, fps, useVirtualDisplay, lightweight)
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
    console.log('  --width <number>     Browser window width (default: 1920)');
    console.log('  --height <number>    Browser window height (default: 1080)');
    console.log('  --stream-width <n>   Stream output width (default: same as browser width)');
    console.log('  --stream-height <n>  Stream output height (default: same as browser height)');
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

