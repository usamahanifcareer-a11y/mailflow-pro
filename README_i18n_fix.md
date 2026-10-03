# MailFlow Pro — i18n + Speed + Mobile Fix

Is round mein **do kaam** hue:
1. **Language (i18n) fix** — language switching kaam nahi karta tha
2. **Speed + Mobile polish** — language switch slow tha, mobile UX behtar ki

Brand naam **"MailFlow Pro" hi rakha gaya** (domain/Vercel project safe).

---

## Part 1 — Language (i18n) fix

### Asli bug
`applyI18n()` aur `t()` bilkul theek the — **dictionary khaali thi**:

| Language | Pehle | Ab |
|---|---|---|
| `en` | ✅ 329 keys | ✅ 329 |
| `ur-roman` | ⚠️ sirf **108** | ✅ **329/329 — 0 missing** |
| `ur` `hi` `ar` `es` `fr` | ❌ khaali `{}` | ⚠️ English fallback (crash/blank nahi) |

`t()` ka fallback `I18N.en[key]` hai, is liye khaali dictionary = English hi dikhti thi.

### Fix
- **Nayi file `public/i18n-data.js`** — Roman Urdu ka complete dictionary
  (emojis, `<b>`/`<br>`/`<a>` tags aur `{name}`/`{company}` placeholders safe)
  + baqi languages ke liye English base + poora `try/catch` (fail ho to app chalti rahe).
- `index.html` head mein `<script src="/i18n-data.js">` (main script se pehle).
- `getEmailStatus()` / `getRecipientStatus()`: `lbl:'Machine'` → `lbl:t('machine')`.
- `applyI18n()` ab `mf:i18n` event bhejta hai → tables re-render (throttled).

### Test result
```
EN keys          : 329
ur-roman keys    : 336
ur-roman missing : 0
data-i18n total  : 328 | en mein missing: 0
```

---

## Part 2 — Speed + Mobile

### Language switch ab INSTANT hai
**Pehle:** dropdown badlo → Save → server ka wait → phir UI change.
**Ab:**
- `localStorage` mein preferences cache (`mf_prefs_v1`) — page khulte hi sahi
  language lagti hai, login screen bhi sahi bhasha mein aata hai (server wait nahi).
- Save pe **UI turant** badalta hai, server background mein save hota hai.
  Fail ho to purani values wapas (revert).
- `applyI18n()` optimize: sirf woh elements likhta hai jin ki value **waqai badli**
  ho (`_mfI18nKey` + `_mfI18nLang` yaad rakhta hai) aur sab updates
  `requestAnimationFrame` mein batch karta hai. Pehle har baar 328 elements
  re-paint hote the — **mobile pe yahi asli bottleneck tha**.

### Mobile rendering
- `content-visibility: auto` + `contain-intrinsic-size` un lists/tables pe jo screen
  se bahar hain (recipients, inbox, OCR, admin lists, modals) — scroll/tab-switch
  turant.
- `touch-action: manipulation` (tap delay khatam) + tap-highlight off.
- `-webkit-overflow-scrolling: touch` purane iPhone ke liye.
- `loading="lazy"` + `decoding="async"` images pe.
- Naya `@media (max-height: 700px)` — chhote/short phone pe login card poora fit ho
  jata hai (padding + logo + heading chhote ho jate hain).

### Mobile layout verified (headless Chrome, real measurement)

| Device | Viewport | scrollWidth | Card (L/W/R) | Overflow |
|---|---|---|---|---|
| iPhone SE | 320 | 320 | 20 / 280 / 300 | ✅ none |
| Android small | 360 | 360 | 20 / 320 / 340 | ✅ none |
| iPhone 14 | 390 | 390 | 20 / 350 / 370 | ✅ none |
| iPhone Plus | 414 | 414 | 20 / 374 / 394 | ✅ none |
| iPad | 768 | 768 | 159 / 450 / 609 | ✅ none |
| Desktop | 1280 | 1280 | 415 / 450 / 865 | ✅ none |

Har width pe **0 wide elements** — koi horizontal scroll nahi.

---

## Part 3 — Naya logo

- **Paper plane + envelope fold**, cyan → indigo → purple gradient, amber accent dot.
- Login screen (96px), topbar (mini), aur **favicon (inline SVG data-URI)** — teeno same mark.
- 12px se 96px tak test kiya: har size pe saaf dikhta hai (logo scaling test screenshot).
- Naye mobile meta tags: `apple-mobile-web-app-capable`, `theme-color`,
  `apple-mobile-web-app-title`, description.

---

## Files changed is round
| File | Kya |
|---|---|
| `public/index.html` | i18n wiring, speed cache, CSS, logo, favicon, mobile meta |
| `public/i18n-data.js` | (pehle round mein bana) Roman Urdu dictionary |
| `README.md` (ye file) | documentation |

**`server.js` ko haath nahi lagaya** — cron-job.org auto-send path bilkul waise hi hai:
`GET /api/cron/auto-send`, header `x-cron-secret`, schedule `0 * * * *`.

---

## Baqi pending (imaandar list)

1. **`ur` / `hi` / `ar` / `es` / `fr` ki asli translations** — abhi English dikhate hain
   (safe fallback, bug nahi). Ek-ek language add ho sakti hai.
2. **Cron time budget** — `/api/cron/auto-send` saare users ek request mein handle
   karta hai; har recipient ke baad `sendDelay` wait hota hai. Vercel `maxDuration: 60s`
   hai, is liye zyada recipients ya zyada delay pe request timeout ho sakti hai.
   Fix: 50-second budget daal ke baqi kaam agli hourly run pe chhod dena.
   **Ye abhi pending hai aur aapke auto-send ke liye important hai.**
3. **`getUserData()`** poora user document (including `logoBase64`) memory mein laata
   hai — performance optimization baqi hai.
