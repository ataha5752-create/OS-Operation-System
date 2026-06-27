const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'ops_reporting_secret_key_987654321_abc';
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

const clients = new Map(); // client -> { ws, username, roomId, voiceRoomId }

function broadcastToAll(payload) {
  const msg = JSON.stringify(payload);
  for (const [ws, info] of clients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

async function sendEmailAlert(toUser, subject, text) {
  const host = process.env.SMTP_HOST || 'smtp.office365.com'; // Default for te.eg (Office 365)
  const port = process.env.SMTP_PORT || '587';
  const user = process.env.SMTP_USER || 'ahmed.t.ahmad@te.eg'; // Default sender email
  
  let pass = process.env.SMTP_PASS || '';
  if (!pass) {
    const passwordFilePath = path.join(__dirname, 'email_password.txt');
    if (fs.existsSync(passwordFilePath)) {
      const fileContent = fs.readFileSync(passwordFilePath, 'utf8').trim();
      if (fileContent && fileContent !== 'YOUR_PASSWORD_HERE') {
        pass = fileContent;
      }
    }
  }
  
  if (!host || !user || !pass) {
    console.log(`[Email Mock Alert] (To: ${toUser}): Subject: ${subject}. Content: ${text}`);
    return;
  }
  
  try {
    const transporter = nodemailer.createTransport({
      host,
      port: parseInt(port) || 587,
      secure: port === '465',
      auth: { user, pass }
    });
    
    // Auto-complete default domain as te.eg if not specified
    const toEmail = toUser.includes('@') ? toUser : `${toUser}@te.eg`;
    
    await transporter.sendMail({
      from: `"WE Ops Control" <${user}>`,
      to: toEmail,
      subject: subject,
      text: text
    });
    console.log(`[Email Alert Sent] To: ${toEmail}`);
  } catch (err) {
    console.error('[Email Alert Error]:', err);
  }
}

function sendNotificationToUser(username, payload) {
  const msg = JSON.stringify(payload);
  for (const [ws, info] of clients.entries()) {
    if (info.username === username && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

async function createNotification(username, title, message) {
  const id = 'notif_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const timestamp = new Date().toISOString();
  try {
    await dbRun(
      'INSERT INTO notifications (id, username, title, message, read, timestamp) VALUES (?, ?, ?, ?, 0, ?)',
      [id, username, title, message, timestamp]
    );
    sendNotificationToUser(username, {
      type: 'notification-new',
      notification: { id, title, message, read: 0, timestamp }
    });
  } catch (err) {
    console.error('Error creating notification:', err);
  }
}

app.use(cors());
app.use(express.json({ limit: '50mb' })); // support large payloads for file attachments
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve frontend static files from current directory
app.use(express.static(__dirname));
app.use('/uploads', express.static(uploadsDir));

// Helper to save base64 files to disk
function saveBase64Files(filesArray) {
  if (!Array.isArray(filesArray)) return [];
  
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  
  return filesArray.map(file => {
    // If already uploaded, keep original URL
    if (!file.dataUrl || !file.dataUrl.startsWith('data:')) {
      return {
        name: file.name,
        size: file.size,
        type: file.type,
        url: file.url || file.path
      };
    }
    
    try {
      const matches = file.dataUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
      if (!matches || matches.length !== 3) {
        console.error('[Upload] Invalid base64 structure');
        return null;
      }
      
      const fileBuffer = Buffer.from(matches[2], 'base64');
      const sanitizedExt = path.extname(file.name) || '.' + matches[1].split('/')[1] || '';
      const fileNameOnly = path.basename(file.name, sanitizedExt).replace(/[^a-zA-Z0-9]/g, '_');
      const uniqueFilename = `${fileNameOnly}_${Date.now()}${sanitizedExt}`;
      const filePath = path.join(uploadsDir, uniqueFilename);
      
      fs.writeFileSync(filePath, fileBuffer);
      console.log(`[Upload] File saved to disk: ${uniqueFilename}`);
      
      return {
        name: file.name,
        size: file.size,
        type: file.type,
        url: `/uploads/${uniqueFilename}`
      };
    } catch (err) {
      console.error('[Upload] Error saving file to disk:', err);
      return null;
    }
  }).filter(Boolean);
}

// Connect to SQLite Database
const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, 'data.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    initializeDatabase();
  }
});

// Helper for db queries (Promise-based)
const dbRun = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

// Activity Logger Helper
async function logActivity(username, action, targetType, targetId, details) {
  const id = 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const timestamp = new Date().toISOString();
  try {
    await dbRun(
      'INSERT INTO activity_log (id, username, action, target_type, target_id, details, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, username || 'System', action, targetType || '', targetId || '', details || '', timestamp]
    );
  } catch (err) {
    console.error('Error writing activity log:', err);
  }
}

// Telegram Notifier Helper
const https = require('https');
function sendTelegramNotification(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatIds) {
    console.log('[Telegram Mock Alert]:', message.replace(/<[^>]*>/g, '')); // Strips HTML for clean console log
    return;
  }

  const ids = chatIds.split(',').map(id => id.trim());
  ids.forEach(chatId => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
      }
    };

    const req = https.request(options, (res) => {
      res.on('data', () => {});
    });

    req.on('error', (e) => {
      console.error('Error sending Telegram notification:', e);
    });

    req.write(payload);
    req.end();
  });
}

// SMS/WhatsApp Notifier Helper
async function sendSmsOrWhatsAppNotification(username, message) {
  try {
    const user = await dbGet('SELECT phone FROM users WHERE username = ?', [username]);
    const phone = user ? user.phone : null;
    
    // Default mock phone or user's phone
    const targetPhone = phone || '01000000000';
    
    const gatewayUrl = process.env.SMS_GATEWAY_URL;
    const whatsappToken = process.env.WHATSAPP_API_TOKEN;
    
    if (!gatewayUrl && !whatsappToken) {
      console.log(`[SMS/WhatsApp Mock Alert] (To: ${targetPhone}): ${message}`);
      return;
    }
    
    // SMS Gateway Integration boilerplate
    if (gatewayUrl) {
      const payload = JSON.stringify({ to: targetPhone, text: message });
      const urlObj = new URL(gatewayUrl);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        }
      };
      const req = https.request(options, (res) => {});
      req.on('error', (e) => console.error('SMS Gateway Error:', e));
      req.write(payload);
      req.end();
      console.log(`[SMS Sent] To: ${targetPhone}`);
    }
  } catch (err) {
    console.error('Error in sendSmsOrWhatsAppNotification:', err);
  }
}

