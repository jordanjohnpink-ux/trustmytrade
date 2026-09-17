'use strict';
require('dotenv').config();
const express    = require('express');
const { DatabaseSync } = require('node:sqlite');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const Stripe      = require('stripe');

const app = express();
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const db  = new DatabaseSync(process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'monasite.db'));
const PORT = process.env.PORT || 4000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if (DATA_DIR !== __dirname) {
    // Uploaded content lives on the persistent volume; site-bundled assets
    // (images/site, images/badges, etc.) still ship with the repo below.
    ['logos', 'covers', 'gallery'].forEach(d => {
        app.use(`/images/${d}`, express.static(path.join(DATA_DIR, 'images', d)));
    });
    app.use('/documents/compliance', express.static(path.join(DATA_DIR, 'documents', 'compliance')));
}
app.use(express.static(__dirname));

// ── Database setup ──────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS businesses (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    name                   TEXT NOT NULL,
    slug                   TEXT UNIQUE,
    category               TEXT DEFAULT '',
    area                   TEXT DEFAULT '',
    town                   TEXT DEFAULT '',
    county                 TEXT DEFAULT '',
    postcode               TEXT DEFAULT '',
    description            TEXT DEFAULT '',
    short_desc             TEXT DEFAULT '',
    phone                  TEXT DEFAULT '',
    email                  TEXT DEFAULT '',
    website                TEXT DEFAULT '',
    logo_path              TEXT DEFAULT '',
    cover_path             TEXT DEFAULT '',
    plan                   TEXT DEFAULT 'starter',
    status                 TEXT DEFAULT 'pending',
    api_key                TEXT UNIQUE,
    review_count           INTEGER DEFAULT 0,
    avg_rating             REAL DEFAULT 0,
    rank_score             REAL DEFAULT 0,
    featured               INTEGER DEFAULT 0,
    stripe_customer_id     TEXT DEFAULT '',
    stripe_subscription_id TEXT DEFAULT '',
    verified_at            TEXT DEFAULT '',
    created_at             TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS business_owners (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id   INTEGER NOT NULL,
    name          TEXT DEFAULT '',
    email         TEXT UNIQUE,
    password_hash TEXT DEFAULT '',
    token         TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reviews (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id    INTEGER NOT NULL,
    reviewer_name  TEXT DEFAULT '',
    reviewer_email TEXT DEFAULT '',
    rating         INTEGER DEFAULT 5,
    title          TEXT DEFAULT '',
    body           TEXT DEFAULT '',
    status         TEXT DEFAULT 'pending',
    reply          TEXT DEFAULT '',
    replied_at     TEXT DEFAULT '',
    source         TEXT DEFAULT 'site',
    created_at     TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_tokens (
    token      TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migrations
try { db.exec("ALTER TABLE businesses ADD COLUMN categories TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN gallery TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN lat REAL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN lng REAL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN promo_expires_at TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN pre_promo_plan TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN billing_status TEXT DEFAULT 'awaiting_payment'"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN suspended_reason TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN last_payment_at TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN has_restricted_categories INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE businesses ADD COLUMN restricted_review_status TEXT DEFAULT NULL"); } catch {} // pending | approved | rejected
try { db.exec("ALTER TABLE businesses ADD COLUMN restricted_requirements TEXT DEFAULT '[]'"); } catch {} // JSON array: documents/insurance/qualifications
try { db.exec("ALTER TABLE businesses ADD COLUMN compliance_docs TEXT DEFAULT '[]'"); } catch {} // JSON array of {filename, original_name, uploaded_at}
db.prepare(`UPDATE businesses SET categories=json_array(category) WHERE (categories IS NULL OR categories='[]') AND category!=''`).run();

db.exec(`
CREATE TABLE IF NOT EXISTS discount_codes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL DEFAULT 'percent',
    value      REAL NOT NULL,
    expires_at TEXT DEFAULT NULL,
    max_uses   INTEGER DEFAULT NULL,
    use_count  INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discount_uses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id       INTEGER NOT NULL,
    business_name TEXT DEFAULT '',
    owner_email   TEXT DEFAULT '',
    used_at       TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT NOT NULL DEFAULT 'issue',
    message        TEXT NOT NULL DEFAULT '',
    reporter_email TEXT DEFAULT '',
    trader_name    TEXT DEFAULT '',
    business_slug  TEXT DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'open',
    created_at     TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS locations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    slug             TEXT UNIQUE,
    sort_order       INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    description      TEXT DEFAULT '',
    seo_title        TEXT DEFAULT '',
    seo_description  TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   INTEGER,
    details     TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS daily_stats (
    date              TEXT PRIMARY KEY,
    total_businesses  INTEGER DEFAULT 0,
    active_businesses INTEGER DEFAULT 0,
    total_reviews     INTEGER DEFAULT 0,
    pending_reviews   INTEGER DEFAULT 0,
    open_reports      INTEGER DEFAULT 0,
    new_enquiries     INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enquiries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    name        TEXT DEFAULT '',
    email       TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'new',
    created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS support_tickets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id INTEGER NOT NULL,
    owner_email TEXT DEFAULT '',
    subject     TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open',
    reply       TEXT DEFAULT '',
    replied_at  TEXT DEFAULT '',
    created_at  TEXT DEFAULT (datetime('now'))
);
`);

// Categories: visibility, restriction, compliance-requirement and SEO fields
try { db.exec("ALTER TABLE categories ADD COLUMN slug TEXT"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch {} // active | coming_soon | disabled
try { db.exec("ALTER TABLE categories ADD COLUMN is_restricted INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN requires_documents INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN requires_insurance INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN requires_qualifications INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN requires_manual_approval INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN seo_title TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN seo_description TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN description TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE categories ADD COLUMN updated_at TEXT"); } catch {} // SQLite forbids a non-constant default in ADD COLUMN once rows exist
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug)"); } catch {}

// Backfill slugs for any pre-existing rows that predate the slug column
function slugify(name) {
    return String(name).toLowerCase().trim()
        .replace(/&/g, ' ')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
db.prepare('SELECT id, name FROM categories WHERE slug IS NULL OR slug = ?').all('').forEach(c => {
    let base = slugify(c.name), slug = base, n = 2;
    while (db.prepare('SELECT 1 FROM categories WHERE slug=? AND id!=?').get(slug, c.id)) { slug = `${base}-${n++}`; }
    db.prepare('UPDATE categories SET slug=? WHERE id=?').run(slug, c.id);
});

// Seed categories from the original hardcoded list, once, if the table is empty
if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n === 0) {
    const defaults = [
        'Builder','Electrician','Plumber','Roofer','Carpenter','Painter & Decorator',
        'Landscaper','Plasterer','HVAC / Heating','Locksmith','Glazier','Flooring',
        'Kitchen & Bathroom','Solar & Renewables','Architect','Surveyor',
        'Restaurant','Café','Pub & Bar','Takeaway','Hotel','Gym & Fitness',
        'Hair & Beauty','Garage & MOT','Dentist','Optician','Accountant',
        'Solicitor','Estate Agent','Letting Agent','Cleaning','Removals','IT Support','Other',
    ];
    const stmt = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    defaults.forEach((name, i) => stmt.run(name, i));
}

// Default settings
[
    ['site_name', 'Monasite'],
    ['site_tagline', 'Find Trusted Local Businesses'],
    ['starter_price', '19'],
    ['pro_price', '39'],
    ['featured_price', '79'],
    ['site_url', ''],
    ['cat_limit_starter', '1'],
    ['cat_limit_pro', '3'],
    ['cat_limit_featured', '5'],
    ['search_radius_default_miles', '20'],
    ['featured_pin_radius_miles', '15'],
    ['featured_pin_max', '3'],
    ['stripe_secret_key', ''],
    ['stripe_publishable_key', ''],
    ['stripe_webhook_secret', ''],
    ['stripe_price_starter', ''],
    ['stripe_price_pro', ''],
    ['stripe_price_featured', ''],
].forEach(([k, v]) => {
    db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(k, v);
});

// Upload dirs
['images/logos','images/covers','images/gallery','images/site','documents/compliance'].forEach(d => {
    const full = path.join(DATA_DIR, d);
    if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function hashPass(pass) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pass, salt, 100000, 64, 'sha512').toString('hex');
    return salt + ':' + hash;
}
function verifyPass(pass, stored) {
    const [salt, hash] = stored.split(':');
    return hash === crypto.pbkdf2Sync(pass, salt, 100000, 64, 'sha512').toString('hex');
}
function genToken() { return crypto.randomBytes(32).toString('hex'); }
function genApiKey() { return crypto.randomBytes(20).toString('hex'); }
function makeSlug(name, area) {
    const base = [name, area].join('-').toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
    const suffix = crypto.randomBytes(3).toString('hex');
    return base + '-' + suffix;
}
function calcRankScore(avgRating, reviewCount, plan) {
    const mult = { starter: 1.0, pro: 1.1, featured: 1.3 }[plan] || 1.0;
    return parseFloat((avgRating * Math.log(reviewCount + 1) * mult).toFixed(4));
}
function updateBusinessStats(businessId) {
    const stats = db.prepare(`
        SELECT COUNT(*) AS cnt, ROUND(AVG(rating),2) AS avg
        FROM reviews WHERE business_id=? AND status='approved'
    `).get(businessId);
    const cnt = stats.cnt || 0;
    const avg = stats.avg || 0;
    const biz = db.prepare('SELECT plan FROM businesses WHERE id=?').get(businessId);
    const score = calcRankScore(avg, cnt, biz?.plan || 'starter');
    db.prepare('UPDATE businesses SET review_count=?, avg_rating=?, rank_score=? WHERE id=?')
        .run(cnt, avg, score, businessId);
}
// Reverts any business whose promo period has ended back to its plan from before the promo.
function expirePromos() {
    const expired = db.prepare("SELECT id, pre_promo_plan FROM businesses WHERE promo_expires_at IS NOT NULL AND promo_expires_at <= datetime('now')").all();
    for (const b of expired) {
        const revertPlan = b.pre_promo_plan || 'starter';
        db.prepare("UPDATE businesses SET plan=?, featured=?, promo_expires_at=NULL, pre_promo_plan=NULL WHERE id=?")
            .run(revertPlan, revertPlan === 'featured' ? 1 : 0, b.id);
        updateBusinessStats(b.id);
    }
}
// Stripe credentials/price IDs can be set via the admin panel (stored in `settings`) or
// left to fall back to .env — admin-panel values always win once set, so they take effect
// immediately without a server restart.
function stripeSetting(key, envKey) {
    const s = settings();
    return s[key] || process.env[envKey] || '';
}
function getStripe() {
    return new Stripe(stripeSetting('stripe_secret_key', 'STRIPE_SECRET_KEY') || 'sk_test_placeholder');
}
const stripeConfigured = () => !!stripeSetting('stripe_secret_key', 'STRIPE_SECRET_KEY');
function priceIdForPlan(plan) {
    return {
        starter: stripeSetting('stripe_price_starter', 'STRIPE_PRICE_STARTER'),
        pro: stripeSetting('stripe_price_pro', 'STRIPE_PRICE_PRO'),
        featured: stripeSetting('stripe_price_featured', 'STRIPE_PRICE_FEATURED'),
    }[plan];
}
function planForPriceId(priceId) {
    const map = {
        [stripeSetting('stripe_price_starter', 'STRIPE_PRICE_STARTER')]: 'starter',
        [stripeSetting('stripe_price_pro', 'STRIPE_PRICE_PRO')]: 'pro',
        [stripeSetting('stripe_price_featured', 'STRIPE_PRICE_FEATURED')]: 'featured',
    };
    return map[priceId] || null;
}
function findBusinessByCustomer(customerId) {
    return db.prepare('SELECT * FROM businesses WHERE stripe_customer_id=?').get(customerId);
}
// Strip fields that should never reach a public response (API keys, Stripe IDs, internal billing state)
function publicBiz(b) {
    const { api_key, stripe_customer_id, stripe_subscription_id, suspended_reason, ...rest } = b;
    return rest;
}
function settings() {
    return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
}
function siteUrl() {
    const s = settings();
    return (s.site_url || SITE_URL).replace(/\/$/, '');
}
// Public, default-visible category names only — used by signup/profile category pickers
function getCategories() {
    return db.prepare("SELECT name FROM categories WHERE is_public=1 AND status='active' ORDER BY sort_order, id").all().map(r => r.name);
}
// All categories not explicitly disabled — lets admin assign hidden categories to a trader manually
function getAssignableCategories() {
    return db.prepare("SELECT name FROM categories WHERE status!='disabled' ORDER BY sort_order, id").all().map(r => r.name);
}
function getCategoryRow(name) {
    return db.prepare('SELECT * FROM categories WHERE name=?').get(name);
}
function isRestrictedCategory(name) {
    const c = getCategoryRow(name);
    return !!(c && c.is_restricted);
}
// Union of compliance requirements across a set of selected category names
function computeRestrictedRequirements(categoryNames) {
    const reqs = new Set();
    for (const name of categoryNames) {
        const c = getCategoryRow(name);
        if (!c || !c.is_restricted) continue;
        if (c.requires_documents) reqs.add('documents');
        if (c.requires_insurance) reqs.add('insurance');
        if (c.requires_qualifications) reqs.add('qualifications');
    }
    return [...reqs];
}
// Restricted categories require manual review — preserves an existing approval if the
// approved set of categories hasn't changed, otherwise (re-)flags it for review.
function computeRestrictedFields(validCats, previousReviewStatus) {
    const has = validCats.some(isRestrictedCategory);
    return {
        has_restricted_categories: has ? 1 : 0,
        restricted_review_status: has ? (previousReviewStatus === 'approved' ? 'approved' : 'pending') : null,
        restricted_requirements: JSON.stringify(computeRestrictedRequirements(validCats)),
    };
}
function seoDefaults(name) {
    return {
        seo_title: `${name} Near You | Trusted Local Trades`,
        seo_description: `Find trusted ${name} near you. Compare verified local trades, read reviews, and request quotes from approved professionals.`,
    };
}
function getCatLimits() {
    const s = settings();
    return {
        starter:  parseInt(s.cat_limit_starter) || 1,
        pro:      parseInt(s.cat_limit_pro) || 3,
        featured: parseInt(s.cat_limit_featured) || 5,
    };
}
// Admin action trail — actor is always 'Admin' since there's a single shared admin login,
// not per-person attribution (that needs named staff accounts, which don't exist yet).
function logAudit(action, entity_type, entity_id, details = '') {
    db.prepare('INSERT INTO audit_logs (action,entity_type,entity_id,details) VALUES (?,?,?,?)')
        .run(action, entity_type, entity_id ?? null, details);
}
// One row per calendar day of headline counts, so Analytics has real (if short) history to
// chart instead of fabricated trends. INSERT OR IGNORE means redeploys/restarts never
// duplicate or skip today's snapshot.
function snapshotDailyStats() {
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT OR IGNORE INTO daily_stats (date, total_businesses, active_businesses, total_reviews, pending_reviews, open_reports, new_enquiries)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        today,
        db.prepare("SELECT COUNT(*) AS n FROM businesses").get().n,
        db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status='active'").get().n,
        db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status='approved'").get().n,
        db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status='pending'").get().n,
        db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='open'").get().n,
        db.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE date(created_at)=?").get(today).n,
    );
}

// ── Email ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
});
async function sendMail(to, subject, html) {
    if (!process.env.EMAIL_USER) return;
    await transporter.sendMail({ from: process.env.EMAIL_FROM, to, subject, html });
}

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const row = db.prepare('SELECT 1 FROM admin_tokens WHERE token=?').get(token);
    if (!row) return res.status(401).json({ error: 'Unauthorised' });
    next();
}
function requireOwner(req, res, next) {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const owner = db.prepare('SELECT * FROM business_owners WHERE token=?').get(token);
    if (!owner) return res.status(401).json({ error: 'Unauthorised' });
    req.owner = owner;
    req.business = db.prepare('SELECT * FROM businesses WHERE id=?').get(owner.business_id);
    next();
}

// ── Multer ───────────────────────────────────────────────────────────────────
const imgFilter = (req, file, cb) => {
    ['image/jpeg','image/png','image/webp','image/svg+xml','image/x-icon','image/vnd.microsoft.icon'].includes(file.mimetype)
        ? cb(null, true) : cb(new Error('Images only'));
};
const docFilter = (req, file, cb) => {
    ['application/pdf','image/jpeg','image/png','image/webp'].includes(file.mimetype)
        ? cb(null, true) : cb(new Error('PDF or image files only'));
};
function makeStorage(folder, nameFn) {
    return multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(DATA_DIR, folder)),
        filename: (req, file, cb) => cb(null, nameFn(req, file)),
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════════

// Categories list
app.get('/api/categories', (req, res) => res.json(getCategories()));
app.get('/api/plan-limits', (req, res) => res.json(getCatLimits()));

// Lightweight per-category metadata for onboarding hints (restricted/compliance flags are not sensitive)
app.get('/api/categories/meta', (req, res) => {
    res.json(db.prepare(`SELECT name, is_restricted, requires_documents, requires_insurance, requires_qualifications
                          FROM categories WHERE status!='disabled' ORDER BY sort_order, id`).all());
});

// Full public category list for the /categories browsing page — public+active only
app.get('/api/public-categories', (req, res) => {
    const { q, name } = req.query;
    let sql = "SELECT name, slug, description, seo_title, seo_description FROM categories WHERE is_public=1 AND status='active'";
    const params = [];
    if (name) { sql += ' AND name=?'; params.push(name); }
    else if (q) { sql += ' AND name LIKE ?'; params.push(`%${q}%`); }
    sql += ' ORDER BY sort_order, id';
    res.json(db.prepare(sql).all(...params));
});
app.get('/api/public-categories/:slug', (req, res) => {
    const c = db.prepare("SELECT name, slug, description, seo_title, seo_description FROM categories WHERE slug=? AND is_public=1 AND status='active'").get(req.params.slug);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
});

// A featured listing only gets the "pinned to top" boost if it's genuinely local —
// otherwise a business 100 miles away could out-rank closer, non-featured results.
// (Radius/cap values are admin-configurable — see settings() keys featured_pin_*.)

function haversineMiles(lat1, lon1, lat2, lon2) {
    const R = 3958.8; // Earth radius in miles
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function geocodePostcode(raw) {
    if (!raw) return null;
    const code = raw.replace(/\s/g, '').toUpperCase();
    try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(code)}`);
        const data = await r.json();
        if (data.status === 200 && data.result) return { lat: data.result.latitude, lng: data.result.longitude };
    } catch {}
    // Fall back to outcode (e.g. "CT9" or partial postcode) for a less precise but still local centroid
    try {
        const outcode = code.match(/^[A-Z]{1,2}[0-9][A-Z0-9]?/)?.[0];
        if (!outcode) return null;
        const r = await fetch(`https://api.postcodes.io/outcodes/${encodeURIComponent(outcode)}`);
        const data = await r.json();
        if (data.status === 200 && data.result) return { lat: data.result.latitude, lng: data.result.longitude };
    } catch {}
    return null;
}

// Directory listing
app.get('/api/businesses', async (req, res) => {
    expirePromos();
    const { area, category, sort = 'rank', q, plan, page = 1, near, radius } = req.query;
    const limit = 20;
    const offset = (parseInt(page) - 1) * limit;
    let where = ["b.status='active'"];
    const params = [];
    // `near` is a postcode/town the searcher entered — try to geocode it for real distance filtering
    const geo = near ? await geocodePostcode(near) : null;
    if (area && !geo) { where.push("(b.area LIKE ? OR b.town LIKE ? OR b.county LIKE ? OR b.postcode LIKE ?)"); params.push(`%${area}%`,`%${area}%`,`%${area}%`,`%${area}%`); }
    if (near && !geo) { where.push("(b.area LIKE ? OR b.town LIKE ? OR b.county LIKE ? OR b.postcode LIKE ?)"); params.push(`%${near}%`,`%${near}%`,`%${near}%`,`%${near}%`); }
    // Match primary category OR any secondary category in the JSON array
    if (category) { where.push("(b.category=? OR b.categories LIKE ?)"); params.push(category, `%"${category}"%`); }
    if (plan)     { where.push('b.plan=?'); params.push(plan); }
    if (q)        { where.push('(b.name LIKE ? OR b.description LIKE ?)'); params.push(`%${q}%`,`%${q}%`); }

    const allRows = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM reviews r WHERE r.business_id=b.id AND r.status='approved') AS rc
                                 FROM businesses b WHERE ${where.join(' AND ')}`).all(...params);

    const cfg = settings();
    const defaultRadiusMiles = parseFloat(cfg.search_radius_default_miles) || 20;
    const featuredPinRadiusMiles = parseFloat(cfg.featured_pin_radius_miles) || 15;
    const featuredPinMax = parseInt(cfg.featured_pin_max) || 3;
    const radiusMiles = Math.min(parseFloat(radius) || defaultRadiusMiles, 100);
    let candidates = allRows;
    if (geo) {
        candidates = allRows
            .filter(b => b.lat != null && b.lng != null)
            .map(b => ({ ...b, distance_miles: haversineMiles(geo.lat, geo.lng, b.lat, b.lng) }))
            .filter(b => b.distance_miles <= radiusMiles);
    }

    // Featured pinning: only when browsing that category, only if local enough, and capped
    // so a flood of featured businesses can't all pin to the top of every search.
    const isPinned = b => {
        if (!b.featured) return false;
        if (category && b.category !== category) return false;
        if (geo && b.distance_miles > featuredPinRadiusMiles) return false;
        return true;
    };
    const pinned = candidates.filter(isPinned)
        .sort((a, b) => geo ? a.distance_miles - b.distance_miles : b.rank_score - a.rank_score)
        .slice(0, featuredPinMax);
    const pinnedIds = new Set(pinned.map(b => b.id));
    const rest = candidates.filter(b => !pinnedIds.has(b.id));

    const sorters = {
        rank:    (a, b) => geo ? a.distance_miles - b.distance_miles : b.rank_score - a.rank_score,
        reviews: (a, b) => b.review_count - a.review_count,
        rating:  (a, b) => b.avg_rating - a.avg_rating,
        newest:  (a, b) => new Date(b.created_at) - new Date(a.created_at),
        nearest: (a, b) => (a.distance_miles ?? Infinity) - (b.distance_miles ?? Infinity),
    };
    rest.sort(sorters[sort] || sorters.rank);

    const final = pinned.concat(rest);
    const total = final.length;
    const rows  = final.slice(offset, offset + limit).map(publicBiz);
    res.json({
        businesses: rows,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit) || 1,
        geo: geo ? { radius_miles: radiusMiles } : null,
        near_not_found: !!(near && !geo),
    });
});

// Single business by slug
app.get('/api/businesses/:slug', (req, res) => {
    const b = db.prepare("SELECT * FROM businesses WHERE slug=? AND status='active'").get(req.params.slug);
    if (!b) return res.status(404).json({ error: 'Not found' });
    res.json(publicBiz(b));
});

// Reviews for a business
app.get('/api/businesses/:slug/reviews', (req, res) => {
    const b = db.prepare("SELECT id FROM businesses WHERE slug=?").get(req.params.slug);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const reviews = db.prepare("SELECT * FROM reviews WHERE business_id=? AND status='approved' ORDER BY created_at DESC").all(b.id);
    res.json(reviews);
});

// Submit a review
app.post('/api/reviews', (req, res) => {
    const { slug, reviewer_name, reviewer_email, rating, title, body } = req.body;
    if (!slug || !reviewer_name || !rating) return res.status(400).json({ error: 'Missing fields' });
    const b = db.prepare("SELECT * FROM businesses WHERE slug=? AND status='active'").get(slug);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    const r = parseInt(rating);
    if (r < 1 || r > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
    // Check for duplicate email review
    const dupe = db.prepare('SELECT id FROM reviews WHERE business_id=? AND reviewer_email=?').get(b.id, reviewer_email||'');
    if (dupe && reviewer_email) return res.status(409).json({ error: 'You have already reviewed this business' });
    db.prepare('INSERT INTO reviews (business_id,reviewer_name,reviewer_email,rating,title,body,status) VALUES (?,?,?,?,?,?,?)')
        .run(b.id, reviewer_name.trim(), reviewer_email||'', r, title||'', body||'', 'pending');
    // Notify admin
    sendMail(process.env.EMAIL_USER, `New review for ${b.name}`,
        `<p><strong>${reviewer_name}</strong> left a ${r}★ review for <strong>${b.name}</strong>.</p><p><em>${body}</em></p><p><a href="${siteUrl()}/admin">Review in admin panel</a></p>`
    ).catch(()=>{});
    res.json({ ok: true, message: 'Review submitted — pending approval' });
});

// Enquiries — a visitor contacting a business directly through its listing, no account needed
app.post('/api/businesses/:slug/enquiries', (req, res) => {
    const { name, email, phone, message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Please enter a message' });
    const b = db.prepare("SELECT * FROM businesses WHERE slug=? AND status='active'").get(req.params.slug);
    if (!b) return res.status(404).json({ error: 'Business not found' });
    const r = db.prepare('INSERT INTO enquiries (business_id,name,email,phone,message) VALUES (?,?,?,?,?)')
        .run(b.id, (name||'').trim(), (email||'').trim(), (phone||'').trim(), message.trim());
    const owner = db.prepare('SELECT * FROM business_owners WHERE business_id=?').get(b.id);
    if (owner) {
        sendMail(owner.email, `New enquiry — ${b.name}`,
            `<p>You have a new enquiry via your ${siteUrl()} listing:</p>
             <p><strong>From:</strong> ${name || '(no name given)'}${email?` (${email})`:''}${phone?` · ${phone}`:''}</p>
             <p>${message}</p>
             <p><a href="${siteUrl()}/dashboard">View in your dashboard</a></p>`
        ).catch(()=>{});
    }
    res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/admin/enquiries', requireAdmin, (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE e.status=?' : '';
    const params = status ? [status] : [];
    res.json(db.prepare(`
        SELECT e.*, b.name AS business_name, b.slug AS business_slug
        FROM enquiries e JOIN businesses b ON b.id=e.business_id
        ${where} ORDER BY e.created_at DESC LIMIT 300
    `).all(...params));
});
app.put('/api/admin/enquiries/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['new','read','archived'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE enquiries SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ ok: true });
});
app.get('/api/owner/enquiries', requireOwner, (req, res) => {
    res.json(db.prepare('SELECT * FROM enquiries WHERE business_id=? ORDER BY created_at DESC').all(req.business.id));
});

// Support tickets — a business owner contacting admin for help, distinct from public Reports
app.post('/api/owner/support', requireOwner, (req, res) => {
    const { subject, message } = req.body;
    if (!subject || !subject.trim()) return res.status(400).json({ error: 'Please enter a subject' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Please enter a message' });
    const r = db.prepare('INSERT INTO support_tickets (business_id,owner_email,subject,message) VALUES (?,?,?,?)')
        .run(req.business.id, req.owner.email, subject.trim(), message.trim());
    sendMail(process.env.EMAIL_USER, `New support ticket — ${req.business.name}`,
        `<p><strong>${req.business.name}</strong> (${req.owner.email}) opened a support ticket:</p>
         <p><strong>${subject}</strong></p><p>${message}</p>
         <p><a href="${siteUrl()}/admin">Reply in admin panel</a></p>`
    ).catch(()=>{});
    res.json({ ok: true, id: r.lastInsertRowid });
});
app.get('/api/owner/support', requireOwner, (req, res) => {
    res.json(db.prepare('SELECT * FROM support_tickets WHERE business_id=? ORDER BY created_at DESC').all(req.business.id));
});
app.get('/api/admin/support-tickets', requireAdmin, (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE t.status=?' : '';
    const params = status ? [status] : [];
    res.json(db.prepare(`
        SELECT t.*, b.name AS business_name
        FROM support_tickets t JOIN businesses b ON b.id=t.business_id
        ${where} ORDER BY t.created_at DESC LIMIT 300
    `).all(...params));
});
app.put('/api/admin/support-tickets/:id/reply', requireAdmin, (req, res) => {
    const { reply } = req.body;
    if (!reply || !reply.trim()) return res.status(400).json({ error: 'Please enter a reply' });
    const t = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE support_tickets SET reply=?, replied_at=datetime('now'), status='resolved' WHERE id=?").run(reply.trim(), t.id);
    if (t.owner_email) {
        sendMail(t.owner_email, `Reply to your support ticket — ${t.subject}`,
            `<p>You wrote:</p><p><em>${t.message}</em></p><p>Our reply:</p><p>${reply}</p>`
        ).catch(()=>{});
    }
    logAudit('support_ticket.replied', 'support_ticket', t.id, t.subject);
    res.json({ ok: true });
});

// Widget data (CORS enabled — called from business websites)
app.get('/api/widget/:apiKey', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = db.prepare("SELECT id,name,slug,avg_rating,review_count,plan,verified_at,logo_path FROM businesses WHERE api_key=? AND status='active'").get(req.params.apiKey);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (!['pro','featured'].includes(b.plan)) return res.status(403).json({ error: 'Widget requires Pro or Featured plan' });
    res.json({ ...b, profile_url: `${siteUrl()}/business/${b.slug}` });
});

// Trusted badge SVG
app.get('/api/badge/:apiKey.svg', (req, res) => {
    const b = db.prepare("SELECT name,avg_rating,review_count,plan,verified_at FROM businesses WHERE api_key=? AND status='active'").get(req.params.apiKey);
    if (!b || !['pro','featured'].includes(b.plan)) {
        res.status(404).end(); return;
    }
    const stars = Math.round(b.avg_rating || 0);
    const starStr = '★'.repeat(stars) + '☆'.repeat(5 - stars);
    const gold = '#C9A84C';
    const navy = '#2A2823';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">
  <rect width="200" height="80" rx="6" fill="${navy}"/>
  <rect x="1" y="1" width="198" height="78" rx="5" fill="none" stroke="${gold}" stroke-width="1.5"/>
  <text x="100" y="18" fill="${gold}" font-size="9" font-family="sans-serif" text-anchor="middle" font-weight="bold" letter-spacing="2">MONASITE</text>
  <text x="100" y="34" fill="#fff" font-size="8" font-family="sans-serif" text-anchor="middle" letter-spacing="1">✓ VERIFIED &amp; TRUSTED</text>
  <text x="100" y="54" fill="${gold}" font-size="16" font-family="sans-serif" text-anchor="middle">${starStr}</text>
  <text x="100" y="70" fill="rgba(255,255,255,0.6)" font-size="8" font-family="sans-serif" text-anchor="middle">${b.review_count} Review${b.review_count !== 1 ? 's' : ''} · ${(b.avg_rating||0).toFixed(1)} / 5</text>
</svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(svg);
});

// Public settings — whitelist only; never leak admin_password_hash etc.
const PUBLIC_SETTINGS = ['site_name','site_tagline','starter_price','pro_price','featured_price'];
app.get('/api/settings', (req, res) => {
    const s = settings();
    res.json(Object.fromEntries(PUBLIC_SETTINGS.map(k => [k, s[k]])));
});

// Synchronous settings script — loaded in <head> so window.SITE is available before any page JS
app.get('/settings.js', (req, res) => {
    const s = settings();
    const name    = (s.site_name    || 'Trustmytrade').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const tagline = (s.site_tagline || '').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const logo    = s.site_logo    ? `/${s.site_logo}`    : '';
    const favicon = s.site_favicon ? 1 : 0;
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(`window.SITE={name:'${name}',tagline:'${tagline}',logo:'${logo}',favicon:${favicon}};`);
});

// Serve uploaded favicon at the standard path
app.get('/favicon.ico', (req, res) => {
    const fav = settings().site_favicon;
    if (fav) return res.sendFile(path.join(__dirname, fav), err => { if (err) res.status(204).end(); });
    res.status(204).end();
});

// ══════════════════════════════════════════════════════════════════════════════
// BUSINESS SIGNUP
// ══════════════════════════════════════════════════════════════════════════════

// ── Discount codes ───────────────────────────────────────────────────────────

app.post('/api/validate-discount', (req, res) => {
    const code = (req.body.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Enter a discount code' });
    const dc = db.prepare('SELECT * FROM discount_codes WHERE UPPER(code)=?').get(code);
    if (!dc) return res.status(404).json({ error: 'Invalid discount code' });
    if (dc.expires_at && new Date(dc.expires_at) < new Date())
        return res.status(400).json({ error: 'This code has expired' });
    if (dc.max_uses !== null && dc.use_count >= dc.max_uses)
        return res.status(400).json({ error: 'This code has reached its usage limit' });
    res.json({ ok: true, type: dc.type, value: dc.value,
               label: dc.type === 'percent' ? `${dc.value}% off` : `£${dc.value} off` });
});

app.get('/api/admin/discounts', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM discount_codes ORDER BY created_at DESC').all());
});

// ── Reports (Report an Issue / Report a Trader — linked from every page footer) ────────────
app.post('/api/reports', (req, res) => {
    const { type, message, reporter_email, trader_name, business_slug } = req.body;
    if (!['issue', 'trader'].includes(type)) return res.status(400).json({ error: 'Invalid report type' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Please describe the issue' });
    db.prepare('INSERT INTO reports (type,message,reporter_email,trader_name,business_slug) VALUES (?,?,?,?,?)')
        .run(type, message.trim(), (reporter_email||'').trim(), (trader_name||'').trim(), (business_slug||'').trim());
    sendMail(process.env.EMAIL_USER, `New ${type === 'trader' ? 'trader report' : 'issue report'} submitted`,
        `<p><strong>Type:</strong> ${type}</p>${trader_name?`<p><strong>Trader:</strong> ${trader_name}</p>`:''}
         <p><strong>Message:</strong> ${message}</p>${reporter_email?`<p><strong>From:</strong> ${reporter_email}</p>`:''}
         <p><a href="${siteUrl()}/admin">Review in admin panel</a></p>`
    ).catch(()=>{});
    res.json({ ok: true });
});
app.get('/api/admin/reports', requireAdmin, (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE status=?' : '';
    res.json(db.prepare(`SELECT * FROM reports ${where} ORDER BY created_at DESC`).all(...(status ? [status] : [])));
});
app.put('/api/admin/reports/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['open','resolved'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(status, req.params.id);
    logAudit('report.status_changed', 'report', req.params.id, `Status set to ${status}`);
    res.json({ ok: true });
});

app.post('/api/admin/discounts', requireAdmin, (req, res) => {
    const { code, type, value, expires_at, max_uses } = req.body;
    if (!code || !type || value === undefined) return res.status(400).json({ error: 'Missing fields' });
    if (!['percent','fixed'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    const v = parseFloat(value);
    if (isNaN(v) || v <= 0) return res.status(400).json({ error: 'Invalid value' });
    try {
        const r = db.prepare('INSERT INTO discount_codes (code,type,value,expires_at,max_uses) VALUES (?,?,?,?,?)')
            .run(code.trim().toUpperCase(), type, v, expires_at || null, max_uses ? parseInt(max_uses) : null);
        logAudit('discount.created', 'discount', r.lastInsertRowid, `Code ${code.trim().toUpperCase()}`);
        res.json({ ok: true, id: r.lastInsertRowid });
    } catch(e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Code already exists' });
        throw e;
    }
});

app.delete('/api/admin/discounts/:id', requireAdmin, (req, res) => {
    const dc = db.prepare('SELECT code FROM discount_codes WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM discount_uses WHERE code_id=?').run(req.params.id);
    db.prepare('DELETE FROM discount_codes WHERE id=?').run(req.params.id);
    logAudit('discount.deleted', 'discount', req.params.id, dc ? `Code ${dc.code}` : '');
    res.json({ ok: true });
});

app.get('/api/admin/discounts/:id/uses', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM discount_uses WHERE code_id=? ORDER BY used_at DESC').all(req.params.id));
});

// ── Signup ───────────────────────────────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
    const { name, area, town, county, postcode, description, short_desc,
            phone, email, website, owner_name, owner_email, owner_password, plan, discount_code } = req.body;
    if (!name || !owner_email || !owner_password) return res.status(400).json({ error: 'Missing required fields' });
    if (!['starter','pro','featured'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    // Validate and cap categories for the chosen plan
    const rawCats = Array.isArray(req.body.categories) ? req.body.categories : [req.body.category].filter(Boolean);
    const catLimit = getCatLimits()[plan] || 1;
    const validCats = rawCats.filter(c => getCategories().includes(c)).slice(0, catLimit);
    if (!validCats.length) return res.status(400).json({ error: 'Please select at least one category' });
    const primaryCat = validCats[0];
    const rf = computeRestrictedFields(validCats, null);
    // An existing owner whose business never completed its first payment can pick up where
    // they left off (e.g. they closed the Stripe Checkout tab) rather than being locked out.
    const existingOwner = db.prepare('SELECT * FROM business_owners WHERE email=?').get(owner_email);
    const existingBiz = existingOwner && db.prepare('SELECT * FROM businesses WHERE id=?').get(existingOwner.business_id);
    if (existingOwner && !(existingBiz && existingBiz.billing_status === 'awaiting_payment')) {
        return res.status(409).json({ error: 'An account with that email already exists' });
    }

    let bizId, slug;
    if (existingBiz) {
        bizId = existingBiz.id;
        slug = existingBiz.slug;
        const geo = await geocodePostcode(postcode);
        db.prepare(`UPDATE businesses SET name=?,category=?,categories=?,area=?,town=?,county=?,postcode=?,description=?,short_desc=?,phone=?,email=?,website=?,plan=?,lat=?,lng=?,
                    has_restricted_categories=?,restricted_review_status=?,restricted_requirements=? WHERE id=?`)
            .run(name.trim(), primaryCat, JSON.stringify(validCats), area||'', town||'', county||'', postcode||'', description||'', short_desc||'', phone||'', email||'', website||'', plan, geo?.lat ?? null, geo?.lng ?? null,
                 rf.has_restricted_categories, rf.restricted_review_status, rf.restricted_requirements, bizId);
        db.prepare('UPDATE business_owners SET name=?, password_hash=? WHERE id=?').run(owner_name||name, hashPass(owner_password), existingOwner.id);
    } else {
        slug = makeSlug(name, area);
        const api_key = genApiKey();
        const geo = await geocodePostcode(postcode);
        const bizRes = db.prepare(`INSERT INTO businesses (name,slug,category,categories,area,town,county,postcode,description,short_desc,phone,email,website,plan,status,api_key,lat,lng,
                                    has_restricted_categories,restricted_review_status,restricted_requirements)
                                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`)
            .run(name.trim(), slug, primaryCat, JSON.stringify(validCats), area||'', town||'', county||'', postcode||'', description||'', short_desc||'', phone||'', email||'', website||'', plan, api_key, geo?.lat ?? null, geo?.lng ?? null,
                 rf.has_restricted_categories, rf.restricted_review_status, rf.restricted_requirements);
        bizId = bizRes.lastInsertRowid;
        db.prepare('INSERT INTO business_owners (business_id,name,email,password_hash) VALUES (?,?,?,?)')
            .run(bizId, owner_name||name, owner_email.toLowerCase().trim(), hashPass(owner_password));
    }
    // Apply discount code if provided
    const dc = discount_code ? db.prepare('SELECT * FROM discount_codes WHERE UPPER(code)=?').get(discount_code.trim().toUpperCase()) : null;
    const dcValid = dc && !(dc.expires_at && new Date(dc.expires_at) < new Date()) && !(dc.max_uses !== null && dc.use_count >= dc.max_uses);
    if (dcValid) {
        db.prepare('UPDATE discount_codes SET use_count=use_count+1 WHERE id=?').run(dc.id);
        db.prepare('INSERT INTO discount_uses (code_id,business_name,owner_email) VALUES (?,?,?)')
            .run(dc.id, name, owner_email.toLowerCase().trim());
    }

    // No Stripe keys configured (e.g. local/dev) — fall back to the old "submit now, bill later" flow
    const priceId = priceIdForPlan(plan);
    if (!stripeConfigured() || !priceId) {
        sendMail(process.env.EMAIL_USER, `New business signup — ${name}`,
            `<p><strong>${name}</strong> has signed up on the <strong>${plan}</strong> plan and is awaiting vetting.</p><p>Owner: ${owner_name} (${owner_email})</p><p>Area: ${area}, ${county}</p><a href="${siteUrl()}/admin">Review in admin panel</a>`
        ).catch(()=>{});
        sendMail(owner_email, `Welcome to Monasite, ${owner_name||name}!`,
            `<p>Thanks for signing up to Monasite! Your listing for <strong>${name}</strong> is now pending vetting.</p><p>We'll review your details and activate your listing within 1–2 business days.</p><p>Once approved, you'll be able to log in to your dashboard at <a href="${siteUrl()}/dashboard">${siteUrl()}/dashboard</a>.</p>`
        ).catch(()=>{});
        return res.json({ ok: true, slug, message: 'Application submitted — we\'ll verify and activate your listing within 1–2 business days.' });
    }

    // Take payment via Stripe Checkout before the subscription (and vetting queue) goes any further
    try {
        const customer = await getStripe().customers.create({
            email: owner_email, name, metadata: { business_id: String(bizId) },
        });
        db.prepare('UPDATE businesses SET stripe_customer_id=? WHERE id=?').run(customer.id, bizId);

        let discounts;
        if (dcValid) {
            const coupon = await getStripe().coupons.create(
                dc.type === 'percent'
                    ? { percent_off: dc.value, duration: 'once' }
                    : { amount_off: Math.round(dc.value * 100), currency: 'gbp', duration: 'once' }
            );
            discounts = [{ coupon: coupon.id }];
        }

        const session = await getStripe().checkout.sessions.create({
            customer: customer.id,
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            ...(discounts ? { discounts } : { allow_promotion_codes: false }),
            success_url: `${siteUrl()}/dashboard?checkout=success`,
            cancel_url: `${siteUrl()}/signup?checkout=cancelled`,
            metadata: { business_id: String(bizId) },
        });
        res.json({ ok: true, slug, checkout_url: session.url });
    } catch (e) {
        res.status(500).json({ error: 'Could not start checkout: ' + e.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════════
// BUSINESS OWNER API
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/owner/login', (req, res) => {
    const { email, password } = req.body;
    const owner = db.prepare('SELECT * FROM business_owners WHERE email=?').get((email||'').toLowerCase().trim());
    if (!owner || !verifyPass(password, owner.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = genToken();
    db.prepare('UPDATE business_owners SET token=? WHERE id=?').run(token, owner.id);
    const biz = db.prepare('SELECT * FROM businesses WHERE id=?').get(owner.business_id);
    res.json({ token, name: owner.name, business: biz });
});

app.get('/api/owner/me', requireOwner, (req, res) => {
    res.json({ owner: req.owner, business: req.business });
});

app.put('/api/owner/profile', requireOwner, async (req, res) => {
    const { name, area, town, county, postcode, description, short_desc, phone, email, website } = req.body;
    const rawCats = Array.isArray(req.body.categories) ? req.body.categories : [req.body.category].filter(Boolean);
    const catLimit = getCatLimits()[req.business.plan] || 1;
    // Assignable (not just public) so an admin-assigned hidden category the owner already has isn't dropped
    const validCats = rawCats.filter(c => getAssignableCategories().includes(c)).slice(0, catLimit);
    const primaryCat = validCats[0] || req.business.category;
    const rf = computeRestrictedFields(validCats.length ? validCats : [primaryCat], req.business.restricted_review_status);
    // Adding a not-yet-approved restricted category takes a live listing back out of public view
    // until admin re-approves — editing your profile can't be used to bypass that review.
    const statusClause = (rf.has_restricted_categories && rf.restricted_review_status !== 'approved' && req.business.status === 'active')
        ? ", status='pending'" : '';
    // Only re-geocode if the postcode actually changed, to avoid a lookup on every unrelated save
    const postcodeChanged = (postcode || '') !== (req.business.postcode || '');
    const geo = postcodeChanged ? await geocodePostcode(postcode) : { lat: req.business.lat, lng: req.business.lng };
    db.prepare(`UPDATE businesses SET name=?,category=?,categories=?,area=?,town=?,county=?,postcode=?,description=?,short_desc=?,phone=?,email=?,website=?,lat=?,lng=?,
                has_restricted_categories=?,restricted_review_status=?,restricted_requirements=?${statusClause} WHERE id=?`)
        .run(name||req.business.name, primaryCat, JSON.stringify(validCats.length ? validCats : [primaryCat]),
             area||'', town||'', county||'', postcode||'', description||'', short_desc||'', phone||'', email||'', website||'',
             geo?.lat ?? null, geo?.lng ?? null, rf.has_restricted_categories, rf.restricted_review_status, rf.restricted_requirements, req.business.id);
    res.json({ ok: true, requires_review: rf.has_restricted_categories && rf.restricted_review_status !== 'approved' });
});

app.get('/api/owner/reviews', requireOwner, (req, res) => {
    res.json(db.prepare('SELECT * FROM reviews WHERE business_id=? ORDER BY created_at DESC').all(req.business.id));
});

app.post('/api/owner/reviews/:id/reply', requireOwner, (req, res) => {
    const { reply } = req.body;
    const review = db.prepare('SELECT * FROM reviews WHERE id=? AND business_id=?').get(req.params.id, req.business.id);
    if (!review) return res.status(404).json({ error: 'Not found' });
    db.prepare("UPDATE reviews SET reply=?, replied_at=datetime('now') WHERE id=?").run(reply||'', req.params.id);
    res.json({ ok: true });
});

app.get('/api/owner/analytics', requireOwner, (req, res) => {
    const biz = req.business;
    const byMonth = db.prepare(`
        SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count, ROUND(AVG(rating),1) AS avg
        FROM reviews WHERE business_id=? AND status='approved'
        GROUP BY month ORDER BY month DESC LIMIT 12
    `).all(biz.id);
    const breakdown = db.prepare(`
        SELECT rating, COUNT(*) AS count FROM reviews WHERE business_id=? AND status='approved' GROUP BY rating ORDER BY rating DESC
    `).all(biz.id);
    res.json({ business: biz, byMonth, breakdown });
});

app.get('/api/owner/widget-code', requireOwner, (req, res) => {
    const b = req.business;
    if (!['pro','featured'].includes(b.plan)) return res.status(403).json({ error: 'Widget requires Pro or Featured plan' });
    const widgetCode = `<!-- Monasite Review Widget -->
<div id="monasite-widget"></div>
<script src="${siteUrl()}/widget.js" data-key="${b.api_key}"></script>`;
    const badgeCode = `<!-- Monasite Trusted Badge -->
<a href="${siteUrl()}/business/${b.slug}" target="_blank" rel="noopener">
  <img src="${siteUrl()}/api/badge/${b.api_key}.svg" alt="Trusted on Monasite" width="200" height="80">
</a>`;
    res.json({ api_key: b.api_key, widget_code: widgetCode, badge_code: badgeCode, profile_url: `${siteUrl()}/business/${b.slug}` });
});

app.post('/api/owner/upload/logo',
    requireOwner,
    multer({ limits: { fileSize: 5*1024*1024 }, fileFilter: imgFilter,
             storage: makeStorage('images/logos', (req, file) => `logo-${req.owner.business_id}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
    }).single('image'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const p = `images/logos/${req.file.filename}`;
        db.prepare('UPDATE businesses SET logo_path=? WHERE id=?').run(p, req.owner.business_id);
        res.json({ ok: true, path: p });
    }
);

