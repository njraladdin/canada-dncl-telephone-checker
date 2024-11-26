const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Initialize database connection
const db = new sqlite3.Database('./engineers.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
        return;
    }
    console.log('Connected to engineers database');
});

// First, get the table schema
db.all(`PRAGMA table_info(engineers)`, (err, columns) => {
    if (err) {
        console.error('Error getting table schema:', err);
        return;
    }

    // Create header from actual database columns
    const header = columns.map(col => ({
        id: col.name,
        title: col.name
    }));

    const csvWriter = createCsvWriter({
        path: 'engineers_dncl.csv',
        header: header
    });

    // Query all columns for rows with DNCL_status not null and not ERROR
    const columnNames = columns.map(col => col.name).join(', ');
    db.all(`
        SELECT ${columnNames}
        FROM engineers
        WHERE DNCL_status IS NOT NULL
        AND DNCL_status != 'ERROR'
    `, (err, rows) => {
        if (err) {
            console.error('Error querying database:', err);
            return;
        }

        console.log(`Found ${rows.length} records to export (excluding ERROR status)`);

        csvWriter.writeRecords(rows)
            .then(() => {
                console.log('CSV file has been written successfully');
                db.close();
            })
            .catch(error => {
                console.error('Error writing CSV:', error);
                db.close();
            });
    });
});
