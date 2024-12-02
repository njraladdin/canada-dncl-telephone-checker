const express = require('express');
const ip = require('ip');
const path = require('path');
const renderProcessingPage = require('./progress/renderProcessingPage');
const DatabaseManager = require('./db/DatabaseManager');
const extractCaptchaTokens2Captcha = require('./captcha/generateCaptchaTokensWith2Captcha');
const extractCaptchaTokensAudio = require('./captcha/generateCaptchaTokensWithAudio');

// Configuration
const CAPTCHA_METHOD = 'audio'; // Method to solve captcha: '2captcha' (paid service) or 'audio' (transcribe audio challenge)
const DATA_SOURCE = './data/numbers.db'; // This can be either an SQLite .db file or a .json file. Both should include a 'telephone' column
const app = express();

app.get('/', async (req, res) => {
    try {
        const html = await renderProcessingPage(req.app.locals.db, req);
        res.send(html);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
    }
});

async function startApplication(inputPath = DATA_SOURCE) {
    const dbManager = new DatabaseManager(inputPath);
    await dbManager.init();
    
    app.locals.db = dbManager;

    app.listen(5000, () => {
        console.log('\n=== Progress Server Running ===');
        console.log(`Local:   http://localhost:${5000}`);
        console.log(`Network: http://${ip.address()}:${5000}`);
        console.log('===========================\n');
    });

    console.log(`Starting DNCL processing using ${CAPTCHA_METHOD} method...`);
    
    try {
        if (CAPTCHA_METHOD === '2captcha') {
            await extractCaptchaTokens2Captcha(dbManager);
        } else if (CAPTCHA_METHOD === 'audio') {
            await extractCaptchaTokensAudio(dbManager);
        } else {
            throw new Error(`Invalid CAPTCHA_METHOD: ${CAPTCHA_METHOD}. Must be either '2captcha' or 'audio'`);
        }

        // After processing is complete, convert to CSV
        console.log('DNCL processing completed. Converting results to CSV...');
        const outputPath = await dbManager.convertToCSV();
        console.log('CSV conversion completed. Results saved to:', outputPath);

    } catch (error) {
        console.error('Fatal error in DNCL processing:', error);
        await dbManager.close();
        process.exit(1);
    }
}

if (require.main === module) {
    startApplication(process.env.DB_PATH).catch(error => {
        console.error('Fatal error starting application:', error);
        process.exit(1);
    });
}