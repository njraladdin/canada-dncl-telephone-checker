const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

dotenv.config();

puppeteerExtra.use(StealthPlugin());
const osPlatform = os.platform();
                
const executablePath = osPlatform.startsWith('win')  ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

const CONCURRENT_BROWSERS = 6;
const BATCH_SIZE = 10;

const ALLOW_PROXY = false;

// Initialize 2captcha solver with your API key
const APIKEY = 'ebf194334f2a754eda785a2cb04d6226';

// Define constant user agent to use throughout the app
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Add this class near the top of the file, after the constants
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
            // Track if it was processed successfully (ACTIVE or INACTIVE)
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
        
        // Calculate average time based only on successfully processed numbers
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

// Add this as a global variable after the ResultTracker class
const resultTracker = new ResultTracker();

// Move results object declaration to the top level, before any function declarations
const results = {
    successful: [],
    failed: [],
    startTime: Date.now(),
    _totalAttempts: 0,
    getSuccessRate() {
        const total = this.successful.length + this.failed.length;
        return total ? ((this.successful.length / total) * 100).toFixed(2) : 0;
    },
    getTimeStats() {
        const totalTimeSeconds = (Date.now() - this.startTime) / 1000;
        const totalAttempts = this.successful.length + this.failed.length;
        const timePerAttempt = totalAttempts ? (totalTimeSeconds / totalAttempts).toFixed(2) : 0;
        
        return {
            totalTime: totalTimeSeconds.toFixed(2),
            timePerAttempt
        };
    },

};

