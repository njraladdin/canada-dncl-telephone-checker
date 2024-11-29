const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const undici = require('undici');

dotenv.config();

// Configuration
const CONCURRENT_BROWSERS = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ALLOW_PROXY = false;
const osPlatform = os.platform();
const executablePath = osPlatform.startsWith('win') 
    ? "C://Program Files//Google//Chrome//Application//chrome.exe" 
    : "/usr/bin/google-chrome";

// Setup puppeteer with stealth plugin
puppeteerExtra.use(StealthPlugin());

// Also add this helper function for getting Chrome user data directory
function getDefaultChromeUserDataDir() {
    if (/^win/i.test(osPlatform)) {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (/^darwin/i.test(osPlatform)) {  // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else {  // Linux
        return path.join(os.homedir(), '.config', 'google-chrome');
    }
}

// ResultTracker class (keeping this as a class since it manages state)
class ResultTracker {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
        this.maxResults = 500;
        this.firstProcessingTime = null;
    }

    addResult(result) {
        if (!this.firstProcessingTime) {
            this.firstProcessingTime = Date.now();
        }

        this.results.push({
            success: result.success,
            processed: result.status === 'ACTIVE' || result.status === 'INACTIVE',
            timestamp: Date.now()
        });
        
        if (this.results.length > this.maxResults) {
            this.results.shift();
        }
    }

    getStats() {
        if (this.results.length === 0) return null;

        const successfullyProcessed = this.results.filter(r => r.processed);
        const successCount = this.results.filter(r => r.success).length;
        const successRate = (successCount / this.results.length) * 100;
        
        let avgTimePerNumber = 0;
        if (successfullyProcessed.length > 0) {
            const totalElapsedSeconds = (Date.now() - this.startTime) / 1000;
            avgTimePerNumber = totalElapsedSeconds / successfullyProcessed.length;
        }

        return {
            successRate: successRate.toFixed(2),
            avgTimePerNumber: avgTimePerNumber.toFixed(2),
            totalProcessed: this.results.length,
            successfullyProcessed: successfullyProcessed.length
        };
    }
}

// Browser management functions
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
    const randomProfile = Math.floor(Math.random() * 4) + 1;

    const browser = await puppeteerExtra.launch({
        headless: false,
        executablePath: executablePath,
        userDataDir: userDataDir,
        protocolTimeout: 30000,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-webgl',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--password-store=basic',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--lang=ja',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${randomProfile}`,
            ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Update page configuration without request interception
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                delete navigator.__proto__.webdriver;
            });
            
            const userAgents = [
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            ];
            const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
            await page.setUserAgent(randomUserAgent);
            
            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);
        }
    });

    return browser;
}

async function launchBrowsers() {
    return Promise.all(
        Array.from({ length: CONCURRENT_BROWSERS }, async (_, index) => {
            await new Promise(resolve => setTimeout(resolve, index * 1000));
            return launchBrowser(`./chrome-data/chrome-data-${index + 1}`);
        })
    );
}

async function closeBrowser(browser) {
    try {
        await browser.close();
    } catch (error) {
        console.error('Error closing browser:', error);
    }
}

