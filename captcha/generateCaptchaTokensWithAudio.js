const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const undici = require('undici');
const { sendDNCLRequest, formatPhoneNumber } = require('../sendDNCLRequest');
const ResultTracker = require('../progress/ResultTracker');


dotenv.config();

// Configuration
const CONCURRENT_BROWSERS = 6;
const BATCH_SIZE = 6;

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

// Browser management functions
async function launchBrowser(usedDirs) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;
    const randomProfile = Math.floor(Math.random() * 4) + 1;  // Keep random profile 1-4
    
    // Generate random dir number 1-15 that hasn't been used
    let dirNumber;
    do {
        dirNumber = Math.floor(Math.random() * 15) + 1;
    } while (usedDirs.has(dirNumber));
    
    usedDirs.add(dirNumber);
    const userDataDir = `./chrome-user-data/chrome-user-data-${dirNumber}`;

    const browser = await puppeteerExtra.launch({
        headless: true,
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
           // '--lang=ja',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${randomProfile}`,  // Keep using random profile 1-4
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
        }
    });

    return browser;
}

async function launchBrowsers() {
    const usedDirs = new Set();
    return Promise.all(
        Array.from({ length: CONCURRENT_BROWSERS }, async (_, index) => {
            await new Promise(resolve => setTimeout(resolve, index * 1000));
            return launchBrowser(usedDirs);
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
                console.log(clc.cyan(`[Audio] Download attempt ${downloadAttempts}/${maxDownloadAttempts}`));
                
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    validateStatus: false,
                    timeout: 60000
                });

                if (audioResponse.status !== 200) {
                    throw new Error(`Failed to download audio: ${audioResponse.status}`);
                }

                audioData = audioResponse.data;
                console.log(clc.green('[Audio] Downloaded successfully'));
                break;

            } catch (downloadError) {
                console.error(clc.red(`[Audio] Download attempt ${downloadAttempts} failed:`), downloadError.message);
                if (downloadAttempts === maxDownloadAttempts) return null;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        const witTokens = [
            process.env.WIT_TOKEN,
            process.env.WIT_TOKEN_1,
            process.env.WIT_TOKEN_2
        ].filter(Boolean);
        
        const witToken = witTokens[Math.floor(Math.random() * witTokens.length)];

        console.log(clc.cyan('[Audio] Transcribing with wit.ai...'));
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
            console.error(clc.red('[Audio] No transcription found'));
            return null;
        }

        const lastText = lastTextMatch[lastTextMatch.length - 1];
        const audioTranscript = lastText.match(/"text":\s*"([^"]+)"/)[1];
        console.log(clc.green('[Audio] Transcribed text:'), clc.yellow(audioTranscript));

        return audioTranscript;

    } catch (error) {
        console.error(clc.red('[Audio] Error in transcription:'), error);
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
            console.log(clc.yellow('[Captcha] Alert detected:'), message);
            if (message.includes('Cannot contact reCAPTCHA')) {
                console.log(clc.yellow('[Captcha] Detected reCAPTCHA connection error, moving on...'));
                await dialog.accept();
                return null;
            }
            await dialog.accept();
        };
        
        page.on('dialog', alertHandler);

        let recaptchaFrame = null;
        for (let i = 0; i < 5; i++) {
            const frames = await page.frames();
            console.log(clc.cyan(`[Captcha] Attempt ${i + 1} to find reCAPTCHA frame`));
            
            recaptchaFrame = frames.find(frame => frame.url().includes('google.com/recaptcha'));

            if (recaptchaFrame) {
                console.log(clc.green('[Captcha] Found recaptcha frame:'), recaptchaFrame.url());
                
                const selector = '#recaptcha-anchor > div.recaptcha-checkbox-border';
                await recaptchaFrame.waitForSelector(selector, {
                    visible: true,
                    timeout: 20000
                });
                
                await recaptchaFrame.waitForFunction(
                    selector => {
                        const element = document.querySelector(selector);
                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0 && element.clientHeight > 0;
                    },
                    {},
                    selector
                );
                
                await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)));
                
                try {
                    await recaptchaFrame.click(selector);
                } catch (e) {
                    await recaptchaFrame.evaluate(selector => {
                        document.querySelector(selector).click();
                    }, selector);
                }
                
                console.log(clc.green('[Captcha] Clicked checkbox'));
                break;
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(clc.cyan('[Captcha] Waiting for result after checkbox click...'));
        
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
                console.log(clc.green('[Captcha] Captcha solved immediately!'));
                return immediateToken;
            }

            // Helper function to check for blocking message
            const checkForBlockingMessage = async (bframe) => {
                try {
                    const blockingMessage = await bframe.$('.rc-doscaptcha-header-text');
                    if (blockingMessage) {
                        const text = await bframe.$eval('.rc-doscaptcha-header-text', el => el.textContent);
                        if (text.includes('Try again later')) {
                            console.log(clc.red('[Captcha] Detected "Try again later" message. Moving on...'));
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
                console.log(clc.red('[Captcha] Could not find bframe after retries'));
                return null;
            }

            // Click audio button
            const audioButton = await bframe.waitForSelector('#recaptcha-audio-button', {
                visible: true,
                timeout: 10000
            });
            
            if (!audioButton) {
                console.log(clc.red('[Captcha] Audio button not found'));
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
                        console.log(clc.red('[Captcha] No audio challenge available or blocking message detected'));
                        return null;
                    }

                    console.log(clc.green('[Captcha] Audio challenge appeared'));

                    // Get audio URL and transcribe
                    const audioUrl = await bframe.$eval('#audio-source', el => el.src);
                    console.log(clc.green('[Captcha] Got audio URL:'), clc.yellow(audioUrl));

                    const transcription = await downloadAndTranscribeAudio(audioUrl);
                    if (!transcription) {
                        console.log(clc.red('[Captcha] Failed to get transcription, retrying...'));
                        const reloadButton = await bframe.$('#recaptcha-reload-button');
                        await reloadButton.click({ delay: rdn(30, 150) });
                        continue;
                    }

                    console.log(clc.green('[Captcha] Got transcription:'), clc.yellow(transcription));

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
                        console.log(clc.green('Solution found!'));

                        return token;
                    }

                    console.log(clc.red('[Captcha] No token received, retrying...'));
                    continue;

                } catch (error) {
                    // Check if the error is due to blocking message
                    if (await checkForBlockingMessage(bframe)) {
                        return null;
                    }
                    
                    console.error(clc.red('[Captcha] Error in audio challenge loop:'), error);
                    continue;
                }
            }
        } catch (error) {
            console.error(clc.red('[Captcha] Fatal error in solveCaptcha:'), error);
            return null;
        }
    } catch (error) {
        console.error(clc.red('[Captcha] Fatal error in solveCaptcha:'), error);
        return null;
    }
}