function getDefaultChromeUserDataDir() {
    if (/^win/i.test(osPlatform)) {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (/^darwin/i.test(osPlatform)) {  // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else {  // Linux
        return path.join(os.homedir(), '.config', 'google-chrome');
    }
}

// Add new DatabaseManager class
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

    async getNextBatch(batchSize) {
        console.log(`Fetching next batch of ${batchSize} numbers...`);
        
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
            console.log(`Found ${numbers.length} numbers to process`);
            numbers.forEach(n => console.log(`ID: ${n.id}, Phone: ${n.telephone}`));
        }
        
        return numbers;
    }

    async updateNumberStatus(id, status, registrationDate = null) {
        const currentTime = new Date().toISOString();
        console.log(`\n=== Database Update ===`);
        console.log(`ID: ${clc.yellow(id)}`);
        console.log(`Status: ${clc.cyan(status)}`);
        console.log(`Registration Date: ${clc.cyan(registrationDate || 'N/A')}`);
        console.log(`Update Time: ${clc.cyan(currentTime)}`);
        console.log('====================\n');

        try {
            await this.db.run(`
                UPDATE numbers 
                SET 
                    dncl_status = ?,
                    dncl_registration_date = ?,
                    dncl_checked_at = ?
                WHERE id = ?
            `, [status, registrationDate, currentTime, id]);

            const updated = await this.db.get(
                'SELECT dncl_status, dncl_registration_date FROM numbers WHERE id = ?',
                id
            );

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

// Add this at the top level of the file, after other constants
let currentChromeDataDirIndex = 0;

// Modify extractCapchaTokens function
async function extractCapchaTokens() {
    const dbManager = new DatabaseManager();
    await dbManager.init();
    const startTime = Date.now();
    let totalProcessed = 0;

    // Modify the printStats function to be simple and straightforward
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

        // Calculate ETA based on successfully processed numbers only
        const estimatedTimeLeft = stats.successfullyProcessed > 0 
            ? (remaining.count * parseFloat(stats.avgTimePerNumber)) / CONCURRENT_BROWSERS 
            : 0;
        
        const hoursLeft = Math.floor(estimatedTimeLeft / 3600);
        const minutesLeft = Math.floor((estimatedTimeLeft % 3600) / 60);

        console.log(`\n[Stats] Success: ${clc.green(stats.successRate)}% | Avg Time (successful): ${clc.cyan(stats.avgTimePerNumber)}s | Total Processed: ${clc.yellow(stats.totalProcessed)} | Successfully Processed: ${clc.green(stats.successfullyProcessed)} | Remaining: ${clc.yellow(remaining.count)} | ETA: ${clc.magenta(`${hoursLeft}h ${minutesLeft}m`)}\n`);
    };

    try {
        await dbManager.resetProcessingStatus();

        while (true) {
            const numbers = await dbManager.getNextBatch(BATCH_SIZE);
            if (numbers.length === 0) {
                console.log('No more numbers to process');
                break;
            }

            try {
                // Launch browsers with unique data directories
                const browsers = await Promise.all(
                    Array.from({ length: CONCURRENT_BROWSERS }, async () => {
                        // Rotate through chrome data directories
                        currentChromeDataDirIndex = (currentChromeDataDirIndex % 10) + 1;
                        const chromeDataDir = `./javascript/chrome-data/chrome-data-${currentChromeDataDirIndex}`;
                        return launchBrowser(chromeDataDir);
                    })
                );

                try {
                    const pagePromises = numbers.map(async (numberRecord, index) => {
                        const browser = browsers[index % CONCURRENT_BROWSERS];
                        const page = await browser.newPage();
                        
                        try {
                            await page.setUserAgent(USER_AGENT);
                            if (ALLOW_PROXY) {
                                await page.authenticate({
                                    username: process.env.PROXY_USERNAME,
                                    password: process.env.PROXY_PASSWORD
                                });
                            }

                            console.log(`Processing ${numberRecord.telephone}`);
                            const result = await attemptCaptcha(page, numberRecord.telephone);
                            
                            if (result) {
                                resultTracker.addResult({
                                    success: true,
                                    status: result.status
                                });
                                await dbManager.updateNumberStatus(
                                    numberRecord.id, 
                                    result.status,
                                    result.registrationDate
                                );
                            } else {
                                resultTracker.addResult({
                                    success: false,
                                    status: 'ERROR'
                                });
                                await dbManager.updateNumberStatus(numberRecord.id, 'ERROR', null);
                            }

                            // Print stats immediately after processing each number
                            await printStats();

                        } catch (error) {
                            resultTracker.addResult({
                                success: false,
                                status: 'ERROR'
                            });
                            console.error(`Error processing ${numberRecord.telephone}:`, error);
                            await dbManager.updateNumberStatus(numberRecord.id, 'ERROR', null);
                            // Print stats even after errors
                            await printStats();
                        }
                    });

                    await Promise.all(pagePromises);

                } finally {
                    // Close browsers
                    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
                }

            } finally {
                // Add a small delay between batches
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            // Update counts after each batch
            totalProcessed += numbers.length;
        }

        // Print final results
        const totalTime = (Date.now() - startTime) / 1000;
        const timePerNumber = totalTime / totalProcessed;
        
        console.log('\n=== Final Results ===');
        console.log(`Total processed: ${clc.yellow(totalProcessed)}`);
        console.log(`Total time: ${clc.cyan(totalTime.toFixed(2))} seconds`);
        console.log(`Avg time per number: ${clc.cyan(timePerNumber.toFixed(2))} seconds`);
        console.log('=====================\n');

    } catch (error) {
        console.error(`Fatal error:`, error);
    } finally {
        await dbManager.close();
    }
}

// Update launchBrowser function to remove request interception setup
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

    const browser = await puppeteerExtra.launch({
        headless: true,
        executablePath: executablePath,
        userDataDir: userDataDir,
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
            '--lang=en',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${Math.floor(Math.random() * 10) + 1}`,
            ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });

    // Set user agent for all new pages
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await page.setUserAgent(USER_AGENT);
        }
    });

    return browser;
}

// Update solve2Captcha function to use the new format and include user agent
async function solve2Captcha(sitekey, pageUrl) {
    try {
        console.log('Initiating 2captcha solve request...');
        
        const taskData = {
            clientKey: APIKEY,
            task: {
                type: "RecaptchaV2TaskProxyless",
                websiteURL: pageUrl,
                websiteKey: sitekey,
                userAgent: USER_AGENT,
                isInvisible: false
            }
        };
        
      //  console.log('Task data:', JSON.stringify(taskData, null, 2));

        // Create task request
        const createTaskResponse = await axios.post('https://api.2captcha.com/createTask', taskData);

        console.log('Create task response:', createTaskResponse.data);

        if (createTaskResponse.data.errorId !== 0) {
            throw new Error(`Failed to create captcha task: ${createTaskResponse.data.errorDescription}`);
        }

        const taskId = createTaskResponse.data.taskId;
        console.log('Got task ID:', taskId);

        // Poll for the result
        let attempts = 0;
        const maxAttempts = 60;
        
        while (attempts < maxAttempts) {
           // console.log(`Checking solution status, attempt ${attempts + 1}/${maxAttempts}`);
            
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            const resultResponse = await axios.post('https://api.2captcha.com/getTaskResult', {
                clientKey: APIKEY,
                taskId: taskId
            });

           console.log('Result response:', resultResponse.data);

            if (resultResponse.data.status === 'ready') {
                console.log('Solution found!');
                return resultResponse.data.solution.token;
            }

            attempts++;
        }

        throw new Error('Timeout waiting for captcha solution');
    } catch (error) {
        console.error('Error in solve2Captcha:', error);
        throw error;
    }
}

async function solveCaptchaChallenge(page) {
    try {
        console.log('Starting 2captcha solution with detailed debugging...');
        
        // Debug: Log all iframes on the page
        const iframeUrls = await page.evaluate(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).map(frame => ({
                src: frame.src,
                id: frame.id,
                className: frame.className
            }));
        });
      //  console.log('All iframes found on page:', JSON.stringify(iframeUrls, null, 2));

        // Try to get sitekey from the URL if it exists in iframe src
        const recaptchaFrames = iframeUrls.filter(frame => frame.src.includes('recaptcha'));
        const sitekeyFromUrl = recaptchaFrames.length > 0 ? 
            new URL(recaptchaFrames[0].src).searchParams.get('k') : null;
        
        console.log('Sitekey found in iframe URL:', sitekeyFromUrl);

        if (!sitekeyFromUrl) {
            console.error('Could not find reCAPTCHA sitekey in iframe URL');
            return null;
        }

        // Get the page URL
        const pageUrl = page.url();
        console.log('Using page URL:', pageUrl);
        console.log('Using sitekey:', sitekeyFromUrl);

        try {
            // Get solution from 2captcha
            const solution = await solve2Captcha(sitekeyFromUrl, 'https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration');
            console.log('Got solution from 2captcha:', clc.yellow(solution.slice(0, 50) + '...'));

            // Insert the solution
            await page.evaluate((token) => {
                // Set textarea value
                document.querySelector('#g-recaptcha-response').value = token;
                
                // Make textarea visible (sometimes needed)
                document.querySelector('#g-recaptcha-response').style.display = 'block';
                
                // Try to trigger the callback
                try {
                    window.___grecaptcha_cfg.clients[0].K.K.callback(token);
                    console.log('Triggered callback successfully');
                } catch (e) {
                    console.log('Failed to trigger callback:', e);
                    // Alternative method to submit the form
                    const form = document.querySelector('form');
                    if (form) {
                        form.submit();
                    }
                }
            }, solution);

            return solution;
        } catch (error) {
            console.error('Error solving captcha with 2captcha:', error);
            return null;
        }
    } catch (error) {
        console.error('Error in solveCaptchaChallenge:', error);
        return null;
    }
}

// Modify the attemptCaptcha function to use the new captcha solving approach
async function attemptCaptcha(page, phoneNumber) {
    try {
        // Navigate to the initial page
        console.log(`Loading registration check page...`);
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // Wait for and fill in phone number
        const phoneInput = await page.waitForSelector('#phone');
        await page.evaluate(() => document.querySelector('#phone').focus());
        
        // Clear the input first
        await page.click('#phone', { clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace');

        // Type the number with verification
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            await page.type('#phone', phoneNumber, { delay: 30 });
            
            // Verify the input value
            const inputValue = await page.$eval('#phone', el => el.value);
            if (inputValue === phoneNumber) {
                console.log(`Successfully entered phone number: ${phoneNumber}`);
                break;
            } else {
                console.log(`Failed to enter number correctly. Attempt ${attempts + 1}. Got: ${inputValue}`);
                await page.click('#phone', { clickCount: 3 });
                await page.keyboard.press('Backspace');
            }
            attempts++;
            
            if (attempts === maxAttempts) {
                console.error(`Failed to enter phone number after ${maxAttempts} attempts`);
                return false;
            }
        }

        // Click the next button
        await page.click('button[type="submit"]');
        console.log('Clicked next button to proceed to captcha page');

        // Start timing here
        const captchaStartTime = Date.now();

        // Wait for element that confirms we're on next page
        await page.waitForSelector('#wb-auto-2 > form > div > div:nth-child(3) > div', {
            timeout: 20000
        });
        console.log('Successfully moved to next page');

        // Wait for reCAPTCHA iframe to be present
        await page.waitForFunction(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).some(frame => 
                frame.src && frame.src.includes('recaptcha') && 
                frame.getBoundingClientRect().height > 0
            );
        }, { timeout: 25000 });
        console.log('ReCAPTCHA iframe detected');

        // Solve the captcha using 2captcha
        console.log('Attempting to solve captcha with 2captcha...');
        const solvedToken = await solveCaptchaChallenge(page);
        
        if (solvedToken) {
            const captchaSolveTime = (Date.now() - captchaStartTime) / 1000;
            console.log(`Successfully solved captcha and got token in ${captchaSolveTime.toFixed(2)} seconds`);
            
            // Make the API request with the token
            console.log('Making API request with token...');
            try {
                const config = {
                    method: 'post',
                    url: 'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
                    headers: { 
                        'accept': 'application/json, text/plain, */*', 
                        'accept-language': 'en', 
                        'authorization-captcha': solvedToken,
                        'dnt': '1', 
                        'origin': 'https://lnnte-dncl.gc.ca', 
                        'priority': 'u=1, i', 
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
                        "Phone": phoneNumber
                    })
                };

                const response = await axios.request(config);
                console.log('\n=== API Response ===');
                console.log(`Status Code: ${clc.green(response.status)}`);
                console.log(`Phone Number: ${clc.yellow(phoneNumber)}`);
                console.log(`Status: ${clc.green('ACTIVE')}`);
                console.log(`Response Data: ${clc.cyan(JSON.stringify(response.data, null, 2))}`);
                console.log('==================\n');
                
                return {
                    status: 'ACTIVE',
                    registrationDate: response.data.AddedAt
                };

            } catch (error) {
                if (error.response?.status === 404) {
                    console.log('\n=== API Response ===');
                    console.log(`Status Code: ${clc.yellow(error.response.status)}`);
                    console.log(`Phone Number: ${clc.yellow(phoneNumber)}`);
                    console.log(`Status: ${clc.yellow('INACTIVE')}`);
                    console.log('==================\n');
                    
                    return {
                        status: 'INACTIVE',
                        registrationDate: null
                    };
                }
                
                console.error('\n=== API Error ===');
                console.error(`Status Code: ${clc.red(error.response?.status || 'N/A')}`);
                console.error(`Error Message: ${clc.red(error.message)}`);
                if (error.response?.data) {
                    console.error(`Response Data: ${clc.red(JSON.stringify(error.response.data, null, 2))}`);
                }
                console.error('==================\n');
                
                return null;
            }
        }

        console.log('Failed to solve captcha');
        return null;

    } catch (error) {
        console.error(clc.red(`Error processing ${phoneNumber}:`), clc.red(error));
        return null;
    }
}

if (require.main === module) {
    extractCapchaTokens();
} else {
    module.exports = extractCapchaTokens
}