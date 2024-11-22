const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const dotenv = require('dotenv');
dotenv.config();
const undici = require('undici');
const fs = require('fs');

puppeteerExtra.use(StealthPlugin());

// Add platform-specific executable path logic
const osPlatform = os.platform();
let executablePath;
if (/^win/i.test(osPlatform)) {
    executablePath = "C://Program Files//Google//Chrome//Application//chrome.exe";
} else if (/^linux/i.test(osPlatform)) {
    executablePath = "/usr/bin/google-chrome";
}

const ALLOW_PROXY = true;
const PHONE_NUMBERS = [
    '514-519-5990', '514-298-4761', '613-324-6266',
    '514-947-1271', '514-443-3423', '514-862-0122',
    '416-938-4616', '450-558-9278', '514-206-0848',
    '514-962-3884', '819-860-6532', '514-975-3641',
    // '514-605-8392', '514-949-6404', '418-951-4916',
    // '581-234-3734', '438-994-6354', '514-795-4732',
    // '514-913-3606', '613-295-4115', '514-823-7290',
    // '514-606-9032', '514-805-5930', '418-569-7631',
    // '514-235-9565', '514-466-5735', '571-488-9969',
    // '819-859-2345', '613-513-8852', '514-269-3401',
    // '450-880-0946', '514-243-4065', '514-946-1212',
    // '514-594-6553', '514-209-2613', '418-802-1100',
    // '819-856-3071', '514-572-1544'
];
const proxyUrl = `premium-residential.geonode.com:9009`;

// Add at the top with other constants
const results = {
    successful: [],
    failed: [],
    startTime: Date.now(),
    successTimes: [], // Array to store time taken for successful attempts
    allTimes: [], // Array to store time taken for all attempts
    getSuccessRate() {
        const total = this.successful.length + this.failed.length;
        return total ? ((this.successful.length / total) * 100).toFixed(2) : 0;
    },
    getTimeStats() {
        const totalTime = (Date.now() - this.startTime) / 1000; // Convert to seconds
        const avgTimeAll = this.allTimes.length ? 
            (this.allTimes.reduce((a, b) => a + b, 0) / this.allTimes.length).toFixed(2) : 0;
        const avgTimeSuccess = this.successTimes.length ? 
            (this.successTimes.reduce((a, b) => a + b, 0) / this.successTimes.length).toFixed(2) : 0;
        
        return {
            totalTime: totalTime.toFixed(2),
            avgTimeAll,
            avgTimeSuccess
        };
    }
};
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;

