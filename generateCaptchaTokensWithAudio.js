const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const undici = require('undici');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');
const ip = require('ip');
const renderProcessingPage = require('./renderProcessingPage');
const { formatPhoneNumber } = require('./sendDNCLRequest');

dotenv.config();

// Configuration
const CONCURRENT_BROWSERS = 5;
const BATCH_SIZE = 5;

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
                            console.log(clc.yellow('[Captcha] Detected "Try again later" message. Moving on...'));
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

// Add DatabaseManager class after other classes
class DatabaseManager {
    constructor(dbPath = './numbers.db') {
        this.dbPath = dbPath;
    }

    async init() {
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });
    }

    getDb() {
        return this.db;
    }

    async getNextBatch(batchSize) {
        console.log(clc.cyan(`\n[DB] Fetching next batch of ${batchSize} numbers...`));
        
        const numbers = await this.db.all(`
            UPDATE numbers 
            SET dncl_status = 'PROCESSING'
            WHERE id IN (
                SELECT id 
                FROM numbers 
                WHERE (dncl_status IS NULL OR dncl_status = '')
                AND telephone IS NOT NULL 
                AND phone_type = 'MOBILE'
                LIMIT ?
            )
            RETURNING id, telephone
        `, batchSize);

        if (numbers.length > 0) {
            console.log(clc.green(`[DB] Found ${numbers.length} numbers to process`));
            numbers.forEach(n => console.log(clc.yellow(`[DB] ID: ${n.id}, Phone: ${n.telephone}`)));
        }
        
        return numbers;
    }

    async updateNumberStatus(id, status, registrationDate = null) {
        const currentTime = new Date().toISOString();
        try {
            await this.db.run(`
                UPDATE numbers 
                SET 
                    dncl_status = ?,
                    dncl_registration_date = ?,
                    dncl_checked_at = ?
                WHERE id = ?
            `, [status, registrationDate, currentTime, id]);
        } catch (error) {
            console.error(clc.red(`Database update failed for ID ${id}:`), error.message);
            throw error;
        }
    }

    async resetProcessingStatus() {
        await this.db.run(`
            UPDATE numbers 
            SET dncl_status = NULL 
            WHERE dncl_status = 'PROCESSING'
        `);
    }

    async close() {
        if (this.db) {
            await this.db.close();
        }
    }
}

