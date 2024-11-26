const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const axios = require('axios');
const dotenv = require('dotenv');
const EventEmitter = require('events');
const fs = require('fs');
const clc = require('cli-color');

dotenv.config();
const undici = require('undici');

puppeteerExtra.use(StealthPlugin());
const osPlatform = os.platform();
                
const executablePath = osPlatform.startsWith('win')  ? "C://Program Files//Google//Chrome//Application//chrome.exe" : "/usr/bin/google-chrome";

const CONCURRENT_BROWSERS = 1;
const BATCH_SIZE = 1;
const PHONE_NUMBER = '514-519-5990';
const ALLOW_PROXY = false;

// Initialize 2captcha solver with your API key
const APIKEY = 'ebf194334f2a754eda785a2cb04d6226';

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

async function extractCapchaTokens(totalAttempts = 30, tokenManager) {
    try {
        const totalBatches = Math.ceil(totalAttempts / BATCH_SIZE);
        let globalAttemptCount = 0;
        let completedAttemptCount = 0;

        results._totalAttempts = totalAttempts;

        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            console.log(`\n=== Starting Batch ${batchNum + 1}/${totalBatches} ===`);
            
            // Generate array of unique random numbers between 1-10
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
                    launchBrowser(`./chrome-data/chrome-data-${getRandomUnusedNumber()}`)
                )
            );
            console.log(`Launched ${CONCURRENT_BROWSERS} browsers for batch`);

            const batchAttempts = Math.min(BATCH_SIZE, totalAttempts - globalAttemptCount);
            
            try {
                const completedAttempts = new Map();
                
                console.log(`Opening ${batchAttempts} pages simultaneously...`);
                // Distribute pages across all browsers
                const pagePromises = Array(batchAttempts).fill(0).map(async (_, index) => {
                    // Distribute pages across all browsers
                    const browser = browsers[index % CONCURRENT_BROWSERS];
                    const page = await browser.newPage();
                    
                    try {
                        await page.evaluateOnNewDocument(() => {
                            Object.defineProperty(navigator, 'webdriver', ()=>{});
                            delete navigator.__proto__.webdriver;
                          });
                          const userAgents = [
                            // Keep the successful ones
                            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            // Add Linux Chrome
                            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                        ];
                        const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
                        await page.setUserAgent(randomUserAgent);
                        if (ALLOW_PROXY) {
                            await page.authenticate({
                                username: process.env.PROXY_USERNAME,
                                password: process.env.PROXY_PASSWORD
                            });
                        }

                        console.log(`\nProcessing tab ${index + 1} of batch ${batchNum + 1}`);
                        const success = await attemptCaptcha(page, PHONE_NUMBER);
                        
                        // Increment completed count and update results atomically
                        completedAttemptCount++;
                        if (success) {
                            results.successful.push(new Date().toISOString());
                            results.trackUserAgent(randomUserAgent, true);
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
                            results.trackUserAgent(randomUserAgent, false);
                        }

                        // Log progress after each individual completion
                        console.log(`\n=== PROGRESS UPDATE (Completed: ${completedAttemptCount}) ===`);
                        console.log(`Success rate: ${results.getSuccessRate()}%`);
                        console.log(`Total successful tokens: ${results.successful.length}`);
                        console.log(`Failed attempts: ${results.failed.length}`);
                        console.log(`Average time per attempt: ${results.getTimeStats().timePerAttempt} seconds`);
                        console.log(`Remaining attempts: ${totalAttempts - completedAttemptCount}`);
                        console.log('========================\n');

                    } catch (error) {
                        console.error(clc.red(`Error in tab ${index + 1}:`), clc.red(error));
                        completedAttemptCount++;
                        results.failed.push(new Date().toISOString());
                        results.trackUserAgent(randomUserAgent, false);

                    } finally {
                        try {
                            await page.close().catch(() => {});
                        } catch (e) {
                            console.log('Error closing page:', e.message);
                        }
                    }
                });

                // Wait for all pages to complete
                await Promise.all(pagePromises);
                console.log(`Successfully processed ${batchAttempts} pages in parallel`);

                globalAttemptCount += batchAttempts;

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
        console.log(`Total Attempts: ${totalAttempts}`);
        console.log(`Successful tokens: ${results.successful.length}`);
        console.log(`Failed attempts: ${results.failed.length}`);
        console.log(`Final success rate: ${results.getSuccessRate()}%`);
        console.log(`Total time: ${timeStats.totalTime} seconds`);
        console.log(`Average time per success: ${timeStats.timePerAttempt} seconds`);

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

// Update launchBrowser to accept userDataDir parameter
async function launchBrowser(userDataDir) {
    const proxyUrl = `${process.env.PROXY_HOST}:${process.env.PROXY_PORT}`;

    const randomProfile = Math.floor(Math.random() * 10) + 1;
    const browser = await puppeteerExtra.launch({
        headless: false,
        executablePath: executablePath,
        userDataDir: userDataDir, // Use the provided userDataDir
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

    // Set up request interception for all new pages
    browser.on('targetcreated', async (target) => {
        const page = await target.page();
        if (page) {
            await setupRequestInterception(page);
        }
    });

    return browser;
}

// New function to set up request interception
async function setupRequestInterception(page) {
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        const url = request.url();

        // Block unnecessary resource types
        if ([
            'image',
            'font',
            'media',
            'other'
        ].includes(resourceType) ||  url.includes('analytics') || url.includes('tracking') || url.includes('advertisement') || url.includes('marketing') || (url.includes('google-analytics.com') ||  url.includes('doubleclick.net') ||  url.includes('facebook.com'))
        ) {
            request.abort();
        }
        // Allow essential requests
        else if ( url.includes('recaptcha') || url.includes('gstatic.com') || url.includes('google.com') || url.includes('lnnte-dncl.gc.ca') || resourceType === 'xhr' || resourceType === 'fetch' || resourceType === 'document' || resourceType === 'script'
        ) {
            request.continue();
        }
        // Block everything else
        else {
            request.abort();
        }
    });
}

async function solve2Captcha(sitekey, pageUrl) {
    try {
        console.log('Initiating 2captcha solve request...');
        
        // First request to create the task
        const createTaskResponse = await axios.post('https://2captcha.com/in.php', null, {
            params: {
                key: APIKEY,
                method: 'userrecaptcha',
                googlekey: sitekey,
                pageurl: pageUrl,
                json: 1
            }
        });

        console.log('Create task response:', createTaskResponse.data);

        if (createTaskResponse.data.status !== 1) {
            throw new Error(`Failed to create captcha task: ${createTaskResponse.data.error_text}`);
        }

        const taskId = createTaskResponse.data.request;
        console.log('Got task ID:', taskId);

        // Poll for the result
        let attempts = 0;
        const maxAttempts = 60; // 30 minutes maximum (with 30-second intervals)
        
        while (attempts < maxAttempts) {
            console.log(`Checking solution status, attempt ${attempts + 1}/${maxAttempts}`);
            
            await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds between checks
            
            const resultResponse = await axios.get('https://2captcha.com/res.php', {
                params: {
                    key: APIKEY,
                    action: 'get',
                    id: taskId,
                    json: 1
                }
            });

            console.log('Result response:', resultResponse.data);

            if (resultResponse.data.status === 1) {
                console.log('Solution found!');
                return resultResponse.data.request;
            }

            if (resultResponse.data.request === 'CAPCHA_NOT_READY') {
                attempts++;
                continue;
            }

            throw new Error(`Failed to get solution: ${resultResponse.data.error_text}`);
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
            const solution = await solve2Captcha(sitekeyFromUrl, pageUrl);
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
            await page.type('#phone', '514-519-5990', { delay: 30 });
            
            // Verify the input value
            const inputValue = await page.$eval('#phone', el => el.value);
            if (inputValue === '514-519-5990') {
                console.log(`Successfully entered phone number: 514-519-5990`);
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
                return false;
            }
        }

        // Reduced random delay before clicking next button (200-500ms instead of 500-1500ms)
        await new Promise(resolve => setTimeout(resolve, 200 + Math.floor(Math.random() * 300)));
        
        // Click the next button
        await page.click('button[type="submit"]');
        console.log('Clicked next button to proceed to captcha page');

        // Wait for element that confirms we're on next page
        await page.waitForSelector('#wb-auto-2 > form > div > div:nth-child(3) > div', {
            timeout: 10000
        });
        console.log('Successfully moved to next page');

        // Wait for reCAPTCHA iframe to be present and loaded
        await page.waitForFunction(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).some(frame => 
                frame.src && frame.src.includes('recaptcha') && 
                frame.getBoundingClientRect().height > 0
            );
        }, { timeout: 25000 });
        console.log('ReCAPTCHA iframe detected');

        // Wait for Puppeteer to recognize the reCAPTCHA frame
        await page.waitForFunction(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).some(frame => 
                frame.src && frame.src.includes('recaptcha') && 
                frame.getBoundingClientRect().height > 0
            );
        }, { timeout: 10000 });

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
                
                // Try both click methods immediately
             
                    await recaptchaFrame.evaluate(selector => {
                        document.querySelector(selector).click();
                    }, selector);
                
                console.log('Clicked recaptcha checkbox');

                // Check for blocking message more aggressively
                const frames = await page.frames();
                const bframe = frames.find(frame => frame.url().includes('api2/bframe'));

                if (bframe) {
                    try {
                        // Check for both the header text and body text
                        const blockingSelectors = [
                            '.rc-doscaptcha-header-text',
                            '.rc-doscaptcha-body-text'
                        ];

                        for (const selector of blockingSelectors) {
                            const element = await bframe.$(selector);
                            if (element) {
                                const text = await bframe.$eval(selector, el => el.textContent);
                                if (text.includes('Try again later') || text.includes('automated queries')) {
                                    console.log(`Detected blocking message: "${text}". Moving on...`);
                                    return null;
                                }
                            }
                        }
                    } catch (e) {
                        console.log('No blocking message detected, continuing...');
                    }
                }

                // Run both checks concurrently
                const [token, challengeDetected] = await Promise.all([
                    // Check for token
                    page.evaluate(() => {
                        return new Promise((resolve) => {
                            const checkToken = () => {
                                const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                                if (textarea && textarea.value) {
                                    resolve(textarea.value);
                                }
                            };
                            const interval = setInterval(checkToken, 100);
                            setTimeout(() => {
                                clearInterval(interval);
                                resolve(null);
                            }, 7000);
                        });
                    }),
                    
                    // Check for challenge popup
                    page.evaluate(() => {
                        return new Promise((resolve) => {
                            const checkChallenge = () => {
                                const frames = document.getElementsByTagName('iframe');
                                const hasChallenge = Array.from(frames).some(frame => 
                                    frame.src && frame.src.includes('api2/bframe')
                                );
                                if (hasChallenge) {
                                    resolve(true);
                                }
                            };
                            const interval = setInterval(checkChallenge, 100);
                            setTimeout(() => {
                                clearInterval(interval);
                                console.log('No challenge popup detected');
                                resolve(false);
                            }, 7000);
                        });
                    })
                ]);

                // If challenge was detected before token, proceed with solving
                if (challengeDetected && !token) {
                    console.log('Challenge popup detected, attempting to solve captcha...');
                    const solvedToken = await solveCaptchaChallenge(page);
                    if (solvedToken) {
                        console.log('Successfully solved captcha and got token');
                        return solvedToken;
                    }
                    console.log('Failed to solve captcha');
                    return null;
                }

                if (token) {
                    console.log('reCAPTCHA token received:', token);
                    console.log(`Successfully got token for ${phoneNumber}`);
                    return token;
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(clc.red(`Failed to get token for ${phoneNumber}`));
        return null;

    } catch (error) {
        console.error(clc.red(`Error processing ${phoneNumber}:`), clc.red(error));
        return null;
    }
}

