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

app.get('/admin', (req, res) => {
  // If password passed as query param, pre-authenticate and skip login screen
  const preAuth = (req.query.pw === ADMIN_PASSWORD) ? 'true' : 'false';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>GameDay Admin</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  :root{--bg:#05070E;--surface:#0D1117;--card:#121820;--border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.12);--red:#FF1A2E;--cyan:#00C8FF;--green:#00E676;--text:#F0F4FF;--text2:#8899BB;--muted:#445566;--safe-top:env(safe-area-inset-top,0px);--safe-bot:env(safe-area-inset-bottom,0px)}
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
  body{font-family:'Space Grotesk',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;padding-top:var(--safe-top);padding-bottom:calc(var(--safe-bot) + 24px);overflow-x:hidden}
  .topbar{position:sticky;top:0;z-index:100;background:rgba(5,7,14,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--border);padding:14px 20px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px}
  .topbar-logo{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:800;letter-spacing:-.3px}
  .logo-dot{width:10px;height:10px;border-radius:50%;background:var(--red);box-shadow:0 0 8px var(--red);animation:logoPulse 2s ease-in-out infinite}
  @keyframes logoPulse{0%,100%{opacity:1}50%{opacity:.4}}
  .topbar-badge{font-size:12px;font-weight:700;background:var(--red);color:#fff;padding:3px 9px;border-radius:20px;min-width:28px;text-align:center}
  .topbar-badge.zero{background:var(--surface);color:var(--muted)}
  #loginScreen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:calc(100dvh - 60px);padding:32px 24px;text-align:center}
  .login-icon{width:72px;height:72px;border-radius:20px;background:linear-gradient(135deg,var(--red),#c0001a);display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:32px;box-shadow:0 8px 32px rgba(255,26,46,.35)}
  .login-title{font-size:26px;font-weight:800;margin-bottom:8px;background:linear-gradient(90deg,#fff 60%,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .login-sub{font-size:14px;color:var(--text2);margin-bottom:36px;line-height:1.6}
  .pw-field{width:100%;max-width:320px;background:var(--surface);border:1.5px solid var(--border2);border-radius:14px;padding:15px 18px;font-size:17px;font-family:inherit;color:var(--text);text-align:center;letter-spacing:2px;outline:none;transition:border-color .2s;margin-bottom:16px}
  .pw-field:focus{border-color:var(--cyan)}
  .pw-field::placeholder{letter-spacing:0;color:var(--muted);font-size:14px}
  .login-btn{width:100%;max-width:320px;background:var(--red);color:#fff;border:none;border-radius:14px;padding:16px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:opacity .15s,transform .1s}
  .login-btn:active{opacity:.8;transform:scale(.98)}
  .login-err{font-size:13px;color:var(--red);margin-top:12px;min-height:20px}
  #adminPanel{display:none}
  .section-header{padding:20px 20px 10px;display:flex;align-items:center;justify-content:space-between}
  .section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text2)}
  .refresh-btn{background:none;border:1.5px solid var(--border2);border-radius:8px;padding:5px 12px;color:var(--text2);font-size:12px;font-family:inherit;cursor:pointer;display:flex;align-items:center;gap:6px}
  .refresh-btn:active{border-color:var(--cyan);color:var(--cyan)}
  .spin{animation:spin .6s linear infinite;display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}
  .empty-state{text-align:center;padding:60px 24px;color:var(--text2)}
  .empty-icon{font-size:48px;margin-bottom:16px}
  .empty-title{font-size:18px;font-weight:700;color:var(--text);margin-bottom:8px}
  .empty-sub{font-size:13.5px;line-height:1.6}
  .tips-list{padding:0 16px;display:flex;flex-direction:column;gap:12px}
  .tip-card{background:var(--card);border:1.5px solid var(--border2);border-radius:18px;overflow:hidden;animation:cardIn .3s ease-out}
  @keyframes cardIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  .tip-card-top{padding:16px 18px 14px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .tip-name{font-size:17px;font-weight:800;color:var(--text);margin-bottom:3px}
  .tip-time{font-size:12px;color:var(--muted)}
  .tip-amount-badge{background:rgba(0,200,255,.12);border:1.5px solid rgba(0,200,255,.25);border-radius:10px;padding:6px 14px;font-size:20px;font-weight:800;color:var(--cyan);white-space:nowrap;flex-shrink:0}
  .tip-message{padding:0 18px 14px;font-size:14px;color:var(--text2);line-height:1.55;font-style:italic}
  .tip-message:empty{display:none}
  .tip-actions{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border)}
  .tip-btn{border:none;background:none;padding:15px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:background .15s}
  .tip-btn:active{opacity:.75}
  .tip-btn.approve{color:var(--green);border-right:1px solid var(--border)}
  .tip-btn.approve:active{background:rgba(0,230,118,.08)}
  .tip-btn.reject{color:var(--red)}
  .tip-btn.reject:active{background:rgba(255,26,46,.08)}
  .tip-btn:disabled{opacity:.4;pointer-events:none}
  .tip-card.processing{opacity:.6;pointer-events:none}
  .status-bar{position:fixed;bottom:calc(var(--safe-bot) + 12px);left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border2);border-radius:20px;padding:8px 20px;font-size:12px;color:var(--text2);display:flex;align-items:center;gap:8px;opacity:0;transition:opacity .3s;pointer-events:none;white-space:nowrap;max-width:90vw}
  .status-bar.show{opacity:1}
  .status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
  .status-dot.ok{background:var(--green);box-shadow:0 0 6px var(--green)}
  .status-dot.err{background:var(--red);box-shadow:0 0 6px var(--red)}
  .toast{position:fixed;top:calc(var(--safe-top) + 70px);left:50%;transform:translateX(-50%) translateY(-10px);background:var(--card);border:1.5px solid var(--border2);border-radius:14px;padding:12px 20px;font-size:14px;font-weight:600;color:var(--text);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap;max-width:90vw;z-index:200}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast.green{border-color:rgba(0,230,118,.35);color:var(--green)}
  .toast.red{border-color:rgba(255,26,46,.35);color:var(--red)}
  .logout-row{text-align:center;padding:32px 20px 8px}
  .logout-btn{background:none;border:none;color:var(--muted);font-size:13px;font-family:inherit;cursor:pointer;text-decoration:underline}
</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-logo"><div class="logo-dot"></div>GameDay Admin</div>
  <div class="topbar-badge zero" id="pendingBadge">0</div>
</div>
<div id="loginScreen">
  <div class="login-icon">🔐</div>
  <div class="login-title">Admin Access</div>
  <p class="login-sub">Enter your GameDay admin password<br>to manage tip confirmations.</p>
  <input class="pw-field" id="pwInput" type="password" placeholder="Enter admin password" autocomplete="current-password" autocorrect="off" autocapitalize="none">
  <button class="login-btn" id="loginBtn">Unlock →</button>
  <div class="login-err" id="loginErr"></div>
</div>
<div id="adminPanel">
  <div class="section-header">
    <span class="section-title">Pending Tips</span>
    <button class="refresh-btn" id="refreshBtn"><span id="refreshIcon">↻</span> Refresh</button>
  </div>
  <div class="tips-list" id="tipsList"></div>
  <div class="logout-row"><button class="logout-btn" id="logoutBtn">Sign out</button></div>
</div>
<div class="status-bar" id="statusBar"><div class="status-dot ok" id="statusDot"></div><span id="statusText">Connected</span></div>
<div class="toast" id="toast"></div>
<script>
let _password=sessionStorage.getItem('gd_admin_pw')||'';
let _pollTimer=null;
function showToast(msg,type=''){const el=document.getElementById('toast');el.textContent=msg;el.className='toast '+type+' show';setTimeout(()=>{el.className='toast '+type;},2800)}
function showStatus(msg,ok=true){const bar=document.getElementById('statusBar');const dot=document.getElementById('statusDot');const text=document.getElementById('statusText');dot.className='status-dot '+(ok?'ok':'err');text.textContent=msg;bar.classList.add('show');clearTimeout(bar._t);bar._t=setTimeout(()=>bar.classList.remove('show'),2500)}
function timeAgo(ts){const s=Math.floor((Date.now()-ts)/1000);if(s<60)return s+'s ago';if(s<3600)return Math.floor(s/60)+'m ago';return Math.floor(s/3600)+'h ago'}
function formatINR(n){return '\\u20B9'+Number(n).toLocaleString('en-IN')}
async function apiFetch(url,opts={}){const r=await fetch(url,{...opts,headers:{'Content-Type':'application/json','x-admin-password':_password,...(opts.headers||{})}});if(r.status===401)throw new Error('AUTH_FAIL');if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}
async function tryLogin(){const pw=document.getElementById('pwInput').value.trim();const err=document.getElementById('loginErr');if(!pw){err.textContent='Enter your password first.';return}const btn=document.getElementById('loginBtn');btn.disabled=true;btn.innerHTML='<span class="spin" style="display:inline-block;margin-right:6px">↻</span>Checking…';err.textContent='';try{_password=pw;await apiFetch('/api/admin/tips');sessionStorage.setItem('gd_admin_pw',pw);showAdminPanel()}catch(e){if(e.message==='AUTH_FAIL'){err.textContent='❌ Wrong password. Try again.'}else{err.textContent='⚠️ Could not connect. Check your internet.'}btn.disabled=false;btn.textContent='Unlock →'}}
function showAdminPanel(){document.getElementById('loginScreen').style.display='none';document.getElementById('adminPanel').style.display='block';loadTips();startAutoRefresh()}
function logout(){_password='';sessionStorage.removeItem('gd_admin_pw');clearInterval(_pollTimer);document.getElementById('adminPanel').style.display='none';document.getElementById('loginScreen').style.display='flex';document.getElementById('pwInput').value='';document.getElementById('loginErr').textContent='';document.getElementById('loginBtn').disabled=false;document.getElementById('loginBtn').textContent='Unlock →'}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
async function loadTips(showSpinner=false){const listEl=document.getElementById('tipsList');const icon=document.getElementById('refreshIcon');const badge=document.getElementById('pendingBadge');if(showSpinner)icon.className='spin';try{const data=await apiFetch('/api/admin/tips');icon.className='';const tips=data.tips||[];badge.textContent=tips.length;badge.className='topbar-badge'+(tips.length===0?' zero':'');if(tips.length===0){listEl.innerHTML='<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-title">All clear!</div><p class="empty-sub">No pending tips right now.<br>Auto-refreshes every 5 seconds.</p></div>';return}listEl.innerHTML=tips.map(t=>'<div class="tip-card" id="card-'+t.id+'"><div class="tip-card-top"><div><div class="tip-name">'+escHtml(t.name)+'</div><div class="tip-time">'+timeAgo(t.timestamp)+'</div></div><div class="tip-amount-badge">'+formatINR(t.amount)+'</div></div>'+(t.message?'<div class="tip-message">"'+escHtml(t.message)+'"</div>':'')+'<div class="tip-actions"><button class="tip-btn approve" onclick="approveTip(\''+t.id+'\')">✅ Approve</button><button class="tip-btn reject" onclick="rejectTip(\''+t.id+'\')">❌ Reject</button></div></div>').join('')}catch(e){icon.className='';if(e.message==='AUTH_FAIL'){logout();return}showStatus('Connection lost',false)}}
async function approveTip(id){const card=document.getElementById('card-'+id);if(!card)return;card.classList.add('processing');try{const data=await apiFetch('/api/admin/approve/'+id,{method:'POST'});card.style.transition='opacity .4s,transform .4s';card.style.opacity='0';card.style.transform='scale(.95)';setTimeout(()=>{card.remove();loadTips();},420);const msg=data.alertsFired>0?'🔔 Alert fired! ('+data.alertsFired+' platform'+(data.alertsFired>1?'s':'')+'!)':'✅ Approved — no alert platform configured';showToast(msg,'green');showStatus('Approved',true)}catch(e){card.classList.remove('processing');if(e.message==='AUTH_FAIL'){logout();return}showToast('⚠️ Could not approve. Try again.','red');showStatus('Action failed',false)}}
async function rejectTip(id){const card=document.getElementById('card-'+id);if(!card)return;const btns=card.querySelectorAll('.tip-btn');btns.forEach(b=>b.disabled=true);try{await apiFetch('/api/admin/reject/'+id,{method:'POST'});card.style.transition='opacity .4s,transform .4s';card.style.opacity='0';card.style.transform='scale(.95)';setTimeout(()=>{card.remove();loadTips();},420);showToast('❌ Tip rejected','red');showStatus('Rejected',true)}catch(e){btns.forEach(b=>b.disabled=false);if(e.message==='AUTH_FAIL'){logout();return}showToast('⚠️ Could not reject. Try again.','red');showStatus('Action failed',false)}}
function startAutoRefresh(){clearInterval(_pollTimer);_pollTimer=setInterval(()=>loadTips(false),5000)}
document.getElementById('loginBtn').addEventListener('click',tryLogin);
document.getElementById('pwInput').addEventListener('keydown',e=>{if(e.key==='Enter')tryLogin()});
document.getElementById('refreshBtn').addEventListener('click',()=>loadTips(true));
document.getElementById('logoutBtn').addEventListener('click',logout);
// Server pre-authenticated via ?pw= query param
if('${preAuth}'==='true'){_password=new URLSearchParams(location.search).get('pw');sessionStorage.setItem('gd_admin_pw',_password);showAdminPanel();}
else if(_password){showAdminPanel();}
</script>
</body>
</html>`;
  res.send(adminHtml);
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