function getDefaultChromeUserDataDir() {
    if (/^win/i.test(osPlatform)) {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (/^darwin/i.test(osPlatform)) {  // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else {  // Linux
        return path.join(os.homedir(), '.config', 'google-chrome');
    }
}

async function scrapeWebsite() {
    try {
        // Initial browser setup
        let browser = await launchBrowser();
        let currentIndex = 0;

        while (currentIndex < PHONE_NUMBERS.length) {
            const remainingNumbers = PHONE_NUMBERS.slice(currentIndex);
            const batch = remainingNumbers.slice(0, 3);
            console.log(`Processing batch starting at index ${currentIndex}: ${batch.join(', ')}`);

            try {
                const promises = batch.map(async (phoneNumber, index) => {
                    let page;
                    try {
                        page = await browser.newPage();
                        
                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

                        if (ALLOW_PROXY) {
                            await page.authenticate({
                                username: process.env.PROXY_USERNAME,
                                password: process.env.PROXY_PASSWORD
                            });
                        }

                        // Move page setup into a separate try-catch block
                        try {
                            await page.evaluateOnNewDocument(() => {
                                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                                Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
                                Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
                                
                                window.chrome = {
                                    runtime: {}
                                };
                                
                                const originalQuery = window.navigator.permissions.query;
                                window.navigator.permissions.query = (parameters) => (
                                    parameters.name === 'notifications' ?
                                    Promise.resolve({ state: Notification.permission }) :
                                    originalQuery(parameters)
                                );
                            });

                            const success = await attemptCaptcha(page, phoneNumber);
                            if (success) {
                                consecutiveFailures = 0;
                                results.successful.push(phoneNumber);
                            } else {
                                results.failed.push(phoneNumber);
                                consecutiveFailures++;
                            }
                        } catch (error) {
                            console.error(`Error processing ${phoneNumber}:`, error);
                            results.failed.push(phoneNumber);
                            consecutiveFailures++;
                        } finally {
                            if (page) {
                                try {
                                    await page.close().catch(() => {});
                                } catch (e) {
                                    console.log('Error closing page:', e.message);
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`Error processing ${phoneNumber}:`, error);
                        results.failed.push(phoneNumber);
                        consecutiveFailures++;
                    }
                });

                await Promise.all(promises);
                console.log(`\n=== BATCH RESULTS (Index: ${currentIndex}) ===`);
                console.log(`Successful numbers so far (${results.successful.length}):`, results.successful.join(', '));
                console.log(`Failed numbers so far (${results.failed.length}):`, results.failed.join(', '));
                console.log(`Current success rate: ${results.getSuccessRate()}%`);
                console.log('==========================================\n');

                // Check if we need to restart browser after batch completion
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.log(`${MAX_CONSECUTIVE_FAILURES} consecutive failures reached. Restarting browser...`);
                    try {
                        await browser.close().catch(() => {});
                    } catch (e) {
                        console.log('Error closing browser:', e.message);
                    }
                    
                    // Add delay before launching new browser
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    try {
                        browser = await launchBrowser();
                        console.log('Successfully launched new browser');
                        consecutiveFailures = 0;
                    } catch (e) {
                        console.error('Failed to launch new browser:', e);
                        // If we can't launch a new browser, wait and try again
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        browser = await launchBrowser();
                    }
                }

                currentIndex += 3;
                
            } catch (batchError) {
                console.error('Batch processing error:', batchError);
                // If batch fails, increment index by 1 instead of 3 to retry failed numbers
                currentIndex += 1;
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Final cleanup
        try {
            await browser.close().catch(() => {});
        } catch (e) {
            console.log('Error closing browser at end:', e.message);
        }
        
        // Log final results
        console.log('\n=== FINAL RESULTS ===');
        const timeStats = results.getTimeStats();
        console.log(`\nTiming Statistics:`);
        console.log(`Total Time: ${timeStats.totalTime} seconds`);
        console.log(`Average Time Per Number: ${timeStats.avgTimeAll} seconds`);
        console.log(`Average Time Per Successful Number: ${timeStats.avgTimeSuccess} seconds`);
        console.log(`\nSuccessful numbers (${results.successful.length}):`);
        console.log(results.successful.join('\n'));
        console.log(`\nFailed numbers (${results.failed.length}):`);
        console.log(results.failed.join('\n'));
        console.log(`\nSuccess rate: ${results.getSuccessRate()}%`);
        console.log('\n===================');
        
    } catch (error) {
        console.error('An error occurred:', error);
    }
}

// Helper function to launch browser with existing configuration
async function launchBrowser() {
    const randomProfile = Math.floor(Math.random() * 6) + 1; // Random number between 1-5
    return await puppeteerExtra.launch({
        headless: true,
        executablePath: executablePath,
        userDataDir: './chrome-data3',//getDefaultChromeUserDataDir(),// 
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
            `--profile-directory=Profile ${randomProfile}`,
            ALLOW_PROXY ? `--proxy-server=${proxyUrl}` : ''
        ].filter(Boolean),
        ignoreDefaultArgs: ['--enable-automation', '--enable-blink-features=AutomationControlled'],
        defaultViewport: null,
    });
}

async function solveCaptchaChallenge(page) {
    function rdn(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    try {
        // Add detection for connection error alert
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

        // Wait for challenge
        console.log('Waiting for challenge...');
        await page.waitForFunction(() => {
            const frames = document.getElementsByTagName('iframe');
            return Array.from(frames).some(frame => 
                frame.src && frame.src.includes('api2/bframe')
            );
        }, { timeout: 15000 });
        
        // Get bframe
        const frames = await page.frames();
        const bframe = frames.find(frame => frame.url().includes('api2/bframe'));
        
        if (!bframe) {
            console.log('Could not find bframe');
            return;
        }

        // Click audio button
        await new Promise(resolve => setTimeout(resolve, 2000));
        const audioButton = await bframe.waitForSelector('#recaptcha-audio-button', {
            visible: true,
            timeout: 10000
        });
        
        if (!audioButton) {
            console.log('Audio button not found');
            return;
        }

        await audioButton.click({ delay: rdn(30, 150) });
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check for blocking message before proceeding with audio challenge
        try {
            const blockingMessage = await bframe.$('.rc-doscaptcha-header-text');
            if (blockingMessage) {
                const text = await bframe.$eval('.rc-doscaptcha-header-text', el => el.textContent);
                if (text.includes('Try again later')) {
                    console.log('Detected "Try again later" message after clicking audio button. Moving on...');
                    return null;
                }
            }
        } catch (e) {
            console.log('No blocking message detected, continuing with audio challenge...');
        }

        while (true) {
            try {
                // Check for blocking message at start of each loop
                const blockingMessage = await bframe.$('.rc-doscaptcha-header-text');
                if (blockingMessage) {
                    const text = await bframe.$eval('.rc-doscaptcha-header-text', el => el.textContent);
                    if (text.includes('Try again later')) {
                        console.log('Detected "Try again later" message during audio challenge. Moving on...');
                        return null;
                    }
                }

                // Wait for audio challenge with shorter timeout
                await bframe.waitForSelector('.rc-audiochallenge-tdownload-link', {
                    timeout: 5000
                });
                console.log('Audio challenge appeared');

                // Get audio URL and process it
                const audioUrl = await bframe.$eval('#audio-source', el => el.src);
                console.log('Got audio URL:', audioUrl);

                const transcription = await processAudio(audioUrl);
                if (!transcription) {
                    console.log('Failed to get transcription, retrying...');
                    const reloadButton = await bframe.$('#recaptcha-reload-button');
                    await reloadButton.click({ delay: rdn(30, 150) });
                    continue;
                }

                console.log('Got transcription:', transcription);

                // Enter the transcription
                const input = await bframe.$('#audio-response');
                await input.click({ delay: rdn(30, 150) });
                await input.type(transcription, { delay: rdn(30, 75) });

                // Click verify
                const verifyButton = await bframe.$('#recaptcha-verify-button');
                await verifyButton.click({ delay: rdn(30, 150) });

                // Wait for result
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
                        }, 15000);
                    });
                });

                if (token) {
                    console.log('Token:', token);
                    console.log('Successfully solved captcha!');
                    return token;
                }

                console.log('No token received, retrying...');
                continue;

            } catch (error) {
                console.error('Error in audio challenge loop:', error);
                // Clean up alert handler before continuing
                page.removeListener('dialog', alertHandler);
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }
        }
    } catch (error) {
        console.error('Fatal error in solveCaptcha:', error);
        return null;
    }
}

