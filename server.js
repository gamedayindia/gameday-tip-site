/**
 * Tip Site — Express server
 *
 * Payment flow:
 *   1. Viewer scans UPI QR → pays on Google Pay / PhonePe / etc.
 *   2. Viewer fills name + message → clicks "Send Alert"
 *   3. Server creates a PENDING tip and returns tipId
 *   4. Viewer's page shows "Waiting for confirmation…" and polls /api/tip-status/:id
 *   5. Streamer sees Google Pay notification on iPhone → opens /admin
 *   6. Streamer taps ✅ Approve → alerts fire instantly, viewer sees success
 *      OR taps ❌ Reject → viewer sees payment-failed message
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app = express();

// ─── Env vars ──────────────────────────────────────────────────────────────
const {
  SE_CHANNEL_ID,
  SE_JWT_TOKEN,
  STREAMLABS_ACCESS_TOKEN,
  ADMIN_PASSWORD = 'gameday2024',   // ← change this in Render env vars!
  PORT = 3000,
} = process.env;

// ─── Startup check ─────────────────────────────────────────────────────────
console.log('\n── Tip Site starting up ──────────────────────────────');
console.log(`   StreamElements : ${SE_JWT_TOKEN            ? '✅ configured' : '⬜ not set'}`);
console.log(`   Streamlabs     : ${STREAMLABS_ACCESS_TOKEN ? '✅ configured' : '⬜ not set'}`);
console.log(`   Admin password : ${ADMIN_PASSWORD === 'gameday2024' ? '⚠️  using default — set ADMIN_PASSWORD in env!' : '✅ custom'}`);
console.log('──────────────────────────────────────────────────────\n');

// ─── Tip queue (in-memory) ─────────────────────────────────────────────────
// tipId → { id, name, message, amount, status, timestamp, alertsFired }
// status: 'pending' | 'approved' | 'rejected'
const tipQueue = new Map();

function newTipId() {
  return crypto.randomBytes(8).toString('hex');
}

// Auto-clean tips older than 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, tip] of tipQueue) {
    if (tip.timestamp < cutoff) tipQueue.delete(id);
  }
}, 5 * 60 * 1000);

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Admin auth helper ─────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  next();
}

// ─── Serve HTML ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// helpers used by both GET /admin and the action routes
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtINR(n) { return '₹' + Number(n).toLocaleString('en-IN'); }
function agoStr(ts) {
  const s = Math.floor((Date.now()-ts)/1000);
  return s<60 ? s+'s ago' : s<3600 ? Math.floor(s/60)+'m ago' : Math.floor(s/3600)+'h ago';
}

function renderAdmin(res, { isAuth, wrongPw = false, msg = '' }) {
  const loginDisplay = isAuth ? 'none'  : 'flex';
  const panelDisplay = isAuth ? 'block' : 'none';
  const pw           = isAuth ? escHtml(ADMIN_PASSWORD) : '';

  let tipsHtml = '';
  let count    = 0;
  if (isAuth) {
    const pending = [...tipQueue.values()]
      .filter(t => t.status === 'pending')
      .sort((a,b) => a.timestamp - b.timestamp);
    count = pending.length;
    if (pending.length === 0) {
      tipsHtml = '<div class="empty"><div class="empty-ico">&#9989;</div><div class="empty-ttl">All clear!</div><p>No pending tips right now.</p></div>';
    } else {
      tipsHtml = pending.map(t =>
        `<div class="tip-card">` +
        `<div class="tip-top"><div><div class="tip-name">${escHtml(t.name)}</div><div class="tip-time">${agoStr(t.timestamp)}</div></div>` +
        `<div class="tip-amt">${fmtINR(t.amount)}</div></div>` +
        (t.message ? `<div class="tip-msg">&ldquo;${escHtml(t.message)}&rdquo;</div>` : '') +
        `<div class="tip-actions">` +
        `<form method="POST" action="/admin/approve/${escHtml(t.id)}?pw=${pw}" style="display:contents">` +
        `<button type="submit" class="tip-btn ok">&#9989; Approve</button></form>` +
        `<form method="POST" action="/admin/reject/${escHtml(t.id)}?pw=${pw}" style="display:contents">` +
        `<button type="submit" class="tip-btn no">&#10060; Reject</button></form>` +
        `</div></div>`
      ).join('');
    }
  }

  let msgBar = '';
  if (msg === 'approved') msgBar = '<div class="msg-bar ok">&#9989; Tip approved — alert fired!</div>';
  if (msg === 'approved0') msgBar = '<div class="msg-bar ok">&#9989; Tip approved (no alert platform configured)</div>';
  if (msg === 'rejected')  msgBar = '<div class="msg-bar no">&#10060; Tip rejected</div>';
  if (msg === 'notfound')  msgBar = '<div class="msg-bar no">&#9888;&#65039; Tip not found (may have expired)</div>';

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>GameDay Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#05070E;--surface:#0D1117;--card:#121820;--border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.12);--red:#FF1A2E;--cyan:#00C8FF;--green:#00E676;--text:#F0F4FF;--text2:#8899BB;--muted:#445566}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{font-family:'Space Grotesk',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;overflow-x:hidden}
.topbar{position:sticky;top:0;z-index:100;background:rgba(5,7,14,.95);border-bottom:1px solid var(--border);padding:14px 20px;display:flex;align-items:center;justify-content:space-between}
.logo{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:800}
.dot{width:10px;height:10px;border-radius:50%;background:var(--red);box-shadow:0 0 8px var(--red);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.badge{font-size:12px;font-weight:700;background:var(--red);color:#fff;padding:3px 10px;border-radius:20px}
.badge.zero{background:var(--surface);color:var(--muted)}
.msg-bar{padding:12px 20px;font-size:14px;font-weight:700;text-align:center}
.msg-bar.ok{background:rgba(0,230,118,.12);color:var(--green);border-bottom:1px solid rgba(0,230,118,.2)}
.msg-bar.no{background:rgba(255,26,46,.10);color:var(--red);border-bottom:1px solid rgba(255,26,46,.2)}
.login-wrap{display:${loginDisplay};flex-direction:column;align-items:center;justify-content:center;min-height:calc(100dvh - 56px);padding:32px 24px;text-align:center}
.login-icon{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,var(--red),#c0001a);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px;box-shadow:0 8px 32px rgba(255,26,46,.35)}
.login-title{font-size:26px;font-weight:800;margin-bottom:8px;background:linear-gradient(90deg,#fff 60%,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.login-sub{font-size:14px;color:var(--text2);margin-bottom:28px;line-height:1.6}
.login-form{width:100%;max-width:320px;display:flex;flex-direction:column;gap:12px}
.pw-input{background:var(--surface);border:1.5px solid var(--border2);border-radius:14px;padding:15px 18px;font-size:17px;font-family:inherit;color:var(--text);text-align:center;outline:none;width:100%}
.pw-input:focus{border-color:var(--cyan)}
.unlock-btn{background:var(--red);color:#fff;border:none;border-radius:14px;padding:16px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;width:100%}
.unlock-btn:active{opacity:.8}
.login-err{font-size:13px;color:var(--red);min-height:18px;text-align:center}
.panel-wrap{display:${panelDisplay};flex-direction:column}
.sec-header{padding:20px 20px 10px;display:flex;align-items:center;justify-content:space-between}
.sec-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text2)}
.refresh-link{background:none;border:1.5px solid var(--border2);border-radius:8px;padding:5px 12px;color:var(--text2);font-size:12px;font-family:inherit;text-decoration:none;display:inline-block}
.tips-list{padding:0 16px;display:flex;flex-direction:column;gap:12px}
.tip-card{background:var(--card);border:1.5px solid var(--border2);border-radius:18px;overflow:hidden}
.tip-top{padding:16px 18px 12px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.tip-name{font-size:17px;font-weight:800;margin-bottom:3px}
.tip-time{font-size:12px;color:var(--muted)}
.tip-amt{background:rgba(0,200,255,.12);border:1.5px solid rgba(0,200,255,.25);border-radius:10px;padding:6px 14px;font-size:20px;font-weight:800;color:var(--cyan);white-space:nowrap;flex-shrink:0}
.tip-msg{padding:0 18px 12px;font-size:14px;color:var(--text2);font-style:italic}
.tip-actions{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border)}
.tip-btn{border:none;background:none;padding:16px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;width:100%;display:block}
.tip-btn.ok{color:var(--green);border-right:1px solid var(--border)}
.tip-btn.no{color:var(--red)}
.tip-btn:active{opacity:.7}
.empty{text-align:center;padding:60px 24px;color:var(--text2)}
.empty-ico{font-size:48px;margin-bottom:14px}
.empty-ttl{font-size:18px;font-weight:700;color:var(--text);margin-bottom:8px}
.signout{text-align:center;padding:28px 20px 8px}
.signout a{color:var(--muted);font-size:13px;text-decoration:underline}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo"><div class="dot"></div>GameDay Admin</div>
  <div class="badge${count === 0 ? ' zero' : ''}">${count}</div>
</div>

${msgBar}

<div class="login-wrap">
  <div class="login-icon">&#128272;</div>
  <div class="login-title">Admin Access</div>
  <p class="login-sub">Enter your GameDay admin password<br>to manage tip confirmations.</p>
  <form class="login-form" action="/admin" method="GET">
    <input class="pw-input" type="password" name="pw" placeholder="Enter admin password" autocomplete="current-password" autocorrect="off" autocapitalize="none" autofocus>
    <button class="unlock-btn" type="submit">Unlock &#8594;</button>
  </form>
  <div class="login-err">${wrongPw ? '&#10060; Wrong password. Try again.' : ''}</div>
</div>

<div class="panel-wrap">
  <div class="sec-header">
    <span class="sec-title">Pending Tips</span>
    <a class="refresh-link" href="/admin?pw=${pw}">&#8635; Refresh</a>
  </div>
  <div class="tips-list">${tipsHtml}</div>
  <div class="signout"><a href="/admin">Sign out</a></div>
</div>
</body>
</html>`);
}

app.get('/admin', (req, res) => {
  const isAuth  = !!(req.query.pw && req.query.pw === ADMIN_PASSWORD);
  const wrongPw = !!(req.query.pw && !isAuth);
  const msg     = req.query.msg || '';
  renderAdmin(res, { isAuth, wrongPw, msg });
});
});

// ─── Alert helpers ─────────────────────────────────────────────────────────
async function alertStreamElements({ donorName, amountINR, message }) {
  if (!SE_JWT_TOKEN || !SE_CHANNEL_ID) return false;
  try {
    await axios.post(
      `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`,
      {
        user:     { username: donorName, email: 'tip@gameday.live' },
        amount:   amountINR,
        currency: 'INR',
        message,
        imported: true,
      },
      { headers: { 'Authorization': `Bearer ${SE_JWT_TOKEN}` } }
    );
    console.log(`🔔 StreamElements alert fired — ₹${amountINR} from ${donorName}`);
    return true;
  } catch (err) {
    console.error('❌ StreamElements error:', err?.response?.data || err.message);
    return false;
  }
}

async function alertStreamlabs({ donorName, amountINR, message }) {
  if (!STREAMLABS_ACCESS_TOKEN) return false;
  try {
    const params = new URLSearchParams({
      name:         donorName,
      message:      message || ' ',
      identifier:   'tip@gameday.live',
      amount:       amountINR.toString(),
      currency:     'INR',
      skip_alert:   'false',
      access_token: STREAMLABS_ACCESS_TOKEN,
    });
    await axios.post(
      'https://streamlabs.com/api/v1.0/donations',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log(`🔔 Streamlabs alert fired — ₹${amountINR} from ${donorName}`);
    return true;
  } catch (err) {
    console.error('❌ Streamlabs error:', err?.response?.data || err.message);
    return false;
  }
}

// ─── POST /admin/approve/:id  &  POST /admin/reject/:id ───────────────────
// Plain HTML form submissions from the admin panel — no JS needed.
app.post('/admin/approve/:id', async (req, res) => {
  const pw = req.query.pw || req.body?.pw || '';
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  const tip = tipQueue.get(req.params.id);
  const redirect = `/admin?pw=${encodeURIComponent(ADMIN_PASSWORD)}`;
  if (!tip || tip.status !== 'pending') {
    return res.redirect(redirect + '&msg=notfound');
  }
  tip.status = 'processing';
  const [seFired, slFired] = await Promise.all([
    alertStreamElements({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
    alertStreamlabs({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
  ]);
  tip.alertsFired = (seFired ? 1 : 0) + (slFired ? 1 : 0);
  tip.status = 'approved';
  console.log(`\n✅ Tip approved: ₹${tip.amount} from ${tip.name} — alerts fired: ${tip.alertsFired}`);
  return res.redirect(redirect + (tip.alertsFired > 0 ? '&msg=approved' : '&msg=approved0'));
});

app.post('/admin/reject/:id', (req, res) => {
  const pw = req.query.pw || req.body?.pw || '';
  if (!pw || pw !== ADMIN_PASSWORD) return res.status(401).send('Unauthorized');
  const tip = tipQueue.get(req.params.id);
  const redirect = `/admin?pw=${encodeURIComponent(ADMIN_PASSWORD)}`;
  if (!tip || tip.status !== 'pending') {
    return res.redirect(redirect + '&msg=notfound');
  }
  tip.status = 'rejected';
  console.log(`\n❌ Tip rejected: ₹${tip.amount} from ${tip.name}`);
  return res.redirect(redirect + '&msg=rejected');
});

// ─── POST /confirm-tip ─────────────────────────────────────────────────────
// Viewer submits → creates a PENDING tip, returns tipId for polling.
// Alert does NOT fire here — it fires only when the streamer approves.
app.post('/confirm-tip', (req, res) => {
  const { name, message, amount } = req.body;

  const donorName = (name || 'Anonymous').substring(0, 50).trim();
  const tipMsg    = (message || '').substring(0, 200).trim();
  const amountINR = Number(amount) || 0;

  if (amountINR < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const tipId = newTipId();
  tipQueue.set(tipId, {
    id:          tipId,
    name:        donorName,
    message:     tipMsg,
    amount:      amountINR,
    status:      'pending',
    timestamp:   Date.now(),
    alertsFired: 0,
  });

  console.log(`\n⏳ Tip pending: ₹${amountINR} from ${donorName} [${tipId}]`);

  res.json({ ok: true, tipId, status: 'pending' });
});

// ─── GET /api/tip-status/:id ───────────────────────────────────────────────
// Viewer's page polls this every 3 seconds waiting for approval.
app.get('/api/tip-status/:id', (req, res) => {
  const tip = tipQueue.get(req.params.id);
  if (!tip) return res.status(404).json({ error: 'Tip not found or expired' });
  res.json({
    status:      tip.status,       // 'pending' | 'approved' | 'rejected'
    alertsFired: tip.alertsFired,
  });
});

// ─── GET /api/admin/tips ───────────────────────────────────────────────────
// Admin panel fetches all pending tips.
app.get('/api/admin/tips', requireAdmin, (_req, res) => {
  const pending = [...tipQueue.values()]
    .filter(t => t.status === 'pending')
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(t => ({
      id:        t.id,
      name:      t.name,
      message:   t.message,
      amount:    t.amount,
      timestamp: t.timestamp,
    }));
  res.json({ tips: pending, total: tipQueue.size });
});

// ─── POST /api/admin/approve/:id  (kept for backwards compat / future use) ──
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  const tip = tipQueue.get(req.params.id);
  if (!tip || tip.status !== 'pending') return res.status(404).json({ error: 'Not found or already processed' });
  tip.status = 'processing';
  const [seFired, slFired] = await Promise.all([
    alertStreamElements({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
    alertStreamlabs    ({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
  ]);
  tip.alertsFired = (seFired ? 1 : 0) + (slFired ? 1 : 0);
  tip.status = 'approved';
  setTimeout(() => tipQueue.delete(tip.id), 5 * 60 * 1000);
  res.json({ ok: true, alertsFired: tip.alertsFired });
});

app.post('/api/admin/reject/:id', requireAdmin, (req, res) => {
  const tip = tipQueue.get(req.params.id);
  if (!tip) return res.status(404).json({ error: 'Tip not found' });
  tip.status = 'rejected';
  setTimeout(() => tipQueue.delete(tip.id), 2 * 60 * 1000);
  res.json({ ok: true });
});

// ─── GET /api/health ──────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    seConfigured: !!(SE_JWT_TOKEN && SE_CHANNEL_ID),
    slConfigured: !!STREAMLABS_ACCESS_TOKEN,
    configured:   !!(( SE_JWT_TOKEN && SE_CHANNEL_ID) || STREAMLABS_ACCESS_TOKEN),
  });
});

// ─── GET /api/banners ──────────────────────────────────────────────────────
app.get('/api/banners', (_req, res) => {
  const bannersDir = path.join(__dirname, 'public', 'banners');
  try {
    const files = fs.readdirSync(bannersDir)
      .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
      .sort()
      .map(f => `/banners/${f}`);
    res.json({ banners: files });
  } catch {
    res.json({ banners: [] });
  }
});

// ─── GET /api/latest-videos ───────────────────────────────────────────────
app.get('/api/latest-videos', async (_req, res) => {
  const CHANNEL_ID = 'UCu5LMkQhZdVlfNnoBso-nfg';
  try {
    const response = await axios.get(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      { timeout: 6000 }
    );
    const xml       = response.data;
    const videoIds  = [...xml.matchAll(/<yt:videoId>(.*?)<\/yt:videoId>/g)].map(m => m[1]);
    const allTitles = [...xml.matchAll(/<title>(.*?)<\/title>/gs)].map(m => m[1].trim());
    const titles    = allTitles.slice(1);
    const videos    = videoIds.slice(0, 5).map((id, i) => ({
      id,
      title:     titles[i] || 'Video',
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    }));
    res.json({ videos });
  } catch (err) {
    console.error('RSS fetch error:', err.message);
    res.json({ videos: [] });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`   Admin panel   : http://localhost:${PORT}/admin\n`);
});