// Modify the generateTokens function to include API requests and DB updates
async function generateTokens(numbers, eventManager, resultTracker) {
    console.log(clc.cyan('\n=== Starting Token Generation ==='));
    console.log(clc.white('Total Numbers:'), clc.yellow(numbers.length));
    console.log(clc.white('Concurrent Browsers:'), clc.yellow(CONCURRENT_BROWSERS));
    console.log('===============================\n');

    const browsers = await launchBrowsers();
    const tabsPerBrowser = Math.ceil(numbers.length / browsers.length);
    const dbManager = new DatabaseManager();
    await dbManager.init();

    try {
        const allPromises = [];
        let tokensGenerated = 0;

        // Add printStats function inside generateTokens
        const printStats = async () => {
            const stats = resultTracker.getStats();
            if (!stats) return;

            const remaining = await dbManager.db.get(`
                SELECT COUNT(*) as count 
                FROM numbers 
                WHERE (dncl_status IS NULL OR dncl_status = '')
                AND telephone IS NOT NULL 
                AND phone_type = 'MOBILE'
            `);

            const avgTimePerNumber = parseFloat(stats.avgTimePerNumber);
            const remainingCount = remaining.count;
            const estimatedTimeLeft = remainingCount * avgTimePerNumber;
            const hoursLeft = Math.floor(estimatedTimeLeft / 3600);
            const minutesLeft = Math.floor((estimatedTimeLeft % 3600) / 60);

            console.log(`[Stats] Success: ${clc.green(stats.successRate)}% | Avg Time (successful): ${clc.cyan(stats.avgTimePerNumber)}s | Total Processed: ${clc.yellow(stats.totalProcessed)} | Successfully Processed: ${clc.green(stats.successfullyProcessed)} | Remaining: ${clc.yellow(remaining.count)} | ETA: ${clc.magenta(`${hoursLeft}h ${minutesLeft}m`)}`);
        };

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
                            // Make API request with the token
                            try {
                                const config = {
                                    method: 'post',
                                    url: 'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
                                    headers: { 
                                        'accept': 'application/json, text/plain, */*', 
                                        'accept-language': 'en', 
                                        'authorization-captcha': token,
                                        'dnt': '1', 
                                        'origin': 'https://lnnte-dncl.gc.ca', 
                                        'referer': 'https://lnnte-dncl.gc.ca/', 
                                        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', 
                                        'sec-ch-ua-mobile': '?0', 
                                        'sec-ch-ua-platform': '"Windows"', 
                                        'sec-fetch-dest': 'empty', 
                                        'sec-fetch-mode': 'cors', 
                                        'sec-fetch-site': 'same-site', 
                                        'user-agent': USER_AGENT,
                                        'Content-Type': 'application/json'
                                    },
                                    data: JSON.stringify({
                                        "Phone": formatPhoneNumber(currentNumber.telephone)
                                    })
                                };

                                const response = await axios.request(config);
                                console.log('\n=== API Response ===');
                                console.log(`Status Code: ${clc.green(response.status)}`);
                                console.log(`Phone Number: ${clc.yellow(currentNumber.telephone)}`);
                                console.log(`Formatted Phone: ${clc.yellow(formatPhoneNumber(currentNumber.telephone))}`);
                                console.log(`Status: ${clc.green('ACTIVE')}`);
                                console.log(`Response Data: ${clc.cyan(JSON.stringify(response.data, null, 2))}`);
                                console.log('==================\n');

                                console.log('\n=== Database Update ===');
                                console.log(`ID: ${clc.yellow(currentNumber.id)}`);
                                console.log(`Status: ${clc.green('ACTIVE')}`);
                                console.log(`Registration Date: ${clc.cyan(response.data.AddedAt)}`);
                                console.log(`Update Time: ${clc.cyan(new Date().toISOString())}`);
                                console.log('====================\n');

                                await dbManager.updateNumberStatus(
                                    currentNumber.id,
                                    'ACTIVE',
                                    response.data.AddedAt
                                );

                                resultTracker.addResult({ success: true, status: 'ACTIVE' });
                                await printStats();

                            } catch (error) {
                                if (error.response?.status === 404) {
                                    console.log('\n=== API Response ===');
                                    console.log(`Status Code: ${clc.yellow(error.response.status)}`);
                                    console.log(`Phone Number: ${clc.yellow(currentNumber.telephone)}`);
                                    console.log(`Status: ${clc.yellow('INACTIVE')}`);
                                    console.log('==================\n');

                                    console.log('\n=== Database Update ===');
                                    console.log(`ID: ${clc.yellow(currentNumber.id)}`);
                                    console.log(`Status: ${clc.yellow('INACTIVE')}`);
                                    console.log(`Registration Date: ${clc.cyan('N/A')}`);
                                    console.log(`Update Time: ${clc.cyan(new Date().toISOString())}`);
                                    console.log('====================\n');

                                    await dbManager.updateNumberStatus(
                                        currentNumber.id,
                                        'INACTIVE',
                                        null
                                    );

                                    resultTracker.addResult({ success: true, status: 'INACTIVE' });
                                    await printStats();
                                } else if (error.response?.status === 400) {
                                    console.error('\n=== API Error (400) ===');
                                    console.error(`Status Code: ${clc.red(error.response.status)}`);
                                    console.error(`Phone Number: ${clc.yellow(currentNumber.telephone)}`);
                                    console.error(`Error Message: ${clc.red(error.message)}`);
                                    console.error('Response Data:', clc.red(JSON.stringify(error.response.data, null, 2)));
                                    if (error.response.data?.message) {
                                        console.error('Error Text:', clc.red(error.response.data.message));
                                    }
                                    console.error('=====================\n');

                                    // Check if the error is due to invalid area code
                                    if (error.response.data?.ModelState?.['model.Phone']?.includes('Phone number area code is invalid.')) {
                                        console.log('\n=== Database Update ===');
                                        console.log(`ID: ${clc.yellow(currentNumber.id)}`);
                                        console.log(`Status: ${clc.yellow('INVALID')}`);
                                        console.log(`Registration Date: ${clc.cyan('N/A')}`);
                                        console.log(`Update Time: ${clc.cyan(new Date().toISOString())}`);
                                        console.log('====================\n');

                                        await dbManager.updateNumberStatus(
                                            currentNumber.id,
                                            'INVALID',
                                            null
                                        );
                                        
                                        resultTracker.addResult({ success: true, status: 'INVALID' });
                                        await printStats();
                                    } else {
                                        console.log('\n=== Database Update ===');
                                        console.log(`ID: ${clc.yellow(currentNumber.id)}`);
                                        console.log(`Status: ${clc.red('ERROR')}`);
                                        console.log(`Registration Date: ${clc.cyan('N/A')}`);
                                        console.log(`Update Time: ${clc.cyan(new Date().toISOString())}`);
                                        console.log('====================\n');

                                        await dbManager.updateNumberStatus(
                                            currentNumber.id,
                                            'ERROR',
                                            null
                                        );
                                        
                                        resultTracker.addResult({ success: false, status: 'ERROR' });
                                        await printStats();
                                    }
                                } else {
                                    console.error('\n=== API Error ===');
                                    console.error(`Status Code: ${clc.red(error.response?.status || 'N/A')}`);
                                    console.error(`Error Message: ${clc.red(error.message)}`);
                                    if (error.response?.data) {
                                        console.error(`Response Data: ${clc.red(JSON.stringify(error.response.data, null, 2))}`);
                                    }
                                    console.error('==================\n');

                                    await dbManager.updateNumberStatus(
                                        currentNumber.id,
                                        'ERROR',
                                        null
                                    );

                                    resultTracker.addResult({ success: false, status: 'ERROR' });
                                    await printStats();
                                }
                            }
                        } else {
                            await dbManager.updateNumberStatus(
                                currentNumber.id,
                                'ERROR',
                                null
                            );
                            resultTracker.addResult({ success: false, status: 'ERROR' });
                            await printStats();
                        }

                    } catch (error) {
                        console.error(`Error processing ${currentNumber.telephone}:`, error);
                        await dbManager.updateNumberStatus(
                            currentNumber.id,
                            'ERROR',
                            null
                        );
                        resultTracker.addResult({ success: false, status: 'ERROR' });
                        await printStats();
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
        await dbManager.close();
    }
}

