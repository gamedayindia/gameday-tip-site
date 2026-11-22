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

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
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

// ─── POST /api/admin/approve/:id ──────────────────────────────────────────
// Streamer taps Approve → alerts fire immediately.
app.post('/api/admin/approve/:id', requireAdmin, async (req, res) => {
  const tip = tipQueue.get(req.params.id);
  if (!tip)                    return res.status(404).json({ error: 'Tip not found' });
  if (tip.status !== 'pending') return res.status(400).json({ error: 'Already processed' });

  tip.status = 'processing';

  const [seFired, slFired] = await Promise.all([
    alertStreamElements({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
    alertStreamlabs    ({ donorName: tip.name, amountINR: tip.amount, message: tip.message }),
  ]);

  tip.alertsFired = (seFired ? 1 : 0) + (slFired ? 1 : 0);
  tip.status      = 'approved';

  const configured = (SE_JWT_TOKEN && SE_CHANNEL_ID) || STREAMLABS_ACCESS_TOKEN;
  if (!configured) {
    console.warn('⚠️  Approved but no alert platform configured — set env vars!');
  }

  console.log(`✅ Tip approved: ₹${tip.amount} from ${tip.name} — alerts fired: ${tip.alertsFired}`);

  // Keep in queue for 5 more minutes so the viewer's poll can read 'approved'
  setTimeout(() => tipQueue.delete(tip.id), 5 * 60 * 1000);

  res.json({ ok: true, alertsFired: tip.alertsFired, configured: !!configured });
});

// ─── POST /api/admin/reject/:id ───────────────────────────────────────────
// Streamer taps Reject → viewer sees a payment-failed message.
app.post('/api/admin/reject/:id', requireAdmin, (req, res) => {
  const tip = tipQueue.get(req.params.id);
  if (!tip) return res.status(404).json({ error: 'Tip not found' });

  tip.status = 'rejected';
  console.log(`❌ Tip rejected: ₹${tip.amount} from ${tip.name}`);

  // Keep for 2 minutes so viewer's poll gets the rejected status
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
