const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const os = require('os');
const path = require('path');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');
const dotenv = require('dotenv');
const undici = require('undici');
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

function getDefaultChromeUserDataDir() {
    if (/^win/i.test(osPlatform)) {
        return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    } else if (/^darwin/i.test(osPlatform)) {  // macOS
        return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
    } else {  // Linux
        return path.join(os.homedir(), '.config', 'google-chrome');
    }
}

async function solveCaptcha(page) {
    function rdn(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    try {
        // console.log('Waiting for recaptcha iframe to load...');
        // await page.waitForFunction(() => {
        //     const iframe = document.querySelector('iframe[src*="api2/anchor"]');
        //     if (!iframe) return false;
        //     return !!iframe.contentWindow.document.querySelector('#recaptcha-anchor');
        // });
        // console.log('Recaptcha iframe found');

        // let frames = await page.frames();
        // const recaptchaFrame = frames.find(frame => frame.url().includes('api2/anchor'));
        // console.log('Found recaptcha frame:', !!recaptchaFrame);

        // const checkbox = await recaptchaFrame.$('#recaptcha-anchor');
        // console.log('Found checkbox:', !!checkbox);
        // await checkbox.click({ delay: rdn(30, 150) });
        // console.log('Clicked checkbox');

        console.log('Waiting for challenge...');
        const challenge = await page.waitForFunction(() => {
            // Log the current state for debugging
            const anchorIframe = document.querySelector('iframe[src*="api2/anchor"]');
            const bframe = document.querySelector('iframe[src*="api2/bframe"]');
            console.log('Anchor iframe present:', !!anchorIframe);
            console.log('Bframe present:', !!bframe);
            
            if (!bframe) return false;
            
            try {
                // Check if the bframe has loaded
                const bframeContent = bframe.contentWindow.document;
                console.log('Bframe content accessible:', !!bframeContent);
                
                // Check for either image or audio challenge
                const hasImageChallenge = !!bframeContent.querySelector('.rc-image-tile-wrapper');
                const hasAudioChallenge = !!bframeContent.querySelector('.rc-audiochallenge-tdownload-link');
                console.log('Has image challenge:', hasImageChallenge);
                console.log('Has audio challenge:', hasAudioChallenge);
                
                return hasImageChallenge || hasAudioChallenge;
            } catch (e) {
                console.log('Error accessing bframe content:', e.message);
                return false;
            }
        }, { timeout: 15000 });

        if (!challenge) {
            console.log('No challenge appeared');
            return;
        }
        console.log('Challenge detected');

        frames = await page.frames();
        const imageFrame = frames.find(frame => frame.url().includes('api2/bframe'));
        console.log('Found image frame:', !!imageFrame);

        const audioButton = await imageFrame.$('#recaptcha-audio-button');
        console.log('Found audio button:', !!audioButton);
        await audioButton.click({ delay: rdn(30, 150) });
        console.log('Clicked audio button');

        while (true) {
            try {
                console.log('Waiting for audio challenge...');
                await page.waitForFunction(() => {
                    const iframe = document.querySelector('iframe[src*="api2/bframe"]');
                    if (!iframe) return false;
                    return !!iframe.contentWindow.document.querySelector('.rc-audiochallenge-tdownload-link');
                }, { timeout: 15000 });
                console.log('Audio challenge appeared');

                const audioLink = await page.evaluate(() => {
                    const iframe = document.querySelector('iframe[src*="api2/bframe"]');
                    return iframe.contentWindow.document.querySelector('#audio-source').src;
                });
                console.log('Got audio link:', !!audioLink);

                console.log('Downloading audio...');
                const audioBytes = await page.evaluate(audioLink => {
                    return (async () => {
                        const response = await window.fetch(audioLink);
                        const buffer = await response.arrayBuffer();
                        return Array.from(new Uint8Array(buffer));
                    })();
                }, audioLink);
                console.log('Audio downloaded, size:', audioBytes.length);

                console.log('Sending to wit.ai...');
                const response = await undici.fetch('https://api.wit.ai/speech?v=20220622', {
                    method: 'POST',
                    body: new Uint8Array(audioBytes),
                    headers: {
                        Authorization: 'Bearer JVHWCNWJLWLGN6MFALYLHAPKUFHMNTAC',
                        'Content-Type': 'audio/mpeg3'
                    }
                }).then((res) => res.text());
                console.log('Wit.ai response:', response);

                let audioTranscript = null;

                try {
                    audioTranscript = response.match('"text": "(.*)",')[1].trim();
                    console.log('Transcribed text:', audioTranscript);
                } catch (e) {
                    console.log('Failed to extract transcript, reloading...');
                    const reloadButton = await imageFrame.$('#recaptcha-reload-button');
                    await reloadButton.click({ delay: rdn(30, 150) });
                    continue;
                }

                const input = await imageFrame.$('#audio-response');
                console.log('Found input field:', !!input);
                await input.click({ delay: rdn(30, 150) });
                await input.type(audioTranscript, { delay: rdn(30, 75) });
                console.log('Entered transcript');

                const verifyButton = await imageFrame.$('#recaptcha-verify-button');
                console.log('Found verify button:', !!verifyButton);
                await verifyButton.click({ delay: rdn(30, 150) });
                console.log('Clicked verify');

                try {
                    console.log('Waiting for verification result...');
                    await page.waitForFunction(() => {
                        const iframe = document.querySelector('iframe[src*="api2/anchor"]');
                        if (iframe == null || !!iframe.contentWindow.document.querySelector('#recaptcha-anchor[aria-checked="true"]')) {
                            return true;
                        }
                    }, { timeout: 15000 });

                    console.log('Captcha appears to be solved, getting token...');
                    return page.evaluate(() => document.getElementById('g-recaptcha-response').value);
                } catch (e) {
                    console.log('Verification failed, retrying...');
                    continue;
                }
            } catch (e) {
                console.error('Error in audio challenge loop:', e);
                continue;
            }
        }
    } catch (e) {
        console.error('Fatal error in solveCaptcha:', e);
    }
}

async function scrapeWebsite() {
    try {
        const browser = await puppeteerExtra.launch({
            headless: false,
            executablePath: executablePath,
            userDataDir: './chrome-data3',//getDefaultChromeUserDataDir(),
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
                `--profile-directory=Profile 1`,
                ALLOW_PROXY ? `--proxy-server=premium-residential.geonode.com:9004` : ''
            ].filter(Boolean),
            ignoreDefaultArgs: [
                '--enable-automation',
                '--enable-blink-features=AutomationControlled'
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

        // Navigate to recaptcha demo page
        console.log('Loading registration check page...');
        await page.goto('https://www.google.com/recaptcha/api2/demo', {
            waitUntil: 'domcontentloaded'
        });

        // Solve the captcha
        console.log('Attempting to solve captcha...');
        const captchaToken = await solveCaptcha(page);
        if (captchaToken) {
            console.log('Captcha solved successfully!');
            console.log('Token:', captchaToken);
        } else {
            console.log('Failed to solve captcha');
        }

    } catch (error) {
        console.error('An error occurred:', error);
    }
}

module.exports = solveCaptcha;

if (require.main === module) {
    scrapeWebsite();
} 