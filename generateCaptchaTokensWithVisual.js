const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const fsSync = require('fs');
const clc = require('cli-color');
const undici = require('undici');
const {GoogleGenerativeAI} = require('@google/generative-ai');

dotenv.config();
// Configuration
const CONCURRENT_BROWSERS = 5;
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

// Add function to analyze image with Gemini
async function analyzeWithGemini(screenshotPath, prompt, gridType) {
    try {
        console.log(`Original prompt: ${prompt}`);
        
        // Extract main challenge text
        const mainPrompt = prompt.split('Click verify once there are none left')[0].trim()
            .replace(/\.$/, '');
        
        console.log(`Processed prompt: ${mainPrompt}`);
        
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        
        // Read screenshot file
        const imageData = await fs.readFile(screenshotPath);
        const imageBase64 = imageData.toString('base64');
        
        // Construct grid description based on type
        const gridDesc = gridType === "4x4" ? 
            `Row 4: [1,1] - [1,2] - [1,3] - [1,4]
             Row 3: [2,1] - [2,2] - [2,3] - [2,4]
             Row 2: [3,1] - [3,2] - [3,3] - [3,4]
             Row 1: [4,1] - [4,2] - [4,3] - [4,4]` :
            `Row 3: [1,1] - [1,2] - [1,3]
             Row 2: [2,1] - [2,2] - [2,3]
             Row 1: [3,1] - [3,2] - [3,3]`;

        const finalPrompt = `For each tile in the grid, check if it contains a VISIBLE -- ${mainPrompt} -- .
If the object is not present in ANY of the tiles, mark ALL tiles as "has_match": false.
Only mark a tile as "has_match": true if you are CERTAIN the object appears in that specific tile.

Respond with a JSON object where each key is the tile coordinate in [row,col] format and the value has a 'has_match' boolean.
Example response format:
{
    "[1,1]": {"has_match": false},
    "[1,2]": {"has_match": true},
    ...
}

Grid layout (row,column coordinates):
${gridDesc}

Important: If ${mainPrompt} does not appear in ANY tile, ALL tiles should have "has_match": false.
Respond ONLY with the JSON object.`;

        const model = genAI.getGenerativeModel({
            model: "gemini-1.5-flash",
            generationConfig: {
                temperature: 0.1,
                topP: 0.95,
                topK: 40,
            }
        });

        const result = await model.generateContent([
            {
                inlineData: {
                    mimeType: "image/png",
                    data: imageBase64
                }
            },
            finalPrompt
        ]);

        const response = result.response.text();
        console.log("\n=== Gemini Response ===");
        console.log(response);
        console.log("=" * 30);

        // Clean up response to extract just the JSON part
        let jsonStr = response;
        if (response.includes('```json')) {
            jsonStr = response.split('```json')[1].split('```')[0].trim();
        } else if (response.includes('```')) {
            jsonStr = response.split('```')[1].split('```')[0].trim();
        }

        // Parse JSON response and extract tiles to click
        const jsonResponse = JSON.parse(jsonStr);
        const tilesToClick = Object.entries(jsonResponse)
            .filter(([_, data]) => data.has_match)
            .map(([coord]) => coord);

        console.log("\n=== Tiles to Click ===");
        console.log(`Found ${tilesToClick.length} tiles to click: ${tilesToClick}`);
        console.log("=" * 30);

        return tilesToClick;

    } catch (error) {
        console.error("\n=== Gemini Analysis Error ===");
        console.error(`Error: ${error.message}`);
        console.error(`Type: ${error.constructor.name}`);
        console.error(`Stack: ${error.stack}`);
        console.error("=" * 30);
        return null;
    }
}

