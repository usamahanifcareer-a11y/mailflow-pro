require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const nodemailer = require('nodemailer');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const path = require('path');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'usama.hanif.career@gmail.com').toLowerCase();
const DEFAULT_DAILY_LIMIT = 500;
const DEFAULT_SEND_DELAY = 20;
const IS_VERCEL = !!process.env.VERCEL;
const CRON_SECRET = process.env.CRON_SECRET || '';
const BACKEND_URL = process.env.BACKEND_URL || 'https://mailflowpro.dpdns.org';
const APP_VERSION = '2.0.1';
const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || 'helloworld';
const OCR_FREE_MONTHLY_LIMIT = 25000;

// Tracking quality controls
const TRACK_MIN_DELAY_MS = 60 * 1000;
const TRACK_MACHINE_WINDOW_MS = 5 * 60 * 1000;

const MAX_FILE_SIZE = 3 * 1024 * 1024;
const MAX_LOGO_SIZE = 2 * 1024 * 1024;
const MAX_PROFILE_PIC_SIZE = 1 * 1024 * 1024;
const MAX_OCR_IMAGE_SIZE = 1 * 1024 * 1024;

if (!process.env.SESSION_SECRET) { console.error('FATAL: SESSION_SECRET missing!'); process.exit(1); }
if (!process.env.ENCRYPTION_KEY) { console.error('FATAL: ENCRYPTION_KEY missing!'); process.exit(1); }

const ENC_KEY = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY).digest();
const SESSION_DAYS_SHORT = 3;
const SESSION_DAYS_LONG = 30;

const userCache = new Map();
const CACHE_TTL = { quota: 30 * 1000, history: 5 * 60 * 1000, status: 30 * 1000, stats: 10 * 1000 };
function cacheGet(key){const e=userCache.get(key);if(!e)return null;if(Date.now()-e.time>e.ttl){userCache.delete(key);return null;}return e.value;}
function cacheSet(key,value,ttl){if(userCache.size>500){const k=userCache.keys().next().value;userCache.delete(k);}userCache.set(key,{value,time:Date.now(),ttl});}
function cacheDel(prefix){for(const k of userCache.keys()){if(k.startsWith(prefix))userCache.delete(k);}}

function encrypt(text){if(!text)return text;try{const iv=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv);let enc=cipher.update(JSON.stringify(text),'utf8','base64');enc+=cipher.final('base64');return 'v1:'+iv.toString('base64')+':'+cipher.getAuthTag().toString('base64')+':'+enc;}catch(e){return text;}}
function decrypt(data){if(!data||typeof data!=='string'||!data.startsWith('v1:'))return data;try{const parts=data.split(':');const decipher=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(parts[1],'base64'));decipher.setAuthTag(Buffer.from(parts[2],'base64'));let dec=decipher.update(parts[3],'base64','utf8');dec+=decipher.final('utf8');return JSON.parse(dec);}catch(e){return null;}}
function hashPassword(password,salt){if(!salt)salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64).toString('hex');return {hash,salt};}
function verifyPassword(password,hash,salt){try{const attempt=crypto.scryptSync(password,salt,64).toString('hex');return crypto.timingSafeEqual(Buffer.from(attempt,'hex'),Buffer.from(hash,'hex'));}catch(e){return false;}}
function normalizeEmail(email){let e=String(email).toLowerCase().trim();const parts=e.split('@');if(parts.length!==2)return e;let local=parts[0];const domain=parts[1];if(domain==='gmail.com'||domain==='googlemail.com'){local=local.split('+')[0].replace(/\./g,'');return local+'@gmail.com';}return e;}
function emailUid(email){return crypto.createHash('md5').update(normalizeEmail(email)).digest('hex');}

const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const MISTRAL_KEY = process.env.MISTRAL_API_KEY || '';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';

const aiCache = new Map();
const AI_CACHE_TTL = 10 * 60 * 1000;
const PROVIDER_BUDGETS = {groq:parseInt(process.env.GROQ_TOKEN_BUDGET||'0',10),gemini:parseInt(process.env.GEMINI_TOKEN_BUDGET||'0',10),mistral:parseInt(process.env.MISTRAL_TOKEN_BUDGET||'0',10),openrouter:parseInt(process.env.OPENROUTER_TOKEN_BUDGET||'0',10),omniroute:parseInt(process.env.OMNIROUTE_TOKEN_BUDGET||'0',10)};
const TOTAL_AI_BUDGET = parseInt(process.env.AI_TOKEN_BUDGET || '0', 10);

function getCacheKey(prompt,uid){return crypto.createHash('md5').update((uid||'anon')+'::'+prompt).digest('hex');}
function getCachedResponse(prompt,uid){const k=getCacheKey(prompt,uid);const e=aiCache.get(k);if(!e)return null;if(Date.now()-e.time>AI_CACHE_TTL){aiCache.delete(k);return null;}return e.text;}
function setCachedResponse(prompt,uid,t){if(aiCache.size>800){const k=aiCache.keys().next().value;aiCache.delete(k);}aiCache.set(getCacheKey(prompt,uid),{text:t,time:Date.now()});}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function safeParseJSON(text){if(!text)return null;let c=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/i,'').trim();const fb=c.indexOf('{'),lb=c.lastIndexOf('}');if(fb===-1||lb===-1)return null;try{return JSON.parse(c.substring(fb,lb+1));}catch(e){return null;}}
async function fetchWithTimeout(url,opts,ms){const ctrl=new AbortController();const t=setTimeout(()=>ctrl.abort(),ms||20000);try{const r=await fetch(url,{...opts,signal:ctrl.signal});clearTimeout(t);return r;}catch(e){clearTimeout(t);throw e;}}

function replaceInlineLogoWithPublicUrl(html, uid){if(!html||!uid)return html;try{return html.replace(/src\s*=\s*["']data:image\/[^;]+;base64,[^"']+["']/gi, 'src="' + BACKEND_URL + '/logo/' + uid + '"');}catch(e){return html;}}

function rewriteLinksForTracking(html, logId, uid, token){
  if(!html||!logId||!uid||!token) return html;
  try{
    return html.replace(/href\s*=\s*["'](https?:\/\/[^"']+)["']/gi, function(match, url){
      try{
        const enc = Buffer.from(url,'utf8').toString('base64url');
        return 'href="' + BACKEND_URL + '/click/' + logId + '?u=' + uid + '&t=' + token + '&url=' + enc + '"';
      }catch(e){return match;}
    });
  }catch(e){return html;}
}

function stripSignature(text){if(!text)return text;let t=String(text).trim();const lines=t.split('\n');while(lines.length>0&&!lines[lines.length-1].trim())lines.pop();if(lines.length<2)return t;const closer=/^(best regards|regards|sincerely|thank you|thanks|warm regards|kind regards|cheers|warmly|yours truly|yours faithfully|respectfully|all the best|best|thankyou|thanks & regards)[,.!\s]*$/i;const last=lines[lines.length-1].trim();const sec=lines.length>=2?lines[lines.length-2].trim():'';if(closer.test(last))return lines.slice(0,-1).join('\n').trim();if(lines.length>=3&&closer.test(sec))return lines.slice(0,-2).join('\n').trim();return t;}

function localCategorize(fromEmail,subject,bodyText){const f=(fromEmail||'').toLowerCase();const s=(subject||'').toLowerCase();const b=(bodyText||'').toLowerCase();if(f.includes('noreply')||f.includes('no-reply')||f.includes('donotreply')){if(s.includes('welcome')||s.includes('verify'))return 'NEWSLETTER';return 'AUTO_REPLY';}if(s.includes('newsletter')||b.includes('unsubscribe')||f.includes('notifications@'))return 'NEWSLETTER';if(s.includes('winner')||s.includes('prize')||s.includes('claim'))return 'SPAM';if(s.includes('meeting')||s.includes('invite')||s.includes('calendar'))return 'MEETING_REQUEST';if(s.includes('invoice')||s.includes('receipt')||s.includes('payment'))return 'INVOICE';if(s.includes('order')||s.includes('shipping')||s.includes('delivery'))return 'ORDER';if(s.includes('?'))return 'QUESTION';if(s.includes('following up'))return 'FOLLOW_UP';if(b.includes('interested')||b.includes("let's discuss"))return 'INTERESTED';if(b.includes('not interested'))return 'NOT_INTERESTED';return 'OTHER';}

async function logAIUsage(uid,provider,model,usage){if(!uid||!provider)return;try{const today=new Date().toISOString().split('T')[0];const month=today.substring(0,7);const pt=(usage&&usage.promptTokens)||(usage&&usage.prompt_tokens)||0;const ct=(usage&&usage.completionTokens)||(usage&&usage.completion_tokens)||0;const tt=(usage&&usage.totalTokens)||(usage&&usage.total_tokens)||(pt+ct);const dayRef=db.collection('users').doc(uid).collection('aiUsage').doc(today);const monthRef=db.collection('users').doc(uid).collection('aiUsage').doc('month_'+month);const totalRef=db.collection('users').doc(uid).collection('aiUsage').doc('total');const provRef=db.collection('users').doc(uid).collection('aiUsage').doc('prov_'+provider);const batch=db.batch();const [daySnap,monthSnap,totalSnap,provSnap]=await Promise.all([dayRef.get(),monthRef.get(),totalRef.get(),provRef.get()]);const mut=(snap)=>{const d=snap.exists?snap.data():{calls:0,promptTokens:0,completionTokens:0,totalTokens:0,providers:{}};d.calls=(d.calls||0)+1;d.promptTokens=(d.promptTokens||0)+pt;d.completionTokens=(d.completionTokens||0)+ct;d.totalTokens=(d.totalTokens||0)+tt;d.providers=d.providers||{};d.providers[provider]=(d.providers[provider]||0)+1;d.updatedAt=new Date();return d;};batch.set(dayRef,mut(daySnap),{merge:true});batch.set(monthRef,mut(monthSnap),{merge:true});const totalData=mut(totalSnap);totalData.firstUsed=totalData.firstUsed||new Date();batch.set(totalRef,totalData,{merge:true});const provData=provSnap.exists?provSnap.data():{calls:0,tokens:0};provData.calls=(provData.calls||0)+1;provData.tokens=(provData.tokens||0)+tt;provData.updatedAt=new Date();batch.set(provRef,provData,{merge:true});await batch.commit();}catch(e){}}

async function logOcrUsage(uid, success, chars, errorMsg, fileName, isClientError, stage) {if (!uid) return;try {const today = new Date().toISOString().split('T')[0];const month = today.substring(0, 7);const batch = db.batch();const dayRef = db.collection('users').doc(uid).collection('ocrUsage').doc(today);const dayUpdate = { date: today, updatedAt: new Date() };if (isClientError) { dayUpdate.clientErrors = FieldValue.increment(1); } else { dayUpdate.total = FieldValue.increment(1); dayUpdate.success = FieldValue.increment(success ? 1 : 0); dayUpdate.failed = FieldValue.increment(success ? 0 : 1); dayUpdate.charsExtracted = FieldValue.increment(chars || 0); }if (errorMsg) dayUpdate.lastError = String(errorMsg).substring(0, 200);if (fileName) dayUpdate.lastFileName = String(fileName).substring(0, 120);batch.set(dayRef, dayUpdate, { merge: true });const totalRef = db.collection('users').doc(uid).collection('ocrUsage').doc('total');if (isClientError) { batch.set(totalRef, { clientErrors: FieldValue.increment(1), updatedAt: new Date() }, { merge: true }); } else { batch.set(totalRef, { total: FieldValue.increment(1), success: FieldValue.increment(success ? 1 : 0), failed: FieldValue.increment(success ? 0 : 1), charsExtracted: FieldValue.increment(chars || 0), updatedAt: new Date() }, { merge: true }); }const logRef = db.collection('users').doc(uid).collection('ocrLog').doc();batch.set(logRef, { success: !!success, chars: chars || 0, error: errorMsg ? String(errorMsg).substring(0, 300) : '', fileName: fileName ? String(fileName).substring(0, 120) : '', isClientError: !!isClientError, stage: stage ? String(stage).substring(0, 50) : '', at: new Date() });if (!isClientError) { const globalRef = db.collection('globalStats').doc('ocrQuota_' + month); batch.set(globalRef, { month, total: FieldValue.increment(1), success: FieldValue.increment(success ? 1 : 0), failed: FieldValue.increment(success ? 0 : 1), charsExtracted: FieldValue.increment(chars || 0), updatedAt: new Date() }, { merge: true }); }await batch.commit();} catch (e) { }}

async function logAIError(uid, provider, errorMessage) {if (!uid || !provider) return;try {const today = new Date().toISOString().split('T')[0];const ref = db.collection('users').doc(uid).collection('aiErrors').doc(today);const update = { date: today, total: FieldValue.increment(1), lastError: String(errorMessage || '').substring(0, 250), updatedAt: new Date() };update['providers.' + provider] = FieldValue.increment(1);await ref.set(update, { merge: true });} catch (e) { }}

async function callGroq(prompt,uid){if(!GROQ_KEY)throw new Error('No key');const models=['openai/gpt-oss-120b','llama-3.3-70b-versatile','llama-3.1-8b-instant','llama3-70b-8192','mixtral-8x7b-32768','gemma2-9b-it'];let lastErr=null;for(const model of models){try{const r=await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_KEY},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:0.75,max_tokens:2000})},25000);if(!r.ok){lastErr=new Error('Groq '+model+' HTTP '+r.status);continue;}const d=await r.json();const content=(d.choices?.[0]?.message?.content||'').trim();if(content&&content.length>5){logAIUsage(uid,'groq',model,d.usage||{});return content;}lastErr=new Error('Groq '+model+' empty');}catch(e){lastErr=e;}}throw lastErr||new Error('All Groq models failed');}
async function callGemini(prompt,uid){if(!GEMINI_KEY)throw new Error('No key');const models=['gemini-2.0-flash-exp','gemini-2.0-flash','gemini-1.5-flash','gemini-1.5-flash-latest','gemini-1.5-pro'];let lastErr=null;for(const modelName of models){try{const client=new GoogleGenerativeAI(GEMINI_KEY);const model=client.getGenerativeModel({model:modelName});const result=await model.generateContent(prompt);const text=result.response.text().trim();if(text&&text.length>5){const um=result.response.usageMetadata||{};logAIUsage(uid,'gemini',modelName,{promptTokens:um.promptTokenCount||0,completionTokens:um.candidatesTokenCount||0,totalTokens:um.totalTokenCount||0});return text;}lastErr=new Error('Gemini '+modelName+' empty');}catch(e){lastErr=new Error('Gemini '+modelName+': '+e.message);}}throw lastErr||new Error('All Gemini models failed');}
async function callOpenRouter(prompt,uid){if(!OPENROUTER_KEY)throw new Error('No key');const models=['meta-llama/llama-3.3-70b-instruct:free','meta-llama/llama-3.1-8b-instruct:free','google/gemini-flash-1.5-8b:free','mistralai/mistral-7b-instruct:free','qwen/qwen-2.5-7b-instruct:free'];let lastErr=null;for(const model of models){try{const r=await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OPENROUTER_KEY,'HTTP-Referer':BACKEND_URL,'X-Title':'MailFlow Pro'},body:JSON.stringify({model,messages:[{role:'user',content:prompt+'\nReturn valid JSON only.'}],temperature:0.7,max_tokens:2000})},25000);if(!r.ok){lastErr=new Error('OR '+model+' HTTP '+r.status);continue;}const d=await r.json();const content=(d.choices?.[0]?.message?.content||'').trim();if(content&&content.length>5){logAIUsage(uid,'openrouter',model,d.usage||{});return content;}lastErr=new Error('OR '+model+' empty');}catch(e){lastErr=e;}}throw lastErr||new Error('All OpenRouter models failed');}
async function callMistral(prompt,uid){if(!MISTRAL_KEY)throw new Error('No key');const doFetch=async()=>{const r=await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+MISTRAL_KEY},body:JSON.stringify({model:'mistral-small-latest',messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:2000})},25000);if(r.status===429){const e=new Error('Rate limited');e.retryAfter=parseInt(r.headers.get('retry-after')||'5',10);throw e;}if(!r.ok)throw new Error('Mistral '+r.status);const d=await r.json();const content=(d.choices?.[0]?.message?.content||'').trim();if(content)logAIUsage(uid,'mistral','mistral-small-latest',d.usage||{});return content;};let lastErr;for(let attempt=0;attempt<3;attempt++){try{return await doFetch();}catch(e){lastErr=e;if(e.retryAfter!==undefined||e.message.includes('429'))await sleep((e.retryAfter||Math.pow(2,attempt))*1000);else throw e;}}throw lastErr;}
async function callOmniRoute(prompt,uid){const OMNIROUTE_URL=process.env.OMNIROUTE_URL||'';const OMNIROUTE_KEY=process.env.OMNIROUTE_KEY||'';if(!OMNIROUTE_URL||!OMNIROUTE_KEY)throw new Error('No OmniRoute config');const r=await fetchWithTimeout(OMNIROUTE_URL.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+OMNIROUTE_KEY},body:JSON.stringify({model:'auto',messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:2000})},30000);if(!r.ok)throw new Error('OmniRoute HTTP '+r.status);const d=await r.json();const content=(d.choices?.[0]?.message?.content||'').trim();if(!content||content.length<5)throw new Error('OmniRoute empty');logAIUsage(uid,'omniroute',d.model||'auto',d.usage||{});return content;}
async function callAI(prompt,uid){const cached=getCachedResponse(prompt,uid);if(cached)return cached;const providers=[{n:'omniroute',f:callOmniRoute},{n:'groq',f:callGroq},{n:'gemini',f:callGemini},{n:'openrouter',f:callOpenRouter},{n:'mistral',f:callMistral}];const errs=[];for(const p of providers){try{const text=await p.f(prompt,uid);if(!text||text.length<5)continue;setCachedResponse(prompt,uid,text);return text;}catch(e){errs.push(p.n+': '+e.message);logAIError(uid, p.n, e.message);}}throw new Error('All AI failed: '+errs.join(' | '));}