// Initialize Tables & Seed Demo Data
async function initializeDatabase() {
  try {
    // 1. Create tables
    await dbRun(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT,
      role TEXT,
      allowed_depts TEXT,
      allowed_tabs TEXT,
      phone TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS departments (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      dept_id TEXT,
      name TEXT,
      FOREIGN KEY (dept_id) REFERENCES departments(id) ON DELETE CASCADE
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS subcategories (
      id TEXT PRIMARY KEY,
      cat_id TEXT,
      name TEXT,
      FOREIGN KEY (cat_id) REFERENCES categories(id) ON DELETE CASCADE
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      sub_id TEXT,
      name TEXT,
      FOREIGN KEY (sub_id) REFERENCES subcategories(id) ON DELETE CASCADE
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      title TEXT,
      dept_id TEXT,
      cat_id TEXT,
      sub_id TEXT,
      item_id TEXT,
      date TEXT,
      status TEXT,
      priority TEXT,
      progress INTEGER,
      notes TEXT,
      files TEXT,
      assigned_to TEXT,
      subtasks TEXT,
      blocked_by TEXT
    )`);

    try { await dbRun("ALTER TABLE entries ADD COLUMN assigned_to TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN subtasks TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN due_date TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN blocked_by TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE users ADD COLUMN phone TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE users ADD COLUMN allowed_tabs TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN points INTEGER DEFAULT 0"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN parts_used TEXT"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN latitude REAL"); } catch(e) {}
    try { await dbRun("ALTER TABLE entries ADD COLUMN longitude REAL"); } catch(e) {}

    await dbRun(`CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      username TEXT,
      comment_text TEXT,
      timestamp TEXT,
      FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY,
      username TEXT,
      action TEXT,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      timestamp TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS group_chats (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      username TEXT,
      message TEXT,
      timestamp TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      username TEXT,
      title TEXT,
      message TEXT,
      read INTEGER,
      timestamp TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS preventive_templates (
      id TEXT PRIMARY KEY,
      title TEXT,
      dept_id TEXT,
      cat_id TEXT,
      sub_id TEXT,
      item_id TEXT,
      frequency TEXT,
      last_generated TEXT,
      assigned_to TEXT,
      priority TEXT,
      notes TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS entry_revisions (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      changed_by TEXT,
      old_notes TEXT,
      new_notes TEXT,
      timestamp TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      engineer TEXT,
      sector TEXT,
      shift_type TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS stakeholders (
      id TEXT PRIMARY KEY,
      name TEXT,
      job_title TEXT,
      governorate TEXT,
      mobile TEXT,
      email TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      year INTEGER,
      engineer TEXT,
      total_points INTEGER,
      rating TEXT,
      comments TEXT,
      approved_by TEXT,
      timestamp TEXT,
      UNIQUE(year, engineer)
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS spare_parts (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      sku TEXT,
      quantity INTEGER DEFAULT 0,
      min_quantity INTEGER DEFAULT 5,
      unit TEXT
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS part_transactions (
      id TEXT PRIMARY KEY,
      part_id TEXT,
      entry_id TEXT,
      type TEXT,
      quantity INTEGER,
      username TEXT,
      timestamp TEXT,
      FOREIGN KEY (part_id) REFERENCES spare_parts(id)
    )`);

    await dbRun(`CREATE TABLE IF NOT EXISTS handovers (
      id TEXT PRIMARY KEY,
      outgoing_engineer TEXT,
      incoming_engineer TEXT,
      active_faults TEXT,
      general_notes TEXT,
      status TEXT,
      timestamp TEXT
    )`);

    console.log('Database tables verified/created.');

    // 2. Seed default users if empty
    const userCount = await dbGet('SELECT COUNT(*) as count FROM users');
    if (userCount.count === 0) {
      const adminPass = bcrypt.hashSync('admin123', 10);
      const editorPass = bcrypt.hashSync('editor123', 10);
      const viewerPass = bcrypt.hashSync('viewer123', 10);

      await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts) VALUES (?, ?, ?, ?, ?)', ['u_1', 'admin', adminPass, 'admin', '[]']);
      await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts) VALUES (?, ?, ?, ?, ?)', ['u_2', 'editor', editorPass, 'editor', '[]']);
      await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts) VALUES (?, ?, ?, ?, ?)', ['u_3', 'viewer', viewerPass, 'viewer', '[]']);

      // Seed default engineers
      const engineers = [
        'م الهادي احمد', 'م هنادي الحلو', 'م محمد مصطفي', 'م محمد صلاح',
        'م ايمان عبدالرازق', 'اشرف كمال', 'م رانيا محمود', 'وفاء عبدالرازق',
        'م احمد طه', 'م احمد حمدي', 'م نور', 'م علاء'
      ];
      const defaultEngPass = bcrypt.hashSync('123456', 10);
      for (let i = 0; i < engineers.length; i++) {
        await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts) VALUES (?, ?, ?, ?, ?)', [`u_eng_${i}`, engineers[i], defaultEngPass, 'editor', '[]']);
      }

      console.log('Seeded default users and engineers (default password: 123456).');
    }

    // Seed default spare parts if empty
    const partCount = await dbGet('SELECT COUNT(*) as count FROM spare_parts');
    if (partCount.count === 0) {
      const defaultParts = [
        { id: 'p_1', name: 'Control Card (كرت تحكم رئيسي)', sku: 'CTRL-CARD-V1', quantity: 15, min_quantity: 3, unit: 'pcs' },
        { id: 'p_2', name: 'Fiber Patch Cord 3m (كابل فايبر 3م)', sku: 'FIB-PATCH-3M', quantity: 50, min_quantity: 10, unit: 'pcs' },
        { id: 'p_3', name: 'Fuse 16A (فيوز 16 أمبير)', sku: 'FUSE-16A', quantity: 120, min_quantity: 20, unit: 'pcs' },
        { id: 'p_4', name: 'Lithium Battery 12V (بطارية ليثيوم 12فولت)', sku: 'BATT-LITH-12V', quantity: 8, min_quantity: 2, unit: 'pcs' },
        { id: 'p_5', name: 'SFP Transceiver 10G (موديول SFP 10G)', sku: 'SFP-10G-LR', quantity: 25, min_quantity: 5, unit: 'pcs' }
      ];
      for (const p of defaultParts) {
        await dbRun('INSERT INTO spare_parts (id, name, sku, quantity, min_quantity, unit) VALUES (?, ?, ?, ?, ?, ?)',
          [p.id, p.name, p.sku, p.quantity, p.min_quantity, p.unit]
        );
      }
      console.log('Seeded default spare parts.');
    }

    // Destructive SPM category migration check removed to prevent database from being wiped on startup.

    // 3. Seed demo structure if empty (only on initial database creation when both departments and users are empty)
    const deptCount = await dbGet('SELECT COUNT(*) as count FROM departments');
    if (deptCount.count === 0 && userCount.count === 0) {
      console.log('Seeding demo departments, hierarchy, and entries...');
      const depts = [
        { id: 'd_1', name: 'S.Sinai' },
        { id: 'd_2', name: 'N.Sinai' },
        { id: 'd_3', name: 'ISM' },
        { id: 'd_4', name: 'Suez' },
        { id: 'd_5', name: 'Port Said' },
        { id: 'd_6', name: 'Red Sea' }
      ];

      const categoryNames = [
        "Correlative Maintenance",
        "Preventive Maintenance",
        "New Project",
        "CID's Installation",
        "Hall Layout",
        "SPM"
      ];

      for (const d of depts) {
        await dbRun('INSERT INTO departments VALUES (?, ?)', [d.id, d.name]);

        for (const catName of categoryNames) {
          const catClean = catName.toLowerCase().replace(/[^a-z0-9]/g, '_');
          const catId = `c_${catClean}_${d.id}`;
          await dbRun('INSERT INTO categories VALUES (?, ?, ?)', [catId, d.id, catName]);

          // Seed a sample subcategory and item for each category to keep it structured
          const subId = `s_${catClean}_${d.id}`;
          let subName = '';
          let itemName = '';
          
          if (catName === 'Correlative Maintenance') {
            subName = 'Mechanical Repairs';
            itemName = 'Main Engine Repair';
          } else if (catName === 'Preventive Maintenance') {
            subName = 'Routine Inspection';
            itemName = 'Daily Equipment Check';
          } else if (catName === 'New Project') {
            subName = 'Phase 1';
            itemName = 'Site Preparation';
          } else if (catName === 'CID\'s Installation') {
            subName = 'Hardware Setup';
            itemName = 'Camera Mounting';
          } else if (catName === 'Hall Layout') {
            subName = 'Space Planning';
            itemName = 'Floor Grid Design';
          } else if (catName === 'SPM') {
            subName = 'SPM Monitoring';
            itemName = 'Daily SPM Log';
          }

          await dbRun('INSERT INTO subcategories VALUES (?, ?, ?)', [subId, catId, subName]);
          const itemId = "i_" + catClean + "_" + d.id;
          await dbRun("INSERT INTO items VALUES (?, ?, ?)", [itemId, subId, itemName]);
        }
      }
        // Add a couple of sample Fault & Solution entries
      const statuses = ['On track', 'At risk', 'Delayed', 'Completed', 'Pending'];
      const priorities = ['High', 'Medium', 'Low'];

      // Add 6 standard demo entries (assigned to Preventive Maintenance)
      for (let i = 0; i < 6; i++) {
        const d = depts[i];
        const catId = `c_preventive_maintenance_${d.id}`;
        const subId = `s_preventive_maintenance_${d.id}`;
        const itemId = `i_preventive_maintenance_${d.id}`;
        
        await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          'e_' + i,
          `${d.name} – Preventive Maintenance Task`,
          d.id,
          catId,
          subId,
          itemId,
          `2026-05-${10 + i}`,
          statuses[i % statuses.length],
          priorities[i % priorities.length],
          30 + (i * 12),
          `Sample notes for department operational task at ${d.name}.`,
          '[]'
        ]);
      }
 
      // Add specific Faults and Solutions for "Smart Search"
      await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'e_fault_1',
        'عطل كهربائي في الونش الرئيسي رقم 4 (Main Crane Failure)',
        'd_1',
        'c_correlative_maintenance_d_1',
        's_correlative_maintenance_d_1',
        'i_correlative_maintenance_d_1',
        '2026-05-20',
        'Completed',
        'High',
        100,
        'الوصف: توقف مفاجئ للونش الرئيسي رقم 4 بسبب احتراق فيوز التحكم الرئيسي.\nالحل: تم فحص الدائرة واستبدال الفيوز التالف بفيوز آخر أصلي 16 أمبير، وتمت إعادة التشغيل بنجاح والونش يعمل بكفاءة الآن.',
        '[]'
      ]);
 
      await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        'e_fault_2',
        'تسريب زيت هيدروليكي في رصيف 2 (Hydraulic Leakage)',
        'd_5',
        'c_preventive_maintenance_d_5',
        's_preventive_maintenance_d_5',
        'i_preventive_maintenance_d_5',
        '2026-05-22',
        'Completed',
        'Medium',
        100,
        'الوصف: وجود بقع زيتية وتسريب هيدروليكي أسفل رافعة Berth 2.\nالحل: تم إيقاف العمل مؤقتاً، واستبدال الأنابيب التالفة (Hydraulic Hoses) وتنظيف الرصيف بالكامل لمنع الانزلاق.',
        '[]'
      ]);

      console.log('Seeded demo structure and fault-solution data successfully.');
    }
  } catch (error) {
    console.error('Error seeding database:', error);
  }
}

// Token Verification Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required. Please log in.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token is invalid or expired.' });
    req.user = user;
    next();
  });
}

// Role Authorization Middleware
function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Unauthorized: You do not have permission for this action.' });
    }
    next();
  };
}

// Department access helper
function getDeptFilter(user) {
  if (user.role === 'admin' || !user.allowed_depts || user.allowed_depts.length === 0) {
    return null; // No restriction
  }
  return user.allowed_depts; // returns array of allowed deptIds
}

// Authentication Endpoint
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  try {
    const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const validPass = bcrypt.compareSync(password, user.password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Invalid username or password' });
    }

    const allowedDepts = JSON.parse(user.allowed_depts || '[]');
    const allowedTabs = JSON.parse(user.allowed_tabs || '[]');
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, allowed_depts: allowedDepts, allowed_tabs: allowedTabs },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await logActivity(user.username, 'Login', 'user', user.id, 'User logged in successfully');

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        allowed_depts: allowedDepts,
        allowed_tabs: allowedTabs
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error during login' });
  }
});

// GET Current Session User profile
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// SMART SEARCH Endpoint
// Searches faults and solutions in 'title' and 'notes' fields
app.get('/api/entries/search', authenticateToken, async (req, res) => {
  const query = req.query.q || '';
  if (!query.trim()) {
    return res.json([]);
  }

  try {
    const allowedDepts = getDeptFilter(req.user);
    let sql = 'SELECT * FROM entries WHERE (title LIKE ? OR notes LIKE ?)';
    let params = [`%${query}%`, `%${query}%`];

    if (allowedDepts) {
      const placeholders = allowedDepts.map(() => '?').join(',');
      sql += ` AND dept_id IN (${placeholders})`;
      params.push(...allowedDepts);
    }

    sql += ' ORDER BY date DESC';
    const results = await dbAll(sql, params);
    
    // Parse files JSON for each entry
    results.forEach(r => {
      r.files = JSON.parse(r.files || '[]');
      r.subtasks = JSON.parse(r.subtasks || '[]');
      r.parts_used = JSON.parse(r.parts_used || '[]');
    });

    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Error performing search' });
  }
});

// GET Fetch All Dashboard Data
app.get('/api/data', authenticateToken, async (req, res) => {
  try {
    const allowedDepts = getDeptFilter(req.user);

    let depts, cats, subs, items, entries;

    if (allowedDepts) {
      const placeholders = allowedDepts.map(() => '?').join(',');
      
      depts = await dbAll(`SELECT * FROM departments WHERE id IN (${placeholders})`, allowedDepts);
      
      cats = await dbAll(`SELECT * FROM categories WHERE dept_id IN (${placeholders})`, allowedDepts);
      const catIds = cats.map(c => c.id);
      
      if (catIds.length > 0) {
        const catPlaceholders = catIds.map(() => '?').join(',');
        subs = await dbAll(`SELECT * FROM subcategories WHERE cat_id IN (${catPlaceholders})`, catIds);
      } else {
        subs = [];
      }
      const subIds = subs.map(s => s.id);

      if (subIds.length > 0) {
        const subPlaceholders = subIds.map(() => '?').join(',');
        items = await dbAll(`SELECT * FROM items WHERE sub_id IN (${subPlaceholders})`, subIds);
      } else {
        items = [];
      }

      entries = await dbAll(`SELECT * FROM entries WHERE dept_id IN (${placeholders})`, allowedDepts);
    } else {
      depts = await dbAll('SELECT * FROM departments');
      cats = await dbAll('SELECT * FROM categories');
      subs = await dbAll('SELECT * FROM subcategories');
      items = await dbAll('SELECT * FROM items');
      entries = await dbAll('SELECT * FROM entries');
    }

    // Parse files JSON back to array
    entries.forEach(e => {
      e.files = JSON.parse(e.files || '[]');
      e.subtasks = JSON.parse(e.subtasks || '[]');
      e.parts_used = JSON.parse(e.parts_used || '[]');
    });

    const evaluations = await dbAll('SELECT * FROM evaluations');

    res.json({
      departments: depts,
      categories: cats,
      subcategories: subs,
      items: items,
      entries: entries,
      evaluations: evaluations
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve database contents' });
  }
});

// ================= HIERARCHY MUTATIONS =================

// Add Department (Admin Only)
app.post('/api/hierarchy/dept', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const id = 'dept_' + Date.now();

  try {
    await dbRun('INSERT INTO departments VALUES (?, ?)', [id, name.trim()]);
    await logActivity(req.user.username, 'Create Department', 'department', id, `Created department: ${name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id, name });
  } catch (error) {
    res.status(500).json({ error: 'Department name already exists or server error.' });
  }
});

// Add Category (Admin/Editor)
app.post('/api/hierarchy/cat', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { deptId, name } = req.body;
  if (!deptId || !name || !name.trim()) return res.status(400).json({ error: 'Required fields missing' });

  // Enforce Editor Department restriction
  const allowedDepts = getDeptFilter(req.user);
  if (allowedDepts && !allowedDepts.includes(deptId)) {
    return res.status(403).json({ error: 'You do not have write access for this department' });
  }

  const id = 'cat_' + Date.now();
  try {
    await dbRun('INSERT INTO categories VALUES (?, ?, ?)', [id, deptId, name.trim()]);
    await logActivity(req.user.username, 'Create Category', 'category', id, `Created category: ${name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id, name });
  } catch (error) {
    res.status(500).json({ error: 'Error adding category' });
  }
});

// Add Subcategory (Admin/Editor)
app.post('/api/hierarchy/sub', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { catId, name } = req.body;
  if (!catId || !name || !name.trim()) return res.status(400).json({ error: 'Required fields missing' });

  try {
    const cat = await dbGet('SELECT dept_id FROM categories WHERE id = ?', [catId]);
    if (!cat) return res.status(404).json({ error: 'Parent category not found' });

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && !allowedDepts.includes(cat.dept_id)) {
      return res.status(403).json({ error: 'You do not have write access for this department' });
    }

    const id = 'sub_' + Date.now();
    await dbRun('INSERT INTO subcategories VALUES (?, ?, ?)', [id, catId, name.trim()]);
    await logActivity(req.user.username, 'Create Subcategory', 'subcategory', id, `Created subcategory: ${name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id, name });
  } catch (error) {
    res.status(500).json({ error: 'Error adding subcategory' });
  }
});

// Add Item (Admin/Editor)
app.post('/api/hierarchy/item', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { subId, name } = req.body;
  if (!subId || !name || !name.trim()) return res.status(400).json({ error: 'Required fields missing' });

  try {
    const sub = await dbGet(`SELECT categories.dept_id FROM subcategories 
      JOIN categories ON subcategories.cat_id = categories.id 
      WHERE subcategories.id = ?`, [subId]);
    if (!sub) return res.status(404).json({ error: 'Parent subcategory not found' });

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && !allowedDepts.includes(sub.dept_id)) {
      return res.status(403).json({ error: 'You do not have write access for this department' });
    }

    const id = 'itm_' + Date.now();
    await dbRun('INSERT INTO items VALUES (?, ?, ?)', [id, subId, name.trim()]);
    await logActivity(req.user.username, 'Create Item', 'item', id, `Created item: ${name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id, name });
  } catch (error) {
    res.status(500).json({ error: 'Error adding item' });
  }
});

// Rename Node (Admin/Editor)
app.put('/api/hierarchy/:type/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { type, id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  try {
    let deptId = null;

    if (type === 'cat') {
      const cat = await dbGet('SELECT dept_id FROM categories WHERE id = ?', [id]);
      if (cat) deptId = cat.dept_id;
    } else if (type === 'sub') {
      const sub = await dbGet('SELECT categories.dept_id FROM subcategories JOIN categories ON subcategories.cat_id = categories.id WHERE subcategories.id = ?', [id]);
      if (sub) deptId = sub.dept_id;
    } else if (type === 'item') {
      const itm = await dbGet('SELECT categories.dept_id FROM items JOIN subcategories ON items.sub_id = subcategories.id JOIN categories ON subcategories.cat_id = categories.id WHERE items.id = ?', [id]);
      if (itm) deptId = itm.dept_id;
    }

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && deptId && !allowedDepts.includes(deptId)) {
      return res.status(403).json({ error: 'Unauthorized operation for your assigned departments' });
    }

    if (type === 'cat') {
      await dbRun('UPDATE categories SET name = ? WHERE id = ?', [name.trim(), id]);
    } else if (type === 'sub') {
      await dbRun('UPDATE subcategories SET name = ? WHERE id = ?', [name.trim(), id]);
    } else if (type === 'item') {
      await dbRun('UPDATE items SET name = ? WHERE id = ?', [name.trim(), id]);
    } else {
      return res.status(400).json({ error: 'Invalid node type' });
    }

    await logActivity(req.user.username, 'Rename Node', type, id, `Renamed ${type} to: ${name.trim()}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error renaming node' });
  }
});

// Delete Node (Admin/Editor)
app.delete('/api/hierarchy/:type/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { type, id } = req.params;

  try {
    let deptId = null;

    if (type === 'cat') {
      const cat = await dbGet('SELECT dept_id FROM categories WHERE id = ?', [id]);
      if (cat) deptId = cat.dept_id;
    } else if (type === 'sub') {
      const sub = await dbGet('SELECT categories.dept_id FROM subcategories JOIN categories ON subcategories.cat_id = categories.id WHERE subcategories.id = ?', [id]);
      if (sub) deptId = sub.dept_id;
    } else if (type === 'item') {
      const itm = await dbGet('SELECT categories.dept_id FROM items JOIN subcategories ON items.sub_id = subcategories.id JOIN categories ON subcategories.cat_id = categories.id WHERE items.id = ?', [id]);
      if (itm) deptId = itm.dept_id;
    }

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && deptId && !allowedDepts.includes(deptId)) {
      return res.status(403).json({ error: 'Unauthorized operation for your assigned departments' });
    }

    let targetName = 'Unknown';
    if (type === 'cat') {
      const node = await dbGet('SELECT name FROM categories WHERE id = ?', [id]);
      if (node) targetName = node.name;
      await dbRun('DELETE FROM entries WHERE cat_id = ?', [id]);
      await dbRun('DELETE FROM categories WHERE id = ?', [id]);
    } else if (type === 'sub') {
      const node = await dbGet('SELECT name FROM subcategories WHERE id = ?', [id]);
      if (node) targetName = node.name;
      await dbRun('DELETE FROM entries WHERE sub_id = ?', [id]);
      await dbRun('DELETE FROM subcategories WHERE id = ?', [id]);
    } else if (type === 'item') {
      const node = await dbGet('SELECT name FROM items WHERE id = ?', [id]);
      if (node) targetName = node.name;
      await dbRun('DELETE FROM entries WHERE item_id = ?', [id]);
      await dbRun('DELETE FROM items WHERE id = ?', [id]);
    } else {
      return res.status(400).json({ error: 'Invalid node type' });
    }

    await logActivity(req.user.username, 'Delete Node', type, id, `Deleted ${type}: ${targetName}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting node' });
  }
});


// ================= ENTRY MUTATIONS =================

// Create Entry (Admin/Editor)
app.post('/api/entries', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { title, deptId, catId, subId, itemId, date, status, priority, progress, notes, files, assignedTo, subtasks, dueDate, blockedBy, points, partsUsed, latitude, longitude } = req.body;
  if (!title || !deptId) {
    return res.status(400).json({ error: 'Title and Department are required.' });
  }

  const allowedDepts = getDeptFilter(req.user);
  if (allowedDepts && !allowedDepts.includes(deptId)) {
    return res.status(403).json({ error: 'Unauthorized department for new entry.' });
  }

  const id = 'entry_' + Date.now();
  const savedFiles = saveBase64Files(files || []);
  const filesStr = JSON.stringify(savedFiles);
  const subtasksStr = JSON.stringify(subtasks || []);
  const partsUsedStr = JSON.stringify(partsUsed || []);
  const pointsVal = req.user.role === 'admin' ? (parseInt(points) || 0) : 0;
  const latVal = latitude ? parseFloat(latitude) : null;
  const lngVal = longitude ? parseFloat(longitude) : null;

  try {
    await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files, assigned_to, subtasks, due_date, blocked_by, points, parts_used, latitude, longitude) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
      [id, title, deptId, catId, subId, itemId, date, status, priority, parseInt(progress) || 0, notes, filesStr, assignedTo || '', subtasksStr, dueDate || '', blockedBy || '', pointsVal, partsUsedStr, latVal, lngVal]
    );

    // Deduct stock for parts used
    if (partsUsed && Array.isArray(partsUsed)) {
      for (const p of partsUsed) {
        await dbRun('UPDATE spare_parts SET quantity = quantity - ? WHERE id = ?', [p.quantity, p.partId]);
        await dbRun('INSERT INTO part_transactions (id, part_id, entry_id, type, quantity, username, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5), p.partId, id, 'OUT', p.quantity, req.user.username, new Date().toISOString()]
        );
        
        // Low stock alert check
        const part = await dbGet('SELECT * FROM spare_parts WHERE id = ?', [p.partId]);
        if (part && part.quantity <= part.min_quantity) {
          sendTelegramNotification(`⚠️ <b>تنبيه مخزن قطع الغيار:</b>\nرصيد قطعة الغيار <b>${part.name}</b> شارف على النفاد!\nالكمية الحالية: ${part.quantity} (الحد الأدنى: ${part.min_quantity})`);
        }
      }
    }

    await logActivity(req.user.username, 'Create Entry', 'entry', id, `Created entry: ${title} with ${pointsVal} points`);

    // Real-time notification for assignee
    if (assignedTo && assignedTo !== req.user.username) {
      await createNotification(
        assignedTo,
        'مهمة جديدة مسندة إليك (New Task Assigned)',
        `تم إسناد المهمة: "${title}" إليك بواسطة ${req.user.username}.`
      );
      await sendEmailAlert(
        assignedTo,
        'مهمة جديدة مسندة إليك (New Task Assigned)',
        `تم إسناد المهمة: "${title}" إليك بواسطة ${req.user.username} في تاريخ ${date}.`
      );
      await sendSmsOrWhatsAppNotification(
        assignedTo,
        `تنبيه: تم إسناد مهمة جديدة إليك: "${title}" بواسطة ${req.user.username}.`
      );
    }

    // Trigger Telegram notification
    if (priority === 'High' && (status === 'Delayed' || status === 'At risk')) {
      const dept = await dbGet('SELECT name FROM departments WHERE id = ?', [deptId]);
      const deptNameStr = dept ? dept.name : deptId;
      const msg = `⚠️ <b>تنبيه عطل طارئ (High Priority Alert)</b>\n\n` +
                  `<b>العنوان:</b> ${title}\n` +
                  `<b>المحافظة/القطاع:</b> ${deptNameStr}\n` +
                  `<b>الحالة:</b> ${status}\n` +
                  `<b>المسؤول:</b> ${assignedTo || 'غير محدد'}\n` +
                  `<b>تاريخ الاستحقاق:</b> ${dueDate || 'غير محدد'}\n\n` +
                  `<i>يرجى المتابعة وسرعة حل العطل.</i>`;
      sendTelegramNotification(msg);
    }

    broadcastToAll({ type: 'db-update' });

    const newEntry = { id, title, deptId, catId, subId, itemId, date, status, priority, progress: parseInt(progress) || 0, notes, files: savedFiles, assignedTo: assignedTo || '', subtasks: subtasks || [], due_date: dueDate || '', blocked_by: blockedBy || '', points: pointsVal, parts_used: partsUsed, latitude: latVal, longitude: lngVal };
    res.json(newEntry);
  } catch (error) {
    console.error('Error creating entry:', error);
    res.status(500).json({ error: 'Error creating entry.' });
  }
});

// Update Entry (Admin/Editor)
app.put('/api/entries/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  const { title, deptId, catId, subId, itemId, date, status, priority, progress, notes, files, assignedTo, subtasks, dueDate, blockedBy, points, partsUsed, latitude, longitude } = req.body;

  try {
    const oldEntry = await dbGet('SELECT * FROM entries WHERE id = ?', [id]);
    if (!oldEntry) return res.status(404).json({ error: 'Entry not found' });

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && (!allowedDepts.includes(oldEntry.dept_id) || !allowedDepts.includes(deptId))) {
      return res.status(403).json({ error: 'Unauthorized department for entry edit.' });
    }

    // Check if notes changed to write a revision history record
    if (notes !== undefined && notes !== oldEntry.notes) {
      const revisionId = 'rev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
      const timestamp = new Date().toISOString();
      await dbRun(
        'INSERT INTO entry_revisions (id, entry_id, changed_by, old_notes, new_notes, timestamp) VALUES (?, ?, ?, ?, ?, ?)',
        [revisionId, id, req.user.username, oldEntry.notes || '', notes || '', timestamp]
      );
    }

    // Reverse old inventory adjustments
    if (oldEntry.parts_used) {
      try {
        const oldParts = JSON.parse(oldEntry.parts_used);
        for (const p of oldParts) {
          await dbRun('UPDATE spare_parts SET quantity = quantity + ? WHERE id = ?', [p.quantity, p.partId]);
          await dbRun('INSERT INTO part_transactions (id, part_id, entry_id, type, quantity, username, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5), p.partId, id, 'IN_REV', p.quantity, req.user.username, new Date().toISOString()]
          );
        }
      } catch (e) {
        console.error('Error reversing old inventory:', e);
      }
    }

    // Apply new inventory adjustments
    if (partsUsed && Array.isArray(partsUsed)) {
      for (const p of partsUsed) {
        await dbRun('UPDATE spare_parts SET quantity = quantity - ? WHERE id = ?', [p.quantity, p.partId]);
        await dbRun('INSERT INTO part_transactions (id, part_id, entry_id, type, quantity, username, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ['tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5), p.partId, id, 'OUT', p.quantity, req.user.username, new Date().toISOString()]
        );

        // Low stock alert check
        const part = await dbGet('SELECT * FROM spare_parts WHERE id = ?', [p.partId]);
        if (part && part.quantity <= part.min_quantity) {
          sendTelegramNotification(`⚠️ <b>تنبيه مخزن قطع الغيار:</b>\nرصيد قطعة الغيار <b>${part.name}</b> شارف على النفاد!\nالكمية الحالية: ${part.quantity} (الحد الأدنى: ${part.min_quantity})`);
        }
      }
    }

    const savedFiles = saveBase64Files(files || []);
    const filesStr = JSON.stringify(savedFiles);
    const subtasksStr = JSON.stringify(subtasks || []);
    const partsUsedStr = JSON.stringify(partsUsed || []);
    const pointsVal = req.user.role === 'admin' ? (points !== undefined ? (parseInt(points) || 0) : oldEntry.points) : oldEntry.points;
    const latVal = latitude ? parseFloat(latitude) : null;
    const lngVal = longitude ? parseFloat(longitude) : null;

    await dbRun(`UPDATE entries 
      SET title = ?, dept_id = ?, cat_id = ?, sub_id = ?, item_id = ?, date = ?, status = ?, priority = ?, progress = ?, notes = ?, files = ?, assigned_to = ?, subtasks = ?, due_date = ?, blocked_by = ?, points = ?, parts_used = ?, latitude = ?, longitude = ? 
      WHERE id = ?`,
      [title, deptId, catId, subId, itemId, date, status, priority, parseInt(progress) || 0, notes, filesStr, assignedTo || '', subtasksStr, dueDate || '', blockedBy || '', pointsVal, partsUsedStr, latVal, lngVal, id]
    );

    await logActivity(req.user.username, 'Update Entry', 'entry', id, `Updated entry: ${title} with points ${pointsVal}`);

    // Trigger In-App Notifications for changes
    if (assignedTo && assignedTo !== oldEntry.assigned_to && assignedTo !== req.user.username) {
      await createNotification(
        assignedTo,
        'مهمة مسندة إليك (Task Assigned)',
        `تم إسناد المهمة: "${title}" إليك بواسطة ${req.user.username}.`
      );
      await sendEmailAlert(
        assignedTo,
        'مهمة مسندة إليك (Task Assigned)',
        `تم إسناد المهمة: "${title}" إليك بواسطة ${req.user.username}.`
      );
      await sendSmsOrWhatsAppNotification(
        assignedTo,
        `تنبيه: تم إسناد المهمة: "${title}" إليك بواسطة ${req.user.username}.`
      );
    }
    if (status !== oldEntry.status) {
      const msgText = `تم تغيير حالة المهمة "${title}" إلى [${status}] بواسطة ${req.user.username}.`;
      if (assignedTo && assignedTo !== req.user.username) {
        await createNotification(assignedTo, 'تحديث حالة المهمة (Task Status Update)', msgText);
        await sendEmailAlert(assignedTo, 'تحديث حالة المهمة (Task Status Update)', msgText);
        await sendSmsOrWhatsAppNotification(assignedTo, `تنبيه: تم تغيير حالة المهمة "${title}" إلى [${status}] بواسطة ${req.user.username}.`);
      }
    }

    // Trigger Telegram notification
    if (priority === 'High' && (status === 'Delayed' || status === 'At risk')) {
      const dept = await dbGet('SELECT name FROM departments WHERE id = ?', [deptId]);
      const deptNameStr = dept ? dept.name : deptId;
      const msg = `⚠️ <b>تحديث عطل طارئ (High Priority Alert Update)</b>\n\n` +
                  `<b>العنوان:</b> ${title}\n` +
                  `<b>المحافظة/القطاع:</b> ${deptNameStr}\n` +
                  `<b>الحالة:</b> ${status}\n` +
                  `<b>المسؤول:</b> ${assignedTo || 'غير محدد'}\n` +
                  `<b>تاريخ الاستحقاق:</b> ${dueDate || 'غير محدد'}\n\n` +
                  `<i>تم تحديث تفاصيل العطل.</i>`;
      sendTelegramNotification(msg);
    }

    broadcastToAll({ type: 'db-update' });

    res.json({ id, title, deptId, catId, subId, itemId, date, status, priority, progress: parseInt(progress) || 0, notes, files: savedFiles, assignedTo: assignedTo || '', subtasks: subtasks || [], due_date: dueDate || '', blocked_by: blockedBy || '', points: pointsVal, parts_used: partsUsed, latitude: latVal, longitude: lngVal });
  } catch (error) {
    console.error('Error updating entry:', error);
    res.status(500).json({ error: 'Error updating entry.' });
  }
});

// Delete Entry (Admin/Editor)
app.delete('/api/entries/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await dbGet('SELECT title, dept_id FROM entries WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Entry not found' });

    const allowedDepts = getDeptFilter(req.user);
    if (allowedDepts && !allowedDepts.includes(existing.dept_id)) {
      return res.status(403).json({ error: 'Unauthorized department for entry deletion.' });
    }

    await dbRun('DELETE FROM entries WHERE id = ?', [id]);
    await logActivity(req.user.username, 'Delete Entry', 'entry', id, `Deleted entry: ${existing.title}`);
    
    broadcastToAll({ type: 'db-update' });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting entry.' });
  }
});


// ================= USER MANAGEMENT (Admin Only) =================

// Fetch Users
app.get('/api/users', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  try {
    const users = await dbAll('SELECT id, username, role, allowed_depts, allowed_tabs, phone FROM users');
    users.forEach(u => {
      u.allowed_depts = JSON.parse(u.allowed_depts || '[]');
      u.allowed_tabs = JSON.parse(u.allowed_tabs || '[]');
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

// Create User
app.post('/api/users', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { username, password, role, allowedDepts, allowedTabs, phone } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Username, password and role are required.' });
  }

  const id = 'usr_' + Date.now();
  const passwordHash = bcrypt.hashSync(password, 10);
  const allowedDeptsStr = JSON.stringify(allowedDepts || []);
  const allowedTabsStr = JSON.stringify(allowedTabs || []);

  try {
    await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts, allowed_tabs, phone) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, username.trim(), passwordHash, role, allowedDeptsStr, allowedTabsStr, phone || '']);
    broadcastToAll({ type: 'db-update' });
    res.json({ id, username: username.trim(), role, allowedDepts: allowedDepts || [], allowedTabs: allowedTabs || [], phone: phone || '' });
  } catch (error) {
    res.status(400).json({ error: 'Username already exists.' });
  }
});

// Update User
app.put('/api/users/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { id } = req.params;
  const { username, password, role, allowedDepts, allowedTabs, phone } = req.body;

  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let sql = 'UPDATE users SET username = ?, role = ?, allowed_depts = ?, allowed_tabs = ?, phone = ?';
    let params = [username.trim(), role, JSON.stringify(allowedDepts || []), JSON.stringify(allowedTabs || []), phone || ''];

    if (password && password.trim()) {
      const passwordHash = bcrypt.hashSync(password, 10);
      sql += ', password_hash = ?';
      params.push(passwordHash);
    }

    sql += ' WHERE id = ?';
    params.push(id);

    await dbRun(sql, params);
    broadcastToAll({ type: 'db-update' });
    res.json({ id, username: username.trim(), role, allowedDepts: allowedDepts || [], allowedTabs: allowedTabs || [], phone: phone || '' });
  } catch (error) {
    res.status(400).json({ error: 'Error updating user or username already exists.' });
  }
});

// Delete User
app.delete('/api/users/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { id } = req.params;
  if (id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own admin account.' });
  }

  try {
    await dbRun('DELETE FROM users WHERE id = ?', [id]);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error deleting user.' });
  }
});

// ================= STAKEHOLDERS MANAGEMENT =================

// Fetch Stakeholders
app.get('/api/stakeholders', authenticateToken, async (req, res) => {
  try {
    const list = await dbAll('SELECT * FROM stakeholders ORDER BY name ASC');
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve stakeholders' });
  }
});

// Create Stakeholder
app.post('/api/stakeholders', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { name, jobTitle, governorate, mobile, email } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  const id = 'stk_' + Date.now();
  try {
    await dbRun(
      'INSERT INTO stakeholders (id, name, job_title, governorate, mobile, email) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name.trim(), jobTitle || '', governorate || '', mobile || '', email || '']
    );
    await logActivity(req.user.username, 'Create Stakeholder', 'stakeholder', id, `Created stakeholder: ${name.trim()}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ id, name: name.trim(), jobTitle, governorate, mobile, email });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create stakeholder.' });
  }
});

