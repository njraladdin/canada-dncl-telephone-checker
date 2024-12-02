const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const clc = require('cli-color');

class DatabaseManager {
    constructor(dbPath = './numbers.db') {
        this.dbPath = dbPath;
    }

    async init() {
        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });
    }

    async getNextBatch(batchSize) {
        console.log(`Fetching next batch of ${batchSize} numbers...`);
        
        const numbers = await this.db.all(`
            UPDATE numbers 
            SET dncl_status = 'PROCESSING'
            WHERE id IN (
                SELECT id 
                FROM numbers 
                WHERE (dncl_status IS NULL OR dncl_status = '')
                AND telephone IS NOT NULL 
                AND phone_type = 'MOBILE'
                LIMIT ?
            )
            RETURNING id, telephone
        `, batchSize);

        if (numbers.length > 0) {
            console.log(`Found ${numbers.length} numbers to process`);
        }
        
        return numbers;
    }

    async updateNumberStatus(id, status, registrationDate = null) {
        const currentTime = new Date().toISOString();
        console.log(`\n=== Database Update ===`);
        console.log(`ID: ${id}`);
        console.log(`Status: ${status}`);
        console.log(`Registration Date: ${registrationDate || 'N/A'}`);
        console.log(`Update Time: ${currentTime}`);
        console.log('====================\n');

        try {
            await this.db.run(`
                UPDATE numbers 
                SET 
                    dncl_status = ?,
                    dncl_registration_date = ?,
                    dncl_checked_at = ?
                WHERE id = ?
            `, [status, registrationDate, currentTime, id]);
        } catch (error) {
            console.error(`Database update failed for ID ${id}:`, error.message);
            throw error;
        }
    }

    async resetProcessingStatus() {
        await this.db.run(`
            UPDATE numbers 
            SET dncl_status = NULL 
            WHERE dncl_status = 'PROCESSING'
        `);
    }

    async resetErrorStatus() {
        console.log('\nResetting ERROR status numbers for retry...');
        const result = await this.db.run(`
            UPDATE numbers 
            SET dncl_status = NULL 
            WHERE dncl_status = 'ERROR'
        `);
        const errorCount = await this.db.get(`
            SELECT COUNT(*) as count 
            FROM numbers 
            WHERE dncl_status = 'ERROR'
        `);
        console.log(`Reset ${errorCount.count} numbers with ERROR status\n`);
        return errorCount.count;
    }

    async close() {
        if (this.db) {
            await this.db.close();
        }
    }

    // Helper method to get database connection for other uses
    getDb() {
        return this.db;
    }
}

module.exports = DatabaseManager; 