app.set('trust proxy',1);
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('X-XSS-Protection','1; mode=block');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');next();});
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({origin:function(origin,cb){if(!origin)return cb(null,true);if(ALLOWED_ORIGINS.length===0)return cb(null,true);if(ALLOWED_ORIGINS.indexOf(origin)!==-1)return cb(null,true);cb(null,false);},credentials:true}));
app.use(express.json({limit:'12mb'}));
app.use(cookieSession({name:'mf_session',keys:[process.env.SESSION_SECRET],maxAge:SESSION_DAYS_LONG*24*60*60*1000,secure:IS_VERCEL,sameSite:IS_VERCEL?'none':'lax',httpOnly:true,signed:true,overwrite:true}));
app.use(express.static(path.join(__dirname,'public')));
app.get('/privacy',(req,res)=>res.sendFile(path.join(__dirname,'public','privacy.html')));
app.get('/terms',(req,res)=>res.sendFile(path.join(__dirname,'public','terms.html')));

// ====== FIREBASE: Idempotent init (Vercel-safe) ======
let serviceAccount = {};
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  }
} catch (e) { console.error('Firebase parse error:', e.message); }

if (getApps().length === 0) {
  try {
    if (!Object.keys(serviceAccount).length) throw new Error('Firebase service account missing');
    initializeApp({ credential: cert(serviceAccount) });
    console.log('✅ Firebase initialized (fresh)');
  } catch (e) {
    console.error('❌ Firebase init error:', e.message);
  }
} else {
  console.log('✅ Firebase reused existing app');
}
const db = getFirestore();

app.get('/logo/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    if (!uid || uid.length > 64) return res.status(404).end();
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return res.status(404).end();
    const data = snap.data();
    if (!data.logoBase64) return res.status(404).end();
    let buf; try { buf = Buffer.from(data.logoBase64, 'base64'); } catch (e) { return res.status(500).end(); }
    res.set('Content-Type', data.logoMimeType || 'image/png');
    res.set('Cache-Control', 'public, max-age=604800, immutable');
    res.send(buf);
  } catch (e) { res.status(500).end(); }
});

function createTransporter(email, appPassword) { return nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: email, pass: appPassword }, connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 60000 }); }
function createImapClient(email, appPassword) { return new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: email, pass: appPassword }, logger: false, tls: { rejectUnauthorized: false } }); }

function isBotOrPrefetch(req){
  const ua = String(req.headers['user-agent'] || '');
  const uaLower = ua.toLowerCase();
  if (!ua) return true;
  if (/googleimageproxy|ggpht\.com|google image proxy/i.test(ua)) return true;
  const botRx = /(googlebot|google-read-aloud|googleweblight|feedfetcher|google-safety|bingbot|bingpreview|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebookexternalhit|facebot|twitterbot|linkedinbot|pinterest|slackbot|discordbot|telegrambot|whatsapp|skypeuripreview|applebot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|bytespider|preview|crawler|spider|monitoring|uptime|pingdom|statuscake|newrelic|datadog|site24x7|proofpoint|barracuda|mimecast|cloudmark|symantec|forcepoint|trendmicro|phishlabs|safelinks|mailchimp|sendgrid|amazonses|postmark|mailgun|outlook-iOS|ms-office|microsoft office|yahoomailproxy|outlookmobile|outlook|thunderbird|apple mail)/i;
  if (botRx.test(uaLower)) return true;
  if (/mozilla\/5\.0/i.test(ua) && /(chrome|safari|firefox|edg|opr|samsungbrowser)/i.test(ua)) return false;
  return true;
}

