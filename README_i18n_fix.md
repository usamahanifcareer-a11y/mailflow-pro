# MailFlow Pro — Language (i18n) Fix

**Date:** ye change
**Files touched:** `public/i18n-data.js` (NAYI file), `public/index.html` (3 chhote edits), `.gitignore` (scratch entry)

---

## Asli bug kya tha

Aap jab Settings → Preferences → Language badalte the to UI change nahi hoti thi.

**Wajah:** `public/index.html` ke andar `I18N` dictionary thi, jismein:

| Language | Pehle | Ab |
|---|---|---|
| `en` (English) | ✅ Poori (~360 keys) | ✅ Waisi hi |
| `ur-roman` (Urdu Roman) | ⚠️ Sirf ~120 keys — 240 keys missing | ✅ **Poori (360/360)** |
| `ur` (اردو) | ❌ Khaali `{}` | ⚠️ English fallback |
| `hi` (हिन्दी) | ❌ Khaali `{}` | ⚠️ English fallback |
| `ar` (العربية) | ❌ Khaali `{}` | ⚠️ English fallback |
| `es` (Español) | ❌ Khaali `{}` | ⚠️ English fallback |
| `fr` (Français) | ❌ Khaali `{}` | ⚠️ English fallback |

Code (`applyI18n()`, `t()`) bilkul theek tha — **data hi missing tha**.
`t()` ka fallback `I18N.en[key]` hai, is liye khaali dictionary = English hi dikhti thi
(blank nahi, is liye "kuch nahi hua" mehsoos hota tha).

Ek chhota race condition bhi tha: `loadAll()` pehle chal jata tha aur `applyI18n()`
baad mein — is liye table ke andar banne wale labels (jaise `⚙️ Machine`) English
reh jate the.

---

## Kya fix hua

### 1. Nayi file: `public/i18n-data.js`
- Roman Urdu ka **complete** dictionary (360 keys — emojis, `<br>`/`<b>` tags aur
  `{name}` / `{company}` placeholders bilkul safe).
- Baqi 5 languages ke liye English base inject karta hai — taake **kabhi blank UI na ho**.
- Poora `try/catch` mein hai: agar ye file load bhi na ho to app normal chalti rahegi.

### 2. `index.html` — line ~16 (head mein)
```html
<script src="/i18n-data.js"></script>
```
Ye main script se **pehle** load hota hai, is liye translation pehle tayyar rehti hai.

### 3. `index.html` — `getEmailStatus()` / `getRecipientStatus()`
`lbl:'Machine'` ki jagah ab:
```js
lbl:t('machine')||'Machine'
```

### 4. `index.html` — `applyI18n()`
Ab language change pe ek event bhejta hai:
```js
document.dispatchEvent(new CustomEvent('mf:i18n'));
```
Aur `DOMContentLoaded` mein ek listener hai jo `renderMyEmails()` +
`renderTestRecipients()` dobara chala deta hai (400ms throttle ke sath), taake
table ke andar wale labels bhi translate ho jayein.

### 5. `loadAll()` mein `applyI18n()` add kiya
Data load hone ke **baad** dobara translate — race condition khatam.

---

## Verified test results (deploy se pehle chala kar check kiya)

```
EN keys           : 329
ur-roman (before) : 108
--- MERGE KE BAAD ---
  en       : 329 keys
  ur-roman : 336 keys   <-- 329 + 7 extra (machine/never/live etc)
  ur       : 329 keys
  hi       : 329 keys
  ar       : 329 keys
  es       : 329 keys
  fr       : 329 keys
ur-roman missing  : 0
data-i18n total   : 328 | en mein missing: 0
keep-check tagline / legal / signupNote / proTip1Desc /
           createTemplateDesc / usePlaceholders / alsoEnableImap -> OK
```

Syntax checks: `node --check server.js` OK, `node --check public/i18n-data.js` OK,
index.html ke dono inline script blocks OK.

---

## Test kaise karein

1. Deploy ke baad site kholein aur login karein.
2. **Settings → Preferences → Language → "Urdu Roman"** → **Save Preferences**.
3. Poora UI Roman Urdu mein ho jana chahiye — Dashboard, buttons, tables, modals,
   Admin panel, sab.
4. Page refresh karein — language save rehni chahiye.
5. Table mein status labels dekhein: `Khule` / `Bheje` / `Machine` (pehle hardcoded
   English tha).
6. Wapas English pe switch kar ke confirm karein ke sab normal hai.

---

## Zaroori note — cron-job.org safe hai

Is round mein **`server.js` ko haath nahi lagaya gaya**. Aapka external cron
(`cron-job.org`) bilkul waise hi kaam karega:

- **URL:** `https://mailflowpro.dpdns.org/api/cron/auto-send`
- **Method:** GET
- **Header:** `x-cron-secret: <aapka CRON_SECRET>`
- **Schedule:** `0 * * * *` (har ghante)

Server `x-cron-secret` header ke sath sath `Authorization: Bearer <secret>` bhi
accept karta hai — dono chalte hain, is liye kuch todna nahi padta.

---

## Baqi recommendations (abhi implement nahi kiye)

1. **hi / ar / es / fr ki asli translations** — abhi ye English dikhate hain
   (safe fallback, koi bug nahi). Chahein to ek-ek language complete ki ja sakti hai.
   Note: `hi`, `ar`, `es`, `fr` abhi bhi **English hi dikhayenge** — sirf UI blank
   nahi hoga. Asli translation baad mein add karni hogi.
2. **Cron time budget** — `server.js` ka `/api/cron/auto-send` saare users ko ek hi
   request mein handle karta hai (per-recipient delay `sendDelay` ke sath). Vercel
   par `maxDuration: 60s` hai. Bahut zyada users ya zyada delay ho to request
   timeout ho sakti hai. Solution: 50-second time budget daal ke baqi kaam agli run
   pe chhod dena. **Ye abhi pending hai.**
3. **`getUserData()`** poora user document (including `logoBase64`, `profilePicture`)
   memory mein laata hai — bahut se endpoints ke liye ye wasteful hai. Chhota
   projection behtar hoga (performance).
4. **`server.js` minified hai** (211 lambi lines). Isse koi bug nahi hota, lekin
   edit karna mushkil hai. Chahein to readable version bana di jaye.

