const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('data.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

db.all("SELECT name, sql FROM sqlite_master WHERE type='table'", (err, rows) => {
    if (err) {
        console.error('Error querying schema:', err);
    } else {
        console.log('Database Schema Tables:');
        rows.forEach(r => {
            console.log(`Table Name: ${r.name}`);
            console.log(`SQL Schema:\n${r.sql}\n------------------------`);
        });
    }
    db.close();
});

