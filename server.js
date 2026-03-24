// ─── IMPORTS & CONSTANTS ─────────────────────────────────────────────────────
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = path.join(__dirname, 'storage');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
const DB_PATH = path.join(STORAGE_DIR, 'capsen.db');
const HOUSE_PASSWORD = process.env.HOUSE_PASSWORD || 'change-me';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
const SESSION_COOKIE = 'capsen_session';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const DRIVE_PHOTOS = process.env.GOOGLE_DRIVE_PHOTOS_FOLDER_ID || '';
const DRIVE_BACKUP = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || '';
// TODO: Google Drive API integration for photo sync and DB backup
// Photos folder ID: DRIVE_PHOTOS
// Backup folder ID: DRIVE_BACKUP

// ─── NODEMAILER ──────────────────────────────────────────────────────────────
const transporter = SMTP_USER ? nodemailer.createTransport({
  service: 'gmail',
  auth: { user: SMTP_USER, pass: SMTP_PASS }
}) : null;

// ─── STARTUP: ensure dirs + icons ────────────────────────────────────────────
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });

// TODO: replace icon-192.png and icon-512.png with real Capsen icons
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
['icon-192.png', 'icon-512.png'].forEach(name => {
  const p = path.join(__dirname, 'public', name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, MINIMAL_PNG);
});

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#22c55e',
    avatar_path TEXT,
    email TEXT,
    notify_mode TEXT NOT NULL DEFAULT 'none',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    winner_profile_id INTEGER REFERENCES profiles(id),
    created_by_profile_id INTEGER REFERENCES profiles(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    played_at TEXT NOT NULL,
    notes TEXT,
    photo_path TEXT,
    overtime INTEGER NOT NULL DEFAULT 0,
    created_by_profile_id INTEGER REFERENCES profiles(id),
    tournament_id INTEGER REFERENCES tournaments(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS match_sides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    side_name TEXT NOT NULL,
    is_winner INTEGER NOT NULL DEFAULT 0,
    cups_remaining INTEGER
  );
  CREATE TABLE IF NOT EXISTS match_side_members (
    side_id INTEGER NOT NULL REFERENCES match_sides(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (side_id, profile_id)
  );
  CREATE TABLE IF NOT EXISTS tournament_participants (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    PRIMARY KEY (tournament_id, profile_id)
  );
  CREATE TABLE IF NOT EXISTS tournament_matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    position INTEGER NOT NULL,
    match_id INTEGER REFERENCES matches(id),
    side1_profile_ids TEXT,
    side2_profile_ids TEXT,
    side1_name TEXT,
    side2_name TEXT,
    winner_side INTEGER,
    next_match_id INTEGER REFERENCES tournament_matches(id)
  );
`);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function hashToken(token) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(token).digest('hex');
}

function issueSession(res, profileId) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = hashToken(token);
  db.prepare('INSERT INTO sessions (token_hash, profile_id) VALUES (?, ?)').run(hash, profileId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 90 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSession(req, res) {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

function redirectWithMessage(res, url, msg) {
  const sep = url.includes('?') ? '&' : '?';
  res.redirect(url + sep + 'msg=' + encodeURIComponent(msg));
}

function avatarHtml(profile, size = 32) {
  if (profile && profile.avatar_path) {
    return `<img src="${escapeHtml(profile.avatar_path)}" alt="${escapeHtml(profile.name)}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:2px solid ${escapeHtml(profile.color)};">`;
  }
  const color = (profile && profile.color) || '#22c55e';
  const letter = (profile && profile.name) ? profile.name[0].toUpperCase() : '?';
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${escapeHtml(color)};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;color:#060d18;flex-shrink:0;">${letter}</div>`;
}

function profileNamesFromIds(ids) {
  if (!ids) return 'TBD';
  const arr = ids.split(',').map(Number).filter(Boolean);
  if (arr.length === 0) return 'TBD';
  return arr.map(id => {
    const p = db.prepare('SELECT name FROM profiles WHERE id = ?').get(id);
    return p ? escapeHtml(p.name) : '?';
  }).join(', ');
}

function getProfilesFromIds(ids) {
  if (!ids) return [];
  const arr = ids.split(',').map(Number).filter(Boolean);
  return arr.map(id => db.prepare('SELECT * FROM profiles WHERE id = ?').get(id)).filter(Boolean);
}

// ─── MULTER SETUP ────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, crypto.randomBytes(12).toString('hex') + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Nur Bilder erlaubt'));
  }
});

// ─── EXPRESS APP ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── SESSION MIDDLEWARE ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.currentUser = null;
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    const hash = hashToken(token);
    const session = db.prepare('SELECT profile_id FROM sessions WHERE token_hash = ?').get(hash);
    if (session) {
      req.currentUser = db.prepare('SELECT * FROM profiles WHERE id = ?').get(session.profile_id);
      db.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?').run(hash);
    }
  }
  next();
});

function requireUser(req, res, next) {
  if (!req.currentUser) return res.redirect('/login?msg=' + encodeURIComponent('Bitte einloggen'));
  next();
}

// ─── RATE LIMITER (avatar upload) ────────────────────────────────────────────
const uploadRateMap = new Map();
function avatarRateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  if (!uploadRateMap.has(ip)) uploadRateMap.set(ip, []);
  const hits = uploadRateMap.get(ip).filter(t => now - t < 60000);
  if (hits.length >= 10) {
    return res.status(429).json({ error: 'Zu viele Uploads, bitte warten.' });
  }
  hits.push(now);
  uploadRateMap.set(ip, hits);
  next();
}

