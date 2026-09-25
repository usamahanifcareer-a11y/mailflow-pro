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

// ==================== MULTI-AI: GROQ → GEMINI → MISTRAL ====================
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';

async function callGroq(prompt) {
  if (!GROQ_KEY) throw new Error('No Groq key');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500
    })
  });
  if (!res.ok) throw new Error('Groq HTTP ' + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callGemini(prompt) {
  if (!GEMINI_KEY) throw new Error('No Gemini key');
  const client = new GoogleGenerativeAI(GEMINI_KEY);
  const model = client.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

async function callMistral(prompt) {
  if (!MISTRAL_KEY) throw new Error('No Mistral key');
  const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + MISTRAL_KEY },
    body: JSON.stringify({
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 1500
    })
  });
  if (!res.ok) throw new Error('Mistral HTTP ' + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

async function callAI(prompt) {
  // Order: Groq (fastest) → Gemini (best quality) → Mistral (backup)
  const providers = [
    { name: 'Groq', fn: callGroq },
    { name: 'Gemini', fn: callGemini },
    { name: 'Mistral', fn: callMistral }
  ];
  let lastError;
  for (const p of providers) {
    try {
      const text = await p.fn(prompt);
      console.log('AI provider: ' + p.name);
      return text;
    } catch (err) {
      console.error(p.name + ' failed:', err.message);
      lastError = err;
    }
  }
  throw lastError || new Error('All AI providers failed');
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
function generateAppAccountId() { const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let id = 'MFP-'; for (let i = 0; i < 6; i++) id += chars.charAt(Math.floor(Math.random() * chars.length)); return id; }
function isQuietHours(prefs) { if (!prefs || !prefs.quietEnabled) return false; const now = new Date().getHours(); const start = Number(prefs.quietStart); const end = Number(prefs.quietEnd); if (isNaN(start) || isNaN(end) || start === end) return false; if (start < end) return now >= start && now < end; return now >= start || now < end; }
function getCurrentHourKey() { const now = new Date(); return now.toISOString().split('T')[0] + '-' + now.getHours(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/api/health', (req, res) => res.json({ ok: true, vercel: IS_VERCEL, firebase: !!serviceAccount.project_id, ai: { groq: !!GROQ_KEY, gemini: !!GEMINI_KEY, mistral: !!MISTRAL_KEY } }));

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
  } catch (err) { console.error('OAuth error:', err.message); res.redirect((process.env.FRONTEND_URL || 'http://localhost:3000') + '?login=error'); }
});

app.get('/api/me', async (req, res) => {
  if (req.session && req.session.user) {
    if (!req.session.user.appAccountId) { const d = await getUserData(req.session.user.id); if (d && d.appAccountId) req.session.user.appAccountId = d.appAccountId; }
    res.json({ ok: true, user: req.session.user });
  } else res.json({ ok: false });
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/quiet-status', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); const inQuiet = isQuietHours(d); res.json({ ok: true, inQuiet, quietEnd: d.quietEnd }); } catch (err) { res.json({ ok: false, error: err.message }); } });

app.get('/api/quota', authRequired, async (req, res) => {
  try {
    const userDoc = await getUserData(req.session.user.id);
    if (!userDoc || !userDoc.tokens) return res.json({ ok: false, error: 'Session expired' });
    const client = setUserOAuth(userDoc.tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const oneDayAgo = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    let sentToday = 0;
    try {
      const response = await gmail.users.messages.list({ userId: 'me', q: `in:sent after:${oneDayAgo}`, maxResults: 500 });
      sentToday = response.data.resultSizeEstimate || (response.data.messages ? response.data.messages.length : 0);
    } catch (gErr) { const today = new Date().toISOString().split('T')[0]; const sd = await db.collection('users').doc(req.session.user.id).collection('stats').doc(today).get(); sentToday = sd.exists ? (sd.data().sent || 0) : 0; }
    res.json({ ok: true, sentToday, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - sentToday) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ==================== AI: LIVE ANALYSIS ====================
app.post('/api/ai/analyze-live', authRequired, async (req, res) => {
  try {
    const { subject, body } = req.body;
    const hasSubject = subject && subject.trim().length > 0;
    const hasBody = body && body.trim().length > 0;
    if (!hasSubject && !hasBody) return res.json({ ok: true, empty: true });
    try {
      const userDoc = await getUserData(req.session.user.id);
      const hasLogo = !!(userDoc && userDoc.logoUrl);
      const cleanBody = (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1500);
      const linkCount = (body.match(/https?:\/\//g) || []).length;
      const wordCount = cleanBody.split(/\s+/).filter(w => w).length;
      const prompt = `You are an elite email deliverability expert. Analyze this DRAFT. Return ONLY valid JSON, no markdown.
DRAFT:
- Subject: "${(subject || '').substring(0, 200)}"
- Body: "${cleanBody}"
- Words: ${wordCount}, Links: ${linkCount}, Logo: ${hasLogo ? 'yes' : 'no'}
Return JSON: {"score":0-100,"prediction":"EXCELLENT"|"GOOD"|"RISKY"|"SPAM","inboxProbability":0-100,"tone":"string","issues":[{"type":"string","severity":"low"|"medium"|"high","message":"string"}],"suggestions":["string"],"emotionalTone":"string","readability":0-100}
Rules: score <= 15 EXCELLENT, 16-40 GOOD, 41-70 RISKY, 71+ SPAM. Return ONLY JSON.`;
      const text = await callAI(prompt);
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text);
      res.json({ ok: true, ...parsed, aiPowered: true });
    } catch (aiErr) { console.error('AI failed:', aiErr.message); res.json({ ok: true, ...localAnalysis(subject, body), aiPowered: false }); }
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

function localAnalysis(subject, body) {
  const SPAM_WORDS = ['free','guarantee','act now','click here','limited time','buy now','cash','prize','urgent','risk-free','earn money','work from home','make money','no cost','no fees'];
  const text = ((subject||'') + ' ' + (body||'')).toLowerCase();
  const found = SPAM_WORDS.filter(w => text.includes(w));
  const linkCount = (body.match(/https?:\/\//g) || []).length;
  const hasExclamation = ((subject.match(/!/g) || []).length) > 1;
  const isAllCaps = subject === subject.toUpperCase() && subject.length > 5;
  const cleanBody = (body || '').replace(/<[^>]+>/g, ' ').trim();
  const wordCount = cleanBody.split(/\s+/).filter(w => w).length;
  const issues = [];
  if (found.length) issues.push({ type: 'spam_words', severity: 'high', message: 'Contains: ' + found.slice(0,3).join(', ') });
  if (linkCount > 2) issues.push({ type: 'links', severity: 'medium', message: linkCount + ' links found' });
  if (hasExclamation) issues.push({ type: 'caps', severity: 'low', message: 'Multiple exclamation marks' });
  if (isAllCaps) issues.push({ type: 'caps', severity: 'high', message: 'Subject in ALL CAPS' });
  if (wordCount < 20 && wordCount > 0) issues.push({ type: 'short', severity: 'medium', message: 'Body too short' });
  const score = Math.min(100, found.length * 20 + (linkCount > 2 ? 15 : 0) + (hasExclamation ? 10 : 0) + (isAllCaps ? 25 : 0) + (wordCount < 20 && wordCount > 0 ? 15 : 0));
  const inboxProbability = 100 - score;
  const prediction = score <= 15 ? 'EXCELLENT' : score <= 40 ? 'GOOD' : score <= 70 ? 'RISKY' : 'SPAM';
  const suggestions = [];
  if (found.length) suggestions.push('Remove trigger words: ' + found.slice(0,2).join(', '));
  if (linkCount > 2) suggestions.push('Reduce links to 2 max');
  if (isAllCaps) suggestions.push('Write subject in normal case');
  if (wordCount < 20 && wordCount > 0) suggestions.push('Add more context (20+ words recommended)');
  if (suggestions.length === 0) suggestions.push('Content looks good!');
  return { score, prediction, inboxProbability, issues, suggestions, tone: 'professional', readability: 75, emotionalTone: 'neutral' };
}

app.post('/api/ai/write-email', authRequired, async (req, res) => {
  try {
    const { context, recipientName, recipientCompany, tone, length } = req.body;
    if (!context) return res.json({ ok: false, error: 'Please provide context' });
    const toneMap = { formal: 'professional and formal', friendly: 'warm and friendly', casual: 'casual and conversational', persuasive: 'persuasive and confident' };
    const lengthMap = { short: 'under 80 words', medium: 'between 100-150 words', long: 'between 200-250 words' };
    const prompt = `You are an elite email copywriter. Write a professional email. Return ONLY valid JSON.
CONTEXT: ${context}
RECIPIENT: ${recipientName || 'unknown'}
COMPANY: ${recipientCompany || 'unknown'}
TONE: ${toneMap[tone] || toneMap.formal}
LENGTH: ${lengthMap[length] || lengthMap.medium}
Requirements: natural human-like, no spam words, personalized, clear purpose, strong closing. Plain text with \\n\\n line breaks.
Return JSON: {"subject":"under 60 chars","body":"with \\n\\n breaks","tone":"string","wordCount":number,"keyPoints":["point"]}`;
    const text = await callAI(prompt);
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    res.json({ ok: true, ...parsed });
  } catch (err) { res.json({ ok: false, error: 'AI limit reached. Try again.' }); }
});

app.post('/api/ai/generate-subjects', authRequired, async (req, res) => {
  try {
    const { context } = req.body;
    const prompt = `Generate 5 professional email subject lines. Return ONLY JSON.
CONTEXT: ${context || 'professional outreach'}
Rules: max 60 chars, no ALL CAPS, no spam words, vary styles.
Return: {"subjects":["s1","s2","s3","s4","s5"]}`;
    const text = await callAI(prompt);
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    res.json({ ok: true, subjects: parsed.subjects || [] });
  } catch (err) { res.json({ ok: false, error: 'AI limit reached. Try later.' }); }
});

app.post('/api/ai/improve-email', authRequired, async (req, res) => {
  try {
    const { subject, body } = req.body;
    const prompt = `Improve this email for better inbox placement. Return ONLY JSON.
SUBJECT: "${subject || ''}"
BODY: "${(body||'').substring(0, 1000)}"
Return JSON: {"improvedSubject":"...","improvedBody":"...","changes":["c1"],"beforeScore":0-100,"afterScore":0-100}`;
    const text = await callAI(prompt);
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    res.json({ ok: true, ...parsed });
  } catch (err) { res.json({ ok: false, error: 'AI limit reached. Try later.' }); }
});

app.get('/api/ai/best-time', authRequired, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const snap = await db.collection('users').doc(userId).collection('emailLog').orderBy('sentAt', 'desc').limit(100).get();
    const hourStats = {};
    snap.forEach(d => { const data = d.data(); const sentMs = data.sentAt?._seconds ? data.sentAt._seconds * 1000 : new Date(data.sentAt).getTime(); const hour = new Date(sentMs).getHours(); if (!hourStats[hour]) hourStats[hour] = { sent: 0, opened: 0 }; hourStats[hour].sent++; });
    const rSnap = await db.collection('users').doc(userId).collection('recipients').where('status', '==', 'Opened').get();
    rSnap.forEach(d => { const data = d.data(); if (data.openedAt) { const ms = data.openedAt._seconds ? data.openedAt._seconds * 1000 : new Date(data.openedAt).getTime(); const hour = new Date(ms).getHours(); if (!hourStats[hour]) hourStats[hour] = { sent: 0, opened: 0 }; hourStats[hour].opened = (hourStats[hour].opened || 0) + 1; } });
    try {
      const history = Object.entries(hourStats).map(([h, s]) => `Hour ${h}: sent=${s.sent}, opened=${s.opened || 0}`).join('\n');
      const prompt = `Recommend 3 best sending hours (0-23) for highest open rate. Return ONLY JSON.\nHISTORY:\n${history || 'No data yet'}\nReturn: {"bestHours":[h1,h2,h3],"reasoning":"short"}`;
      const text = await callAI(prompt);
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text);
      res.json({ ok: true, ...parsed });
    } catch (aiErr) { res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default business hours' }); }
  } catch (err) { res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default' }); }
});

app.post('/api/ai/analyze-replies', authRequired, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const user = await getUserData(userId);
    if (!user.tokens) return res.json({ ok: false, error: 'Session expired' });
    const client = setUserOAuth(user.tokens);
    const gmail = google.gmail({ version: 'v1', auth: client });
    const since = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    const list = await gmail.users.messages.list({ userId: 'me', q: `in:inbox after:${since}`, maxResults: 15 });
    if (!list.data.messages || !list.data.messages.length) return res.json({ ok: true, replies: [] });
    const replies = [];
    for (const msg of list.data.messages.slice(0, 10)) {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = full.data.payload.headers;
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        let bodyText = '';
        const extract = (parts) => { for (const p of parts || []) { if (p.mimeType === 'text/plain' && p.body?.data) bodyText += Buffer.from(p.body.data, 'base64').toString(); else if (p.parts) extract(p.parts); } };
        if (full.data.payload.body?.data) bodyText = Buffer.from(full.data.payload.body.data, 'base64').toString(); else extract(full.data.payload.parts);
        bodyText = bodyText.substring(0, 600);
        replies.push({ id: msg.id, from, subject, bodyPreview: bodyText });
      } catch (e) {}
    }
    if (!replies.length) return res.json({ ok: true, replies: [] });
    try {
      const prompt = `Categorize these email replies. Return ONLY JSON.\n${replies.map((r, i) => `[${i}] From: ${r.from}\nSubject: ${r.subject}\nBody: ${r.bodyPreview}`).join('\n\n')}\nReturn JSON: {"categories":[{"index":0,"type":"INTERESTED"|"NOT_INTERESTED"|"AUTO_REPLY"|"QUESTION"|"SPAM"|"MEETING_REQUEST"|"OTHER","sentiment":"POSITIVE"|"NEUTRAL"|"NEGATIVE","summary":"line","actionSuggestion":"string"}]}`;
      const text = await callAI(prompt);
      const match = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : text);
      const enriched = replies.map((r, i) => { const cat = (parsed.categories || []).find(c => c.index === i) || {}; return { ...r, category: cat.type || 'OTHER', sentiment: cat.sentiment || 'NEUTRAL', summary: cat.summary || '', actionSuggestion: cat.actionSuggestion || '' }; });
      res.json({ ok: true, replies: enriched });
    } catch (aiErr) { res.json({ ok: false, error: 'AI limit reached. Try later.' }); }
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// LOGO
app.post('/api/upload-logo', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64) return res.json({ ok: false, error: 'No image data' });
    const allowed = ['image/png','image/jpeg','image/jpg','image/gif','image/svg+xml','image/webp'];
    if (!allowed.includes(mimeType)) return res.json({ ok: false, error: 'Only PNG/JPG/GIF/SVG/WEBP allowed' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.json({ ok: false, error: 'Maximum size is 2MB' });
    const userDoc = await getUserData(req.session.user.id);
    if (!userDoc.tokens) return res.json({ ok: false, error: 'Session expired' });
    const client = setUserOAuth(userDoc.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    if (userDoc.logoFileId) { try { await drive.files.delete({ fileId: userDoc.logoFileId }); } catch (e) {} }
    const uploaded = await drive.files.create({ requestBody: { name: filename || 'logo', mimeType }, media: { mimeType, body: Readable.from(buf) }, fields: 'id' });
    const fileId = uploaded.data.id;
    try { await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } }); } catch (e) {}
    const url = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w500';
    const urlAlt = 'https://lh3.googleusercontent.com/d/' + fileId;
    await db.collection('users').doc(req.session.user.id).update({ logoFileId: fileId, logoUrl: url, logoUrlAlt: urlAlt });
    res.json({ ok: true, url, urlAlt, fileId });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/remove-logo', authRequired, async (req, res) => {
  try {
    const userDoc = await getUserData(req.session.user.id);
    if (userDoc.logoFileId && userDoc.tokens) { try { const client = setUserOAuth(userDoc.tokens); await google.drive({ version: 'v3', auth: client }).files.delete({ fileId: userDoc.logoFileId }); } catch (e) {} }
    await db.collection('users').doc(req.session.user.id).update({ logoFileId: null, logoUrl: '', logoUrlAlt: '' });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/logo', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); res.json({ ok: true, url: d.logoUrl || '', urlAlt: d.logoUrlAlt || '' }); } catch (err) { res.json({ ok: false, error: err.message }); } });

// FILES
app.post('/api/upload-file', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || !filename) return res.json({ ok: false, error: 'Missing data' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 4.5 * 1024 * 1024) return res.json({ ok: false, error: 'File too large. Max 4.5MB' });
    const userDoc = await getUserData(req.session.user.id);
    const client = setUserOAuth(userDoc.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const uploaded = await drive.files.create({ requestBody: { name: filename, mimeType: mimeType || 'application/octet-stream' }, media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buf) }, fields: 'id,name,size,mimeType' });
    const fd = { driveId: uploaded.data.id, name: uploaded.data.name, mimeType: uploaded.data.mimeType, size: uploaded.data.size || buf.length, uploadedAt: new Date() };
    const doc = await db.collection('users').doc(req.session.user.id).collection('files').add(fd);
    res.json({ ok: true, file: { id: doc.id, ...fd } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/files', authRequired, async (req, res) => { try { const s = await db.collection('users').doc(req.session.user.id).collection('files').orderBy('uploadedAt','desc').get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, files: l }); } catch (err) { res.json({ ok: false, error: err.message }); } });

app.delete('/api/files/:id', authRequired, async (req, res) => {
  try {
    const fDoc = await db.collection('users').doc(req.session.user.id).collection('files').doc(req.params.id).get();
    if (!fDoc.exists) return res.json({ ok: false });
    const userDoc = await getUserData(req.session.user.id);
    const client = setUserOAuth(userDoc.tokens);
    try { await google.drive({ version: 'v3', auth: client }).files.delete({ fileId: fDoc.data().driveId }); } catch (e) {}
    await fDoc.ref.delete();
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// TEMPLATES
app.get('/api/templates', authRequired, async (req, res) => { try { const s = await db.collection('users').doc(req.session.user.id).collection('templates').get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, templates: l }); } catch (err) { res.json({ ok: false, error: err.message }); } });

app.post('/api/templates', authRequired, async (req, res) => {
  try {
    const { id, name, subject, body } = req.body;
    if (!name || !subject || !body) return res.json({ ok: false, error: 'All fields required' });
    const ref = db.collection('users').doc(req.session.user.id).collection('templates');
    if (id) { await ref.doc(id).set({ name, subject, body, updatedAt: new Date() }); res.json({ ok: true, id }); }
    else { const d = await ref.add({ name, subject, body, createdAt: new Date() }); res.json({ ok: true, id: d.id }); }
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.delete('/api/templates/:id', authRequired, async (req, res) => { try { await db.collection('users').doc(req.session.user.id).collection('templates').doc(req.params.id).delete(); res.json({ ok: true }); } catch (err) { res.json({ ok: false, error: err.message }); } });

// RECIPIENTS
app.get('/api/recipients', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const { status, search, range } = req.query;
    let query = db.collection('users').doc(uid).collection('recipients');
    if (status && status !== 'all') query = query.where('status', '==', status);
    if (range && range !== 'all') {
      const now = new Date(); let fromDate;
      if (range === 'today') fromDate = new Date(now.setHours(0,0,0,0));
      else if (range === '7d') fromDate = new Date(Date.now() - 7*24*60*60*1000);
      else if (range === '30d') fromDate = new Date(Date.now() - 30*24*60*60*1000);
      else if (range === '90d') fromDate = new Date(Date.now() - 90*24*60*60*1000);
      if (fromDate) query = query.where('createdAt', '>=', fromDate);
    }
    query = query.orderBy('createdAt','desc').limit(1000);
    const snap = await query.get();
    const logSnap = await db.collection('users').doc(uid).collection('emailLog').get();
    const counts = {};
    logSnap.forEach(d => { const rid = d.data().recipientId; counts[rid] = (counts[rid]||0)+1; });
    let list = [];
    snap.forEach(d => { const data = d.data(); list.push({ id: d.id, ...data, sendCount: counts[d.id] || 0 }); });
    if (search) { const q = search.toLowerCase(); list = list.filter(r => (r.email||'').toLowerCase().includes(q) || (r.company||'').toLowerCase().includes(q)); }
    res.json({ ok: true, recipients: list });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/recipients', authRequired, async (req, res) => {
  try {
    const { list, templateId } = req.body;
    if (!list || !list.length) return res.json({ ok: false, error: 'No recipients provided' });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('recipients');
    let added = 0;
    for (const r of list) {
      if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) continue;
      const doc = ref.doc();
      batch.set(doc, { company: (r.company || '').trim(), email: r.email.toLowerCase(), templateId: templateId || '', status: 'Pending', sentAt: null, openedAt: null, createdAt: new Date() });
      added++;
    }
    await batch.commit();
    res.json({ ok: true, added });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.delete('/api/recipients/:id', authRequired, async (req, res) => { try { await db.collection('users').doc(req.session.user.id).collection('recipients').doc(req.params.id).delete(); res.json({ ok: true }); } catch (err) { res.json({ ok: false, error: err.message }); } });

app.post('/api/recipients/bulk-delete', authRequired, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('recipients');
    ids.forEach(id => batch.delete(ref.doc(id)));
    await batch.commit();
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// EMAIL LOG
app.get('/api/my-emails', authRequired, async (req, res) => {
  try {
    const { range, search } = req.query;
    let query = db.collection('users').doc(req.session.user.id).collection('emailLog').orderBy('sentAt','desc');
    if (range && range !== 'all') {
      const now = new Date(); let fromDate;
      if (range === 'today') fromDate = new Date(now.setHours(0,0,0,0));
      else if (range === '7d') fromDate = new Date(Date.now() - 7*24*60*60*1000);
      else if (range === '30d') fromDate = new Date(Date.now() - 30*24*60*60*1000);
      else if (range === '90d') fromDate = new Date(Date.now() - 90*24*60*60*1000);
      if (fromDate) query = query.where('sentAt', '>=', fromDate);
    }
    query = query.limit(1000);
    const s = await query.get();
    let l = []; s.forEach(d => l.push({ id: d.id, ...d.data() }));
    if (search) { const q = search.toLowerCase(); l = l.filter(e => (e.recipientEmail||'').toLowerCase().includes(q) || (e.subject||'').toLowerCase().includes(q) || (e.company||'').toLowerCase().includes(q)); }
    res.json({ ok: true, emails: l });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// MIME
function encSubject(s) { return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function htmlToPlain(html) { return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n\s*\n\s*\n/g, '\n\n').trim(); }
function buildMime(fromName, fromEmail, to, subject, html, attachments) {
  const mB = 'mixed_' + crypto.randomBytes(8).toString('hex');
  const aB = 'alt_' + crypto.randomBytes(8).toString('hex');
  const domain = fromEmail.split('@')[1] || 'gmail.com';
  const msgId = '<' + crypto.randomBytes(16).toString('hex') + '.' + Date.now() + '@' + domain + '>';
  const plainText = htmlToPlain(html);
  const p = ['From: "' + fromName.replace(/"/g, '') + '" <' + fromEmail + '>', 'To: ' + to, 'Subject: ' + encSubject(subject), 'Date: ' + new Date().toUTCString(), 'Message-ID: ' + msgId, 'MIME-Version: 1.0', 'X-Mailer: MailFlow Pro', 'List-Unsubscribe: <mailto:' + fromEmail + '?subject=unsubscribe>', 'List-Unsubscribe-Post: List-Unsubscribe=One-Click', 'Precedence: bulk', 'X-Priority: 3', 'Importance: Normal'];
  if (attachments && attachments.length) {
    p.push('Content-Type: multipart/mixed; boundary="' + mB + '"', '', '--' + mB);
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plainText, 'utf8').toString('base64'), '');
    p.push('--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), '', '--' + aB + '--', '');
    for (const att of attachments) { p.push('--' + mB, 'Content-Type: ' + att.mimeType + '; name="' + att.filename + '"', 'Content-Disposition: attachment; filename="' + att.filename + '"', 'Content-Transfer-Encoding: base64', '', att.data, ''); }
    p.push('--' + mB + '--');
  } else {
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(plainText, 'utf8').toString('base64'), '');
    p.push('--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), '', '--' + aB + '--');
  }
  return Buffer.from(p.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

// SEND
async function sendOne(userId, userEmail, recipientId, attachFiles, options) {
  options = options || {};
  const userDoc = await getUserData(userId);
  if (!userDoc.tokens) throw new Error('Session expired. Please login again.');
  const inQuiet = isQuietHours(userDoc);
  if (inQuiet && !options.force) { const err = new Error('QUIET_HOURS'); err.code = 'QUIET_HOURS'; err.quietEnd = userDoc.quietEnd; throw err; }
  if (userDoc.lastSendTime && !options.skipDelay) {
    const last = userDoc.lastSendTime._seconds ? userDoc.lastSendTime._seconds * 1000 : new Date(userDoc.lastSendTime).getTime();
    const elapsed = Date.now() - last;
    const minGap = 8000 + Math.floor(Math.random() * 7000);
    if (elapsed < minGap) await sleep(minGap - elapsed);
  }
  const client = setUserOAuth(userDoc.tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const rDoc = await db.collection('users').doc(userId).collection('recipients').doc(recipientId).get();
  if (!rDoc.exists) throw new Error('Recipient not found');
  const rec = rDoc.data();
  let tpl;
  if (rec.templateId) { const t = await db.collection('users').doc(userId).collection('templates').doc(rec.templateId).get(); if (t.exists) tpl = t.data(); }
  if (!tpl) { const tS = await db.collection('users').doc(userId).collection('templates').limit(1).get(); if (!tS.empty) tpl = tS.docs[0].data(); }
  if (!tpl) throw new Error('No email template found. Please create one first.');
  const sig = userDoc.signature || '';
  const body = tpl.body.replace(/\n/g, '<br>');
  const sigH = sig ? '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb;">' + sig + '</div>' : '';
  const full = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">' + body + sigH + '</div>';

  let aiPrediction = null;
  try {
    const cleanBody = full.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 800);
    const prompt = `Rate this email for spam risk. Return ONLY JSON: {"score":0-100,"prediction":"EXCELLENT"|"GOOD"|"RISKY"|"SPAM","inboxProbability":0-100}\nSUBJECT: "${tpl.subject}"\nBODY: "${cleanBody}"`;
    const text = await callAI(prompt);
    const match = text.match(/\{[\s\S]*\}/);
    aiPrediction = JSON.parse(match ? match[0] : text);
  } catch (e) { aiPrediction = { score: 20, prediction: 'GOOD', inboxProbability: 80 }; }
  if (!aiPrediction) aiPrediction = { score: 20, prediction: 'GOOD', inboxProbability: 80 };

  const trackToken = crypto.randomBytes(16).toString('hex');
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ trackToken });
  const tUrl = (process.env.BACKEND_URL || 'http://localhost:3000') + '/track/' + recipientId + '?u=' + userId + '&t=' + trackToken;
  const pixel = '<img src="' + tUrl + '" width="1" height="1" alt="" style="border:0;outline:none;text-decoration:none;display:block;width:1px;height:1px">';
  const attachments = [];
  if (attachFiles !== false) {
    const fS = await db.collection('users').doc(userId).collection('files').get();
    const drive = google.drive({ version: 'v3', auth: client });
    for (const fD of fS.docs) { const f = fD.data(); try { const fd = await drive.files.get({ fileId: f.driveId, alt: 'media' }, { responseType: 'arraybuffer' }); attachments.push({ filename: f.name, mimeType: f.mimeType || 'application/octet-stream', data: Buffer.from(fd.data).toString('base64') }); } catch (e) {} }
  }
  const raw = buildMime(userDoc.name || 'MailFlow User', userEmail, rec.email, tpl.subject, full + pixel, attachments);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  await db.collection('users').doc(userId).collection('emailLog').add({ recipientId, recipientEmail: rec.email, company: rec.company || '', subject: tpl.subject, sentAt: new Date(), attachmentsCount: attachments.length, aiPrediction: aiPrediction.prediction || 'GOOD', aiScore: aiPrediction.score || 20, aiInboxProb: aiPrediction.inboxProbability || 80 });
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ status: 'Sent', sentAt: new Date(), lastSentAt: new Date() });
  await db.collection('users').doc(userId).update({ lastSendTime: new Date() });
  const today = new Date().toISOString().split('T')[0];
  const sRef = db.collection('users').doc(userId).collection('stats').doc(today);
  const sDoc = await sRef.get();
  await sRef.set({ sent: ((sDoc.exists ? sDoc.data().sent : 0) || 0) + 1, updatedAt: new Date() }, { merge: true });
  return rec.email;
}

app.post('/api/send', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false, { force: req.body.force === true, skipDelay: req.body.skipDelay === true }); res.json({ ok: true, email: e }); }
  catch (err) { if (err.code === 'QUIET_HOURS') return res.json({ ok: false, error: 'QUIET_HOURS', quietEnd: err.quietEnd }); res.json({ ok: false, error: err.message }); }
});

app.post('/api/resend', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false, { force: req.body.force === true, skipDelay: req.body.skipDelay === true }); res.json({ ok: true, email: e }); }
  catch (err) { if (err.code === 'QUIET_HOURS') return res.json({ ok: false, error: 'QUIET_HOURS', quietEnd: err.quietEnd }); res.json({ ok: false, error: err.message }); }
});

app.get('/track/:id', async (req, res) => {
  try { const uid = req.query.u; const token = req.query.t; if (uid && token) { const rDoc = await db.collection('users').doc(uid).collection('recipients').doc(req.params.id).get(); if (rDoc.exists && rDoc.data().trackToken === token) await db.collection('users').doc(uid).collection('recipients').doc(req.params.id).update({ status: 'Opened', openedAt: new Date() }); } } catch (e) {}
  const px = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif'); res.send(px);
});

app.get('/api/signature', authRequired, async (req, res) => { try { const d = await getUserData(req.session.user.id); res.json({ ok: true, signature: d.signature || '', fields: d.sigFields || {} }); } catch (err) { res.json({ ok: false, error: err.message }); } });
app.post('/api/signature', authRequired, async (req, res) => { try { const upd = { signature: req.body.signature || '' }; if (req.body.fields) upd.sigFields = req.body.fields; await db.collection('users').doc(req.session.user.id).update(upd); res.json({ ok: true }); } catch (err) { res.json({ ok: false, error: err.message }); } });

app.get('/api/prefs', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, prefs: { quietEnabled: d.quietEnabled === true, quietStart: d.quietStart !== undefined ? d.quietStart : 22, quietEnd: d.quietEnd !== undefined ? d.quietEnd : 7, autoSend: d.autoSend === true, autoSendBatchSize: d.autoSendBatchSize !== undefined ? d.autoSendBatchSize : 5, appAccountId: d.appAccountId || '', totalAutoSent: d.totalAutoSent || 0 } }); } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/prefs', authRequired, async (req, res) => {
  try { const { quietEnabled, quietStart, quietEnd, autoSend, autoSendBatchSize } = req.body; let batchSize = Number(autoSendBatchSize); if (isNaN(batchSize) || batchSize < 1) batchSize = 5; if (batchSize > 100) batchSize = 100; await db.collection('users').doc(req.session.user.id).update({ quietEnabled: !!quietEnabled, quietStart: Number(quietStart), quietEnd: Number(quietEnd), autoSend: !!autoSend, autoSendBatchSize: batchSize, updatedAt: new Date() }); res.json({ ok: true }); } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const totalSnap = await db.collection('users').doc(uid).collection('recipients').count().get();
    const sentSnap = await db.collection('users').doc(uid).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get();
    const openedSnap = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Opened').count().get();
    const pendingSnap = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').count().get();
    const totalSendsSnap = await db.collection('users').doc(uid).collection('emailLog').count().get();
    res.json({ ok: true, stats: { total: totalSnap.data().count, sent: sentSnap.data().count, opened: openedSnap.data().count, pending: pendingSnap.data().count, totalSends: totalSendsSnap.data().count } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

async function runAutoSendForUser(userId, userEmail, userDoc) {
  if (isQuietHours(userDoc)) return { skipped: true, reason: 'quiet_hours' };
  const batchSize = Number(userDoc.autoSendBatchSize) || 5;
  const pendingSnap = await db.collection('users').doc(userId).collection('recipients').where('status', '==', 'Pending').limit(batchSize).get();
  if (pendingSnap.empty) return { sent: 0, failed: 0, reason: 'no_pending' };
  let sent = 0, failed = 0;
  for (const rDoc of pendingSnap.docs) {
    try { await sendOne(userId, userEmail, rDoc.id, true, { force: true }); sent++; await sleep(10000 + Math.floor(Math.random() * 10000)); }
    catch (e) { failed++; if (e.code === 'QUIET_HOURS') break; }
  }
  if (sent > 0) await db.collection('users').doc(userId).update({ totalAutoSent: (userDoc.totalAutoSent || 0) + sent, lastAutoSendRun: new Date() });
  return { sent, failed };
}

app.get('/api/cron/auto-send', async (req, res) => {
  try {
    const secret = req.query.secret || req.headers['x-cron-secret'];
    if (secret !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const usersSnap = await db.collection('users').where('autoSend', '==', true).get();
    let totalSent = 0, totalUsers = 0, skipped = 0, errors = 0;
    for (const uD of usersSnap.docs) { const u = uD.data(); if (!u.tokens || !u.email) continue; try { const result = await runAutoSendForUser(uD.id, u.email, u); if (result.skipped) skipped++; else if (result.sent > 0) { totalSent += result.sent; totalUsers++; } } catch (e) { errors++; } }
    res.json({ ok: true, totalSent, totalUsers, skipped, errors, timestamp: new Date().toISOString() });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.post('/api/auto-send-check', authRequired, async (req, res) => {
  try {
    const userDoc = await getUserData(req.session.user.id);
    if (!userDoc || !userDoc.autoSend) return res.json({ ok: true, skipped: true, reason: 'auto_send_off' });
    const last = userDoc.lastAutoSendRun ? new Date(userDoc.lastAutoSendRun._seconds ? userDoc.lastAutoSendRun._seconds * 1000 : userDoc.lastAutoSendRun) : null;
    const hourKey = getCurrentHourKey();
    const lastHourKey = last ? (last.toISOString().split('T')[0] + '-' + last.getHours()) : null;
    if (lastHourKey === hourKey) return res.json({ ok: true, skipped: true, reason: 'already_ran_this_hour' });
    const result = await runAutoSendForUser(req.session.user.id, req.session.user.email, userDoc);
    res.json({ ok: true, ...result });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/admin/dashboard', adminRequired, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const users = [];
    let tE = 0, tS = 0, tO = 0, tP = 0, tSends = 0;
    for (const uD of usersSnap.docs) {
      const u = uD.data();
      const totalSnap = await db.collection('users').doc(uD.id).collection('recipients').count().get();
      const sentSnap = await db.collection('users').doc(uD.id).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get();
      const openedSnap = await db.collection('users').doc(uD.id).collection('recipients').where('status', '==', 'Opened').count().get();
      const pendingSnap = await db.collection('users').doc(uD.id).collection('recipients').where('status', '==', 'Pending').count().get();
      const sendsSnap = await db.collection('users').doc(uD.id).collection('emailLog').count().get();
      const t = totalSnap.data().count, s = sentSnap.data().count, o = openedSnap.data().count, p = pendingSnap.data().count, sends = sendsSnap.data().count;
      tE += t; tS += s; tO += o; tP += p; tSends += sends;
      users.push({ id: uD.id, email: u.email, name: u.name, picture: u.picture || '', appAccountId: u.appAccountId || 'N/A', autoSend: !!u.autoSend, totalAutoSent: u.totalAutoSent || 0, createdAt: u.createdAt ? u.createdAt.toDate().toISOString() : '', hasSignature: !!u.signature, hasLogo: !!u.logoUrl, total: t, sent: s, opened: o, pending: p, totalSends: sends });
    }
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    res.json({ ok: true, users, stats: { totalUsers: users.length, totalEmails: tE, totalSent: tS, totalOpened: tO, totalPending: tP, totalSends: tSends } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/admin/user/:id/emails', adminRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.params.id).collection('emailLog').orderBy('sentAt','desc').limit(500).get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, emails: l }); } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/admin/all-emails', adminRequired, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const all = [];
    for (const uD of usersSnap.docs) { const u = uD.data(); const eS = await db.collection('users').doc(uD.id).collection('emailLog').orderBy('sentAt','desc').limit(500).get(); eS.forEach(d => { const dd = d.data(); all.push({ id: d.id, userId: uD.id, userEmail: u.email, userAppId: u.appAccountId || 'N/A', recipientEmail: dd.recipientEmail, company: dd.company || '', subject: dd.subject || '', sentAt: dd.sentAt, attachmentsCount: dd.attachmentsCount || 0, aiPrediction: dd.aiPrediction || '', aiScore: dd.aiScore || 0 }); }); }
    all.sort((a, b) => { const ta = a.sentAt?._seconds || 0; const tb = b.sentAt?._seconds || 0; return tb - ta; });
    res.json({ ok: true, emails: all.slice(0, 1000) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/auth') && !req.path.startsWith('/track')) return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  next();
});

if (process.env.VERCEL) module.exports = app;
else app.listen(PORT, () => console.log('Server running on port ' + PORT));