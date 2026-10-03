/* ============================================================================
   MailFlow Pro — i18n data bundle + lazy language loader
   ----------------------------------------------------------------------------
   - Roman Urdu dictionary INLINE hai (sab se zyada use hoti hai) — zero request.
   - English base index.html se aata hai.
   - Baqi languages (ur/hi/ar/es/fr) alag files se LAZY load hoti hain:
     public/i18n/<lang>.js  ->  window.MF_I18N[<lang>] = {...}
     Is liye jo language chuni gayi ho sirf wohi download hoti hai.

   Important:
   - HTML tags (<br>, <b>, <a>) aur emojis translate NAHI kiye gaye.
   - {name} / {company} placeholders bilkul waisay hi rakhe gaye hain.
   - Poora code try/catch mein hai — i18n fail ho to app normal chalti rahe.
   ============================================================================ */
(function () {
  "use strict";

  window.MF_I18N = window.MF_I18N || {};

  /* ==========================================================================
     ROMAN URDU — 100% complete
     ========================================================================== */
  var urRoman = {
    tagline: "AI-powered email automation.<br>Smart bhejo. Inbox mein land karo.",
    login: "Login", register: "Register", emailAddress: "Email Address", password: "Password",
    rememberMe: "Mujhe 30 din tak yaad rakho", loginBtn: "🔓 Login Karo", fullName: "Poora Naam",
    passwordMin8: "Password (kam se kam 8 characters)", createAccount: "✨ Account Banao",
    signupNote: "💡 <b>Note:</b> Signup ke baad Dashboard se Gmail App Password connect karo taake emails bhej sako.",
    featAI: "AI emails likhta aur behtar karta hai", featOCR: "Screenshot se Text nikalta hai",
    featInbox: "Live inbox sync", featTrack: "Real-time open tracking", featGmail: "Apne Gmail se bhejo",
    legal: 'Continue karne ka matlab hai ke aap hamari <a href="/terms" target="_blank">Terms</a> aur <a href="/privacy" target="_blank">Privacy Policy</a> se agree karte hain',
    accessSuspended: "Access Band Hai", accountSuspended: "Aapka account suspend kar diya gaya hai",
    suspendedDefault: "Aapka account terms of service violate karne ki wajah se suspend kiya gaya.",
    requestNewAccess: "📝 Naya Access Maango", fullNameReq: "Poora Naam *", newEmailReq: "Naya Email *",
    companyOpt: "Company (Optional)", phoneOpt: "Phone (Optional)", reasonAccess: "Access ki Wajah *",
    submitRequest: "📩 Request Bhejo", backToLogin: "← Login pe Wapas",
    settingsBtn: "⚙️ Settings", exitBtn: "Exit",
    tabDashboard: "📊 Dashboard", tabInbox: "📥 Inbox", tabAIProfile: "🧠 AI Profile",
    tabTools: "🧪 Tools", tabTestLab: "🧪 Test Lab", tabAdmin: "👑 Admin",
    gettingStarted: "🚀 Shuru Kaise Karein", connectGmail: "Gmail Connect Karo", createTemplate: "Template Banao",
    createTemplateDesc: "AI se likhwao ya apna paste karo. {name} aur {company} se personalize karo.",
    addRecipients: "Recipients Add Karo", addRecipientsDesc: "Manual, bulk paste, ya screenshot OCR.",
    sendTrack: "Bhejo aur Track Karo", sendTrackDesc: "Bhejne ke liye 📤 dabao. Real-time open tracking.",
    proTips: "⚡ Pro Tips", proTip1Title: "Har Email Personalize Karo",
    proTip1Desc: "{name} aur {company} placeholders use karo — personalized emails ko 6 guna zyada opens milte hain.",
    proTip2Title: "Asli Tracking", proTip2Desc: "Sirf asli opens count hote hain. Gmail proxy aur bots auto filter ho jate hain.",
    proTip3Title: "Click = 100% Open", proTip3Desc: "Agar receiver koi link click kare to ye pakka open mana jata hai.",
    proTip4Title: "Duplicate Guard", proTip4Desc: "Ek hi recipient ko 90 second mein dobara email nahi jayegi. Safe hai.",
    proTip5Title: "Har Ghante Auto-Send", proTip5Desc: "Auto-send on karo to pehli email agle poore ghante pe jayegi (jaise 6:13 ON → 7:00 pehli send).",
    gmailNotConnected: "Gmail connect nahi hai.", clickConnect: "Gmail App Password connect karne ke liye yahan click karo.",
    quietActive: "Quiet Hours Chal Rahe Hain", autoPaused: "Auto-send rukka hua hai.",
    statRecipients: "Recipients", statSent: "Bheje Gaye", statOpened: "Khule", statPending: "Pending", statTotalSends: "Total Sends",
    quickAuto: "⚡ Quick Automation", autoSendEmails: "🤖 Auto-Send Emails",
    autoSendDesc: "Pending emails har ghante khud ba khud chali jati hain (7:00, 8:00, 9:00...)",
    autoSendTemplate: "📝 Auto-send ke liye Template", allAutoEmails: "Saari auto-sent emails isi template se jayengi",
    batchSize: "Batch Size (per hour)", sendDelay: "Sends ke Darmiyan Delay (seconds)",
    quietHours: "🌙 Quiet Hours", quietHoursDesc: "Is waqt mein auto-send nahi chalega",
    quietStart: "Start Time (Yahan se rok do)", quietEnd: "End Time (Yahan se shuru karo)",
    quietExample: "Misaal: Start 22:00, End 07:00 = raat 10 se subah 7 tak koi email nahi.",
    includeInAuto: "📎 Har Auto-Sent Email Mein Shamil Karo", optSignature: "✍️ Signature", optLogo: "🖼️ Logo",
    optAttachFiles: "📎 Files Attach Karo", selectFilesAuto: "Auto-attach karne ke liye files chuno:",
    saveAutomation: "💾 Automation Settings Save Karo", totalAutoSent: "Total Auto-Sent", lastAutoRun: "Aakhri Auto-Run",
    nextAutoRun: "Agla Auto-Run", pendingRecipients: "Pending Recipients",
    gmailQuota: "📊 Gmail Daily Sending Quota", mailflowSentToday: "📤 MailFlow ne aaj bheje:",
    gmailSentToday: "📧 Gmail se aaj bheje (saare sources):", totalSentToday: "Aaj total bheje:",
    dailyLimit: "Daily limit:", remainingToday: "Aaj bachi hain:",
    aiComposer: "✉️ AI Email Composer", multiProvider: "Multi-provider AI", templateName: "Template Name",
    subject: "Subject", aiSuggest: "✨ AI Suggest", aiSuggestions: "✨ AI Suggestions", body: "Body",
    aiWrite: "🤖 AI Likhwao", cvBtn: "📄 CV", aiFix: "✨ Fix",
    usePlaceholders: "💡 Personalization ke liye {name} aur {company} use karo",
    saveTemplate: "💾 Template Save Karo", clearBtn: "🗑 Clear", aiAnalysis: "AI Analysis", deepBtn: "🤖 Deep",
    inboxProb: "Inbox Probability", templates: "📝 Templates", emailSignature: "✍️ Email Signature",
    sigAppears: "Har email mein aata hai", uploadLogo: "Logo upload karne ke liye click karo", removeLogo: "🗑 Logo Hatado",
    sigName: "Naam", sigDesignation: "Designation", sigCompany: "Company", sigPhone: "📞 Phone",
    sigEmail: "✉️ Email", sigLinkedin: "🔗 LinkedIn", previewBtn: "👁 Preview", saveSignature: "💾 Signature Save Karo",
    resetBtn: "🗑 Reset", preview: "📧 Preview", attachments: "📎 Attachments", maxFileSize: "Har file max 3MB",
    clickUpload: "Files upload karne ke liye click karo", uploadDesc: "PDF, DOC, DOCX, TXT, images — har ek max 3MB",
    selectAll: "☑️ Sab Select Karo", unselectAll: "⬜ Sab Unselect Karo", addRecipientsH: "➕ Recipients Add Karo",
    templateLabel: "Template", tabManual: "✍️ Manual", tabBulk: "📋 Bulk", tabOcr: "📸 Screenshot",
    addRow: "+ Row Add Karo", saveBtn: "💾 Save", bulkHelp: "Emails kisi bhi format mein paste karo — ek per line, CSV, ya company naam ke sath.",
    livePreview: "🔍 Live Preview", addAllBtn: "➕ Sab Add Karo",
    ocrHelp: "<b>Screenshot se Text</b> — Bulk upload. Auto-compress. Preview ke liye thumbnail click karo.",
    chooseFiles: "📁 Files Chuno", useCamera: "📷 Camera Use Karo",
    ocrDropTitle: "Multiple screenshots upload karne ke liye click karo",
    ocrDropSub: "PNG, JPG, WEBP — har ek max 12MB (auto-compress)",
    extractedText: "📝 Nikla Hua Text — zaroorat ho to edit karo", sendToBulk: "📋 Sab Bulk Mein Bhejo",
    copyBtn: "📋 Copy", retryFailed: "🔄 Failed Dobara Try Karo", cancelBtn: "⏹ Cancel",
    recipientTracking: "📊 Recipient Tracking",
    trackingHelp: "💡 Poori all-time history ke liye kisi bhi row pe click karo. Sirf asli opens — bots filter. Duplicate sends 90s tak auto-block.",
    optAllStatus: "Saare Status", optPending: "Pending", optSent: "Bheje", optOpened: "Khule",
    optScheduled: "Scheduled",
    resendBtn: "🔁 Dobara Bhejo", deleteBtn: "🗑 Delete", clearSelBtn: "Clear", refreshBtn: "🔄 Refresh",
    selectPage: "☑️ Page Select Karo", emailHistory: "📧 Email History", allTime: "Sab Time", today: "Aaj",
    last7: "Pichle 7 Din", last30: "Pichle 30 Din",
    connectInbox: "Apna Inbox Connect Karo", connectInboxDesc: "Wahi Gmail App Password use karo jo sender ka hai. Ek click mein dono connect.",
    appPassword: "🔑 Gmail App Password", connectInboxBtn: "🔌 Inbox Connect Karo", useSavedPass: "🔗 Saved Password Use Karo",
    encryptedNote: "🔒 AES-256 encrypted", folderInbox: "📥 Inbox", folderSent: "📤 Sent", syncBtn: "🔄 Sync",
    selectEmail: "Koi email select karo", fromLbl: "Se:", toLbl: "Ko:", dateLbl: "Date:",
    replyBtn: "↩️ Reply", aiReplyBtn: "🤖 AI Reply", aiProfileH: "🧠 AI Profile", aiWritesAsYou: "AI aapki tarah likhta hai",
    aiProfileHelp: "Ye information AI ko aapka tone aur style match karne mein madad deti hai.",
    industryLbl: "Industry", toneLbl: "Pasandeeda Tone", toneProfessional: "Professional",
    toneFriendly: "Dostana", toneCasual: "Casual", toneConfident: "Confident",
    aboutMe: "Mere Baare Mein", commonPhrases: "Aam Alfaz", saveAIProfile: "💾 AI Profile Save Karo",
    aiTools: "🤖 AI Tools", bestTimeH: "⏰ Bhejne ka Best Time", clickAnalyze: "Analyze pe click karo",
    analyzeBtn: "✨ Analyze", predictionsH: "📊 Email Predictions", senderMemoryH: "🧠 Sender Memory",
    noSenderMemory: "Abhi koi sender memory nahi", testLabBanner: "TEST LAB — Sirf Admin",
    testRecipients: "Test Recipients", testSent: "Test Bheje", testOpened: "Test Khule",
    testPending: "Test Pending", testLog: "Test Log", addTestRecipients: "➕ Test Recipients Add Karo",
    sendTestH: "📤 Test Bhejo", toLbl2: "Ko", includeInEmail: "📎 Email Mein Shamil Karo",
    selectFiles: "Attach karne ke liye files chuno:", sendTestBtn: "🚀 Test Bhejo",
    automationTest: "🤖 Automation Test", batchSizeLbl: "Batch Size", delaySec: "Delay (seconds)",
    totalAutoSentLbl: "Total auto-sent:", lastRunLbl: "Aakhri run:", pendingLbl: "Pending:",
    runNowBtn: "▶️ Abhi Chalao", testRecipientsLbl: "📋 Test Recipients", selectAllShort: "☑️ Sab",
    testLogH: "📜 Test Log", dangerZone: "🗑 Danger Zone", clearAllTest: "🗑 Saara Test Data Clear Karo",
    statUsers: "Users", statEmails: "Emails", statSends: "Sends",
    ocrAiMonitor: "🔍 OCR aur AI Monitor", ocrQuotaTitle: "📊 OCR Monthly Quota",
    statUsed: "Use Hua", statRemaining: "Bacha", statLimit: "Limit", statTotal: "Total",
    statSuccess: "Kamyab", statFailed: "Fail", statClientErr: "Client Err",
    perUserOcr: "👥 Per-User OCR Usage", aiProviderErrors: "⚠️ AI Provider Errors (Aaj)",
    aiUsage: "🧠 AI Usage", totalUsers: "Total Users", aiActive: "AI Active", month: "Mahina",
    lifetime: "Lifetime", remaining: "Bacha", callsLeft: "~Calls Baaki", calls: "Calls",
    bannedUsers: "🚫 Banned Users", accessRequests: "📩 Access Requests", allUsers: "👥 Saare Users",
    allSentEmails: "📨 Saari Bheji Emails", connectGmailH: "📧 Apna Gmail Connect Karo",
    appPasswordWhy: "💡 <b>App Password kyun?</b> Google verification ke baghair apne Gmail se bhejo.",
    alsoEnableImap: "<b>Inbox (IMAP) bhi on karo</b> — MailFlow Pro ke andar hi Gmail Inbox aur Sent padho",
    connectGmailBtn: "🔌 Gmail Connect Karo", encryptedNote2: "🔒 AES-256-GCM encrypted",
    myProfileH: "👤 Meri Profile", displayName: "Display Name", saveNameBtn: "💾 Naam Save Karo",
    appIdLbl: "App ID:", registeredLbl: "Register hua:", myAiUsage: "🤖 Meri AI Usage",
    remainingTokens: "Bache Hue Tokens", settingsH: "⚙️ Settings", tabAccount: "👤 Account",
    tabSecurity: "🔒 Security", tabPreferences: "🌐 Preferences", tabDanger: "⚠️ Danger",
    emailReadonly: "Email (read-only)",
    emailChangeDisabled: "💡 Email change band hai. Naye email se naya account banao.",
    saveChanges: "💾 Changes Save Karo", changePasswordH: "🔑 Password Badlo",
    currentPassword: "Current Password", newPassword: "Naya Password (kam se kam 8)", confirmNew: "Naya Password Confirm Karo",
    changePasswordBtn: "🔒 Password Badlo", langRegion: "🌐 Language aur Region",
    languageLbl: "Language", timezoneLbl: "Timezone", dateFormatLbl: "Date Format",
    timeFormatLbl: "Time Format", savePreferences: "💾 Preferences Save Karo",
    dangerZoneH: "⚠️ Danger Zone", disconnectGmail: "Gmail Disconnect Karo",
    disconnectInbox: "Inbox Disconnect Karo", disconnectBtn: "🔌 Gmail Disconnect Karo",
    disconnectInboxBtn: "🔌 Inbox Disconnect Karo", deleteAllRecipientsH: "Saare Recipients Delete Karo",
    deleteAllBtn: "🗑 Sab Delete Karo", replyH: "↩️ Reply", messageLbl: "Message",
    attachToReply: "📎 Reply ke Sath Attach Karo", optFiles: "📎 Files", aiImproveBtn: "✨ AI Behtar Karo",
    sendReplyBtn: "📤 Reply Bhejo", aiWriterH: "🤖 AI Email Writer",
    aiWriterHint: "🌐 Context kisi bhi language mein likho — AI professional English banayega.",
    contextLbl: "Context / Maqsad", recipientName: "Recipient ka Naam", companyLbl: "Company",
    toneFormal: "Formal", tonePersuasive: "Dilchasp", lengthLbl: "Lambai", lengthShort: "Chhota",
    lengthMedium: "Darmiyana", lengthLong: "Lamba", generateEmailBtn: "✨ Email Generate Karo",
    cvAnalyzerH: "📄 AI CV Analyzer", cvHint: "🌐 CV kisi bhi language mein — AI professional English email banata hai.",
    selectCvFile: "📁 CV File Chuno", uploadNewCv: "📤 Naya CV Upload Karo", chooseFileBtn: "📁 File Chuno",
    extractedTextLbl: "📝 Nikla Hua Text", targetRole: "🎯 Target Role",
    jobDescLbl: "📋 Job Description (Optional)", analyzeGenerate: "🤖 Analyze Karo aur Email Banao",
    recipientHistoryH: "📊 Recipient History", sendEmailH: "📤 Email Bhejo",
    sendNowBtn: "📤 Abhi Bhejo", cancelBtn2: "Cancel", resendEmailH: "🔁 Email Dobara Bhejo",
    resendNowBtn: "🔁 Abhi Dobara Bhejo", subjectLbl: "Subject", bodyLbl: "Body",
    userOcrDetails: "📸 User OCR Details", userDetailsH: "👤 User Details",
    banUserH: "🚫 User Ban Karo", reasonLbl: "Wajah", alsoBanIp: "<b>IP address bhi ban karo</b>",
    banUserBtn: "🚫 User Ban Karo", openTimeCol: "Khulne ka Waqt",
    machine: "Machine", statusMachine: "Machine",
    sentLbl: "Bheja", openedLbl: "Khula", machineLbl: "Machine",
    never: "Kabhi Nahi", liveLbl: "Live",
    dailyLimitLbl: "📊 Rozana Bhejne ki Limit (per day)",
    dailyLimitHint: "Gmail rozana taqreeban 500 emails allow karta hai. Limit poori hone pe auto-send khud ruk jata hai.",
    sendWindow: "⏰ Sirf In Ghanton Mein Bhejo",
    sendWindowDesc: "Auto-send sirf is waqt ke andar chalega",
    windowStart: "Se", windowEnd: "Tak",
    windowExample: "Misaal: 09:00 se 18:00 = emails sirf office hours mein jayengi.",
    deliverabilityLbl: "📬 Inbox Deliverability",
    deliverabilityGood: "Behtareen — inbox mein jane ke chances zyada",
    deliverabilityRisk: "Kuch issues hain — spam mein ja sakti hai",
    checkInboxBtn: "📬 Inbox Check"
  };

  window.MF_I18N["ur-roman"] = urRoman;

  /* ==========================================================================
     LANGUAGE MANIFEST — kaunsi language kaunsi file se aati hai
     ========================================================================== */
  var LANG_FILES = {
    ur: "/i18n/ur.js",
    hi: "/i18n/hi.js",
    ar: "/i18n/ar.js",
    es: "/i18n/es.js",
    fr: "/i18n/fr.js"
  };
  var LANG_NAMES = {
    en: "English",
    "ur-roman": "Urdu Roman",
    ur: "اردو",
    hi: "हिन्दी",
    ar: "العربية",
    es: "Español",
    fr: "Français"
  };
  var loading = {};

  /* ==========================================================================
     MERGE — jab ek language load ho jaye to I18N[lang] bana do
     NOTE: "loaded" alag rakha gaya hai. buildLang() abhi bhi English fallback
     deta hai, lekin us se ye pata nahi chalta ke ASLI file aayi hai ya nahi.
     Isi liye lazy-load ka faisla "loaded" flag se hota hai.
     ========================================================================== */
  var loaded = { "ur-roman": true }; // Roman Urdu inline hai — hamesha maujood

  /* Version counter: jab bhi kisi language ki ASLI dictionary load hoti hai, us ka
     version barh jata hai. Isse applyI18n ko pata chalta hai ke pehle jo (English
     fallback) values lagayi gayi thin wo ab purani ho chuki hain — dobara likhni hain.
     Warna: DOMContentLoaded pe English lag jati hai aur file load hone ke baad
     marker ki wajah se skip ho jati hai (yahi asli bug tha). */
  var langVersion = {};

  function bumpVersion(lang) {
    langVersion[lang] = (langVersion[lang] || 0) + 1;
  }

  // index.html ka applyI18n isse poochta hai
  window.mfLangVersion = function (lang) { return langVersion[lang] || 0; };

  function buildLang(lang) {
    if (typeof I18N === "undefined" || !I18N) return;
    I18N.en = I18N.en || {};
    var dict = window.MF_I18N[lang] || {};
    var had = Object.keys(dict).length > 0;
    I18N[lang] = Object.assign({}, I18N.en, dict);
    if (had) bumpVersion(lang);
  }

  function markLoaded(lang) {
    if (window.MF_I18N[lang]) { loaded[lang] = true; bumpVersion(lang); }
  }

  function buildAll() {
    buildLang("ur-roman");
    for (var k in LANG_FILES) buildLang(k);
  }

  /* ==========================================================================
     LAZY LOAD — sirf chuni hui language ki file mangwao
     ========================================================================== */
  function mfLoadLang(lang, cb) {
    if (!lang || lang === "en") { if (cb) cb(); return; }
    if (loaded[lang]) { buildLang(lang); if (cb) cb(); return; }
    if (loading[lang]) { if (cb) loading[lang].push(cb); return; }
    var src = LANG_FILES[lang];
    if (!src) { if (cb) cb(); return; }
    loading[lang] = cb ? [cb] : [];
    var sc = document.createElement("script");
    sc.src = src;
    sc.async = true;
    sc.onload = function () {
      markLoaded(lang);
      buildLang(lang);
      var q = loading[lang] || [];
      delete loading[lang];
      for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
      if (typeof applyI18n === "function" && typeof CURRENT_LANG !== "undefined" && CURRENT_LANG === lang) {
        try { applyI18n(); } catch (e) {}
      }
    };
    sc.onerror = function () {
      delete loading[lang];
      // file load na ho to app English pe chalti rahe — crash nahi
    };
    document.head.appendChild(sc);
  }

  /* ==========================================================================
     PUBLIC API — index.html se call hota hai
     ========================================================================== */
  // Language set karo + apply karo (file load hone ke baad khud re-apply hoti hai)
  window.mfApplyLanguage = function (lang, cb) {
    try {
      mfLoadLang(lang, function () {
        buildLang(lang);
        if (typeof applyI18n === "function") { try { applyI18n(); } catch (e) {} }
        if (cb) { try { cb(); } catch (e) {} }
      });
    } catch (e) { if (cb) { try { cb(); } catch (e2) {} } }
  };

  // Page khulte hi cached language eagerly load karo (pehle render se pehle tayyar ho)
  window.mfPrefetchLanguage = function (lang) {
    try {
      if (lang === "en" || !lang) return;
      if (loaded[lang] || loading[lang]) return;
      var src = LANG_FILES[lang];
      if (!src) return;
      loading[lang] = [];
      var sc = document.createElement("script");
      sc.src = src;
      sc.async = true;
      sc.onload = function () {
        markLoaded(lang);
        buildLang(lang);
        var q = loading[lang] || [];
        delete loading[lang];
        for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
        if (typeof applyI18n === "function" && typeof CURRENT_LANG !== "undefined" && CURRENT_LANG === lang) {
          try { applyI18n(); } catch (e) {}
        }
      };
      sc.onerror = function () { delete loading[lang]; };
      document.head.appendChild(sc);
    } catch (e) {}
  };

  window.mfLangName = function (lang) { return LANG_NAMES[lang] || lang; };

  /* ==========================================================================
     BOOTSTRAP
     ========================================================================== */
  function boot() {
    if (typeof I18N === "undefined" || !I18N) return;
    I18N.en = I18N.en || {};
    buildAll();
  }

  try {
    boot();
    // Page khulte hi cached language ka file eagerly load karo — login screen bhi
    // sahi bhasha (aur RTL direction) mein khule. Pehle ye sirf login ke BAAD hota tha.
    try {
      var _raw = localStorage.getItem("mf_prefs_v1");
      if (_raw) {
        var _o = JSON.parse(_raw);
        var _lg = _o && _o.p && _o.p.language;
        if (_lg && _lg !== "en") {
          if (typeof CURRENT_LANG !== "undefined") { try { CURRENT_LANG = _lg; } catch (e) {} }
          if (typeof PREFERENCES !== "undefined" && _o.p) { try { PREFERENCES = _o.p; } catch (e) {} }
          try { document.documentElement.lang = _lg; } catch (e) {}
          window.mfPrefetchLanguage(_lg);
        }
      }
    } catch (e) {}

    if (typeof I18N === "undefined") {
      document.addEventListener("DOMContentLoaded", function () {
        try {
          boot();
          try {
            var raw = localStorage.getItem("mf_prefs_v1");
            if (raw) {
              var o = JSON.parse(raw);
              var lg = o && o.p && o.p.language;
              if (lg) {
                if (typeof CURRENT_LANG !== "undefined") { try { CURRENT_LANG = lg; } catch (e) {} }
                window.mfPrefetchLanguage(lg);
              }
            }
          } catch (e) {}
        } catch (e) {}
      });
    }
  } catch (e) {
    // i18n fail ho jaye to app normal English pe chalti rahe — crash nahi
  }
})();