// Update Stakeholder
app.put('/api/stakeholders/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  const { name, jobTitle, governorate, mobile, email } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }

  try {
    const existing = await dbGet('SELECT * FROM stakeholders WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Stakeholder not found' });

    await dbRun(
      'UPDATE stakeholders SET name = ?, job_title = ?, governorate = ?, mobile = ?, email = ? WHERE id = ?',
      [name.trim(), jobTitle || '', governorate || '', mobile || '', email || '', id]
    );
    await logActivity(req.user.username, 'Update Stakeholder', 'stakeholder', id, `Updated stakeholder: ${name.trim()}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ id, name: name.trim(), jobTitle, governorate, mobile, email });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update stakeholder.' });
  }
});

// Delete Stakeholder
app.delete('/api/stakeholders/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet('SELECT * FROM stakeholders WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Stakeholder not found' });

    await dbRun('DELETE FROM stakeholders WHERE id = ?', [id]);
    await logActivity(req.user.username, 'Delete Stakeholder', 'stakeholder', id, `Deleted stakeholder: ${existing.name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete stakeholder.' });
  }
});


// ================= COMMENTS & PASSWORD MANAGEMENT =================

// GET Entry Comments
app.get('/api/entries/:id/comments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const comments = await dbAll('SELECT * FROM comments WHERE entry_id = ? ORDER BY timestamp ASC', [id]);
    res.json(comments);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve comments' });
  }
});

