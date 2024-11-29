const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');
const clc = require('cli-color');

dotenv.config();

// Configuration
const CONCURRENT_BROWSERS = 3;
const TABS_PER_BROWSER = 2;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const APIKEY = process.env['2CAPTCHA_API_KEY'];
const ALLOW_PROXY = false;
const osPlatform = os.platform();
const executablePath = osPlatform.startsWith('win') 
    ? "C://Program Files//Google//Chrome//Application//chrome.exe" 
    : "/usr/bin/google-chrome";

if (!APIKEY) {
    throw new Error('2CAPTCHA_API_KEY is not set in environment variables');
}

// Setup puppeteer with stealth plugin
puppeteerExtra.use(StealthPlugin());

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

    const browser = await puppeteerExtra.launch({
        headless: true,
       // executablePath: executablePath,
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

// Captcha solving functions
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

        const createTaskResponse = await axios.post('https://api.2captcha.com/createTask', taskData);
        console.log('Create task response:', createTaskResponse.data);

        if (createTaskResponse.data.errorId !== 0) {
            throw new Error(`Failed to create captcha task: ${createTaskResponse.data.errorDescription}`);
        }

        const taskId = createTaskResponse.data.taskId;
        console.log('Got task ID:', taskId);

        let attempts = 0;
        const maxAttempts = 60;
        
        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            
            const resultResponse = await axios.post('https://api.2captcha.com/getTaskResult', {
                clientKey: APIKEY,
                taskId: taskId
            });

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

async function extractSitekey(page) {
    const iframeUrls = await page.evaluate(() => {
        const frames = document.getElementsByTagName('iframe');
        return Array.from(frames).map(frame => ({
            src: frame.src,
            id: frame.id,
            className: frame.className
        }));
    });

    const recaptchaFrames = iframeUrls.filter(frame => frame.src.includes('recaptcha'));
    const sitekey = recaptchaFrames.length > 0 ? 
        new URL(recaptchaFrames[0].src).searchParams.get('k') : null;

    if (!sitekey) {
        throw new Error('Could not find reCAPTCHA sitekey');
    }

    console.log('Found sitekey:', sitekey);
    return sitekey;
}

async function injectToken(page, token) {
    await page.evaluate((token) => {
        document.querySelector('#g-recaptcha-response').value = token;
        document.querySelector('#g-recaptcha-response').style.display = 'block';
        
        try {
            window.___grecaptcha_cfg.clients[0].K.K.callback(token);
            console.log('Triggered callback successfully');
        } catch (e) {
            console.log('Failed to trigger callback:', e);
            const form = document.querySelector('form');
            if (form) form.submit();
        }
    }, token);
}

async function ensureTempDir() {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    return tempDir;
}

async function solveCaptchaChallenge(page, resultTracker) {
    try {
        console.log('Loading registration check page...');
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
            await page.type('#phone', '514-519-5990', { delay: 30 });
            
            // Verify the input value
            const inputValue = await page.$eval('#phone', el => el.value);
            if (inputValue === '514-519-5990') {
                console.log('Successfully entered phone number: 514-519-5990');
                break;
            } else {
                console.log(`Failed to enter number correctly. Attempt ${attempts + 1}. Got: ${inputValue}`);
                // Clear and try again
                await page.click('#phone', { clickCount: 3 });
                await page.keyboard.press('Backspace');
            }
            attempts++;
            
            if (attempts === maxAttempts) {
                console.error(`Failed to enter phone number after ${maxAttempts} attempts`);
                return null;
            }
        }

        // Small delay before clicking next button
        await new Promise(resolve => setTimeout(resolve, 200 + Math.floor(Math.random() * 300)));
        
        // Click the next button
        await page.click('button[type="submit"]');
        console.log('Clicked next button to proceed to captcha page');

        // Wait for reCAPTCHA iframe
        await page.waitForFunction(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).some(frame => 
                frame.src && frame.src.includes('recaptcha') && 
                frame.getBoundingClientRect().height > 0
            );
        }, { timeout: 25000 });

        const sitekey = await extractSitekey(page);
        const solution = await solve2Captcha(sitekey, page.url());

        if (solution) {
            await injectToken(page, solution);
            resultTracker.addResult({ success: true, status: 'SUCCESS' });
            
            console.log('\n=== GOT TOKEN ===');
            console.log(clc.yellow(solution.slice(0, 100) + '...'));
            console.log('================\n');
            
            return solution;
        }

        resultTracker.addResult({ success: false, status: 'ERROR' });
        return null;

    } catch (error) {
        console.error('Error in solveCaptchaChallenge:', error);
        
        // Take screenshot on navigation timeout error
        if (error.name === 'TimeoutError' && error.message.includes('Navigation timeout')) {
            try {
                const tempDir = await ensureTempDir();
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const screenshotPath = path.join(tempDir, `timeout-error-${timestamp}.png`);
                
                await page.screenshot({
                    path: screenshotPath,
                    fullPage: true
                });
                
                console.log(`Screenshot saved to: ${screenshotPath}`);
            } catch (screenshotError) {
                console.error('Failed to save screenshot:', screenshotError);
            }
        }

        resultTracker.addResult({ success: false, status: 'ERROR' });
        return null;
    }
}

// Main token generation function
async function generateTokens(count, eventManager) {
    const resultTracker = new ResultTracker();
    const browsers = await launchBrowsers();
    const totalConcurrentTabs = CONCURRENT_BROWSERS * TABS_PER_BROWSER;

    try {
        let tokensGenerated = 0;
        while (tokensGenerated < count) {
            const remainingTokens = count - tokensGenerated;
            const batchSize = Math.min(remainingTokens, totalConcurrentTabs);
            
            const tokenPromises = Array(batchSize).fill().map(async (_, index) => {
                // Calculate which browser to use based on the tab index
                const browserIndex = Math.floor(index / TABS_PER_BROWSER);
                const browser = browsers[browserIndex % CONCURRENT_BROWSERS];
                const page = await browser.newPage();
                
                try {
                    await page.setUserAgent(USER_AGENT);
                    const token = await solveCaptchaChallenge(page, resultTracker);
                    if (token) {
                        eventManager.emit('tokenGenerated', { token });
                        tokensGenerated++;
                    }
                } catch (error) {
                    console.error('Error generating token:', error);
                    eventManager.emit('tokenError', { error: error.message });
                } finally {
                    await page.close().catch(console.error);
                }
            });

            await Promise.all(tokenPromises);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        console.error('Fatal error in token generation:', error);
        throw error;
    } finally {
        await Promise.all(browsers.map(closeBrowser));
    }
}

// Replace everything after generateTokens with this simple execution block
if (require.main === module) {
    const eventManager = {
        emit: (event, data) => {
            if (event === 'tokenGenerated') {
                console.log(clc.green('\nToken generated:'));
                console.log(clc.yellow(data.token.slice(0, 50) + '...\n'));
            } else if (event === 'tokenError') {
                console.log(clc.red('\nError:', data.error, '\n'));
            }
        }
    };

    console.log(clc.cyan('Starting token generation...'));
    generateTokens(3, eventManager)
        .then(() => console.log(clc.green('Done!')))
        .catch(console.error);
} else {
    module.exports = generateTokens;
}