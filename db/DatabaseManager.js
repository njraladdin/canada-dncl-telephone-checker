const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const clc = require('cli-color');
const fs = require('fs');
const path = require('path');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

class DatabaseManager {
    constructor(inputPath = './data/numbers.db') {
        this.inputPath = inputPath;
        this.dbPath = inputPath.endsWith('.json') 
            ? inputPath.replace('.json', '.db')
            : inputPath;
    }

    async init() {
        // If input is JSON, convert to SQLite if needed
        if (this.inputPath.endsWith('.json')) {
            await this.handleJsonInput();
        }

        this.db = await open({
            filename: this.dbPath,
            driver: sqlite3.Database
        });

        // Verify telephone column exists
        const hasRequiredStructure = await this.verifyDatabaseStructure();
        if (!hasRequiredStructure) {
            throw new Error('Database must contain a "telephone" column');
        }
        
        await this.ensureColumns();
    }

    async handleJsonInput() {
        // Skip if DB file already exists
        if (fs.existsSync(this.dbPath)) {
            console.log(clc.yellow(`[DB] Using existing database: ${this.dbPath}`));
            return;
        }

        console.log(clc.yellow(`[DB] Converting JSON to SQLite database: ${this.inputPath} -> ${this.dbPath}`));
        
        try {
            const jsonData = JSON.parse(fs.readFileSync(this.inputPath, 'utf8'));
            if (!Array.isArray(jsonData)) {
                throw new Error('JSON file must contain an array of records');
            }

            // Create temporary db connection
            const tempDb = await open({
                filename: this.dbPath,
                driver: sqlite3.Database
            });

            // Create table based on first record structure
            if (jsonData.length > 0) {
                const columns = Object.keys(jsonData[0]);
                if (!columns.includes('telephone')) {
                    throw new Error('JSON data must contain a "telephone" field');
                }

                const columnDefs = columns.map(col => 
                    `${col} ${col === 'telephone' ? 'TEXT' : 'TEXT'}`
                ).join(', ');

                await tempDb.exec(`
                    CREATE TABLE numbers (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        ${columnDefs}
                    )
                `);

                // Insert data
                const placeholders = columns.map(() => '?').join(', ');
                const stmt = await tempDb.prepare(`
                    INSERT INTO numbers (${columns.join(', ')})
                    VALUES (${placeholders})
                `);

                for (const record of jsonData) {
                    await stmt.run(...columns.map(col => record[col]));
                }
            }

            await tempDb.close();
            console.log(clc.green('[DB] Successfully converted JSON to SQLite database'));

        } catch (error) {
            console.error(clc.red('[DB] Error converting JSON to SQLite:'), error);
            // Clean up failed DB file if it was created
            if (fs.existsSync(this.dbPath)) {
                fs.unlinkSync(this.dbPath);
            }
            throw error;
        }
    }

    async verifyDatabaseStructure() {
        const tableInfo = await this.db.all(`PRAGMA table_info(numbers)`);
        return tableInfo.some(col => col.name.toLowerCase() === 'telephone');
    }

    async ensureColumns() {
        try {
            // First check if table exists
            const tableExists = await this.db.get(`
                SELECT name 
                FROM sqlite_master 
                WHERE type='table' 
                AND name='numbers'
            `);

            if (!tableExists) {
                console.log(clc.yellow('[DB] Creating numbers table...'));
                await this.db.run(`
                    CREATE TABLE numbers (
                        id INTEGER PRIMARY KEY,
                        telephone TEXT,
                        dncl_checked_at DATETIME,
                        DNCL_status TEXT DEFAULT NULL,
                        DNCL_registration_date TEXT DEFAULT NULL
                    )
                `);
                console.log(clc.green('[DB] Successfully created numbers table'));
                return;
            }

            // If table exists, check for missing columns
            const tableInfo = await this.db.all(`PRAGMA table_info(numbers)`);
            
            const requiredColumns = {
                'dncl_checked_at': 'DATETIME',
                'DNCL_status': 'TEXT DEFAULT NULL',
                'DNCL_registration_date': 'TEXT DEFAULT NULL'
            };

            for (const [columnName, columnType] of Object.entries(requiredColumns)) {
                const hasColumn = tableInfo.some(col => 
                    col.name.toLowerCase() === columnName.toLowerCase()
                );
                
                if (!hasColumn) {
                    console.log(clc.yellow(`[DB] Adding ${columnName} column to numbers table...`));
                    await this.db.run(`
                        ALTER TABLE numbers 
                        ADD COLUMN ${columnName} ${columnType}
                    `);
                    console.log(clc.green(`[DB] Successfully added ${columnName} column`));
                }
            }
        } catch (error) {
            console.error(clc.red('[DB] Error ensuring columns exist:'), error.message);
            throw error;
        }
    }