// POST Add Comment
app.post('/api/entries/:id/comments', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { commentText } = req.body;
  if (!commentText || !commentText.trim()) {
    return res.status(400).json({ error: 'Comment text is required' });
  }

  const commentId = 'comm_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
  const timestamp = new Date().toISOString();

  try {
    const entry = await dbGet('SELECT title, assigned_to FROM entries WHERE id = ?', [id]);
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    await dbRun(
      'INSERT INTO comments (id, entry_id, username, comment_text, timestamp) VALUES (?, ?, ?, ?, ?)',
      [commentId, id, req.user.username, commentText.trim(), timestamp]
    );

    await logActivity(req.user.username, 'Add Comment', 'entry', id, `Added comment to: ${entry.title}`);

    // Trigger notification if assignee exists and is not the commentator
    if (entry.assigned_to && entry.assigned_to !== req.user.username) {
      await createNotification(
        entry.assigned_to,
        'تعليق جديد على المهمة (New Comment Added)',
        `أضاف ${req.user.username} تعليقاً جديداً على المهمة "${entry.title}": "${commentText.trim().substring(0, 50)}${commentText.trim().length > 50 ? '...' : ''}"`
      );
      await sendSmsOrWhatsAppNotification(
        entry.assigned_to,
        `تنبيه: أضاف ${req.user.username} تعليقاً على مهمتك "${entry.title}": ${commentText.trim()}`
      );
    }

    broadcastToAll({ type: 'db-update' });

    res.json({ id: commentId, entry_id: id, username: req.user.username, comment_text: commentText.trim(), timestamp });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// POST Change Own Password
app.post('/api/users/change-password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  try {
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const validPass = bcrypt.compareSync(currentPassword, user.password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    const newPasswordHash = bcrypt.hashSync(newPassword, 10);
    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [newPasswordHash, req.user.id]);

    await logActivity(user.username, 'Change Password', 'user', user.id, 'User changed their own password');

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password.' });
  }
});


