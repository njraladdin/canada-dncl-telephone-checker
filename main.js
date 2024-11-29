const express = require('express');
const EventEmitter = require('events');
const generateCaptchaTokensWith2Captcha = require('./generateCaptchaTokensWith2Captcha');
const generateCaptchaTokensWithAudio = require('./generateCaptchaTokensWithAudio');
const generateCaptchaTokensWithVisual = require('./generateCaptchaTokensWithVisual');
const { sendDNCLRequest } = require('./sendDNCLRequest');
const DatabaseManager = require('./DatabaseManager');
const renderProcessingPage = require('./renderProcessingPage');
const ip = require('ip');
const clc = require('cli-color');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration
const BATCH_SIZE = 6;
const PORT = 5000;
const CAPTCHA_METHOD = '2captcha'; // '2captcha', 'audio', or 'visual'

// Core processing functions
async function processBatch(db, numbers, statsTracker) {
    const eventManager = new EventEmitter();
    
    eventManager.on('tokenGenerated', async ({ token }) => {
        const number = numbers.shift();
        if (number) {
            await processNumber(db, number, token);
            await statsTracker.updateStats(db);
        }
    });

    eventManager.on('tokenError', ({ error }) => console.error('Token error:', error));

    try {
        let generateTokens;
        switch (CAPTCHA_METHOD) {
            case 'audio':
                generateTokens = generateCaptchaTokensWithAudio;
                break;
            case 'visual':
                generateTokens = generateCaptchaTokensWithVisual;
                break;
            case '2captcha':
                generateTokens = generateCaptchaTokensWith2Captcha;
                break;
            default:
                throw new Error(`Unknown CAPTCHA method: ${CAPTCHA_METHOD}`);
        }

        await generateTokens(numbers.length, eventManager);
        
        if (numbers.length > 0) {
            console.error(`${numbers.length} numbers remained unprocessed`);
        }
    } catch (error) {
        console.error('Error in batch processing:', error);
        throw error;
    }
}

async function processNumber(db, number, token) {
    try {
        const result = await sendDNCLRequest(number.telephone, token);
        await db.updateNumberStatus(number.id, result.status, result.registrationDate);
    } catch (error) {
        console.error(`Error processing ${number.telephone}:`, error);
        await db.updateNumberStatus(number.id, 'ERROR', null);
    }
}

async function processAllNumbers(db, statsTracker) {
    while (true) {
        const numbers = await db.getNextBatch(BATCH_SIZE);
        if (numbers.length === 0) break;
        await processBatch(db, numbers, statsTracker);
    }
}

// Start everything
async function start() {
    const methodInfo = {
        'audio': 'Audio Recognition',
        'visual': 'Visual AI (Gemini)',
        '2captcha': '2Captcha Service'
    };

    console.log(`\n=== Using ${methodInfo[CAPTCHA_METHOD]} for CAPTCHA solving ===\n`);
    
    if (CAPTCHA_METHOD === 'visual' && !process.env.GEMINI_API_KEY) {
        throw new Error('GEMINI_API_KEY is required for visual CAPTCHA solving');
    }
    
    const db = new DatabaseManager();
    await db.init();
    await db.resetProcessingStatus();
    const statsTracker = new StatsTracker();

    try {
        await processAllNumbers(db, statsTracker);
        
        const errorCount = await db.resetErrorStatus();
        if (errorCount > 0) {
            console.log(`\n=== Final Retry Phase ===`);
            console.log(`Retrying ${errorCount} failed numbers...`);
            console.log(`=====================\n`);
            await processAllNumbers(db, statsTracker);
        }
    } finally {
        await db.close();
    }
}

// Web server setup
const app = express();

app.get('/', async (req, res) => {
    const db = new DatabaseManager();
    try {
        await db.init();
        const html = await renderProcessingPage(db, req);
        res.send(html);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send('Internal Server Error');
    } finally {
        if (db) {
            await db.close();
        }
    }
});

// Start application
if (require.main === module) {
    app.listen(PORT, () => {
        console.log('\n=== Progress Server Running ===');
        console.log(`Local:   http://localhost:${PORT}`);
        console.log(`Network: http://${ip.address()}:${PORT}`);
        console.log('===========================\n');
    });

    start().catch(error => {
        console.error('Fatal error in DNCL processing:', error);
    });
}

// Add the StatsTracker class
class StatsTracker {
    constructor() {
        this.startTime = Date.now();
        this.processedCount = 0;
        this.lastBackupTime = Date.now();
        this.BACKUP_INTERVAL = 10 * 60 * 1000; // 10 minutes in milliseconds
    }

    async gitBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            await execPromise('git add numbers.db');
            await execPromise(`git commit -m "Auto-backup numbers.db at ${timestamp}"`);
            await execPromise('git push');
            console.log(clc.green('\n✓ Database backed up to Git successfully\n'));
        } catch (error) {
            console.error(clc.red('\n✗ Git backup failed:'), error.message, '\n');
        }
    }

    async updateStats(db) {
        this.processedCount++;
        
        // Check if it's time for a backup
        const currentTime = Date.now();
        if (currentTime - this.lastBackupTime >= this.BACKUP_INTERVAL) {
            await this.gitBackup();
            this.lastBackupTime = currentTime;
        }
        
        // Calculate time stats
        const elapsedSeconds = (Date.now() - this.startTime) / 1000;
        const avgSecondsPerNumber = elapsedSeconds / this.processedCount;
        
        // Get remaining count from DB
        const remaining = await db.getDb().get(`
            SELECT COUNT(*) as count
            FROM numbers 
            WHERE (dncl_status IS NULL OR dncl_status = '')
            AND telephone IS NOT NULL 
            AND phone_type = 'MOBILE'
        `);
        
        // Calculate ETA
        const estimatedSecondsLeft = remaining.count * avgSecondsPerNumber;
        const hoursLeft = Math.floor(estimatedSecondsLeft / 3600);
        const minutesLeft = Math.floor((estimatedSecondsLeft % 3600) / 60);
        
        console.log('\n=== Processing Stats ===');
        console.log(`Processed: ${clc.green(this.processedCount)} numbers`);
        console.log(`Average Time: ${clc.cyan(avgSecondsPerNumber.toFixed(2))}s per number`);
        console.log(`Remaining: ${clc.yellow(remaining.count)} numbers`);
        console.log(`ETA: ${clc.magenta(`${hoursLeft}h ${minutesLeft}m`)}`);
        console.log('=====================\n');
    }
}