app.post('/api/owner/upload/cover',
    requireOwner,
    multer({ limits: { fileSize: 8*1024*1024 }, fileFilter: imgFilter,
             storage: makeStorage('images/covers', (req, file) => `cover-${req.owner.business_id}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
    }).single('image'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const p = `images/covers/${req.file.filename}`;
        db.prepare('UPDATE businesses SET cover_path=? WHERE id=?').run(p, req.owner.business_id);
        res.json({ ok: true, path: p });
    }
);

app.post('/api/owner/upload/gallery/:slot',
    requireOwner,
    (req, res, next) => {
        const slot = parseInt(req.params.slot);
        if (isNaN(slot) || slot < 0 || slot > 4) return res.status(400).json({ error: 'Invalid slot' });
        next();
    },
    multer({ limits: { fileSize: 8*1024*1024 }, fileFilter: imgFilter,
             storage: makeStorage('images/gallery', (req, file) => `gallery-${req.owner.business_id}-${req.params.slot}${path.extname(file.originalname).toLowerCase() || '.jpg'}`)
    }).single('image'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const slot = parseInt(req.params.slot);
        const p = `images/gallery/${req.file.filename}`;
        let gallery = [];
        try { gallery = JSON.parse(req.business.gallery || '[]'); } catch {}
        while (gallery.length <= slot) gallery.push('');
        gallery[slot] = p;
        db.prepare('UPDATE businesses SET gallery=? WHERE id=?').run(JSON.stringify(gallery), req.owner.business_id);
        res.json({ ok: true, path: p });
    }
);

// Compliance document upload — insurance certs, qualifications etc. for restricted categories.
// Randomised filename since these may contain sensitive info (not meant to be guessable).
app.post('/api/owner/upload/compliance-doc',
    requireOwner,
    multer({ limits: { fileSize: 10*1024*1024 }, fileFilter: docFilter,
             storage: makeStorage('documents/compliance', (req, file) => `${req.owner.business_id}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase() || '.pdf'}`)
    }).single('file'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const p = `documents/compliance/${req.file.filename}`;
        let docs = [];
        try { docs = JSON.parse(req.business.compliance_docs || '[]'); } catch {}
        docs.push({ path: p, original_name: req.file.originalname, uploaded_at: new Date().toISOString().slice(0,19).replace('T',' ') });
        db.prepare('UPDATE businesses SET compliance_docs=? WHERE id=?').run(JSON.stringify(docs), req.owner.business_id);
        res.json({ ok: true, docs });
    }
);

// Site logo upload (admin only)
app.post('/api/admin/upload/site-logo',
    requireAdmin,
    multer({ limits: { fileSize: 2*1024*1024 }, fileFilter: imgFilter,
             storage: makeStorage('images/site', (req, file) => `logo${path.extname(file.originalname).toLowerCase() || '.png'}`)
    }).single('image'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const p = `images/site/${req.file.filename}`;
        db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('site_logo', p);
        res.json({ ok: true, path: p });
    }
);

// Favicon upload (admin only) — no mimetype filter; .ico files report as application/octet-stream on many OS
app.post('/api/admin/upload/favicon',
    requireAdmin,
    multer({ limits: { fileSize: 2*1024*1024 },
             storage: makeStorage('images/site', (req, file) => `favicon${path.extname(file.originalname).toLowerCase() || '.ico'}`)
    }).single('image'),
    (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        const p = `images/site/${req.file.filename}`;
        db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('site_favicon', p);
        res.json({ ok: true, path: p });
    }
);

// Stripe billing portal
app.post('/api/owner/billing-portal', requireOwner, async (req, res) => {
    const b = req.business;
    if (!b.stripe_customer_id) return res.status(400).json({ error: 'No billing account found' });
    try {
        const session = await getStripe().billingPortal.sessions.create({
            customer: b.stripe_customer_id,
            return_url: `${siteUrl()}/dashboard`,
        });
        res.json({ url: session.url });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════════════════════════════

// Once a password is set via the admin panel (settings.admin_password_hash), it takes over
// from the .env ADMIN_PASSWORD entirely — the .env value remains as a recovery fallback only
// for as long as that setting is unset.
function checkAdminPassword(password) {
    const hash = settings().admin_password_hash;
    return hash ? verifyPass(password, hash) : password === process.env.ADMIN_PASSWORD;
}

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!checkAdminPassword(password)) return res.status(401).json({ error: 'Invalid password' });
    const token = genToken();
    db.prepare('INSERT INTO admin_tokens (token) VALUES (?)').run(token);
    res.json({ token });
});

app.put('/api/admin/password', requireAdmin, (req, res) => {
    const { current_password, new_password } = req.body;
    if (!checkAdminPassword(current_password)) return res.status(401).json({ error: 'Current password is incorrect' });
    if (!new_password || new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)').run('admin_password_hash', hashPass(new_password));
    res.json({ ok: true });
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
    expirePromos();
    res.json({
        total_businesses: db.prepare("SELECT COUNT(*) AS n FROM businesses").get().n,
        active:           db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status='active'").get().n,
        pending:          db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE status='pending'").get().n,
        pending_reviews:  db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status='pending'").get().n,
        total_reviews:    db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE status='approved'").get().n,
        starter_count:    db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE plan='starter' AND status='active'").get().n,
        pro_count:        db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE plan='pro' AND status='active'").get().n,
        featured_count:   db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE plan='featured' AND status='active'").get().n,
        open_reports:     db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='open'").get().n,
        new_enquiries:    db.prepare("SELECT COUNT(*) AS n FROM enquiries WHERE status='new'").get().n,
        open_tickets:     db.prepare("SELECT COUNT(*) AS n FROM support_tickets WHERE status='open'").get().n,
        stripe_connected: stripeConfigured(),
        email_configured: !!process.env.EMAIL_USER,
    });
});

// Daily snapshots for the Analytics chart — real history only, starts accumulating from
// whenever this shipped. No fabricated past data.
app.get('/api/admin/daily-stats', requireAdmin, (req, res) => {
    res.json(db.prepare('SELECT * FROM daily_stats ORDER BY date ASC LIMIT 90').all());
});

// Revenue comes straight from Stripe (the payment processor) — no separate bank API needed;
// the bank just passively receives Stripe's payouts.
app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
    if (!stripeConfigured()) return res.json({ configured: false });
    try {
        const stripe = getStripe();
        const now = new Date();
        const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

        const [balance, invoices] = await Promise.all([
            stripe.balance.retrieve(),
            stripe.invoices.list({ status: 'paid', created: { gte: monthStart }, limit: 100 }),
        ]);

        const revenueThisMonth = invoices.data.reduce((sum, inv) => sum + inv.amount_paid, 0) / 100;
        const currency = (invoices.data[0]?.currency || balance.available[0]?.currency || 'gbp').toUpperCase();
        const available = balance.available.reduce((sum, b) => sum + b.amount, 0) / 100;
        const pending = balance.pending.reduce((sum, b) => sum + b.amount, 0) / 100;

        res.json({
            configured: true,
            currency,
            revenue_this_month: revenueThisMonth,
            invoices_this_month: invoices.data.length,
            balance_available: available,
            balance_pending: pending,
            has_more_invoices: invoices.has_more,
        });
    } catch (e) {
        res.status(500).json({ configured: true, error: e.message });
    }
});

app.get('/api/admin/businesses', requireAdmin, (req, res) => {
    expirePromos();
    const { status, plan, q, featured, verification } = req.query;
    let where = ['1=1'], params = [];
    if (status) { where.push('status=?'); params.push(status); }
    if (plan)   { where.push('plan=?'); params.push(plan); }
    if (q)      { where.push('(name LIKE ? OR email LIKE ? OR area LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    if (featured) { where.push("(featured=1 OR plan='featured')"); }
    if (verification) { where.push("(has_restricted_categories=1 AND restricted_review_status='pending')"); }
    res.json(db.prepare(`SELECT * FROM businesses WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params));
});