// Update the isDesiredChallenge function with better error handling and selectors
async function isDesiredChallenge(bframe) {
    try {
        // First wait for the element to be present
        await bframe.waitForSelector('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc', {
            timeout: 5000
        });

        const challengeInfo = await bframe.evaluate(() => {
            const desc = document.querySelector('.rc-imageselect-desc-no-canonical') || 
                        document.querySelector('.rc-imageselect-desc');
            
            if (desc) {
                const text = desc.textContent.trim();
                const hasCorrectFormat = text.includes('Select all images with');
                const hasDynamicText = text.includes('Click verify once there are none left');
                
                return {
                    matches: hasCorrectFormat, // Accept all challenges with 'Select all images with'
                    mainText: text,
                    hasCorrectFormat: hasCorrectFormat,
                    hasDynamicText: hasDynamicText
                };
            }
            return { matches: false, mainText: '', hasCorrectFormat: false, hasDynamicText: false };
        });

        console.log("\n=== Challenge Format Check ===");
        console.log(`Full Text: ${challengeInfo.mainText}`);
        console.log(`Has 'Select all images with': ${challengeInfo.hasCorrectFormat}`);
        console.log(`Has dynamic text: ${challengeInfo.hasDynamicText}`);
        console.log(`Matches Requirements: ${challengeInfo.matches}`);
        console.log("=" + "=".repeat(29));

        if (!challengeInfo.matches) {
            console.log("Challenge rejected because:");
            if (!challengeInfo.hasCorrectFormat) {
                console.log("- Does NOT contain 'Select all images with'");
            }
            console.log("=" + "=".repeat(29));
        }

        return challengeInfo.matches;
    } catch (error) {
        console.error('Error checking challenge format:', error);
        return false;
    }
}

