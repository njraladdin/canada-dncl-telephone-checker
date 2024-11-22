const extractCapchaTokens = require('./extractCapchaTokens');
const sendDNCLRequest = require('./sendDNCLRequest');
const sqlite3 = require('sqlite3').verbose();
const EventEmitter = require('events');
const clc = require('cli-color');

// Create token manager to handle communication between modules
const tokenManager = new EventEmitter();
let tokenQueue = [];

// Initialize database
const db = new sqlite3.Database('./engineers.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
        return;
    }
});

// Add more robust event listener setup
console.log('Setting up tokenExtracted event listener...');
tokenManager.removeAllListeners('tokenExtracted'); // Clear any existing listeners
tokenManager.on('tokenExtracted', async (token) => {
    try {
        console.log(
            clc.green.bold('\n=== NEW TOKEN RECEIVED IN MAIN ===\n') +
            clc.cyan('Token: ') + clc.yellow(token.slice(0, 50)+'...') +
            clc.cyan('\nQueue Size: ') + clc.yellow(tokenQueue.length + 1) + 
            '\n'
        );
        tokenQueue.push(token);
        await processNextRequest();
    } catch (error) {
        console.error('Error processing received token:', error);
    }
});

// Add error handler
tokenManager.on('error', (error) => {
    console.error('TokenManager error:', error);
});


async function getUnprocessedCount() {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT COUNT(*) as count 
            FROM engineers 
            WHERE DNCL_status IS NULL 
            AND telephone IS NOT NULL
            AND phone_type = 'MOBILE'
        `, (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
        });
    });
}

// Add at the top with other global variables
let startTime = null;
let processedCount = 0;
let totalInitialCount = 0;

// Process DNCL requests using available tokens
async function processNextRequest() {
    if (tokenQueue.length === 0) {
        // Get count of remaining numbers to process
        const remainingCount = await getUnprocessedCount();
        if (remainingCount === 0) {
            console.log('No more numbers to process');
            return;
        }
        
        // Just return and wait for more tokens to arrive via the event emitter
        return;
    }

    // Get next phone number from database that needs processing
    db.get(`
        SELECT id, telephone 
        FROM engineers 
        WHERE DNCL_status IS NULL 
        AND telephone IS NOT NULL 
        AND phone_type = 'MOBILE'
        LIMIT 1
    `, async (err, row) => {
        if (err) {
            console.error('Database error:', err);
            return;
        }

        if (!row) {
            console.log('No more numbers to process');
            return;
        }

        const token = tokenQueue.shift();
        try {
            console.log(`\x1b[36mSending DNCL request for phone number: ${row.telephone}\x1b[0m`);
            const result = await sendDNCLRequest(row.telephone, token);
            console.log(result);
            
            if (result.status === 'INVALID') {
                db.run(`
                    UPDATE engineers 
                    SET DNCL_status = 'INVALID'
                    WHERE id = ?
                `, [row.id]);
                console.log(`Marked ${row.telephone} as INVALID due to invalid area code`);
            } else if (result.status === 'ERROR') {
                db.run(`
                    UPDATE engineers 
                    SET DNCL_status = 'ERROR'
                    WHERE id = ?
                `, [row.id]);
                console.log(`Marked ${row.telephone} as ERROR due to: ${result.error}`);
            } else {
                // Handle normal successful response
                db.run(`
                    UPDATE engineers 
                    SET DNCL_status = ?, 
                        DNCL_registration_date = ? 
                    WHERE id = ?
                `, [
                    result.Active ? 'ACTIVE' : 'INACTIVE', 
                    result.Active ? result.AddedAt : null, 
                    row.id
                ]);
            }

            // Update progress tracking
            processedCount++;
            const remainingCount = await getUnprocessedCount();
            const percentComplete = ((processedCount / totalInitialCount) * 100).toFixed(2);
            
            // Calculate actual average time per request
            const elapsedMs = Date.now() - startTime;
            const avgTimePerRequest = elapsedMs / processedCount;
            
            // Calculate estimated time remaining based on actual average
            const estimatedMsRemaining = avgTimePerRequest * remainingCount;
            const estimatedHours = Math.floor(estimatedMsRemaining / (3600000));
            const estimatedMinutes = Math.floor((estimatedMsRemaining % 3600000) / 60000);
            const estimatedSeconds = Math.floor((estimatedMsRemaining % 60000) / 1000);

            // Format time string based on duration
            const timeRemaining = estimatedHours > 0 
                ? `${estimatedHours}h ${estimatedMinutes}m`
                : `${estimatedMinutes}m ${estimatedSeconds}s`;

            console.log(
                clc.green.bold('\n=== PROGRESS UPDATE ===\n') +
                clc.cyan('Progress: ') + clc.yellow(`${percentComplete}%`) +
                clc.cyan('\nNumbers Remaining: ') + clc.yellow(remainingCount) +
                clc.cyan('\nAvg Time Per Number: ') + clc.yellow(`${(avgTimePerRequest / 1000).toFixed(1)}s`) +
                clc.cyan('\nEstimated Time Remaining: ') + clc.yellow(timeRemaining) +
                '\n'
            );

            // Process next request
            processNextRequest();
        } catch (error) {
            console.error('Error processing DNCL request:', error.message);
            processNextRequest();
        }
    });
}

// Start the process
if (require.main === module) {
    getUnprocessedCount()
        .then(count => {
            if (count > 0) {
                startTime = Date.now();
                totalInitialCount = count;
                console.log(
                    clc.green.bold('\n=== STARTING DNCL PROCESSING ===\n') +
                    clc.cyan('Numbers to process: ') + clc.yellow(count) +
                    '\n'
                );
                return extractCapchaTokens(count, tokenManager);
            }
        })
        .catch(error => {
            console.error('Error starting process:', error);
        });
}