// Fetch Activity Logs (Admin Only)
app.get('/api/logs', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const logs = await dbAll('SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT 500');
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve activity logs' });
  }
});

// GET Backup Export (Admin Only)
app.get('/api/backup/export', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const data = {};
    data.users = await dbAll('SELECT id, username, password_hash, role, allowed_depts, allowed_tabs, phone FROM users');
    data.departments = await dbAll('SELECT * FROM departments');
    data.categories = await dbAll('SELECT * FROM categories');
    data.subcategories = await dbAll('SELECT * FROM subcategories');
    data.items = await dbAll('SELECT * FROM items');
    data.entries = await dbAll('SELECT * FROM entries');
    data.comments = await dbAll('SELECT * FROM comments');
    data.activity_log = await dbAll('SELECT * FROM activity_log');
    data.group_chats = await dbAll('SELECT * FROM group_chats');
    data.stakeholders = await dbAll('SELECT * FROM stakeholders');
    data.evaluations = await dbAll('SELECT * FROM evaluations');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to export database backup: ' + error.message });
  }
});

// POST Backup Import (Admin Only)
app.post('/api/backup/import', authenticateToken, requireRole(['admin']), async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid backup payload structure.' });
  }

  try {
    await dbRun('BEGIN TRANSACTION');

    const tables = ['users', 'departments', 'categories', 'subcategories', 'items', 'entries', 'comments', 'activity_log', 'group_chats', 'notifications', 'stakeholders', 'evaluations'];
    for (const t of tables) {
      await dbRun(`DELETE FROM ${t}`);
    }

    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        const passHash = u.password_hash || bcrypt.hashSync('123456', 10);
        const allowedTabsStr = typeof u.allowed_tabs === 'string' ? u.allowed_tabs : JSON.stringify(u.allowed_tabs || []);
        await dbRun('INSERT INTO users (id, username, password_hash, role, allowed_depts, allowed_tabs, phone) VALUES (?, ?, ?, ?, ?, ?, ?)', [u.id, u.username, passHash, u.role, typeof u.allowed_depts === 'string' ? u.allowed_depts : JSON.stringify(u.allowed_depts || []), allowedTabsStr, u.phone || '']);
      }
    }
    if (Array.isArray(data.departments)) {
      for (const d of data.departments) {
        await dbRun('INSERT INTO departments VALUES (?, ?)', [d.id, d.name]);
      }
    }
    if (Array.isArray(data.categories)) {
      for (const c of data.categories) {
        await dbRun('INSERT INTO categories VALUES (?, ?, ?)', [c.id, c.dept_id, c.name]);
      }
    }
    if (Array.isArray(data.subcategories)) {
      for (const s of data.subcategories) {
        await dbRun('INSERT INTO subcategories VALUES (?, ?, ?)', [s.id, s.cat_id, s.name]);
      }
    }
    if (Array.isArray(data.items)) {
      for (const i of data.items) {
        await dbRun('INSERT INTO items VALUES (?, ?, ?)', [i.id, i.sub_id, i.name]);
      }
    }
    if (Array.isArray(data.entries)) {
      for (const e of data.entries) {
        const filesStr = typeof e.files === 'string' ? e.files : JSON.stringify(e.files || []);
        const subtasksStr = typeof e.subtasks === 'string' ? e.subtasks : JSON.stringify(e.subtasks || []);
        await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files, assigned_to, subtasks, due_date, blocked_by, points)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [e.id, e.title, e.dept_id, e.cat_id, e.sub_id, e.item_id, e.date, e.status, e.priority, parseInt(e.progress) || 0, e.notes || '', filesStr, e.assigned_to || '', subtasksStr, e.due_date || '', e.blocked_by || '', parseInt(e.points) || 0]
        );
      }
    }
    if (Array.isArray(data.comments)) {
      for (const c of data.comments) {
        await dbRun('INSERT INTO comments VALUES (?, ?, ?, ?, ?)', [c.id, c.entry_id, c.username, c.comment_text, c.timestamp]);
      }
    }
    if (Array.isArray(data.activity_log)) {
      for (const l of data.activity_log) {
        await dbRun('INSERT INTO activity_log VALUES (?, ?, ?, ?, ?, ?, ?)', [l.id, l.username, l.action, l.target_type, l.target_id, l.details, l.timestamp]);
      }
    }
    if (Array.isArray(data.group_chats)) {
      for (const ch of data.group_chats) {
        await dbRun('INSERT INTO group_chats VALUES (?, ?, ?, ?, ?)', [ch.id, ch.room_id, ch.username, ch.message, ch.timestamp]);
      }
    }
    if (Array.isArray(data.stakeholders)) {
      for (const s of data.stakeholders) {
        await dbRun('INSERT INTO stakeholders VALUES (?, ?, ?, ?, ?, ?)', [s.id, s.name, s.job_title, s.governorate, s.mobile, s.email]);
      }
    }
    if (Array.isArray(data.evaluations)) {
      for (const ev of data.evaluations) {
        await dbRun('INSERT INTO evaluations VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [ev.id, ev.year, ev.engineer, ev.total_points, ev.rating, ev.comments, ev.approved_by, ev.timestamp]);
      }
    }

    await dbRun('COMMIT');
    await logActivity(req.user.username, 'Import Database', 'system', 'backup', 'Database fully restored from JSON backup');
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, message: 'Database imported successfully.' });
  } catch (error) {
    try { await dbRun('ROLLBACK'); } catch (err) {}
    res.status(500).json({ error: 'Failed to import backup data: ' + error.message });
  }
});

