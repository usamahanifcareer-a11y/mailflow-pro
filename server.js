require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const { Readable } = require('stream');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = 'usama.hanif.career@gmail.com';
const DAILY_LIMIT = 100;
const IS_VERCEL = !!process.env.VERCEL;
const CRON_SECRET = process.env.CRON_SECRET || 'mf-cron-default-change-me';

if (!process.env.SESSION_SECRET) { console.error('FATAL: SESSION_SECRET missing!'); process.exit(1); }

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const aiCache = new Map();
const AI_CACHE_TTL = 10 * 60 * 1000;

function getCacheKey(p) { return crypto.createHash('md5').update(p).digest('hex'); }
function getCachedResponse(p) {
  const k = getCacheKey(p); const e = aiCache.get(k);
  if (!e) return null;
  if (Date.now() - e.time > AI_CACHE_TTL) { aiCache.delete(k); return null; }
  return e.text;
}
function setCachedResponse(p, t) {
  if (aiCache.size > 500) { const k = aiCache.keys().next().value; aiCache.delete(k); }
  aiCache.set(getCacheKey(p), { text: t, time: Date.now() });
}

function safeParseJSON(text) {
  if (!text) return null;
  let c = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const fb = c.indexOf('{'), lb = c.lastIndexOf('}');
  if (fb === -1 || lb === -1) return null;
  try { return JSON.parse(c.substring(fb, lb + 1)); } catch (e) { return null; }
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 12000);
  try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(t); return r; }
  catch (e) { clearTimeout(t); throw e; }
}

async function callGroq(prompt) {
  if (!GROQ_KEY) throw new Error('No key');
  const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 900 })
  }, 12000);
  if (!r.ok) { const t = await r.text(); throw new Error('Groq ' + r.status + ' ' + t.substring(0, 100)); }
  const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim();
}

async function callCerebras(prompt) {
  if (!CEREBRAS_KEY) throw new Error('No key');
  const r = await fetchWithTimeout('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CEREBRAS_KEY },
    body: JSON.stringify({ model: 'llama-4-scout-17b-16e-instruct', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 900 })
  }, 12000);
  if (!r.ok) { const t = await r.text(); throw new Error('Cerebras ' + r.status + ' ' + t.substring(0, 100)); }
  const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim();
}

async function callMistral(prompt) {
  if (!MISTRAL_KEY) throw new Error('No key');
  const r = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MISTRAL_KEY },
    body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 900 })
  }, 12000);
  if (!r.ok) { const t = await r.text(); throw new Error('Mistral ' + r.status + ' ' + t.substring(0, 100)); }
  const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('No key');
  const client = new GoogleGenerativeAI(GEMINI_KEY);
  const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function callOpenRouter(prompt) {
  if (!OPENROUTER_KEY) throw new Error('No key');
  const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'HTTP-Referer': process.env.BACKEND_URL || 'https://mailflow-pro-ten.vercel.app', 'X-Title': 'MailFlow Pro' },
    body: JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', messages: [{ role: 'user', content: prompt + '\nReturn valid JSON only.' }], temperature: 0.7, max_tokens: 900 })
  }, 12000);
  if (!r.ok) { const t = await r.text(); throw new Error('OpenRouter ' + r.status + ' ' + t.substring(0, 100)); }
  const d = await r.json(); return (d.choices?.[0]?.message?.content || '').trim();
}

async function callAI(prompt) {
  const cached = getCachedResponse(prompt);
  if (cached) { console.log('AI: CACHE'); return cached; }

  const providers = [
    { name: 'Groq', fn: callGroq },
    { name: 'Cerebras', fn: callCerebras },
    { name: 'Gemini', fn: callGemini },
    { name: 'Mistral', fn: callMistral },
    { name: 'OpenRouter', fn: callOpenRouter }
  ];
  const errors = [];
  for (const p of providers) {
    try {
      const text = await p.fn(prompt);
      if (!text || text.length < 5) { errors.push(p.name + ':empty'); continue; }
      console.log('AI OK: ' + p.name);
      setCachedResponse(prompt, text);
      return text;
    } catch (err) { console.error('AI FAIL ' + p.name + ':', err.message); errors.push(p.name); }
  }
  throw new Error('All AI failed: ' + errors.join(','));
}

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieSession({ name: 'mf_session', keys: [process.env.SESSION_SECRET], maxAge: 72 * 60 * 60 * 1000, secure: IS_VERCEL, sameSite: IS_VERCEL ? 'none' : 'lax', httpOnly: true, signed: true, overwrite: true }));
app.use(express.static(path.join(__dirname, 'public')));

let serviceAccount = {};
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  else if (process.env.FIREBASE_SERVICE_ACCOUNT) serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) { console.error('Firebase parse error:', e.message); }
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
const SCOPES = ['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/drive.file'];

