# MailFlow Pro — Fixes & Features Log

Ye file har round ke kaam ka record rakhti hai. Brand naam **"MailFlow Pro"** hai
(domain/Vercel project safe — kabhi nahi badla gaya).

---

## ROUND 8 — Timezone Fix + Gmail-jaisa Schedule UI (latest)

### 1. 🕐 ASLI BUG: "7 AM chuna, 12 PM dikha" — timezone
**Wajah:** frontend sirf **hour number** (7) bhejta tha. Server usay **apni
timezone** mein set karta tha. Vercel **UTC** pe chalta hai, user **PKT (UTC+5)** —
is liye **5 ghante ka farq** (7 AM → 12 PM).

**Fix:** frontend ab **poora ISO timestamp** bhejta hai:
```js
scheduleAt: new Date(pickedMs).toISOString()   // "2026-10-04T02:00:00.000Z"
timezone: Intl.DateTimeFormat().resolvedOptions().timeZone   // "Asia/Karachi"
```
Server usay **bilkul waisa hi** store karta hai (`new Date(iso)`) → **koi timezone
masla nahi**, kisi bhi server timezone pe.
Purana `sendAtHour` bhi chalta rahega (backward compatible).

**Test se confirm:**
```
user picks      : 7:00 AM PKT (4 Oct)
payload sent    : {"scheduleAt":"2026-10-04T02:00:00.000Z","timezone":"Asia/Karachi"}
server stores   : 2026-10-04T02:00:00.000Z  (exact same moment)
client dekhay   : 4 Oct 2026, 7:00 am       ✅ EXACT MATCH
```

### 2. 📅 Naya Schedule UI (Gmail se behtar)
Pehle: sirf 24 hour-chips (`12 AM`, `1 AM`, ...). Ab:

- **⚡ 6 Quick presets:** `⏱ +1 ghanta` · `⏱ +3 ghante` · `🌅 Kal subah 9` ·
  `☀️ Kal 12 baje` · `🌆 Kal 6 baje` · `🌙 Aaj raat 9`
- **📅 Date picker + 🕐 Time picker** — koi bhi exact waqt
- **Live preview:** `📅 4 Oct 2026, 7:00 am · 142m 50s baaki`
- **🌍 Timezone line:** `Aapki timezone: Asia/Karachi`
- **Past-time guard:** guzra hua waqt chunein to warning
- Purane 24 hour-chips bhi maujood hain (chip dabane se date/time khud set ho jate hain)
- **Scheduled Batches list** mein countdown + template name

### 3. 🔔 Toast bug: "Gmail se live count aa gaya: 0"
Toast jhoot bol raha tha (0 pe bhi "aa gaya" keh raha tha).
**Ab:** `✅ 0 email aaj Gmail ke Gmail Sent folder mein · total 0/500 · 500 baaki`
Aur agar live nahi to seedha diagnose chalta hai.

### Note: language bug nahi tha
"English save karne pe Urdu Roman" — browser test se **verify kiya**, language
**sahi** save ho rahi hai (`CL="en"`, button `📤 Login`, `dir=ltr`). Purana test
assertion ghalat tha. Ab language 7/7 sahi chalti hai.

---

## ROUND 7 — Duplicate Clock, Admin Tables, AI Error Spam

### 1. 🐛 "⏰ ⏰ Scheduled" — duplicate clock emoji
**Wajah:** `getRecipientStatus()` icon **aur** label dono mein clock tha:
```js
{icon:'⏰', lbl:t('optScheduled')}   // optScheduled tha "⏰ Scheduled"
```
Badge builder dono render karta hai → **⏰ ⏰ Scheduled**.
**Fix:** label se emoji hataya (dono EN + Roman Urdu).

### 2. 👥 Admin "Per-User OCR Usage" table
- **"U" avatar circle hataya** — ab sirf email dikhta hai (saaf)
- **Headers clear kiye** + tooltips:
  `USER · APP ID · TODAY · SUCCESS · FAILED · CLIENT ERR · ALL TIME · RATE`
  (pehle confusing the: `✓ ✗ Client All Succ`)

### 3. ⚠️ AI Provider Errors — "No OmniRoute config" spam (asli bug)
**Wajah:** AI fallback chain har call pe **saare** providers try karti hai. Jin ka key
nahi hota (jaise OmniRoute) unka `"No OmniRoute config"` message
`logAIError` se **error** ban ke count hota tha — is liye admin panel mein
bewajah errors bharte rehte the.
**Fix:** aise messages ab **`configSkips`** mein jate hain, `total` errors mein
**nahi**. Admin panel mein alag line:
> ℹ️ Config missing (error nahi): 2 calls skipped `omniroute: 2`