async function attemptCaptcha(page, phoneNumber) {
    const startTime = Date.now();
    try {
        // Navigate directly to registration check page
        console.log(`Loading registration check page for ${phoneNumber}...`);
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // // Add a 30 second delay
        // console.log('Waiting 30 seconds...');
        // await new Promise(resolve => setTimeout(resolve, 30000));
        // console.log('30 second wait completed');
        // More robust phone number input handling
        const phoneInput = await page.waitForSelector('#phone');
        await page.evaluate(() => document.querySelector('#phone').focus());
        
        // Clear the input first
        await page.click('#phone', { clickCount: 3 }); // Triple click to select all
        await page.keyboard.press('Backspace');

        // Type the number with verification
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            await page.type('#phone', phoneNumber, { delay: 100 });
            
            // Verify the input value
            const inputValue = await page.$eval('#phone', el => el.value);
            if (inputValue === phoneNumber) {
                console.log(`Successfully entered phone number: ${phoneNumber}`);
                break;
            } else {
                console.log(`Failed to enter number correctly. Attempt ${attempts + 1}. Got: ${inputValue}`);
                // Clear and try again
                await page.click('#phone', { clickCount: 3 });
                await page.keyboard.press('Backspace');
            }
            attempts++;
            
            if (attempts === maxAttempts) {
                console.error(`Failed to enter phone number after ${maxAttempts} attempts: ${phoneNumber}`);
                return false;
            }
        }

        // Add small random delay (500-1500ms) before clicking next button
        await new Promise(resolve => setTimeout(resolve, 500 + Math.floor(Math.random() * 1000)));
        
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
        }, { timeout: 10000 });
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
                try {
                    await recaptchaFrame.click(selector, { delay: rdn(30, 150) });
                } catch (error) {
                    console.log('Standard click failed, trying evaluate click...');
                    await recaptchaFrame.evaluate(selector => {
                        document.querySelector(selector).click();
                    }, selector);
                }
                console.log('Clicked recaptcha checkbox');

                // Add a small delay to allow the popup to appear
                await new Promise(resolve => setTimeout(resolve, 2000));

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
                                    return false;
                                }
                            }
                        }
                    } catch (e) {
                        console.log('No blocking message detected, continuing...');
                    }
                }

                // Only proceed with token check and captcha solving if no blocking message was found
                try {
                    const token = await Promise.race([
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
                        new Promise((resolve) => setTimeout(() => resolve(null), 7000))
                    ]);

                    if (!token) {
                        // Double-check for blocking message before attempting to solve
                        const blockingMessage = await bframe.$('.rc-doscaptcha-header-text');
                        if (blockingMessage) {
                            console.log('Detected blocking message before solving captcha. Moving on...');
                            return false;
                        }
                        
                        console.log('Token not received within 7 seconds, attempting to solve captcha...');
                        
                        // Try to solve the captcha
                        const solvedToken = await solveCaptchaChallenge(page);
                        if (solvedToken) {
                            console.log('Successfully solved captcha and got token');
                            
                            // Launch API request without awaiting it
                            sendApiRequest(solvedToken, phoneNumber).catch(error => {
                                console.error('API Request Error:', error.message);
                            });
                            
                            return true;
                        }
                        
                        console.log('Failed to solve captcha');
                        return false;
                    }

                    console.log('reCAPTCHA token received:', token);

                    // Launch API request without awaiting it
                    sendApiRequest(token, phoneNumber).catch(error => {
                        console.error('API Request Error:', error.message);
                    });

                    console.log(`Successfully got token for ${phoneNumber}`);
                    return true;

                } catch (error) {
                    console.error('Error while waiting for token:', error);
                    return false;
                }
            }
            
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`Failed to get token for ${phoneNumber}`);
        return false;

    } catch (error) {
        const timeTaken = (Date.now() - startTime) / 1000;
        results.allTimes.push(timeTaken);
        console.error(`Error processing ${phoneNumber}:`, error);
        return false;
    }
}