// Add Express server setup at the bottom
const PORT = 5000;
const app = express();

app.get('/', async (req, res) => {
    const db = new DatabaseManager();
    try {
        await db.init();
        const html = await renderProcessingPage(db, req);
        res.send(html);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
    } finally {
        if (db) {
            await db.close();
        }
    }
});

// Add this function after DatabaseManager class
async function extractCapchaTokens() {
    const dbManager = new DatabaseManager();
    await dbManager.init();
    let shouldContinue = true;
    const resultTracker = new ResultTracker();

    while (shouldContinue) {
        const startTime = Date.now();
        let totalProcessed = 0;

        try {
            await dbManager.resetProcessingStatus();

            while (true) {
                const numbers = await dbManager.getNextBatch(BATCH_SIZE);
                if (numbers.length === 0) {
                    console.log('No more numbers to process');
                    break;
                }

                await generateTokens(numbers, {
                    emit: (event, data) => {
                        if (event === 'tokenGenerated') {
                            console.log(clc.green('\nToken generated for:'), data.telephone);
                            console.log(clc.yellow(data.token.slice(0, 50) + '...\n'));
                        } else if (event === 'tokenError') {
                            console.log(clc.red('\nError for', data.telephone + ':', data.error, '\n'));
                        }
                    }
                }, resultTracker);

                totalProcessed += numbers.length;
            }

            const totalTime = (Date.now() - startTime) / 1000;
            const timePerNumber = totalTime / totalProcessed;
            
            console.log('\n=== Final Results ===');
            console.log(`Total processed: ${clc.yellow(totalProcessed)}`);
            console.log(`Total time: ${clc.cyan(totalTime.toFixed(2))} seconds`);
            console.log(`Avg time per number: ${clc.cyan(timePerNumber.toFixed(2))} seconds`);
            console.log('=====================\n');

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

    await dbManager.close();
}

// Update the bottom of the file
if (require.main === module) {
    // Start Express server
    app.listen(PORT, () => {
        console.log('\n=== Progress Server Running ===');
        console.log(`Local:   http://localhost:${PORT}`);
        console.log(`Network: http://${ip.address()}:${PORT}`);
        console.log('===========================\n');
    });

    // Start the DNCL processing
    extractCapchaTokens().catch(error => {
        console.error('Fatal error in DNCL processing:', error);
    });
} else {
    module.exports = extractCapchaTokens;
}