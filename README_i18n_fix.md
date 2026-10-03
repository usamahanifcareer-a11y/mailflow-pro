# MailFlow Pro — Fixes & Features Log

Ye file har round ke kaam ka record rakhti hai. Brand naam **"MailFlow Pro"** hai
(domain/Vercel project safe — kabhi nahi badla gaya).

---

## ROUND 3 — Inbox Deliverability + Limits + Tracking (latest)

### 1. 📬 Inbox deliverability — email spam mein na jaye

**Sab se bara fix:** email pehle **sirf HTML** ja rahi thi. Spam filters HTML-only
email ko shak ki nazar se dekhte hain.

**Ab har email mein plain-text version bhi jata hai** (multipart/alternative):

| Send path | Pehle | Ab |
|---|---|---|
| Main send (`/api/send`) | HTML only | ✅ HTML + plain-text |
| Resend (`/api/resend`) | HTML only | ✅ HTML + plain-text |
| Inbox reply (`/api/inbox/reply`) | HTML only | ✅ HTML + plain-text |
| Test Lab send | HTML only | ✅ HTML + plain-text |
| Test automation | HTML only | ✅ HTML + plain-text |

Plain-text mein link URLs `text (https://url)` form mein hote hain — ye
deliverability ke liye behtar hai. Saath ek chhota footer:
```
--
<Naam>
<Email>

Is email ko aapne <Naam> se receive kiya.
Privacy Policy: https://mailflowpro.dpdns.org/privacy
Unsubscribe: is email ka reply karein aur subject mein "unsubscribe" likh dein.
```