// Modify the generateTokens function to include API requests and DB updates
async function generateTokens(numbers, resultTracker, dbManager) {
    console.log(clc.cyan('\n=== Starting Token Generation ==='));
    console.log(clc.white('Total Numbers:'), clc.yellow(numbers.length));
    console.log(clc.white('Concurrent Browsers:'), clc.yellow(CONCURRENT_BROWSERS));
    console.log('===============================\n');

    const browsers = await launchBrowsers();
    const tabsPerBrowser = Math.ceil(numbers.length / browsers.length);

    try {
        const allPromises = [];
        let tokensGenerated = 0;


        for (let browserIndex = 0; browserIndex < browsers.length; browserIndex++) {
            const browser = browsers[browserIndex];
            const tabPromises = [];

            const remainingTokens = numbers.length - tokensGenerated;
            const tabsForThisBrowser = Math.min(tabsPerBrowser, remainingTokens);

            console.log(clc.cyan(`\n[Browser ${browserIndex + 1}] Launching with ${tabsForThisBrowser} tabs`));

            for (let tabIndex = 0; tabIndex < tabsForThisBrowser; tabIndex++) {
                const currentNumber = numbers[tokensGenerated];
                
                const tabPromise = (async () => {
                    const page = await browser.newPage();
                    
                    try {
                        await page.setUserAgent(USER_AGENT);
                        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
                            waitUntil: 'domcontentloaded',
                            timeout: 120000
                        });

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
                            const result = await sendDNCLRequest(formatPhoneNumber(currentNumber.telephone), token, USER_AGENT);
                            if (result) {
                                await dbManager.updateNumberStatus(
                                    currentNumber.id,
                                    result.status,
                                    result.registrationDate
                                );
                                resultTracker.addResult({ success: true, status: result.status });
                                await resultTracker.printStats(dbManager);
                            }
                        } else {
                            await dbManager.updateNumberStatus(
                                currentNumber.id,
                                'ERROR',
                                null
                            );
                            resultTracker.addResult({ success: false, status: 'ERROR' });
                            await resultTracker.printStats(dbManager);
                        }

                    } catch (error) {
                        console.error(`Error processing ${currentNumber.telephone}:`, error);
                        await dbManager.updateNumberStatus(
                            currentNumber.id,
                            'ERROR',
                            null
                        );
                        resultTracker.addResult({ success: false, status: 'ERROR' });
                        await resultTracker.printStats(dbManager);
                    } finally {
                        if (page) {
                            await page.close().catch(console.error);
                        }
                    }
                })();

                tabPromises.push(tabPromise);
                tokensGenerated++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            allPromises.push(...tabPromises);
        }

        await Promise.all(allPromises);

    } finally {
        await Promise.all(browsers.map(closeBrowser));
    }
}

// Remove DatabaseManager initialization and pass it as parameter
async function extractCapchaTokens(dbManager) {
    let shouldContinue = true;
    const resultTracker = new ResultTracker();
    
    await dbManager.resetNullStatusCheckedAt();
    
    while (shouldContinue) {
        let totalProcessed = 0;

        try {
            await dbManager.resetProcessingStatus();

            while (true) {
                const numbers = await dbManager.getNextBatch(BATCH_SIZE);
                if (numbers.length === 0) {
                    console.log('No more numbers to process');
                    break;
                }

                await generateTokens(numbers, resultTracker, dbManager);

                totalProcessed += numbers.length;
            }

            const errorCount = await dbManager.resetErrorStatus();
            
            if (errorCount > 0) {
                console.log(clc.yellow(`\nFound ${errorCount} failed numbers to retry. Starting retry process...\n`));
                continue;
            } else {
                console.log(clc.green('\nNo failed numbers to retry. Processing complete!\n'));
                shouldContinue = false;
            }

        } catch (error) {
            console.error(`Fatal error:`, error);
            shouldContinue = false;
        }
    }
}

// Update the bottom of the file
if (require.main === module) {
    extractCapchaTokens().catch(error => {
        console.error('Fatal error in DNCL processing:', error);
    });
} else {
    module.exports = extractCapchaTokens;
}