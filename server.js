/**
 * Tip Site — Express server
 * - Serves the frontend
 * - Creates Razorpay orders
 * - Handles Razorpay webhooks → fires StreamElements AND/OR Streamlabs alerts
 *
 * Set whichever tokens you have in .env — both work simultaneously if both are set.
 */

require('dotenv').config();
const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const path     = require('path');
const fs       = require('fs');

const app = express();

// ─── Env vars ──────────────────────────────────────────────────────────────
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET,

  // StreamElements
  SE_CHANNEL_ID,
  SE_JWT_TOKEN,

  // Streamlabs
  STREAMLABS_ACCESS_TOKEN,

  STREAMER_NAME = 'Streamer',
  PORT          = 3000,
} = process.env;

// ─── Startup check ─────────────────────────────────────────────────────────
console.log('\n── Tip Site starting up ──────────────────────────────');
console.log(`   StreamElements : ${SE_JWT_TOKEN       ? '✅ configured' : '⬜ not set'}`);
console.log(`   Streamlabs     : ${STREAMLABS_ACCESS_TOKEN ? '✅ configured' : '⬜ not set'}`);
console.log('──────────────────────────────────────────────────────\n');

// ─── Razorpay client ───────────────────────────────────────────────────────
const Razorpay = require('razorpay');
const razorpay = new Razorpay({
  key_id:     RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ─── Middleware ────────────────────────────────────────────────────────────
// Raw body for webhook verification — MUST come before express.json
app.use('/webhook/razorpay', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Serve HTML with injected config ──────────────────────────────────────
const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('__RAZORPAY_KEY__', RAZORPAY_KEY_ID || '');

app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ─── POST /create-order ────────────────────────────────────────────────────
app.post('/create-order', async (req, res) => {
  const { amount, name, message } = req.body;

  if (!amount || isNaN(amount) || Number(amount) < 1) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const order = await razorpay.orders.create({
      amount:   Math.round(Number(amount) * 100), // paise
      currency: 'INR',
      receipt:  `tip_${Date.now()}`,
      notes: {
        donor_name: name    || 'Anonymous',
        message:    message || '',
      },
    });

    res.json({ ...order, key: RAZORPAY_KEY_ID });

  } catch (err) {
    console.error('❌ Order creation failed:', err.message);
    res.status(500).json({ error: 'Could not create payment order' });
  }
});

// ─── Alert helpers ─────────────────────────────────────────────────────────

/**
 * Fire a StreamElements tip alert.
 * Docs: https://docs.streamelements.com/reference/tips_create
 */
async function alertStreamElements({ donorName, email, amountINR, message }) {
  if (!SE_JWT_TOKEN || !SE_CHANNEL_ID) return;

  try {
    await axios.post(
      `https://api.streamelements.com/kappa/v2/tips/${SE_CHANNEL_ID}`,
      {
        user:     { username: donorName, email },
        amount:   amountINR,
        currency: 'INR',
        message,
        imported: true,
      },
      { headers: { 'Authorization': `Bearer ${SE_JWT_TOKEN}` } }
    );
    console.log(`🔔 StreamElements alert fired — ₹${amountINR} from ${donorName}`);

  } catch (err) {
    console.error('❌ StreamElements error:', err?.response?.data || err.message);
  }
}

/**
 * Fire a Streamlabs donation alert.
 * Docs: https://dev.streamlabs.com/reference/donations-1
 */
async function alertStreamlabs({ donorName, email, amountINR, message }) {
  if (!STREAMLABS_ACCESS_TOKEN) return;

  try {
    // Streamlabs expects form-encoded data
    const params = new URLSearchParams({
      name:         donorName,
      message:      message || ' ',          // Streamlabs requires a non-empty message
      identifier:   email,
      amount:       amountINR.toString(),
      currency:     'INR',
      skip_alert:   'false',                 // false = DO trigger the alert
      access_token: STREAMLABS_ACCESS_TOKEN,
    });

    await axios.post(
      'https://streamlabs.com/api/v1.0/donations',
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log(`🔔 Streamlabs alert fired — ₹${amountINR} from ${donorName}`);

  } catch (err) {
    console.error('❌ Streamlabs error:', err?.response?.data || err.message);
  }
}

// ─── POST /webhook/razorpay ────────────────────────────────────────────────
app.post('/webhook/razorpay', async (req, res) => {

  // 1. Verify webhook signature
  const signature   = req.headers['x-razorpay-signature'];
  const expectedSig = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (signature !== expectedSig) {
    console.warn('⚠️  Webhook signature mismatch — ignoring');
    return res.status(400).send('Invalid signature');
  }

  // 2. Parse event
  let event;
  try { event = JSON.parse(req.body); }
  catch { return res.status(400).send('Bad JSON'); }

  // 3. Only act on captured payments
  if (event.event !== 'payment.captured') {
    return res.status(200).send('Ignored');
  }

  // 4. Extract donor info
  const payment   = event.payload.payment.entity;
  const donorName = payment.notes?.donor_name || 'Anonymous';
  const message   = payment.notes?.message    || '';
  const amountINR = payment.amount / 100;
  const email     = payment.email || 'noemail@donation.local';

  console.log(`\n💸 Payment captured: ₹${amountINR} from ${donorName}`);
  if (message) console.log(`   Message: "${message}"`);

  // 5. Fire alerts on both platforms simultaneously
  await Promise.all([
    alertStreamElements({ donorName, email, amountINR, message }),
    alertStreamlabs    ({ donorName, email, amountINR, message }),
  ]);

  res.status(200).send('OK');
});


// ─── GET /api/banners — list images in public/banners/ ────────────────────
// Drop .jpg/.png/.gif/.webp files into public/banners/ to show them in the
// top carousel automatically. No restart needed; files are read on each request.
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

// ─── Latest YouTube videos (RSS feed, no API key needed) ──────────────────
app.get('/api/latest-videos', async (req, res) => {
  const CHANNEL_ID = 'UCu5LMkQhZdVlfNnoBso-nfg';
  try {
    const response = await axios.get(
      `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`,
      { timeout: 6000 }
    );
    const xml = response.data;
    const videoIds = [...xml.matchAll(/<yt:videoId>(.*?)<\/yt:videoId>/g)].map(m => m[1]);
    const allTitles = [...xml.matchAll(/<title>(.*?)<\/title>/gs)].map(m => m[1].trim());
    const titles = allTitles.slice(1); // skip channel title
    const videos = videoIds.slice(0, 5).map((id, i) => ({
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
  console.log(`   Webhook URL   : http://localhost:${PORT}/webhook/razorpay\n`);
});
