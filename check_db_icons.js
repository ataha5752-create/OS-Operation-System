const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./data.db', (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
});

db.all("SELECT 'categories' as tbl, id, name, icon FROM categories", (err, rows) => {
    if (err) {
        console.error('Error querying categories:', err);
    } else {
        console.log(`Categories icons (total: ${rows.length}):`);
        console.log(rows.slice(0, 20));
    }
    
    db.all("SELECT 'subcategories' as tbl, id, name, icon FROM subcategories", (err, subrows) => {
        if (err) {
            console.error('Error querying subcategories:', err);
        } else {
            console.log(`Subcategories icons (total: ${subrows.length}):`);
            console.log(subrows.slice(0, 20));
        }

        db.all("SELECT 'items' as tbl, id, name, icon FROM items", (err, itemrows) => {
            if (err) {
                console.error('Error querying items:', err);
            } else {
                console.log(`Items icons (total: ${itemrows.length}):`);
                console.log(itemrows.slice(0, 20));
            }
            db.close();
        });
    });
});