### 4. 🐛 2 aur "Invalid Date" bugs (audit se mile)
| Jagah | Pehle | Ab |
|---|---|---|
| Admin OCR log table | `new Date(l.at)` (Firestore Timestamp) | `toMs(l.at)` |
| Profile "Registered" date | `new Date(p.createdAt)` | `toMs(p.createdAt)` |

### 5. 🌐 Language files update
`optScheduled` key 5 languages mein add hui:
`شیڈول شدہ` · `शेड्यूल किया` · `مجدول` · `Programado` · `Programmé`

### Full code audit (chalaya gaya)
```
A) icon/lbl duplicate emojis .......... saaf (8 badges check kiye)
B) new Date() on Firestore timestamps . none found — OK
C) data-i18n keys missing in EN ....... 0 missing (337 total)
D) duplicate HTML ids ................. none
E) language files key coverage ........ 344 keys each, naye keys add
F) server risky new Date() ............ sirf lastAutoSendRun (try/catch mein)
G) syntax: server.js / i18n-data.js / 5 languages / index.html -> sab OK
```

---

## ROUND 6 — Scheduled System + Quota Diagnose

### 1. 🐛 "Invalid Date" fix (Scheduled Batches)
**Wajah:** Firestore `Timestamp` object (`{_seconds,...}`) ko seedha `new Date()` diya
ja raha tha — JavaScript isay parse nahi kar sakta → **Invalid Date**.
**Fix:** `toMs(s.scheduledFor)` helper (jo `_seconds`/`seconds`/ISO sab handle karta
hai) + graceful fallback "Date missing" / "next occurrence".
**Do jagah fix hui:** Scheduled Batches list aur bulk-schedule toast.

### 2. ⏰ Scheduled emails ka sahi status
**Wajah:** `/api/bulk/schedule` recipients ko mark hi nahi karta tha — is liye
Recipient Tracking mein **galat status** dikhta tha aur schedule ka koi nishan nahi tha.

**Ab poora system:**

| Kab | Recipient status |
|---|---|
| Schedule banate waqt | **`Scheduled`** (naya purple badge ⏰) |
| Scheduled waqt aane pe | `sendOne` chalta hai → **`Sent`** |
| Receiver khole to | **`Opened`** |
| Schedule cancel/delete karein | wapas **`Pending`** (ya `Sent`/`Opened` agar pehle bhej chuke) |

Ek recipient **kai batches** mein ho sakta hai — `scheduledBatchIds` array se track
hota hai, aur jab aakhri batch chal jaye tab hi status badalta hai.

### 3. 🔒 Duplicate send se bachao (atomic claim)
**Bug:** `/api/scheduled/check` (client) aur **cron** dono ek hi batch utha sakte the
→ **duplicate emails**.
**Fix:** `claimBatch()` — Firestore transaction se batch `pending → processing` hota
hai. Sirf **ek** processor jeetta hai, doosra chup chaap chhod deta hai.

### 4. 📊 Quota diagnose (ab exact wajah pata chalti hai)
Naya endpoint `GET /api/quota/diagnose` + UI mein link.
Ye step-by-step batata hai:
- SMTP connected hai ya nahi
- IMAP (Inbox) connected hai ya nahi
- MailFlow counter kitna hai
- Gmail Sent folder **padha ja saka ya nahi** (aur error kya aaya)
- Kitna waqt laga (ms)

Hint mein link aata hai: **(wajah dekhein)** / **(check karein)** — click karne pe
poori tafseel. "Sync now" bhi ab khud diagnose chala deta hai jab count na aaye.

`/api/bulk/schedules` ab `templateName`, `recipientCount`, `scheduledForMs` bhi
return karta hai → list mein **template ka naam** aur **"2h 15m baaki"** countdown
dikhta hai.

### 5. 📋 Recipient History mein scheduled banner
Recipient click karne pe history modal mein purple banner:
*"⏰ Scheduled — 2 batches"* + har batch ka waqt + baaki waqt + status. Saath saaf
likha hota hai: *"Ye emails abhi bheji nahi gayin — scheduled waqt pe khud chali
jayengi."*
Naya endpoint: `GET /api/recipient/:id/schedules`