async function resolveAppPassword(uid) { const snap = await db.collection('users').doc(uid).get(); if (!snap.exists) return null; const d = snap.data(); let pass = null; if (d.smtpAppPassword) pass = decrypt(d.smtpAppPassword); if (!pass && d.imapAppPassword) pass = decrypt(d.imapAppPassword); return pass; }
async function authRequired(req, res, next) { if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: 'Session expired.' }); try { const banned = await db.collection('bannedUsers').doc(req.session.user.id).get(); if (banned.exists) { req.session = null; return res.status(403).json({ ok: false, error: 'BANNED', reason: banned.data().reason }); } } catch (e) { } next(); }
async function adminRequired(req, res, next) { if (!req.session || !req.session.user) return res.status(401).json({ ok: false, error: 'Session expired.' }); if (req.session.user.email.toLowerCase() !== ADMIN_EMAIL) return res.status(403).json({ ok: false, error: 'Admin required' }); next(); }
async function getUserData(uid) { const d = await db.collection('users').doc(uid).get(); if (!d.exists) return null; const data = d.data(); if (data.imapAppPassword && typeof data.imapAppPassword === 'string') data.imapAppPassword = decrypt(data.imapAppPassword) || null; if (data.smtpAppPassword && typeof data.smtpAppPassword === 'string') data.smtpAppPassword = decrypt(data.smtpAppPassword) || null; return data; }
function generateAppAccountId() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const bytes = crypto.randomBytes(6); let id = 'MFP-'; for (let i = 0; i < 6; i++) id += c.charAt(bytes[i] % c.length); return id; }
function isQuietHours(p) { if (!p || !p.quietEnabled) return false; const n = new Date().getHours(); const s = Number(p.quietStart), e = Number(p.quietEnd); if (isNaN(s) || isNaN(e) || s === e) return false; if (s < e) return n >= s && n < e; return n >= s || n < e; }
function getCurrentHourKey() { const n = new Date(); return n.toISOString().split('T')[0] + '-' + n.getHours(); }
function sanitizeSubject(subject) { if (!subject) return ''; let s = subject.replace(/!{2,}/g, '!').replace(/\?{2,}/g, '?').trim(); if (s.length > 78) s = s.substring(0, 75) + '...'; return s; }
function getClientIP(req) { const fwd = req.headers['x-forwarded-for']; if (fwd) return String(fwd).split(',')[0].trim(); return req.headers['x-real-ip'] || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'; }

function localAnalysis(subject, body) {
  const SW = ['free', 'guarantee', 'act now', 'click here', 'limited time', 'buy now', 'cash', 'prize', 'urgent', 'risk-free', 'earn money', 'work from home', 'make money', 'no cost', 'no fees'];
  const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
  const found = SW.filter(w => text.includes(w));
  const links = (body.match(/https?:\/\//g) || []).length;
  const exc = ((subject.match(/!/g) || []).length) > 1;
  const caps = subject === subject.toUpperCase() && subject.length > 5;
  const cb = (body || '').replace(/<[^>]+>/g, ' ').trim();
  const wc = cb.split(/\s+/).filter(w => w).length;
  const issues = [];
  if (found.length) issues.push({ severity: 'high', message: 'Contains: ' + found.slice(0, 3).join(', ') });
  if (links > 2) issues.push({ severity: 'medium', message: links + ' links found' });
  if (exc) issues.push({ severity: 'low', message: 'Multiple exclamation marks' });
  if (caps) issues.push({ severity: 'high', message: 'Subject in ALL CAPS' });
  if (wc < 20 && wc > 0) issues.push({ severity: 'medium', message: 'Body too short' });
  const score = Math.min(100, found.length * 20 + (links > 2 ? 15 : 0) + (exc ? 10 : 0) + (caps ? 25 : 0) + (wc < 20 && wc > 0 ? 15 : 0));
  return { score, prediction: score <= 15 ? 'EXCELLENT' : score <= 40 ? 'GOOD' : score <= 70 ? 'RISKY' : 'SPAM', inboxProbability: 100 - score, issues, suggestions: [], tone: 'professional', readability: 75, emotionalTone: 'neutral' };
}

async function testImapConnection(email, appPassword) { const client = createImapClient(email, appPassword); try { await client.connect(); await client.logout(); return { ok: true }; } catch (e) { try { await client.close(); } catch (err) { } return { ok: false, error: e.message }; } }

async function fetchImapEmails(email, appPassword, options = {}) {
  const client = createImapClient(email, appPassword);
  const emails = [];
  try {
    await client.connect();
    const folder = options.folder || 'INBOX';
    const mailbox = await client.mailboxOpen(folder);
    const total = mailbox.exists || 0;
    const pageSize = Math.min(options.pageSize || 20, 50);
    const page = Math.max(1, options.page || 1);
    let hasMore = false;
    if (total > 0) {
      const end = total - (page - 1) * pageSize;
      const start = Math.max(1, end - pageSize + 1);
      if (end >= 1) {
        hasMore = start > 1;
        const raws = [];
        for await (const message of client.fetch(`${start}:${end}`, { envelope: true, uid: true, flags: true })) { raws.push(message); }
        raws.reverse();
        for (const m of raws) {
          try {
            const env = m.envelope || {};
            const fromAddr = env.from && env.from[0] ? env.from[0].address : '';
            const fromName = env.from && env.from[0] ? env.from[0].name : '';
            const toAddr = env.to && env.to[0] ? env.to[0].address : '';
            const replyToAddr = env.replyTo && env.replyTo[0] ? env.replyTo[0].address : '';
            const subj = env.subject || '(no subject)';
            const dt = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
            const flags = m.flags || new Set();
            emails.push({ uid: m.uid, seq: m.seq, messageId: env.messageId || '', from: fromAddr, fromName: fromName || fromAddr, to: toAddr, replyTo: replyToAddr, subject: subj, date: dt, snippet: '', category: localCategorize(fromAddr, subj, ''), folder: folder, isRead: flags.has('\\Seen'), attachments: [] });
          } catch (pe) { }
        }
      }
    }
    await client.logout();
    return { ok: true, emails, total, hasMore, page, pageSize, folder };
  } catch (e) { try { await client.close(); } catch (err) { } return { ok: false, error: e.message }; }
}

async function fetchImapBody(email, appPassword, folder, uid) {
  const client = createImapClient(email, appPassword);
  try {
    await client.connect();
    await client.mailboxOpen(folder || 'INBOX');
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) { await client.logout(); return { ok: false, error: 'Email not found' }; }
    const parsed = await simpleParser(msg.source);
    const body = { textBody: (parsed.text || '').substring(0, 15000), htmlBody: (parsed.html || '').substring(0, 40000), snippet: (parsed.text || '').substring(0, 200).replace(/\s+/g, ' '), messageId: parsed.messageId || '', inReplyTo: parsed.inReplyTo || '', references: Array.isArray(parsed.references) ? parsed.references.join(' ') : (parsed.references || ''), replyTo: parsed.replyTo ? parsed.replyTo.text : '', to: parsed.to ? parsed.to.text : '', from: parsed.from ? parsed.from.text : '', cc: parsed.cc ? parsed.cc.text : '', attachments: (parsed.attachments || []).map(a => ({ filename: a.filename || 'attachment', size: a.size || 0, contentType: a.contentType || 'application/octet-stream' })) };
    await client.logout();
    return { ok: true, body };
  } catch (e) { try { await client.close(); } catch (err) { } return { ok: false, error: e.message }; }
}

async function fetchGmailSentTodayCount(email, appPassword) {
  const client = createImapClient(email, appPassword);
  try {
    await client.connect();
    let opened = false;
    const folders = ['[Gmail]/Sent Mail', '[Gmail]/Sent', 'Sent', 'Sent Items'];
    for (const f of folders) { try { await client.mailboxOpen(f); opened = true; break; } catch (e) { } }
    if (!opened) { await client.logout(); return { ok: false, error: 'No Sent folder' }; }
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let uids = [];
    try { uids = await client.search({ since: today }, { uid: true }); } catch (e) { uids = []; }
    await client.logout();
    return { ok: true, count: uids ? uids.length : 0, since: today.toISOString() };
  } catch (e) { try { await client.close(); } catch (err) { } return { ok: false, error: e.message }; }
}

async function fetchImapSentForRecipient(email, appPassword, recipientEmail, maxResults) {
  const client = createImapClient(email, appPassword);
  const results = [];
  try {
    await client.connect();
    const folders = ['[Gmail]/Sent Mail', '[Gmail]/Sent', 'Sent', 'Sent Items', 'INBOX.Sent', '[Gmail]/All Mail'];
    let opened = false;
    for (const f of folders) { try { await client.mailboxOpen(f); opened = true; break; } catch (e) { } }
    if (!opened) { await client.logout(); return { ok: false, error: 'No Sent folder found' }; }
    const target = String(recipientEmail || '').toLowerCase().trim();
    if (!target) { await client.logout(); return { ok: true, emails: [], total: 0 }; }
    let searchRes = [];
    const searchStrategies = [{ to: target }, { or: [{ to: target }, { cc: target }, { bcc: target }] }, { text: target }];
    for (const strat of searchStrategies) { try { const res = await client.search(strat, { uid: true }); if (res && res.length > searchRes.length) searchRes = res; } catch (e) { } }
    if (!searchRes || !searchRes.length) { await client.logout(); return { ok: true, emails: [], total: 0 }; }
    let uids = searchRes;
    if (maxResults && maxResults > 0 && uids.length > maxResults) uids = uids.slice(-maxResults);
    const CHUNK = 500;
    const fetched = [];
    for (let i = 0; i < uids.length; i += CHUNK) { const chunk = uids.slice(i, i + CHUNK); try { for await (const msg of client.fetch(chunk.join(','), { envelope: true, flags: true, uid: true }, { uid: true })) { fetched.push(msg); } } catch (e) { } }
    for (const msg of fetched) {
      try {
        const env = msg.envelope || {};
        const toAddrs = (env.to || []).map(x => (x.address || '').toLowerCase().trim());
        const ccAddrs = (env.cc || []).map(x => (x.address || '').toLowerCase().trim());
        if (!toAddrs.includes(target) && !ccAddrs.includes(target)) continue;
        const flags = msg.flags || new Set();
        results.push({ uid: msg.uid, messageId: env.messageId || '', subject: env.subject || '(no subject)', date: env.date ? new Date(env.date).toISOString() : null, from: env.from && env.from[0] ? env.from[0].address : email, to: env.to && env.to[0] ? env.to[0].address : '', isRead: flags.has('\\Seen'), source: 'gmail_imap' });
      } catch (e) { }
    }
    await client.logout();
    results.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    return { ok: true, emails: results, total: results.length, searched: searchRes.length };
  } catch (e) { try { await client.close(); } catch (err) { } return { ok: false, error: e.message }; }
}

async function updateSenderMemory(userId, email) {
  try {
    if (!email.from) return;
    const senderId = crypto.createHash('md5').update(email.from.toLowerCase()).digest('hex');
    const ref = db.collection('users').doc(userId).collection('senderMemory').doc(senderId);
    const existing = await ref.get();
    const category = localCategorize(email.from, email.subject, email.textBody || '');
    if (existing.exists) { const data = existing.data(); await ref.update({ totalEmails: (data.totalEmails || 0) + 1, lastEmailAt: new Date(), lastSubject: email.subject, categories: Array.from(new Set([...(data.categories || []), category])), subjects: [...(data.subjects || []).slice(-9), email.subject] }); }
    else { await ref.set({ senderEmail: email.from, senderName: email.fromName || email.from.split('@')[0], totalEmails: 1, firstEmailAt: new Date(), lastEmailAt: new Date(), lastSubject: email.subject, categories: [category], subjects: [email.subject] }); }
  } catch (e) { }
}

function looksLikeBinaryCv(text) { if (!text) return true; const t = String(text).trim(); if (t.startsWith('%PDF') || t.startsWith('PK\x03\x04')) return true; const sample = t.substring(0, 800); let bad = 0; for (let i = 0; i < sample.length; i++) { const c = sample.charCodeAt(i); if (c === 0 || (c < 9) || (c > 13 && c < 32)) bad++; } return bad > 12; }
function decodePdfString(s) { return s.replace(/\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, '\t').replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\').replace(/\\(\d{1,3})/g, function (_, oct) { return String.fromCharCode(parseInt(oct, 8)); }); }
function naivePdfExtract(buf) {
  try {
    const raw = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf);
    if (raw.indexOf('%PDF') === -1) return '';
    const chunks = [];
    const tj = raw.match(/\((?:\\.|[^\\)]){2,}\)(?:\s*Tj)?/g) || [];
    for (const x of tj) { const inner = x.replace(/\)\s*Tj\s*$/, '').replace(/^\(/, '').replace(/\)$/, ''); const d = decodePdfString(inner); if (/[A-Za-z]{3,}/.test(d)) chunks.push(d); }
    const tjArr = raw.match(/\[(?:[^\]]{4,1200})\]\s*TJ/g) || [];
    for (const x of tjArr) { const parts = x.match(/\((?:\\.|[^\\)])+\)/g) || []; const line = parts.map(p => decodePdfString(p.slice(1, -1))).join(''); if (/[A-Za-z]{3,}/.test(line)) chunks.push(line); }
    const text = chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[^\S\n]+/g, ' ').trim();
    return text.length > 40 ? text : '';
  } catch (e) { return ''; }
}
async function extractPdfText(buf) { try { const pdfParse = require('pdf-parse'); const data = await pdfParse(buf); const t = (data && data.text ? data.text : '').replace(/\u0000/g, '').trim(); if (t.replace(/\s/g, '').length > 30) return t; } catch (e) { } return naivePdfExtract(buf); }
function extractDocxText(buf) {
  try {
    const zip = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const name = 'word/document.xml';
    let pos = zip.indexOf(Buffer.from(name));
    if (pos < 0) return '';
    let local = -1;
    for (let i = Math.max(0, pos - 80); i < pos; i++) { if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x03 && zip[i + 3] === 0x04) { local = i; break; } }
    if (local < 0) return '';
    const compression = zip.readUInt16LE(local + 8);
    const compSize = zip.readUInt32LE(local + 18);
    const nameLen = zip.readUInt16LE(local + 26);
    const extraLen = zip.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLen + extraLen;
    const data = zip.slice(dataStart, dataStart + compSize);
    let xml = '';
    if (compression === 0) xml = data.toString('utf8');
    else { const zlib = require('zlib'); xml = zlib.inflateRawSync(data).toString('utf8'); }
    return xml.replace(/<w:p[^>]*>/g, '\n').replace(/<w:tab[^/]*\/>/g, '\t').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); }).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  } catch (e) { return ''; }
}
async function extractCvFromBuffer(buf, filename, mimeType) {
  const name = (filename || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (mime.includes('pdf') || name.endsWith('.pdf') || buf.slice(0, 5).toString() === '%PDF-') { const pdf = await extractPdfText(buf); if (pdf) return pdf; return ''; }
  if (mime.includes('wordprocessingml') || name.endsWith('.docx')) return extractDocxText(buf);
  if (mime.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.rtf')) { let t = buf.toString('utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t.replace(/\u0000/g, '').trim(); }
  const asText = buf.toString('utf8');
  if (!looksLikeBinaryCv(asText)) return asText.trim();
  const pdfTry = await extractPdfText(buf); if (pdfTry) return pdfTry;
  const docxTry = extractDocxText(buf); if (docxTry) return docxTry;
  return '';
}

app.get('/api/health', (req, res) => res.json({ ok: true, vercel: IS_VERCEL, version: APP_VERSION, method: 'smtp', trackMinDelayMs: TRACK_MIN_DELAY_MS, machineWindowMs: TRACK_MACHINE_WINDOW_MS }));

/* ============ TRACKING ============ */
app.get('/track/:id', async (req, res) => {
  const px = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  try {
    const u = String(req.query.u || '');
    const t = String(req.query.t || '');
    const type = String(req.query.type || '');
    if (!u || !t || !req.params.id) return res.send(px);
    const bot = isBotOrPrefetch(req);
    if (type === 'test') {
      if (bot) return res.send(px);
      const ref = db.collection('users').doc(u).collection('testRecipients').doc(req.params.id);
      const r = await ref.get();
      if (r.exists && r.data().trackToken === t) {
        const now = new Date();
        const update = { lastOpenAt: now };
        if (r.data().status !== 'Opened') { update.status = 'Opened'; update.openedAt = now; update.everOpened = true; }
        await ref.set(update, { merge: true });
      }
      return res.send(px);
    }
    const logRef = db.collection('users').doc(u).collection('emailLog').doc(req.params.id);
    const r = await logRef.get();
    if (!r.exists) return res.send(px);
    const data = r.data();
    if (data.sendTrackToken !== t) return res.send(px);
    const now = Date.now();
    const sentAt = data.sentAt && data.sentAt._seconds ? data.sentAt._seconds * 1000 : new Date(data.sentAt || 0).getTime();
    const sinceSend = now - sentAt;
    if (bot) { try { await logRef.set({ lastMachineHitAt: new Date(), machineHits: FieldValue.increment(1) }, { merge: true }); } catch(e){} return res.send(px); }
    if (sinceSend < TRACK_MIN_DELAY_MS) { try { await logRef.set({ lastMachineHitAt: new Date(), machineHits: FieldValue.increment(1) }, { merge: true }); } catch(e){} return res.send(px); }
    const firstRealOpen = !data.openedAt;
    const update = { lastOpenAt: new Date() };
    if (firstRealOpen) { update.openedAt = new Date(); update.openCount = FieldValue.increment(1); } else { update.reopenCount = FieldValue.increment(1); }
    await logRef.set(update, { merge: true });
    const recId = data.recipientId;
    if (recId) {
      try {
        const recRef = db.collection('users').doc(u).collection('recipients').doc(recId);
        const rec = await recRef.get();
        if (rec.exists) {
          const recUpdate = { lastActivityAt: new Date() };
          if (rec.data().status !== 'Opened') { recUpdate.status = 'Opened'; recUpdate.openedAt = new Date(); recUpdate.everOpened = true; }
          await recRef.set(recUpdate, { merge: true });
        }
      } catch(e){}
    }
    cacheDel('stats:' + u); cacheDel('recipients:' + u);
  } catch (e) { }
  res.send(px);
});

app.get('/click/:id', async (req, res) => {
  let redirectUrl = BACKEND_URL;
  try {
    const u = String(req.query.u || '');
    const t = String(req.query.t || '');
    const enc = String(req.query.url || '');
    if (enc) { try { redirectUrl = Buffer.from(enc, 'base64url').toString('utf8'); } catch(e){} }
    if (!/^https?:\/\//i.test(redirectUrl)) redirectUrl = BACKEND_URL;
    if (!u || !t || !req.params.id) return res.redirect(302, redirectUrl);
    const bot = isBotOrPrefetch(req);
    if (bot) return res.redirect(302, redirectUrl);
    const logRef = db.collection('users').doc(u).collection('emailLog').doc(req.params.id);
    const r = await logRef.get();
    if (!r.exists) return res.redirect(302, redirectUrl);
    const data = r.data();
    if (data.sendTrackToken !== t) return res.redirect(302, redirectUrl);
    const now = new Date();
    const firstClick = !data.firstClickAt;
    const update = { lastClickAt: now, clickCount: FieldValue.increment(1), lastClickUrl: redirectUrl.substring(0, 500) };
    if (firstClick) update.firstClickAt = now;
    if (!data.openedAt) { update.openedAt = now; update.openedBy = 'click'; }
    await logRef.set(update, { merge: true });
    const recId = data.recipientId;
    if (recId) {
      try {
        const recRef = db.collection('users').doc(u).collection('recipients').doc(recId);
        const rec = await recRef.get();
        if (rec.exists) {
          const ru = { lastActivityAt: now };
          if (rec.data().status !== 'Opened') { ru.status = 'Opened'; ru.openedAt = now; ru.everOpened = true; }
          await recRef.set(ru, { merge: true });
        }
      } catch(e){}
    }
    cacheDel('stats:' + u); cacheDel('recipients:' + u);
  } catch (e) { }
  return res.redirect(302, redirectUrl);
});

/* ============ OCR ============ */
app.post('/api/ocr/extract', authRequired, async (req, res) => {
  const uid = req.session.user.id;
  let fileName = '';
  try {
    const { base64, mimeType, filename } = req.body || {};
    fileName = filename || '';
    if (!base64 || base64.length < 50) { await logOcrUsage(uid, false, 0, 'No image data provided', fileName, false, ''); return res.json({ ok: false, error: 'No image data provided' }); }
    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { await logOcrUsage(uid, false, 0, 'Invalid base64', fileName, false, ''); return res.json({ ok: false, error: 'Invalid image data. Please re-upload the screenshot.' }); }
    if (buf.length > MAX_OCR_IMAGE_SIZE) { const kb = Math.round(buf.length / 1024); await logOcrUsage(uid, false, 0, 'Image too large: ' + kb + 'KB', fileName, false, ''); return res.json({ ok: false, error: 'Image too large (' + kb + ' KB). Max ' + Math.round(MAX_OCR_IMAGE_SIZE/1024) + ' KB.' }); }
    const mime = (mimeType || 'image/jpeg').toLowerCase();
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff'];
    const safeMime = allowed.indexOf(mime) !== -1 ? mime : 'image/jpeg';
    const params = new URLSearchParams();
    params.append('base64Image', 'data:' + safeMime + ';base64,' + base64);
    params.append('language', 'eng');
    params.append('isOverlayRequired', 'false');
    params.append('OCREngine', '2');
    params.append('scale', 'true');
    params.append('isTable', 'false');
    params.append('detectOrientation', 'true');
    let ocrRes;
    try { ocrRes = await fetchWithTimeout('https://api.ocr.space/parse/image', { method: 'POST', headers: { 'apikey': OCR_SPACE_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }, 60000); }
    catch (netErr) { await logOcrUsage(uid, false, 0, 'Network: ' + netErr.message, fileName, false, ''); return res.json({ ok: false, error: 'OCR service unreachable. Please try again in a moment.' }); }
    if (!ocrRes.ok) { await logOcrUsage(uid, false, 0, 'OCR HTTP ' + ocrRes.status, fileName, false, ''); return res.json({ ok: false, error: 'OCR service error (HTTP ' + ocrRes.status + ').' + (ocrRes.status === 413 ? ' Image too large.' : ' Please try again.') }); }
    let ocrData;
    try { ocrData = await ocrRes.json(); } catch (e) { await logOcrUsage(uid, false, 0, 'Invalid OCR response', fileName, false, ''); return res.json({ ok: false, error: 'Invalid response from OCR service. Please retry.' }); }
    if (ocrData.IsErroredOnProcessing) { const errMsg = (ocrData.ErrorMessage && Array.isArray(ocrData.ErrorMessage)) ? ocrData.ErrorMessage.join(' ') : (ocrData.ErrorMessage || 'OCR processing failed'); await logOcrUsage(uid, false, 0, errMsg, fileName, false, ''); const low = String(errMsg).toLowerCase(); if (low.indexOf('limit') !== -1 || low.indexOf('quota') !== -1) return res.json({ ok: false, error: 'OCR monthly limit reached. Please try again next month.' }); if (low.indexOf('size') !== -1 || low.indexOf('large') !== -1) return res.json({ ok: false, error: 'Image is too large for OCR.' }); return res.json({ ok: false, error: errMsg }); }
    if (!ocrData.ParsedResults || !ocrData.ParsedResults.length) { await logOcrUsage(uid, false, 0, 'No text detected', fileName, false, ''); return res.json({ ok: false, error: 'No text detected in this image. Try a clearer screenshot.' }); }
    const text = ocrData.ParsedResults.map(r => r.ParsedText || '').join('\n').trim();
    if (!text || text.length < 2) { await logOcrUsage(uid, false, 0, 'No readable text', fileName, false, ''); return res.json({ ok: false, error: 'No readable text found in image.' }); }
    await logOcrUsage(uid, true, text.length, '', fileName, false, '');
    res.json({ ok: true, text: text.substring(0, 30000), chars: text.length });
  } catch (e) { console.error('OCR error:', e.message); await logOcrUsage(uid, false, 0, 'Server: ' + e.message, fileName, false, ''); res.json({ ok: false, error: 'OCR failed: ' + e.message }); }
});

app.post('/api/ocr/client-error', authRequired, async (req, res) => {
  try { const uid = req.session.user.id; const { error, fileName, stage } = req.body || {}; await logOcrUsage(uid, false, 0, String(error || 'Client error').substring(0, 200), String(fileName || '').substring(0, 120), true, String(stage || 'client').substring(0, 50)); res.json({ ok: true }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ AUTH ============ */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password || !name) return res.json({ ok: false, error: 'Email, password, and name are required' });
    if (password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ ok: false, error: 'Invalid email address' });
    const emailLower = String(email).toLowerCase().trim();
    const normalized = normalizeEmail(emailLower);
    const uid = emailUid(emailLower);
    const ip = getClientIP(req);
    const banned = await db.collection('bannedUsers').doc(uid).get();
    if (banned.exists) return res.json({ ok: false, error: 'This email is suspended', banned: true });
    const ipBanned = await db.collection('bannedUsers').where('ip', '==', ip).limit(1).get();
    if (!ipBanned.empty) return res.json({ ok: false, error: 'Your IP is suspended', banned: true });
    const dupCheck = await db.collection('users').where('email', 'in', [emailLower, normalized]).limit(1).get();
    if (!dupCheck.empty) { const existingDoc = dupCheck.docs[0]; const exData = existingDoc.data(); if (exData.passwordHash) return res.json({ ok: false, error: 'This email is already registered. Please login instead.' }); }
    const existing = await db.collection('users').doc(uid).get();
    if (existing.exists && existing.data().passwordHash) return res.json({ ok: false, error: 'This email is already registered. Please login instead.' });
    const { hash, salt } = hashPassword(password);
    const now = new Date();
    const data = { email: emailLower, emailNormalized: normalized, name: String(name).substring(0, 100), passwordHash: hash, passwordSalt: salt, authType: 'email', createdAt: now, updatedAt: now, lastLogin: now, lastIP: ip, firstIP: ip, quietEnabled: false, quietStart: 22, quietEnd: 7, autoSend: false, autoSendBatchSize: 5, autoSendTemplateId: '', autoSendFileIds: [], autoSendIncludeLogo: true, autoSendIncludeSignature: true, autoSendIncludeAttachments: false, signature: '', logoUrl: '', logoUrlAlt: '', logoFileId: null, sigFields: {}, appAccountId: generateAppAccountId(), lastAutoSendRun: null, totalAutoSent: 0, lastSendTime: null, dailyLimit: DEFAULT_DAILY_LIMIT, sendDelay: DEFAULT_SEND_DELAY, imapEnabled: false, imapAppPassword: null, aiProfile: {}, profilePicture: '', smtpEnabled: false, smtpAppPassword: null, preferences: { language: 'en', timezone: 'Asia/Karachi', dateFormat: 'DD/MM/YYYY', timeFormat: '12h' } };
    if (existing.exists) { const ex = existing.data(); if (ex.appAccountId) data.appAccountId = ex.appAccountId; data.createdAt = ex.createdAt || now; if (ex.smtpAppPassword) data.smtpAppPassword = ex.smtpAppPassword; if (ex.smtpEnabled) data.smtpEnabled = ex.smtpEnabled; if (ex.imapAppPassword) data.imapAppPassword = ex.imapAppPassword; if (ex.imapEnabled) data.imapEnabled = ex.imapEnabled; }
    await db.collection('users').doc(uid).set(data, { merge: true });
    req.session.user = { id: uid, email: emailLower, name: data.name, picture: '', appAccountId: data.appAccountId, isAdmin: emailLower === ADMIN_EMAIL };
    res.json({ ok: true, user: req.session.user });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, remember } = req.body || {};
    if (!email || !password) return res.json({ ok: false, error: 'Email and password are required' });
    const emailLower = String(email).toLowerCase().trim();
    const normalized = normalizeEmail(emailLower);
    let uid = emailUid(emailLower);
    let userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) { const altUid = crypto.createHash('md5').update(emailLower).digest('hex'); if (altUid !== uid) { const altSnap = await db.collection('users').doc(altUid).get(); if (altSnap.exists) { userSnap = altSnap; uid = altUid; } } }
    if (!userSnap.exists) { const q = await db.collection('users').where('emailNormalized', '==', normalized).limit(1).get(); if (!q.empty) { userSnap = q.docs[0]; uid = q.docs[0].id; } }
    if (!userSnap.exists) return res.json({ ok: false, error: 'Invalid email or password' });
    const userData = userSnap.data();
    if (!userData.passwordHash || !userData.passwordSalt) return res.json({ ok: false, error: 'Invalid email or password' });
    const valid = verifyPassword(password, userData.passwordHash, userData.passwordSalt);
    if (!valid) return res.json({ ok: false, error: 'Invalid email or password' });
    const banned = await db.collection('bannedUsers').doc(uid).get();
    if (banned.exists) return res.json({ ok: false, error: 'Account suspended', banned: true, reason: banned.data().reason });
    const ip = getClientIP(req);
    const ipBanned = await db.collection('bannedUsers').where('ip', '==', ip).limit(1).get();
    if (!ipBanned.empty) return res.json({ ok: false, error: 'IP suspended', banned: true });
    await db.collection('users').doc(uid).update({ lastLogin: new Date(), lastIP: ip, emailNormalized: normalized });
    const sessionDays = remember ? SESSION_DAYS_LONG : SESSION_DAYS_SHORT;
    req.sessionOptions.maxAge = sessionDays * 24 * 60 * 60 * 1000;
    req.session.remember = !!remember;
    req.session.user = { id: uid, email: userData.email, name: userData.name, picture: userData.profilePicture || '', appAccountId: userData.appAccountId, isAdmin: userData.email.toLowerCase() === ADMIN_EMAIL };
    res.json({ ok: true, user: req.session.user, remember: !!remember });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/check-banned', async (req, res) => {
  try {
    const { email, ip } = req.body || {};
    const result = { banned: false, reason: '', canRequest: false };
    if (email) { const uid = emailUid(String(email).toLowerCase()); const snap = await db.collection('bannedUsers').doc(uid).get(); if (snap.exists) { result.banned = true; result.reason = snap.data().reason || 'Account suspended'; result.canRequest = true; } }
    if (!result.banned && ip) { const snap = await db.collection('bannedUsers').where('ip', '==', ip).limit(1).get(); if (!snap.empty) { result.banned = true; result.reason = snap.docs[0].data().reason || 'IP suspended'; result.canRequest = true; } }
    res.json({ ok: true, ...result });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/request-access', async (req, res) => {
  try {
    const { name, email, company, phone, reason, oldEmail } = req.body || {};
    if (!name || !email || !reason) return res.json({ ok: false, error: 'Name, email, and reason are required' });
    const ip = getClientIP(req);
    const uid = emailUid(email);
    const ref = db.collection('accessRequests').doc(uid);
    const existing = await ref.get();
    if (existing.exists && existing.data().status === 'pending') return res.json({ ok: false, error: 'You already have a pending request' });
    await ref.set({ name: String(name).substring(0, 100), email: String(email).toLowerCase().substring(0, 200), company: String(company || '').substring(0, 150), phone: String(phone || '').substring(0, 50), reason: String(reason).substring(0, 1000), oldEmail: String(oldEmail || '').toLowerCase(), ip, status: 'pending', requestedAt: new Date() });
    res.json({ ok: true, message: 'Request submitted' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/me', async (req, res) => {
  if (req.session && req.session.user) { if (!req.session.user.appAccountId) { const d = await getUserData(req.session.user.id); if (d && d.appAccountId) req.session.user.appAccountId = d.appAccountId; } res.json({ ok: true, user: req.session.user, remember: !!req.session.remember }); }
  else res.json({ ok: false });
});
app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.post('/api/change-password', authRequired, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.json({ ok: false, error: 'Current and new password required' });
    if (newPassword.length < 8) return res.json({ ok: false, error: 'New password must be at least 8 characters' });
    if (currentPassword === newPassword) return res.json({ ok: false, error: 'New password must be different' });
    const userSnap = await db.collection('users').doc(req.session.user.id).get();
    if (!userSnap.exists) return res.json({ ok: false, error: 'User not found' });
    const userData = userSnap.data();
    if (!verifyPassword(currentPassword, userData.passwordHash, userData.passwordSalt)) return res.json({ ok: false, error: 'Current password is incorrect' });
    const { hash, salt } = hashPassword(newPassword);
    await db.collection('users').doc(req.session.user.id).update({ passwordHash: hash, passwordSalt: salt, passwordChangedAt: new Date() });
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/change-email', authRequired, async (req, res) => {
  try {
    const { currentPassword, newEmail } = req.body || {};
    if (!currentPassword || !newEmail) return res.json({ ok: false, error: 'Current password and new email required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) return res.json({ ok: false, error: 'Invalid email address' });
    const newEmailLower = String(newEmail).toLowerCase().trim();
    const newNormalized = normalizeEmail(newEmailLower);
    const newUid = emailUid(newEmailLower);
    if (newUid === req.session.user.id) return res.json({ ok: false, error: 'New email is same as current' });
    const userSnap = await db.collection('users').doc(req.session.user.id).get();
    if (!userSnap.exists) return res.json({ ok: false, error: 'User not found' });
    const userData = userSnap.data();
    if (!verifyPassword(currentPassword, userData.passwordHash, userData.passwordSalt)) return res.json({ ok: false, error: 'Password is incorrect' });
    const dupCheck = await db.collection('users').where('emailNormalized', '==', newNormalized).limit(1).get();
    if (!dupCheck.empty) return res.json({ ok: false, error: 'This email is already registered' });
    const newDoc = await db.collection('users').doc(newUid).get();
    if (newDoc.exists && newDoc.data().passwordHash) return res.json({ ok: false, error: 'This email is already registered' });
    await db.collection('users').doc(newUid).set({ ...userData, email: newEmailLower, emailNormalized: newNormalized, updatedAt: new Date() }, { merge: true });
    await db.collection('users').doc(req.session.user.id).delete();
    const bannedOld = await db.collection('bannedUsers').doc(req.session.user.id).get();
    if (bannedOld.exists) await db.collection('bannedUsers').doc(newUid).set(bannedOld.data());
    req.session.user = { ...req.session.user, id: newUid, email: newEmailLower, isAdmin: newEmailLower === ADMIN_EMAIL };
    res.json({ ok: true, user: req.session.user, message: 'Email changed successfully' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/user-preferences', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, preferences: d.preferences || { language: 'en', timezone: 'Asia/Karachi', dateFormat: 'DD/MM/YYYY', timeFormat: '12h' } }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/user-preferences', authRequired, async (req, res) => {
  try {
    const { language, timezone, dateFormat, timeFormat } = req.body || {};
    const allowedLangs = ['en', 'ur', 'hi', 'ar', 'es', 'fr'];
    const allowedTimezones = ['Asia/Karachi', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Riyadh', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'UTC'];
    const allowedDateFormats = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'MMM DD, YYYY'];
    const allowedTimeFormats = ['12h', '24h'];
    const prefs = { language: allowedLangs.includes(language) ? language : 'en', timezone: allowedTimezones.includes(timezone) ? timezone : 'Asia/Karachi', dateFormat: allowedDateFormats.includes(dateFormat) ? dateFormat : 'DD/MM/YYYY', timeFormat: allowedTimeFormats.includes(timeFormat) ? timeFormat : '12h', updatedAt: new Date() };
    await db.collection('users').doc(req.session.user.id).update({ preferences: prefs });
    res.json({ ok: true, preferences: prefs });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ SMTP / IMAP ============ */
app.post('/api/smtp/connect', authRequired, async (req, res) => {
  try {
    const { appPassword, alsoEnableImap } = req.body || {};
    if (!appPassword || appPassword.replace(/\s/g, '').length < 16) return res.json({ ok: false, error: 'App password must be 16 characters.' });
    const cleanPass = appPassword.replace(/\s/g, '');
    const userEmail = req.session.user.email;
    const transporter = createTransporter(userEmail, cleanPass);
    try { await transporter.verify(); } catch (err) { return res.json({ ok: false, error: 'Connection failed: ' + err.message }); }
    const update = { smtpAppPassword: encrypt(cleanPass), smtpEnabled: true, smtpConnectedAt: new Date() };
    if (alsoEnableImap) { const test = await testImapConnection(userEmail, cleanPass); if (test.ok) { update.imapAppPassword = encrypt(cleanPass); update.imapEnabled = true; update.imapConnectedAt = new Date(); } }
    await db.collection('users').doc(req.session.user.id).update(update);
    cacheDel('quota:' + req.session.user.id); cacheDel('status:' + req.session.user.id);
    res.json({ ok: true, message: 'Gmail connected successfully', imapEnabled: !!update.imapEnabled });
  } catch (e) { res.json({ ok: false, error: 'Connection failed: ' + e.message }); }
});
app.get('/api/smtp/status', authRequired, async (req, res) => {
  try { const ck = 'status:' + req.session.user.id; const cached = cacheGet(ck); if (cached) return res.json(cached); const u = await getUserData(req.session.user.id); const out = { ok: true, connected: !!u.smtpEnabled, connectedAt: u.smtpConnectedAt || null, imapEnabled: !!u.imapEnabled }; cacheSet(ck, out, CACHE_TTL.status); res.json(out); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/smtp/disconnect', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).update({ smtpAppPassword: null, smtpEnabled: false }); cacheDel('quota:' + req.session.user.id); cacheDel('status:' + req.session.user.id); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/imap/connect', authRequired, async (req, res) => {
  try {
    const { appPassword, useStored } = req.body || {};
    let cleanPass = '';
    if (useStored) { const stored = await resolveAppPassword(req.session.user.id); if (!stored) return res.json({ ok: false, error: 'No stored password found' }); cleanPass = stored; }
    else { if (!appPassword || appPassword.replace(/\s/g, '').length < 16) return res.json({ ok: false, error: 'App password must be 16 characters.' }); cleanPass = appPassword.replace(/\s/g, ''); }
    const test = await testImapConnection(req.session.user.email, cleanPass);
    if (!test.ok) return res.json({ ok: false, error: 'Connection failed: ' + test.error });
    await db.collection('users').doc(req.session.user.id).update({ imapAppPassword: encrypt(cleanPass), imapEnabled: true, imapConnectedAt: new Date() });
    cacheDel('quota:' + req.session.user.id); cacheDel('status:' + req.session.user.id);
    res.json({ ok: true, message: 'Inbox connected successfully' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/imap/status', authRequired, async (req, res) => {
  try { const u = await getUserData(req.session.user.id); res.json({ ok: true, connected: !!u.imapEnabled, connectedAt: u.imapConnectedAt || null, lastSync: u.imapLastSync || null, totalSynced: u.imapTotalSynced || 0, hasSmtpPass: !!u.smtpEnabled, userEmail: u.email }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/imap/disconnect', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).update({ imapAppPassword: null, imapEnabled: false }); cacheDel('quota:' + req.session.user.id); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/imap/inbox', authRequired, async (req, res) => {
  try {
    const u = await getUserData(req.session.user.id);
    if (!u.imapEnabled || !u.imapAppPassword) return res.json({ ok: false, error: 'Inbox not connected' });
    const folder = req.body.folder || 'INBOX';
    const page = parseInt(req.body.page) || 1;
    const pageSize = Math.min(parseInt(req.body.pageSize) || 20, 50);
    const result = await fetchImapEmails(u.email, u.imapAppPassword, { folder, page, pageSize });
    if (!result.ok) return res.json({ ok: false, error: result.error });
    const uid = req.session.user.id;
    const coll = db.collection('users').doc(uid).collection('imapEmails');
    const writes = [];
    for (const e of result.emails) { const key = folder.replace(/[^A-Za-z0-9]/g, '_') + '_' + e.uid; writes.push(coll.doc(key).set(e, { merge: true }).catch(() => { })); if (e.from) updateSenderMemory(uid, { from: e.from, fromName: e.fromName, subject: e.subject, textBody: '' }); }
    Promise.all(writes).catch(() => { });
    db.collection('users').doc(uid).update({ imapLastSync: new Date() }).catch(() => { });
    res.json({ ok: true, emails: result.emails, total: result.total, hasMore: result.hasMore, page: result.page, pageSize: result.pageSize, folder: folder, userEmail: u.email });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/imap/body', authRequired, async (req, res) => {
  try {
    const u = await getUserData(req.session.user.id);
    if (!u.imapEnabled || !u.imapAppPassword) return res.json({ ok: false, error: 'Inbox not connected' });
    const { folder, uid } = req.body;
    if (!uid) return res.json({ ok: false, error: 'Missing uid' });
    const folderKey = (folder || 'INBOX').replace(/[^A-Za-z0-9]/g, '_');
    const docId = folderKey + '_' + uid;
    const ref = db.collection('users').doc(req.session.user.id).collection('imapEmails').doc(docId);
    const cached = await ref.get();
    if (cached.exists && cached.data().bodyFetched) { const cd = cached.data(); return res.json({ ok: true, email: { id: docId, ...cd, userEmail: u.email } }); }
    const result = await fetchImapBody(u.email, u.imapAppPassword, folder || 'INBOX', uid);
    if (!result.ok) return res.json({ ok: false, error: result.error });
    await ref.set({ ...result.body, bodyFetched: true, isRead: true }, { merge: true });
    const fresh = await ref.get();
    res.json({ ok: true, email: { id: docId, ...fresh.data(), userEmail: u.email } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/imap/email/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('imapEmails').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/inbox/reply', authRequired, async (req, res) => {
  try {
    const { to, subject, body, inReplyTo, references, includeSignature, includeLogo, includeAttachments, selectedFileIds } = req.body;
    if (!to || !subject || !body) return res.json({ ok: false, error: 'Missing fields' });
    const uid = req.session.user.id;
    const u = await getUserData(uid);
    if (!u.smtpEnabled || !u.smtpAppPassword) return res.json({ ok: false, error: 'Connect Gmail first' });
    const userEmailLower = String(req.session.user.email || '').toLowerCase();
    const toLower = String(to).toLowerCase().trim();
    if (toLower === userEmailLower) return res.json({ ok: false, error: 'Cannot reply to your own email address.' });
    const transporter = createTransporter(req.session.user.email, u.smtpAppPassword);
    let sigHtml = '';
    const hasSignature = !!(u.signature && u.signature.trim().length > 20);
    if (hasSignature && includeSignature !== false) {
      let sig = u.signature;
      if (includeLogo === false) sig = sig.replace(/<td[^>]*>\s*<img[\s\S]*?<\/td>/gi, '').replace(/<img[^>]*>/gi, '').replace(/<td[^>]*>\s*<\/td>/gi, '');
      else sig = replaceInlineLogoWithPublicUrl(sig, uid);
      sigHtml = '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;">' + sig + '</div>';
    }
    const atts = []; const attNames = [];
    if (includeAttachments === true && Array.isArray(selectedFileIds) && selectedFileIds.length > 0) {
      for (const fid of selectedFileIds) {
        try { const fd = await db.collection('users').doc(uid).collection('files').doc(fid).get(); if (fd.exists) { const f = fd.data(); if (f.base64) { atts.push({ filename: f.name, content: Buffer.from(f.base64, 'base64'), contentType: f.mimeType || 'application/octet-stream' }); attNames.push(f.name); } } } catch (fe) {}
      }
    }
    const bodyHtml = body.replace(/\n/g, '<br>');
    const fullHtml = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">' + bodyHtml + sigHtml + '</div>';
    const sendTrackToken = crypto.randomBytes(16).toString('hex');
    const logRef = await db.collection('users').doc(uid).collection('emailLog').add({ recipientId: null, recipientEmail: to, company: '', subject: sanitizeSubject(subject), sentAt: new Date(), attachmentsCount: atts.length, attachmentNames: attNames, aiPrediction: 'GOOD', aiScore: 20, aiInboxProb: 80, sendTrackToken, openedAt: null, hasSignature: hasSignature, templateName: '', isReply: true, inReplyTo: inReplyTo || '' });
    const logId = logRef.id;
    const trackUrl = BACKEND_URL + '/track/' + logId + '?u=' + uid + '&t=' + sendTrackToken;
    const pix = '<img src="' + trackUrl + '" width="1" height="1" alt="" style="border:0;display:block;width:1px;height:1px">';
    const withClickLinks = rewriteLinksForTracking(fullHtml, logId, uid, sendTrackToken);
    const finalHtml = withClickLinks + pix;
    const mailOptions = { from: '"' + (u.name || 'User') + '" <' + req.session.user.email + '>', to, subject: sanitizeSubject(subject), html: finalHtml };
    if (inReplyTo) mailOptions.inReplyTo = inReplyTo;
    if (references) mailOptions.references = references;
    if (atts.length > 0) mailOptions.attachments = atts;
    const info = await transporter.sendMail(mailOptions);
    cacheDel('quota:' + uid); cacheDel('stats:' + uid);
    await db.collection('users').doc(uid).collection('replyLog').add({ to, subject, body, sentAt: new Date(), messageId: info.messageId || '', inReplyTo: inReplyTo || '', references: references || '', logId: logId, attachmentNames: attNames });
    res.json({ ok: true, id: info.messageId, logId: logId, hasSignature: hasSignature, attachmentsCount: atts.length });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/memory/senders', authRequired, async (req, res) => {
  try { const snap = await db.collection('users').doc(req.session.user.id).collection('senderMemory').orderBy('lastEmailAt', 'desc').limit(200).get(); const senders = []; snap.forEach(d => senders.push({ id: d.id, ...d.data() })); res.json({ ok: true, senders }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ AI ============ */
app.post('/api/ai/analyze-live', authRequired, async (req, res) => {
  try {
    const { subject, body } = req.body;
    if (!subject && !body) return res.json({ ok: true, empty: true });
    try { const cleanBody = (body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 1200); const prompt = `Analyze this email for spam score. Return ONLY JSON.\nSubject: "${(subject || '').substring(0, 200)}"\nBody: "${cleanBody}"\nReturn: {"score":0-100,"prediction":"EXCELLENT"|"GOOD"|"RISKY"|"SPAM","inboxProbability":0-100,"issues":[{"severity":"low"|"medium"|"high","message":"string"}],"suggestions":["string"],"tone":"string"}`; const text = await callAI(prompt, req.session.user.id); const parsed = safeParseJSON(text); if (parsed && typeof parsed.score === 'number') return res.json({ ok: true, ...parsed, aiPowered: true }); } catch (aiErr) { }
    res.json({ ok: true, ...localAnalysis(subject, body), aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/smart-reply', authRequired, async (req, res) => {
  try {
    const { originalSubject, originalBody, originalFrom, instruction } = req.body;
    if (!originalBody) return res.json({ ok: false, error: 'No original body' });
    const u = await getUserData(req.session.user.id);
    const aiProfile = u.aiProfile || {};
    const userName = aiProfile.fullName || u.name || u.email.split('@')[0];
    const userCompany = aiProfile.company || (u.sigFields?.company) || '';
    const userPos = aiProfile.designation || (u.sigFields?.pos) || '';
    const userTone = aiProfile.tone || 'professional';
    const userAbout = aiProfile.aboutMe || '';
    const userIndustry = aiProfile.industry || '';
    const hasSignature = !!(u.signature && u.signature.trim().length > 20);
    const sigInstruction = hasSignature ? 'A professional HTML signature will be auto-appended. Do NOT include any sign-off, name, contact info, or closing line.' : `End with clean professional sign-off. Include name "${userName}"${userPos ? ', ' + userPos : ''}${userCompany ? ' at ' + userCompany : ''}.`;
    const prompt = `You are an expert business email assistant writing a reply on behalf of ${userName}.\n\nWRITER IDENTITY:\n- Name: ${userName}\n${userPos ? '- Position: ' + userPos : ''}\n${userCompany ? '- Company: ' + userCompany : ''}\n${userIndustry ? '- Industry: ' + userIndustry : ''}\n${userAbout ? '- About: ' + userAbout : ''}\n- Preferred Tone: ${userTone}\n\nINCOMING EMAIL (may be in ANY language):\nFrom: ${originalFrom || 'Unknown Sender'}\nSubject: ${originalSubject || '(no subject)'}\nBody:\n"""\n${(originalBody || '').substring(0, 4000)}\n"""\n\n${instruction ? 'EXTRA INSTRUCTION: ' + instruction : ''}\n\nTASK: Write a thoughtful, professional reply.\n\nCRITICAL RULES:\n1. Reply in professional ENGLISH only.\n2. Write in FIRST PERSON as ${userName}.\n3. Match tone: ${userTone}.\n4. Address EVERY point, question, request.\n5. Keep 2-4 paragraphs.\n6. ${sigInstruction}\n7. Do NOT invent facts.\n\nReturn ONLY valid JSON:\n{"subject":"Re: (matching original subject)","body":"complete reply text with \\n\\n for paragraphs"}`;
    try { const text = await callAI(prompt, req.session.user.id); const parsed = safeParseJSON(text); if (parsed && parsed.body && parsed.body.length > 20) { const cleanedBody = hasSignature ? stripSignature(parsed.body) : parsed.body; return res.json({ ok: true, subject: parsed.subject || ('Re: ' + originalSubject), body: cleanedBody, aiPowered: true, hasUserSignature: hasSignature }); } } catch (e) { }
    res.json({ ok: true, subject: 'Re: ' + (originalSubject || ''), body: 'Hi,\n\nThank you for reaching out. I will get back to you shortly.', aiPowered: false, hasUserSignature: hasSignature });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/write-email', authRequired, async (req, res) => {
  try {
    const { context, recipientName, recipientCompany, tone, length } = req.body;
    if (!context) return res.json({ ok: false, error: 'Please describe the email purpose' });
    const u = await getUserData(req.session.user.id);
    const aiProfile = u.aiProfile || {};
    const writerName = aiProfile.fullName || u.name || 'the sender';
    const writerDesig = aiProfile.designation || '';
    const writerCompany = aiProfile.company || '';
    const writerAbout = aiProfile.aboutMe || '';
    const writerIndustry = aiProfile.industry || '';
    const TM = { formal: 'professional and business-appropriate', friendly: 'warm and approachable yet polished', casual: 'relaxed but professional', persuasive: 'confident and compelling' };
    const LM = { short: '80-100 words, concise', medium: '130-180 words, balanced', long: '200-280 words, detailed' };
    const prompt = `Write a high-quality professional email.\n\nWRITER: ${writerName}${writerDesig ? ', ' + writerDesig : ''}${writerCompany ? ' at ' + writerCompany : ''}\n${writerIndustry ? 'Industry: ' + writerIndustry : ''}\n${writerAbout ? 'About writer: ' + writerAbout : ''}\n\nPURPOSE: ${context}\nRECIPIENT: ${recipientName || 'unknown'}\nRECIPIENT COMPANY: ${recipientCompany || 'unknown'}\nTONE: ${TM[tone] || TM.formal}\nLENGTH: ${LM[length] || LM.medium}\n\nRULES:\n- Output in professional English only\n- No sign-off, no name, no signature (auto-appended)\n- Clear, actionable, human\n\nReturn ONLY valid JSON:\n{"subject":"under 65 chars","body":"email body with \\n\\n for paragraphs"}`;
    try { const text = await callAI(prompt, req.session.user.id); const parsed = safeParseJSON(text); if (parsed && parsed.subject && parsed.body) return res.json({ ok: true, subject: parsed.subject, body: stripSignature(parsed.body), aiPowered: true }); } catch (e) { }
    res.json({ ok: true, subject: context.substring(0, 60), body: 'Dear ' + (recipientName || 'there') + ',\n\nI hope this message finds you well.\n\n' + context, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/extract-cv', authRequired, async (req, res) => {
  try {
    const { fileId, base64, mimeType, filename } = req.body || {};
    let buf = null, fname = filename || 'cv', mime = mimeType || '';
    if (fileId) {
      const f = await db.collection('users').doc(req.session.user.id).collection('files').doc(fileId).get();
      if (!f.exists) return res.json({ ok: false, error: 'File not found. Please re-upload your CV.' });
      const meta = f.data();
      if (!meta.base64 || meta.base64.length < 50) return res.json({ ok: false, error: 'This file has no data.' });
      fname = meta.name || fname; mime = meta.mimeType || mime;
      try { buf = Buffer.from(meta.base64, 'base64'); } catch (e) { return res.json({ ok: false, error: 'File data is corrupted. Please re-upload.' }); }
    }
    else if (base64) { try { buf = Buffer.from(base64, 'base64'); } catch (e) { return res.json({ ok: false, error: 'Invalid file data' }); } if (buf.length > MAX_FILE_SIZE) return res.json({ ok: false, error: 'Maximum file size is 3MB.' }); }
    else return res.json({ ok: false, error: 'No file provided' });
    if (!buf || buf.length < 20) return res.json({ ok: false, error: 'File is empty or corrupted.' });
    const text = await extractCvFromBuffer(buf, fname, mime);
    if (!text || text.replace(/\s/g, '').length < 30 || looksLikeBinaryCv(text)) return res.json({ ok: false, error: 'Could not read text. Try pasting manually.' });
    res.json({ ok: true, text: text.substring(0, 20000), filename: fname, chars: text.length });
  } catch (e) { res.json({ ok: false, error: 'File processing error: ' + e.message }); }
});

app.post('/api/ai/analyze-cv', authRequired, async (req, res) => {
  try {
    const { cvText, targetRole, jobDescription, fileId } = req.body;
    let text = cvText || '';
    if (fileId && (!text || looksLikeBinaryCv(text))) { try { const f = await db.collection('users').doc(req.session.user.id).collection('files').doc(fileId).get(); if (f.exists) { const meta = f.data(); if (meta.base64 && meta.base64.length > 100) { text = await extractCvFromBuffer(Buffer.from(meta.base64, 'base64'), meta.name || 'cv', meta.mimeType || ''); } } } catch (e) { } }
    if (looksLikeBinaryCv(text)) return res.json({ ok: false, error: 'CV is not readable.' });
    if (!text || text.replace(/\s/g, '').length < 30) return res.json({ ok: false, error: 'CV text is too short or empty.' });
    const u = await getUserData(req.session.user.id);
    const aiProfile = u.aiProfile || {};
    const writerName = aiProfile.fullName || u.name || 'the applicant';
    const writerCompany = aiProfile.company || '';
    const prompt = `Analyze this CV and write a job application email.\n\nRULES: Output in professional English. First person as ${writerName}.${writerCompany ? ' Current company: ' + writerCompany : ''}\n\nCV:\n"""\n${text.substring(0, 3800)}\n"""\n\nTARGET ROLE: ${targetRole || 'Not specified'}\n${jobDescription ? 'JOB DESCRIPTION:\n' + jobDescription.substring(0, 800) : ''}\n\nReturn ONLY JSON:\n{"subject":"under 65 chars","body":"email with \\n\\n","keySkills":["s1","s2","s3","s4","s5"],"analysis":"2-3 sentences","score":0-100}`;
    const aiText = await callAI(prompt, req.session.user.id);
    const parsed = safeParseJSON(aiText);
    if (parsed && parsed.subject && parsed.body) return res.json({ ok: true, subject: parsed.subject, body: stripSignature(parsed.body), keySkills: parsed.keySkills || [], analysis: parsed.analysis || '', score: parsed.score || 70, aiPowered: true });
    res.json({ ok: false, error: 'AI could not parse the CV.' });
  } catch (e) { res.json({ ok: false, error: 'Analysis failed: ' + e.message }); }
});

app.post('/api/ai/generate-subjects', authRequired, async (req, res) => {
  try {
    const { context } = req.body;
    const prompt = `Generate 5 email subject lines. Return ONLY JSON.\nMax 60 chars each, no spam words.\nContext: ${context || 'professional outreach'}\nReturn: {"subjects":["s1","s2","s3","s4","s5"]}`;
    try { const text = await callAI(prompt, req.session.user.id); const parsed = safeParseJSON(text); if (parsed && parsed.subjects && parsed.subjects.length >= 3) return res.json({ ok: true, subjects: parsed.subjects, aiPowered: true }); } catch (e) { }
    const c = (context || 'Professional Outreach').substring(0, 50);
    res.json({ ok: true, subjects: [c, 'Quick question about ' + c, 'Following up on ' + c], aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/ai/improve-email', authRequired, async (req, res) => {
  try {
    const { subject, body, isReply } = req.body;
    const prompt = `Improve this email.\n\nSubject: "${subject || ''}"\nBody:\n"""\n${(body || '').substring(0, 1500)}\n"""\n\nReturn ONLY JSON:\n{"improvedSubject":"...","improvedBody":"...","beforeScore":50,"afterScore":85}`;
    try { const text = await callAI(prompt, req.session.user.id); const parsed = safeParseJSON(text); if (parsed && parsed.improvedSubject) return res.json({ ok: true, improvedSubject: parsed.improvedSubject, improvedBody: stripSignature(parsed.improvedBody || ''), beforeScore: parsed.beforeScore || 50, afterScore: parsed.afterScore || 85, aiPowered: true }); } catch (e) { }
    res.json({ ok: true, improvedSubject: subject, improvedBody: body, beforeScore: 50, afterScore: 75, aiPowered: false });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/ai/best-time', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const snap = await db.collection('users').doc(uid).collection('emailLog').orderBy('sentAt', 'desc').limit(100).get();
    const hs = {};
    snap.forEach(d => { const data = d.data(); const ms = data.sentAt?._seconds ? data.sentAt._seconds * 1000 : new Date(data.sentAt).getTime(); const h = new Date(ms).getHours(); if (!hs[h]) hs[h] = { sent: 0 }; hs[h].sent++; });
    try { const hist = Object.entries(hs).map(([h, s]) => `Hour ${h}: sent=${s.sent}`).join('\n'); const prompt = `Recommend 3 best hours for B2B emails. JSON only.\n${hist || 'No data'}\nReturn: {"bestHours":[h1,h2,h3],"reasoning":"short"}`; const text = await callAI(prompt, uid); const parsed = safeParseJSON(text); if (parsed && parsed.bestHours) return res.json({ ok: true, ...parsed, aiPowered: true }); } catch (e) { }
    res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default', aiPowered: false });
  } catch (e) { res.json({ ok: true, bestHours: [9, 11, 14], reasoning: 'Default', aiPowered: false }); }
});

/* ============ TEMPLATES ============ */
app.get('/api/templates', authRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('templates').get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, templates: l }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/templates', authRequired, async (req, res) => {
  try {
    const { id, name, subject, body } = req.body;
    if (!name || !subject || !body) return res.json({ ok: false, error: 'Name, subject, and body are required' });
    const ref = db.collection('users').doc(req.session.user.id).collection('templates');
    if (id) { await ref.doc(id).set({ name, subject, body, updatedAt: new Date() }, { merge: true }); res.json({ ok: true, id, name }); }
    else { const existing = await ref.get(); const names = []; existing.forEach(d => { const n = d.data().name; if (n) names.push(n); }); let fn = name; if (names.includes(name)) { let c = 1; while (names.includes(name + ' ' + c)) c++; fn = name + ' ' + c; } const d = await ref.add({ name: fn, subject, body, createdAt: new Date() }); res.json({ ok: true, id: d.id, name: fn, renamed: fn !== name }); }
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/templates/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('templates').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ RECIPIENTS ============ */
app.get('/api/recipients', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const ck = 'recipients:' + uid;
    const cached = cacheGet(ck); if (cached) return res.json(cached);
    const s = await db.collection('users').doc(uid).collection('recipients').orderBy('createdAt', 'desc').limit(1000).get();
    const ls = await db.collection('users').doc(uid).collection('emailLog').get();
    const c = {}; ls.forEach(d => { const r = d.data().recipientId; if (r) c[r] = (c[r] || 0) + 1; });
    let l = []; s.forEach(d => { const da = d.data(); l.push({ id: d.id, ...da, sendCount: c[d.id] || 0 }); });
    const out = { ok: true, recipients: l };
    cacheSet(ck, out, 15 * 1000);
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/recipients', authRequired, async (req, res) => {
  try {
    const { list, templateId } = req.body;
    if (!list || !list.length) return res.json({ ok: false, error: 'No recipients provided' });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('recipients');
    let a = 0;
    for (const r of list) { if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) continue; const doc = ref.doc(); batch.set(doc, { company: (r.company || '').trim(), email: r.email.toLowerCase(), templateId: templateId || '', status: 'Pending', sentAt: null, openedAt: null, everOpened: false, createdAt: new Date() }); a++; }
    await batch.commit();
    cacheDel('recipients:' + req.session.user.id); cacheDel('stats:' + req.session.user.id);
    res.json({ ok: true, added: a });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/recipients/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('recipients').doc(req.params.id).delete(); cacheDel('recipients:' + req.session.user.id); cacheDel('stats:' + req.session.user.id); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/recipients/bulk-delete', authRequired, async (req, res) => {
  try { const { ids } = req.body; if (!ids || !ids.length) return res.json({ ok: false }); const b = db.batch(); const r = db.collection('users').doc(req.session.user.id).collection('recipients'); ids.forEach(id => b.delete(r.doc(id))); await b.commit(); cacheDel('recipients:' + req.session.user.id); cacheDel('stats:' + req.session.user.id); res.json({ ok: true, deleted: ids.length }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/recipient/:id/history', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const recipientId = req.params.id;
    const recSnap = await db.collection('users').doc(uid).collection('recipients').doc(recipientId).get();
    if (!recSnap.exists) return res.json({ ok: false, error: 'Recipient not found' });
    const rec = recSnap.data();
    const allEmails = [];
    let lastDoc = null, more = true, it = 0;
    while (more && it < 60) { it++; let q = db.collection('users').doc(uid).collection('emailLog').where('recipientId', '==', recipientId).limit(500); if (lastDoc) q = q.startAfter(lastDoc); const snap = await q.get(); if (snap.empty) { more = false; break; } snap.forEach(d => allEmails.push({ id: d.id, ...d.data() })); lastDoc = snap.docs[snap.docs.length - 1]; if (snap.size < 500) more = false; }
    try { const recEmail = String(rec.email || '').toLowerCase(); const replySnap = await db.collection('users').doc(uid).collection('emailLog').where('recipientEmail','==',recEmail).limit(500).get(); const seen = new Set(allEmails.map(e=>e.id)); replySnap.forEach(d=>{ if(!seen.has(d.id)){ allEmails.push({ id: d.id, ...d.data() }); seen.add(d.id); } }); } catch(e){}
    allEmails.sort((a, b) => { const ta = a.sentAt && a.sentAt._seconds ? a.sentAt._seconds * 1000 : new Date(a.sentAt || 0).getTime(); const tb = b.sentAt && b.sentAt._seconds ? b.sentAt._seconds * 1000 : new Date(b.sentAt || 0).getTime(); return tb - ta; });
    const totalSent = allEmails.length;
    const totalOpened = allEmails.filter(e => !!e.openedAt).length;
    const totalNotOpened = totalSent - totalOpened;
    const openRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;
    res.json({ ok: true, recipient: { id: recipientId, email: rec.email, company: rec.company || '', status: rec.status || 'Pending', everOpened: rec.everOpened === true, openedAt: rec.openedAt || null, templateId: rec.templateId || '' }, stats: { totalSent, totalOpened, totalNotOpened, openRate, firstSent: allEmails.length ? allEmails[allEmails.length - 1].sentAt : null, lastSent: allEmails.length ? allEmails[0].sentAt : null }, emails: allEmails });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/recipient/:id/gmail-history', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const recipientId = req.params.id;
    const force = req.query.force === '1';
    const ck = 'history:' + uid + ':' + recipientId;
    if (!force) { const cached = cacheGet(ck); if (cached) return res.json(cached); }
    const recSnap = await db.collection('users').doc(uid).collection('recipients').doc(recipientId).get();
    if (!recSnap.exists) return res.json({ ok: false, error: 'Recipient not found' });
    const u = await getUserData(uid);
    if (!u.imapEnabled || !u.imapAppPassword) return res.json({ ok: false, error: 'Please connect your Inbox (IMAP) first', needsImap: true });
    const result = await fetchImapSentForRecipient(u.email, u.imapAppPassword, recSnap.data().email, 0);
    if (!result.ok) return res.json({ ok: false, error: result.error });
    const mfLogs = await db.collection('users').doc(uid).collection('emailLog').where('recipientId', '==', recipientId).get();
    const mfKeys = new Set();
    mfLogs.forEach(d => { const da = d.data(); const dt = da.sentAt && da.sentAt._seconds ? da.sentAt._seconds * 1000 : new Date(da.sentAt || 0).getTime(); const key = (da.subject || '').substring(0, 60).toLowerCase().trim() + '|' + Math.floor(dt / 60000); mfKeys.add(key); });
    const allGmail = result.emails || [];
    const deduped = allGmail.filter(e => { if (!e.date) return true; const dt = new Date(e.date).getTime(); const key = (e.subject || '').substring(0, 60).toLowerCase().trim() + '|' + Math.floor(dt / 60000); return !mfKeys.has(key); });
    const duplicatesRemoved = allGmail.length - deduped.length;
    const out = { ok: true, emails: deduped, count: deduped.length, duplicatesRemoved: duplicatesRemoved, totalInGmail: allGmail.length, fetchedAt: new Date().toISOString() };
    cacheSet(ck, out, CACHE_TTL.history);
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ FILES / LOGO / PROFILE ============ */
app.post('/api/upload-file', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64 || !filename) return res.json({ ok: false, error: 'Missing file data' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_FILE_SIZE) return res.json({ ok: false, error: 'Max 3MB.' });
    const fd = { base64, name: filename, mimeType: mimeType || 'application/octet-stream', size: buf.length, uploadedAt: new Date() };
    const doc = await db.collection('users').doc(req.session.user.id).collection('files').add(fd);
    res.json({ ok: true, file: { id: doc.id, name: fd.name, mimeType: fd.mimeType, size: fd.size, uploadedAt: fd.uploadedAt } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/files', authRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('files').orderBy('uploadedAt', 'desc').get(); const l = []; s.forEach(d => { const dd = d.data(); l.push({ id: d.id, name: dd.name, mimeType: dd.mimeType, size: dd.size, uploadedAt: dd.uploadedAt }); }); res.json({ ok: true, files: l }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/files/:id', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('files').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/upload-logo', authRequired, async (req, res) => {
  try {
    const { base64, mimeType, filename } = req.body;
    if (!base64) return res.json({ ok: false, error: 'No image data' });
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/svg+xml', 'image/webp'];
    if (!allowed.includes(mimeType)) return res.json({ ok: false, error: 'Invalid image type' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_LOGO_SIZE) return res.json({ ok: false, error: 'Max 2MB' });
    const uid = req.session.user.id;
    const dataUrl = 'data:' + mimeType + ';base64,' + base64;
    await db.collection('users').doc(uid).update({ logoUrl: dataUrl, logoUrlAlt: BACKEND_URL + '/logo/' + uid, logoBase64: base64, logoMimeType: mimeType });
    res.json({ ok: true, url: BACKEND_URL + '/logo/' + uid, urlAlt: dataUrl });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/remove-logo', authRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).update({ logoUrl: '', logoUrlAlt: '', logoBase64: null, logoMimeType: null }); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/logo', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); const uid = req.session.user.id; const publicUrl = d.logoBase64 ? (BACKEND_URL + '/logo/' + uid) : ''; res.json({ ok: true, url: publicUrl, urlAlt: d.logoUrl || '' }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/profile/picture', authRequired, async (req, res) => {
  try {
    const { base64, mimeType } = req.body;
    if (!base64) return res.json({ ok: false, error: 'No image provided' });
    const allowed = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
    if (allowed.indexOf(mimeType) === -1) return res.json({ ok: false, error: 'PNG/JPG/WEBP only' });
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_PROFILE_PIC_SIZE) return res.json({ ok: false, error: 'Max 1MB' });
    const url = 'data:' + mimeType + ';base64,' + base64;
    await db.collection('users').doc(req.session.user.id).update({ profilePicture: url });
    if (req.session.user) req.session.user.picture = url;
    res.json({ ok: true, url });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/profile', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, profile: { name: d.name || '', email: d.email || '', picture: d.profilePicture || '', appAccountId: d.appAccountId || '', createdAt: d.createdAt || null, lastLogin: d.lastLogin || null, hasSmtp: !!d.smtpEnabled, authType: d.authType || 'email', preferences: d.preferences || { language: 'en', timezone: 'Asia/Karachi', dateFormat: 'DD/MM/YYYY', timeFormat: '12h' } } }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/profile', authRequired, async (req, res) => {
  try { const { name } = req.body; const update = {}; if (name && typeof name === 'string') update.name = name.substring(0, 100); if (Object.keys(update).length) { await db.collection('users').doc(req.session.user.id).update(update); if (req.session.user) req.session.user.name = update.name || req.session.user.name; } res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/ai/usage', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    const [daySnap, monthSnap, totalSnap] = await Promise.all([db.collection('users').doc(uid).collection('aiUsage').doc(today).get(), db.collection('users').doc(uid).collection('aiUsage').doc('month_' + month).get(), db.collection('users').doc(uid).collection('aiUsage').doc('total').get()]);
    const day = daySnap.exists ? daySnap.data() : { calls: 0, totalTokens: 0, providers: {} };
    const mon = monthSnap.exists ? monthSnap.data() : { calls: 0, totalTokens: 0, providers: {} };
    const tot = totalSnap.exists ? totalSnap.data() : { calls: 0, totalTokens: 0, providers: {} };
    const avgPerCall = tot.calls > 0 ? Math.round(tot.totalTokens / tot.calls) : 500;
    let totalBudget = TOTAL_AI_BUDGET;
    if (!totalBudget) totalBudget = Object.values(PROVIDER_BUDGETS).reduce((a, b) => a + (b || 0), 0);
    const remainingTokens = totalBudget > 0 ? Math.max(0, totalBudget - (tot.totalTokens || 0)) : null;
    const estimatedRemainingCalls = remainingTokens !== null && avgPerCall > 0 ? Math.floor(remainingTokens / avgPerCall) : null;
    res.json({ ok: true, today: day, month: mon, total: tot, date: today, monthKey: month, avgPerCall, remainingTokens, estimatedRemainingCalls, tokenBudget: totalBudget, budgets: PROVIDER_BUDGETS });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/ai-profile', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); const p = d.aiProfile || {}; res.json({ ok: true, profile: { fullName: p.fullName || d.name || '', designation: p.designation || (d.sigFields?.pos) || '', company: p.company || (d.sigFields?.company) || '', industry: p.industry || '', tone: p.tone || 'professional', aboutMe: p.aboutMe || '', commonPhrases: p.commonPhrases || '' } }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/ai-profile', authRequired, async (req, res) => {
  try {
    const { fullName, designation, company, industry, tone, aboutMe, commonPhrases } = req.body;
    await db.collection('users').doc(req.session.user.id).update({ aiProfile: { fullName: String(fullName || '').substring(0, 100), designation: String(designation || '').substring(0, 150), company: String(company || '').substring(0, 150), industry: String(industry || '').substring(0, 100), tone: ['professional', 'friendly', 'casual', 'confident'].includes(tone) ? tone : 'professional', aboutMe: String(aboutMe || '').substring(0, 500), commonPhrases: String(commonPhrases || '').substring(0, 300), updatedAt: new Date() } });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/signature', authRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, signature: d.signature || '', fields: d.sigFields || {} }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/signature', authRequired, async (req, res) => {
  try { const u = { signature: req.body.signature || '' }; if (req.body.fields) u.sigFields = req.body.fields; await db.collection('users').doc(req.session.user.id).update(u); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ PREFS ============ */
app.get('/api/prefs', authRequired, async (req, res) => {
  try {
    const d = await getUserData(req.session.user.id);
    res.json({ ok: true, prefs: { quietEnabled: d.quietEnabled === true, quietStart: d.quietStart !== undefined ? d.quietStart : 22, quietEnd: d.quietEnd !== undefined ? d.quietEnd : 7, autoSend: d.autoSend === true, autoSendBatchSize: d.autoSendBatchSize !== undefined ? d.autoSendBatchSize : 5, appAccountId: d.appAccountId || '', totalAutoSent: d.totalAutoSent || 0, autoSendIncludeLogo: d.autoSendIncludeLogo !== false, autoSendIncludeSignature: d.autoSendIncludeSignature !== false, autoSendIncludeAttachments: d.autoSendIncludeAttachments === true, autoSendTemplateId: d.autoSendTemplateId || '', autoSendFileIds: Array.isArray(d.autoSendFileIds) ? d.autoSendFileIds : [], sendDelay: d.sendDelay !== undefined ? d.sendDelay : DEFAULT_SEND_DELAY, lastAutoSendRun: d.lastAutoSendRun || null, dailyLimit: d.dailyLimit || DEFAULT_DAILY_LIMIT } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/prefs', authRequired, async (req, res) => {
  try {
    const { quietEnabled, quietStart, quietEnd, autoSend, autoSendBatchSize, autoSendIncludeLogo, autoSendIncludeSignature, autoSendIncludeAttachments, autoSendTemplateId, autoSendFileIds, sendDelay } = req.body;
    let bs = Number(autoSendBatchSize); if (isNaN(bs) || bs < 1) bs = 5; if (bs > 500) bs = 500;
    let sd = Number(sendDelay); if (isNaN(sd) || sd < 0) sd = DEFAULT_SEND_DELAY; if (sd > 120) sd = 120;
    const update = { quietEnabled: !!quietEnabled, quietStart: Number(quietStart), quietEnd: Number(quietEnd), autoSend: !!autoSend, autoSendBatchSize: bs, sendDelay: sd, updatedAt: new Date() };
    if (autoSendIncludeLogo !== undefined) update.autoSendIncludeLogo = !!autoSendIncludeLogo;
    if (autoSendIncludeSignature !== undefined) update.autoSendIncludeSignature = !!autoSendIncludeSignature;
    if (autoSendIncludeAttachments !== undefined) update.autoSendIncludeAttachments = !!autoSendIncludeAttachments;
    if (autoSendTemplateId !== undefined) update.autoSendTemplateId = String(autoSendTemplateId || '').substring(0, 200);
    if (Array.isArray(autoSendFileIds)) update.autoSendFileIds = autoSendFileIds.map(x => String(x)).slice(0, 50);
    await db.collection('users').doc(req.session.user.id).update(update);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const ck = 'stats:' + uid;
    const cached = cacheGet(ck); if (cached) return res.json(cached);
    const [t, s, p, ts] = await Promise.all([
      db.collection('users').doc(uid).collection('recipients').count().get(),
      db.collection('users').doc(uid).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get(),
      db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').count().get(),
      db.collection('users').doc(uid).collection('emailLog').count().get()
    ]);
    let openedSends = 0;
    try { const openLogs = await db.collection('users').doc(uid).collection('emailLog').where('openedAt', '!=', null).limit(10000).get(); openedSends = openLogs.size; }
    catch (e) { const allLogs = await db.collection('users').doc(uid).collection('emailLog').limit(10000).get(); allLogs.forEach(d => { if (d.data().openedAt) openedSends++; }); }
    const out = { ok: true, stats: { total: t.data().count, sent: s.data().count, opened: openedSends, pending: p.data().count, totalSends: ts.data().count } };
    cacheSet(ck, out, CACHE_TTL.stats);
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/api/my-emails', authRequired, async (req, res) => {
  try {
    const { range, search } = req.query;
    let q = db.collection('users').doc(req.session.user.id).collection('emailLog').orderBy('sentAt', 'desc');
    if (range && range !== 'all') { const n = new Date(); let f; if (range === 'today') f = new Date(n.setHours(0, 0, 0, 0)); else if (range === '7d') f = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); else if (range === '30d') f = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); else if (range === '90d') f = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); if (f) q = q.where('sentAt', '>=', f); }
    q = q.limit(1000);
    const s = await q.get();
    let l = []; s.forEach(d => l.push({ id: d.id, ...d.data() }));
    const recSnap = await db.collection('users').doc(req.session.user.id).collection('recipients').get();
    const recMap = {}; recSnap.forEach(d => { recMap[d.id] = d.data(); });
    l = l.map(e => { const rec = e.recipientId ? recMap[e.recipientId] : null; return { ...e, recipientStatus: rec ? rec.status : (e.isReply ? 'Reply' : 'Unknown'), recipientOpenedAt: rec ? rec.openedAt : null, perSendOpened: !!e.openedAt }; });
    if (search) { const sq = search.toLowerCase(); l = l.filter(e => (e.recipientEmail || '').toLowerCase().includes(sq) || (e.subject || '').toLowerCase().includes(sq)); }
    res.json({ ok: true, emails: l });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ SEND ============ */
async function sendOne(userId, userEmail, recipientId, options) {
  options = options || {};
  const u = await getUserData(userId);
  if (!u.smtpEnabled || !u.smtpAppPassword) throw new Error('Please connect Gmail first to send emails');
  if (isQuietHours(u) && !options.force) { const e = new Error('QUIET_HOURS'); e.code = 'QUIET_HOURS'; e.quietEnd = u.quietEnd; throw e; }
  const today = new Date().toISOString().split('T')[0];
  const sdChk = await db.collection('users').doc(userId).collection('stats').doc(today).get();
  const sentToday = sdChk.exists ? (sdChk.data().sent || 0) : 0;
  const limit = u.dailyLimit || DEFAULT_DAILY_LIMIT;
  if (sentToday >= limit) { const err = new Error('DAILY_LIMIT_REACHED'); err.code = 'DAILY_LIMIT_REACHED'; err.limit = limit; throw err; }
  const r = await db.collection('users').doc(userId).collection('recipients').doc(recipientId).get();
  if (!r.exists) throw new Error('Recipient not found');
  const rec = r.data();
  if (u.lastSendTime && !options.skipDelay) {
    const l = u.lastSendTime._seconds ? u.lastSendTime._seconds * 1000 : new Date(u.lastSendTime).getTime();
    const delaySec = u.sendDelay !== undefined ? Number(u.sendDelay) : DEFAULT_SEND_DELAY;
    const delayMs = Math.max(0, delaySec * 1000);
    const jitter = Math.floor(Math.random() * 1000);
    const el = Date.now() - l;
    const mg = delayMs + jitter;
    if (el < mg) await sleep(mg - el);
  }
  let t = null;
  const templateIdToUse = options.templateId || rec.templateId;
  if (templateIdToUse) { const tt = await db.collection('users').doc(userId).collection('templates').doc(templateIdToUse).get(); if (tt.exists) t = tt.data(); else if (options.templateId) throw new Error('Selected template was not found.'); }
  if (!t) { const ts = await db.collection('users').doc(userId).collection('templates').limit(1).get(); if (!ts.empty) t = ts.docs[0].data(); }
  if (!t) throw new Error('No template available.');
  if (!t.subject || !String(t.subject).trim()) throw new Error('Template has no subject.');
  if (!t.body || !String(t.body).trim()) throw new Error('Template has no body.');
  const recipientName = (rec.company || '').split(' ')[0] || 'there';
  const recipientCompany = rec.company || '';
  const recipientEmail = rec.email || '';
  let subject = t.subject || '';
  let body = t.body || '';
  const replacements = { '{name}': recipientName, '{company}': recipientCompany, '{email}': recipientEmail, '{firstName}': recipientName };
  for (const [k, v] of Object.entries(replacements)) { subject = subject.split(k).join(v); body = body.split(k).join(v); }

  let sigHtml = '';
  const hasSignature = !!(u.signature && u.signature.trim().length > 20);
  if (hasSignature && options.includeSignature !== false) {
    let sig = u.signature;
    if (options.includeLogo === false) sig = sig.replace(/<td[^>]*>\s*<img[\s\S]*?<\/td>/gi, '').replace(/<img[^>]*>/gi, '').replace(/<td[^>]*>\s*<\/td>/gi, '');
    else sig = replaceInlineLogoWithPublicUrl(sig, userId);
    sigHtml = '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;">' + sig + '</div>';
  }
  const bodyHtml = body.replace(/\n/g, '<br>');
  const fullHtml = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">' + bodyHtml + sigHtml + '</div>';
  const lp = localAnalysis(subject, fullHtml);
  const sendTrackToken = crypto.randomBytes(16).toString('hex');

  const atts = []; const attNames = [];
  if (options.includeAttachments === true && Array.isArray(options.selectedFileIds) && options.selectedFileIds.length > 0) {
    for (const fid of options.selectedFileIds) {
      try {
        const fd = await db.collection('users').doc(userId).collection('files').doc(fid).get();
        if (fd.exists) {
          const f = fd.data();
          if (f.base64) {
            atts.push({ filename: f.name, content: Buffer.from(f.base64, 'base64'), contentType: f.mimeType || 'application/octet-stream' });
            attNames.push(f.name);
          }
        }
      } catch (fe) {}
    }
  }

  const logRef = await db.collection('users').doc(userId).collection('emailLog').add({ recipientId, recipientEmail: rec.email, company: rec.company || '', subject, sentAt: new Date(), attachmentsCount: atts.length, attachmentNames: attNames, aiPrediction: lp.prediction, aiScore: lp.score, aiInboxProb: lp.inboxProbability, sendTrackToken, openedAt: null, hasSignature: hasSignature, templateName: t.name || '', isReply: false });
  const logId = logRef.id;
  const trackUrl = BACKEND_URL + '/track/' + logId + '?u=' + userId + '&t=' + sendTrackToken;
  const pix = '<img src="' + trackUrl + '" width="1" height="1" alt="" style="border:0;display:block;width:1px;height:1px">';
  const withClickLinks = rewriteLinksForTracking(fullHtml, logId, userId, sendTrackToken);
  const finalHtml = withClickLinks + pix;

  const transporter = createTransporter(userEmail, u.smtpAppPassword);
  const mailOptions = { from: '"' + (u.name || 'MailFlow User') + '" <' + userEmail + '>', to: rec.email, subject: sanitizeSubject(subject), html: finalHtml, headers: { 'List-Unsubscribe': '<mailto:' + userEmail + '?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'Precedence': 'bulk' } };
  if (atts.length > 0) mailOptions.attachments = atts;
  await transporter.sendMail(mailOptions);
  const everOpenedFlag = rec.everOpened === true || rec.status === 'Opened';
  await db.collection('users').doc(userId).collection('recipients').doc(recipientId).update({ status: 'Sent', lastSentAt: new Date(), sentAt: new Date(), everOpened: everOpenedFlag });
  await db.collection('users').doc(userId).update({ lastSendTime: new Date() });
  const todayKey = new Date().toISOString().split('T')[0];
  const sr = db.collection('users').doc(userId).collection('stats').doc(todayKey);
  await sr.set({ sent: FieldValue.increment(1), updatedAt: new Date() }, { merge: true });
  cacheDel('quota:' + userId); cacheDel('stats:' + userId); cacheDel('recipients:' + userId);
  return { email: rec.email, attachmentsCount: atts.length };
}

app.post('/api/send', authRequired, async (req, res) => {
  try {
    const result = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, { force: req.body.force === true, skipDelay: req.body.skipDelay === true, includeSignature: req.body.includeSignature !== false, includeLogo: req.body.includeLogo !== false, includeAttachments: req.body.includeAttachments === true, selectedFileIds: req.body.selectedFileIds || [], templateId: req.body.templateId || null });
    res.json({ ok: true, email: result.email, attachmentsCount: result.attachmentsCount });
  } catch (e) {
    if (e.code === 'QUIET_HOURS') return res.json({ ok: false, error: 'QUIET_HOURS', quietEnd: e.quietEnd });
    if (e.code === 'DAILY_LIMIT_REACHED') return res.json({ ok: false, error: 'DAILY_LIMIT_REACHED', limit: e.limit });
    res.json({ ok: false, error: e.message });
  }
});
app.post('/api/resend', authRequired, async (req, res) => {
  try {
    const result = await sendOne(req.session.user.id, req.session.user.email, req.body.recipientId, { force: true, skipDelay: true, includeSignature: req.body.includeSignature !== false, includeLogo: req.body.includeLogo !== false, includeAttachments: req.body.includeAttachments === true, selectedFileIds: req.body.selectedFileIds || [], templateId: req.body.templateId || null });
    res.json({ ok: true, email: result.email, attachmentsCount: result.attachmentsCount });
  } catch (e) {
    if (e.code === 'DAILY_LIMIT_REACHED') return res.json({ ok: false, error: 'DAILY_LIMIT_REACHED', limit: e.limit });
    res.json({ ok: false, error: e.message });
  }
});

/* ============ AUTO-SEND ============ */
async function runAutoSend(uid, ue, ud) {
  if (isQuietHours(ud)) return { skipped: true };
  const bs = Number(ud.autoSendBatchSize) || 5;
  const ps = await db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').limit(bs).get();
  if (ps.empty) return { sent: 0, failed: 0 };
  let s = 0, f = 0;
  const delaySec = ud.sendDelay !== undefined ? Number(ud.sendDelay) : DEFAULT_SEND_DELAY;
  const autoFileIds = Array.isArray(ud.autoSendFileIds) ? ud.autoSendFileIds : [];
  const includeAtt = ud.autoSendIncludeAttachments === true && autoFileIds.length > 0;
  const autoTemplateId = ud.autoSendTemplateId || null;
  for (const r of ps.docs) {
    try {
      await sendOne(uid, ue, r.id, { force: true, skipDelay: true, includeSignature: ud.autoSendIncludeSignature !== false, includeLogo: ud.autoSendIncludeLogo !== false, includeAttachments: includeAtt, templateId: autoTemplateId, selectedFileIds: autoFileIds });
      s++;
      if (delaySec > 0) await sleep(delaySec * 1000 + Math.floor(Math.random() * 1000));
    }
    catch (e) { f++; if (e.code === 'QUIET_HOURS' || e.code === 'DAILY_LIMIT_REACHED') break; }
  }
  if (s > 0) await db.collection('users').doc(uid).update({ totalAutoSent: FieldValue.increment(s), lastAutoSendRun: new Date() });
  return { sent: s, failed: f };
}

app.get('/api/cron/auto-send', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : '';
    const sec = bearer || req.headers['x-cron-secret'] || req.query.secret;
    if (!CRON_SECRET || sec !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const us = await db.collection('users').where('autoSend', '==', true).get();
    let ts = 0, tu = 0, sk = 0, er = 0;
    for (const u of us.docs) { const d = u.data(); if (!d.smtpEnabled || !d.email) continue; try { const r = await runAutoSend(u.id, d.email, d); if (r.skipped) sk++; else if (r.sent > 0) { ts += r.sent; tu++; } } catch (e) { er++; } }
    res.json({ ok: true, totalSent: ts, totalUsers: tu, skipped: sk, errors: er, timestamp: new Date().toISOString() });
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

/* ============ QUOTA ============ */
app.get('/api/quota', authRequired, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const force = req.query.force === '1';
    const ck = 'quota:' + userId;
    if (!force) { const cached = cacheGet(ck); if (cached) return res.json(cached); }
    const u = await getUserData(userId);
    if (!u || !u.smtpEnabled) return res.json({ ok: false, error: 'Gmail not connected', noTokens: true });
    const today = new Date().toISOString().split('T')[0];
    const sdChk = await db.collection('users').doc(userId).collection('stats').doc(today).get();
    const mailflowSentToday = sdChk.exists ? (sdChk.data().sent || 0) : 0;
    const limit = u.dailyLimit || 500;
    let gmailSentToday = null;
    let gmailSource = 'unavailable';
    let imapAvailable = false;
    if (u.imapEnabled && u.imapAppPassword) { imapAvailable = true; try { const g = await fetchGmailSentTodayCount(u.email, u.imapAppPassword); if (g.ok) { gmailSentToday = g.count; gmailSource = 'imap_sent_folder'; } } catch (e) { } }
    let totalSentToday = mailflowSentToday;
    if (gmailSentToday !== null) totalSentToday = Math.max(mailflowSentToday, gmailSentToday);
    const remaining = Math.max(0, limit - totalSentToday);
    const out = { ok: true, sent: totalSentToday, mailflowSent: mailflowSentToday, gmailSent: gmailSentToday, gmailSource: gmailSource, imapAvailable: imapAvailable, limit: limit, remaining: remaining, timestamp: new Date().toISOString(), live: gmailSentToday !== null };
    cacheSet(ck, out, CACHE_TTL.quota);
    res.json(out);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ TEST LAB ============ */
app.get('/api/test/stats', adminRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const t = await db.collection('users').doc(uid).collection('testRecipients').count().get();
    const s = await db.collection('users').doc(uid).collection('testRecipients').where('status', 'in', ['Sent', 'Opened']).count().get();
    const p = await db.collection('users').doc(uid).collection('testRecipients').where('status', '==', 'Pending').count().get();
    const ts = await db.collection('users').doc(uid).collection('testLog').count().get();
    const allRecs = await db.collection('users').doc(uid).collection('testRecipients').limit(5000).get();
    const openedSet = new Set();
    allRecs.forEach(d => { const da = d.data(); if (da.everOpened || da.status === 'Opened') openedSet.add(d.id); });
    res.json({ ok: true, stats: { total: t.data().count, sent: s.data().count, opened: openedSet.size, pending: p.data().count, totalSends: ts.data().count } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/test/recipients', adminRequired, async (req, res) => {
  try { const s = await db.collection('users').doc(req.session.user.id).collection('testRecipients').orderBy('createdAt', 'desc').limit(500).get(); const l = []; s.forEach(d => l.push({ id: d.id, ...d.data() })); res.json({ ok: true, recipients: l }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/recipients', adminRequired, async (req, res) => {
  try {
    const { list } = req.body;
    if (!list || !list.length) return res.json({ ok: false, error: 'No recipients' });
    const batch = db.batch();
    const ref = db.collection('users').doc(req.session.user.id).collection('testRecipients');
    let a = 0;
    for (const r of list) { if (!r.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email)) continue; const doc = ref.doc(); batch.set(doc, { company: (r.company || '').trim(), email: r.email.toLowerCase(), status: 'Pending', sentAt: null, openedAt: null, everOpened: false, createdAt: new Date() }); a++; }
    await batch.commit();
    res.json({ ok: true, added: a });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/test/recipients/:id', adminRequired, async (req, res) => {
  try { await db.collection('users').doc(req.session.user.id).collection('testRecipients').doc(req.params.id).delete(); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/recipients/bulk-delete', adminRequired, async (req, res) => {
  try { const { ids } = req.body; if (!ids || !ids.length) return res.json({ ok: false }); const b = db.batch(); const r = db.collection('users').doc(req.session.user.id).collection('testRecipients'); ids.forEach(id => b.delete(r.doc(id))); await b.commit(); res.json({ ok: true, deleted: ids.length }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/clear', adminRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    let totalDeleted = 0;
    for (const coll of ['testRecipients', 'testLog']) { let more = true; while (more) { const r = await db.collection('users').doc(uid).collection(coll).limit(400).get(); if (r.empty) { more = false; break; } const b = db.batch(); r.forEach(d => b.delete(d.ref)); await b.commit(); totalDeleted += r.size; if (r.size < 400) more = false; } }
    res.json({ ok: true, deleted: totalDeleted });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/test/prefs', adminRequired, async (req, res) => {
  try { const d = await getUserData(req.session.user.id); res.json({ ok: true, prefs: { sendDelay: d.testSendDelay !== undefined ? d.testSendDelay : DEFAULT_SEND_DELAY, autoSend: d.testAutoSend === true, autoSendBatchSize: d.testAutoSendBatchSize || 5, lastRun: d.testLastAutoRun || null, totalAutoSent: d.testTotalAutoSent || 0 } }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/prefs', adminRequired, async (req, res) => {
  try { const { sendDelay, autoSend, autoSendBatchSize } = req.body; let sd = Number(sendDelay); if (isNaN(sd) || sd < 0) sd = DEFAULT_SEND_DELAY; if (sd > 120) sd = 120; let bs = Number(autoSendBatchSize); if (isNaN(bs) || bs < 1) bs = 5; if (bs > 100) bs = 100; await db.collection('users').doc(req.session.user.id).update({ testSendDelay: sd, testAutoSend: !!autoSend, testAutoSendBatchSize: bs }); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/send', adminRequired, async (req, res) => {
  try {
    const { recipientId, subject, body, to, includeSignature, includeLogo, selectedFileIds, useTestSignature } = req.body;
    const uid = req.session.user.id;
    const u = await getUserData(uid);
    if (!u.smtpEnabled || !u.smtpAppPassword) return res.json({ ok: false, error: 'Connect Gmail first' });
    const transporter = createTransporter(u.email, u.smtpAppPassword);
    let targetEmail = to;
    let recId = recipientId || '';
    if (recId) { const r = await db.collection('users').doc(uid).collection('testRecipients').doc(recId).get(); if (r.exists) targetEmail = r.data().email; }
    if (!targetEmail || !subject || !body) return res.json({ ok: false, error: 'Missing fields' });
    let sigHtml = '';
    const sigToUse = useTestSignature ? (u.testSignature || u.signature) : (u.signature || u.testSignature);
    if (sigToUse && includeSignature !== false) { let sig = sigToUse; if (includeLogo === false) sig = sig.replace(/<td[^>]*>\s*<img[\s\S]*?<\/td>/gi, '').replace(/<img[^>]*>/gi, '').replace(/<td[^>]*>\s*<\/td>/gi, ''); else sig = replaceInlineLogoWithPublicUrl(sig, uid); sigHtml = '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;">' + sig + '</div>'; }
    let pix = '';
    if (recId) { const trackTok = crypto.randomBytes(16).toString('hex'); await db.collection('users').doc(uid).collection('testRecipients').doc(recId).update({ trackToken: trackTok }); const tu = BACKEND_URL + '/track/' + recId + '?u=' + uid + '&t=' + trackTok + '&type=test'; pix = '<img src="' + tu + '" width="1" height="1" alt="" style="border:0;display:block;width:1px;height:1px">'; }
    const bodyHtml = body.replace(/\n/g, '<br>');
    const full = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">' + bodyHtml + sigHtml + pix + '</div>';
    const atts = []; const attNames = [];
    if (Array.isArray(selectedFileIds) && selectedFileIds.length > 0) { for (const fid of selectedFileIds) { try { const fd = await db.collection('users').doc(uid).collection('files').doc(fid).get(); if (fd.exists) { const f = fd.data(); if (f.base64) { atts.push({ filename: f.name, content: Buffer.from(f.base64, 'base64'), contentType: f.mimeType || 'application/octet-stream' }); attNames.push(f.name); } } } catch(fe){} } }
    const mailOptions = { from: '"' + (u.name || 'User') + '" <' + u.email + '>', to: targetEmail, subject: sanitizeSubject(subject), html: full };
    if (atts.length > 0) mailOptions.attachments = atts;
    await transporter.sendMail(mailOptions);
    await db.collection('users').doc(uid).collection('testLog').add({ recipientEmail: targetEmail, subject, body, sentAt: new Date(), recipientId: recId || '', attachmentsCount: atts.length, attachmentNames: attNames });
    if (recId) { const rec = await db.collection('users').doc(uid).collection('testRecipients').doc(recId).get(); const wasOpened = rec.exists && rec.data().everOpened === true; await db.collection('users').doc(uid).collection('testRecipients').doc(recId).update({ status: 'Sent', lastSentAt: new Date(), sentAt: new Date(), everOpened: wasOpened }); }
    cacheDel('quota:' + uid);
    res.json({ ok: true, email: targetEmail });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/test/log', adminRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const [s, recs] = await Promise.all([db.collection('users').doc(uid).collection('testLog').orderBy('sentAt', 'desc').limit(300).get(), db.collection('users').doc(uid).collection('testRecipients').get()]);
    const recById = {}; const recByEmail = {};
    recs.forEach(d => { const da = d.data(); recById[d.id] = da; if (da.email) recByEmail[String(da.email).toLowerCase()] = da; });
    const l = [];
    s.forEach(d => { const da = d.data(); const rec = recById[da.recipientId] || recByEmail[(da.recipientEmail || '').toLowerCase()] || {}; l.push({ id: d.id, ...da, openedAt: da.openedAt || rec.openedAt || null, recipientStatus: rec.status || (da.openedAt ? 'Opened' : 'Sent') }); });
    res.json({ ok: true, logs: l });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/test/automation/run', adminRequired, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const u = await getUserData(uid);
    if (!u.smtpEnabled || !u.smtpAppPassword) return res.json({ ok: false, error: 'Connect Gmail first' });
    const batchSize = Number(req.body.batchSize) || 5;
    const delay = Number(req.body.delay) || 20;
    const ps = await db.collection('users').doc(uid).collection('testRecipients').where('status', '==', 'Pending').limit(batchSize).get();
    if (ps.empty) return res.json({ ok: true, sent: 0, message: 'No pending recipients' });
    let sent = 0, failed = 0;
    const transporter = createTransporter(u.email, u.smtpAppPassword);
    for (const r of ps.docs) {
      try {
        const rec = r.data();
        const subject = 'Test Email from MailFlow Pro';
        const bodyText = 'Hello,\n\nThis is an automated test email.\n\nThank you.';
        let sig = u.testSignature || u.signature || '';
        sig = replaceInlineLogoWithPublicUrl(sig, uid);
        const bodyHtml = bodyText.replace(/\n/g, '<br>');
        const sigHtml = sig ? '<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb;">' + sig + '</div>' : '';
        const tok = crypto.randomBytes(16).toString('hex');
        await db.collection('users').doc(uid).collection('testRecipients').doc(r.id).update({ trackToken: tok });
        const tu = BACKEND_URL + '/track/' + r.id + '?u=' + uid + '&t=' + tok + '&type=test';
        const pix = '<img src="' + tu + '" width="1" height="1" alt="" style="border:0;display:block;width:1px;height:1px">';
        const full = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;line-height:1.6;">' + bodyHtml + sigHtml + pix + '</div>';
        await transporter.sendMail({ from: '"' + (u.name || 'User') + '" <' + u.email + '>', to: rec.email, subject, html: full });
        await db.collection('users').doc(uid).collection('testLog').add({ recipientEmail: rec.email, subject, body: bodyText, sentAt: new Date(), recipientId: r.id, attachmentsCount: 0 });
        const wasOpened = rec.everOpened === true;
        await db.collection('users').doc(uid).collection('testRecipients').doc(r.id).update({ status: 'Sent', sentAt: new Date(), everOpened: wasOpened });
        sent++;
        if (delay > 0 && sent < batchSize) await sleep(delay * 1000);
      } catch (e) { failed++; }
    }
    const upd = await getUserData(uid);
    await db.collection('users').doc(uid).update({ testLastAutoRun: new Date(), testTotalAutoSent: (upd.testTotalAutoSent || 0) + sent });
    cacheDel('quota:' + uid);
    res.json({ ok: true, sent, failed });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ============ ADMIN ============ */
app.get('/api/admin/dashboard', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const totalUsers = us.size;
    let totalEmails = 0, totalOpened = 0, totalPending = 0, totalSends = 0;
    for (const u of us.docs) {
      const [t, p, s] = await Promise.all([db.collection('users').doc(u.id).collection('recipients').count().get(), db.collection('users').doc(u.id).collection('recipients').where('status', '==', 'Pending').count().get(), db.collection('users').doc(u.id).collection('emailLog').count().get()]);
      totalEmails += t.data().count; totalPending += p.data().count; totalSends += s.data().count;
      const logs = await db.collection('users').doc(u.id).collection('emailLog').limit(2000).get();
      logs.forEach(d => { const da = d.data(); if (da.openedAt) totalOpened++; });
    }
    res.json({ ok: true, stats: { totalUsers, totalEmails, totalOpened, totalPending, totalSends } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/ocr-usage', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const today = new Date().toISOString().split('T')[0];
    const rows = [];
    let grandTotal = 0, grandSuccess = 0, grandFailed = 0, grandChars = 0, grandClientErrors = 0;
    for (const u of us.docs) {
      const d = u.data();
      const [daySnap, totalSnap] = await Promise.all([db.collection('users').doc(u.id).collection('ocrUsage').doc(today).get(), db.collection('users').doc(u.id).collection('ocrUsage').doc('total').get()]);
      const day = daySnap.exists ? daySnap.data() : { total: 0, success: 0, failed: 0, charsExtracted: 0, clientErrors: 0 };
      const tot = totalSnap.exists ? totalSnap.data() : { total: 0, success: 0, failed: 0, charsExtracted: 0, clientErrors: 0 };
      if ((tot.total || 0) > 0 || (tot.clientErrors || 0) > 0) {
        rows.push({ id: u.id, email: d.email, name: d.name, appAccountId: d.appAccountId || 'N/A', todayTotal: day.total || 0, todaySuccess: day.success || 0, todayFailed: day.failed || 0, todayChars: day.charsExtracted || 0, todayClientErrors: day.clientErrors || 0, todayLastError: day.lastError || '', total: tot.total || 0, success: tot.success || 0, failed: tot.failed || 0, chars: tot.charsExtracted || 0, clientErrors: tot.clientErrors || 0 });
        grandTotal += tot.total || 0; grandSuccess += tot.success || 0; grandFailed += tot.failed || 0; grandChars += tot.charsExtracted || 0; grandClientErrors += tot.clientErrors || 0;
      }
    }
    rows.sort((a, b) => (b.total + b.clientErrors) - (a.total + a.clientErrors));
    res.json({ ok: true, rows, summary: { totalUsers: us.size, activeUsers: rows.length, grandTotal, grandSuccess, grandFailed, grandChars, grandClientErrors, successRate: grandTotal > 0 ? Math.round((grandSuccess / grandTotal) * 100) : 0 } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/ocr-quota', adminRequired, async (req, res) => {
  try {
    const month = new Date().toISOString().substring(0, 7);
    const snap = await db.collection('globalStats').doc('ocrQuota_' + month).get();
    const data = snap.exists ? snap.data() : { total: 0, success: 0, failed: 0, charsExtracted: 0 };
    const used = data.total || 0;
    const remaining = Math.max(0, OCR_FREE_MONTHLY_LIMIT - used);
    const percent = Math.round((used / OCR_FREE_MONTHLY_LIMIT) * 100);
    res.json({ ok: true, month, used, remaining, limit: OCR_FREE_MONTHLY_LIMIT, percent, success: data.success || 0, failed: data.failed || 0, charsExtracted: data.charsExtracted || 0 });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/ocr-log', adminRequired, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const userFilter = req.query.user || '';
    const us = userFilter ? [await db.collection('users').doc(userFilter).get()] : (await db.collection('users').get()).docs;
    const all = [];
    for (const u of us) {
      if (!u.exists) continue;
      const d = u.data();
      const snaps = await db.collection('users').doc(u.id).collection('ocrLog').orderBy('at', 'desc').limit(200).get();
      snaps.forEach(s => {
        const dd = s.data();
        const at = dd.at && dd.at._seconds ? dd.at._seconds * 1000 : new Date(dd.at || 0).getTime();
        all.push({ id: s.id, userId: u.id, userEmail: d.email, userAppId: d.appAccountId || 'N/A', success: !!dd.success, chars: dd.chars || 0, error: dd.error || '', fileName: dd.fileName || '', isClientError: !!dd.isClientError, stage: dd.stage || '', at });
      });
    }
    all.sort((a, b) => b.at - a.at);
    res.json({ ok: true, logs: all.slice(0, limit) });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/ai-errors', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const today = new Date().toISOString().split('T')[0];
    const rows = [];
    let grandTotal = 0;
    const providerTotals = {};
    for (const u of us.docs) {
      const d = u.data();
      const snap = await db.collection('users').doc(u.id).collection('aiErrors').doc(today).get();
      if (!snap.exists) continue;
      const dd = snap.data();
      if ((dd.total || 0) === 0) continue;
      rows.push({ id: u.id, email: d.email, name: d.name, appAccountId: d.appAccountId || 'N/A', todayTotal: dd.total || 0, providers: dd.providers || {}, lastError: dd.lastError || '' });
      grandTotal += dd.total || 0;
      for (const [k, v] of Object.entries(dd.providers || {})) { providerTotals[k] = (providerTotals[k] || 0) + (typeof v === 'number' ? v : 0); }
    }
    rows.sort((a, b) => b.todayTotal - a.todayTotal);
    res.json({ ok: true, rows, summary: { date: today, grandTotal, providerTotals } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/users/paginated', adminRequired, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 15);
    const search = (req.query.search || '').toLowerCase().trim();
    const bannedSnap = await db.collection('bannedUsers').get();
    const bannedSet = new Set(bannedSnap.docs.map(d => d.id));
    const us = await db.collection('users').orderBy('createdAt', 'desc').get();
    let allUsers = [];
    for (const u of us.docs) { const d = u.data(); allUsers.push({ id: u.id, email: d.email, name: d.name, picture: d.profilePicture || '', appAccountId: d.appAccountId || 'N/A', autoSend: !!d.autoSend, totalAutoSent: d.totalAutoSent || 0, createdAt: d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate().toISOString() : d.createdAt) : '', lastLogin: d.lastLogin || null, authType: d.authType || 'email', banned: bannedSet.has(u.id), hasSmtp: !!d.smtpEnabled }); }
    if (search) allUsers = allUsers.filter(u => (u.email || '').toLowerCase().includes(search) || (u.name || '').toLowerCase().includes(search) || (u.appAccountId || '').toLowerCase().includes(search));
    const total = allUsers.length;
    const start = (page - 1) * limit;
    const users = allUsers.slice(start, start + limit);
    res.json({ ok: true, users, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/all-emails-paginated', adminRequired, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 15);
    const search = (req.query.search || '').toLowerCase().trim();
    const us = await db.collection('users').get();
    const all = [];
    for (const u of us.docs) { const d = u.data(); const es = await db.collection('users').doc(u.id).collection('emailLog').orderBy('sentAt', 'desc').limit(500).get(); es.forEach(e => { const dd = e.data(); all.push({ id: e.id, userId: u.id, userEmail: d.email, userAppId: d.appAccountId || 'N/A', recipientEmail: dd.recipientEmail, company: dd.company || '', subject: dd.subject || '', sentAt: dd.sentAt, attachmentsCount: dd.attachmentsCount || 0, aiPrediction: dd.aiPrediction || 'GOOD', aiInboxProb: dd.aiInboxProb || 75, isReply: !!dd.isReply }); }); }
    all.sort((a, b) => { const ta = a.sentAt?._seconds || 0; const tb = b.sentAt?._seconds || 0; return tb - ta; });
    let filtered = all;
    if (search) filtered = all.filter(e => (e.userEmail || '').toLowerCase().includes(search) || (e.recipientEmail || '').toLowerCase().includes(search) || (e.subject || '').toLowerCase().includes(search));
    const total = filtered.length;
    const start = (page - 1) * limit;
    const emails = filtered.slice(start, start + limit);
    res.json({ ok: true, emails, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/ai-usage', adminRequired, async (req, res) => {
  try {
    const us = await db.collection('users').get();
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    const rows = [];
    let totalToday = 0, totalMonth = 0, totalLifetime = 0, totalUsersWithAI = 0, totalCalls = 0;
    for (const u of us.docs) {
      const d = u.data();
      const [ds, ms, ts] = await Promise.all([db.collection('users').doc(u.id).collection('aiUsage').doc(today).get(), db.collection('users').doc(u.id).collection('aiUsage').doc('month_' + month).get(), db.collection('users').doc(u.id).collection('aiUsage').doc('total').get()]);
      const day = ds.exists ? ds.data() : { calls: 0, totalTokens: 0, providers: {} };
      const mon = ms.exists ? ms.data() : { calls: 0, totalTokens: 0, providers: {} };
      const tot = ts.exists ? ts.data() : { calls: 0, totalTokens: 0, providers: {} };
      if ((tot.calls || 0) > 0) totalUsersWithAI++;
      totalToday += day.totalTokens || 0; totalMonth += mon.totalTokens || 0; totalLifetime += tot.totalTokens || 0; totalCalls += tot.calls || 0;
      rows.push({ id: u.id, email: d.email, name: d.name, appAccountId: d.appAccountId || 'N/A', todayCalls: day.calls || 0, todayTokens: day.totalTokens || 0, monthCalls: mon.calls || 0, monthTokens: mon.totalTokens || 0, totalCalls: tot.calls || 0, totalTokens: tot.totalTokens || 0, totalProviders: tot.providers || {} });
    }
    rows.sort((a, b) => (b.totalTokens || 0) - (a.totalTokens || 0));
    let totalBudget = TOTAL_AI_BUDGET;
    if (!totalBudget) totalBudget = Object.values(PROVIDER_BUDGETS).reduce((a, b) => a + (b || 0), 0);
    const remainingTokens = totalBudget > 0 ? Math.max(0, totalBudget - totalLifetime) : null;
    const avgPerCall = totalCalls > 0 ? Math.round(totalLifetime / totalCalls) : 500;
    const estimatedRemainingCalls = remainingTokens !== null && avgPerCall > 0 ? Math.floor(remainingTokens / avgPerCall) : null;
    res.json({ ok: true, rows, summary: { totalUsers: us.size, activeAIUsers: totalUsersWithAI, tokensToday: totalToday, tokensThisMonth: totalMonth, tokensLifetime: totalLifetime, totalCalls, remainingTokens, estimatedRemainingCalls, tokenBudget: totalBudget, budgets: PROVIDER_BUDGETS, monthKey: month, date: today } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/admin/user/:id/ban', adminRequired, async (req, res) => {
  try {
    const uid = req.params.id;
    const { reason, banIP } = req.body || {};
    const target = await db.collection('users').doc(uid).get();
    if (!target.exists) return res.json({ ok: false, error: 'User not found' });
    const data = target.data();
    if ((data.email || '').toLowerCase() === ADMIN_EMAIL) return res.json({ ok: false, error: 'Cannot ban admin' });
    await db.collection('bannedUsers').doc(uid).set({ uid, email: data.email || '', name: data.name || '', appAccountId: data.appAccountId || '', reason: String(reason || 'Violation of terms').substring(0, 500), ip: banIP ? (data.lastIP || data.firstIP || 'unknown') : '', bannedAt: new Date(), bannedBy: req.session.user.email });
    res.json({ ok: true, banned: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/admin/user/:id/unban', adminRequired, async (req, res) => {
  try { await db.collection('bannedUsers').doc(req.params.id).delete(); res.json({ ok: true, unbanned: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/banned-users', adminRequired, async (req, res) => {
  try { const snap = await db.collection('bannedUsers').orderBy('bannedAt', 'desc').get(); const banned = []; snap.forEach(d => banned.push({ id: d.id, ...d.data() })); res.json({ ok: true, banned }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/access-requests', adminRequired, async (req, res) => {
  try { const snap = await db.collection('accessRequests').orderBy('requestedAt', 'desc').limit(200).get(); const requests = []; snap.forEach(d => requests.push({ id: d.id, ...d.data() })); res.json({ ok: true, requests }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/admin/access-requests/:id/approve', adminRequired, async (req, res) => {
  try {
    const ref = db.collection('accessRequests').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ ok: false, error: 'Not found' });
    const reqData = snap.data();
    if (reqData.oldEmail && reqData.oldEmail !== reqData.email) { const oldUid = emailUid(reqData.oldEmail); await db.collection('bannedUsers').doc(oldUid).delete().catch(() => { }); }
    const newUid = emailUid(reqData.email);
    await db.collection('bannedUsers').doc(newUid).delete().catch(() => { });
    await ref.update({ status: 'approved', approvedAt: new Date(), approvedBy: req.session.user.email });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.post('/api/admin/access-requests/:id/reject', adminRequired, async (req, res) => {
  try { const { reason } = req.body || {}; await db.collection('accessRequests').doc(req.params.id).update({ status: 'rejected', rejectReason: String(reason || '').substring(0, 500), rejectedAt: new Date(), rejectedBy: req.session.user.email }); res.json({ ok: true }); } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.get('/api/admin/user/:id/details', adminRequired, async (req, res) => {
  try {
    const uid = req.params.id;
    const d = await db.collection('users').doc(uid).get();
    if (!d.exists) return res.json({ ok: false, error: 'Not found' });
    const data = d.data();
    const banned = await db.collection('bannedUsers').doc(uid).get();
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    const [t, s, p, sd, aiT, aiM, aiAll, ocrT, ocrAll] = await Promise.all([
      db.collection('users').doc(uid).collection('recipients').count().get(),
      db.collection('users').doc(uid).collection('recipients').where('status', 'in', ['Sent', 'Opened']).count().get(),
      db.collection('users').doc(uid).collection('recipients').where('status', '==', 'Pending').count().get(),
      db.collection('users').doc(uid).collection('emailLog').count().get(),
      db.collection('users').doc(uid).collection('aiUsage').doc(today).get(),
      db.collection('users').doc(uid).collection('aiUsage').doc('month_' + month).get(),
      db.collection('users').doc(uid).collection('aiUsage').doc('total').get(),
      db.collection('users').doc(uid).collection('ocrUsage').doc(today).get(),
      db.collection('users').doc(uid).collection('ocrUsage').doc('total').get()
    ]);
    const logs = await db.collection('users').doc(uid).collection('emailLog').limit(2000).get();
    let openedSends = 0; logs.forEach(x => { if (x.data().openedAt) openedSends++; });
    const aiUsage = { today: aiT.exists ? (aiT.data().totalTokens || 0) : 0, todayCalls: aiT.exists ? (aiT.data().calls || 0) : 0, month: aiM.exists ? (aiM.data().totalTokens || 0) : 0, monthCalls: aiM.exists ? (aiM.data().calls || 0) : 0, total: aiAll.exists ? (aiAll.data().totalTokens || 0) : 0, calls: aiAll.exists ? (aiAll.data().calls || 0) : 0, providers: aiAll.exists ? (aiAll.data().providers || {}) : {} };
    const ocrUsage = { todayTotal: ocrT.exists ? (ocrT.data().total || 0) : 0, todaySuccess: ocrT.exists ? (ocrT.data().success || 0) : 0, todayFailed: ocrT.exists ? (ocrT.data().failed || 0) : 0, todayClientErrors: ocrT.exists ? (ocrT.data().clientErrors || 0) : 0, totalTotal: ocrAll.exists ? (ocrAll.data().total || 0) : 0, totalSuccess: ocrAll.exists ? (ocrAll.data().success || 0) : 0, totalFailed: ocrAll.exists ? (ocrAll.data().failed || 0) : 0, totalClientErrors: ocrAll.exists ? (ocrAll.data().clientErrors || 0) : 0, totalChars: ocrAll.exists ? (ocrAll.data().charsExtracted || 0) : 0 };
    res.json({ ok: true, user: { id: uid, email: data.email, name: data.name, picture: data.profilePicture || '', appAccountId: data.appAccountId || 'N/A', createdAt: data.createdAt ? (data.createdAt.toDate ? data.createdAt.toDate().toISOString() : data.createdAt) : null, lastLogin: data.lastLogin ? (data.lastLogin.toDate ? data.lastLogin.toDate().toISOString() : data.lastLogin) : null, authType: data.authType || 'email', hasSmtp: !!data.smtpEnabled, hasImap: !!data.imapEnabled, autoSend: !!data.autoSend, banned: banned.exists, banReason: banned.exists ? banned.data().reason : '', aiUsage, ocrUsage, stats: { total: t.data().count, sent: s.data().count, opened: openedSends, pending: p.data().count, totalSends: sd.data().count } } });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});
app.delete('/api/admin/user/:id', adminRequired, async (req, res) => {
  try {
    const uid = req.params.id;
    if (!uid) return res.json({ ok: false, error: 'Missing user ID' });
    const target = await db.collection('users').doc(uid).get();
    if (!target.exists) return res.json({ ok: false, error: 'User not found' });
    const email = (target.data().email || '').toLowerCase();
    if (email === ADMIN_EMAIL) return res.json({ ok: false, error: 'Cannot delete admin account' });
    const subcollections = ['recipients', 'templates', 'emailLog', 'files', 'stats', 'senderMemory', 'imapEmails', 'testRecipients', 'testLog', 'aiUsage', 'replyLog', 'ocrUsage', 'ocrLog', 'aiErrors'];
    for (const coll of subcollections) { let more = true; while (more) { const snap = await db.collection('users').doc(uid).collection(coll).limit(400).get(); if (snap.empty) { more = false; break; } const b = db.batch(); snap.forEach(d => b.delete(d.ref)); await b.commit(); if (snap.size < 400) more = false; } }
    await db.collection('users').doc(uid).delete();
    await db.collection('bannedUsers').doc(uid).delete().catch(() => { });
    res.json({ ok: true, deleted: true, email });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.use((err, req, res, next) => { console.error('Unhandled:', err.message); if (res.headersSent) return next(err); res.status(500).json({ ok: false, error: 'Internal server error' }); });
app.use((req, res, next) => { if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/auth') && !req.path.startsWith('/track') && !req.path.startsWith('/click') && !req.path.startsWith('/logo')) { return res.sendFile(path.join(__dirname, 'public', 'index.html')); } next(); });

if (process.env.VERCEL) { module.exports = app; } else { app.listen(PORT, () => console.log('✅ MailFlow Pro v' + APP_VERSION + ' running on port ' + PORT)); }