// Add audio transcription function
async function downloadAndTranscribeAudio(audioUrl) {
    try {
        let audioData;
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        
        while (downloadAttempts < maxDownloadAttempts) {
            try {
                downloadAttempts++;
                console.log(`Downloading audio attempt ${downloadAttempts}/${maxDownloadAttempts}`);
                
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    validateStatus: false,
                    timeout: 60000
                });

                if (audioResponse.status !== 200) {
                    throw new Error(`Failed to download audio: ${audioResponse.status}`);
                }

                audioData = audioResponse.data;
                console.log('Audio downloaded successfully');
                break;

            } catch (downloadError) {
                console.error(`Download attempt ${downloadAttempts} failed:`, downloadError.message);
                if (downloadAttempts === maxDownloadAttempts) return null;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Randomly choose between WIT tokens
        const witTokens = [
            process.env.WIT_TOKEN,
            process.env.WIT_TOKEN_1,
            process.env.WIT_TOKEN_2
        ].filter(Boolean);
        
        const witToken = witTokens[Math.floor(Math.random() * witTokens.length)];

        console.log('Transcribing audio with wit.ai...');
        const witResponse = await undici.request('https://api.wit.ai/speech?v=20220622', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${witToken}`,
                'Content-Type': 'audio/mpeg3'
            },
            body: audioData,
            bodyTimeout: 120000,
            headersTimeout: 120000
        });

        let fullResponse = '';
        for await (const chunk of witResponse.body) {
            fullResponse += chunk.toString();
        }

        const lastTextMatch = fullResponse.match(/"text":\s*"([^"]+)"/g);
        if (!lastTextMatch) {
            console.error('No transcription found');
            return null;
        }

        const lastText = lastTextMatch[lastTextMatch.length - 1];
        const audioTranscript = lastText.match(/"text":\s*"([^"]+)"/)[1];
        console.log('Transcribed text:', audioTranscript);

        return audioTranscript;

    } catch (error) {
        console.error('Error in audio transcription:', error);
        return null;
    }
}

// Replace solve2Captcha with solveCaptchaChallenge
async function solveCaptchaChallenge(page) {
    function rdn(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    try {
        const alertHandler = async dialog => {
            const message = dialog.message();
            console.log('Alert detected:', message);
            if (message.includes('Cannot contact reCAPTCHA')) {
                console.log('Detected reCAPTCHA connection error, moving on...');
                await dialog.accept();
                return null;
            }
            await dialog.accept();
        };
        
        page.on('dialog', alertHandler);

        // Keep checking for the frame until we find it
        let recaptchaFrame = null;
        for (let i = 0; i < 5; i++) {
            const frames = await page.frames();
            console.log(`Attempt ${i + 1} to find reCAPTCHA frame`);
            
            recaptchaFrame = frames.find(frame => frame.url().includes('google.com/recaptcha'));

            if (recaptchaFrame) {
                console.log('Found recaptcha frame:', recaptchaFrame.url());
                
                // Add more explicit waiting and verification
                const selector = '#recaptcha-anchor > div.recaptcha-checkbox-border';
                await recaptchaFrame.waitForSelector(selector, {
                    visible: true,
                    timeout: 20000
                });
                
                // Ensure element is actually clickable
                await recaptchaFrame.waitForFunction(
                    selector => {
                        const element = document.querySelector(selector);
                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && element.clientHeight > 0;
                    },
                    {},
                    selector
                );
                
                // Small random delay before clicking (500-1500ms)
                await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)));
                
                // Try both click methods
                try {
                    await recaptchaFrame.click(selector);
                } catch (e) {
                    await recaptchaFrame.evaluate(selector => {
                        document.querySelector(selector).click();
                    }, selector);
                }
                
                console.log('Clicked recaptcha checkbox');
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // After clicking checkbox, wait for either token or challenge
        console.log('Waiting for result after checkbox click...');
        
        try {
            // First check if we get an immediate token
            const immediateToken = await page.evaluate(() => {
                return new Promise((resolve) => {
                    const checkToken = () => {
                        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                        if (textarea && textarea.value) {
                            resolve(textarea.value);
                        }
                    };
                    
                    // Check immediately
                    checkToken();
                    
                    // Also set up an interval for a short period
                    const interval = setInterval(checkToken, 100);
                    setTimeout(() => {
                        clearInterval(interval);
                        resolve(null);
                    }, 2000); // Short timeout for immediate success case
                });
            });

            if (immediateToken) {
                console.log('Captcha solved immediately!');
                return immediateToken;
            }

            // Helper function to check for blocking message
            const checkForBlockingMessage = async (bframe) => {
                try {
                    const blockingMessage = await bframe.$('.rc-doscaptcha-header-text');
                    if (blockingMessage) {
                        const text = await bframe.$eval('.rc-doscaptcha-header-text', el => el.textContent);
                        if (text.includes('Try again later')) {
                            console.log('Detected "Try again later" message. Moving on...');
                            return true;
                        }
                    }
                    return false;
                } catch (e) {
                    return false;
                }
            };

            // Get bframe with retry
            let bframe = null;
            for (let i = 0; i < 5; i++) {
                const frames = await page.frames();
                bframe = frames.find(frame => frame.url().includes('api2/bframe'));
                if (bframe) break;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (!bframe) {
                console.log('Could not find bframe after retries');
                return null;
            }

            // Click audio button
            const audioButton = await bframe.waitForSelector('#recaptcha-audio-button', {
                visible: true,
                timeout: 10000
            });
            
            if (!audioButton) {
                console.log('Audio button not found');
                return null;
            }

            await audioButton.click({ delay: rdn(30, 150) });
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Check for blocking message immediately after clicking audio button
            if (await checkForBlockingMessage(bframe)) {
                return null;
            }

            while (true) {
                try {
                    // Check for blocking message at start of each attempt
                    if (await checkForBlockingMessage(bframe)) {
                        return null;
                    }

                    // Wait for audio challenge with shorter timeout and check for blocking message
                    const audioChallenge = await Promise.race([
                        bframe.waitForSelector('.rc-audiochallenge-tdownload-link', {
                            timeout: 10000
                        }),
                        new Promise(async (resolve) => {
                            // Check for blocking message every 500ms
                            while (true) {
                                if (await checkForBlockingMessage(bframe)) {
                                    resolve(null);
                                    break;
                                }
                                await new Promise(r => setTimeout(r, 500));
                            }
                        })
                    ]);

                    if (!audioChallenge) {
                        console.log('No audio challenge available or blocking message detected');
                        return null;
                    }

                    console.log('Audio challenge appeared');

                    // Get audio URL and transcribe
                    const audioUrl = await bframe.$eval('#audio-source', el => el.src);
                    console.log('Got audio URL:', audioUrl);

                    const transcription = await downloadAndTranscribeAudio(audioUrl);
                    if (!transcription) {
                        console.log('Failed to get transcription, retrying...');
                        const reloadButton = await bframe.$('#recaptcha-reload-button');
                        await reloadButton.click({ delay: rdn(30, 150) });
                        continue;
                    }

                    console.log('Got transcription:', transcription);

                    // Enter transcription
                    const input = await bframe.$('#audio-response');
                    await input.click({ delay: rdn(30, 150) });
                    await input.type(transcription, { delay: rdn(30, 75) });

                    // Verify
                    const verifyButton = await bframe.$('#recaptcha-verify-button');
                    await verifyButton.click({ delay: rdn(30, 150) });

                    // Check for token
                    const token = await page.evaluate(() => {
                        return new Promise((resolve) => {
                            const checkToken = () => {
                                const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                                if (textarea && textarea.value) {
                                    resolve(textarea.value);
                                }
                            };
                            
                            checkToken();
                            const interval = setInterval(checkToken, 100);
                            
                            setTimeout(() => {
                                clearInterval(interval);
                                resolve(null);
                            }, 5000);
                        });
                    });

                    if (token) {
                       // console.log('Token:', token);
                        console.log('Successfully solved captcha!');
                        return token;
                    }

                    console.log('No token received, retrying...');
                    continue;

                } catch (error) {
                    // Check if the error is due to blocking message
                    if (await checkForBlockingMessage(bframe)) {
                        return null;
                    }
                    
                    console.error('Error in audio challenge loop:', error);
                    continue;
                }
            }
        } catch (error) {
            console.error('Fatal error in solveCaptcha:', error);
            return null;
        }
    } catch (error) {
        console.error('Fatal error in solveCaptcha:', error);
        return null;
    }
}

// Update the main generateTokens function to use audio solving
async function generateTokens(count, eventManager) {
    const resultTracker = new ResultTracker();
    const browsers = await launchBrowsers();
    const tabsPerBrowser = Math.ceil(count / browsers.length);

    try {
        const allPromises = [];
        let tokensGenerated = 0;

        // Distribute tabs across browsers
        for (let browserIndex = 0; browserIndex < browsers.length; browserIndex++) {
            const browser = browsers[browserIndex];
            const tabPromises = [];

            // Calculate how many tabs this browser should handle
            const remainingTokens = count - tokensGenerated;
            const tabsForThisBrowser = Math.min(tabsPerBrowser, remainingTokens);

            // Create multiple tabs for this browser
            for (let tabIndex = 0; tabIndex < tabsForThisBrowser; tabIndex++) {
                const tabPromise = (async () => {
                    const page = await browser.newPage();
                    
                    try {
                        await page.setUserAgent(USER_AGENT);
                        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 120000
                        });

                        // Set Angular state
                        await page.evaluate(() => {
                            const element = document.querySelector('[ng-show="state==\'number\'"]');
                            if (!element) throw new Error('Could not find Angular element');
                            const scope = angular.element(element).scope();
                            scope.model = scope.model || {};
                            scope.state = 'confirm';
                            scope.$apply();
                        });

                        const token = await solveCaptchaChallenge(page);
                        if (token) {
                            eventManager.emit('tokenGenerated', { token });
                            tokensGenerated++;
                            resultTracker.addResult({ success: true, status: 'ACTIVE' });
                        } else {
                            resultTracker.addResult({ success: false, status: 'ERROR' });
                        }

                        // Display stats after each attempt
                        const stats = resultTracker.getStats();
                        if (stats) {
                            console.log(clc.cyan('\nCurrent Statistics:'));
                            console.log(clc.white('Success Rate: ') + clc.green(`${stats.successRate}%`));
                            console.log(clc.white('Average Time Per Token: ') + clc.green(`${stats.avgTimePerNumber} seconds`));
                            console.log(clc.white('Total Processed: ') + clc.green(stats.totalProcessed));
                            console.log(clc.white('Successfully Processed: ') + clc.green(stats.successfullyProcessed));
                            console.log('----------------------------------------');
                        }

                    } catch (error) {
                        console.error('Error generating token:', error);
                        eventManager.emit('tokenError', { error: error.message });
                        resultTracker.addResult({ success: false, status: 'ERROR' });
                    } finally {
                        await page.close().catch(console.error);
                    }
                })();

                tabPromises.push(tabPromise);
                tokensGenerated++;

                // Add small delay between opening tabs
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            allPromises.push(...tabPromises);
        }

        // Wait for all tabs to complete
        await Promise.all(allPromises);

    } finally {
        await Promise.all(browsers.map(closeBrowser));
    }
}

// Update the main execution block at the bottom of the file
if (require.main === module) {
    const resultTracker = new ResultTracker(); // Create tracker instance
    
    const eventManager = {
        emit: (event, data) => {
            if (event === 'tokenGenerated') {
                console.log(clc.green('\nToken generated:'));
                console.log(clc.yellow(data.token.slice(0, 50) + '...\n'));
                
                // Display stats after each successful token
                const stats = resultTracker.getStats();
                if (stats) {
                    console.log(clc.cyan('Current Statistics:'));
                    console.log(clc.white('Success Rate: ') + clc.green(`${stats.successRate}%`));
                    console.log(clc.white('Average Time Per Token: ') + clc.green(`${stats.avgTimePerNumber} seconds`));
                    console.log(clc.white('Total Processed: ') + clc.green(stats.totalProcessed));
                    console.log(clc.white('Successfully Processed: ') + clc.green(stats.successfullyProcessed));
                    console.log('----------------------------------------');
                }
                
                resultTracker.addResult({ success: true, status: 'ACTIVE' });
            } else if (event === 'tokenError') {
                console.log(clc.red('\nError:', data.error, '\n'));
                resultTracker.addResult({ success: false, status: 'INACTIVE' });
            }
        }
    };

    console.log(clc.cyan('Starting token generation...'));
    generateTokens(3, eventManager)
        .then(() => {
            console.log(clc.green('Done!'));
            // Display final stats
            const finalStats = resultTracker.getStats();
            if (finalStats) {
                console.log(clc.cyan('\nFinal Statistics:'));
                console.log(clc.white('Final Success Rate: ') + clc.green(`${finalStats.successRate}%`));
                console.log(clc.white('Final Average Time Per Token: ') + clc.green(`${finalStats.avgTimePerNumber} seconds`));
                console.log(clc.white('Total Tokens Processed: ') + clc.green(finalStats.totalProcessed));
                console.log(clc.white('Successfully Generated Tokens: ') + clc.green(finalStats.successfullyProcessed));
            }
        })
        .catch(console.error);
} else {
    module.exports = generateTokens;
}