// GET notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const notifs = await dbAll('SELECT * FROM notifications WHERE username = ? ORDER BY timestamp DESC LIMIT 50', [req.user.username]);
    res.json(notifs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve notifications' });
  }
});

// POST mark notifications as read
app.post('/api/notifications/read', authenticateToken, async (req, res) => {
  try {
    await dbRun('UPDATE notifications SET read = 1 WHERE username = ?', [req.user.username]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});
// GET Chat Room Messages
app.get('/api/chats/:roomId', authenticateToken, async (req, res) => {
  const { roomId } = req.params;
  try {
    const messages = await dbAll('SELECT * FROM group_chats WHERE room_id = ? ORDER BY timestamp ASC LIMIT 100', [roomId]);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve messages' });
  }
});

// --- PREVENTIVE MAINTENANCE SCHEDULER ENDPOINTS ---

// GET Fetch All templates
app.get('/api/preventive/templates', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  try {
    const templates = await dbAll('SELECT * FROM preventive_templates');
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve preventive templates' });
  }
});

// POST Create template
app.post('/api/preventive/templates', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { title, deptId, catId, subId, itemId, frequency, assignedTo, priority, notes } = req.body;
  if (!title || !deptId || !frequency) {
    return res.status(400).json({ error: 'Title, Department, and Frequency are required.' });
  }

  const id = 'temp_' + Date.now();
  try {
    await dbRun(`INSERT INTO preventive_templates (id, title, dept_id, cat_id, sub_id, item_id, frequency, last_generated, assigned_to, priority, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
      [id, title, deptId, catId || '', subId || '', itemId || '', frequency, assignedTo || '', priority || 'Medium', notes || '']
    );
    await logActivity(req.user.username, 'Create PM Template', 'template', id, `Created recurring PM template: ${title}`);
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// DELETE template
app.delete('/api/preventive/templates/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  try {
    const temp = await dbGet('SELECT title FROM preventive_templates WHERE id = ?', [id]);
    if (!temp) return res.status(404).json({ error: 'Template not found' });
    
    await dbRun('DELETE FROM preventive_templates WHERE id = ?', [id]);
    await logActivity(req.user.username, 'Delete PM Template', 'template', id, `Deleted recurring PM template: ${temp.title}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

// --- REVISION HISTORY ENDPOINT ---

// GET Entry Revisions
app.get('/api/entries/:id/revisions', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const revisions = await dbAll('SELECT * FROM entry_revisions WHERE entry_id = ? ORDER BY timestamp DESC', [id]);
    res.json(revisions);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve revisions' });
  }
});

// GET Fetch All shifts
app.get('/api/shifts', authenticateToken, async (req, res) => {
  try {
    const shifts = await dbAll('SELECT * FROM shifts');
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve shifts' });
  }
});

// POST Create/Update shift
app.post('/api/shifts', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { date, engineer, sector, shift_type } = req.body;
  if (!date || !engineer) {
    return res.status(400).json({ error: 'Date and Engineer are required.' });
  }
  try {
    // Check if shift already exists for this date and sector
    const existing = await dbGet('SELECT id FROM shifts WHERE date = ? AND sector = ?', [date, sector || '']);
    if (existing) {
      await dbRun('UPDATE shifts SET engineer = ?, shift_type = ? WHERE id = ?', [engineer, shift_type || 'Morning', existing.id]);
    } else {
      await dbRun('INSERT INTO shifts (date, engineer, sector, shift_type) VALUES (?, ?, ?, ?)', [date, engineer, sector || '', shift_type || 'Morning']);
    }
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save shift' });
  }
});

// DELETE shift
app.delete('/api/shifts/:id', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  try {
    await dbRun('DELETE FROM shifts WHERE id = ?', [id]);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete shift' });
  }
});

// --- EVALUATION ENDPOINTS ---

// Fetch Evaluations
app.get('/api/evaluations', authenticateToken, async (req, res) => {
  try {
    const list = await dbAll('SELECT * FROM evaluations ORDER BY year DESC, total_points DESC');
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve evaluations' });
  }
});

