'use strict';
// Integration tests for the category taxonomy feature.
// Spins up the real server against a throwaway SQLite file, runs the seeder against it,
// then exercises the public/admin HTTP API exactly as a browser would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, `test-${Date.now()}.db`);
const PORT = 5099;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'test-admin-password-123';

let serverProc;

function runSeeder() {
    return new Promise((resolve, reject) => {
        const p = spawn('node', [path.join(ROOT, 'scripts', 'seed-categories.js')], {
            cwd: ROOT, env: { ...process.env, DB_PATH }, stdio: 'pipe',
        });
        let out = '';
        p.stdout.on('data', d => out += d);
        p.on('exit', code => code === 0 ? resolve(out) : reject(new Error('Seeder failed: ' + out)));
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        serverProc = spawn('node', [path.join(ROOT, 'server.js')], {
            cwd: ROOT,
            env: { ...process.env, DB_PATH, PORT: String(PORT), ADMIN_PASSWORD, EMAIL_USER: '', STRIPE_SECRET_KEY: '' },
            stdio: 'pipe',
        });
        serverProc.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
        const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 15000);
        const tryConnect = async () => {
            try {
                const r = await fetch(BASE + '/api/categories');
                if (r.ok) { clearTimeout(timeout); resolve(); return; }
            } catch {}
            setTimeout(tryConnect, 200);
        };
        tryConnect();
    });
}

async function adminToken() {
    const r = await fetch(BASE + '/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ADMIN_PASSWORD }),
    });
    const d = await r.json();
    return d.token;
}

test.before(async () => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    await runSeeder();
    await startServer();
});

test.after(() => {
    if (serverProc) serverProc.kill();
    for (const f of [DB_PATH, DB_PATH + '-journal', DB_PATH + '-wal', DB_PATH + '-shm']) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }
});

test('public categories page only shows public+active categories', async () => {
    const cats = await fetch(BASE + '/api/categories').then(r => r.json());
    assert.ok(cats.includes('Builders'), 'public category "Builders" should appear');
    assert.ok(cats.includes('Roofers'), 'public category "Roofers" should appear');
    assert.ok(!cats.includes('Quantity Surveyors'), 'hidden category should NOT appear in public list');
    assert.ok(!cats.includes('Resin Flooring Specialists'), 'hidden category should NOT appear in public list');
});

test('hidden categories exist in admin list but not public list', async () => {
    const token = await adminToken();
    const all = await fetch(BASE + '/api/admin/categories', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    const qs = all.find(c => c.name === 'Quantity Surveyors');
    assert.ok(qs, 'Quantity Surveyors should exist in admin category list');
    assert.equal(qs.is_public, 0, 'Quantity Surveyors should be marked hidden');
});

test('restricted categories are flagged correctly', async () => {
    const meta = await fetch(BASE + '/api/categories/meta').then(r => r.json());
    const gas = meta.find(c => c.name === 'Gas Engineers');
    const builders = meta.find(c => c.name === 'Builders');
    assert.ok(gas?.is_restricted, 'Gas Engineers should be restricted');
    assert.ok(!builders?.is_restricted, 'Builders should not be restricted');
});

test('category slugs are generated correctly', async () => {
    const token = await adminToken();
    const all = await fetch(BASE + '/api/admin/categories', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    const byName = n => all.find(c => c.name === n);
    assert.equal(byName('Builders').slug, 'builders');
    assert.equal(byName('Fire & Security Companies').slug, 'fire-security-companies');
    assert.equal(byName('CCTV Installers').slug, 'cctv-installers');
    assert.equal(byName('Fire Extinguisher Servicing Companies').slug, 'fire-extinguisher-servicing-companies');
});

test('admin can toggle category visibility', async () => {
    const token = await adminToken();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const all = await fetch(BASE + '/api/admin/categories', { headers }).then(r => r.json());
    const builders = all.find(c => c.name === 'Builders');

    await fetch(`${BASE}/api/admin/categories/${builders.id}`, { method: 'PUT', headers, body: JSON.stringify({ is_public: false }) });
    let pub = await fetch(BASE + '/api/categories').then(r => r.json());
    assert.ok(!pub.includes('Builders'), 'Builders should be hidden from public list after toggle');

    await fetch(`${BASE}/api/admin/categories/${builders.id}`, { method: 'PUT', headers, body: JSON.stringify({ is_public: true }) });
    pub = await fetch(BASE + '/api/categories').then(r => r.json());
    assert.ok(pub.includes('Builders'), 'Builders should be public again after toggling back');
});

test('trader onboarding detects restricted categories and flags business for review', async () => {
    const r = await fetch(BASE + '/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Test Gas Co', categories: ['Gas Engineers'], plan: 'starter',
            owner_name: 'Test Owner', owner_email: `gastest-${Date.now()}@example.com`, owner_password: 'password1234',
            area: 'Test Area', town: 'Test Town',
        }),
    });
    const body = await r.json();
    assert.ok(r.ok, 'signup with a restricted category should still succeed: ' + JSON.stringify(body));

    const token = await adminToken();
    const all = await fetch(BASE + '/api/admin/businesses', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    const biz = all.find(b => b.slug === body.slug);
    assert.ok(biz, 'created business should be findable by admin');
    assert.equal(biz.has_restricted_categories, 1, 'business should be flagged as having restricted categories');
    assert.equal(biz.restricted_review_status, 'pending', 'restricted review should start pending');
    assert.equal(biz.status, 'pending', 'listing should not be live until vetted');
});

test('approving a restricted business marks the review approved', async () => {
    const r = await fetch(BASE + '/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: 'Test Electric Co', categories: ['Electricians'], plan: 'starter',
            owner_name: 'Test Owner', owner_email: `electest-${Date.now()}@example.com`, owner_password: 'password1234',
            area: 'Test Area', town: 'Test Town',
        }),
    });
    const { slug } = await r.json();
    const token = await adminToken();
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const all = await fetch(BASE + '/api/admin/businesses', { headers }).then(r => r.json());
    const biz = all.find(b => b.slug === slug);

    await fetch(`${BASE}/api/admin/businesses/${biz.id}/status`, { method: 'PUT', headers, body: JSON.stringify({ status: 'active' }) });

    const after = await fetch(BASE + '/api/admin/businesses', { headers }).then(r => r.json());
    const updated = after.find(b => b.id === biz.id);
    assert.equal(updated.status, 'active');
    assert.equal(updated.restricted_review_status, 'approved', 'approving the listing should also approve the restricted review');
});

test('seeder is idempotent — re-running does not create duplicates', async () => {
    const token = await adminToken();
    const before = await fetch(BASE + '/api/admin/categories', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    await runSeeder();
    // Re-fetch via a fresh request against the same running server/db
    const after = await fetch(BASE + '/api/admin/categories', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.equal(after.length, before.length, 'category count should be unchanged after re-running the seeder');
    const slugs = after.map(c => c.slug);
    assert.equal(new Set(slugs).size, slugs.length, 'no duplicate slugs should exist');
});