function authRequired(req, res, next) { if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: 'Session expired.' }); next(); }
function adminRequired(req, res, next) { if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: 'Session expired.' }); if (req.session.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).json({ ok: false, error: 'Admin required' }); next(); }
async function getUserData(uid) { const d = await db.collection('users').doc(uid).get(); return d.exists ? d.data() : null; }
function setUserOAuth(t) { const c = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI); c.setCredentials(t); return c; }
function generateAppAccountId() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let id = 'MFP-'; for (let i = 0; i < 6; i++) id += c.charAt(Math.floor(Math.random() * c.length)); return id; }
function isQuietHours(p) { if (!p || !p.quietEnabled) return false; const n = new Date().getHours(); const s = Number(p.quietStart); const e = Number(p.quietEnd); if (isNaN(s) || isNaN(e) || s === e) return false; if (s < e) return n >= s && n < e; return n >= s || n < e; }
function getCurrentHourKey() { const n = new Date(); return n.toISOString().split('T')[0] + '-' + n.getHours(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/api/health', (req, res) => res.json({ ok: true, vercel: IS_VERCEL, firebase: !!serviceAccount.project_id, ai: { groq: !!GROQ_KEY, cerebras: !!CEREBRAS_KEY, gemini: !!GEMINI_KEY, mistral: !!MISTRAL_KEY, openrouter: !!OPENROUTER_KEY } }));

app.get('/api/ai/debug', authRequired, async (req, res) => {
  const testPrompt = 'Return ONLY JSON: {"message":"hello","status":"ok"}';
  const results = {};
  const testers = [
    { name: 'groq', key: GROQ_KEY, fn: callGroq },
    { name: 'cerebras', key: CEREBRAS_KEY, fn: callCerebras },
    { name: 'gemini', key: GEMINI_KEY, fn: callGemini },
    { name: 'mistral', key: MISTRAL_KEY, fn: callMistral },
    { name: 'openrouter', key: OPENROUTER_KEY, fn: callOpenRouter }
  ];
  for (const t of testers) {
    if (!t.key) { results[t.name] = { status: 'no_key' }; continue; }
    const start = Date.now();
    try { const text = await t.fn(testPrompt); results[t.name] = { status: 'ok', time: (Date.now() - start) + 'ms', preview: text.substring(0, 80) }; }
    catch (e) { results[t.name] = { status: 'fail', time: (Date.now() - start) + 'ms', error: e.message.substring(0, 150) }; }
  }
  res.json({ ok: true, results });
});

app.get('/auth/google', (req, res) => { const url = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' }); res.redirect(url); });

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const info = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get();
    const email = info.data.email, name = info.data.name, picture = info.data.picture || '';
    const uid = crypto.createHash('md5').update(email).digest('hex');
    const existing = await db.collection('users').doc(uid).get();
    const data = { email, name, picture, tokens, updatedAt: new Date() };
    if (!existing.exists) {
      data.createdAt = new Date(); data.quietEnabled = false; data.quietStart = 22; data.quietEnd = 7;
      data.autoSend = false; data.autoSendBatchSize = 5; data.signature = ''; data.logoUrl = ''; data.sigFields = {};
      data.appAccountId = generateAppAccountId(); data.lastAutoSendRun = null; data.totalAutoSent = 0; data.lastSendTime = null;
    } else {
      const ex = existing.data();
      if (!ex.appAccountId) data.appAccountId = generateAppAccountId();
      if (ex.autoSendBatchSize === undefined) data.autoSendBatchSize = 5;
      if (ex.totalAutoSent === undefined) data.totalAutoSent = 0;
    }
    await db.collection('users').doc(uid).set(data, { merge: true });
    const fresh = await db.collection('users').doc(uid).get();
    req.session.user = { id: uid, email, name, picture, appAccountId: fresh.data().appAccountId, isAdmin: email.toLowerCase() === ADMIN_EMAIL.toLowerCase() };
    res.redirect((process.env.FRONTEND_URL || 'http://localhost:3000') + '?login=success');
  } catch (err) { console.error('OAuth:', err.message); res.redirect((process.env.FRONTEND_URL || 'http://localhost:3000') + '?login=error'); }
});

app.get('/api/me', async (req, res) => {
  if (req.session && req.session.user) {
    if (!req.session.user.appAccountId) { const d = await getUserData(req.session.user.id); if (d && d.appAccountId) req.session.user.appAccountId = d.appAccountId; }
    res.json({ ok: true, user: req.session.user });
  } else res.json({ ok: false });
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });
app.get('/api/quiet-status', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); const q = isQuietHours(d); res.json({ ok: true, inQuiet: q, quietEnd: d.quietEnd }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get('/api/quota', authRequired, async (req, res) => {
  try {
    const u = await getUserData(req.session.user.id);
    if (!u || !u.tokens) return res.json({ ok: false, error: 'Session expired' });
    const client = setUserOAuth(u.tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    let sent = 0;
    try { const r = await gmail.users.messages.list({ userId: 'me', q: `in:sent after:${oneDayAgo}`, maxResults: 500 }); sent = r.data.resultSizeEstimate || (r.data.messages ? r.data.messages.length : 0); }
    catch (e) { const t = new Date().toISOString().split('T')[0]; const sd = await db.collection('users').doc(req.session.user.id).collection('stats').doc(t).get(); sent = sd.exists ? (sd.data().sent || 0) : 0; }
    res.json({ ok: true, sentToday: sent, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - sent) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/analyze-live', authRequired, async (req, res) => {
  try {
    const { subject, body } = req.body;
    const hasS = subject && subject.trim().length > 0;
    const hasB = body && body.trim().length > 0;
    if (!hasS && !hasB) return res.json({ ok: true, empty: true });
    try {
      const u = await getUserData(req.session.user.id);
      const hasLogo = !!(u && u.logoUrl);
      const cleanBody = (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1200);
      const prompt = `Analyze this email. Return ONLY JSON.
Subject: "${(subject || '').substring(0, 200)}"
Body: "${cleanBody}"
Logo: ${hasLogo ? 'yes' : 'no'}
Return: {"score":0-100,"prediction":"EXCELLENT"|"GOOD"|"RISKY"|"SPAM","inboxProbability":0-100,"issues":[{"severity":"low"|"medium"|"high","message":"string"}],"suggestions":["string"],"tone":"string"}
Rules: <= 15 EXCELLENT, 16-40 GOOD, 41-70 RISKY, 71+ SPAM.`;
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && typeof parsed.score === 'number') return res.json({ ok: true, ...parsed, aiPowered: true });
    } catch (aiErr) { console.error('Live AI:', aiErr.message); }
    res.json({ ok: true, ...localAnalysis(subject, body), aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

function localAnalysis(subject, body) {
  const SW = ['free','guarantee','act now','click here','limited time','buy now','cash','prize','urgent','risk-free','earn money','work from home','make money','no cost','no fees'];
  const text = ((subject||'') + ' ' + (body||'')).toLowerCase();
  const found = SW.filter(w => text.includes(w));
  const links = (body.match(/https?:\/\//g) || []).length;
  const exc = ((subject.match(/!/g) || []).length) > 1;
  const caps = subject === subject.toUpperCase() && subject.length > 5;
  const cb = (body || '').replace(/<[^>]+>/g, ' ').trim();
  const wc = cb.split(/\s+/).filter(w => w).length;
  const issues = [];
  if (found.length) issues.push({ type: 'spam_words', severity: 'high', message: 'Contains: ' + found.slice(0,3).join(', ') });
  if (links > 2) issues.push({ type: 'links', severity: 'medium', message: links + ' links found' });
  if (exc) issues.push({ type: 'caps', severity: 'low', message: 'Multiple exclamation marks' });
  if (caps) issues.push({ type: 'caps', severity: 'high', message: 'Subject in ALL CAPS' });
  if (wc < 20 && wc > 0) issues.push({ type: 'short', severity: 'medium', message: 'Body too short' });
  const score = Math.min(100, found.length * 20 + (links > 2 ? 15 : 0) + (exc ? 10 : 0) + (caps ? 25 : 0) + (wc < 20 && wc > 0 ? 15 : 0));
  const inboxProbability = 100 - score;
  const prediction = score <= 15 ? 'EXCELLENT' : score <= 40 ? 'GOOD' : score <= 70 ? 'RISKY' : 'SPAM';
  const suggestions = [];
  if (found.length) suggestions.push('Remove trigger words: ' + found.slice(0,2).join(', '));
  if (links > 2) suggestions.push('Reduce links to 2 max');
  if (caps) suggestions.push('Write subject in normal case');
  if (wc < 20 && wc > 0) suggestions.push('Add more context (20+ words)');
  if (!suggestions.length) suggestions.push('Content looks good!');
  return { score, prediction, inboxProbability, issues, suggestions, tone: 'professional', readability: 75, emotionalTone: 'neutral' };
}

app.post('/api/ai/write-email', authRequired, async (req, res) => {
  try {
    const { context, recipientName, recipientCompany, tone, length } = req.body;
    if (!context) return res.json({ ok: false, error: 'Context required' });
    const TM = { formal: 'professional', friendly: 'warm', casual: 'casual', persuasive: 'confident' };
    const LM = { short: 'under 80 words', medium: '100-150 words', long: '200-250 words' };
    const prompt = `Write professional email. Return ONLY JSON.
Context: ${context}
Recipient: ${recipientName || 'unknown'}
Company: ${recipientCompany || 'unknown'}
Tone: ${TM[tone] || TM.formal}
Length: ${LM[length] || LM.medium}
Return: {"subject":"under 60 chars","body":"with \\n\\n breaks"}`;
    try {
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && parsed.subject && parsed.body) return res.json({ ok: true, ...parsed, aiPowered: true });
    } catch (e) { console.error('write:', e.message); }
    const r = recipientName || (recipientCompany ? recipientCompany + ' Team' : 'Hiring Team');
    const s = context.length > 55 ? context.substring(0, 52) + '...' : context;
    const b = `Dear ${r},\n\nI hope this message finds you well. I'm reaching out regarding ${context}.\n\nI believe this could be a great fit, and I would welcome the chance to discuss further.\n\nPlease let me know if you need any additional information.\n\nThank you for your time.\n\nBest regards`;
    res.json({ ok: true, subject: s, body: b, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/generate-subjects', authRequired, async (req, res) => {
  try {
    const { context } = req.body;
    const prompt = `Generate 5 email subject lines (max 60 chars). Return ONLY JSON.\nContext: ${context || 'professional outreach'}\nReturn: {"subjects":["s1","s2","s3","s4","s5"]}`;
    try {
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && parsed.subjects && parsed.subjects.length >= 3) return res.json({ ok: true, subjects: parsed.subjects, aiPowered: true });
    } catch (e) { console.error('subjects:', e.message); }
    const c = (context || 'Professional Outreach').substring(0, 50);
    res.json({ ok: true, subjects: [c, 'Quick question about ' + c, 'Following up on ' + c, 'Regarding ' + c, c + ' — Brief Introduction'], aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/improve-email', authRequired, async (req, res) => {
  try {
    const { subject, body } = req.body;
    const prompt = `Improve this email for inbox placement. Return ONLY JSON.\nSubject: "${subject || ''}"\nBody: "${(body||'').substring(0, 800)}"\nReturn: {"improvedSubject":"...","improvedBody":"...","beforeScore":50,"afterScore":85}`;
    try {
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && parsed.improvedSubject) return res.json({ ok: true, ...parsed, aiPowered: true });
    } catch (e) { console.error('improve:', e.message); }
    const cs = (subject || '').replace(/[!]{2,}/g, '!').replace(/\bfree\b/gi, '').trim();
    const cb = (body || '').replace(/\bfree\b/gi, '').replace(/[!]{2,}/g, '!').trim();
    res.json({ ok: true, improvedSubject: cs || subject, improvedBody: cb || body, beforeScore: 50, afterScore: 75, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/parse-bulk', authRequired, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.json({ ok: false, error: 'No text' });
    const emailRx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    const foundEmails = {};
    const seenEmails = new Set();
    for (const line of lines) {
      const emails = line.match(emailRx) || [];
      if (!emails.length) continue;
      let cleanLine = line;
      for (const e of emails) cleanLine = cleanLine.replace(e, ' ');
      cleanLine = cleanLine.replace(/[,;|<>"'\(\)\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      let company = '';
      if (cleanLine.length >= 2 && cleanLine.length <= 80) {
        const compacted = cleanLine.replace(/\s/g, '');
        const looksLikeDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(compacted);
        const isSingleWord = !cleanLine.includes(' ');
        if (!looksLikeDomain && !(isSingleWord && /^[a-z0-9._-]+$/i.test(cleanLine))) {
          company = cleanLine;
        }
      }
      for (const e of emails) {
        const lower = e.toLowerCase();
        if (seenEmails.has(lower)) continue;
        seenEmails.add(lower);
        foundEmails[lower] = company;
      }
    }
    const items = Object.keys(foundEmails).map(e => ({ email: e, company: foundEmails[e] }));
    const emptyCount = items.filter(i => !i.company).length;
    if (emptyCount > 0 && emptyCount < items.length) {
      try {
        const prompt = `Extract company/name for each email. Return ONLY JSON.\nText:\n${text.substring(0, 1500)}\nReturn: {"items":[{"email":"...","company":"..."}]}`;
        const aiText = await callAI(prompt);
        const parsed = safeParseJSON(aiText);
        if (parsed && parsed.items) {
          const aiMap = {};
          parsed.items.forEach(i => { if (i.email) aiMap[i.email.toLowerCase()] = i.company || ''; });
          const improved = items.map(i => ({ email: i.email, company: i.company || aiMap[i.email] || '' }));
          return res.json({ ok: true, items: improved, aiPowered: true });
        }
      } catch (e) { console.error('parse-bulk AI:', e.message); }
    }
    res.json({ ok: true, items: items, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/ai/best-time', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const snap = await db.collection('users').doc(uid).collection('emailLog').orderBy('sentAt', 'desc').limit(100).get();
    const hs = {};
    snap.forEach(d => { const data = d.data(); const ms = data.sentAt?._seconds ? data.sentAt._seconds * 1000 : new Date(data.sentAt).getTime(); const h = new Date(ms).getHours(); if (!hs[h]) hs[h] = { sent: 0, opened: 0 }; hs[h].sent++; });
    const rSnap = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Opened').get();
    rSnap.forEach(d => { const data = d.data(); if (data.openedAt) { const ms = data.openedAt._seconds ? data.openedAt._seconds * 1000 : new Date(data.openedAt).getTime(); const h = new Date(ms).getHours(); if (!hs[h]) hs[h] = { sent: 0, opened: 0 }; hs[h].opened = (hs[h].opened || 0) + 1; } });
    try {
      const hist = Object.entries(hs).map(([h, s]) => `Hour ${h}: sent=${s.sent}, opened=${s.opened || 0}`).join('\n');
      const prompt = `Recommend 3 best hours (0-23). Return ONLY JSON.\nHistory:\n${hist || 'No data'}\nReturn: {"bestHours":[h1,h2,h3],"reasoning":"short"}`;
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && parsed.bestHours) return res.json({ ok: true, ...parsed, aiPowered: true });
    } catch (e) { console.error('best-time:', e.message); }
    res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default business hours', aiPowered: false });
  } catch (e) { res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default', aiPowered: false }); }
});

app.post('/api/ai/analyze-replies', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const user = await getUserData(uid);
    if (!user.tokens) return res.json({ ok: false, error: 'Session expired' });
    const client = setUserOAuth(user.tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const list = await gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${since}`, maxResults: 10 });
    if (!list.data.messages || !list.data.messages.length) return res.json({ ok: true, replies: [] });
    const replies = [];
    for (const msg of list.data.messages.slice(0, 8)) {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = full.data.payload.headers;
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        let bodyText = '';
        const ex = (parts) => { for (const p of parts || []) { if (p.mimeType === 'text/plain' && p.body?.data) bodyText += Buffer.from(p.body.data, 'base64').toString(); else if (p.parts) ex(p.parts); } };
        if (full.data.payload.body?.data) bodyText = Buffer.from(full.data.payload.body.data, 'base64').toString(); else ex(full.data.payload.parts);
        bodyText = bodyText.substring(0, 400);
        replies.push({ id: msg.id, from, subject, bodyPreview: bodyText });
      } catch (e) {}
    }
    if (!replies.length) return res.json({ ok: true, replies: [] });
    try {
      const prompt = `Categorize email replies. Return ONLY JSON.
${replies.map((r, i) => `[${i}] From: ${r.from}\nSubject: ${r.subject}\nBody: ${r.bodyPreview}`).join('\n\n')}
Return: {"categories":[{"index":0,"type":"INTERESTED"|"NOT_INTERESTED"|"AUTO_REPLY"|"QUESTION"|"SPAM"|"MEETING_REQUEST"|"OTHER","sentiment":"POSITIVE"|"NEUTRAL"|"NEGATIVE","summary":"line"}]}`;
      const text = await callAI(prompt);
      const parsed = safeParseJSON(text);
      if (parsed && parsed.categories) {
        const enriched = replies.map((r, i) => { const cat = (parsed.categories || []).find(c => c.index === i) || {}; return { ...r, category: cat.type || 'OTHER', sentiment: cat.sentiment || 'NEUTRAL', summary: cat.summary || '' }; });
        return res.json({ ok: true, replies: enriched, aiPowered: true });
      }
    } catch (e) { console.error('analyze-replies:', e.message); }
    const enriched = replies.map(r => ({ ...r, category: 'OTHER', sentiment: 'NEUTRAL', summary: 'AI unavailable' }));
    res.json({ ok: true, replies: enriched, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/upload-logo', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64) return res.json({ ok: false, error: 'No data' });
    const allowed = ['image/png','image/jpeg','image/jpg','image/gif','image/svg+xml','image/webp'];
    if (!allowed.includes(mimeType)) return res.json({ ok: false, error: 'Invalid type' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.json({ ok: false, error: 'Max 2MB' });
    const u = await getUserData(req.session.user.id);
    if (!u.tokens) return res.json({ ok: false, error: 'Expired' });
    const client = setUserOAuth(u.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    if (u.logoFileId) { try { await drive.files.delete({ fileId: u.logoFileId }); } catch (e) {} }
    const up = await drive.files.create({ requestBody: { name: filename || 'logo', mimeType }, media: { mimeType, body: Readable.from(buf) }, fields: 'id' });
    const fid = up.data.id;
    try { await drive.permissions.create({ fileId: fid, requestBody: { role: 'reader', type: 'anyone' } }); } catch (e) {}
    const url = 'https://drive.google.com/thumbnail?id=' + fid + '&sz=w500';
    const urlAlt = 'https://lh3.googleusercontent.com/d/' + fid;
    await db.collection('users').doc(req.session.user.id).update({ logoFileId: fid, logoUrl: url, logoUrlAlt: urlAlt });
    res.json({ ok: true, url, urlAlt, fileId: fid });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/remove-logo', authRequired, async (req, res) => {
  try {
    const u = await getUserData(req.session.user.id);
    if (u.logoFileId && u.tokens) { try { const c = setUserOAuth(u.tokens); await google.drive({ version: 'v3', auth: c }).files.delete({ fileId: u.logoFileId }); } catch (e) {} }
    await db.collection('users').doc(req.session.user.id).update({ logoFileId: null, logoUrl: '', logoUrlAlt: '' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/logo', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); res.json({ ok: true, url: d.logoUrl || '', urlAlt: d.logoUrlAlt || '' }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.post('/api/upload-file', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || !filename) return res.json({ ok: false, error: 'Missing' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 4.5 * 1024 * 1024) return res.json({ ok: false, error: 'Max 4.5MB' });
    const u = await getUserData(req.session.user.id);
    const client = setUserOAuth(u.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const up = await drive.files.create({ requestBody: { name: filename, mimeType: mimeType || 'application/octet-stream' }, media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buf) }, fields: 'id,name,size,mimeType' });
    const fd = { driveId: up.data.id, name: up.data.name, mimeType: up.data.mimeType, size: up.data.size || buf.length, uploadedAt: new Date() };
    const doc = await db.collection('users').doc(req.session.user.id).collection('files').add(fd);
    res.json({ ok: true, file: { id: doc.id, ...fd } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/files', authRequired, async (req, res) => { try { const s = await db.collection('users').doc(req.session.user.id).collection('files').orderBy('uploadedAt','desc').get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, files: l }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.delete('/api/files/:id', authRequired, async (req, res) => {
  try {
    const f = await db.collection('users').doc(req.session.user.id).collection('files').doc(req.params.id).get();
    if (!f.exists) return res.json({ ok: false });
    const u = await getUserData(req.session.user.id);
    const c = setUserOAuth(u.tokens);
    try { await google.drive({ version: 'v3', auth: c }).files.delete({ fileId: f.data().driveId }); } catch (e) {}
    await f.ref.delete(); res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/templates', authRequired, async (req, res) => { try { const s = await db.collection('users').doc(req.session.user.id).collection('templates').get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, templates: l }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/templates', authRequired, async (req, res) => {
  try {
    const { id, name, subject, body } = req.body;
    if (!name || !subject || !body) return res.json({ ok: false, error: 'Required' });
    const ref = db.collection('users').doc(req.session.user.id).collection('templates');
    if (id) { await ref.doc(id).set({ name, subject, body, updatedAt: new Date() }); res.json({ ok: true, id }); }
    else { const d = await ref.add({ name, subject, body, createdAt: new Date() }); res.json({ ok: true, id: d.id }); }
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/templates/:id', authRequired, async (req, res) => { try { await db.collection('users').doc(req.session.user.id).collection('templates').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get('/api/recipients', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const { status, search, range } = req.query;
    let q = db.collection('users').doc(uid).collection('recipients');
    if (status && status !== 'all') q = q.where('status', '==', status);
    if (range && range !== 'all') {
      const n = new Date(); let f;
      if (range === 'today') f = new Date(n.setHours(0,0,0,0));
      else if (range === '7d') f = new Date(Date.now() - 7*24*60*60*1000);
      else if (range === '30d') f = new Date(Date.now() - 30*24*60*60*1000);
      else if (range === '90d') f = new Date(Date.now() - 90*24*60*60*1000);
      if (f) q = q.where('createdAt', '>=', f);
    }
    q = q.orderBy('createdAt','desc').limit(1000);
    const s = await q.get();
    const ls = await db.collection('users').doc(uid).collection('emailLog').get();
    const c = {}; ls.forEach(d => { const r = d.data().recipientId; c[r] = (c[r]||0)+1; });
    let l = []; s.forEach(d => { const da = d.data(); l.push({ id: d.id, ...da, sendCount: c[d.id] || 0 }); });
    if (search) { const sq = search.toLowerCase(); l = l.filter(r => (r.email||'').toLowerCase().includes(sq) || (r.company||'').toLowerCase().includes(sq)); }
    res.json({ ok: true, recipients: l });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/recipients', authRequired, async (req, res) => {
  try {
    const { list, templateId } = req.body;
    if (!list || !list.length) return res.json({ ok: false, error: 'None' });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('recipients');
    let a = 0;
    for (const r of list) {
      if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) continue;
      const doc = ref.doc();
      batch.set(doc, { company: (r.company || '').trim(), email: r.email.toLowerCase(), templateId: templateId || '', status: 'Pending', sentAt: null, openedAt: null, createdAt: new Date() });
      a++;
    }
    await batch.commit();
    res.json({ ok: true, added: a });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/recipients/:id', authRequired, async (req, res) => { try { await db.collection('users').doc(req.session.user.id).collection('recipients').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/recipients/bulk-delete', authRequired, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    const b = db.batch();
    const r = db.collection('users').doc(req.session.user.id).collection('recipients');
    ids.forEach(id => b.delete(r.doc(id)));
    await b.commit();
    res.json({ ok: true, deleted: ids.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/my-emails', authRequired, async (req, res) => {
  try {
    const { range, search } = req.query;
    let q = db.collection('users').doc(req.session.user.id).collection('emailLog').orderBy('sentAt','desc');
    if (range && range !== 'all') {
      const n = new Date(); let f;
      if (range === 'today') f = new Date(n.setHours(0,0,0,0));
      else if (range === '7d') f = new Date(Date.now() - 7*24*60*60*1000);
      else if (range === '30d') f = new Date(Date.now() - 30*24*60*60*1000);
      else if (range === '90d') f = new Date(Date.now() - 90*24*60*60*1000);
      if (f) q = q.where('sentAt', '>=', f);
    }
    q = q.limit(1000);
    const s = await q.get();
    let l = []; s.forEach(d => l.push({ id: d.id, ...d.data() }));
    if (search) { const sq = search.toLowerCase(); l = l.filter(e => (e.recipientEmail||'').toLowerCase().includes(sq) || (e.subject||'').toLowerCase().includes(sq) || (e.company||'').toLowerCase().includes(sq)); }
    res.json({ ok: true, emails: l });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

function encS(s) { return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function htmlToPlain(h) { return h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n\s*\n\s*\n/g, '\n\n').trim(); }
function buildMime(fn, fe, to, sub, h, atts) {
  const mB = 'm_' + crypto.randomBytes(8).toString('hex');
  const aB = 'a_' + crypto.randomBytes(8).toString('hex');
  const dom = fe.split('@')[1] || 'gmail.com';
  const mid = '<' + crypto.randomBytes(16).toString('hex') + '.' + Date.now() + '@' + dom + '>';
  const pt = htmlToPlain(h);
  const p = ['From: "' + fn.replace(/"/g, '') + '" <' + fe + '>', 'To: ' + to, 'Subject: ' + encS(sub), 'Date: ' + new Date().toUTCString(), 'Message-ID: ' + mid, 'MIME-Version: 1.0', 'X-Mailer: MailFlow Pro', 'List-Unsubscribe: <mailto:' + fe + '?subject=unsubscribe>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click', 'Precedence: bulk', 'X-Priority: 3', 'Importance: Normal'];
  if (atts && atts.length) {
    p.push('Content-Type: multipart/mixed; boundary="' + mB + '"', '', '--' + mB);
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(pt, 'utf8').toString('base64'), '');
    p.push('--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(h, 'utf8').toString('base64'), '', '--' + aB + '--', '');
    for (const a of atts) { p.push('--' + mB, 'Content-Type: ' + a.mimeType + '; name="' + a.filename + '"', 'Content-Disposition: attachment; filename="' + a.filename + '"', 'Content-Transfer-Encoding: base64', '', a.data, ''); }
    p.push('--' + mB + '--');
  } else {
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(pt, 'utf8').toString('base64'), '');
    p.push('--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(h, 'utf8').toString('base64'), '', '--' + aB + '--');
  }
  return Buffer.from(p.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function sendOne(userId, userEmail, recipientId, attachFiles, options) {
  options = options || {};
  const u = await getUserData(userId);
  if (!u.tokens) throw new Error('Expired');
  if (isQuietHours(u) && !options.force) { const e = new Error('QUIET_HOURS'); e.code = 'QUIET_HOURS'; e.quietEnd = u.quietEnd; throw e; }
  if (u.lastSendTime && !options.skipDelay) {
    const l = u.lastSendTime._seconds ? u.lastSendTime._seconds * 1000 : new Date(u.lastSendTime).getTime();
    const el = Date.now() - l; const mg = 8000 + Math.floor(Math.random() * 7000);
    if (el < mg) await sleep(mg - el);
  }
  const c = setUserOAuth(u.tokens);
  const g = google.gmail({ version: 'v1', auth: c });
  const r = await db.collection('users').doc(userId).collection('recipients').doc(recipientId).get();
  if (!r.exists) throw new Error('Not found');
  const rec = r.data();
  let t;
  if (rec.templateId) { const tt = await db.collection('users').doc(userId).collection('templates').doc(rec.templateId).get(); if (tt.exists) t = tt.data(); }
  if (!t) { const ts = await db.collection('users').doc(userId).collection('templates').limit(1).get(); if (!ts.empty) t = ts.docs[0].data(); }
  if (!t) throw new Error('No template');
  const sig = u.signature || '';
  const b = t.body.replace(/\n/g, '<br>');
  const sh = sig ? '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb;">' + sig + '</div>' : '';
  const full = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">' + b + sh + '</div>';
  const lp = localAnalysis(t.subject, full);
  const tok = crypto.randomBytes(16).toString('hex');
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ trackToken: tok });
  const tu = (process.env.BACKEND_URL || 'http://localhost:3000') + '/track/' + recipientId + '?u=' + userId + '&t=' + tok;
  const pix = '<img src="' + tu + '" width="1" height="1" alt="" style="border:0;outline:none;text-decoration:none;display:block;width:1px;height:1px">';
  const atts = [];
  if (attachFiles !== false) {
    const fs = await db.collection('users').doc(userId).collection('files').get();
    const dr = google.drive({ version: 'v3', auth: c });
    for (const fd of fs.docs) { const f = fd.data(); try { const r2 = await dr.files.get({ fileId: f.driveId, alt: 'media' }, { responseType: 'arraybuffer' }); atts.push({ filename: f.name, mimeType: f.mimeType || 'application/octet-stream', data: Buffer.from(r2.data).toString('base64') }); } catch (e) {} }
  }
  const raw = buildMime(u.name || 'MailFlow User', userEmail, rec.email, t.subject, full + pix, atts);
  await g.users.messages.send({ userId: 'me', requestBody: { raw } });
  await db.collection('users').doc(userId).collection('emailLog').add({ recipientId, recipientEmail: rec.email, company: rec.company || '', subject: t.subject, sentAt: new Date(), attachmentsCount: atts.length, aiPrediction: lp.prediction, aiScore: lp.score, aiInboxProb: lp.inboxProbability });
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ status: 'Sent', sentAt: new Date(), lastSentAt: new Date() });
  await db.collection('users').doc(userId).update({ lastSendTime: new Date() });
  const td = new Date().toISOString().split('T')[0];
  const sr = db.collection('users').doc(userId).collection('stats').doc(td);
  const sd = await sr.get();
  await sr.set({ sent: ((sd.exists ? sd.data().sent : 0) || 0) + 1, updatedAt: new Date() }, { merge: true });
  return rec.email;
}

app.post('/api/send', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false, { force: req.body.force === true, skipDelay: req.body.skipDelay === true }); res.json({ ok: true, email: e }); }
  catch (e) { if (e.code === 'QUIET_HOURS') return res.json({ ok: false, error: 'QUIET_HOURS', quietEnd: e.quietEnd }); res.json({ ok: false, error: e.message }); }
});
app.post('/api/resend', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false, { force: req.body.force === true, skipDelay: req.body.skipDelay === true }); res.json({ ok: true, email: e }); }
  catch (e) { if (e.code === 'QUIET_HOURS') return res.json({ ok: false, error: 'QUIET_HOURS', quietEnd: e.quietEnd }); res.json({ ok: false, error: e.message }); }
});

app.get('/track/:id', async (req, res) => {
  try { const u = req.query.u; const t = req.query.t; if (u && t) { const r = await db.collection('users').doc(u).collection('recipients').doc(req.params.id).get(); if (r.exists && r.data().trackToken === t) await db.collection('users').doc(u).collection('recipients').doc(req.params.id).update({ status: 'Opened', openedAt: new Date() }); } } catch (e) {}
  const px = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif'); res.send(px);
});

app.get('/api/signature', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); res.json({ ok: true, signature: d.signature || '', fields: d.sigFields || {} }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.post('/api/signature', authRequired, async (req, res) => { try { const u = { signature: req.body.signature || '' }; if (req.body.fields) u.sigFields = req.body.fields; await db.collection('users').doc(req.session.user.id).update(u); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); } });

app.get('/api/prefs', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, prefs: { quietEnabled: d.quietEnabled === true, quietStart: d.quietStart !== undefined ? d.quietStart : 22, quietEnd: d.quietEnd !== undefined ? d.quietEnd : 7, autoSend: d.autoSend === true, autoSendBatchSize: d.autoSendBatchSize !== undefined ? d.autoSendBatchSize : 5, appAccountId: d.appAccountId || '', totalAutoSent: d.totalAutoSent || 0 } }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/prefs', authRequired, async (req, res) => {
  try { const { quietEnabled, quietStart, quietEnd, autoSend, autoSendBatchSize } = req.body; let bs = Number(autoSendBatchSize); if (isNaN(bs) || bs < 1) bs = 5; if (bs > 100) bs = 100; await db.collection('users').doc(req.session.user.id).update({ quietEnabled: !!quietEnabled, quietStart: Number(quietStart), quietEnd: Number(quietEnd), autoSend: !!autoSend, autoSendBatchSize: bs, updatedAt: new Date() }); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const t = await db.collection('users').doc(uid).collection('recipients').count().get();
    const s = await db.collection('users').doc(uid).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get();
    const o = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Opened').count().get();
    const p = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').count().get();
    const ts = await db.collection('users').doc(uid).collection('emailLog').count().get();
    res.json({ ok: true, stats: { total: t.data().count, sent: s.data().count, opened: o.data().count, pending: p.data().count, totalSends: ts.data().count } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

async function runAutoSend(uid, ue, ud) {
  if (isQuietHours(ud)) return { skipped: true };
  const bs = Number(ud.autoSendBatchSize) || 5;
  const ps = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').limit(bs).get();
  if (ps.empty) return { sent: 0, failed: 0 };
  let s = 0, f = 0;
  for (const r of ps.docs) { try { await sendOne(uid, ue, r.id, true, { force: true }); s++; await sleep(10000 + Math.floor(Math.random() * 10000)); } catch (e) { f++; if (e.code === 'QUIET_HOURS') break; } }
  if (s > 0) await db.collection('users').doc(uid).update({ totalAutoSent: (ud.totalAutoSent || 0) + s, lastAutoSendRun: new Date() });
  return { sent: s, failed: f };
}

app.get('/api/cron/auto-send', async (req, res) => {
  try {
    const sec = req.query.secret || req.headers['x-cron-secret'];
    if (sec !== CRON_SECRET) return res.status(401).json({ ok: false });
    const us = await db.collection('users').where('autoSend', '==', true).get();
    let ts = 0, tu = 0, sk = 0, er = 0;
    for (const u of us.docs) { const d = u.data(); if (!d.tokens || !d.email) continue; try { const r = await runAutoSend(u.id, d.email, d); if (r.skipped) sk++; else if (r.sent > 0) { ts += r.sent; tu++; } } catch (e) { er++; } }
    res.json({ ok: true, totalSent: ts, totalUsers: tu, skipped: sk, errors: er });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/auto-send-check', authRequired, async (req, res) => {
  try {
    const u = await getUserData(req.session.user.id);
    if (!u || !u.autoSend) return res.json({ ok: true, skipped: true });
    const l = u.lastAutoSendRun ? new Date(u.lastAutoSendRun._seconds ? u.lastAutoSendRun._seconds * 1000 : u.lastAutoSendRun) : null;
    const hk = getCurrentHourKey();
    const lhk = l ? (l.toISOString().split('T')[0] + '-' + l.getHours()) : null;
    if (lhk === hk) return res.json({ ok: true, skipped: true });
    const r = await runAutoSend(req.session.user.id, req.session.user.email, u);
    res.json({ ok: true, ...r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/admin/dashboard', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const users = [];
    let tE = 0, tS = 0, tO = 0, tP = 0, tSd = 0;
    for (const u of us.docs) {
      const d = u.data();
      const t = await db.collection('users').doc(u.id).collection('recipients').count().get();
      const s = await db.collection('users').doc(u.id).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get();
      const o = await db.collection('users').doc(u.id).collection('recipients').where('status', '==', 'Opened').count().get();
      const p = await db.collection('users').doc(u.id).collection('recipients').where('status', '==', 'Pending').count().get();
      const sd = await db.collection('users').doc(u.id).collection('emailLog').count().get();
      const tc = t.data().count, sc = s.data().count, oc = o.data().count, pc = p.data().count, sdc = sd.data().count;
      tE += tc; tS += sc; tO += oc; tP += pc; tSd += sdc;
      users.push({ id: u.id, email: d.email, name: d.name, picture: d.picture || '', appAccountId: d.appAccountId || 'N/A', autoSend: !!d.autoSend, totalAutoSent: d.totalAutoSent || 0, createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : '', hasSignature: !!d.signature, hasLogo: !!d.logoUrl, total: tc, sent: sc, opened: oc, pending: pc, totalSends: sdc });
    }
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, users, stats: { totalUsers: users.length, totalEmails: tE, totalSent: tS, totalOpened: tO, totalPending: tP, totalSends: tSd } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/user/:id/emails', adminRequired, async (req, res) => { try { const s = await db.collection('users').doc(req.params.id).collection('emailLog').orderBy('sentAt','desc').limit(500).get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, emails: l }); } catch (e) { res.json({ ok: false, error: e.message }); } });
app.get('/api/admin/all-emails', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const all = [];
    for (const u of us.docs) { const d = u.data(); const es = await db.collection('users').doc(u.id).collection('emailLog').orderBy('sentAt','desc').limit(500).get(); es.forEach(e => { const dd = e.data(); all.push({ id: e.id, userId: u.id, userEmail: d.email, userAppId: d.appAccountId || 'N/A', recipientEmail: dd.recipientEmail, company: dd.company || '', subject: dd.subject || '', sentAt: dd.sentAt, attachmentsCount: dd.attachmentsCount || 0 }); }); }
    all.sort((a, b) => { const ta = a.sentAt?._seconds || 0; const tb = b.sentAt?._seconds || 0; return tb - ta; });
    res.json({ ok: true, emails: all.slice(0, 1000) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/auth') && !req.path.startsWith('/track')) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  next();
});

if (process.env.VERCEL) module.exports = app;
else app.listen(PORT, () => console.log('Server on port ' + PORT));