// Create/Update Evaluation (Admin Only)
app.post('/api/evaluations', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { year, engineer, totalPoints, rating, comments } = req.body;
  if (!year || !engineer || !rating) {
    return res.status(400).json({ error: 'Year, Engineer and Rating are required.' });
  }

  const id = 'eval_' + Date.now();
  const timestamp = new Date().toISOString();

  try {
    const existing = await dbGet('SELECT id FROM evaluations WHERE year = ? AND engineer = ?', [year, engineer]);
    if (existing) {
      await dbRun(
        'UPDATE evaluations SET total_points = ?, rating = ?, comments = ?, approved_by = ?, timestamp = ? WHERE id = ?',
        [parseInt(totalPoints) || 0, rating, comments || '', req.user.username, timestamp, existing.id]
      );
    } else {
      await dbRun(
        'INSERT INTO evaluations (id, year, engineer, total_points, rating, comments, approved_by, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, parseInt(year), engineer, parseInt(totalPoints) || 0, rating, comments || '', req.user.username, timestamp]
      );
    }
    await logActivity(req.user.username, 'Save Evaluation', 'evaluation', year + '_' + engineer, `Approved evaluation for ${engineer} in ${year}: ${rating}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save evaluation: ' + error.message });
  }
});

// Delete Evaluation (Admin Only)
app.delete('/api/evaluations/:id', authenticateToken, requireRole(['admin']), async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet('SELECT * FROM evaluations WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: 'Evaluation not found' });

    await dbRun('DELETE FROM evaluations WHERE id = ?', [id]);
    await logActivity(req.user.username, 'Delete Evaluation', 'evaluation', id, `Deleted evaluation for ${existing.engineer} in ${existing.year}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete evaluation' });
  }
});


// --- OPERATIONAL ADVANCED MODULES API ---

// 1. Intelligent Troubleshooting Recommendation
app.get('/api/entries/recommend-solutions', authenticateToken, async (req, res) => {
  const query = req.query.q || '';
  if (!query.trim()) {
    return res.json([]);
  }
  try {
    const sql = "SELECT title, notes, status, date FROM entries WHERE status = 'Completed' AND (title LIKE ? OR notes LIKE ?) LIMIT 5";
    const results = await dbAll(sql, [`%${query}%`, `%${query}%`]);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Error getting recommendations' });
  }
});

// 2. Digital Shift Handover
app.get('/api/handovers', authenticateToken, async (req, res) => {
  try {
    const results = await dbAll('SELECT * FROM handovers ORDER BY timestamp DESC');
    // Parse active_faults JSON array back to object
    results.forEach(r => {
      r.active_faults = JSON.parse(r.active_faults || '[]');
    });
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve handovers' });
  }
});

app.post('/api/handovers', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { active_faults, general_notes } = req.body;
  const id = 'handover_' + Date.now();
  const timestamp = new Date().toISOString();
  const outgoing = req.user.username;
  
  try {
    const activeFaultsStr = JSON.stringify(active_faults || []);
    await dbRun('INSERT INTO handovers (id, outgoing_engineer, incoming_engineer, active_faults, general_notes, status, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, outgoing, '', activeFaultsStr, general_notes || '', 'Pending Sign-off', timestamp]
    );
    await logActivity(req.user.username, 'Create Handover', 'handover', id, `Created shift handover report`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create handover report' });
  }
});

app.post('/api/handovers/:id/sign', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { id } = req.params;
  const incoming = req.user.username;
  
  try {
    const handover = await dbGet('SELECT * FROM handovers WHERE id = ?', [id]);
    if (!handover) return res.status(404).json({ error: 'Handover report not found' });
    if (handover.status === 'Completed') return res.status(400).json({ error: 'Handover report already signed' });
    if (handover.outgoing_engineer === incoming) return res.status(400).json({ error: 'Outgoing engineer cannot sign-off their own handover' });

    await dbRun("UPDATE handovers SET incoming_engineer = ?, status = 'Completed' WHERE id = ?", [incoming, id]);
    await logActivity(incoming, 'Sign Handover', 'handover', id, `Signed off handover from ${handover.outgoing_engineer}`);
    broadcastToAll({ type: 'db-update' });
    
    await createNotification(
      handover.outgoing_engineer,
      'اعتماد تسليم الوردية (Handover Signed Off)',
      `قام المهندس ${incoming} باعتماد واستلام الوردية منك بنجاح.`
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to sign handover' });
  }
});

// 3. Spare Parts Inventory
app.get('/api/inventory', authenticateToken, async (req, res) => {
  try {
    const parts = await dbAll('SELECT * FROM spare_parts ORDER BY name ASC');
    res.json(parts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve spare parts' });
  }
});

app.post('/api/inventory', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { name, sku, quantity, min_quantity, unit } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  
  const id = 'part_' + Date.now();
  try {
    await dbRun('INSERT INTO spare_parts (id, name, sku, quantity, min_quantity, unit) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name.trim(), sku || '', parseInt(quantity) || 0, parseInt(min_quantity) || 5, unit || 'pcs']
    );
    
    if (parseInt(quantity) > 0) {
      await dbRun('INSERT INTO part_transactions (id, part_id, entry_id, type, quantity, username, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['tx_' + Date.now(), id, '', 'IN', parseInt(quantity) || 0, req.user.username, new Date().toISOString()]
      );
    }
    
    await logActivity(req.user.username, 'Add Spare Part', 'spare_part', id, `Added spare part: ${name}`);
    broadcastToAll({ type: 'db-update' });
    res.json({ success: true, id });
  } catch (error) {
    res.status(500).json({ error: 'Spare part name already exists or server error' });
  }
});

app.post('/api/inventory/adjust', authenticateToken, requireRole(['admin', 'editor']), async (req, res) => {
  const { partId, type, quantity, notes } = req.body;
  if (!partId || !type || !quantity) return res.status(400).json({ error: 'Part ID, type and quantity are required' });
  
  try {
    const part = await dbGet('SELECT * FROM spare_parts WHERE id = ?', [partId]);
    if (!part) return res.status(404).json({ error: 'Spare part not found' });
    
    const qtyVal = parseInt(quantity);
    if (qtyVal <= 0) return res.status(400).json({ error: 'Quantity must be positive' });
    
    let newQty = part.quantity;
    if (type === 'IN') {
      newQty += qtyVal;
    } else if (type === 'OUT') {
      if (part.quantity < qtyVal) return res.status(400).json({ error: 'Insufficient stock in inventory' });
      newQty -= qtyVal;
    } else {
      return res.status(400).json({ error: 'Invalid adjustment type' });
    }
    
    await dbRun('UPDATE spare_parts SET quantity = ? WHERE id = ?', [newQty, partId]);
    
    const txId = 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    await dbRun('INSERT INTO part_transactions (id, part_id, entry_id, type, quantity, username, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [txId, partId, '', type, qtyVal, req.user.username, new Date().toISOString()]
    );
    
    await logActivity(req.user.username, 'Adjust Inventory', 'spare_part', partId, `Adjusted ${part.name} quantity by ${type === 'IN' ? '+' : '-'}${qtyVal}. Notes: ${notes || ''}`);
    broadcastToAll({ type: 'db-update' });
    
    if (type === 'OUT' && newQty <= part.min_quantity) {
      sendTelegramNotification(`⚠️ <b>تنبيه مخزن قطع الغيار:</b>\nرصيد قطعة الغيار <b>${part.name}</b> شارف على النفاد!\nالكمية الحالية: ${newQty} ${part.unit} (الحد الأدنى: ${part.min_quantity})`);
    }

    res.json({ success: true, newQuantity: newQty });
  } catch (error) {
    res.status(500).json({ error: 'Database error adjusting stock' });
  }
});