async function downloadAndTranscribeAudio(audioUrl) {
    try {
        let audioData;
        let downloadAttempts = 0;
        const maxDownloadAttempts = 3;
        
        // Download audio file with retries
        while (downloadAttempts < maxDownloadAttempts) {
            try {
                downloadAttempts++;
                console.log(`Downloading audio attempt ${downloadAttempts}/${maxDownloadAttempts} from:`, audioUrl);
                
                const audioResponse = await axios.get(audioUrl, {
                    responseType: 'arraybuffer',
                    validateStatus: false,
                    timeout: 60000, // 60 second timeout
                    // headers: {
                    //     'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                    // }
                });

                if (audioResponse.status !== 200) {
                    throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`);
                }

                audioData = audioResponse.data;
                console.log('Audio size:', audioData.length, 'bytes');
                break; // Success, exit retry loop

            } catch (downloadError) {
                console.log(downloadError)
                console.error(`Error downloading audio (attempt ${downloadAttempts}/${maxDownloadAttempts}):`, downloadError.message);
                if (downloadAttempts === maxDownloadAttempts) {
                    console.error('All download retry attempts failed');
                    return null;
                }
                // Wait 1 second before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        // Randomly choose between environment tokens
        const witTokens = [
            process.env.WIT_TOKEN,
            process.env.WIT_TOKEN_1,
            process.env.WIT_TOKEN_2
        ].filter(Boolean); // Filter out any undefined tokens
        
        const witToken = witTokens[Math.floor(Math.random() * witTokens.length)];

        console.log('Sending to wit.ai...');
        let witResponse;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`Attempt ${attempts}/${maxAttempts} to call wit.ai`);
                
                witResponse = await undici.request('https://api.wit.ai/speech?v=20220622', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${witToken}`,
                        'Content-Type': 'audio/mpeg3'
                    },
                    body: audioData,
                    bodyTimeout: 120000,
                    headersTimeout: 120000
                });
                break;
                
            } catch (witError) {
                console.error(`Error making wit.ai request (attempt ${attempts}/${maxAttempts}):`, witError.message);
                if (attempts === maxAttempts) {
                    console.error('All retry attempts failed');
                    return null;
                }
                // Wait 1 second before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        let fullResponse = '';
        try {
            for await (const chunk of witResponse.body) {
                fullResponse += chunk.toString();
            }
        } catch (streamError) {
            console.error('Error reading wit.ai response stream:', streamError.message);
            return null;
        }
        // Log first 100 characters of wit.ai response
        console.log('First 100 chars of response:', fullResponse.substring(0, 100));
        // Extract the last text value using regex
        const lastTextMatch = fullResponse.match(/"text":\s*"([^"]+)"/g);
        if (!lastTextMatch) {
            console.error(clc.red('NO TRANSCRIPTION MATCHES FOUND'));
            
            // Save debug info only on failure
            const tempDir = path.join(__dirname, 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(tempDir, `wit-response-${timestamp}.json`);
            fs.writeFileSync(filePath, fullResponse);
            console.log('Saved failed response to:', filePath);
            
            return null;
        }

        const lastText = lastTextMatch[lastTextMatch.length - 1];
        const audioTranscript = lastText.match(/"text":\s*"([^"]+)"/)[1];
        console.log('Transcribed text:', audioTranscript);

        return audioTranscript;

    } catch (error) {
        console.error(clc.red(`Error processing audio:`), clc.red(error.message));
        //console.log(error)
        return null;
    }
}


if (require.main === module) {
    const EventEmitter = require('events');
    const testManager = new EventEmitter();
    extractCapchaTokens(30, testManager);
} else {
    module.exports = extractCapchaTokens
    
}