### 6. 🎨 Recipient Tracking table
- Naya **⏰ Scheduled** badge (purple) + filter dropdown mein "Scheduled" option
- Scheduled recipients ki row mein **"Last Sent"** column ki jagah **scheduled waqt**
  (`⏰ 3 Oct, 7:00 PM`) dikhta hai
- Scheduled recipients ke liye 📤 Send / 🔁 Resend ki jagah **⏰ (View Schedules)**
  button — ghalti se turant bhejne se bachao

### Verified
```
Routes (401 = exists + auth required):
  /api/quota/diagnose            OK
  /api/bulk/schedules            OK
  /api/recipient/:id/schedules   OK
  /api/recipients?status=scheduled OK
  /api/bulk/schedule             OK
  /api/scheduled/check           OK
UI: optScheduled, scheduled filter, badge.scheduled, toMs fix,
    scheduled banner, template name, countdown, scheduled button -> sab OK
syntax: server.js OK, i18n-data.js OK, ur/hi/ar/es/fr OK, index.html JS OK
```

---

## ROUND 5 — Live Quota + Har Open Count

### 1. 📊 Live Quota — ab sach mein live hai

**Pehle kyun 0 rehta tha (2 bugs):**

| # | Bug | Asar |
|---|---|---|
| 1 | `fetchGmailSentTodayCount` mein `mailboxOpen(f)` **bina `{readOnly:true}`** | Gmail folder theek se nahi khulta |
| 2 | `search({since: date})` Gmail pe **unreliable** hai | Aaj ke bheje emails miss ho jate hain → count 0 |
| 3 | Frontend `/api/quota` **kabhi `force=1` nahi** bhejta tha | 30s ka purana cache hi dikhta rehta |

**Ab:**
- `mailboxOpen(f, {readOnly:true})` — safe read
- **3-level search fallback:** `gmraw` (X-GM-RAW — Gmail ka asli search, sab se
  reliable) → `since` → `all + internalDate filter` (aakhri 400 emails se aaj ke
  ginte hain)
- Frontend **har 15 second** poll karta hai; **55s se purana ho to `force=1`** se
  asli IMAP sync karta hai
- **"🔄 Sync now"** button — foran sync
- Hint mein **sync age** dikhta hai: *"✅ Live — Gmail Sent folder se sync hua (4s ago).
  Manual sends bhi count ho rahe hain."*
- Server pe per-user IMAP cache 60s (IMAP call mehnga hai, Vercel slow na ho)

### 2. 📧 Manual Gmail sends bhi count hote hain
Gmail ke **Sent folder** se aaj ka count aata hai — is liye jo email aap ne **Gmail
app / phone / website se manually** bheji ho, wo bhi total mein aa jati hai.
`Total = max(MailFlow sends, Gmail Sent count)` — double counting nahi hoti.

> Agar Inbox (IMAP) connect nahi hai to sirf MailFlow sends count honge, aur card
> saaf saaf batayega: *"⚠️ Sirf MailFlow sends count ho rahe hain. Manual Gmail sends
> count karne ke liye Inbox (IMAP) connect karein."*

### 3. 👁 Har open count — lekin aap khud kholein to NAHI

**Pehle:** `openCount` sirf **pehle** open pe barhta tha; dobara kholne pe `reopenCount`
alag barhta tha → UI mein 1 hi dikhta tha.

**Ab:** `openCount` **HAR asli open** pe barhta hai (teeno tracking paths mein), aur
`firstOpenAt` alag save hota hai. Matlab — email 5 baar khuli to **5 count** hoga.

**Aur aap khud khol rahe hain to count nahi hoga** — 8 guards:

| Guard | Kya karta hai |
|---|---|
| Session owner | Aap logged in ho aur wahi email kholo → skip |
| Referer | MailFlow UI se aayi request → skip |
| Sender IP | Aapka IP = sender ka IP → skip |
| Sender IP+UA | IP + browser dono match → skip |
| Sender active | Aap 10 min se active ho + email 5 min purani → self-view samajh ke skip |
| Known bots | Gmail proxy, scanners, prefetchers → ignore |
| Delivery prefetch | Send ke 15s ke andar aaya hit → ignore |
| Reopen gap | 60s ke andar dobara hit → ignore (double-count nahi) |