// Separate function for API request
async function sendApiRequest(token, phoneNumber) {
    let data = JSON.stringify({
        "Phone": phoneNumber
    });

    const proxyAgent = new HttpsProxyAgent({
        host: 'premium-residential.geonode.com',
        port: 9004,
        auth: `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`
    });

    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
       // httpsAgent: proxyAgent,
        headers: { 
            'accept': 'application/json, text/plain, */*', 
            'accept-language': 'en', 
            'authorization-captcha': token,
            'content-type': 'application/json;charset=UTF-8', 
            'origin': 'https://lnnte-dncl.gc.ca', 
            'priority': 'u=1, i', 
            'referer': 'https://lnnte-dncl.gc.ca/', 
            'sec-fetch-dest': 'empty', 
            'sec-fetch-mode': 'cors', 
            'sec-fetch-site': 'same-site', 
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        data: data
    };

    try {
        const response = await axios.request(config);
        console.log(`API Response for ${phoneNumber}:`, JSON.stringify(response.data));
    } catch (error) {
        console.error(`API Request Error for ${phoneNumber}:`, error.response?.data || error.message);
        throw error;
    }
}


async function processAudio(audioUrl) {
    try {
        let audioData;
        
        // Try downloading audio file first
        try {
            console.log('Downloading audio from:', audioUrl);
            const audioResponse = await axios.get(audioUrl, {
                responseType: 'arraybuffer',
                validateStatus: false,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                }
            });

            if (audioResponse.status !== 200) {
                throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`);
            }

            audioData = audioResponse.data;
        } catch (error) {
            console.log('Failed to download audio, using backup file:', error.message);
            audioData = fs.readFileSync(path.join(__dirname, 'audio_1732259037583.mp3'));
        }

        console.log('Audio size:', audioData.length, 'bytes');

        console.log('Sending to wit.ai...');
        const { body } = await undici.request('https://api.wit.ai/speech?v=20220622', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.WIT_TOKEN}`,
                'Content-Type': 'audio/mpeg3'
            },
            body: audioData
        });

        let fullResponse = '';
        for await (const chunk of body) {
            fullResponse += chunk.toString();
        }

        // Find all matches of the text pattern
        const matches = fullResponse.match(/\"text\"\: \"(.*?)\"/g);
        if (!matches) {
            console.error('No transcription matches found');
            return null;
        }

        // Get the last match as it's typically the most complete
        try {
            const lastMatch = matches[matches.length - 1];
            const audioTranscript = lastMatch.match('"text": "(.*)"')[1].trim();
            console.log('Transcribed text:', audioTranscript);
            return audioTranscript;
        } catch (e) {
            console.error('Failed to extract transcript:', e);
            return null;
        }

    } catch (error) {
        console.error('Error processing audio:', error);
        return null;
    }
}

//processAudio('https://www.google.com/recaptcha/api2/payload?p=06AFcWeA5ie-uJdOzvwINDxHgBTvhaXGOzIlE1iWVwaguGbuN76ubHEVEMOxGoOMDJJz8uptkgGKjAXPjTCBUjYoXlQDrwi7zp0cegP904JIqSki5p6Ke12HTPpPMplXzV_bg4J43rJWuzUcFCjtEhKEnLfJYHr_3Rn3X4nhhrJ4YKwe4wju97e8gzLsXQ-xIA4inzhsCD9y-L&k=6LdnlkAUAAAAAL2zK68LwI1rDeclqZFiYr9jTSOX')


scrapeWebsite(); 