    getDb() {
        return this.db;
    }

    async getNextBatch(batchSize) {
        console.log(clc.cyan(`\n[DB] Fetching next batch of ${batchSize} numbers...`));
        
        const numbers = await this.db.all(`
            UPDATE numbers 
            SET dncl_status = 'PROCESSING'
            WHERE id IN (
                SELECT id 
                FROM numbers 
                WHERE (dncl_status IS NULL OR dncl_status = '')
                AND telephone IS NOT NULL
                LIMIT ?
            )
            RETURNING id, telephone
        `, batchSize);

        if (numbers.length > 0) {
            console.log(clc.green(`[DB] Found ${numbers.length} numbers to process`));
            numbers.forEach(n => console.log(clc.yellow(`[DB] ID: ${n.id}, Phone: ${n.telephone}`)));
        }
        
        return numbers;
    }

    async updateNumberStatus(id, status, registrationDate = null) {
        const currentTime = new Date().toISOString();
        
        console.log('\n=== Database Update ===');
        console.log(`ID: ${clc.yellow(id)}`);
        console.log(`Status: ${status === 'ERROR' ? clc.red(status) : 
                             status === 'ACTIVE' ? clc.green(status) : 
                             clc.yellow(status)}`);
        console.log(`Registration Date: ${registrationDate ? clc.cyan(registrationDate) : clc.cyan('N/A')}`);
        console.log(`Update Time: ${clc.cyan(currentTime)}`);
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
            console.error(clc.red(`Database update failed for ID ${id}:`), error.message);
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
        const errorCount = await this.db.get(`
            SELECT COUNT(*) as count 
            FROM numbers 
            WHERE dncl_status = 'ERROR'
        `);
        
        await this.db.run(`
            UPDATE numbers 
            SET dncl_status = NULL 
            WHERE dncl_status = 'ERROR'
        `);
        
        return errorCount.count;
    }

    async resetNullStatusCheckedAt() {
        console.log(clc.yellow('\nResetting status for records with null checked_at or null/error/processing status...'));
        
        // Reset PROCESSING status first
        await this.db.run(`
            UPDATE numbers 
            SET dncl_status = NULL 
            WHERE dncl_status = 'PROCESSING'
        `);
        
        // Reset status for records with null checked_at OR null/error status
        const result = await this.db.run(`
            UPDATE numbers 
            SET 
                dncl_status = NULL,
                dncl_checked_at = NULL 
            WHERE dncl_checked_at IS NULL
            OR DNCL_status IS NULL 
            OR DNCL_status = 'ERROR'
        `);
        
        const resetCount = await this.db.get(`
            SELECT COUNT(*) as count 
            FROM numbers 
            WHERE dncl_checked_at IS NULL
            OR DNCL_status IS NULL 
            OR DNCL_status = 'ERROR'
            OR DNCL_status = 'PROCESSING'
        `);
        
        console.log(clc.green(`Reset ${resetCount.count} numbers that had null checked_at or null/error/processing status\n`));
        return resetCount.count;
    }

    async close() {
        if (this.db) {
            await this.db.close();
        }
    }

    async convertToCSV() {
        console.log('\n=== Converting Database to CSV ===');
        const outputPath = this.dbPath.replace('.db', '_dncl.csv');

        try {
            // Get table schema
            const columns = await this.db.all(`PRAGMA table_info(numbers)`);
            
            const header = columns.map(col => ({
                id: col.name,
                title: col.name
            }));

            const csvWriter = createCsvWriter({
                path: outputPath,
                header: header
            });

            // Get all processed records (excluding ERROR status)
            const columnNames = columns.map(col => col.name).join(', ');
            const rows = await this.db.all(`
                SELECT ${columnNames}
                FROM numbers
                WHERE DNCL_status IS NOT NULL
                AND DNCL_status != 'ERROR'
            `);

            console.log(clc.cyan(`[CSV] Found ${rows.length} records to export (excluding ERROR status)`));

            await csvWriter.writeRecords(rows);
            console.log(clc.green(`[CSV] Successfully exported to: ${outputPath}`));
            
            return outputPath;
        } catch (error) {
            console.error(clc.red('[CSV] Error converting to CSV:'), error.message);
            throw error;
        }
    }
}

module.exports = DatabaseManager; 