// Admin-created listing — skips the public signup/vetting flow entirely (status defaults to active)
app.post('/api/admin/businesses', requireAdmin, async (req, res) => {
    const { name, area, town, county, postcode, description, short_desc, phone, email, website,
            plan = 'starter', status = 'active', owner_name, owner_email, owner_password } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!['starter','pro','featured'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const rawCats = Array.isArray(req.body.categories) ? req.body.categories : [req.body.category].filter(Boolean);
    const catLimit = getCatLimits()[plan] || 1;
    // Admins may assign hidden categories deliberately, not just public ones
    const validCats = rawCats.filter(c => getAssignableCategories().includes(c)).slice(0, catLimit);
    if (!validCats.length) return res.status(400).json({ error: 'Please select at least one category' });
    if (owner_email && db.prepare('SELECT id FROM business_owners WHERE email=?').get(owner_email)) {
        return res.status(409).json({ error: 'An account with that email already exists' });
    }
    const rf = computeRestrictedFields(validCats, null);
    const slug = makeSlug(name, area);
    const api_key = genApiKey();
    const geo = await geocodePostcode(postcode);
    const bizRes = db.prepare(`INSERT INTO businesses (name,slug,category,categories,area,town,county,postcode,description,short_desc,phone,email,website,plan,status,featured,api_key,lat,lng,verified_at,
                                has_restricted_categories,restricted_review_status,restricted_requirements)
                                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(name.trim(), slug, validCats[0], JSON.stringify(validCats), area||'', town||'', county||'', postcode||'',
             description||'', short_desc||'', phone||'', email||'', website||'', plan, status, plan==='featured'?1:0,
             api_key, geo?.lat ?? null, geo?.lng ?? null, status === 'active' ? db.prepare("SELECT datetime('now') AS n").get().n : '',
             rf.has_restricted_categories, rf.restricted_review_status, rf.restricted_requirements);
    const bizId = bizRes.lastInsertRowid;
    if (owner_email && owner_password) {
        db.prepare('INSERT INTO business_owners (business_id,name,email,password_hash) VALUES (?,?,?,?)')
            .run(bizId, owner_name||name, owner_email.toLowerCase().trim(), hashPass(owner_password));
    }
    res.json({ ok: true, id: bizId, slug });
});

app.put('/api/admin/businesses/:id', requireAdmin, async (req, res) => {
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const { name, area, town, county, postcode, description, short_desc, phone, email, website } = req.body;
    const rawCats = Array.isArray(req.body.categories) ? req.body.categories : [req.body.category].filter(Boolean);
    const catLimit = getCatLimits()[b.plan] || 1;
    const validCats = rawCats.filter(c => getAssignableCategories().includes(c)).slice(0, catLimit);
    const primaryCat = validCats[0] || b.category;
    const rf = computeRestrictedFields(validCats.length ? validCats : [primaryCat], b.restricted_review_status);
    const postcodeChanged = (postcode || '') !== (b.postcode || '');
    const geo = postcodeChanged ? await geocodePostcode(postcode) : { lat: b.lat, lng: b.lng };
    db.prepare(`UPDATE businesses SET name=?,category=?,categories=?,area=?,town=?,county=?,postcode=?,description=?,short_desc=?,phone=?,email=?,website=?,lat=?,lng=?,
                has_restricted_categories=?,restricted_review_status=?,restricted_requirements=? WHERE id=?`)
        .run(name||b.name, primaryCat, JSON.stringify(validCats.length ? validCats : [primaryCat]),
             area||'', town||'', county||'', postcode||'', description||'', short_desc||'', phone||'', email||'', website||'',
             geo?.lat ?? null, geo?.lng ?? null, rf.has_restricted_categories, rf.restricted_review_status, rf.restricted_requirements, b.id);
    res.json({ ok: true });
});

app.put('/api/admin/businesses/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['active','pending','suspended','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    const verified_at = status === 'active' && !b.verified_at ? "datetime('now')" : `'${b.verified_at}'`;
    // A manual admin action always wins: clear any auto-suspend-for-billing flag, and tag
    // a fresh manual suspension so a later successful payment doesn't silently reactivate it.
    const suspended_reason = status === 'suspended' ? 'admin' : null;
    // Approving (or rejecting) the listing doubles as the restricted-category review decision —
    // no separate approval flow needed.
    const restricted_review_status = !b.has_restricted_categories ? b.restricted_review_status
        : status === 'active' ? 'approved' : status === 'rejected' ? 'rejected' : b.restricted_review_status;
    db.prepare(`UPDATE businesses SET status=?, suspended_reason=?, restricted_review_status=?, verified_at=${verified_at} WHERE id=?`)
        .run(status, suspended_reason, restricted_review_status, b.id);
    // Email business owner when approved
    if (status === 'active') {
        const owner = db.prepare('SELECT * FROM business_owners WHERE business_id=?').get(b.id);
        if (owner) {
            sendMail(owner.email, `Your Monasite listing is live — ${b.name}`,
                `<p>Great news! Your listing for <strong>${b.name}</strong> has been verified and is now live on Monasite.</p>
                 <p><a href="${siteUrl()}/business/${b.slug}">View your profile</a> · <a href="${siteUrl()}/dashboard">Go to dashboard</a></p>
                 ${['pro','featured'].includes(b.plan) ? `<p>Don't forget to grab your <strong>Trusted Badge</strong> and <strong>review widget</strong> from your dashboard to display on your website!</p>` : ''}`
            ).catch(()=>{});
        }
    }
    logAudit('business.status_changed', 'business', b.id, `${b.name} → ${status}`);
    res.json({ ok: true });
});

// Focused compliance-document review, independent of the general active/pending/suspended
// status — lets admin approve/reject a restricted category's documents without also having
// to change (or accidentally leave alone) the listing's overall visibility.
app.put('/api/admin/businesses/:id/verification', requireAdmin, (req, res) => {
    const { decision } = req.body;
    if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Invalid decision' });
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (!b.has_restricted_categories) return res.status(400).json({ error: 'This business has no restricted categories to verify' });
    db.prepare('UPDATE businesses SET restricted_review_status=? WHERE id=?').run(decision, b.id);
    logAudit('business.verification_decided', 'business', b.id, `${b.name} → ${decision}`);
    res.json({ ok: true });
});

app.put('/api/admin/businesses/:id/plan', requireAdmin, (req, res) => {
    const { plan } = req.body;
    if (!['starter','pro','featured'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const b = db.prepare('SELECT name FROM businesses WHERE id=?').get(req.params.id);
    // A direct plan change is a deliberate override — clear any running promo so it can't later revert this.
    db.prepare('UPDATE businesses SET plan=?, featured=?, promo_expires_at=NULL, pre_promo_plan=NULL WHERE id=?')
        .run(plan, plan==='featured'?1:0, req.params.id);
    updateBusinessStats(req.params.id);
    logAudit('business.plan_changed', 'business', req.params.id, `${b?.name||''} → ${plan}`);
    res.json({ ok: true });
});

// Temporarily grant a plan for a promo, after which the business automatically reverts
// to whatever plan it was on before the promo started.
app.put('/api/admin/businesses/:id/promo', requireAdmin, (req, res) => {
    const { plan, days } = req.body;
    if (!['starter','pro','featured'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
    const d = parseFloat(days);
    if (!d || d <= 0) return res.status(400).json({ error: 'Days must be a positive number' });
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    // If a promo is already running, preserve the plan from before *that* one, not the current promo plan
    const basePlan = b.promo_expires_at ? (b.pre_promo_plan || 'starter') : b.plan;
    db.prepare(`UPDATE businesses SET plan=?, featured=?, pre_promo_plan=?, promo_expires_at=datetime('now', ?) WHERE id=?`)
        .run(plan, plan === 'featured' ? 1 : 0, basePlan, `+${d} days`, b.id);
    updateBusinessStats(b.id);
    logAudit('business.promo_applied', 'business', b.id, `${b.name} → ${plan} for ${d} day${d==1?'':'s'}`);
    res.json({ ok: true });
});

app.put('/api/admin/businesses/:id/promo/cancel', requireAdmin, (req, res) => {
    const b = db.prepare('SELECT * FROM businesses WHERE id=?').get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Not found' });
    if (!b.promo_expires_at) return res.json({ ok: true });
    const revertPlan = b.pre_promo_plan || 'starter';
    db.prepare('UPDATE businesses SET plan=?, featured=?, promo_expires_at=NULL, pre_promo_plan=NULL WHERE id=?')
        .run(revertPlan, revertPlan === 'featured' ? 1 : 0, b.id);
    updateBusinessStats(b.id);
    logAudit('business.promo_cancelled', 'business', b.id, `${b.name} reverted to ${revertPlan}`);
    res.json({ ok: true });
});

app.delete('/api/admin/businesses/:id', requireAdmin, (req, res) => {
    const b = db.prepare('SELECT name FROM businesses WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM reviews WHERE business_id=?').run(req.params.id);
    db.prepare('DELETE FROM business_owners WHERE business_id=?').run(req.params.id);
    db.prepare('DELETE FROM businesses WHERE id=?').run(req.params.id);
    logAudit('business.deleted', 'business', req.params.id, b?.name || '');
    res.json({ ok: true });
});

app.get('/api/admin/reviews', requireAdmin, (req, res) => {
    const { status } = req.query;
    const where = status ? 'WHERE r.status=?' : 'WHERE 1=1';
    const params = status ? [status] : [];
    res.json(db.prepare(`
        SELECT r.*, b.name AS business_name, b.slug AS business_slug
        FROM reviews r JOIN businesses b ON b.id=r.business_id
        ${where} ORDER BY r.created_at DESC LIMIT 200
    `).all(...params));
});

app.put('/api/admin/reviews/:id/status', requireAdmin, (req, res) => {
    const { status } = req.body;
    if (!['approved','rejected','pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = db.prepare('SELECT * FROM reviews WHERE id=?').get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    db.prepare('UPDATE reviews SET status=? WHERE id=?').run(status, r.id);
    updateBusinessStats(r.business_id);
    logAudit('review.status_changed', 'review', r.id, `By ${r.reviewer_name || 'anonymous'} → ${status}`);
    res.json({ ok: true });
});

function maskSecret(s) {
    if (!s) return '';
    return s.length <= 4 ? '••••' : '•'.repeat(Math.min(s.length - 4, 20)) + s.slice(-4);
}

app.get('/api/admin/settings', requireAdmin, (req, res) => {
    const s = settings();
    delete s.admin_password_hash; // never echo the hash back, even to a logged-in admin
    // Secrets are masked, not returned in full, even to a logged-in admin's browser
    s.stripe_secret_key_masked = maskSecret(s.stripe_secret_key);
    s.stripe_secret_key_set = !!s.stripe_secret_key || stripeConfigured();
    s.stripe_webhook_secret_masked = maskSecret(s.stripe_webhook_secret);
    s.stripe_webhook_secret_set = !!s.stripe_webhook_secret || !!process.env.STRIPE_WEBHOOK_SECRET;
    delete s.stripe_secret_key;
    delete s.stripe_webhook_secret;
    res.json(s);
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const allowed = [
        'site_name','site_tagline','starter_price','pro_price','featured_price','site_url',
        'cat_limit_starter','cat_limit_pro','cat_limit_featured',
        'search_radius_default_miles','featured_pin_radius_miles','featured_pin_max',
        'stripe_publishable_key','stripe_price_starter','stripe_price_pro','stripe_price_featured',
    ];
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
    for (const k of allowed) { if (k in req.body) stmt.run(k, req.body[k]); }
    // Secrets only overwrite when a real new value is sent — leaving the field blank keeps the existing one
    if (req.body.stripe_secret_key) stmt.run('stripe_secret_key', req.body.stripe_secret_key.trim());
    if (req.body.stripe_webhook_secret) stmt.run('stripe_webhook_secret', req.body.stripe_webhook_secret.trim());
    logAudit('settings.updated', 'settings', null, '');
    res.json({ ok: true });
});

// ── Categories (admin) ──────────────────────────────────────────────────────
function uniqueSlug(desired, excludeId) {
    let base = slugify(desired) || 'category', slug = base, n = 2;
    while (true) {
        const clash = excludeId
            ? db.prepare('SELECT 1 FROM categories WHERE slug=? AND id!=?').get(slug, excludeId)
            : db.prepare('SELECT 1 FROM categories WHERE slug=?').get(slug);
        if (!clash) return slug;
        slug = `${base}-${n++}`;
    }
}

app.get('/api/admin/categories', requireAdmin, (req, res) => {
    const { q, filter } = req.query;
    let where = ['1=1'], params = [];
    if (q) { where.push('name LIKE ?'); params.push(`%${q}%`); }
    const filterMap = {
        public:      "is_public=1 AND status='active'",
        hidden:      "is_public=0 AND status='active'",
        restricted:  'is_restricted=1',
        coming_soon: "status='coming_soon'",
        disabled:    "status='disabled'",
    };
    if (filter && filterMap[filter]) where.push(filterMap[filter]);
    res.json(db.prepare(`SELECT * FROM categories WHERE ${where.join(' AND ')} ORDER BY sort_order, id`).all(...params));
});

app.post('/api/admin/categories', requireAdmin, (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const slug = uniqueSlug(req.body.slug || name);
    const defaults = seoDefaults(name);
    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM categories').get().m;
    try {
        db.prepare(`INSERT INTO categories
            (name, slug, sort_order, is_public, status, is_restricted, requires_documents, requires_insurance,
             requires_qualifications, requires_manual_approval, seo_title, seo_description, description, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
            .run(name, slug, (maxOrder ?? -1) + 1,
                 req.body.is_public !== false ? 1 : 0,
                 req.body.status || 'active',
                 req.body.is_restricted ? 1 : 0,
                 req.body.requires_documents ? 1 : 0,
                 req.body.requires_insurance ? 1 : 0,
                 req.body.requires_qualifications ? 1 : 0,
                 req.body.requires_manual_approval ? 1 : 0,
                 req.body.seo_title || defaults.seo_title,
                 req.body.seo_description || defaults.seo_description,
                 req.body.description || '');
    } catch { return res.status(409).json({ error: 'That category already exists' }); }
    logAudit('category.created', 'category', null, name);
    res.json({ ok: true });
});

app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
    const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    const name = (req.body.name || cat.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    // Renaming keeps category<->business links (matched by name) in sync
    if (name !== cat.name) {
        db.prepare('UPDATE businesses SET category=? WHERE category=?').run(name, cat.name);
        db.prepare('UPDATE businesses SET categories=REPLACE(categories,?,?) WHERE categories LIKE ?')
            .run(`"${cat.name}"`, `"${name}"`, `%"${cat.name}"%`);
    }
    const slug = req.body.slug && req.body.slug.trim() ? uniqueSlug(req.body.slug, cat.id) : cat.slug;
    const sort_order = req.body.sort_order !== undefined && req.body.sort_order !== '' ? parseInt(req.body.sort_order) : cat.sort_order;
    try {
        db.prepare(`UPDATE categories SET name=?, slug=?, sort_order=?, is_public=?, status=?, is_restricted=?, requires_documents=?,
                    requires_insurance=?, requires_qualifications=?, requires_manual_approval=?, seo_title=?,
                    seo_description=?, description=?, updated_at=datetime('now') WHERE id=?`)
            .run(name, slug, sort_order,
                 'is_public' in req.body ? (req.body.is_public ? 1 : 0) : cat.is_public,
                 req.body.status || cat.status,
                 'is_restricted' in req.body ? (req.body.is_restricted ? 1 : 0) : cat.is_restricted,
                 'requires_documents' in req.body ? (req.body.requires_documents ? 1 : 0) : cat.requires_documents,
                 'requires_insurance' in req.body ? (req.body.requires_insurance ? 1 : 0) : cat.requires_insurance,
                 'requires_qualifications' in req.body ? (req.body.requires_qualifications ? 1 : 0) : cat.requires_qualifications,
                 'requires_manual_approval' in req.body ? (req.body.requires_manual_approval ? 1 : 0) : cat.requires_manual_approval,
                 req.body.seo_title ?? cat.seo_title,
                 req.body.seo_description ?? cat.seo_description,
                 req.body.description ?? cat.description,
                 cat.id);
    } catch { return res.status(409).json({ error: 'That category already exists' }); }
    logAudit('category.updated', 'category', cat.id, name);
    res.json({ ok: true });
});

app.put('/api/admin/categories/:id/move', requireAdmin, (req, res) => {
    const cats = db.prepare('SELECT * FROM categories ORDER BY sort_order, id').all();
    const idx = cats.findIndex(c => c.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const swapWith = req.body.direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= cats.length) return res.json({ ok: true });
    const a = cats[idx], b = cats[swapWith];
    db.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(b.sort_order, a.id);
    db.prepare('UPDATE categories SET sort_order=? WHERE id=?').run(a.sort_order, b.id);
    res.json({ ok: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
    const cat = db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    const inUse = db.prepare("SELECT COUNT(*) AS n FROM businesses WHERE category=? OR categories LIKE ?")
        .get(cat.name, `%"${cat.name}"%`).n;
    if (inUse) return res.status(409).json({ error: `${inUse} business(es) still use this category — recategorise them first` });
    db.prepare('DELETE FROM categories WHERE id=?').run(cat.id);
    logAudit('category.deleted', 'category', cat.id, cat.name);
    res.json({ ok: true });
});

// ── Locations (admin) ────────────────────────────────────────────────────────
// Admin-managed canonical list of areas. Not yet wired into the public signup form or
// directory filters (both free-text `area` today) — that's a deliberate follow-up once
// there's a URL/SEO strategy for location pages, not done as part of this build.
function uniqueLocationSlug(desired, excludeId) {
    let base = slugify(desired) || 'location', slug = base, n = 2;
    while (true) {
        const clash = excludeId
            ? db.prepare('SELECT 1 FROM locations WHERE slug=? AND id!=?').get(slug, excludeId)
            : db.prepare('SELECT 1 FROM locations WHERE slug=?').get(slug);
        if (!clash) return slug;
        slug = `${base}-${n++}`;
    }
}

app.get('/api/admin/locations', requireAdmin, (req, res) => {
    const { q } = req.query;
    const where = q ? 'WHERE name LIKE ?' : '';
    const params = q ? [`%${q}%`] : [];
    res.json(db.prepare(`SELECT * FROM locations ${where} ORDER BY sort_order, id`).all(...params));
});

app.post('/api/admin/locations', requireAdmin, (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const slug = uniqueLocationSlug(req.body.slug || name);
    const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM locations').get().m;
    try {
        db.prepare(`INSERT INTO locations (name, slug, sort_order, status, description, seo_title, seo_description)
            VALUES (?,?,?,?,?,?,?)`)
            .run(name, slug, (maxOrder ?? -1) + 1, req.body.status || 'active',
                 req.body.description || '', req.body.seo_title || '', req.body.seo_description || '');
    } catch { return res.status(409).json({ error: 'That location already exists' }); }
    logAudit('location.created', 'location', null, name);
    res.json({ ok: true });
});

app.put('/api/admin/locations/:id', requireAdmin, (req, res) => {
    const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Not found' });
    const name = (req.body.name || loc.name).trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const slug = req.body.slug && req.body.slug.trim() ? uniqueLocationSlug(req.body.slug, loc.id) : loc.slug;
    const sort_order = req.body.sort_order !== undefined && req.body.sort_order !== '' ? parseInt(req.body.sort_order) : loc.sort_order;
    try {
        db.prepare(`UPDATE locations SET name=?, slug=?, sort_order=?, status=?, description=?, seo_title=?, seo_description=? WHERE id=?`)
            .run(name, slug, sort_order, req.body.status || loc.status,
                 req.body.description ?? loc.description, req.body.seo_title ?? loc.seo_title,
                 req.body.seo_description ?? loc.seo_description, loc.id);
    } catch { return res.status(409).json({ error: 'That location already exists' }); }
    logAudit('location.updated', 'location', loc.id, name);
    res.json({ ok: true });
});

app.put('/api/admin/locations/:id/move', requireAdmin, (req, res) => {
    const locs = db.prepare('SELECT * FROM locations ORDER BY sort_order, id').all();
    const idx = locs.findIndex(l => l.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    const swapWith = req.body.direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= locs.length) return res.json({ ok: true });
    const a = locs[idx], b = locs[swapWith];
    db.prepare('UPDATE locations SET sort_order=? WHERE id=?').run(b.sort_order, a.id);
    db.prepare('UPDATE locations SET sort_order=? WHERE id=?').run(a.sort_order, b.id);
    res.json({ ok: true });
});

app.delete('/api/admin/locations/:id', requireAdmin, (req, res) => {
    const loc = db.prepare('SELECT * FROM locations WHERE id=?').get(req.params.id);
    if (!loc) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM locations WHERE id=?').run(loc.id);
    logAudit('location.deleted', 'location', loc.id, loc.name);
    res.json({ ok: true });
});

// ── Audit Logs (admin) ───────────────────────────────────────────────────────
// Actor is always "Admin" — single shared login, no named staff accounts yet.
app.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const perPage = 50;
    const total = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n;
    const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
        .all(perPage, (page - 1) * perPage);
    res.json({ rows, total, page, pages: Math.max(1, Math.ceil(total / perPage)) });
});

// ── Stripe webhook ───────────────────────────────────────────────────────────
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    let event;
    try {
        event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeSetting('stripe_webhook_secret','STRIPE_WEBHOOK_SECRET'));
    } catch(e) { return res.status(400).send(`Webhook error: ${e.message}`); }

    // First payment completes — link the subscription, mark billing active, and only now
    // send the "awaiting vetting" notifications (no point alerting admin to abandoned checkouts).
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const bizId = session.metadata?.business_id;
        const b = bizId && db.prepare('SELECT * FROM businesses WHERE id=?').get(bizId);
        if (b) {
            db.prepare("UPDATE businesses SET stripe_customer_id=?, stripe_subscription_id=?, billing_status='active', last_payment_at=datetime('now') WHERE id=?")
                .run(session.customer, session.subscription, b.id);
            const owner = db.prepare('SELECT * FROM business_owners WHERE business_id=?').get(b.id);
            sendMail(process.env.EMAIL_USER, `New business signup — ${b.name}`,
                `<p><strong>${b.name}</strong> has paid and signed up on the <strong>${b.plan}</strong> plan and is awaiting vetting.</p>
                 <p>Owner: ${owner?.name||''} (${owner?.email||''})</p><p>Area: ${b.area}, ${b.county}</p><a href="${siteUrl()}/admin">Review in admin panel</a>`
            ).catch(()=>{});
            if (owner) {
                sendMail(owner.email, `Payment received — welcome to Monasite, ${owner.name||b.name}!`,
                    `<p>Thanks for signing up to Monasite! Your payment was successful and your listing for <strong>${b.name}</strong> is now pending vetting.</p>
                     <p>We'll review your details and activate your listing within 1–2 business days.</p>
                     <p>You can log in to your dashboard at <a href="${siteUrl()}/dashboard">${siteUrl()}/dashboard</a>.</p>`
                ).catch(()=>{});
            }
        }
    }

    // A renewal payment succeeded — clear any past-due flag and, if we'd auto-suspended for
    // non-payment, bring the listing back now that they're square again.
    if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        const b = findBusinessByCustomer(invoice.customer);
        if (b) {
            const reactivate = b.status === 'suspended' && b.suspended_reason === 'billing';
            db.prepare(`UPDATE businesses SET billing_status='active', last_payment_at=datetime('now')
                        ${reactivate ? ", status='active', suspended_reason=NULL" : ''} WHERE id=?`).run(b.id);
        }
    }

    // A renewal payment failed — flag it, but don't suspend yet; Stripe will retry per its
    // dunning schedule before the subscription itself transitions to unpaid/canceled.
    if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object;
        const b = findBusinessByCustomer(invoice.customer);
        if (b) {
            db.prepare("UPDATE businesses SET billing_status='past_due' WHERE id=?").run(b.id);
            const owner = db.prepare('SELECT * FROM business_owners WHERE business_id=?').get(b.id);
            if (owner) {
                sendMail(owner.email, `Payment failed for your Monasite subscription`,
                    `<p>We couldn't take payment for <strong>${b.name}</strong>'s Monasite subscription.</p>
                     <p>Please update your payment method to keep your listing live: <a href="${siteUrl()}/dashboard">${siteUrl()}/dashboard</a> → Billing.</p>`
                ).catch(()=>{});
            }
        }
    }

    // Plan changes (incl. via the billing portal) and status transitions (active/past_due/unpaid/canceled)
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
        const sub = event.data.object;
        const b = findBusinessByCustomer(sub.customer);
        if (b) {
            const priceId = sub.items?.data[0]?.price?.id;
            const plan = planForPriceId(priceId) || b.plan;
            const billing_status = sub.status; // active | past_due | unpaid | canceled | trialing | incomplete...
            const exhausted = ['unpaid', 'canceled'].includes(sub.status);
            const reactivate = sub.status === 'active' && b.status === 'suspended' && b.suspended_reason === 'billing';
            const suspend = exhausted && b.status === 'active';
            db.prepare(`UPDATE businesses SET stripe_subscription_id=?, plan=?, featured=?, billing_status=?
                        ${suspend ? ", status='suspended', suspended_reason='billing'" : ''}
                        ${reactivate ? ", status='active', suspended_reason=NULL" : ''} WHERE id=?`)
                .run(sub.id, plan, plan === 'featured' ? 1 : 0, billing_status, b.id);
            updateBusinessStats(b.id);
        }
    }

    // Subscription fully cancelled (e.g. final dunning step, or cancelled via billing portal)
    if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const b = findBusinessByCustomer(sub.customer);
        if (b) {
            const suspend = b.status === 'active';
            db.prepare(`UPDATE businesses SET billing_status='canceled' ${suspend ? ", status='suspended', suspended_reason='billing'" : ''} WHERE id=?`).run(b.id);
        }
    }

    res.json({ received: true });
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/directory', (req, res) => res.sendFile(path.join(__dirname, 'directory.html')));
app.get('/categories', (req, res) => res.sendFile(path.join(__dirname, 'categories.html')));
app.get('/report', (req, res) => res.sendFile(path.join(__dirname, 'report.html')));
app.get('/business/:slug', (req, res) => res.sendFile(path.join(__dirname, 'business.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'signup.html')));
app.get('/how-it-works', (req, res) => res.sendFile(path.join(__dirname, 'how-it-works.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Return JSON for upload errors (multer size limits etc.) instead of HTML
app.use((err, req, res, next) => {
    const msg = err && (err.message || 'Upload error');
    res.status(400).json({ error: msg });
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'index.html')));

expirePromos();
setInterval(expirePromos, 15 * 60 * 1000);

snapshotDailyStats();
setInterval(snapshotDailyStats, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`\n  Monasite → http://localhost:${PORT}`);
    console.log(`  Admin    → http://localhost:${PORT}/admin\n`);
});
