const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const dotenv = require('dotenv');
dotenv.config();

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
const TEST_PHONE_NUMBER = '418-313-3337';
const proxyUrl = `http://${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}@premium-residential.geonode.com:9004`;

async function scrapeWebsite() {
    try {
        const browser = await puppeteerExtra.launch({
            headless: true,
            executablePath: executablePath,
            userDataDir: path.join(process.cwd(), 'chrome-data'),
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--enable-webgl',
                '--window-size=1920,1080',
                `--proxy-server=premium-residential.geonode.com:9004`,
            ],
        });

        const page = await browser.newPage();
        
        // Set a more realistic user agent
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        if (ALLOW_PROXY) {
            await page.authenticate({
                username: process.env.PROXY_USERNAME,
                password: process.env.PROXY_PASSWORD
            });
        }

        try {
            await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
                waitUntil: 'domcontentloaded'
            });

            // Wait for phone input and type number
            await page.waitForSelector('#phone');
            await page.type('#phone', TEST_PHONE_NUMBER, { delay: 100 });
            console.log('Entered phone number');

            // Instead of clicking submit, inject state change
            await page.evaluate(() => {
                const element = document.querySelector('.sub-section.ng-scope');
                const $scope = angular.element(element).scope();
                $scope.$apply(() => {
                    $scope.state = 'confirm';
                });
            });
            console.log('Skipped to captcha page using state manipulation');

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
                
                recaptchaFrame = frames.find(frame => {
                    const frameUrl = frame.url();
                   // console.log('Checking frame:', frameUrl);
                    return frameUrl.includes('google.com/recaptcha');
                });

                if (recaptchaFrame) {
                    console.log('Found recaptcha frame:', recaptchaFrame.url());
                    
                    // Wait for checkbox to be visible
                    await recaptchaFrame.waitForSelector('#recaptcha-anchor > div.recaptcha-checkbox-border', {
                        visible: true,
                        timeout: 10000
                    });
                    
                    // Wait 3 seconds before clicking
                    console.log('Waiting 3 seconds before clicking...');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    
                    await recaptchaFrame.click('#recaptcha-anchor > div.recaptcha-checkbox-border');
                    console.log('Clicked recaptcha checkbox');

                    // Wait for the token to be generated (after solving the captcha)
                    await page.waitForFunction(() => {
                        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                        return textarea && textarea.value;
                    }, { timeout: 30000 });

                    // Get the token
                    const token = await page.evaluate(() => {
                        return document.querySelector('textarea[name="g-recaptcha-response"]').value;
                    });

                    console.log('reCAPTCHA token:', token);

                    // After getting the token, make the API request
                    let data = JSON.stringify({
                        "Phone": TEST_PHONE_NUMBER
                    });

                    // Create proxy agent with env variables
                    const proxyAgent = new HttpsProxyAgent({
                        host: 'premium-residential.geonode.com',
                        port: 9004,
                        auth: `${process.env.PROXY_USERNAME}:${process.env.PROXY_PASSWORD}`
                    });

                    let config = {
                        method: 'post',
                        maxBodyLength: Infinity,
                        url: 'https://public-api.lnnte-dncl.gc.ca/v1/Consumer/Check',
                        httpsAgent: proxyAgent, // Add the proxy agent
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
                        console.log('API Response:', JSON.stringify(response.data));
                    } catch (error) {
                        console.error('API Request Error:', error.response?.data || error.message);
                    }

                    break;
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log('Process completed, waiting...');
            
        } catch (error) {
            console.error('Error in tab:', error);
        }

    } catch (error) {
        console.error('An error occurred:', error);
    }
}

scrapeWebsite(); 