const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');
const DatabaseManager = require('./DatabaseManager');
const ResultTracker = require('./ResultTracker');
const { sendDNCLRequest } = require('./DNCLRequestManager');

function formatPhoneNumber(phone) {
    // Trim whitespace and take first 12 characters
    return phone.trim().slice(0, 12);
}
dotenv.config();

puppeteerExtra.use(StealthPlugin());
const osPlatform = os.platform();
                
const executablePath = osPlatform.startsWith('win')  ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

const CONCURRENT_BROWSERS = 6;
const BATCH_SIZE = 16;

const ALLOW_PROXY = false;

// Add this line instead
const APIKEY = process.env['2CAPTCHA_API_KEY'];

// Optionally add a check to ensure the API key exists
if (!APIKEY) {
    throw new Error('2CAPTCHA_API_KEY is not set in environment variables');
}

// Define constant user agent to use throughout the app
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Add this as a global variable after the ResultTracker class
const resultTracker = new ResultTracker();



function getDefaultChromeUserDataDir() {
    if (/^win/i.test(osPlatform)) {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (/^darwin/i.test(osPlatform)) {  // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else {  // Linux
        return path.join(os.homedir(), '.config', 'google-chrome');
    }
}

// Add this at the top level of the file, after other constants
let currentChromeDataDirIndex = 0;

// Modify extractCapchaTokens function
async function extractCapchaTokens(dbManager) {
    let shouldContinue = true;
    
    await dbManager.resetNullStatusCheckedAt();

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

                try {
                    // Launch browsers with unique data directories
                    const browsers = await Promise.all(
                        Array.from({ length: CONCURRENT_BROWSERS }, async (_, index) => {
                            // Delay each browser launch by index * 1000ms
                            await new Promise(resolve => setTimeout(resolve, index * 1000));

                            currentChromeDataDirIndex = (currentChromeDataDirIndex % 20) + 1;
                            const chromeDataDir = `./chrome-user-data/chrome-user-data-${currentChromeDataDirIndex}`;
                            return launchBrowser(chromeDataDir);
                        })
                    );

                    try {
                        const pagePromises = numbers.map(async (numberRecord, index) => {
                            const browser = browsers[index % CONCURRENT_BROWSERS];
                            let page = null;
                            
                            try {
                                page = await browser.newPage();
                                await page.setUserAgent(USER_AGENT);
                                await page.setDefaultTimeout(30000);
                                await page.setDefaultNavigationTimeout(30000);
                                
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
                                await resultTracker.printStats(dbManager);

                            } catch (error) {
                                resultTracker.addResult({
                                    success: false,
                                    status: 'ERROR'
                                });
                                console.error(`Error processing ${numberRecord.telephone}:`, error);
                                await dbManager.updateNumberStatus(numberRecord.id, 'ERROR', null);
                                // Print stats even after errors
                                await resultTracker.printStats(dbManager);
                            } finally {
                                // Always close the page, even if there's an error
                                if (page) {
                                    await page.close().catch(err => 
                                        console.error('Error closing page:', err)
                                    );
                                }
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

            
        

            // After completing the run, check for ERROR status numbers and retry if any exist
            const errorCount = await dbManager.resetErrorStatus();
            
            if (errorCount > 0) {
                console.log(clc.yellow(`\nFound ${errorCount} failed numbers to retry. Starting retry process...\n`));
                // Continue the loop to process the reset numbers
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

// Update launchBrowser function to remove request interception setup
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

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
            '--lang=en',
            '--disable-web-security',
            '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end',
            `--profile-directory=Profile ${Math.floor(Math.random() * 20) + 1}`,
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
            await page.setDefaultTimeout(30000);
            await page.setDefaultNavigationTimeout(30000);
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

           // console.log('Result response:', resultResponse.data);

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
        const formattedPhone = formatPhoneNumber(phoneNumber);
        
        // Navigate to the initial page
        console.log(`Loading registration check page...`);
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // Use Angular to directly set the state and phone number
        console.log('Setting Angular state...');
        await page.evaluate((phone) => {
            const element = document.querySelector('[ng-show="state==\'number\'"]');
            if (!element) {
                throw new Error('Could not find the Angular element');
            }
            const scope = angular.element(element).scope();
            if (!scope) {
                throw new Error('Could not get Angular scope');
            }
            scope.model = scope.model || {};
            scope.model.phone = phone;
            scope.state = 'confirm';
            scope.$apply();
        }, formattedPhone);

        // Start timing here
        const captchaStartTime = Date.now();

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
            try {
                const result = await sendDNCLRequest(formattedPhone, solvedToken, USER_AGENT);
                return result;
            } catch (error) {
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

// Remove the Express server code at the bottom and replace with:
if (require.main === module) {
    extractCapchaTokens().catch(error => {
        console.error('Fatal error in DNCL processing:', error);
    });
} else {
    module.exports = extractCapchaTokens;
}