**Pehle se maujood (verify kiya, acha hai):**
- `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers
- `Precedence: bulk`
- Unique `X-Entity-Ref-ID` (thread merge nahi hota)
- `Message-ID` auto (nodemailer)
- Tracking pixel pe `no-store, no-cache, must-revalidate` (Gmail cache nahi kar sakta → har open count hota hai)

### 2. 📊 Inbox Score checker (naya)

- **Naya endpoint:** `POST /api/deliverability/check` → `{score, label, issues[]}`
- **Naya UI button:** Composer mein **"📬 Inbox Check"**
- Ye check karta hai: spam trigger words, CAPS subject, `!!!`, plain-text missing,
  zyada images, images mein `alt` missing, **URL shorteners (bit.ly wagera)**,
  zyada links, `<script>`/`<iframe>`/`onclick`, HTML structure.
- **Har bheji gayi email ka score save hota hai** → `emailLog` mein
  `deliverabilityScore`, `deliverabilityLabel`, `deliverabilityIssues`.

### 3. 📈 Per-user Daily Limit (ab user set kar sakta hai)

**Masla:** `dailyLimit` per-user tha aur enforce bhi hota tha — **lekin user use set
nahi kar sakta tha!** `/api/prefs` mein accept hi nahi hota tha, UI mein input hi
nahi thi. Is liye hamesha 500 hi rehta tha.

**Ab:**
- `POST /api/prefs` `dailyLimit` accept karta hai (1–5000, clamp kiya hua)
- Quick Automation panel mein **"📊 Daily Send Limit"** input
- Live hint: 500 tak ✅ safe, 500+ pe ⚠️ warning, 2000+ pe ⚠️ strong warning
- Auto-send limit poora hone pe **khud ruk jata hai** (`DAILY_LIMIT_REACHED`)

Aap 150 chaahein to 150 — wahi jayengi. Zyada chaahein to barha dein.

### 4. ⏰ Send Window (naya — "sirf in ghanton mein bhejo")

- Quick Automation mein **"⏰ Send Only During These Hours"** toggle + From/To time
- `sendWindowEnabled`, `sendWindowStart`, `sendWindowEnd` — server side save/load
- Auto-send window ke bahar ho to `{skipped:true, reason:'outside_send_window'}`
- Quiet Hours ke saath kaam karta hai (dono alag hain)

### 5. 🔴 Cron 60-second timeout FIX (aapki asli fikar)

**Masla (pehle):** `/api/cron/auto-send` saare users ek hi request mein handle karta
tha, aur har recipient ke baad `sendDelay` wait hota tha. Vercel ki limit 60s hai:
> 5 recipients × 20s = 100s → **timeout → us user ka auto-send beech mein mar jata**

**Ab:**
- `CRON_BUDGET_MS = 42000` (42 second ka budget — 60s se pehle safely nikal jate hain)
- Har user se pehle deadline check → waqt khatam to **safai se ruk jata hai** (adhoora kaam nahi)
- `runAutoSend(uid, ue, ud, {deadline})` — batch ke beech mein bhi deadline check hota hai
- Delay se pehle bhi check: agar delay se deadline cross hogi to delay skip
- Response mein `elapsedMs`, `budgetMs`, aur `details:[{stopped:'time_budget'}]`
- **Baqi kaam agli hourly run pe khud ho jata hai** (recipients Pending rehte hain)

### 6. Tracking (verify kiya — pehle se strong hai)

- 3-layer bot filter: real browser UA / Google proxy / known bots
- 15s early-prefetch ignore, 60s reopen gap, sender self-view ignore
- `openCount` + `reopenCount` — **har open count hota hai**
- Click tracking: click hua = guaranteed open
- Pixel anti-cache headers sahi hain (Gmail cache nahi kar sakta)

---

## ROUND 2 — Speed, Mobile, Logo

- **Language switch instant:** `localStorage` pref cache (`mf_prefs_v1`) + UI pehle
  badalta hai, server background mein save karta hai (fail pe revert)
- **`applyI18n()` optimized:** sirf woh elements likhta hai jin ki value waqai badli
  ho (`_mfI18nKey`/`_mfI18nLang` yaad rakhta hai) + `requestAnimationFrame` batching.
  Pehle har baar 328 elements re-paint hote the — **yahi "language change slow" ka
  asli sabab tha**
- **Mobile rendering:** `content-visibility: auto` (off-screen lists),
  `touch-action: manipulation`, iOS momentum scroll, lazy images
- **Naya media query** (`max-height: 700px`) — chhote phone pe login card poora fit
- **Naya logo:** paper plane + envelope fold, gradient; login + topbar + favicon
  (inline SVG data-URI) — 12px se 96px tak test kiya
- **Mobile layout verified** (headless Chrome, real DOM measurement) — 320/360/390/414/768/1280
  sab pe **0 overflow**, koi horizontal scroll nahi

---

## ROUND 1 — Language (i18n) Fix

**Asli bug:** `applyI18n()` aur `t()` bilkul theek the — **dictionary khaali thi**.

| Language | Pehle | Ab |
|---|---|---|
| `en` | ✅ 329 | ✅ 342 |
| `ur-roman` | ⚠️ sirf **108** | ✅ **346 (0 missing)** |
| `ur` `hi` `ar` `es` `fr` | ❌ khaali `{}` | ⚠️ English fallback (blank/crash nahi) |

- **Nayi file `public/i18n-data.js`** — complete Roman Urdu + merge logic + `try/catch`
  (fail ho to app normal chalti rahe)
- `index.html` head mein `<script src="/i18n-data.js">` (main script se pehle)
- `machine` status label ab translatable

---

## Verification (har round mein chalaya)

```
server.js            : node --check OK
public/i18n-data.js  : node --check OK
index.html inline JS : ALL JS OK (2 blocks)
EN keys              : 342
ur-roman keys        : 346  |  missing: 0
data-i18n total      : 336  |  not in en: 0
helper test          : plainText OK, spam email score 0/100, good email 85/100
endpoint test        : /api/deliverability/check -> 401 (exists, auth required)
UI test (headless)   : qDailyLimit / qWindowEnabled / qWindowStart / qWindowEnd all present
```

---

## Baqi pending (imaandar list)

1. **`ur` / `hi` / `ar` / `es` / `fr` ki asli translations** — abhi English dikhate
   hain (safe fallback, bug nahi). Ek-ek language add ho sakti hai.
2. **Gmail warmup / ramp-up** — naye Gmail account se achanak 500 emails bhejna spam
   risk hai. Recommended: pehle hafta 20-50/din, phir barhana. Abhi manual hai
   (Daily Limit se control karein).
3. **`getUserData()`** poora user document (including `logoBase64`) memory mein laata
   hai — performance optimization baqi hai.
4. **DKIM/SPF/DMARC** — Gmail App Password se bhejne pe Gmail khud sign karta hai,
   is liye custom domain ki zaroorat nahi. Agar kabhi custom domain email use karein
   to ye setup karna hoga.

---

## Cron setup (cron-job.org) — kabhi nahi badla

```
URL      : https://mailflowpro.dpdns.org/api/cron/auto-send
Method   : GET
Header   : x-cron-secret: <CRON_SECRET>
Schedule : 0 * * * *   (har ghante)
Timezone : Asia/Karachi
```
Server `x-cron-secret` header **aur** `Authorization: Bearer <secret>` dono accept
karta hai. `?secret=` query deprecated hai (kaam karta hai lekin header behtar hai).