app.get('/api/inventory/transactions', authenticateToken, async (req, res) => {
  try {
    const txs = await dbAll(`
      SELECT t.*, p.name as part_name, p.unit
      FROM part_transactions t
      JOIN spare_parts p ON t.part_id = p.id
      ORDER BY t.timestamp DESC LIMIT 100
    `);
    res.json(txs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});


// Auto-Shutdown Heartbeat Mechanism (Disabled for standalone server deployment)
let lastHeartbeat = Date.now() + 180000; // 3 minutes grace period for server to boot and client to load

app.post('/api/heartbeat', (req, res) => {
  lastHeartbeat = Date.now();
  res.json({ success: true });
});

// setInterval(() => {
//   const inactiveTime = Date.now() - lastHeartbeat;
//   if (inactiveTime > 120000) { // Shut down if no heartbeat for > 120s (2 minutes)
//     console.log(`[Heartbeat] No active clients detected. Auto-shutting down server...`);
//     process.exit(0);
//   }
// }, 30000); // Check every 30s

// Start Server with HTTPS (Auto-generated self-signed certificates)
(async () => {
  const disableSsl = process.env.DISABLE_SSL === 'true';
  const keyPath = path.join(__dirname, 'key.pem');
  const certPath = path.join(__dirname, 'cert.pem');
  let credentials = null;

  if (!disableSsl) {
    try {
      if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        console.log('[HTTPS] SSL certificates not found. Generating self-signed certificates...');
        const selfsigned = require('selfsigned');
        const attrs = [{ name: 'commonName', value: 'localhost' }];
        const pems = await selfsigned.generate(attrs, { days: 365 });
        fs.writeFileSync(keyPath, pems.private, 'utf8');
        fs.writeFileSync(certPath, pems.cert, 'utf8');
        console.log('[HTTPS] Self-signed certificates generated and saved successfully.');
      }

      const privateKey = fs.readFileSync(keyPath, 'utf8');
      const certificate = fs.readFileSync(certPath, 'utf8');
      credentials = { key: privateKey, cert: certificate };
      console.log('[HTTPS] SSL certificates loaded successfully.');
    } catch (err) {
      console.error('[HTTPS] Failed to configure SSL:', err.message);
      console.log('[HTTPS] Falling back to standard HTTP.');
    }
  } else {
    console.log('[HTTP] SSL disabled by DISABLE_SSL environment variable.');
  }

  let server;
  if (credentials) {
    server = https.createServer(credentials, app);
    server.listen(PORT, () => {
      console.log(`Backend server is running on HTTPS: https://localhost:${PORT}`);
    });
  } else {
    server = app.listen(PORT, () => {
      console.log(`Backend server is running on HTTP: http://localhost:${PORT}`);
    });
  }

  // WebSocket Server for Group Chat and WebRTC signaling
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    clients.set(ws, { ws, username: null, roomId: null, voiceRoomId: null });

    ws.on('message', async (messageStr) => {
      try {
        const data = JSON.parse(messageStr);
        const clientInfo = clients.get(ws);

        if (data.type === 'join') {
          clientInfo.username = data.username;
          clientInfo.roomId = data.roomId || 'general';
          return;
        }

        if (data.type === 'message') {
          if (!clientInfo.username || !clientInfo.roomId) return;
          const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
          const timestamp = new Date().toISOString();
          await dbRun(
            'INSERT INTO group_chats (id, room_id, username, message, timestamp) VALUES (?, ?, ?, ?, ?)',
            [msgId, clientInfo.roomId, clientInfo.username, data.message, timestamp]
          );

          const outMessage = JSON.stringify({
            type: 'message',
            roomId: clientInfo.roomId,
            username: clientInfo.username,
            message: data.message,
            timestamp
          });

          for (const [c, info] of clients.entries()) {
            if (info.roomId === clientInfo.roomId && c.readyState === WebSocket.OPEN) {
              c.send(outMessage);
            }
          }
          return;
        }

        // --- WEBRTC SIGNALLING ---
        if (data.type === 'voice-join') {
          clientInfo.voiceRoomId = data.voiceRoomId;
          
          // Notify other peers in this room that a new peer joined
          broadcastToVoiceRoom(clientInfo.voiceRoomId, ws, {
            type: 'peer-joined',
            peerId: clientInfo.username
          });
          
          // Send current list of participants in this voice room to the new joiner
          const peers = [];
          for (const [c, info] of clients.entries()) {
            if (info.voiceRoomId === clientInfo.voiceRoomId && c !== ws && info.username) {
              peers.push(info.username);
            }
          }
          ws.send(JSON.stringify({ type: 'voice-peers', peers }));
          return;
        }

        if (data.type === 'voice-leave') {
          const oldRoom = clientInfo.voiceRoomId;
          clientInfo.voiceRoomId = null;
          if (oldRoom) {
            broadcastToVoiceRoom(oldRoom, ws, {
              type: 'peer-left',
              peerId: clientInfo.username
            });
          }
          return;
        }

        if (data.type === 'signal') {
          const targetUsername = data.target;
          for (const [c, info] of clients.entries()) {
            if (info.username === targetUsername && info.voiceRoomId === clientInfo.voiceRoomId && c.readyState === WebSocket.OPEN) {
              c.send(JSON.stringify({
                type: 'signal',
                sender: clientInfo.username,
                signal: data.signal
              }));
              break;
            }
          }
          return;
        }

      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    });

    ws.on('close', () => {
      const clientInfo = clients.get(ws);
      if (clientInfo) {
        if (clientInfo.voiceRoomId) {
          broadcastToVoiceRoom(clientInfo.voiceRoomId, ws, {
            type: 'peer-left',
            peerId: clientInfo.username
          });
        }
        clients.delete(ws);
      }
    });
  });
})();

function broadcastToVoiceRoom(voiceRoomId, senderWs, payload) {
  const message = JSON.stringify(payload);
  for (const [c, info] of clients.entries()) {
    if (info.voiceRoomId === voiceRoomId && c !== senderWs && c.readyState === WebSocket.OPEN) {
      c.send(message);
    }
  }
}

// --- BACKGROUND PM TEMPLATE TASK SPARK ENGINE ---

async function checkAndSpawnPreventiveTasks() {
  console.log('[PM Scheduler] Checking preventive maintenance templates...');
  try {
    const templates = await dbAll('SELECT * FROM preventive_templates');
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    
    for (const temp of templates) {
      let shouldSpawn = false;
      
      if (!temp.last_generated) {
        shouldSpawn = true;
      } else {
        const lastGen = new Date(temp.last_generated);
        const diffMs = today - lastGen;
        const diffDays = diffMs / (1000 * 60 * 60 * 24);
        
        if (temp.frequency === 'Daily' && diffDays >= 1) {
          shouldSpawn = true;
        } else if (temp.frequency === 'Weekly' && diffDays >= 7) {
          shouldSpawn = true;
        } else if (temp.frequency === 'Monthly' && diffDays >= 30) {
          shouldSpawn = true;
        }
      }
      
      if (shouldSpawn) {
        const entryId = 'entry_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        
        await dbRun(`INSERT INTO entries (id, title, dept_id, cat_id, sub_id, item_id, date, status, priority, progress, notes, files, assigned_to, subtasks, due_date, blocked_by) 
          VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', ?, 0, ?, '[]', ?, '[]', '', '')`,
          [
            entryId,
            `[Preventive] ${temp.title}`,
            temp.dept_id,
            temp.cat_id || '',
            temp.sub_id || '',
            temp.item_id || '',
            todayStr,
            temp.priority || 'Medium',
            temp.notes || '',
            temp.assigned_to || ''
          ]
        );
        
        await dbRun('UPDATE preventive_templates SET last_generated = ? WHERE id = ?', [todayStr, temp.id]);
        await logActivity('System', 'Spawn PM Task', 'entry', entryId, `Automatically spawned preventive task: ${temp.title}`);
        
        if (temp.assigned_to) {
          await createNotification(
            temp.assigned_to,
            'مهمة صيانة وقائية جديدة (New PM Task Assigned)',
            `تم توليد مهمة صيانة وقائية تلقائياً وإسنادها إليك: "${temp.title}"`
          );
          await sendEmailAlert(
            temp.assigned_to,
            'مهمة صيانة وقائية جديدة (New PM Task Assigned)',
            `تم توليد مهمة صيانة وقائية جديدة تلقائياً في القطاع وإسنادها إليك: "${temp.title}"`
          );
        }
        
        console.log(`[PM Scheduler] Spawning preventive task for template: ${temp.title}`);
      }
    }
    
    broadcastToAll({ type: 'db-update' });
    
  } catch (err) {
    console.error('[PM Scheduler] Error in PM Spawner:', err);
  }
}

// Start PM Scheduler check on startup and check every 12 hours
setTimeout(checkAndSpawnPreventiveTasks, 5000); // 5 seconds after startup
setInterval(checkAndSpawnPreventiveTasks, 12 * 60 * 60 * 1000); // every 12 hours

// --- AUTOMATIC DATABASE BACKUP MECHANISM ---

function runAutomaticBackup() {
  const backupsDir = path.join(__dirname, 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir);
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `db_backup_${timestamp}.db`;
  const backupPath = path.join(backupsDir, backupFileName);
  const sourcePath = path.join(__dirname, 'data.db');
  
  if (!fs.existsSync(sourcePath)) {
    console.log('[Auto-Backup] Source database file data.db does not exist yet.');
    return;
  }
  
  fs.copyFile(sourcePath, backupPath, async (err) => {
    if (err) {
      console.error('[Auto-Backup] Failed to create automatic backup:', err);
      return;
    }
    console.log(`[Auto-Backup] Automatic backup created successfully: ${backupFileName}`);
    await logActivity('System', 'Automatic Backup', 'system', 'backup', `Database backed up automatically to ${backupFileName}`);
    
    // Clean up old backups (keep only the last 15 backups)
    cleanUpOldBackups(backupsDir, 15);
  });
}

function cleanUpOldBackups(backupsDir, maxBackups = 15) {
  fs.readdir(backupsDir, (err, files) => {
    if (err) {
      console.error('[Auto-Backup] Failed to read backups directory for cleanup:', err);
      return;
    }
    
    // Filter for files starting with 'db_backup_' and ending with '.db'
    const backupFiles = files
      .filter(f => f.startsWith('db_backup_') && f.endsWith('.db'))
      .map(f => {
        const filePath = path.join(backupsDir, f);
        const stat = fs.statSync(filePath);
        return { name: f, path: filePath, mtime: stat.mtime };
      });
      
    // Sort by modified time ascending (oldest first)
    backupFiles.sort((a, b) => a.mtime - b.mtime);
    
    if (backupFiles.length > maxBackups) {
      const filesToDelete = backupFiles.slice(0, backupFiles.length - maxBackups);
      filesToDelete.forEach(file => {
        fs.unlink(file.path, (err) => {
          if (err) {
            console.error(`[Auto-Backup] Failed to delete old backup file ${file.name}:`, err);
          } else {
            console.log(`[Auto-Backup] Deleted old backup file: ${file.name}`);
          }
        });
      });
    }
  });
}

// Schedule automatic backups: once 10 seconds after startup, and then every 24 hours
setTimeout(runAutomaticBackup, 10000); 
setInterval(runAutomaticBackup, 24 * 60 * 60 * 1000);