// Update the solveCaptchaChallenge function to better match Python implementation
async function solveCaptchaChallenge(page) {
    try {
        // Handle alerts similar to Python version
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

        // Wait for recaptcha frame with retry logic like Python
        let recaptchaFrame = null;
        for (let i = 0; i < 5; i++) {
            const frames = await page.frames();
            console.log(`Attempt ${i + 1} to find reCAPTCHA frame`);
            
            recaptchaFrame = frames.find(frame => {
                const url = frame.url();
                return url.includes('google.com/recaptcha');
            });

            if (recaptchaFrame) {
                console.log('Found recaptcha frame:', recaptchaFrame.url());
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!recaptchaFrame) {
            console.log('Could not find reCAPTCHA frame after retries');
            return null;
        }

        // Wait for checkbox to be clickable with explicit checks
        const checkboxSelector = '#recaptcha-anchor > div.recaptcha-checkbox-border';
        await recaptchaFrame.waitForFunction(
            selector => {
                const element = document.querySelector(selector);
                if (!element) return false;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && 
                       style.visibility !== 'hidden' && 
                       rect.width > 0 && 
                       rect.height > 0;
            },
            { timeout: 10000 },
            checkboxSelector
        );

        // Add small random delay before clicking
        await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 500));

        // Click checkbox
        await recaptchaFrame.click(checkboxSelector);
        console.log('Clicked recaptcha checkbox');

        // Check for immediate token success
        const immediateToken = await page.evaluate(() => {
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
                }, 2000);
            });
        });

        if (immediateToken) {
            console.log('Captcha solved immediately!');
            return immediateToken;
        }

        // Get bframe with retry like Python version
        let bframe = null;
        for (let i = 0; i < 5; i++) {
            const frames = await page.frames();
            bframe = frames.find(frame => frame.url().includes('api2/bframe'));
            if (bframe) {
                console.log('Found bframe:', bframe.url());
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!bframe) {
            console.log('Could not find bframe after retries');
            return null;
        }

        // Wait for challenge elements with better error handling
        try {
            await bframe.waitForSelector('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc', {
                timeout: 5000
            });
        } catch (error) {
            console.log('Challenge description not found:', error);
            return null;
        }

        // Check and refresh for desired challenge type
        const isDesired = await isDesiredChallenge(bframe);
        if (!isDesired) {
            console.log("Challenge does not meet requirements - refreshing...");
            const maxRefreshAttempts = 12;
            for (let i = 0; i < maxRefreshAttempts; i++) {
                const reloadButton = await bframe.$('#recaptcha-reload-button');
                if (reloadButton) {
                    await reloadButton.click();
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    if (await isDesiredChallenge(bframe)) {
                        console.log("Got valid challenge - proceeding...");
                        break;
                    }
                }
                if (i === maxRefreshAttempts - 1) {
                    console.log("Could not get valid challenge after max refresh attempts");
                    return null;
                }
            }
        }

        // Get challenge info with comprehensive checks
        const challengeInfo = await bframe.evaluate(() => {
            const desc = document.querySelector('.rc-imageselect-desc-no-canonical') || 
                        document.querySelector('.rc-imageselect-desc');
            
            if (!desc) {
                throw new Error('Could not find challenge description element');
            }

            let promptText = '';
            const strongElement = desc.querySelector('strong');
            if (strongElement) {
                promptText = strongElement.textContent.trim();
            } else {
                const fullText = desc.textContent.trim();
                const match = fullText.match(/Select all images with (.*?)(?:$|\.|\n)/i);
                if (match) {
                    promptText = match[1].trim();
                }
            }

            const images = document.querySelectorAll('.rc-image-tile-wrapper img');
            if (!images || images.length === 0) {
                throw new Error('No challenge images found');
            }

            return {
                promptText: promptText,
                gridType: images[0].className.includes('33') ? '3x3' : '4x4',
                isDynamic: desc.textContent.includes('Click verify once there are none left')
            };
        });

        // Handle dynamic challenges with iteration limit
        const maxDynamicIterations = 4;
        let dynamicIteration = 0;

        while (true) {
            // First ensure all images are loaded and visible
            await bframe.evaluate(() => {
                return new Promise((resolve) => {
                    const checkImagesLoaded = () => {
                        const images = document.querySelectorAll('.rc-image-tile-33, .rc-image-tile-44');
                        let allLoaded = true;
                        
                        images.forEach(img => {
                            // Check if image is actually loaded and rendered
                            if (!img.complete || img.naturalHeight === 0 || 
                                !img.getBoundingClientRect().width) {
                                allLoaded = false;
                            }
                        });
                        
                        return allLoaded;
                    };

                    // Check immediately
                    if (checkImagesLoaded()) {
                        resolve();
                        return;
                    }

                    // Set up mutation observer to watch for changes
                    const observer = new MutationObserver(() => {
                        if (checkImagesLoaded()) {
                            observer.disconnect();
                            resolve();
                        }
                    });

                    // Watch for changes in the challenge area
                    const target = document.querySelector('.rc-imageselect-challenge');
                    if (target) {
                        observer.observe(target, {
                            attributes: true,
                            childList: true,
                            subtree: true
                        });
                    }

                    // Fallback timeout after 5 seconds
                    setTimeout(() => {
                        observer.disconnect();
                        resolve();
                    }, 5000);
                });
            });

            // Additional wait for any animations to complete
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Take screenshot of just the challenge area
            const challengeArea = await bframe.$('.rc-imageselect-challenge');
            if (!challengeArea) {
                console.log('Could not find challenge area element');
                return null;
            }

            // Add explicit wait for challenge area to be fully rendered
            await bframe.waitForFunction(
                () => {
                    const element = document.querySelector('.rc-imageselect-challenge');
                    if (!element) return false;
                    
                    // Check if element is visible
                    const rect = element.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return false;
                    
                    // Check if images are loaded
                    const images = element.querySelectorAll('img');
                    return Array.from(images).every(img => 
                        img.complete && 
                        img.naturalHeight !== 0 && 
                        window.getComputedStyle(img).display !== 'none'
                    );
                },
                { timeout: 10000 }
            );

            // Additional wait to ensure animations are complete
            await new Promise(resolve => setTimeout(resolve, 1000));

            const timestamp = Date.now();
            const screenshotPath = `captcha_screenshots/challenge_${timestamp}.png`;
            await fs.mkdir('captcha_screenshots', { recursive: true });

            // Take screenshot using the element handle
            await challengeArea.screenshot({
                path: screenshotPath,
                type: 'png',
                omitBackground: false
            });

            // Verify screenshot was captured successfully
            const stats = await fs.stat(screenshotPath);
            if (stats.size < 5000) {
                console.log('Screenshot appears invalid. Debug info:');
                
                // Additional debug info about the challenge area
                const debugInfo = await bframe.evaluate(() => {
                    const element = document.querySelector('.rc-imageselect-challenge');
                    if (!element) return 'Element not found';
                    
                    return {
                        offsetWidth: element.offsetWidth,
                        offsetHeight: element.offsetHeight,
                        clientWidth: element.clientWidth,
                        clientHeight: element.clientHeight,
                        style: window.getComputedStyle(element),
                        imageCount: element.querySelectorAll('img').length,
                        imagesLoaded: Array.from(element.querySelectorAll('img'))
                            .map(img => ({
                                complete: img.complete,
                                naturalHeight: img.naturalHeight,
                                display: window.getComputedStyle(img).display
                            }))
                    };
                });
                console.log('Challenge area debug info:', debugInfo);
                
                // Retry the screenshot after a delay
                await new Promise(resolve => setTimeout(resolve, 2000));
                await challengeArea.screenshot({
                    path: screenshotPath,
                    type: 'png'
                });
            }

            console.log(`\n=== Processing Screenshot ${dynamicIteration + 1}/${maxDynamicIterations} ===`);

            // Analyze with Gemini
            const tilesToClick = await analyzeWithGemini(
                screenshotPath,
                challengeInfo.promptText,
                challengeInfo.gridType
            );

            if (tilesToClick === null) {
                console.log('Failed to get Gemini analysis');
                return null;
            }

            if (tilesToClick.length === 0) {
                console.log('No matching tiles found - proceeding to verify');
                break;
            }

            // Click tiles with proper delays and verification
            for (const coord of tilesToClick) {
                try {
                    // Click the tile
                    await bframe.evaluate((coord, gridType) => {
                        const tiles = document.querySelectorAll('.rc-imageselect-tile');
                        const gridSize = gridType === '3x3' ? 3 : 4;
                        const [row, col] = coord.substring(1, coord.length - 1).split(',').map(Number);
                        
                        // For a 3x3 grid, [3,3] should be index 8 (bottom-right)
                        // For a 4x4 grid, [4,4] should be index 15 (bottom-right)
                        const index = (row - 1) * gridSize + (col - 1);
                        
                        console.log(`Converting coordinate ${coord} to index ${index} in ${gridSize}x${gridSize} grid`);
                        if (tiles[index]) {
                            tiles[index].click();
                            return true;
                        }
                        return false;
                    }, coord, challengeInfo.gridType);
                } catch (error) {
                    console.error(`Error clicking tile ${coord}:`, error);
                }
            }

            if (!challengeInfo.isDynamic) break;

            // Much longer wait for dynamic challenges before next screenshot
            const dynamicWaitTime = 8000; // 8 seconds base wait time for dynamic challenges
            await new Promise(resolve => setTimeout(resolve, dynamicWaitTime + Math.random() * 2000));

            dynamicIteration++;
            if (dynamicIteration >= maxDynamicIterations) {
                console.log(`Reached maximum dynamic iterations (${maxDynamicIterations})`);
                break;
            }
        }

        // Add a longer delay before clicking verify (1-2 seconds)
        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

        // Click verify and wait for response
        try {
            let retryCount = 0;
            const maxRetries = 3;  // Maximum number of times to retry the entire challenge

            while (retryCount < maxRetries) {
                const verifyButton = await bframe.$('#recaptcha-verify-button');
                
                // Ensure verify button is clickable
                await bframe.evaluate(() => {
                    const button = document.querySelector('#recaptcha-verify-button');
                    if (button && !button.disabled && window.getComputedStyle(button).display !== 'none') {
                        return true;
                    }
                    throw new Error('Verify button not ready');
                });
                
                await verifyButton.click();
                
                // Wait longer for the response (5-7 seconds)
                await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 2000));

                // Check for token
                const token = await page.evaluate(() => {
                    const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                    return textarea ? textarea.value : null;
                });

                if (token) {
                    console.log('Challenge solved successfully!');
                    return token;
                }

                // If we reach here, no token was received
                console.log(`Verification attempt ${retryCount + 1} failed. Checking for new challenge...`);
                
                // Check if challenge is still present
                const challengePresent = await bframe.$('.rc-imageselect-challenge');
                if (challengePresent) {
                    console.log('Challenge still present. Retrying with new screenshot...');
                    
                    // Add longer delay for subsequent screenshots (3-5 seconds)
                    const extraDelay = (retryCount + 1) * 2000;  // Increases with each retry
                    const baseDelay = challengeInfo.isDynamic ? 6000 : 3000; // Double the base delay for dynamic challenges
                    await new Promise(resolve => setTimeout(resolve, baseDelay + Math.random() * 2000 + extraDelay));
                    
                    // Get fresh reference to challenge area
                    const newChallengeArea = await bframe.$('.rc-imageselect-challenge');
                    if (!newChallengeArea) {
                        console.log('Could not find challenge area element for retry');
                        retryCount++;
                        continue;
                    }

                    // Wait for images to be fully loaded
                    await bframe.waitForFunction(
                        () => {
                            const element = document.querySelector('.rc-imageselect-challenge');
                            if (!element) return false;
                            
                            const images = element.querySelectorAll('img');
                            return Array.from(images).every(img => 
                                img.complete && 
                                img.naturalHeight !== 0 && 
                                window.getComputedStyle(img).display !== 'none'
                            );
                        },
                        { timeout: 10000 }
                    );

                    // Take new screenshot and analyze
                    const timestamp = Date.now();
                    const screenshotPath = `captcha_screenshots/challenge_retry_${timestamp}.png`;
                    
                    await newChallengeArea.screenshot({
                        path: screenshotPath,
                        type: 'png',
                        omitBackground: false
                    });

                    const tilesToClick = await analyzeWithGemini(
                        screenshotPath,
                        challengeInfo.promptText,
                        challengeInfo.gridType
                    );

                    if (tilesToClick === null) {
                        console.log('Failed to get Gemini analysis on retry');
                        retryCount++;
                        continue;
                    }

                    if (tilesToClick.length === 0) {
                        console.log('No matching tiles found on retry - proceeding to verify');
                    } else {
                        // Click new tiles
                        for (const coord of tilesToClick) {
                            try {
                                await bframe.evaluate((coord, gridType) => {
                                    const tiles = document.querySelectorAll('.rc-imageselect-tile');
                                    const gridSize = gridType === '3x3' ? 3 : 4;
                                    const [row, col] = coord.substring(1, coord.length - 1).split(',').map(Number);
                                    const index = (row - 1) * gridSize + (col - 1);
                                    console.log(`Converting coordinate ${coord} to index ${index} in ${gridSize}x${gridSize} grid`);
                                    if (tiles[index]) {
                                        tiles[index].click();
                                        return true;
                                    }
                                    return false;
                                }, coord, challengeInfo.gridType);
                            } catch (error) {
                                console.error(`Error clicking tile ${coord}:`, error);
                            }
                        }
                    }
                } else {
                    console.log('Challenge no longer present but no token received. Moving to next retry...');
                }

                retryCount++;
                if (retryCount >= maxRetries) {
                    console.log(`Reached maximum retries (${maxRetries}). Challenge failed.`);
                    break;
                }
            }

            console.log('Challenge failed - no token received after all retries');
            return null;

        } catch (error) {
            console.error('Error during verification:', error);
            return null;
        }

    } catch (error) {
        console.error('Error in solveCaptcha:', error);
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
    generateTokens(5, eventManager)
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