// ─── LAYOUT ──────────────────────────────────────────────────────────────────
function layout(req, title, body, flash = '') {
  const user = req.currentUser;
  const flashMsg = flash || (req.query && req.query.msg) || '';
  const navItems = [
    { href: '/', icon: '🏠', label: 'Home' },
    { href: '/matches', icon: '🎮', label: 'Spiele' },
    { href: '/matches/new', icon: '➕', label: 'Neu' },
    { href: '/leaderboard', icon: '🏆', label: 'Leaderboard' },
    { href: '/tournaments', icon: '🥊', label: 'Turniere' },
    { href: '/profiles', icon: '👤', label: 'Profile' },
  ];
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#09111f">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;700&display=swap" rel="stylesheet">
  <title>${escapeHtml(title)} – Capsen</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #060d18;
      --panel: rgba(255,255,255,0.04);
      --panel-solid: #0d1a2d;
      --panel-2: rgba(255,255,255,0.07);
      --text: #f0f4f8;
      --muted: #7a8fa6;
      --line: rgba(255,255,255,0.08);
      --green: #00ff87;
      --green-dim: rgba(0,255,135,0.15);
      --blue: #38bdf8;
      --orange: #ff6b35;
      --danger: #ff4444;
      --gold: #ffd700;
    }
    html { background: var(--bg); }
    body {
      font-family: 'DM Sans', sans-serif;
      color: var(--text);
      background: var(--bg);
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    h1, h2, h3 { font-family: 'Bebas Neue', cursive; letter-spacing: 0.04em; font-weight: 400; }
    h1 { font-size: 2rem; }
    h2 { font-size: 1.5rem; }
    a { color: var(--blue); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* Nav */
    .nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(6,13,24,0.85);
      backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border-bottom: 1px solid var(--line);
      padding: 0 12px;
    }
    .nav-inner {
      max-width: 900px; margin: 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      height: 56px;
    }
    .nav-brand { font-family: 'Bebas Neue', cursive; font-size: 1.4rem; color: var(--green); }
    .nav-links { display: flex; gap: 2px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    .nav-links a {
      display: flex; flex-direction: column; align-items: center; gap: 1px;
      padding: 6px 10px; border-radius: 10px; font-size: 10px; color: var(--muted);
      white-space: nowrap; text-decoration: none; min-width: 48px; min-height: 48px;
      justify-content: center;
    }
    .nav-links a:hover, .nav-links a.active { color: var(--green); background: var(--green-dim); }
    .nav-links .nav-icon { font-size: 18px; }
    .nav-auth {
      display: flex; align-items: center; gap: 8px; flex-shrink: 0;
    }
    .nav-auth .user-pill {
      display: flex; align-items: center; gap: 6px; padding: 4px 10px 4px 4px;
      border-radius: 20px; background: var(--panel-2); font-size: 13px;
      color: var(--text); text-decoration: none;
    }

    /* Main */
    .main { max-width: 900px; margin: 0 auto; padding: 20px 16px 80px; }

    /* Cards */
    .card {
      background: var(--panel);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }

    /* Buttons */
    .button, button[type="submit"] {
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      background: var(--green); color: #060d18; font-weight: 700;
      border: none; border-radius: 12px; padding: 12px 24px;
      font-size: 15px; cursor: pointer; min-height: 48px;
      font-family: 'DM Sans', sans-serif; text-decoration: none;
      transition: opacity 0.15s;
    }
    .button:hover, button[type="submit"]:hover { opacity: 0.9; text-decoration: none; }
    .ghost {
      background: transparent; border: 1px solid var(--line);
      color: var(--text); font-weight: 500;
    }
    .ghost:hover { background: var(--panel-2); }
    .danger-btn { background: var(--danger); color: #fff; }
    .small-btn { padding: 6px 14px; font-size: 13px; min-height: 36px; border-radius: 8px; }

    /* Forms */
    input[type="text"], input[type="email"], input[type="password"],
    input[type="number"], input[type="datetime-local"],
    textarea, select {
      width: 100%; padding: 12px 14px;
      background: var(--panel-2); border: 1px solid var(--line);
      border-radius: 12px; color: var(--text);
      font-family: 'DM Sans', sans-serif; font-size: 15px;
      min-height: 48px; outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--green);
      box-shadow: 0 0 0 3px rgba(0,255,135,0.15);
    }
    textarea { min-height: 80px; resize: vertical; }
    label { display: block; font-size: 14px; color: var(--muted); margin-bottom: 6px; font-weight: 500; }
    .form-group { margin-bottom: 16px; }

    /* Color input */
    input[type="color"] {
      width: 48px; height: 48px; border: 2px solid var(--line);
      border-radius: 12px; padding: 2px; background: transparent; cursor: pointer;
    }

    /* Flash */
    .flash {
      background: var(--green-dim); border: 1px solid var(--green);
      color: var(--green); padding: 12px 16px; border-radius: 12px;
      margin-bottom: 16px; font-size: 14px;
    }

    /* Mode cards */
    .mode-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .mode-card {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 6px; padding: 20px 12px; border-radius: 16px;
      background: var(--panel); border: 2px solid var(--line);
      cursor: pointer; min-height: 100px; text-align: center;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .mode-card:hover { border-color: rgba(0,255,135,0.3); }
    .mode-card.selected {
      border-color: var(--green);
      box-shadow: 0 0 20px rgba(0,255,135,0.15);
    }
    .mode-card .mode-icon { font-size: 32px; }
    .mode-card .mode-label { font-family: 'Bebas Neue', cursive; font-size: 1.1rem; }
    .mode-card .mode-desc { font-size: 12px; color: var(--muted); }

    /* Stats bar */
    .stats-bar {
      display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px;
      -webkit-overflow-scrolling: touch; margin-bottom: 20px;
    }
    .stat-card {
      flex-shrink: 0; padding: 16px 20px; border-radius: 16px;
      background: var(--panel); border: 1px solid var(--line);
      min-width: 120px; text-align: center;
    }
    .stat-value {
      font-family: 'Bebas Neue', cursive; font-size: 2rem;
      color: var(--green); line-height: 1;
    }
    .stat-label { font-size: 12px; color: var(--muted); margin-top: 4px; }

    /* Match card */
    .match-card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; padding: 14px; margin-bottom: 10px;
    }
    .match-card .match-meta { font-size: 12px; color: var(--muted); margin-bottom: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .match-card .match-sides { display: flex; align-items: center; gap: 10px; }
    .match-card .match-side {
      flex: 1; display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 10px; background: var(--panel-2);
    }
    .match-card .match-vs { font-family: 'Bebas Neue', cursive; color: var(--muted); font-size: 1.1rem; }
    .match-card .winner-side {
      background: var(--green-dim); border: 1px solid rgba(0,255,135,0.2);
    }
    .winner-text { color: var(--green); text-shadow: 0 0 20px rgba(0,255,135,0.5); font-weight: 700; }

    /* Badge */
    .badge {
      display: inline-block; padding: 3px 10px; border-radius: 6px;
      font-size: 11px; font-weight: 700; text-transform: uppercase;
    }
    .badge-1v1 { background: rgba(56,189,248,0.15); color: var(--blue); }
    .badge-2v2 { background: rgba(255,107,53,0.15); color: var(--orange); }
    .badge-flipcup { background: rgba(255,215,0,0.15); color: var(--gold); }
    .badge-tournament { background: var(--green-dim); color: var(--green); }
    .badge-active { background: var(--green-dim); color: var(--green); }
    .badge-finished { background: var(--panel-2); color: var(--muted); }
    .badge-overtime { background: rgba(255,107,53,0.15); color: var(--orange); }

    /* Player chips */
    .player-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .player-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px 2px 2px; border-radius: 20px;
      background: var(--panel-2); font-size: 13px;
    }

    /* Leaderboard table */
    .lb-table { width: 100%; border-collapse: collapse; }
    .lb-table th { text-align: left; padding: 10px 12px; color: var(--muted); font-size: 12px; font-weight: 500; border-bottom: 1px solid var(--line); }
    .lb-table td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-size: 14px; }
    .lb-table tr:hover { background: var(--panel-2); }

    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; overflow-x: auto; }
    .tab {
      padding: 10px 18px; border-radius: 10px;
      font-weight: 500; font-size: 14px; cursor: pointer;
      background: var(--panel); color: var(--muted);
      text-decoration: none; white-space: nowrap; min-height: 48px;
      display: flex; align-items: center;
    }
    .tab.active { background: var(--green-dim); color: var(--green); }

    /* Bracket */
    .bracket { display: flex; gap: 24px; overflow-x: auto; padding: 20px 0; -webkit-overflow-scrolling: touch; }
    .bracket-round { display: flex; flex-direction: column; gap: 16px; min-width: 220px; }
    .bracket-label { font-family: 'Bebas Neue', cursive; color: var(--muted); font-size: 1.1rem; margin-bottom: 8px; text-align: center; }
    .bracket-match {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 12px; padding: 12px; min-height: 80px;
      display: flex; flex-direction: column; gap: 6px; justify-content: center;
    }
    .bracket-side { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 13px; }
    .bracket-side.winner { color: var(--green); font-weight: 700; }
    .bracket-side.tbd { color: var(--muted); font-style: italic; }

    /* Profile grid */
    .profile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
    .profile-card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 16px; padding: 16px; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 8px;
    }

    /* Checkbox/radio grid */
    .check-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
    .check-item {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; border-radius: 12px;
      background: var(--panel); border: 1px solid var(--line);
      cursor: pointer; min-height: 48px;
    }
    .check-item:has(input:checked) { border-color: var(--green); background: var(--green-dim); }
    .check-item input { accent-color: var(--green); width: 18px; height: 18px; }

    /* Winner radio */
    .winner-radio { display: flex; gap: 10px; margin: 12px 0; }
    .winner-option {
      flex: 1; padding: 14px; border-radius: 14px; text-align: center;
      background: var(--panel); border: 2px solid var(--line);
      cursor: pointer; min-height: 56px;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      font-weight: 600;
    }
    .winner-option:has(input:checked) {
      border-color: var(--green); background: var(--green-dim); color: var(--green);
    }
    .winner-option input { display: none; }

    /* Filter bar */
    .filter-bar { display: flex; gap: 6px; margin-bottom: 16px; overflow-x: auto; }

    /* Subtle text */
    .subtle { color: var(--muted); font-size: 14px; }

    /* Pagination */
    .pagination { display: flex; gap: 8px; justify-content: center; margin-top: 20px; }

    /* Responsive */
    @media (max-width: 640px) {
      .mode-grid { grid-template-columns: 1fr 1fr; }
      .match-card .match-sides { flex-direction: column; }
      .match-card .match-vs { display: none; }
      .winner-radio { flex-direction: column; }
      .nav-links a { padding: 6px 7px; font-size: 9px; }
      h1 { font-size: 1.6rem; }
    }
  </style>
</head>
<body>
  ${user ? `
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="nav-brand">🏓 Capsen</a>
      <div class="nav-links">
        ${navItems.map(n => `<a href="${n.href}"><span class="nav-icon">${n.icon}</span>${n.label}</a>`).join('')}
      </div>
      <div class="nav-auth">
        <a href="/settings" class="user-pill">${avatarHtml(user, 20)}<span>${escapeHtml(user.name)}</span></a>
      </div>
    </div>
  </nav>` : ''}
  <main class="main">
    ${flashMsg ? `<div class="flash">${escapeHtml(flashMsg)}</div>` : ''}
    ${body}
  </main>
</body>
</html>`;
}

// ─── CROPPER HEAD SNIPPET ────────────────────────────────────────────────────
function cropperHead() {
  return `<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.5.13/cropper.min.js"><\/script>`;
}

function cropperSection() {
  return `
<div class="form-group avatar-upload-section">
  <label>Profilbild</label>
  <input type="file" id="avatar-file-input" accept="image/*" style="min-height:48px;" />
  <div id="crop-modal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:1000; align-items:center; justify-content:center; padding:20px;">
    <div style="background:#0d1a2d; border-radius:20px; padding:20px; max-width:380px; width:100%;">
      <h3 style="margin:0 0 12px; font-family:'Bebas Neue';">Bild zuschneiden</h3>
      <div style="height:280px; overflow:hidden; border-radius:12px;">
        <img id="crop-image" style="max-width:100%; display:block;" />
      </div>
      <div style="display:flex; gap:10px; margin-top:12px;">
        <button type="button" id="crop-cancel" class="button ghost" style="flex:1;">Abbrechen</button>
        <button type="button" id="crop-confirm" class="button" style="flex:1;">✓ Bestätigen</button>
      </div>
    </div>
  </div>
  <div id="avatar-preview" style="margin:8px 0;"></div>
  <input type="hidden" name="avatarPath" id="avatar-path-input" />
</div>`;
}

function cropperScript() {
  return `<script>
(function() {
  var cropper = null;
  var fileInput = document.getElementById('avatar-file-input');
  var modal = document.getElementById('crop-modal');
  var cropImage = document.getElementById('crop-image');
  var confirmBtn = document.getElementById('crop-confirm');
  var cancelBtn = document.getElementById('crop-cancel');
  var preview = document.getElementById('avatar-preview');
  var pathInput = document.getElementById('avatar-path-input');

  fileInput.addEventListener('change', function(e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      cropImage.src = ev.target.result;
      modal.style.display = 'flex';
      if (cropper) cropper.destroy();
      setTimeout(function() {
        cropper = new Cropper(cropImage, { aspectRatio: 1, viewMode: 2, background: false, autoCropArea: 1 });
      }, 100);
    };
    reader.readAsDataURL(file);
  });

  cancelBtn.addEventListener('click', function() {
    modal.style.display = 'none';
    if (cropper) { cropper.destroy(); cropper = null; }
    fileInput.value = '';
  });

  confirmBtn.addEventListener('click', function() {
    if (!cropper) return;
    confirmBtn.textContent = '⏳';
    confirmBtn.disabled = true;
    cropper.getCroppedCanvas({ width: 300, height: 300 }).toBlob(function(blob) {
      var fd = new FormData();
      fd.append('avatar', blob, 'avatar.jpg');
      fetch('/profiles/avatar-upload', { method: 'POST', body: fd })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.path) {
            pathInput.value = data.path;
            var url = URL.createObjectURL(blob);
            preview.innerHTML = '<img src="' + url + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:2px solid #00ff87;" />';
          }
        })
        .catch(function(err) { console.error('Upload failed', err); })
        .finally(function() {
          modal.style.display = 'none';
          if (cropper) { cropper.destroy(); cropper = null; }
          confirmBtn.textContent = '✓ Bestätigen';
          confirmBtn.disabled = false;
        });
    }, 'image/jpeg', 0.85);
  });
})();
<\/script>`;
}

// ─── LAYOUT WITH CROPPER ────────────────────────────────────────────────────
function layoutWithCropper(req, title, body, flash = '') {
  const html = layout(req, title, body, flash);
  return html.replace('</head>', cropperHead() + '</head>');
}

// ─── MODE BADGE ──────────────────────────────────────────────────────────────
function modeBadge(mode) {
  const map = {
    '1v1': ['1v1', 'badge-1v1'],
    '2v2': ['2v2', 'badge-2v2'],
    'flipcup': ['Flip Cup', 'badge-flipcup'],
    'tournament': ['Turnier', 'badge-tournament'],
  };
  const [label, cls] = map[mode] || [mode, ''];
  return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, db: 'ok', uptime: process.uptime() });
});

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  const html = `
    <div style="max-width:400px;margin:60px auto;text-align:center;">
      <h1 style="color:var(--green);margin-bottom:8px;">🏓 Capsen</h1>
      <p class="subtle" style="margin-bottom:24px;">Wähle dein Profil</p>
      <form method="POST" action="/login">
        <div class="form-group">
          <label>Hauspasswort</label>
          <input type="password" name="housePassword" required placeholder="Passwort eingeben" />
        </div>
        <div class="form-group">
          <label>Profil</label>
          ${profiles.length > 0 ? `
          <div class="check-grid" style="margin-bottom:12px;">
            ${profiles.map(p => `
              <label class="check-item">
                <input type="radio" name="profileId" value="${p.id}" required />
                ${avatarHtml(p, 24)}
                <span>${escapeHtml(p.name)}</span>
              </label>
            `).join('')}
          </div>` : '<p class="subtle">Noch keine Profile vorhanden.</p>'}
        </div>
        <button type="submit" style="width:100%;margin-bottom:12px;">Einloggen</button>
      </form>
      <a href="/profiles/new" class="button ghost" style="width:100%;display:flex;">Neues Profil erstellen</a>
    </div>
  `;
  res.send(layout(req, 'Login', html));
});

