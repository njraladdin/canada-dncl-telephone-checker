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

const ALLOW_PROXY = false;
const PHONE_NUMBER = '514-519-5990';
const proxyUrl = `premium-residential.geonode.com:9009`;
const TOTAL_ATTEMPTS_WANTED = 12; // Set this to your desired number of attempts

// Move results object declaration to the top level, before any function declarations
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
        
        // Calculate estimated time remaining
        const remainingAttempts = TOTAL_ATTEMPTS_WANTED - (this.successful.length + this.failed.length);
        const estimatedSecondsRemaining = remainingAttempts * avgTimeAll;
        const estimatedMinutesRemaining = (estimatedSecondsRemaining / 60).toFixed(1);
        const estimatedHoursRemaining = (estimatedSecondsRemaining / 3600).toFixed(1);
        
        return {
            totalTime: totalTime.toFixed(2),
            avgTimeAll,
            avgTimeSuccess,
            estimatedMinutesRemaining,
            estimatedHoursRemaining
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
        const batchSize = 3;
        const totalBatches = Math.ceil(TOTAL_ATTEMPTS_WANTED / batchSize);
        let globalAttemptCount = 0;
        let completedAttemptCount = 0;  // New counter for completed attempts

        for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
            console.log(`\n=== Starting Batch ${batchNum + 1}/${totalBatches} ===`);
            
            let browser = await launchBrowser();
            console.log('Launched new browser for batch');

            const batchAttempts = Math.min(batchSize, TOTAL_ATTEMPTS_WANTED - globalAttemptCount);
            
            try {
                // Create a Map to track completed attempts in this batch
                const completedAttempts = new Map();
                
                console.log(`Opening ${batchAttempts} pages simultaneously...`);
                const pagePromises = Array(batchAttempts).fill(0).map(async (_, index) => {
                    const page = await browser.newPage();
                    
                    try {
                        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
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
                            consecutiveFailures = 0;
                        } else {
                            results.failed.push(new Date().toISOString());
                            consecutiveFailures++;
                        }

                        // Log progress after each individual completion
                        console.log(`\n=== PROGRESS UPDATE (Completed: ${completedAttemptCount}) ===`);
                        console.log(`Success rate: ${results.getSuccessRate()}%`);
                        console.log(`Total successful tokens: ${results.successful.length}`);
                        console.log(`Failed attempts: ${results.failed.length}`);
                        console.log(`Average time per success: ${results.getTimeStats().avgTimeSuccess} seconds`);
                        console.log(`Remaining attempts: ${TOTAL_ATTEMPTS_WANTED - completedAttemptCount}`);
                        console.log(`Estimated time remaining: ${results.getTimeStats().estimatedHoursRemaining}h (${results.getTimeStats().estimatedMinutesRemaining}m)`);
                        console.log('========================\n');

                    } catch (error) {
                        completedAttemptCount++;
                        console.error(`Error in tab ${index + 1}:`, error);
                        results.failed.push(new Date().toISOString());
                        consecutiveFailures++;
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

                // Update global attempt count after batch complete
                globalAttemptCount += batchAttempts;

                // Log batch summary
                console.log(`\n=== BATCH ${batchNum + 1} COMPLETE ===`);
                console.log(`Total attempts completed: ${completedAttemptCount}/${TOTAL_ATTEMPTS_WANTED}`);
                console.log(`Overall success rate: ${results.getSuccessRate()}%`);
                console.log(`Total successful tokens: ${results.successful.length}`);
                console.log(`Total failed attempts: ${results.failed.length}`);
                console.log(`Remaining attempts: ${TOTAL_ATTEMPTS_WANTED - completedAttemptCount}`);
                console.log('========================\n');

            } finally {
                // Close browser at end of batch
                try {
                    await browser.close().catch(() => {});
                    console.log('Successfully closed browser for batch');
                } catch (e) {
                    console.log('Error closing browser:', e.message);
                }
                
                // Add small delay between batches
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Final results after all attempts
        console.log('\n=== FINAL RESULTS ===');
        const timeStats = results.getTimeStats();
        console.log(`Total Attempts: ${TOTAL_ATTEMPTS_WANTED}`);
        console.log(`Successful tokens: ${results.successful.length}`);
        console.log(`Failed attempts: ${results.failed.length}`);
        console.log(`Final success rate: ${results.getSuccessRate()}%`);
        console.log(`Total time: ${timeStats.totalTime} seconds`);
        console.log(`Average time per success: ${timeStats.avgTimeSuccess} seconds`);
        console.log('===================\n');

    } catch (error) {
        console.error('Fatal error:', error);
    }
}

// Helper function to launch browser with existing configuration
async function launchBrowser() {
    const randomProfile = Math.floor(Math.random() * 10) + 1; // Random number between 1-5
    return await puppeteerExtra.launch({
        headless: "new",
        executablePath: executablePath,
        userDataDir:getDefaultChromeUserDataDir(),// 
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
        // Navigate to the initial page
        console.log(`Loading registration check page...`);
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });

        // Instead of typing and clicking, directly manipulate the Angular state and form
        await page.evaluate((phone) => {
            // Get the Angular scope
            const scope = angular.element(document.querySelector('[ng-show="state==\'number\'"]')).scope();
            
            // Set the phone number in the model
            scope.model = scope.model || {};
            scope.model.phone = phone;
            
            // Update the state to skip to next page
            scope.state = 'confirm';
            
            // Apply the changes
            scope.$apply();
        }, phoneNumber);

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
             
                    await recaptchaFrame.evaluate(selector => {
                        document.querySelector(selector).click();
                    }, selector);
                
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
                            return true;
                        }
                        
                        console.log('Failed to solve captcha');
                        return false;
                    }

                    console.log('reCAPTCHA token received:', token);
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

async function processAudio(audioUrl) {
    try {
        let audioData;
        
        // Download audio file
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


scrapeWebsite(); 