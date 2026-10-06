// ═══════════════════════════════════════════════════════════════
// MailFlow Pro — Vercel Email Relay Server
// Sirf ek kaam: Gmail SMTP se email bhejna
// DB access nahi, kuch store nahi karta
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const APP_VERSION = '3.0.0-relay';

// ─── Middleware ──────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.length === 0) return cb(null, true);
    if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));

// ─── Security headers ────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─── Health check ────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'mailflow-relay',
    version: APP_VERSION,
    hasSecret: !!SHARED_SECRET,
    timestamp: new Date().toISOString()
  });
});

// ─── Root ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'MailFlow Pro Relay — POST /api/send-email' });
});

// ─── Auth middleware ─────────────────────────────────────────
function requireSecret(req, res, next) {
  const secret = req.headers['x-mailflow-secret'] || (req.body && req.body.secret) || '';
  if (!SHARED_SECRET) {
    return res.status(500).json({ ok: false, error: 'Server secret not configured' });
  }
  if (secret !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ─── SMTP transporter factory ────────────────────────────────
function createTransporter(email, appPassword) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: email, pass: appPassword },
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    pool: false
  });
}

// ─── Send Email Endpoint ─────────────────────────────────────
app.post('/api/send-email', requireSecret, async (req, res) => {
  const startTime = Date.now();

  try {
    const body = req.body || {};
    const smtp = body.smtp || {};
    const email = body.email || {};
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];

    // Validate
    if (!smtp.email || !smtp.appPassword) {
      return res.status(400).json({ ok: false, error: 'SMTP credentials required' });
    }
    if (!email.to || !email.subject) {
      return res.status(400).json({ ok: false, error: 'Recipient and subject required' });
    }
    if (!email.html && !email.text) {
      return res.status(400).json({ ok: false, error: 'Email body required' });
    }

    // Clean app password (Gmail uses 16 chars, sometimes with spaces)
    const cleanPass = String(smtp.appPassword).replace(/\s/g, '');
    if (cleanPass.length < 16) {
      return res.status(400).json({ ok: false, error: 'Invalid app password' });
    }

    // Build mail options
    const mailOptions = {
      from: email.from || smtp.email,
      to: email.to,
      replyTo: email.replyTo || email.from || smtp.email,
      subject: email.subject,
      text: email.text || '',
      html: email.html || '',
      headers: email.headers || {},
      date: new Date()
    };

    if (email.messageId) mailOptions.messageId = email.messageId;
    if (email.inReplyTo) mailOptions.inReplyTo = email.inReplyTo;
    if (email.references) mailOptions.references = email.references;

    // Attachments (base64 content)
    if (attachments.length > 0) {
      mailOptions.attachments = attachments.map(a => ({
        filename: a.filename || 'attachment',
        content: Buffer.from(a.content, 'base64'),
        contentType: a.mimeType || 'application/octet-stream'
      }));
    }

    // Send
    const transporter = createTransporter(smtp.email, cleanPass);
    const info = await transporter.sendMail(mailOptions);
    transporter.close();

    const duration = Date.now() - startTime;

    return res.json({
      ok: true,
      messageId: info.messageId || '',
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      response: info.response || '',
      durationMs: duration
    });

  } catch (err) {
    console.error('[send-email] Error:', err.message);
    const duration = Date.now() - startTime;
    return res.status(500).json({
      ok: false,
      error: err.message || 'Send failed',
      code: err.code || '',
      command: err.command || '',
      durationMs: duration
    });
  }
});

// ─── Verify SMTP credentials (test connection) ───────────────
app.post('/api/verify-smtp', requireSecret, async (req, res) => {
  try {
    const { email, appPassword } = req.body || {};
    if (!email || !appPassword) {
      return res.status(400).json({ ok: false, error: 'Email and app password required' });
    }
    const cleanPass = String(appPassword).replace(/\s/g, '');
    if (cleanPass.length < 16) {
      return res.status(400).json({ ok: false, error: 'Invalid app password' });
    }
    const transporter = createTransporter(email, cleanPass);
    await transporter.verify();
    transporter.close();
    return res.json({ ok: true, message: 'SMTP connection verified' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Error handler ───────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// ─── 404 ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found: ' + req.path });
});

// ─── Start ───────────────────────────────────────────────────
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log('MailFlow Relay v' + APP_VERSION + ' on port ' + PORT);
    console.log('SHARED_SECRET: ' + (SHARED_SECRET ? 'SET' : 'MISSING'));
  });
}