### Verification (chalaya gaya)
```
Gmail count function (fake IMAP client, 6 tests):
  gmraw works            -> count 5,  method=gmraw        OK
  gmraw fail -> since    -> count 3,  method=since        OK
  dono fail -> date_filter -> sirf aaj ke (kal wala exclude) OK
  no Sent folder         -> {ok:false, error}             OK
  readOnly flag passed   -> {"readOnly":true}             OK
  folder fallback order  -> Sent Mail > Sent > Sent       OK

Self-open guards  : 9/9 maujood (track), 3/3 (click)
openCount paths   : 3/3 har open pe barhta hai
Quota UI elements : 9/9 present + live badge + 15s tick + Sync now
syntax            : server.js OK, index.html JS OK
```

### `/api/quota` response (ab)
```json
{ "ok":true, "sent":11, "mailflowSent":4, "gmailSent":11,
  "gmailSource":"gmraw", "gmailError":null, "imapAvailable":true,
  "limit":500, "remaining":489, "usedPercent":2,
  "lastSyncAt":"...", "syncMs":1240, "live":true }
```

---

## ROUND 4 — Saari 7 Languages

### Ab poora UI 6 zabanon mein
| Language | Keys | Direction |
|---|---|---|
| English | 343 | LTR |
| Roman Urdu | 347 | LTR |
| اردو | 343 | **RTL** |
| हिन्दी | 343 | LTR |
| العربية | 343 | **RTL** |
| Español | 343 | LTR |
| Français | 343 | LTR |

Sab 343/343 — **0 missing, 0 extra**, emojis/HTML tags/`{name}` placeholders 100%
preserved (script se verify kiya).

### Architecture — lazy loading (speed barqarar)
- Roman Urdu **inline** hai `i18n-data.js` mein → **zero extra request**
- Baqi 5 languages alag files: `public/i18n/<lang>.js` → **sirf chuni hui language
  download hoti hai** (~16-24KB)
- `window.mfApplyLanguage(lang)` → file load kar ke apply karta hai
- `window.mfPrefetchLanguage(lang)` → page khulte hi eagerly load (login screen bhi
  sahi bhasha mein khulta hai)
- File load fail ho jaye to app English pe chalti rehti hai — **crash nahi**

### RTL support
`اردو` aur `العربية` select karne pe `document.documentElement.dir = "rtl"` set hota
hai, LTR pe wapas `ltr`.

### 2 asli bugs jo is round mein pakre aur fix hue

**BUG A — Login screen pe language apply nahi hoti thi**
`applyI18n()` sirf `enterApp()` (login ke baad) se call hota tha. Is liye login
screen hamesha English mein dikhti thi. **Fix:** `DOMContentLoaded` pe bhi
`applyI18n()` call hota hai + `i18n-data.js` cached language eagerly load karta hai.

**BUG B — Language file load hone ke baad UI update nahi hota tha**
`applyI18n()` ke paas marker tha: `if(el._mfI18nKey===k && el._mfI18nLang===CURRENT_LANG) skip`.
DOMContentLoaded pe dictionary **abhi English** hoti thi → button "Login" set hota aur
marker lag jata. Jab asli language file load hoti, marker ki wajah se **skip** ho jata
→ English hi reh jata.
**Fix:** `mfLangVersion(lang)` counter — jab bhi asli dictionary load hoti hai to
version barhta hai. Marker mein `_mfI18nVer` bhi check hota hai, is liye file load
hone ke baad saare elements **dobara likhe jate hain**. Saath `_i18nPending` ab call
drop nahi karta (re-queue karta hai).

### Verified (headless Chrome, real browser test)
```
English     -> "Login"              dir=ltr  keys=343  PASS
Urdu Roman  -> "Login Karo"         dir=ltr  keys=347  PASS
اردو         -> "لاگ اِن"            dir=rtl  keys=343  PASS
हिन्दी        -> "लॉगिन"              dir=ltr  keys=343  PASS
العربية      -> "تسجيل الدخول"        dir=rtl  keys=343  PASS
Español     -> "Iniciar sesión"     dir=ltr  keys=343  PASS
Français    -> "Connexion"          dir=ltr  keys=343  PASS
RESULT: ALL LANGUAGES WORKING
```

### Warmup — JAAN-BOOJH KAR NAHI DALA
Aapne kaha tha warmup user-per-depend rehna chahiye. Is liye koi automatic ramp-up
nahi dala — user khud **Daily Send Limit** se control karta hai.

---

## ROUND 3 — Inbox Deliverability + Limits + Tracking

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
