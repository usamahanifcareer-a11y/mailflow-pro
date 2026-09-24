require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const { google } = require('googleapis');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = 'usama.hanif.career@gmail.com';
const DAILY_LIMIT = 100;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '20mb' }));
app.use(cookieParser());
app.use(session({ secret: process.env.SESSION_SECRET || 'mf', resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 72 * 60 * 60 * 1000 } }));
app.use(express.static('public'));

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
const SCOPES = ['https://www.googleapis.com/auth/gmail.send','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/userinfo.profile','https://www.googleapis.com/auth/drive.file'];

function authRequired(req, res, next) { if (!req.session.user) return res.status(401).json({ ok: false, error: 'Login required' }); next(); }
function adminRequired(req, res, next) { if (!req.session.user || req.session.user.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) return res.status(403).json({ ok: false, error: 'Admin only' }); next(); }
async function getUserData(uid) { const d = await db.collection('users').doc(uid).get(); return d.exists ? d.data() : null; }
function setUserOAuth(t) { const c = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI); c.setCredentials(t); return c; }

// AUTH
app.get('/auth/google', (req, res) => res.redirect(oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' })));
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    oauth2Client.setCredentials(tokens);
    const info = await google.oauth2({ version: 'v2', auth: oauth2Client }).userinfo.get();
    const email = info.data.email, name = info.data.name;
    const uid = crypto.createHash('md5').update(email).digest('hex');
    const existing = await db.collection('users').doc(uid).get();
    const data = { email, name, tokens, updatedAt: new Date() };
    if (!existing.exists) { data.createdAt = new Date(); data.quietEnabled = true; data.quietStart = 22; data.quietEnd = 7; data.autoSend = false; data.signature = ''; data.logoUrl = ''; data.sigFields = {}; }
    await db.collection('users').doc(uid).set(data, { merge: true });
    req.session.user = { id: uid, email, name, isAdmin: email.toLowerCase() === ADMIN_EMAIL.toLowerCase() };
    res.redirect((process.env.FRONTEND_URL || 'http://localhost:3000') + '?login=success');
  } catch (err) { res.redirect((process.env.FRONTEND_URL || 'http://localhost:3000') + '?login=error'); }
});
app.get('/api/me', (req, res) => req.session.user ? res.json({ ok: true, user: req.session.user }) : res.json({ ok: false }));
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