app.post('/login', (req, res) => {
  const { housePassword, profileId } = req.body;
  if (housePassword !== HOUSE_PASSWORD) {
    return res.redirect('/login?msg=' + encodeURIComponent('Falsches Passwort'));
  }
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(profileId));
  if (!profile) {
    return res.redirect('/login?msg=' + encodeURIComponent('Profil nicht gefunden'));
  }
  issueSession(res, profile.id);
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  clearSession(req, res);
  res.redirect('/login?msg=' + encodeURIComponent('Tschüss!'));
});

// ─── PROFILES ────────────────────────────────────────────────────────────────
app.get('/profiles', requireUser, (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  const html = `
    <div class="card-header"><h1>👤 Profile</h1></div>
    <div class="profile-grid">
      ${profiles.map(p => `
        <div class="profile-card">
          ${avatarHtml(p, 56)}
          <div style="font-weight:600;">${escapeHtml(p.name)}</div>
          <div style="width:12px;height:12px;border-radius:50%;background:${escapeHtml(p.color)};"></div>
          ${p.email ? '<div class="subtle" style="font-size:11px;">📧 E-Mail</div>' : ''}
          <span class="badge" style="background:var(--panel-2);color:var(--muted);font-size:10px;">${escapeHtml(p.notify_mode)}</span>
          <a href="/profiles/${p.id}/edit" class="button ghost small-btn" style="width:100%;margin-top:4px;">Bearbeiten</a>
        </div>
      `).join('')}
    </div>
  `;
  res.send(layout(req, 'Profile', html));
});

app.get('/profiles/new', (req, res) => {
  const html = `
    <div style="max-width:440px;margin:0 auto;">
      <h1 style="margin-bottom:16px;">Neues Profil</h1>
      <form method="POST" action="/profiles" enctype="multipart/form-data">
        <div class="form-group">
          <label>Hauspasswort</label>
          <input type="password" name="housePassword" required />
        </div>
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required minlength="2" placeholder="Dein Name" />
        </div>
        <div class="form-group">
          <label>Farbe</label>
          <input type="color" name="color" value="#22c55e" />
        </div>
        ${cropperSection()}
        <div class="form-group">
          <label>E-Mail (optional)</label>
          <input type="email" name="email" placeholder="deine@email.de" />
        </div>
        <div class="form-group">
          <label>Benachrichtigungen</label>
          <select name="notify_mode">
            <option value="none">Keine E-Mails</option>
            <option value="all">Alle Ergebnisse</option>
            <option value="mine">Nur meine Spiele</option>
            <option value="weekly">Wöchentliche Top 3</option>
          </select>
        </div>
        <button type="submit" style="width:100%;">Profil erstellen</button>
      </form>
      <a href="/login" class="button ghost" style="width:100%;margin-top:12px;display:flex;">Zurück zum Login</a>
    </div>
    ${cropperScript()}
  `;
  res.send(layoutWithCropper(req, 'Neues Profil', html));
});

app.post('/profiles/avatar-upload', avatarRateLimit, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  res.json({ ok: true, path: '/uploads/' + req.file.filename });
});

app.post('/profiles/:id/avatar', requireUser, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Kein Bild' });
  const avatarPath = '/uploads/' + req.file.filename;
  db.prepare('UPDATE profiles SET avatar_path = ? WHERE id = ?').run(avatarPath, Number(req.params.id));
  res.json({ ok: true, path: avatarPath });
});

app.post('/profiles', upload.single('avatar'), (req, res) => {
  const { housePassword, name, color, email, notify_mode, avatarPath } = req.body;
  if (housePassword !== HOUSE_PASSWORD) {
    return res.redirect('/profiles/new?msg=' + encodeURIComponent('Falsches Passwort'));
  }
  if (!name || name.trim().length < 2) {
    return res.redirect('/profiles/new?msg=' + encodeURIComponent('Name muss mindestens 2 Zeichen haben'));
  }
  const existing = db.prepare('SELECT id FROM profiles WHERE name = ?').get(name.trim());
  if (existing) {
    return res.redirect('/profiles/new?msg=' + encodeURIComponent('Name ist schon vergeben'));
  }

  let finalAvatarPath = avatarPath || null;
  if (!finalAvatarPath && req.file) {
    finalAvatarPath = '/uploads/' + req.file.filename;
  }

  const result = db.prepare(
    'INSERT INTO profiles (name, color, avatar_path, email, notify_mode) VALUES (?, ?, ?, ?, ?)'
  ).run(name.trim(), color || '#22c55e', finalAvatarPath, email || null, notify_mode || 'none');

  issueSession(res, result.lastInsertRowid);
  res.redirect('/');
});

app.get('/profiles/:id/edit', requireUser, (req, res) => {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(Number(req.params.id));
  if (!profile) return res.redirect('/profiles?msg=' + encodeURIComponent('Profil nicht gefunden'));

  const html = `
    <div style="max-width:440px;margin:0 auto;">
      <h1 style="margin-bottom:16px;">Profil bearbeiten</h1>
      <div style="text-align:center;margin-bottom:16px;">${avatarHtml(profile, 72)}</div>
      <form method="POST" action="/profiles/${profile.id}/edit">
        <div class="form-group">
          <label>Name</label>
          <input type="text" name="name" required minlength="2" value="${escapeHtml(profile.name)}" />
        </div>
        <div class="form-group">
          <label>Farbe</label>
          <input type="color" name="color" value="${escapeHtml(profile.color)}" />
        </div>
        ${cropperSection()}
        <div class="form-group">
          <label>E-Mail</label>
          <input type="email" name="email" value="${escapeHtml(profile.email || '')}" placeholder="deine@email.de" />
        </div>
        <div class="form-group">
          <label>Benachrichtigungen</label>
          <select name="notify_mode">
            <option value="none" ${profile.notify_mode === 'none' ? 'selected' : ''}>Keine E-Mails</option>
            <option value="all" ${profile.notify_mode === 'all' ? 'selected' : ''}>Alle Ergebnisse</option>
            <option value="mine" ${profile.notify_mode === 'mine' ? 'selected' : ''}>Nur meine Spiele</option>
            <option value="weekly" ${profile.notify_mode === 'weekly' ? 'selected' : ''}>Wöchentliche Top 3</option>
          </select>
        </div>
        <button type="submit" style="width:100%;">Speichern</button>
      </form>
      <a href="/profiles" class="button ghost" style="width:100%;margin-top:12px;display:flex;">Zurück</a>
    </div>
    ${cropperScript()}
  `;
  res.send(layoutWithCropper(req, 'Profil bearbeiten', html));
});

