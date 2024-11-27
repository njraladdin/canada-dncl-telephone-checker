const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const EventEmitter = require('events');
const fs = require('fs');
const clc = require('cli-color');

dotenv.config();

puppeteerExtra.use(StealthPlugin());
const osPlatform = os.platform();
                
const executablePath = osPlatform.startsWith('win')  ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

const CONCURRENT_BROWSERS = 2;
const BATCH_SIZE = 4;
const PHONE_NUMBERS = [
    '514-933-1367',
    '514-332-5110',
    '450-468-7850',
    '450-682-5645',
    '514-861-0583',
    '819-472-4342',
    '819-763-8334',
    '579-252-0330',
    '418-263-5312',
    '418-681-0696',
    '450-647-3724',
    '418-649-2712'
];
const ALLOW_PROXY = false;

// Initialize 2captcha solver with your API key
const APIKEY = 'ebf194334f2a754eda785a2cb04d6226';

// Define constant user agent to use throughout the app
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Move results object declaration to the top level, before any function declarations
const results = {
    successful: [],
    failed: [],
    startTime: Date.now(),
    _totalAttempts: 0,
    userAgentStats: new Map(),
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
    trackUserAgent(userAgent, success) {
        if (!this.userAgentStats.has(userAgent)) {
            this.userAgentStats.set(userAgent, { success: 0, failed: 0 });
        }
        const stats = this.userAgentStats.get(userAgent);
        success ? stats.success++ : stats.failed++;
    },
    getUserAgentStats() {
        const stats = [];
        this.userAgentStats.forEach((value, userAgent) => {
            const total = value.success + value.failed;
            const successRate = ((value.success / total) * 100).toFixed(2);
            stats.push({
                userAgent,
                success: value.success,
                failed: value.failed,
                total,
                successRate: `${successRate}%`
            });
        });
        return stats;
    }
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

async function extractCapchaTokens(phoneNumbers = PHONE_NUMBERS, tokenManager) {
    try {
        const totalBatches = Math.ceil(phoneNumbers.length / BATCH_SIZE);
        let globalAttemptCount = 0;
        let completedAttemptCount = 0;

        results._totalAttempts = phoneNumbers.length;

        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            console.log(`\n=== Starting Batch ${batchNum + 1}/${totalBatches} ===`);
            
            // Generate array of unique random numbers between 1-4
            const usedNumbers = new Set();
            const getRandomUnusedNumber = () => {
                let num;
                do {
                    num = Math.floor(Math.random() * 4) + 1;
                } while (usedNumbers.has(num));
                usedNumbers.add(num);
                return num;
            };
            
            // Launch browsers concurrently with random profile numbers
            const browsers = await Promise.all(
                Array.from({ length: CONCURRENT_BROWSERS }, () => 
                    launchBrowser(`./javascript/chrome-data/chrome-data-${getRandomUnusedNumber()}`)
                )
            );
            console.log(`Launched ${CONCURRENT_BROWSERS} browsers for batch`);

            // Get the current batch of phone numbers
            const startIdx = batchNum * BATCH_SIZE;
            const batchPhoneNumbers = phoneNumbers.slice(startIdx, startIdx + BATCH_SIZE);
            
            try {
                const completedAttempts = new Map();
                
                console.log(`Processing ${batchPhoneNumbers.length} phone numbers in this batch...`);
                // Use existing pages instead of creating new ones
                const pagePromises = batchPhoneNumbers.map(async (phoneNumber, index) => {
                    // Get the browser for this index
                    const browser = browsers[index % CONCURRENT_BROWSERS];
                    // Get the first page of the browser or create one if none exists
                    const pages = await browser.pages();
                    const page = pages[0] || await browser.newPage();
                    
                    try {
                        await page.evaluateOnNewDocument(() => {
                            Object.defineProperty(navigator, 'webdriver', ()=>{});
                            delete navigator.__proto__.webdriver;
                        });
                        
                        await page.setUserAgent(USER_AGENT);
                        if (ALLOW_PROXY) {
                            await page.authenticate({
                                username: process.env.PROXY_USERNAME,
                                password: process.env.PROXY_PASSWORD
                            });
                        }

                        console.log(`\nProcessing phone number ${phoneNumber} (${index + 1}/${batchPhoneNumbers.length})`);
                        const success = await attemptCaptcha(page, phoneNumber);
                        
                        // Increment completed count and update results atomically
                        completedAttemptCount++;
                        if (success) {
                            results.successful.push(new Date().toISOString());
                            results.trackUserAgent(USER_AGENT, true);
                            try {
                                await new Promise((resolve) => {
                                    tokenManager.emit('tokenExtracted', success);
                                    resolve();
                                });
                            } catch (error) {
                                console.error('TokenManager test failed:', error);
                            }
                        } else {
                            results.failed.push(new Date().toISOString());
                            results.trackUserAgent(USER_AGENT, false);
                        }

                        // Log progress after each individual completion
                        console.log(`\n=== PROGRESS UPDATE (Completed: ${completedAttemptCount}/${phoneNumbers.length}) ===`);
                        console.log(`Success rate: ${results.getSuccessRate()}%`);
                        console.log(`Total successful checks: ${results.successful.length}`);
                        console.log(`Failed attempts: ${results.failed.length}`);
                        console.log(`Average time per attempt: ${results.getTimeStats().timePerAttempt} seconds`);
                        console.log(`Remaining numbers: ${phoneNumbers.length - completedAttemptCount}`);
                        console.log('========================\n');

                    } catch (error) {
                        console.error(clc.red(`Error processing ${phoneNumber}:`), clc.red(error));
                        completedAttemptCount++;
                        results.failed.push(new Date().toISOString());
                        results.trackUserAgent(USER_AGENT, false);
                    }
                    // Don't close the page since we're reusing it
                });

                // Wait for all pages in this batch to complete
                await Promise.all(pagePromises);
                console.log(`Successfully processed batch of ${batchPhoneNumbers.length} phone numbers`);

                globalAttemptCount += batchPhoneNumbers.length;

            } finally {
                // Close all browsers at end of batch
                try {
                    await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
                    console.log(`Successfully closed all ${CONCURRENT_BROWSERS} browsers for batch`);
                } catch (e) {
                    console.log('Error closing browsers:', e.message);
                }
                
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Final results after all attempts
        console.log('\n=== FINAL RESULTS ===');
        const timeStats = results.getTimeStats();
        console.log(`Total Phone Numbers Processed: ${phoneNumbers.length}`);
        console.log(`Successful checks: ${results.successful.length}`);
        console.log(`Failed attempts: ${results.failed.length}`);
        console.log(`Final success rate: ${results.getSuccessRate()}%`);
        console.log(`Total time: ${timeStats.totalTime} seconds`);
        console.log(`Average time per check: ${timeStats.timePerAttempt} seconds`);

        console.log('\n=== USER AGENT STATISTICS ===');
        const userAgentStats = results.getUserAgentStats();
        userAgentStats.sort((a, b) => parseFloat(b.successRate) - parseFloat(a.successRate));
        userAgentStats.forEach(stat => {
            console.log(`\nUser Agent: ${stat.userAgent}`);
            console.log(`Success Rate: ${stat.successRate}`);
            console.log(`Successful: ${stat.success}`);
            console.log(`Failed: ${stat.failed}`);
            console.log(`Total Attempts: ${stat.total}`);
        });
        console.log('===================\n');

    } catch (error) {
        console.error(clc.red(`Fatal error:`), clc.red(error));
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
        
        console.log('Task data:', JSON.stringify(taskData, null, 2));

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
            console.log(`Checking solution status, attempt ${attempts + 1}/${maxAttempts}`);
            
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
        console.log('All iframes found on page:', JSON.stringify(iframeUrls, null, 2));

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
            console.log('Got solution from 2captcha:', solution);

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
            timeout: 10000
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

                try {
                    const response = await axios.request(config);
                    console.log('\n=== API Response ===');
                    console.log(`Status Code: ${response.status}`);
                    console.log(`Phone Number: ${phoneNumber}`);
                    console.log(`Status: ACTIVE`);
                    console.log(`Response Data: ${JSON.stringify(response.data, null, 2)}`);
                    console.log('==================\n');
                    return solvedToken;
                } catch (error) {
                    if (error.response) {
                        console.log('\n=== API Response ===');
                        console.log(`Status Code: ${error.response.status}`);
                        console.log(`Phone Number: ${phoneNumber}`);
                        
                        if (error.response.status === 404) {
                            console.log(`Status: INACTIVE`);
                        } else if (error.response.status === 400) {
                            console.log(`Status: ERROR - TOKEN NOT WORKING`);
                            return null; // Return null for invalid token
                        } else {
                            console.log(`Status: UNKNOWN ERROR`);
                        }
                        
                        console.log(`Response Data: ${JSON.stringify(error.response.data, null, 2)}`);
                        console.log('==================\n');
                        
                        // Only return token if it's a valid 404 (INACTIVE) response
                        return error.response.status === 404 ? solvedToken : null;
                    } else {
                        console.error('Error making API request:', error.message);
                        return null;
                    }
                }

            } catch (error) {
                console.error('Error in API request setup:', error.message);
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
    const EventEmitter = require('events');
    const testManager = new EventEmitter();
    extractCapchaTokens(PHONE_NUMBERS, testManager);
} else {
    module.exports = extractCapchaTokens
}