// QUOTA
app.get('/api/quota', authRequired, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const sd = await db.collection('users').doc(req.session.user.id).collection('stats').doc(today).get();
    const sent = sd.exists ? (sd.data().sent || 0) : 0;
    res.json({ ok: true, sentToday: sent, limit: DAILY_LIMIT, remaining: Math.max(0, DAILY_LIMIT - sent) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// LOGO
app.post('/api/upload-logo', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64) return res.json({ ok: false, error: 'No data' });
    const allowed = ['image/png','image/jpeg','image/jpg','image/gif','image/svg+xml','image/webp'];
    if (!allowed.includes(mimeType)) return res.json({ ok: false, error: 'PNG/JPG/GIF/SVG/WEBP only' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 2 * 1024 * 1024) return res.json({ ok: false, error: 'Max 2MB' });
    const userDoc = await getUserData(req.session.user.id);
    if (!userDoc.tokens) return res.json({ ok: false, error: 'Login again' });
    const client = setUserOAuth(userDoc.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    if (userDoc.logoFileId) { try { await drive.files.delete({ fileId: userDoc.logoFileId }); } catch (e) {} }
    const uploaded = await drive.files.create({ requestBody: { name: filename || 'logo', mimeType }, media: { mimeType, body: Readable.from(buf) }, fields: 'id' });
    const fileId = uploaded.data.id;
    try { await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } }); } catch (e) {}
    const url = 'https://lh3.googleusercontent.com/d/' + fileId + '=w400';
    await db.collection('users').doc(req.session.user.id).update({ logoFileId: fileId, logoUrl: url });
    res.json({ ok: true, url, fileId });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get('/api/logo', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, url: d.logoUrl || '' }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// FILES
app.post('/api/upload-file', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || !filename) return res.json({ ok: false, error: 'Missing' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.json({ ok: false, error: 'Max 10MB' });
    const userDoc = await getUserData(req.session.user.id);
    const client = setUserOAuth(userDoc.tokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const uploaded = await drive.files.create({ requestBody: { name: filename, mimeType: mimeType || 'application/octet-stream' }, media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buf) }, fields: 'id,name,size,mimeType' });
    const fd = { driveId: uploaded.data.id, name: uploaded.data.name, mimeType: uploaded.data.mimeType, size: uploaded.data.size || buf.length, uploadedAt: new Date() };
    const doc = await db.collection('users').doc(req.session.user.id).collection('files').add(fd);
    res.json({ ok: true, file: { id: doc.id, ...fd } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get('/api/files', authRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('files').orderBy('uploadedAt','desc').get(); const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); res.json({ ok: true, files: l }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.delete('/api/files/:id', authRequired, async (req, res) => {
  try {
    const fDoc = await db.collection('users').doc(req.session.user.id).collection('files').doc(req.params.id).get();
    if (!fDoc.exists) return res.json({ ok: false });
    const userDoc = await getUserData(req.session.user.id);
    const client = setUserOAuth(userDoc.tokens);
    try { await google.drive({ version: 'v3', auth: client }).files.delete({ fileId: fDoc.data().driveId }); } catch (e) {}
    await fDoc.ref.delete(); res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// TEMPLATES
app.get('/api/templates', authRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('templates').get(); const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); res.json({ ok: true, templates: l }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/templates', authRequired, async (req, res) => {
  try {
    const { id, name, subject, body } = req.body;
    if (!name || !subject || !body) return res.json({ ok: false, error: 'All required' });
    const ref = db.collection('users').doc(req.session.user.id).collection('templates');
    if (id) { await ref.doc(id).set({ name, subject, body, updatedAt: new Date() }); res.json({ ok: true, id }); }
    else { const d = await ref.add({ name, subject, body, createdAt: new Date() }); res.json({ ok: true, id: d.id }); }
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.delete('/api/templates/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('templates').doc(req.params.id).delete(); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// RECIPIENTS — sendCount from emailLog
app.get('/api/recipients', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const snap = await db.collection('users').doc(uid).collection('recipients').orderBy('createdAt','desc').limit(1000).get();
    const logSnap = await db.collection('users').doc(uid).collection('emailLog').get();
    const counts = {};
    logSnap.forEach(d => { const rid = d.data().recipientId; counts[rid] = (counts[rid]||0) + 1; });
    const list = [];
    snap.forEach(d => { const data = d.data(); list.push({ id: d.id, ...data, sendCount: counts[d.id] || 0 }); });
    res.json({ ok: true, recipients: list });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/recipients', authRequired, async (req, res) => {
  try {
    const { list, templateId } = req.body;
    if (!list || !list.length) return res.json({ ok: false, error: 'No recipients' });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('recipients');
    let added = 0;
    for (const r of list) {
      if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) continue;
      const doc = ref.doc();
      batch.set(doc, { company: r.company || '', email: r.email.toLowerCase(), templateId: templateId || '', status: 'Pending', sentAt: null, openedAt: null, createdAt: new Date() });
      added++;
    }
    await batch.commit();
    res.json({ ok: true, added });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.delete('/api/recipients/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('recipients').doc(req.params.id).delete(); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
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

// MY EMAIL HISTORY
app.get('/api/my-emails', authRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('emailLog').orderBy('sentAt','desc').limit(1000).get(); const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); res.json({ ok: true, emails: l }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// SEND
function encSubject(s) { return /^[\x00-\x7F]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function buildMime(from, to, subject, html, attachments) {
  const mB = 'm_' + crypto.randomBytes(8).toString('hex');
  const aB = 'a_' + crypto.randomBytes(8).toString('hex');
  const p = ['From: ' + from, 'To: ' + to, 'Subject: ' + encSubject(subject), 'MIME-Version: 1.0'];
  if (attachments && attachments.length) {
    p.push('Content-Type: multipart/mixed; boundary="' + mB + '"', '', '--' + mB);
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), '', '--' + aB + '--', '');
    for (const att of attachments) {
      p.push('--' + mB, 'Content-Type: ' + att.mimeType + '; name="' + att.filename + '"', 'Content-Disposition: attachment; filename="' + att.filename + '"', 'Content-Transfer-Encoding: base64', '', att.data, '');
    }
    p.push('--' + mB + '--');
  } else {
    p.push('Content-Type: multipart/alternative; boundary="' + aB + '"', '', '--' + aB);
    p.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(html, 'utf8').toString('base64'), '', '--' + aB + '--');
  }
  return Buffer.from(p.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function sendOne(userId, userEmail, recipientId, attachFiles) {
  const userDoc = await getUserData(userId);
  if (!userDoc.tokens) throw new Error('Login again');
  const client = setUserOAuth(userDoc.tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const rDoc = await db.collection('users').doc(userId).collection('recipients').doc(recipientId).get();
  if (!rDoc.exists) throw new Error('Recipient not found');
  const rec = rDoc.data();
  let tpl;
  if (rec.templateId) { const t = await db.collection('users').doc(userId).collection('templates').doc(rec.templateId).get(); if (t.exists) tpl = t.data(); }
  if (!tpl) { const tS = await db.collection('users').doc(userId).collection('templates').limit(1).get(); if (!tS.empty) tpl = tS.docs[0].data(); }
  if (!tpl) throw new Error('No template');
  const sig = userDoc.signature || '';
  const body = tpl.body.replace(/\n/g, '<br>');
  const sigH = sig ? '<div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb;">' + sig + '</div>' : '';
  const full = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;">' + body + sigH + '</div>';
  const tUrl = (process.env.BACKEND_URL || 'http://localhost:3000') + '/track/' + recipientId + '?u=' + userId;
  const pixel = '<img src="' + tUrl + '" width="1" height="1" style="display:none">';
  const attachments = [];
  if (attachFiles !== false) {
    const fS = await db.collection('users').doc(userId).collection('files').get();
    const drive = google.drive({ version: 'v3', auth: client });
    for (const fD of fS.docs) { const f = fD.data(); try { const fd = await drive.files.get({ fileId: f.driveId, alt: 'media' }, { responseType: 'arraybuffer' }); attachments.push({ filename: f.name, mimeType: f.mimeType || 'application/octet-stream', data: Buffer.from(fd.data).toString('base64') }); } catch (e) {} }
  }
  const raw = buildMime(userEmail, rec.email, tpl.subject, full + pixel, attachments);
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  await db.collection('users').doc(userId).collection('emailLog').add({ recipientId, recipientEmail: rec.email, company: rec.company || '', subject: tpl.subject, sentAt: new Date(), attachmentsCount: attachments.length });
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ status: 'Sent', sentAt: new Date(), lastSentAt: new Date() });
  const today = new Date().toISOString().split('T')[0];
  const sRef = db.collection('users').doc(userId).collection('stats').doc(today);
  const sDoc = await sRef.get();
  await sRef.set({ sent: ((sDoc.exists ? sDoc.data().sent : 0) || 0) + 1, updatedAt: new Date() }, { merge: true });
  return rec.email;
}
app.post('/api/send', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false); res.json({ ok: true, email: e }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/resend', authRequired, async (req, res) => {
  try { const e = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, req.body.attachFiles !== false); res.json({ ok: true, email: e }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

// TRACKING PIXEL
app.use((req, res, next) => {
  if (req.path.startsWith('/track/')) {
    res.set('ngrok-skip-browser-warning', 'true');
    res.set('Access-Control-Allow-Origin', '*');
  }
  next();
});

app.get('/track/:id', async (req, res) => {
  try { const uid = req.query.u; if (uid) await db.collection('users').doc(uid).collection('recipients').doc(req.params.id).update({ status: 'Opened', openedAt: new Date() }); } catch (e) {}
  const px = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif'); res.send(px);
});

// SIGNATURE — save/load fields
app.get('/api/signature', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, signature: d.signature || '', fields: d.sigFields || {} }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/signature', authRequired, async (req, res) => {
  try {
    const upd = { signature: req.body.signature || '' };
    if (req.body.fields) upd.sigFields = req.body.fields;
    await db.collection('users').doc(req.session.user.id).update(upd);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// PREFS
app.get('/api/prefs', authRequired, async (req, res) => {
  try {
    const d = await getUserData(req.session.user.id);
    res.json({ ok: true, prefs: { quietEnabled: d.quietEnabled !== false, quietStart: d.quietStart !== undefined ? d.quietStart : 22, quietEnd: d.quietEnd !== undefined ? d.quietEnd : 7, autoSend: d.autoSend === true } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.post('/api/prefs', authRequired, async (req, res) => {
  try {
    const { quietEnabled, quietStart, quietEnd, autoSend } = req.body;
    await db.collection('users').doc(req.session.user.id).update({ quietEnabled: !!quietEnabled, quietStart: Number(quietStart), quietEnd: Number(quietEnd), autoSend: !!autoSend, updatedAt: new Date() });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// STATS
app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.session.user.id).collection('recipients').get();
    let total = 0, sent = 0, opened = 0, pending = 0;
    snap.forEach(d => { total++; const s = (d.data().status || '').toLowerCase(); if (s.includes('opened')) { opened++; sent++; } else if (s === 'sent') sent++; else if (s === 'pending') pending++; });
    const logSnap = await db.collection('users').doc(req.session.user.id).collection('emailLog').get();
    res.json({ ok: true, stats: { total, sent, opened, pending, totalSends: logSnap.size } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

// ADMIN
app.get('/api/admin/dashboard', adminRequired, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const users = [];
    let tE=0, tS=0, tO=0, tP=0, tSends=0;
    for (const uD of usersSnap.docs) {
      const u = uD.data();
      const rS = await db.collection('users').doc(uD.id).collection('recipients').get();
      let t=0,s=0,o=0,p=0;
      rS.forEach(d => { t++; const st=(d.data().status||'').toLowerCase(); if (st.includes('opened')){o++;s++;} else if (st==='sent') s++; else if (st==='pending') p++; });
      const eS = await db.collection('users').doc(uD.id).collection('emailLog').get();
      tE+=t; tS+=s; tO+=o; tP+=p; tSends+=eS.size;
      users.push({ id: uD.id, email: u.email, name: u.name, createdAt: u.createdAt ? u.createdAt.toDate().toISOString() : '', hasSignature: !!u.signature, hasLogo: !!u.logoUrl, total:t, sent:s, opened:o, pending:p, totalSends: eS.size });
    }
    users.sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    res.json({ ok: true, users, stats: { totalUsers: users.length, totalEmails: tE, totalSent: tS, totalOpened: tO, totalPending: tP, totalSends: tSends } });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get('/api/admin/user/:id/emails', adminRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.params.id).collection('emailLog').orderBy('sentAt','desc').limit(500).get(); const l=[]; s.forEach(d=>l.push({id:d.id,...d.data()})); res.json({ ok: true, emails: l }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});
app.get('/api/admin/all-emails', adminRequired, async (req, res) => {
  try {
    const usersSnap = await db.collection('users').get();
    const all = [];
    for (const uD of usersSnap.docs) {
      const u = uD.data();
      const eS = await db.collection('users').doc(uD.id).collection('emailLog').orderBy('sentAt','desc').limit(300).get();
      eS.forEach(d => { const dd = d.data(); all.push({ id: d.id, userEmail: u.email, recipientEmail: dd.recipientEmail, company: dd.company || '', subject: dd.subject || '', sentAt: dd.sentAt, attachmentsCount: dd.attachmentsCount || 0 }); });
    }
    all.sort((a,b) => { const ta = a.sentAt?._seconds||0; const tb = b.sentAt?._seconds||0; return tb - ta; });
    res.json({ ok: true, emails: all.slice(0, 500) });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log('✅ Backend running on port ' + PORT));