app.post('/profiles/:id/edit', requireUser, (req, res) => {
  const { name, color, email, notify_mode, avatarPath } = req.body;
  const id = Number(req.params.id);
  if (!name || name.trim().length < 2) {
    return res.redirect(`/profiles/${id}/edit?msg=` + encodeURIComponent('Name muss mindestens 2 Zeichen haben'));
  }
  const existing = db.prepare('SELECT id FROM profiles WHERE name = ? AND id != ?').get(name.trim(), id);
  if (existing) {
    return res.redirect(`/profiles/${id}/edit?msg=` + encodeURIComponent('Name ist schon vergeben'));
  }

  if (avatarPath) {
    db.prepare('UPDATE profiles SET name = ?, color = ?, email = ?, notify_mode = ?, avatar_path = ? WHERE id = ?')
      .run(name.trim(), color || '#22c55e', email || null, notify_mode || 'none', avatarPath, id);
  } else {
    db.prepare('UPDATE profiles SET name = ?, color = ?, email = ?, notify_mode = ? WHERE id = ?')
      .run(name.trim(), color || '#22c55e', email || null, notify_mode || 'none', id);
  }
  res.redirect('/profiles');
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
app.get('/', requireUser, (req, res) => {
  const totalMatches = db.prepare('SELECT COUNT(*) as c FROM matches').get().c;
  const totalProfiles = db.prepare('SELECT COUNT(*) as c FROM profiles').get().c;
  const activeTournaments = db.prepare("SELECT COUNT(*) as c FROM tournaments WHERE status = 'active'").get().c;

  const recentMatches = db.prepare(`
    SELECT m.*,
      (SELECT GROUP_CONCAT(p.name, ', ') FROM match_sides ms
       JOIN match_side_members msm ON msm.side_id = ms.id
       JOIN profiles p ON p.id = msm.profile_id
       WHERE ms.match_id = m.id AND ms.is_winner = 1) as winner_names,
      (SELECT ms.side_name FROM match_sides ms WHERE ms.match_id = m.id AND ms.is_winner = 1) as winner_side_name
    FROM matches m ORDER BY m.played_at DESC LIMIT 6
  `).all();

  const top5 = db.prepare(`
    SELECT p.id, p.name, p.color, p.avatar_path,
           COUNT(CASE WHEN ms.is_winner = 1 THEN 1 END) as wins,
           COUNT(*) as played
    FROM profiles p
    JOIN match_side_members msm ON msm.profile_id = p.id
    JOIN match_sides ms ON ms.id = msm.side_id
    GROUP BY p.id
    ORDER BY wins DESC, p.name ASC
    LIMIT 5
  `).all();

  const topDominance = db.prepare(`
    SELECT p.id, p.name, p.color, p.avatar_path,
           AVG(ms.cups_remaining) as avg_cups,
           COUNT(*) as cnt
    FROM profiles p
    JOIN match_side_members msm ON msm.profile_id = p.id
    JOIN match_sides ms ON ms.id = msm.side_id
    WHERE ms.is_winner = 1 AND ms.cups_remaining IS NOT NULL
    GROUP BY p.id HAVING cnt >= 3
    ORDER BY avg_cups DESC LIMIT 3
  `).all();

  const matchCards = recentMatches.map(m => {
    const sides = db.prepare(`
      SELECT ms.*, GROUP_CONCAT(p.name, ', ') as playerNames
      FROM match_sides ms
      JOIN match_side_members msm ON msm.side_id = ms.id
      JOIN profiles p ON p.id = msm.profile_id
      WHERE ms.match_id = ?
      GROUP BY ms.id
    `).all(m.id);
    return `
      <a href="/matches/${m.id}" class="match-card" style="text-decoration:none;color:inherit;display:block;">
        <div class="match-meta">
          ${modeBadge(m.mode)}
          <span>${formatDate(m.played_at)}</span>
          ${m.overtime > 0 ? '<span class="badge badge-overtime">⏱ OT</span>' : ''}
        </div>
        <div class="match-sides">
          ${sides.map(s => `
            <div class="match-side ${s.is_winner ? 'winner-side' : ''}">
              <span class="${s.is_winner ? 'winner-text' : ''}">${s.is_winner ? '🏆 ' : ''}${escapeHtml(s.playerNames)}</span>
              ${s.cups_remaining != null ? `<span class="subtle" style="font-size:11px;margin-left:auto;">${s.cups_remaining}🍺</span>` : ''}
            </div>
          `).join('<span class="match-vs">VS</span>')}
        </div>
      </a>
    `;
  }).join('');

  const html = `
    <h1 style="margin-bottom:16px;">🏓 Dashboard</h1>
    <div class="stats-bar">
      <div class="stat-card"><div class="stat-value">${totalMatches}</div><div class="stat-label">Spiele</div></div>
      <div class="stat-card"><div class="stat-value">${totalProfiles}</div><div class="stat-label">Spieler</div></div>
      <div class="stat-card"><div class="stat-value">${activeTournaments}</div><div class="stat-label">Turniere</div></div>
    </div>

    ${top5.length > 0 ? `
    <div class="card">
      <div class="card-header"><h2>🏆 Top 5</h2><a href="/leaderboard" class="subtle">Alle →</a></div>
      ${top5.map((p, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < top5.length - 1 ? 'border-bottom:1px solid var(--line);' : ''}">
          <span style="font-family:'Bebas Neue';font-size:1.3rem;color:${i === 0 ? 'var(--gold)' : 'var(--muted)'};width:28px;text-align:center;">${i + 1}</span>
          ${avatarHtml(p, 28)}
          <span style="font-weight:600;">${escapeHtml(p.name)}</span>
          <span style="margin-left:auto;color:var(--green);font-weight:700;">${p.wins}W</span>
          <span class="subtle">${p.played}G</span>
        </div>
      `).join('')}
    </div>` : ''}

    ${topDominance.length > 0 ? `
    <div class="card">
      <div class="card-header"><h2>💪 Dominanz Top 3</h2></div>
      ${topDominance.map((p, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 0;${i < topDominance.length - 1 ? 'border-bottom:1px solid var(--line);' : ''}">
          <span style="font-family:'Bebas Neue';font-size:1.3rem;color:var(--muted);width:28px;text-align:center;">${i + 1}</span>
          ${avatarHtml(p, 28)}
          <span style="font-weight:600;">${escapeHtml(p.name)}</span>
          <span style="margin-left:auto;color:var(--orange);font-weight:700;">${p.avg_cups.toFixed(1)} 🍺</span>
        </div>
      `).join('')}
    </div>` : ''}

    <div class="card-header"><h2>🎮 Letzte Spiele</h2><a href="/matches" class="subtle">Alle →</a></div>
    ${matchCards || '<p class="subtle">Noch keine Spiele gespielt.</p>'}
  `;
  res.send(layout(req, 'Dashboard', html));
});

// ─── MATCHES ─────────────────────────────────────────────────────────────────
app.get('/matches', requireUser, (req, res) => {
  const modeFilter = req.query.mode || 'all';
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 30;
  const offset = (page - 1) * perPage;

  let whereClause = '';
  const params = [];
  if (modeFilter !== 'all') {
    whereClause = 'WHERE m.mode = ?';
    params.push(modeFilter);
  }

  const totalCount = db.prepare(`SELECT COUNT(*) as c FROM matches m ${whereClause}`).get(...params).c;
  const matches = db.prepare(`
    SELECT m.* FROM matches m ${whereClause}
    ORDER BY m.played_at DESC LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const totalPages = Math.ceil(totalCount / perPage);

  const modes = ['all', '1v1', '2v2', 'flipcup', 'tournament'];
  const modeLabels = { all: 'Alle', '1v1': '1v1', '2v2': '2v2', flipcup: 'Flip Cup', tournament: 'Turnier' };

  const matchCards = matches.map(m => {
    const sides = db.prepare(`
      SELECT ms.*, GROUP_CONCAT(p.name, ', ') as playerNames
      FROM match_sides ms
      JOIN match_side_members msm ON msm.side_id = ms.id
      JOIN profiles p ON p.id = msm.profile_id
      WHERE ms.match_id = ?
      GROUP BY ms.id
    `).all(m.id);
    return `
      <a href="/matches/${m.id}" class="match-card" style="text-decoration:none;color:inherit;display:block;">
        <div class="match-meta">
          ${modeBadge(m.mode)}
          <span>${formatDate(m.played_at)}</span>
          ${m.overtime > 0 ? '<span class="badge badge-overtime">⏱ OT</span>' : ''}
        </div>
        <div class="match-sides">
          ${sides.map(s => `
            <div class="match-side ${s.is_winner ? 'winner-side' : ''}">
              <span class="${s.is_winner ? 'winner-text' : ''}">${s.is_winner ? '🏆 ' : ''}${escapeHtml(s.playerNames)}</span>
              ${s.cups_remaining != null ? `<span class="subtle" style="font-size:11px;margin-left:auto;">${s.cups_remaining}🍺</span>` : ''}
            </div>
          `).join('<span class="match-vs">VS</span>')}
        </div>
      </a>
    `;
  }).join('');

  const html = `
    <div class="card-header"><h1>🎮 Spiele</h1><a href="/matches/new" class="button small-btn">➕ Neues Spiel</a></div>
    <div class="filter-bar">
      ${modes.map(m => `<a href="/matches?mode=${m}" class="tab ${modeFilter === m ? 'active' : ''}">${modeLabels[m]}</a>`).join('')}
    </div>
    ${matchCards || '<p class="subtle">Noch keine Spiele.</p>'}
    ${totalPages > 1 ? `
    <div class="pagination">
      ${page > 1 ? `<a href="/matches?mode=${modeFilter}&page=${page - 1}" class="button ghost small-btn">← Zurück</a>` : ''}
      <span class="subtle" style="display:flex;align-items:center;">Seite ${page} / ${totalPages}</span>
      ${page < totalPages ? `<a href="/matches?mode=${modeFilter}&page=${page + 1}" class="button ghost small-btn">Weiter →</a>` : ''}
    </div>` : ''}
  `;
  res.send(layout(req, 'Spiele', html));
});

app.get('/matches/new', requireUser, (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  const activeTournaments = db.prepare("SELECT * FROM tournaments WHERE status = 'active' ORDER BY name").all();
  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const profileCheckboxes = (sideName, sideNum) => profiles.map(p => `
    <label class="check-item">
      <input type="checkbox" name="side${sideNum}[]" value="${p.id}" class="side-checkbox" data-side="${sideNum}" />
      ${avatarHtml(p, 24)}
      <span>${escapeHtml(p.name)}</span>
    </label>
  `).join('');

  const html = `
    <h1 style="margin-bottom:16px;">➕ Neues Spiel</h1>
    <form method="POST" action="/matches" enctype="multipart/form-data" id="match-form">
      <div class="form-group">
        <label>Spielmodus</label>
        <div class="mode-grid">
          <div class="mode-card" data-mode="1v1" onclick="selectMode('1v1')">
            <span class="mode-icon">🏓</span>
            <span class="mode-label">1v1</span>
            <span class="mode-desc">Capsen klassisch</span>
          </div>
          <div class="mode-card" data-mode="2v2" onclick="selectMode('2v2')">
            <span class="mode-icon">👥</span>
            <span class="mode-label">2v2</span>
            <span class="mode-desc">Team Capsen</span>
          </div>
          <div class="mode-card" data-mode="flipcup" onclick="selectMode('flipcup')">
            <span class="mode-icon">🍺</span>
            <span class="mode-label">Flip Cup</span>
            <span class="mode-desc">Bierpong</span>
          </div>
          <div class="mode-card" data-mode="tournament" onclick="selectMode('tournament')">
            <span class="mode-icon">🏆</span>
            <span class="mode-label">Turnier</span>
            <span class="mode-desc">Turnier-Match</span>
          </div>
        </div>
        <input type="hidden" name="mode" id="mode-input" required />
      </div>

      <div id="regular-section" style="display:none;">
        <div class="form-group">
          <label>Datum & Uhrzeit</label>
          <input type="datetime-local" name="played_at" value="${localNow}" />
        </div>

        <div class="card" style="margin-bottom:16px;">
          <h2 style="margin-bottom:12px;">Seite 1</h2>
          <div class="form-group">
            <label>Teamname (optional)</label>
            <input type="text" name="side1_name" id="side1-name" placeholder="Teamname optional" />
          </div>
          <div class="form-group">
            <label>Spieler</label>
            <div class="check-grid">${profileCheckboxes('Seite 1', 1)}</div>
          </div>
        </div>

        <div class="card" style="margin-bottom:16px;">
          <h2 style="margin-bottom:12px;">Seite 2</h2>
          <div class="form-group">
            <label>Teamname (optional)</label>
            <input type="text" name="side2_name" id="side2-name" placeholder="Teamname optional" />
          </div>
          <div class="form-group">
            <label>Spieler</label>
            <div class="check-grid">${profileCheckboxes('Seite 2', 2)}</div>
          </div>
        </div>

        <div class="form-group">
          <label>🏆 Gewinner</label>
          <div class="winner-radio">
            <label class="winner-option">
              <input type="radio" name="winner" value="1" required />
              🏆 <span id="winner-label-1">Seite 1</span> gewinnt
            </label>
            <label class="winner-option">
              <input type="radio" name="winner" value="2" />
              🏆 <span id="winner-label-2">Seite 2</span> gewinnt
            </label>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group">
            <label>🍺 Restbecher (Verlierer)</label>
            <input type="number" name="cups_remaining" min="0" max="10" placeholder="0" />
          </div>
          <div class="form-group">
            <label>⏱ Verlängerungen</label>
            <input type="number" name="overtime" min="0" max="5" value="0" />
          </div>
        </div>

        <div class="form-group">
          <label>📝 Notizen (optional)</label>
          <textarea name="notes" placeholder="Was ist passiert?"></textarea>
        </div>
        <div class="form-group">
          <label>📸 Foto (optional)</label>
          <input type="file" name="photo" accept="image/*" style="min-height:48px;" />
        </div>
      </div>

      <div id="tournament-section" style="display:none;">
        <div class="form-group">
          <label>Turnier auswählen</label>
          <select id="tournament-select" name="tournament_id" onchange="loadPendingMatches()">
            <option value="">-- Turnier wählen --</option>
            ${activeTournaments.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${t.mode})</option>`).join('')}
          </select>
        </div>
        <div id="pending-matches"></div>
      </div>

      <div id="submit-section" style="display:none;">
        <button type="submit" style="width:100%;">Spiel speichern</button>
      </div>
    </form>

    <script>
    var currentMode = '';
    function selectMode(mode) {
      currentMode = mode;
      document.getElementById('mode-input').value = mode;
      document.querySelectorAll('.mode-card').forEach(function(c) {
        c.classList.toggle('selected', c.dataset.mode === mode);
      });
      var regular = document.getElementById('regular-section');
      var tournament = document.getElementById('tournament-section');
      var submit = document.getElementById('submit-section');
      if (mode === 'tournament') {
        regular.style.display = 'none';
        tournament.style.display = 'block';
        submit.style.display = 'none';
      } else {
        regular.style.display = 'block';
        tournament.style.display = 'none';
        submit.style.display = 'block';
      }
    }

    document.getElementById('side1-name').addEventListener('input', function() {
      document.getElementById('winner-label-1').textContent = this.value || 'Seite 1';
    });
    document.getElementById('side2-name').addEventListener('input', function() {
      document.getElementById('winner-label-2').textContent = this.value || 'Seite 2';
    });

    function loadPendingMatches() {
      var tid = document.getElementById('tournament-select').value;
      var container = document.getElementById('pending-matches');
      if (!tid) { container.innerHTML = ''; return; }
      fetch('/tournaments/' + tid + '/pending-matches')
        .then(function(r) { return r.json(); })
        .then(function(matches) {
          if (matches.length === 0) {
            container.innerHTML = '<p class="subtle">Keine offenen Matches.</p>';
            return;
          }
          container.innerHTML = '<div class="form-group"><label>Match auswählen</label>' +
            matches.map(function(m) {
              return '<label class="check-item" style="margin-bottom:8px;">' +
                '<input type="radio" name="tournament_match_id" value="' + m.id + '" onchange="showTournamentMatchForm()" />' +
                '<span>Runde ' + m.round + ' · ' + m.side1Names + ' vs ' + m.side2Names + '</span></label>';
            }).join('') + '</div>' +
            '<div id="tournament-match-form" style="display:none;">' +
              '<div class="form-group"><label>🏆 Gewinner</label>' +
                '<div class="winner-radio">' +
                  '<label class="winner-option"><input type="radio" name="winner" value="1" required />🏆 Seite 1 gewinnt</label>' +
                  '<label class="winner-option"><input type="radio" name="winner" value="2" />🏆 Seite 2 gewinnt</label>' +
                '</div></div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                '<div class="form-group"><label>🍺 Restbecher</label><input type="number" name="cups_remaining" min="0" max="10" placeholder="0" /></div>' +
                '<div class="form-group"><label>⏱ Verlängerungen</label><input type="number" name="overtime" min="0" max="5" value="0" /></div>' +
              '</div>' +
              '<div class="form-group"><label>Datum & Uhrzeit</label><input type="datetime-local" name="played_at" value="${localNow}" /></div>' +
              '<div class="form-group"><label>📝 Notizen (optional)</label><textarea name="notes"></textarea></div>' +
              '<button type="submit" style="width:100%;">Spiel speichern</button>' +
            '</div>';
        });
    }

    function showTournamentMatchForm() {
      document.getElementById('tournament-match-form').style.display = 'block';
    }
    <\/script>
  `;
  res.send(layout(req, 'Neues Spiel', html));
});

app.post('/matches', requireUser, upload.single('photo'), (req, res) => {
  const { mode, played_at, notes, winner, cups_remaining, overtime, tournament_id, tournament_match_id } = req.body;
  const photoPath = req.file ? '/uploads/' + req.file.filename : null;

  if (mode === 'tournament' && tournament_match_id) {
    return res.redirect(`/tournaments/${tournament_id}/matches/${tournament_match_id}?autoPost=1&winner=${winner}&cups=${cups_remaining || ''}&overtime=${overtime || 0}&played_at=${encodeURIComponent(played_at || '')}&notes=${encodeURIComponent(notes || '')}`);
  }

  if (!mode || !played_at || !winner) {
    if (req.file) fs.unlinkSync(req.file.path);
    return redirectWithMessage(res, '/matches/new', 'Bitte alle Pflichtfelder ausfüllen');
  }

  const side1Players = (Array.isArray(req.body['side1[]']) ? req.body['side1[]'] : (req.body['side1[]'] ? [req.body['side1[]']] : [])).map(Number).filter(Boolean);
  const side2Players = (Array.isArray(req.body['side2[]']) ? req.body['side2[]'] : (req.body['side2[]'] ? [req.body['side2[]']] : [])).map(Number).filter(Boolean);

  if (side1Players.length === 0 || side2Players.length === 0) {
    if (req.file) fs.unlinkSync(req.file.path);
    return redirectWithMessage(res, '/matches/new', 'Beide Seiten brauchen mindestens einen Spieler');
  }

  if (mode === '1v1' && (side1Players.length !== 1 || side2Players.length !== 1)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return redirectWithMessage(res, '/matches/new', '1v1 braucht genau einen Spieler pro Seite');
  }
  if (mode === '2v2' && (side1Players.length !== 2 || side2Players.length !== 2)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return redirectWithMessage(res, '/matches/new', '2v2 braucht genau zwei Spieler pro Seite');
  }

  const side1Name = req.body.side1_name || 'Seite 1';
  const side2Name = req.body.side2_name || 'Seite 2';
  const winnerSide = Number(winner);
  const cupsVal = cups_remaining !== '' && cups_remaining != null ? Number(cups_remaining) : null;
  const otVal = Number(overtime) || 0;

  const insertMatch = db.transaction(() => {
    const matchResult = db.prepare(
      'INSERT INTO matches (mode, played_at, notes, photo_path, overtime, created_by_profile_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(mode, played_at, notes || null, photoPath, otVal, req.currentUser.id);
    const matchId = matchResult.lastInsertRowid;

    const insertSide = db.prepare(
      'INSERT INTO match_sides (match_id, side_name, is_winner, cups_remaining) VALUES (?, ?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO match_side_members (side_id, profile_id) VALUES (?, ?)'
    );

    const side1Result = insertSide.run(matchId, side1Name, winnerSide === 1 ? 1 : 0, winnerSide === 1 ? cupsVal : null);
    side1Players.forEach(pid => insertMember.run(side1Result.lastInsertRowid, pid));

    const side2Result = insertSide.run(matchId, side2Name, winnerSide === 2 ? 1 : 0, winnerSide === 2 ? cupsVal : null);
    side2Players.forEach(pid => insertMember.run(side2Result.lastInsertRowid, pid));

    return matchId;
  });

  const matchId = insertMatch();
  sendMatchEmail(matchId).catch(() => {});
  redirectWithMessage(res, '/matches', 'Spiel gespeichert! 🏆');
});

app.get('/matches/:id', requireUser, (req, res) => {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(Number(req.params.id));
  if (!match) return res.redirect('/matches?msg=' + encodeURIComponent('Spiel nicht gefunden'));

  const sides = db.prepare(`
    SELECT ms.*
    FROM match_sides ms WHERE ms.match_id = ?
  `).all(match.id);

  const sidesHtml = sides.map(s => {
    const members = db.prepare(`
      SELECT p.* FROM profiles p
      JOIN match_side_members msm ON msm.profile_id = p.id
      WHERE msm.side_id = ?
    `).all(s.id);

    return `
      <div class="card" style="${s.is_winner ? 'border-color:rgba(0,255,135,0.3);' : ''}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          ${s.is_winner ? '<span style="font-size:24px;">🏆</span>' : ''}
          <h2 class="${s.is_winner ? 'winner-text' : ''}">${escapeHtml(s.side_name)}</h2>
        </div>
        <div class="player-chips">
          ${members.map(p => `<span class="player-chip">${avatarHtml(p, 20)} ${escapeHtml(p.name)}</span>`).join('')}
        </div>
        ${s.cups_remaining != null ? `<div class="subtle" style="margin-top:8px;">🍺 ${s.cups_remaining} Restbecher</div>` : ''}
      </div>
    `;
  }).join('');

  const html = `
    <div style="margin-bottom:12px;">
      <a href="/matches" class="subtle">← Zurück zu Spiele</a>
    </div>
    <div class="card-header">
      <h1>Spiel #${match.id}</h1>
      <div>${modeBadge(match.mode)}</div>
    </div>
    <div class="subtle" style="margin-bottom:16px;">
      📅 ${formatDate(match.played_at)}
      ${match.overtime > 0 ? ` · ⏱ ${match.overtime} Verlängerung(en)` : ''}
    </div>
    ${sidesHtml}
    ${match.photo_path ? `<div class="card"><img src="${escapeHtml(match.photo_path)}" style="width:100%;border-radius:12px;" alt="Match Foto" /></div>` : ''}
    ${match.notes ? `<div class="card"><h2>📝 Notizen</h2><p>${escapeHtml(match.notes)}</p></div>` : ''}
  `;
  res.send(layout(req, `Spiel #${match.id}`, html));
});

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
app.get('/leaderboard', requireUser, (req, res) => {
  const tab = req.query.tab || 'gesamt';
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();

  let content = '';

  if (tab === 'gesamt') {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.color, p.avatar_path,
             COUNT(DISTINCT msm.side_id) as played,
             COUNT(DISTINCT CASE WHEN ms.is_winner = 1 THEN msm.side_id END) as wins
      FROM profiles p
      LEFT JOIN match_side_members msm ON msm.profile_id = p.id
      LEFT JOIN match_sides ms ON ms.id = msm.side_id
      GROUP BY p.id
      ORDER BY wins DESC,
               CASE WHEN COUNT(DISTINCT msm.side_id) > 0
                    THEN CAST(COUNT(DISTINCT CASE WHEN ms.is_winner = 1 THEN msm.side_id END) AS REAL) / COUNT(DISTINCT msm.side_id)
                    ELSE 0 END DESC,
               p.name ASC
    `).all();

    content = `
      <div class="card" style="overflow-x:auto;">
        <table class="lb-table">
          <thead><tr>
            <th>#</th><th>Spieler</th><th>Spiele</th><th>Siege</th><th>Niederlagen</th><th>Win-%</th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => {
              const losses = r.played - r.wins;
              const winPct = r.played > 0 ? ((r.wins / r.played) * 100).toFixed(0) : '–';
              return `<tr>
                <td style="font-family:'Bebas Neue';font-size:1.2rem;color:${i < 3 ? 'var(--gold)' : 'var(--muted)'};">${i + 1}</td>
                <td><div style="display:flex;align-items:center;gap:8px;">${avatarHtml(r, 24)} <span style="font-weight:600;">${escapeHtml(r.name)}</span></div></td>
                <td>${r.played}</td>
                <td style="color:var(--green);font-weight:700;">${r.wins}</td>
                <td>${losses}</td>
                <td>${winPct}%</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else if (tab === 'h2h') {
    const p1 = Number(req.query.p1) || 0;
    const p2 = Number(req.query.p2) || 0;

    let h2hContent = `
      <div class="card">
        <form method="GET" action="/leaderboard" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <input type="hidden" name="tab" value="h2h" />
          <div class="form-group" style="flex:1;min-width:140px;">
            <label>Spieler 1</label>
            <select name="p1">${profiles.map(p => `<option value="${p.id}" ${p.id === p1 ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <div class="form-group" style="flex:1;min-width:140px;">
            <label>Spieler 2</label>
            <select name="p2">${profiles.map(p => `<option value="${p.id}" ${p.id === p2 ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('')}</select>
          </div>
          <button type="submit" class="small-btn" style="margin-bottom:16px;">Vergleichen</button>
        </form>
      </div>
    `;

    if (p1 && p2 && p1 !== p2) {
      const h2hMatches = db.prepare(`
        SELECT m.* FROM matches m
        WHERE m.id IN (
          SELECT ms1.match_id FROM match_sides ms1
          JOIN match_side_members msm1 ON msm1.side_id = ms1.id AND msm1.profile_id = ?
          JOIN match_sides ms2 ON ms2.match_id = ms1.match_id AND ms2.id != ms1.id
          JOIN match_side_members msm2 ON msm2.side_id = ms2.id AND msm2.profile_id = ?
        )
        ORDER BY m.played_at DESC LIMIT 10
      `).all(p1, p2);

      let p1Wins = 0, p2Wins = 0;
      h2hMatches.forEach(m => {
        const winnerSide = db.prepare(`
          SELECT ms.id FROM match_sides ms
          WHERE ms.match_id = ? AND ms.is_winner = 1
        `).get(m.id);
        if (winnerSide) {
          const isP1Winner = db.prepare('SELECT 1 FROM match_side_members WHERE side_id = ? AND profile_id = ?').get(winnerSide.id, p1);
          if (isP1Winner) p1Wins++; else p2Wins++;
        }
      });

      const profile1 = db.prepare('SELECT * FROM profiles WHERE id = ?').get(p1);
      const profile2 = db.prepare('SELECT * FROM profiles WHERE id = ?').get(p2);

      h2hContent += `
        <div class="card">
          <div style="display:flex;align-items:center;justify-content:space-around;text-align:center;padding:16px 0;">
            <div>
              ${avatarHtml(profile1, 48)}
              <div style="font-weight:700;margin-top:4px;">${escapeHtml(profile1.name)}</div>
              <div class="stat-value">${p1Wins}</div>
              <div class="stat-label">Siege</div>
            </div>
            <div style="font-family:'Bebas Neue';font-size:2rem;color:var(--muted);">VS</div>
            <div>
              ${avatarHtml(profile2, 48)}
              <div style="font-weight:700;margin-top:4px;">${escapeHtml(profile2.name)}</div>
              <div class="stat-value">${p2Wins}</div>
              <div class="stat-label">Siege</div>
            </div>
          </div>
          <div class="subtle" style="text-align:center;">${h2hMatches.length} Spiele gegeneinander</div>
        </div>
      `;

      if (h2hMatches.length > 0) {
        h2hContent += h2hMatches.map(m => {
          const sides = db.prepare(`
            SELECT ms.*, GROUP_CONCAT(p.name, ', ') as playerNames
            FROM match_sides ms JOIN match_side_members msm ON msm.side_id = ms.id
            JOIN profiles p ON p.id = msm.profile_id WHERE ms.match_id = ? GROUP BY ms.id
          `).all(m.id);
          return `
            <div class="match-card">
              <div class="match-meta">${modeBadge(m.mode)} <span>${formatDate(m.played_at)}</span></div>
              <div class="match-sides">
                ${sides.map(s => `<div class="match-side ${s.is_winner ? 'winner-side' : ''}"><span class="${s.is_winner ? 'winner-text' : ''}">${s.is_winner ? '🏆 ' : ''}${escapeHtml(s.playerNames)}</span></div>`).join('<span class="match-vs">VS</span>')}
              </div>
            </div>`;
        }).join('');
      }
    }
    content = h2hContent;
  } else if (tab === 'dominanz') {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.color, p.avatar_path,
             COUNT(*) as qualifying_wins,
             AVG(ms.cups_remaining) as avg_cups
      FROM profiles p
      JOIN match_side_members msm ON msm.profile_id = p.id
      JOIN match_sides ms ON ms.id = msm.side_id
      WHERE ms.is_winner = 1 AND ms.cups_remaining IS NOT NULL
      GROUP BY p.id
      HAVING qualifying_wins >= 3
      ORDER BY avg_cups DESC
    `).all();

    content = `
      <div class="card" style="overflow-x:auto;">
        <p class="subtle" style="margin-bottom:12px;">Wer dominiert am meisten? (Min. 3 Siege mit Restbecher)</p>
        <table class="lb-table">
          <thead><tr><th>#</th><th>Spieler</th><th>Avg Restbecher</th><th>Siege gezählt</th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `<tr>
              <td style="font-family:'Bebas Neue';font-size:1.2rem;color:${i < 3 ? 'var(--gold)' : 'var(--muted)'};">${i + 1}</td>
              <td><div style="display:flex;align-items:center;gap:8px;">${avatarHtml(r, 24)} <span style="font-weight:600;">${escapeHtml(r.name)}</span></div></td>
              <td style="color:var(--orange);font-weight:700;">${r.avg_cups.toFixed(1)} 🍺</td>
              <td>${r.qualifying_wins}</td>
            </tr>`).join('')}
            ${rows.length === 0 ? '<tr><td colspan="4" class="subtle">Noch nicht genug Daten.</td></tr>' : ''}
          </tbody>
        </table>
      </div>
    `;
  }

  const tabs = [
    { key: 'gesamt', label: 'Gesamtranking' },
    { key: 'h2h', label: 'Head-to-Head' },
    { key: 'dominanz', label: 'Dominanz' },
  ];

  const html = `
    <h1 style="margin-bottom:16px;">🏆 Leaderboard</h1>
    <div class="tabs">
      ${tabs.map(t => `<a href="/leaderboard?tab=${t.key}" class="tab ${tab === t.key ? 'active' : ''}">${t.label}</a>`).join('')}
    </div>
    ${content}
  `;
  res.send(layout(req, 'Leaderboard', html));
});

// ─── TOURNAMENTS ─────────────────────────────────────────────────────────────
app.get('/tournaments', requireUser, (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*, p.name as creator_name,
      (SELECT COUNT(*) FROM tournament_participants tp WHERE tp.tournament_id = t.id) as participant_count,
      pw.name as winner_name
    FROM tournaments t
    LEFT JOIN profiles p ON p.id = t.created_by_profile_id
    LEFT JOIN profiles pw ON pw.id = t.winner_profile_id
    ORDER BY CASE WHEN t.status = 'active' THEN 0 ELSE 1 END, t.created_at DESC
  `).all();

  const html = `
    <div class="card-header"><h1>🥊 Turniere</h1><a href="/tournaments/new" class="button small-btn">➕ Neues Turnier</a></div>
    ${tournaments.map(t => `
      <a href="/tournaments/${t.id}" class="card" style="text-decoration:none;color:inherit;display:block;">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
          <h2 style="margin:0;">${escapeHtml(t.name)}</h2>
          ${modeBadge(t.mode)}
          <span class="badge ${t.status === 'active' ? 'badge-active' : 'badge-finished'}">${t.status === 'active' ? 'Aktiv' : 'Beendet'}</span>
        </div>
        <div class="subtle" style="margin-top:6px;">
          ${t.participant_count} Teilnehmer · Erstellt ${formatDate(t.created_at)}
          ${t.winner_name ? ` · 🏆 ${escapeHtml(t.winner_name)}` : ''}
        </div>
      </a>
    `).join('') || '<p class="subtle">Noch keine Turniere.</p>'}
  `;
  res.send(layout(req, 'Turniere', html));
});

app.get('/tournaments/new', requireUser, (req, res) => {
  const profiles = db.prepare('SELECT * FROM profiles ORDER BY name').all();
  const html = `
    <div style="max-width:500px;margin:0 auto;">
      <h1 style="margin-bottom:16px;">🥊 Neues Turnier</h1>
      <form method="POST" action="/tournaments">
        <div class="form-group">
          <label>Turniername</label>
          <input type="text" name="name" required placeholder="z.B. Sommer Capsen 2025" />
        </div>
        <div class="form-group">
          <label>Modus</label>
          <div style="display:flex;gap:10px;">
            <label class="check-item" style="flex:1;">
              <input type="radio" name="mode" value="1v1" required checked />
              <span>🏓 1v1</span>
            </label>
            <label class="check-item" style="flex:1;">
              <input type="radio" name="mode" value="2v2" />
              <span>👥 2v2</span>
            </label>
          </div>
        </div>
        <div class="form-group">
          <label>Teilnehmer (min. 2 für 1v1, min. 4 für 2v2)</label>
          <div class="check-grid">
            ${profiles.map(p => `
              <label class="check-item">
                <input type="checkbox" name="participants[]" value="${p.id}" />
                ${avatarHtml(p, 24)}
                <span>${escapeHtml(p.name)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <button type="submit" style="width:100%;">Turnier erstellen</button>
      </form>
    </div>
  `;
  res.send(layout(req, 'Neues Turnier', html));
});

function generateBracket(db, tournamentId, participantIds, mode) {
  const n = participantIds.length;
  const rounds = Math.ceil(Math.log2(n));
  const slots = Math.pow(2, rounds);

  const shuffled = [...participantIds].sort(() => Math.random() - 0.5);
  while (shuffled.length < slots) shuffled.push(null);

  const insertTM = db.prepare(
    'INSERT INTO tournament_matches (tournament_id, round, position, side1_profile_ids, side2_profile_ids) VALUES (?, ?, ?, ?, ?)'
  );
  const updateNextMatch = db.prepare(
    'UPDATE tournament_matches SET next_match_id = ? WHERE id = ?'
  );

  const matchIds = [];
  for (let r = 0; r < rounds; r++) {
    const matchesInRound = Math.pow(2, rounds - r - 1);
    matchIds[r] = [];
    for (let p = 0; p < matchesInRound; p++) {
      let s1 = null, s2 = null;
      if (r === 0) {
        s1 = shuffled[p * 2] ? String(shuffled[p * 2]) : null;
        s2 = shuffled[p * 2 + 1] ? String(shuffled[p * 2 + 1]) : null;
      }
      const result = insertTM.run(tournamentId, r + 1, p, s1, s2);
      matchIds[r][p] = result.lastInsertRowid;
    }
  }

  for (let r = 0; r < rounds - 1; r++) {
    for (let p = 0; p < matchIds[r].length; p++) {
      const nextPos = Math.floor(p / 2);
      updateNextMatch.run(matchIds[r + 1][nextPos], matchIds[r][p]);
    }
  }

  const byeMatches = db.prepare(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? AND round = 1'
  ).all(tournamentId);

  for (const m of byeMatches) {
    if (m.side1_profile_ids && !m.side2_profile_ids) {
      db.prepare('UPDATE tournament_matches SET winner_side = 1 WHERE id = ?').run(m.id);
      if (m.next_match_id) {
        const col = (m.position % 2 === 0) ? 'side1_profile_ids' : 'side2_profile_ids';
        db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`)
          .run(m.side1_profile_ids, m.next_match_id);
      }
    }
  }
}

app.post('/tournaments', requireUser, (req, res) => {
  const { name, mode } = req.body;
  const participants = (Array.isArray(req.body['participants[]']) ? req.body['participants[]'] : (req.body['participants[]'] ? [req.body['participants[]']] : [])).map(Number).filter(Boolean);

  if (!name || name.trim().length < 1) {
    return redirectWithMessage(res, '/tournaments/new', 'Turniername fehlt');
  }
  const minParticipants = mode === '2v2' ? 4 : 2;
  if (participants.length < minParticipants) {
    return redirectWithMessage(res, '/tournaments/new', `Mindestens ${minParticipants} Teilnehmer nötig`);
  }

  const createTournament = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO tournaments (name, mode, created_by_profile_id) VALUES (?, ?, ?)'
    ).run(name.trim(), mode, req.currentUser.id);
    const tournamentId = result.lastInsertRowid;

    const insertParticipant = db.prepare(
      'INSERT INTO tournament_participants (tournament_id, profile_id) VALUES (?, ?)'
    );
    participants.forEach(pid => insertParticipant.run(tournamentId, pid));

    generateBracket(db, tournamentId, participants, mode);

    return tournamentId;
  });

  const tournamentId = createTournament();
  res.redirect('/tournaments/' + tournamentId);
});

app.get('/tournaments/:id', requireUser, (req, res) => {
  const tournament = db.prepare(`
    SELECT t.*, p.name as creator_name, pw.name as winner_name, pw.avatar_path as winner_avatar, pw.color as winner_color
    FROM tournaments t
    LEFT JOIN profiles p ON p.id = t.created_by_profile_id
    LEFT JOIN profiles pw ON pw.id = t.winner_profile_id
    WHERE t.id = ?
  `).get(Number(req.params.id));
  if (!tournament) return res.redirect('/tournaments?msg=' + encodeURIComponent('Turnier nicht gefunden'));

  const allMatches = db.prepare(
    'SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, position'
  ).all(tournament.id);

  const rounds = {};
  allMatches.forEach(m => {
    if (!rounds[m.round]) rounds[m.round] = [];
    rounds[m.round].push(m);
  });

  const totalRounds = Math.max(...Object.keys(rounds).map(Number), 0);

  function roundLabel(round, total) {
    if (round === total) return 'Finale';
    if (round === total - 1) return 'Halbfinale';
    if (round === total - 2) return 'Viertelfinale';
    return 'Runde ' + round;
  }

  const bracketHtml = Object.keys(rounds).sort((a, b) => a - b).map(r => {
    const rNum = Number(r);
    return `
      <div class="bracket-round">
        <div class="bracket-label">${roundLabel(rNum, totalRounds)}</div>
        ${rounds[r].map(m => {
          const s1Names = profileNamesFromIds(m.side1_profile_ids);
          const s2Names = profileNamesFromIds(m.side2_profile_ids);
          const hasWinner = m.winner_side != null;
          const bothReady = m.side1_profile_ids && m.side2_profile_ids;

          return `
            <div class="bracket-match">
              <div class="bracket-side ${hasWinner && m.winner_side === 1 ? 'winner' : ''} ${!m.side1_profile_ids ? 'tbd' : ''}">
                ${hasWinner && m.winner_side === 1 ? '🏆 ' : ''}${s1Names}
              </div>
              <div style="border-top:1px solid var(--line);margin:2px 0;"></div>
              <div class="bracket-side ${hasWinner && m.winner_side === 2 ? 'winner' : ''} ${!m.side2_profile_ids ? 'tbd' : ''}">
                ${hasWinner && m.winner_side === 2 ? '🏆 ' : ''}${s2Names}
              </div>
              ${bothReady && !hasWinner ? `<a href="/tournaments/${tournament.id}/matches/${m.id}/enter" class="button small-btn" style="margin-top:6px;width:100%;font-size:12px;">Ergebnis eintragen →</a>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    `;
  }).join('');

  const winnerBanner = tournament.status === 'finished' && tournament.winner_name ? `
    <div class="card" style="text-align:center;border-color:var(--gold);background:rgba(255,215,0,0.08);">
      <div style="font-size:48px;margin-bottom:8px;">🏆</div>
      <h1 class="winner-text">${escapeHtml(tournament.winner_name)}</h1>
      <p style="font-family:'Bebas Neue';font-size:1.3rem;color:var(--gold);">WINS THE TOURNAMENT!</p>
    </div>
  ` : '';

  const html = `
    <div style="margin-bottom:12px;"><a href="/tournaments" class="subtle">← Zurück zu Turniere</a></div>
    <div class="card-header">
      <h1>${escapeHtml(tournament.name)}</h1>
      <div>${modeBadge(tournament.mode)} <span class="badge ${tournament.status === 'active' ? 'badge-active' : 'badge-finished'}">${tournament.status === 'active' ? 'Aktiv' : 'Beendet'}</span></div>
    </div>
    <div class="subtle" style="margin-bottom:16px;">Erstellt von ${escapeHtml(tournament.creator_name || '?')}</div>
    ${winnerBanner}
    <div class="bracket">${bracketHtml}</div>
  `;
  res.send(layout(req, tournament.name, html));
});

app.get('/tournaments/:id/matches/:matchId/enter', requireUser, (req, res) => {
  const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
  const tm = db.prepare('SELECT * FROM tournament_matches WHERE id = ? AND tournament_id = ?').get(Number(req.params.matchId), Number(req.params.id));
  if (!tournament || !tm) return res.redirect('/tournaments?msg=' + encodeURIComponent('Nicht gefunden'));

  const s1Names = profileNamesFromIds(tm.side1_profile_ids);
  const s2Names = profileNamesFromIds(tm.side2_profile_ids);

  const totalRounds = db.prepare('SELECT MAX(round) as r FROM tournament_matches WHERE tournament_id = ?').get(tournament.id).r;
  function roundLabel(round, total) {
    if (round === total) return 'Finale';
    if (round === total - 1) return 'Halbfinale';
    return 'Runde ' + round;
  }

  const now = new Date();
  const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  const html = `
    <div style="max-width:500px;margin:0 auto;">
      <div style="margin-bottom:12px;"><a href="/tournaments/${tournament.id}" class="subtle">← Zurück zum Turnier</a></div>
      <h1 style="margin-bottom:4px;">${escapeHtml(tournament.name)}</h1>
      <p class="subtle" style="margin-bottom:16px;">${roundLabel(tm.round, totalRounds)}</p>

      <div class="card" style="text-align:center;">
        <div style="display:flex;align-items:center;justify-content:space-around;">
          <div><strong>${s1Names}</strong></div>
          <div style="font-family:'Bebas Neue';font-size:1.5rem;color:var(--muted);">VS</div>
          <div><strong>${s2Names}</strong></div>
        </div>
      </div>

      <form method="POST" action="/tournaments/${tournament.id}/matches/${tm.id}">
        <div class="form-group">
          <label>🏆 Gewinner</label>
          <div class="winner-radio">
            <label class="winner-option">
              <input type="radio" name="winner_side" value="1" required />
              🏆 ${s1Names}
            </label>
            <label class="winner-option">
              <input type="radio" name="winner_side" value="2" />
              🏆 ${s2Names}
            </label>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
          <div class="form-group">
            <label>🍺 Restbecher</label>
            <input type="number" name="cups_remaining" min="0" max="10" placeholder="0" />
          </div>
          <div class="form-group">
            <label>⏱ Verlängerungen</label>
            <input type="number" name="overtime" min="0" max="5" value="0" />
          </div>
        </div>
        <div class="form-group">
          <label>Datum & Uhrzeit</label>
          <input type="datetime-local" name="played_at" value="${localNow}" />
        </div>
        <div class="form-group">
          <label>📝 Notizen (optional)</label>
          <textarea name="notes" placeholder="Was ist passiert?"></textarea>
        </div>
        <button type="submit" style="width:100%;">Ergebnis speichern</button>
      </form>
    </div>
  `;
  res.send(layout(req, 'Ergebnis eintragen', html));
});

app.post('/tournaments/:id/matches/:matchId', requireUser, (req, res) => {
  const tournamentId = Number(req.params.id);
  const tmId = Number(req.params.matchId);
  const winnerSide = Number(req.body.winner_side);
  const cupsVal = req.body.cups_remaining !== '' && req.body.cups_remaining != null ? Number(req.body.cups_remaining) : null;
  const otVal = Number(req.body.overtime) || 0;
  const playedAt = req.body.played_at || new Date().toISOString();
  const notes = req.body.notes || null;

  if (winnerSide !== 1 && winnerSide !== 2) {
    return redirectWithMessage(res, `/tournaments/${tournamentId}/matches/${tmId}/enter`, 'Bitte Gewinner wählen');
  }

  const executeTournamentMatch = db.transaction(() => {
    const tm = db.prepare('SELECT * FROM tournament_matches WHERE id = ? AND tournament_id = ?').get(tmId, tournamentId);
    if (!tm || tm.winner_side != null) throw new Error('Match nicht verfügbar');

    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
    const winnerIds = winnerSide === 1 ? tm.side1_profile_ids : tm.side2_profile_ids;
    const loserIds = winnerSide === 1 ? tm.side2_profile_ids : tm.side1_profile_ids;
    const winnerProfileArr = winnerIds ? winnerIds.split(',').map(Number) : [];
    const loserProfileArr = loserIds ? loserIds.split(',').map(Number) : [];

    const side1Name = tm.side1_name || profileNamesFromIds(tm.side1_profile_ids);
    const side2Name = tm.side2_name || profileNamesFromIds(tm.side2_profile_ids);

    const matchResult = db.prepare(
      'INSERT INTO matches (mode, played_at, notes, overtime, created_by_profile_id, tournament_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tournament.mode, playedAt, notes, otVal, req.currentUser.id, tournamentId);
    const matchId = matchResult.lastInsertRowid;

    const insertSide = db.prepare(
      'INSERT INTO match_sides (match_id, side_name, is_winner, cups_remaining) VALUES (?, ?, ?, ?)'
    );
    const insertMember = db.prepare(
      'INSERT INTO match_side_members (side_id, profile_id) VALUES (?, ?)'
    );

    const s1IsWinner = winnerSide === 1 ? 1 : 0;
    const s1Result = insertSide.run(matchId, side1Name, s1IsWinner, s1IsWinner ? cupsVal : null);
    const s1Profiles = tm.side1_profile_ids ? tm.side1_profile_ids.split(',').map(Number) : [];
    s1Profiles.forEach(pid => insertMember.run(s1Result.lastInsertRowid, pid));

    const s2IsWinner = winnerSide === 2 ? 1 : 0;
    const s2Result = insertSide.run(matchId, side2Name, s2IsWinner, s2IsWinner ? cupsVal : null);
    const s2Profiles = tm.side2_profile_ids ? tm.side2_profile_ids.split(',').map(Number) : [];
    s2Profiles.forEach(pid => insertMember.run(s2Result.lastInsertRowid, pid));

    db.prepare('UPDATE tournament_matches SET winner_side = ?, match_id = ? WHERE id = ?')
      .run(winnerSide, matchId, tm.id);

    if (tm.next_match_id) {
      const col = (tm.position % 2 === 0) ? 'side1_profile_ids' : 'side2_profile_ids';
      db.prepare(`UPDATE tournament_matches SET ${col} = ? WHERE id = ?`)
        .run(winnerIds, tm.next_match_id);
    } else {
      db.prepare("UPDATE tournaments SET status = 'finished', winner_profile_id = ? WHERE id = ?")
        .run(winnerProfileArr[0], tournamentId);
    }

    sendMatchEmail(matchId).catch(() => {});
  });

  try {
    executeTournamentMatch();
  } catch (err) {
    return redirectWithMessage(res, `/tournaments/${tournamentId}`, err.message);
  }

  res.redirect('/tournaments/' + tournamentId);
});

app.get('/tournaments/:id/pending-matches', requireUser, (req, res) => {
  const matches = db.prepare(`
    SELECT * FROM tournament_matches
    WHERE tournament_id = ? AND side1_profile_ids IS NOT NULL
      AND side2_profile_ids IS NOT NULL AND winner_side IS NULL
    ORDER BY round, position
  `).all(Number(req.params.id));

  const result = matches.map(m => ({
    id: m.id,
    round: m.round,
    side1Names: profileNamesFromIds(m.side1_profile_ids),
    side2Names: profileNamesFromIds(m.side2_profile_ids),
  }));
  res.json(result);
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────
app.get('/settings', requireUser, (req, res) => {
  const user = req.currentUser;
  const html = `
    <div style="max-width:440px;margin:0 auto;">
      <h1 style="margin-bottom:16px;">⚙️ Einstellungen</h1>
      <div style="text-align:center;margin-bottom:16px;">
        ${avatarHtml(user, 64)}
        <div style="font-weight:700;margin-top:8px;">${escapeHtml(user.name)}</div>
      </div>
      <form method="POST" action="/settings">
        <div class="form-group">
          <label>E-Mail</label>
          <input type="email" name="email" value="${escapeHtml(user.email || '')}" placeholder="deine@email.de" />
        </div>
        <div class="form-group">
          <label>Benachrichtigungen</label>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <label class="check-item"><input type="radio" name="notify_mode" value="none" ${user.notify_mode === 'none' ? 'checked' : ''} /> Keine E-Mails</label>
            <label class="check-item"><input type="radio" name="notify_mode" value="all" ${user.notify_mode === 'all' ? 'checked' : ''} /> Alle Ergebnisse</label>
            <label class="check-item"><input type="radio" name="notify_mode" value="mine" ${user.notify_mode === 'mine' ? 'checked' : ''} /> Nur meine Spiele</label>
            <label class="check-item"><input type="radio" name="notify_mode" value="weekly" ${user.notify_mode === 'weekly' ? 'checked' : ''} /> Wöchentliche Top 3</label>
          </div>
        </div>
        <button type="submit" style="width:100%;">Speichern</button>
      </form>
      <form method="POST" action="/logout" style="margin-top:16px;">
        <button type="submit" class="button ghost" style="width:100%;">Ausloggen</button>
      </form>
    </div>
  `;
  res.send(layout(req, 'Einstellungen', html));
});

app.post('/settings', requireUser, (req, res) => {
  const { email, notify_mode } = req.body;
  db.prepare('UPDATE profiles SET email = ?, notify_mode = ? WHERE id = ?')
    .run(email || null, notify_mode || 'none', req.currentUser.id);
  redirectWithMessage(res, '/settings', 'Einstellungen gespeichert!');
});

// ─── EMAIL ───────────────────────────────────────────────────────────────────
async function sendMatchEmail(matchId) {
  if (!transporter) return;
  try {
    const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
    if (!match) return;

    const sides = db.prepare(`
      SELECT ms.*, GROUP_CONCAT(p.name, ', ') as playerNames,
             GROUP_CONCAT(p.email, ',') as playerEmails
      FROM match_sides ms
      JOIN match_side_members msm ON msm.side_id = ms.id
      JOIN profiles p ON p.id = msm.profile_id
      WHERE ms.match_id = ?
      GROUP BY ms.id
    `).all(matchId);

    const profiles = db.prepare(`
      SELECT DISTINCT p.email, p.notify_mode, p.name
      FROM profiles p
      JOIN match_side_members msm ON msm.profile_id = p.id
      JOIN match_sides ms ON ms.id = msm.side_id
      WHERE ms.match_id = ? AND p.email IS NOT NULL AND p.email != ''
        AND p.notify_mode IN ('all', 'mine')
    `).all(matchId);

    if (profiles.length === 0) return;

    const subject = `🏆 Capsen Ergebnis – ${match.mode.toUpperCase()} – ${formatDate(match.played_at)}`;

    const html = `
      <div style="font-family: DM Sans, sans-serif; background: #060d18;
                  color: #f0f4f8; padding: 24px; border-radius: 16px;
                  max-width: 480px; margin: 0 auto;">
        <h1 style="font-family: Georgia, serif; color: #00ff87;
                   margin: 0 0 16px;">🏓 Capsen Ergebnis</h1>
        <p style="color: #7a8fa6;">${match.mode.toUpperCase()} · ${formatDate(match.played_at)}</p>
        ${sides.map(side => `
          <div style="padding: 12px; margin: 8px 0; border-radius: 12px;
               background: ${side.is_winner ? 'rgba(0,255,135,0.1)' : 'rgba(255,255,255,0.05)'};
               border: 1px solid ${side.is_winner ? '#00ff87' : 'rgba(255,255,255,0.1)'};">
            <strong style="color: ${side.is_winner ? '#00ff87' : '#f0f4f8'}">
              ${side.is_winner ? '🏆 ' : ''}${escapeHtml(side.side_name)}
            </strong>
            <div style="color: #7a8fa6; font-size: 14px; margin-top: 4px;">
              ${escapeHtml(side.playerNames)}
              ${side.cups_remaining != null ? ` · ${side.cups_remaining} Restbecher` : ''}
            </div>
          </div>
        `).join('')}
        ${match.overtime > 0 ? `<p style="color: #ff6b35;">⏱ ${match.overtime} Verlängerung(en)</p>` : ''}
        ${match.notes ? `<p style="color: #7a8fa6; font-size: 14px;">${escapeHtml(match.notes)}</p>` : ''}
        <hr style="border-color: rgba(255,255,255,0.08); margin: 16px 0;">
        <p style="font-size: 12px; color: #7a8fa6;">
          Capsen App · <a href="https://spielportal.srv1487908.hstgr.cloud"
          style="color: #38bdf8;">spielportal.srv1487908.hstgr.cloud</a>
        </p>
      </div>
    `;

    for (const profile of profiles) {
      await transporter.sendMail({
        from: `"Capsen" <${SMTP_USER}>`,
        to: profile.email,
        subject,
        html
      });
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

// Weekly email job
function startWeeklyEmailJob() {
  if (!transporter) return;
  setTimeout(async function sendWeekly() {
    try {
      const top3 = db.prepare(`
        SELECT p.name, p.email,
               COUNT(DISTINCT msm.side_id) as wins
        FROM profiles p
        JOIN match_side_members msm ON msm.profile_id = p.id
        JOIN match_sides ms ON ms.id = msm.side_id
        WHERE ms.is_winner = 1
        GROUP BY p.id ORDER BY wins DESC LIMIT 3
      `).all();

      const subscribers = db.prepare(
        "SELECT email, name FROM profiles WHERE notify_mode = 'weekly' AND email != '' AND email IS NOT NULL"
      ).all();

      if (subscribers.length === 0 || top3.length === 0) {
        setTimeout(sendWeekly, 7 * 24 * 60 * 60 * 1000);
        return;
      }

      const html = `
        <div style="font-family: DM Sans, sans-serif; background: #060d18;
                    color: #f0f4f8; padding: 24px; border-radius: 16px;
                    max-width: 480px; margin: 0 auto;">
          <h1 style="font-family: Georgia, serif; color: #00ff87;
                     margin: 0 0 16px;">🏆 Capsen Wochenrückblick</h1>
          <p style="color: #7a8fa6; margin-bottom: 16px;">Die Top 3 dieser Woche:</p>
          ${top3.map((p, i) => `
            <div style="padding: 12px; margin: 6px 0; border-radius: 12px;
                 background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);">
              <strong style="color: ${i === 0 ? '#ffd700' : '#f0f4f8'};">
                ${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} ${escapeHtml(p.name)}
              </strong>
              <span style="color: #00ff87; float: right;">${p.wins} Siege</span>
            </div>
          `).join('')}
          <hr style="border-color: rgba(255,255,255,0.08); margin: 16px 0;">
          <p style="font-size: 12px; color: #7a8fa6;">
            Capsen App · <a href="https://spielportal.srv1487908.hstgr.cloud"
            style="color: #38bdf8;">spielportal.srv1487908.hstgr.cloud</a>
          </p>
        </div>
      `;

      for (const sub of subscribers) {
        await transporter.sendMail({
          from: `"Capsen" <${SMTP_USER}>`,
          to: sub.email,
          subject: '🏆 Capsen Wochenrückblick – Top 3',
          html
        });
      }
    } catch (err) {
      console.error('Weekly email failed:', err.message);
    }
    setTimeout(sendWeekly, 7 * 24 * 60 * 60 * 1000);
  }, 7 * 24 * 60 * 60 * 1000);
}
startWeeklyEmailJob();

// ─── ERROR HANDLER ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send(layout(req, 'Fehler',
    '<div class="card"><h2>Etwas ist schiefgelaufen.</h2>' +
    '<p class="subtle">' + escapeHtml(err.message) + '</p>' +
    '<a class="button ghost" href="/">Zurück</a></div>'));
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🏓 Capsen läuft auf http://localhost:${PORT}`);
});
