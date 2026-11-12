/**
 * Tip Site — Express server
 * Payment flow: Static UPI QR → viewer pays → submits name + message
 *               → /confirm-tip fires StreamElements AND/OR Streamlabs alerts
 *
 * Set whichever alert tokens you have in .env — both work simultaneously.
 */

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');
const fs      = require('fs');

const app = express();

// ─── Env vars ──────────────────────────────────────────────────────────────
const {
  // StreamElements
  SE_CHANNEL_ID,
  SE_JWT_TOKEN,

  // Streamlabs
  STREAMLABS_ACCESS_TOKEN,

  PORT = 3000,
} = process.env;

// ─── Startup check ─────────────────────────────────────────────────────────
console.log('\n── Tip Site starting up ──────────────────────────────');
console.log(`   StreamElements : ${SE_JWT_TOKEN            ? '✅ configured' : '⬜ not set'}`);
console.log(`   Streamlabs     : ${STREAMLABS_ACCESS_TOKEN ? '✅ configured' : '⬜ not set'}`);
console.log('──────────────────────────────────────────────────────\n');

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Serve HTML ────────────────────────────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ─── Alert helpers ─────────────────────────────────────────────────────────

/**
 * Fire a StreamElements tip alert.
 * Docs: https://docs.streamelements.com/reference/tips_create
 */
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

/**
 * Fire a Streamlabs donation alert.
 * Docs: https://dev.streamlabs.com/reference/donations-1
 */
async function alertStreamlabs({ donorName, amountINR, message }) {
  if (!STREAMLABS_ACCESS_TOKEN) return false;

  try {
    const params = new URLSearchParams({
      name:         donorName,
      message:      message || ' ',   // Streamlabs requires non-empty
      identifier:   'tip@gameday.live',
      amount:       amountINR.toString(),
      currency:     'INR',
      skip_alert:   'false',          // false = DO trigger the alert
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
// Called by the frontend after the viewer has paid via UPI QR and fills in
// their name + message. Fires stream alerts on both platforms.
app.post('/confirm-tip', async (req, res) => {
  const { name, message, amount } = req.body;

  const donorName = (name || 'Anonymous').substring(0, 50).trim();
  const tipMsg    = (message || '').substring(0, 200).trim();
  const amountINR = Number(amount) || 0;

  if (amountINR < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  console.log(`\n💸 Tip confirmed: ₹${amountINR} from ${donorName}`);
  if (tipMsg) console.log(`   Message: "${tipMsg}"`);

  // Fire alerts on both platforms simultaneously, track results
  const [seFired, slFired] = await Promise.all([
    alertStreamElements({ donorName, amountINR, message: tipMsg }),
    alertStreamlabs    ({ donorName, amountINR, message: tipMsg }),
  ]);

  const alertsFired = (seFired ? 1 : 0) + (slFired ? 1 : 0);
  const configured  = (SE_JWT_TOKEN && SE_CHANNEL_ID) || STREAMLABS_ACCESS_TOKEN;

  if (!configured) {
    console.warn('⚠️  No alert platform configured — set SE_JWT_TOKEN+SE_CHANNEL_ID or STREAMLABS_ACCESS_TOKEN in env vars');
  }

  res.json({ ok: true, alertsFired, configured: !!configured });
});

// ─── GET /api/health ──────────────────────────────────────────────────────
// Called on page load so the UI can warn immediately if no alert platform is set
app.get('/api/health', (_req, res) => {
  const seConfigured = !!(SE_JWT_TOKEN && SE_CHANNEL_ID);
  const slConfigured = !!STREAMLABS_ACCESS_TOKEN;
  res.json({
    seConfigured,
    slConfigured,
    configured: seConfigured || slConfigured,
  });
});

// ─── GET /api/banners ──────────────────────────────────────────────────────
// Drop .jpg/.png/.gif/.webp files into public/banners/ to auto-show them
// in the top carousel. No restart needed; files are read on each request.
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
app.get('/api/latest-videos', async (req, res) => {
  const CHANNEL_ID = 'UCu5LMkQhZdVlfNnoBso-nfg';
  try {
    const response = await axios.get(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      { timeout: 6000 }
    );
    const xml      = response.data;
    const videoIds = [...xml.matchAll(/<yt:videoId>(.*?)<\/yt:videoId>/g)].map(m => m[1]);
    const allTitles = [...xml.matchAll(/<title>(.*?)<\/title>/gs)].map(m => m[1].trim());
    const titles   = allTitles.slice(1);
    const videos   = videoIds.slice(0, 5).map((id, i) => ({
      id,
      title: titles[i] || 'Video',
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
  console.log(`   Confirm tip URL: http://localhost:${PORT}/confirm-tip\n`);
});
