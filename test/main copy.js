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

// Add this helper function to get the default Chrome profile path
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
        const browser = await puppeteerExtra.launch({
            headless: false,
         //   executablePath: executablePath,
          //  userDataDir: getDefaultChromeUserDataDir(),
            args: [
                '--no-sandbox',
                '--disable-gpu',
                '--enable-webgl',
                '--window-size=1920,1080',

            ],
            ignoreDefaultArgs: [
                '--enable-automation',
                '--enable-blink-features=AutomationControlled',
                '--disable-extensions'
            ],
            defaultViewport: null,
        });

        console.log('Opening initial page...');
        const page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        if (ALLOW_PROXY) {
            await page.authenticate({
                username: process.env.PROXY_USERNAME,
                password: process.env.PROXY_PASSWORD
            });
        }

        // Navigate directly to registration check page
        console.log('Loading registration check page...');
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', {
            waitUntil: 'domcontentloaded'
        });

    } catch (error) {
        console.error('An error occurred:', error);
    }
}

scrapeWebsite(); 