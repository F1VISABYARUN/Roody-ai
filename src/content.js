// Roody lives here: a glass orb you summon on any page. It reads what's on the
// screen (the page's code/text, and — on request — a screenshot), then answers
// your questions and writes code, all in the chat. Read-only: it never touches
// the page. No voice.

(function () {
  if (window.__roodyLoaded) return;
  window.__roodyLoaded = true;

  // ---- Privacy shield -------------------------------------------------------
  // Roody's hard boundary: NO personal pages. Banking, payments, email, chats,
  // social media, government, and any page with password/card fields. Even
  // though the user explicitly summoned us, we refuse and say why.
  const BLOCKED_DOMAINS = [
    // banking & payments
    "paypal.com", "stripe.com", "venmo.com", "wise.com", "revolut.com",
    "razorpay.com", "paytm.com", "phonepe.com", "pay.google.com", "cash.app",
    "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "citibank.com",
    "capitalone.com", "hsbc.com", "barclays.co.uk", "americanexpress.com", "discover.com",
    "sbi.co.in", "onlinesbi.sbi", "icicibank.com", "hdfcbank.com", "axisbank.com",
    "kotak.com", "pnbindia.in", "bankofbaroda.in", "idfcfirstbank.com",
    // email
    "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com",
    "mail.yahoo.com", "proton.me", "protonmail.com", "mail.zoho.com", "tutanota.com",
    // chat / messaging
    "web.whatsapp.com", "web.telegram.org", "discord.com", "app.slack.com",
    "teams.microsoft.com", "messenger.com", "chat.google.com", "web.skype.com",
    // social media (parked for now, by design)
    "facebook.com", "instagram.com", "twitter.com", "x.com", "tiktok.com",
    "snapchat.com", "threads.net", "linkedin.com", "reddit.com", "pinterest.com",
  ];
  function domainBlocked(host) {
    host = (host || "").toLowerCase();
    if (BLOCKED_DOMAINS.some((d) => host === d || host.endsWith("." + d))) return true;
    // login/auth/banking subdomains of ANY site
    if (/^(login|signin|auth|account|accounts|secure|banking|netbanking)\./.test(host)) return true;
    // government sites
    if (/\.(gov|gov\.in|nic\.in|gov\.uk|mil)$/.test(host)) return true;
    return false;
  }
  // Smart detection: personal-looking pages we didn't list — anything with a
  // password field or credit-card input.
  function pageIsSensitive() {
    try {
      if (document.querySelector('input[type="password"]')) return true;
      if (document.querySelector('input[autocomplete^="cc-"], input[name*="cardnumber" i], input[id*="card-number" i], input[name*="cvv" i]')) return true;
    } catch (_) {}
    return false;
  }
  function refusalToast() {
    const old = document.getElementById("roody-refusal");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "roody-refusal";
    t.textContent = "🙈 Roody stays out of personal pages (logins, banking, email, chats). Summon me on a work page!";
    t.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483647;background:rgba(18,20,28,.9);color:#eef1f7;padding:12px 16px;border-radius:12px;font:13px/1.4 ui-sans-serif,system-ui,sans-serif;max-width:300px;box-shadow:0 8px 30px rgba(0,0,0,.5);backdrop-filter:blur(10px)";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  }
  if (domainBlocked(location.hostname) || pageIsSensitive()) {
    refusalToast();
    // Stay responsive to later icon clicks — just repeat the refusal.
    try {
      chrome.runtime.onMessage.addListener((msg, _s, send) => {
        if (msg?.type === "roody:toggle") { refusalToast(); send({ ok: true }); }
      });
    } catch (_) {}
    return;
  }

  const history = []; // running chat between the human and Roody
  let exchangeCount = 0; // total exchanges ever — history caps at 20, this doesn't

  // Tuning knobs.
  const REACT_DEBOUNCE_MS = 1800; // how long the page must be quiet = answer finished
  const REACT_COOLDOWN_MS = 15000; // min gap between auto-reactions
  const MAX_CONTEXT = 30000; // cap how much text we send to the model
  const PROACTIVE_INTERVAL_MS = 180000; // 3 min
  const TAB_LEADER_TTL_MS = 8000; // how long a tab claims the "active speaker" role

  let autoChime = false; // OFF by default — Roody stays quiet unless asked
  let lastAnswerSig = ""; // fingerprint of the latest answer we've seen
  let reacting = false; // lock so we don't react on top of a reaction
  let lastReactTime = 0;
  let pageCache = ""; // incrementally built — NO scrolling ever
  const seenLines = new Set(); // dedup by exact line, not substring
  let lastCacheSnapshot = ""; // detect meaningful changes
  let lastPageUrl = location.href; // SPA navigation guard — reset cache on URL change

  // Send a log line to the background so it shows up in Settings.
  function rlog(line) {
    try { chrome.runtime.sendMessage({ type: "roody:log", payload: { line } }); } catch (_) {}
    // also surface to devtools for quick eyeballing
    try { console.log("[Roody]", line); } catch (_) {}
  }
  rlog(`page=${location.hostname} ua=${navigator.userAgent.slice(0, 60)}`);

  // ---- Tab leader election ------------------------------------------------
  // Only ONE tab across the whole browser can post a proactive reaction at a
  // time. Without this, every open tab runs its own Roody and they all chime
  // at once. Uses chrome.storage.local as a shared lock.
  const TAB_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  async function canISpeak() {
    // Only the visible/focused tab is even eligible. Background tabs stay silent.
    if (document.hidden || document.visibilityState !== "visible") return false;
    try {
      const { roodyActiveTab } = await chrome.storage.local.get(["roodyActiveTab"]);
      const now = Date.now();
      // No active tab or stale lock → claim it
      if (!roodyActiveTab || !roodyActiveTab.ts || now - roodyActiveTab.ts > TAB_LEADER_TTL_MS) {
        await chrome.storage.local.set({ roodyActiveTab: { id: TAB_ID, ts: now } });
        return true;
      }
      // Already the active tab → refresh the lock
      if (roodyActiveTab.id === TAB_ID) {
        await chrome.storage.local.set({ roodyActiveTab: { id: TAB_ID, ts: now } });
        return true;
      }
      // Someone else is the leader
      return false;
    } catch (_) { return true; } // storage errors → be permissive
  }
  async function releaseLeadership() {
    try {
      const { roodyActiveTab } = await chrome.storage.local.get(["roodyActiveTab"]);
      if (roodyActiveTab && roodyActiveTab.id === TAB_ID) {
        await chrome.storage.local.set({ roodyActiveTab: null });
      }
    } catch (_) {}
  }
  // Release the lock when this tab hides or closes so others can take over.
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseLeadership(); });
  window.addEventListener("beforeunload", releaseLeadership);

  // ---- PDF study mode -------------------------------------------------------
  // Chrome's built-in PDF viewer keeps the text locked inside a plugin the DOM
  // can't see, so Roody reads PDFs itself: it takes the raw file bytes, inflates
  // the FlateDecode streams with the browser's NATIVE DecompressionStream (zero
  // libraries, no remote code — stays store-compliant), and pulls text out of
  // the content-stream operators. Works on most text PDFs; scanned/image PDFs
  // have no text to extract, so we fall back to "paste it and I'll read it."
  let studyDoc = null; // { name, text } once a PDF is loaded for study
  let chatContentFound = false; // real chat text extracted → suppress stale tab title

  // Byte-accurate string so file offsets line up with the raw bytes.
  function pdfLatin1(bytes) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return s;
  }

  // Inflate a stream. PDFs use zlib ("deflate"); some tools emit raw deflate.
  async function pdfInflate(bytes) {
    for (const fmt of ["deflate", "deflate-raw"]) {
      try {
        const ds = new DecompressionStream(fmt);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (_) {}
    }
    return null;
  }

  // Pull readable text out of a decoded content stream by walking its operators:
  // literal (…) strings are the text; Td/TD/T*/'/" mean a new line.
  function pdfTextFromContent(s) {
    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === "(") {
        let depth = 1;
        let str = "";
        i++;
        while (i < n && depth > 0) {
          const ch = s[i];
          if (ch === "\\") {
            const nx = s[i + 1];
            const esc = { n: "\n", r: "", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
            if (nx !== undefined && nx in esc) { str += esc[nx]; i += 2; continue; }
            const m = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
            if (m) { str += String.fromCharCode(parseInt(m[0], 8) & 0xff); i += 1 + m[0].length; continue; }
            i += 2; continue;
          }
          if (ch === "(") { depth++; str += ch; i++; continue; }
          if (ch === ")") { depth--; if (depth === 0) { i++; break; } str += ch; i++; continue; }
          str += ch; i++;
        }
        out += str;
      } else if (c === "<" && s[i + 1] !== "<") {
        // Hex string — usually needs a font CMap to decode, skip it.
        const end = s.indexOf(">", i);
        if (end === -1) break;
        i = end + 1;
      } else if ((c === "T" && (s[i + 1] === "d" || s[i + 1] === "D" || s[i + 1] === "*")) || c === "'" || c === '"') {
        out += "\n"; i += 2;
      } else {
        i++;
      }
    }
    return out;
  }

  // Extract text from a whole PDF file (ArrayBuffer) → plain string.
  async function extractPdfText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const raw = pdfLatin1(bytes);
    let text = "";
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end === -1) continue;
      let sEnd = end;
      if (raw[sEnd - 1] === "\n") sEnd--;
      if (raw[sEnd - 1] === "\r") sEnd--;
      const streamBytes = bytes.subarray(start, sEnd);
      const inflated = await pdfInflate(streamBytes);
      const content = inflated ? pdfLatin1(inflated) : pdfLatin1(streamBytes);
      // Only mine streams that carry text operators (skips images/fonts).
      if (content && /(Tj|TJ|BT)/.test(content)) {
        text += pdfTextFromContent(content) + "\n";
      }
      re.lastIndex = end + 9;
    }
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- Read the page (SMART extraction, ZERO scrolling) --------------------
  const CHAT_CONTAINERS = [
    { host: "chatgpt.com", sel: 'main [role="presentation"], main div[class*="conversation"]' },
    { host: "chat.openai.com", sel: 'main [role="presentation"]' },
    { host: "claude.ai", sel: 'main div[data-testid*="conversation"], main div[class*="conversation"]' },
    { host: "gemini.google.com", sel: 'main #chat-history, main [class*="conversation"]' },
    { host: "perplexity.ai", sel: 'main [class*="thread"]' },
    { host: "www.perplexity.ai", sel: 'main [class*="thread"]' },
    { host: "grok.com", sel: 'main [class*="conversation"], main [class*="thread"]' },
    { host: "www.kimi.com", sel: 'main [class*="chat"], main [class*="conversation"]' },
    { host: "kimi.com", sel: 'main [class*="chat"]' },
    { host: "chat.deepseek.com", sel: 'main [class*="conversation"], main [class*="chat"]' },
  ];

  // Find the biggest article-like block on a regular page — biggest <article>,
  // <main>, or content-heavy <div>. Skips nav/header/footer/aside/menus.
  function findArticle() {
    const article = document.querySelector("article");
    if (article && article.innerText && article.innerText.length > 300) return article;
    const main = document.querySelector("main");
    if (main && main.innerText && main.innerText.length > 300) {
      const clone = main.cloneNode(true);
      clone.querySelectorAll(
        "nav, header, footer, aside, script, style, noscript, " +
        "[role='navigation'], [role='banner'], [role='complementary'], " +
        ".menu, .sidebar, .nav, .navbar, .footer, .header, .ad, .ads, " +
        "[class*='cookie'], [class*='consent'], [class*='banner'], " +
        "[class*='related'], [class*='recommend'], [class*='newsletter'], " +
        "[aria-hidden='true'], button"
      ).forEach((el) => el.remove());
      return clone;
    }
    try {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll(
        "nav, aside, header, footer, script, style, noscript, " +
        "[role='navigation'], [role='banner'], [role='complementary'], " +
        "[class*='sidebar'], [class*='side-bar'], [class*='history'], " +
        ".menu, .nav, .navbar, [aria-hidden='true']"
      ).forEach((el) => el.remove());
      if ((clone.innerText || "").trim().length > 200) return clone;
    } catch (_) {}
    return document.body;
  }

  function readPage() {
    // A PDF the user handed us wins over whatever's in the DOM.
    if (studyDoc && studyDoc.text) return studyDoc.text.slice(0, 16000);
    // The page can BECOME sensitive after summon (SPA navigates to a login or
    // checkout view). Re-check on every read; trip the shield if so.
    if (pageIsSensitive()) { tripSensitive(); return ""; }
    try {
      const host = location.hostname;
      const chatSite = CHAT_CONTAINERS.find((c) => c.host === host);
      let text = "";
      chatContentFound = false;
      if (chatSite) {
        const container = document.querySelector(chatSite.sel);
        if (container && container.innerText) {
          text = container.innerText.trim();
          chatContentFound = text.length > 200;
        }
      }
      if (!text) {
        const el = findArticle();
        text = (el.innerText || "").trim();
      }
      if (!text) text = (document.body.innerText || "").trim();
      text = text.replace(/\n\s*\n+/g, "\n\n").replace(/[ \t]+/g, " ");
      if (text.length > 16000) text = text.slice(-16000);
      return text;
    } catch (_) {
      return (document.body.innerText || "").trim().slice(-16000);
    }
  }

  // Save a lightweight memory of the current page — only when the user actually
  // engages with Roody. No LLM cost, just site + title + first 200 chars.
  async function rememberPage() {
    try {
      const snippet = readPage().slice(0, 200).replace(/\s+/g, " ").trim();
      const entry = {
        site: location.hostname,
        title: (document.title || "").slice(0, 100),
        snippet,
        ts: Date.now(),
      };
      const { roodyMemory, roodyTalkCount } = await chrome.storage.local.get(["roodyMemory", "roodyTalkCount"]);
      const mem = Array.isArray(roodyMemory) ? roodyMemory : [];
      const dupIdx = mem.findIndex((m) => m.site === entry.site && m.title === entry.title);
      if (dupIdx >= 0) mem[dupIdx] = entry;
      else mem.push(entry);
      while (mem.length > 20) mem.shift();
      await chrome.storage.local.set({
        roodyMemory: mem,
        roodyTalkCount: (roodyTalkCount || 0) + 1,
      });
    } catch (_) {}
  }

  // The most recent task — tail of what's on screen. Cheap, focused.
  function recentTask() {
    const t = readPage();
    if (!t) return "";
    if (studyDoc) return `Document: ${studyDoc.name}\n\n` + t.slice(0, 2200);
    const isChatSite = CHAT_CONTAINERS.some((c) => c.host === location.hostname);
    if (isChatSite) return t.slice(-2500);
    const head = t.slice(0, 2200);
    return (document.title ? `Page: ${document.title}\n\n` : "") + head;
  }

  // Incrementally capture new content as it appears — called by
  // MutationObserver. Merges new lines into pageCache without scrolling. Also
  // detects SPA navigation and resets the cache so Roody reads the NEW page.
  let captureTimer = null;
  function captureIncremental() {
    if (location.href !== lastPageUrl) {
      lastPageUrl = location.href;
      pageCache = "";
      seenLines.clear();
      lastCacheSnapshot = "";
      openerSent = false; // allow a new greeting on the new page
      rlog(`SPA nav → ${location.hostname}${location.pathname} — cache reset`);
    }
    const fresh = readPage();
    if (!pageCache) {
      pageCache = fresh;
      fresh.split("\n").forEach((l) => { const t = l.trim(); if (t) seenLines.add(t); });
      return;
    }
    const newLines = [];
    for (const l of fresh.split("\n")) {
      const t = l.trim();
      if (t && !seenLines.has(t)) { seenLines.add(t); newLines.push(t); }
    }
    if (newLines.length > 0) pageCache += "\n" + newLines.join("\n");
    if (pageCache.length > MAX_CONTEXT) pageCache = pageCache.slice(-MAX_CONTEXT);
    if (seenLines.size > 5000) {
      seenLines.clear();
      pageCache.split("\n").forEach((l) => { const t = l.trim(); if (t) seenLines.add(t); });
    }
  }
  function debouncedCapture() {
    if (captureTimer) return;
    captureTimer = setTimeout(() => { captureTimer = null; captureIncremental(); }, 800);
  }

  // Detect the page type from cheap heuristics so the brain acts like the right
  // expert. No LLM call, no cost — just a string mapped to a mode instruction.
  function detectMode() {
    if (studyDoc) return "learning";
    const host = location.hostname.replace(/^www\./, "");
    const hp = host + location.pathname;
    if (/(github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|codepen\.io|codesandbox\.io|replit\.com|jsfiddle\.net)/.test(host)) return "code";
    if (/(arxiv\.org|scholar\.google|researchgate|semanticscholar|nature\.com|sciencedirect|ncbi\.nlm\.nih\.gov|ssrn\.com|papers\.ssrn)/.test(host)) return "research";
    if (/(readthedocs|developer\.mozilla|devdocs\.io|^docs\.|\/docs\/)/.test(hp)) return "research";
    if (/(docs\.google\.com\/document|notion\.so|substack\.com\/publish|overleaf\.com|hemingwayapp)/.test(hp)) return "writing";
    if (/(ycombinator\.com|producthunt\.com|crunchbase\.com|pitchbook\.com|a16z\.com|firstround\.com)/.test(host)) return "founder";
    const isChat = CHAT_CONTAINERS.some((c) => c.host === location.hostname);
    if (!isChat) {
      try {
        if (document.querySelectorAll("pre code, .highlight, .CodeMirror, .monaco-editor, .cm-editor").length >= 3) return "code";
        const ed = document.querySelector('[contenteditable="true"], textarea');
        if (ed && ((ed.textContent || ed.value || "").length > 400)) return "writing";
      } catch (_) {}
    }
    return "general";
  }

  // Best context to send the brain — cached history + current screen.
  function buildContext() {
    captureIncremental();
    return pageCache;
  }

  // ---- Markdown rendering (dependency-free, XSS-safe) -----------------------
  // The model answers in Markdown. We build real DOM nodes (never innerHTML on
  // model text) so code blocks, inline code, bold/italic, and lists render, and
  // page/model content can't inject markup.
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderInline(target, text) {
    let i = 0;
    const n = text.length;
    let buf = "";
    const flush = () => { if (buf) { target.appendChild(document.createTextNode(buf)); buf = ""; } };
    while (i < n) {
      const c = text[i];
      if (c === "`") {
        const end = text.indexOf("`", i + 1);
        if (end > i) { flush(); target.appendChild(el("code", "roody-code-inline", text.slice(i + 1, end))); i = end + 1; continue; }
      }
      if (c === "*" && text[i + 1] === "*") {
        const end = text.indexOf("**", i + 2);
        if (end > i) { flush(); const st = el("strong"); renderInline(st, text.slice(i + 2, end)); target.appendChild(st); i = end + 2; continue; }
      }
      if (c === "*") {
        const end = text.indexOf("*", i + 1);
        if (end > i) { flush(); const em = el("em"); renderInline(em, text.slice(i + 1, end)); target.appendChild(em); i = end + 1; continue; }
      }
      buf += c; i++;
    }
    flush();
  }

  function buildCodeBlock(code, lang) {
    const wrap = el("div", "roody-codewrap");
    const bar = el("div", "roody-codebar");
    bar.appendChild(el("span", "roody-codelang", lang || "code"));
    const copy = el("button", "roody-copy", "Copy");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); copy.textContent = "Copied"; }
      catch (_) { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });
    bar.appendChild(copy);
    wrap.appendChild(bar);
    const pre = el("pre", "roody-pre");
    pre.appendChild(el("code", null, code));
    wrap.appendChild(pre);
    return wrap;
  }

  function renderTextBlock(container, text) {
    const lines = text.split("\n");
    let list = null, listType = null, para = [];
    const flushPara = () => {
      if (!para.length) return;
      const p = el("p", "roody-p");
      renderInline(p, para.join(" "));
      container.appendChild(p);
      para = [];
    };
    const flushList = () => { if (list) { container.appendChild(list); list = null; listType = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const t = ul ? "ul" : "ol";
        if (listType !== t) { flushList(); list = el(t, "roody-list"); listType = t; }
        const li = el("li");
        renderInline(li, ul ? ul[1] : ol[1]);
        list.appendChild(li);
        continue;
      }
      if (line.trim() === "") { flushPara(); flushList(); continue; }
      para.push(line.trim());
    }
    flushPara();
    flushList();
  }

  function renderMarkdownInto(container, md) {
    container.textContent = "";
    // Split on ``` fences — odd segments are code blocks.
    const segments = String(md == null ? "" : md).split("```");
    segments.forEach((seg, idx) => {
      if (idx % 2 === 1) {
        let code = seg, lang = "";
        const nl = seg.indexOf("\n");
        if (nl >= 0) {
          const first = seg.slice(0, nl).trim();
          if (/^[a-zA-Z0-9+#._-]*$/.test(first)) { lang = first; code = seg.slice(nl + 1); }
        }
        code = code.replace(/\n$/, "");
        container.appendChild(buildCodeBlock(code, lang));
      } else if (seg) {
        renderTextBlock(container, seg);
      }
    });
  }

  // ---- UI -------------------------------------------------------------------
  const orb = document.createElement("div");
  orb.id = "roody-orb";
  orb.title = "Ask Roody";
  // No emoji glyph — the glassy look comes from CSS.

  const panel = document.createElement("div");
  panel.id = "roody-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div id="roody-header">
      <div id="roody-headtext">
        <span id="roody-title">Roody</span>
        <span id="roody-sub">AI coding assistant</span>
      </div>
      <button id="roody-gear" title="Settings">⚙</button>
      <button id="roody-close" title="Close">×</button>
    </div>
    <div id="roody-log"></div>
    <div id="roody-inputrow">
      <button id="roody-pdf" title="Read a PDF with Roody">📄</button>
      <button id="roody-shot" title="Attach a screenshot of your screen to the next message">📷</button>
      <textarea id="roody-text" rows="1" placeholder="Ask about the code or the page… (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="roody-send" title="Send">➤</button>
    </div>
    <input id="roody-pdf-file" type="file" accept="application/pdf,.pdf" style="display:none" />
  `;

  document.body.appendChild(orb);
  document.body.appendChild(panel);

  // ---- Drag Roody anywhere — the panel rides along --------------------------
  let orbPos = null; // last custom {x, y}; null = default CSS corner
  function placeRoody(x, y) {
    const W = window.innerWidth, H = window.innerHeight;
    const ow = orb.offsetWidth || 52, oh = orb.offsetHeight || 52;
    x = Math.max(4, Math.min(W - ow - 4, x));
    y = Math.max(4, Math.min(H - oh - 4, y));
    orb.style.left = x + "px"; orb.style.top = y + "px";
    orb.style.right = "auto"; orb.style.bottom = "auto";
    const pw = panel.offsetWidth || 360;
    const ph = panel.offsetHeight || Math.min(H * 0.7, 460);
    let px = Math.max(4, Math.min(W - pw - 4, x + ow - pw));
    let py = y - ph - 12; // dock above the orb…
    if (py < 4) py = Math.min(H - ph - 4, y + oh + 12); // …or below at the top edge
    py = Math.max(4, py);
    panel.style.left = px + "px"; panel.style.top = py + "px";
    panel.style.right = "auto"; panel.style.bottom = "auto";
    orbPos = { x, y };
  }
  (function makeDraggable() {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, moved = false;
    orb.addEventListener("pointerdown", (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = orb.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { orb.setPointerCapture(e.pointerId); } catch (_) {}
    });
    orb.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 5) return;
      moved = true;
      placeRoody(ox + dx, oy + dy);
    });
    orb.addEventListener("pointerup", (e) => {
      dragging = false;
      try { orb.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) chrome.storage.local.set({ roodyOrbPos: orbPos }).catch(() => {});
    });
    // Registered BEFORE the open/close toggle listener → a drag-release never
    // also toggles the panel.
    orb.addEventListener("click", (e) => {
      if (moved) { e.stopImmediatePropagation(); moved = false; }
    });
    let lastPanelDisplay = panel.style.display;
    new MutationObserver(() => {
      const d = panel.style.display;
      if (d === lastPanelDisplay) return;
      lastPanelDisplay = d;
      if (orbPos && d !== "none") placeRoody(orbPos.x, orbPos.y);
    }).observe(panel, { attributes: true, attributeFilter: ["style"] });
    chrome.storage.local.get("roodyOrbPos").then(({ roodyOrbPos: p }) => {
      if (p && typeof p.x === "number" && typeof p.y === "number") placeRoody(p.x, p.y);
    }).catch(() => {});
  })();

  // How see-through the panel is (Settings → Transparency). Drives the
  // --roody-alpha CSS variable that every glass surface derives from.
  const DEFAULT_ALPHA = 0.34;
  function applyOpacity(v) {
    const a = Math.min(0.95, Math.max(0.1, Number(v) || DEFAULT_ALPHA));
    panel.style.setProperty("--roody-alpha", String(a));
    orb.style.setProperty("--roody-alpha", String(a));
  }

  // Honor the "Roody is off" master switch — hide everything and bail.
  function applyEnabled(enabled) {
    orb.style.display = enabled ? "flex" : "none";
    if (!enabled) panel.style.display = "none";
  }

  const log = panel.querySelector("#roody-log");
  const input = panel.querySelector("#roody-text");

  let openerSent = false; // guarantees Roody only greets you once per page
  orb.addEventListener("click", () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "flex" : "none";
    if (open && !openerSent) {
      openerSent = true;
      openingHello();
    }
  });

  // Roody opens by looking at what's on the screen and leading with substance.
  const OPENER_PROMPT =
    "(The user just opened you on this page. Look at what's on their screen and lead with the single most useful thing — the bug you spot, the key point, or a sharp observation about what they're doing. One or two sentences in Markdown. Do NOT ask 'what are you working on?' — you can see. No whole-page summary.)";

  function openingHello() {
    const recent = recentTask();
    if (!recent) {
      addBubble("roody", "Hey — I'm Roody, your coding assistant. What are we looking at?");
      return;
    }
    const thinking = addBubble("roody", "…");
    callRoody(OPENER_PROMPT, recent, (t) => fillBubble(thinking, t));
  }

  // Session recap — when a conversation wraps, ask the background to distill it
  // into one line for the notebook. Fires at most once per new material.
  let lastRecapLen = 0;
  function maybeRecap() {
    if (exchangeCount < 1 || exchangeCount === lastRecapLen) return;
    lastRecapLen = exchangeCount;
    try {
      chrome.runtime.sendMessage({
        type: "roody:recap",
        payload: { history: history.slice(-8), site: location.hostname, title: document.title },
      });
    } catch (_) {}
  }

  panel.querySelector("#roody-close").addEventListener("click", () => {
    panel.style.display = "none";
    maybeRecap();
  });
  panel.querySelector("#roody-gear").addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "roody:openOptions" }); } catch (_) {}
  });

  // Toolbar icon clicked again while we're already here → toggle everything.
  try {
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === "roody:toggle") {
        const hidden = orb.style.display === "none" || panel.style.display === "none";
        if (sensitiveTripped) { refusalToast(); }
        else if (hidden) { orb.style.display = "flex"; panel.style.display = "flex"; }
        else { panel.style.display = "none"; orb.style.display = "none"; maybeRecap(); }
        sendResponse({ ok: true });
      }
    });
  } catch (_) {}

  function addBubble(who, text) {
    const b = el("div", `roody-bubble roody-${who}`);
    b.dataset.who = who;
    fillBubble(b, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  // Set/replace a bubble's content. User bubbles stay plain text; Roody bubbles
  // render Markdown.
  function fillBubble(b, text) {
    if (b.dataset && b.dataset.who === "you") b.textContent = text == null ? "" : String(text);
    else renderMarkdownInto(b, text);
    try { if (b.parentNode === log) log.scrollTop = log.scrollHeight; } catch (_) {}
  }

  // ---- Talking to Roody's brain --------------------------------------------
  // onText fills the bubble. opts: { skipHistory, image } where image is a
  // screenshot { mime, data } to send with this turn.
  function callRoody(userText, pageContext, onText, opts) {
    opts = opts || {};
    const skipHistory = opts.skipHistory;
    const image = opts.image || null;
    let settled = false;
    const finish = (text, ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      onText(text);
      if (ok && !skipHistory) {
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: text });
        if (history.length > 20) history.splice(0, history.length - 20);
        exchangeCount++; // monotonic — history.length freezes at the 20-cap
      }
    };

    // Safety net: if the brain doesn't answer in 30s — say so instead of
    // spinning on "…".
    const watchdog = setTimeout(() => {
      rlog("⏱ brain timed out (no reply in 30s)");
      finish("That took too long and I didn't hear back — try once more?", false);
    }, 30000);

    try {
      chrome.runtime.sendMessage(
        { type: "roody:ask", payload: { userText, pageContext, history, site: location.hostname, title: chatContentFound ? "" : document.title, pageMode: detectMode(), image } },
        (res) => {
          if (chrome.runtime.lastError) {
            rlog(`⚠ ask failed: ${chrome.runtime.lastError.message}`);
            finish("I lost the connection to my brain — refresh this page and try again?", false);
            return;
          }
          if (!res || !res.ok) {
            finish((res && res.error) || "Something went wrong.", false);
            return;
          }
          finish(res.text, true);
        }
      );
    } catch (e) {
      // Thrown synchronously when the extension was reloaded/updated while this
      // page stayed open ("Extension context invalidated"). A refresh fixes it.
      rlog(`⚠ ask threw: ${e.message}`);
      finish("We got disconnected — refresh this page and I'll be right back.", false);
    }
  }

  // ---- Screenshot ----------------------------------------------------------
  // Ask the background to capture the visible tab. Returns { mime, data } or null.
  function grabScreenshot() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "roody:screenshot" }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            const why = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (res && res.error) || "no response";
            rlog(`⚠ screenshot failed: ${String(why).slice(0, 200)}`);
            resolve(null);
            return;
          }
          resolve({ mime: res.mime, data: res.data });
        });
      } catch (e) { rlog(`⚠ screenshot threw: ${e.message}`); resolve(null); }
    });
  }

  // "attach a screenshot to my next message" — set by the 📷 button, and
  // auto-triggered when the user's wording is clearly about something visual.
  let attachShot = false;
  const VISUAL_INTENT = /\b(screenshot|on[-\s]?screen|on my screen|this (image|picture|photo|diagram|chart|graph|screen|ui|design|mockup|layout|render)|what('?s| is) (shown|on screen)|what do you see|look at (this|my) (screen|image|picture|page)|see (this|my) screen|the (image|picture|diagram|chart|screenshot)|visually)\b/i;
  const shotBtn = panel.querySelector("#roody-shot");
  function updateShotBtn() { if (shotBtn) shotBtn.classList.toggle("on", attachShot); }
  if (shotBtn) shotBtn.addEventListener("click", () => { attachShot = !attachShot; updateShotBtn(); });

  // You asked Roody something.
  async function send(userText) {
    userText = (userText || "").trim();
    if (!userText) return;
    rememberPage();
    addBubble("you", userText);
    input.value = "";
    autoGrow();
    const wantShot = attachShot || VISUAL_INTENT.test(userText);
    attachShot = false; updateShotBtn();
    const thinking = addBubble("roody", "…");
    const ctx = buildContext();
    let image = null;
    if (wantShot) {
      fillBubble(thinking, "📸 capturing your screen…");
      image = await grabScreenshot();
      fillBubble(thinking, "…");
      if (!image) addBubble("roody", "_(couldn't grab a screenshot — answering from the page text)_");
    }
    callRoody(userText, ctx, (t) => fillBubble(thinking, t), { image });
  }

  // Auto-grow the textarea up to a few lines.
  function autoGrow() {
    try {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 120) + "px";
    } catch (_) {}
  }

  panel.querySelector("#roody-send").addEventListener("click", () => send(input.value));
  input.addEventListener("input", autoGrow);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });

  // ---- Read a PDF -----------------------------------------------------------
  const PDF_OPENER_PROMPT =
    "(The user just loaded a PDF. In 2-3 sentences of Markdown, give the useful decode: what this document is, the one idea that matters most, and one thing people usually get wrong or should focus on. Then briefly offer to go deeper or quiz them. Lead with substance.)";

  async function loadStudyPdf(file) {
    if (!file) return;
    const note = addBubble("roody", `📄 Reading ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      const text = await extractPdfText(buf);
      if (!text || text.length < 40) {
        studyDoc = null;
        fillBubble(note, `Hmm, I couldn't pull readable text out of ${file.name} — it's probably a scanned/image PDF. Copy-paste the part you want and I'll read it with you.`);
        return;
      }
      studyDoc = { name: file.name, text };
      pageCache = text;
      seenLines.clear();
      const sub = panel.querySelector("#roody-sub");
      if (sub) sub.textContent = `📄 reading ${file.name}`;
      fillBubble(note, `📄 Got it — I read ${file.name} (${text.length.toLocaleString()} characters). Ask me anything.`);
      const thinking = addBubble("roody", "…");
      callRoody(PDF_OPENER_PROMPT, text.slice(0, 2500), (t) => fillBubble(thinking, t));
    } catch (e) {
      studyDoc = null;
      fillBubble(note, "I couldn't open that file — mind trying again?");
    }
  }

  const pdfBtn = panel.querySelector("#roody-pdf");
  const pdfFile = panel.querySelector("#roody-pdf-file");
  if (pdfBtn && pdfFile) {
    pdfBtn.addEventListener("click", () => pdfFile.click());
    pdfFile.addEventListener("change", () => {
      const f = pdfFile.files && pdfFile.files[0];
      pdfFile.value = "";
      if (f) loadStudyPdf(f);
    });
  }
  panel.addEventListener("dragover", (e) => { e.preventDefault(); });
  panel.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /pdf/i.test((f.type || "") + " " + (f.name || ""))) loadStudyPdf(f);
  });

  (async function autoStudyPdf() {
    try {
      const looksPdf =
        (document.contentType || "").toLowerCase() === "application/pdf" ||
        /\.pdf($|\?|#)/i.test(location.pathname + location.search);
      if (!looksPdf) return;
      const buf = await (await fetch(location.href)).arrayBuffer();
      const text = await extractPdfText(buf);
      if (text && text.length > 40) {
        studyDoc = { name: document.title || "this PDF", text };
        pageCache = text;
        const sub = panel.querySelector("#roody-sub");
        if (sub) sub.textContent = `📄 reading this PDF`;
      }
    } catch (_) {}
  })();

  // ---- Live watching: react when new content appears -----------------------
  const REACTION_PROMPT =
    "(New content just appeared on the page and you're reading along. React in ONE short Markdown sentence — if something looks wrong or buggy, point it out; if it's a good result, note it; otherwise stay quiet-useful. Never narrate what they can already see.)";

  const PROACTIVE_PROMPTS = [
    "(Glance at what's on screen and say ONE genuinely useful thing — a bug you spot, a simpler approach, or a risk they haven't noticed. Be specific to what's actually on screen. One or two sentences of Markdown.)",
    "(Check-in: look at what they're doing. If something's off, flag it clearly. If they seem stuck, suggest a concrete next step. One or two sentences of Markdown, no filler.)",
    "(You've been reading along. Offer one sharp observation or connection to something earlier that helps them — a better pattern, an edge case, a gotcha. One or two sentences of Markdown, never generic.)",
  ];

  async function reactToNewAnswer() {
    if (reacting) return;
    if (!(await canISpeak())) return; // another tab is the active one
    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";

    const thinking = addBubble("roody", "…");
    const ctx = recentTask();
    callRoody(REACTION_PROMPT, ctx, (t) => {
      fillBubble(thinking, t);
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    }, { skipHistory: true });
  }

  async function proactiveCheckIn() {
    if (!autoChime || reacting) return;
    if (Date.now() - lastReactTime < REACT_COOLDOWN_MS) return;
    if (document.hidden) return;
    const current = readPage().slice(-1200);
    if (!lastCacheSnapshot) { lastCacheSnapshot = current; return; }
    const diffLen = Math.abs(current.length - lastCacheSnapshot.length);
    const changedALot = diffLen > 200 || current.slice(-200) !== lastCacheSnapshot.slice(-200);
    if (!changedALot) return;
    if (!(await canISpeak())) return;
    lastCacheSnapshot = current;

    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";
    const thinking = addBubble("roody", "…");
    const prompt = PROACTIVE_PROMPTS[Math.floor(Math.random() * PROACTIVE_PROMPTS.length)];
    callRoody(prompt, recentTask(), (t) => {
      fillBubble(thinking, t);
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    }, { skipHistory: true });
  }

  function onSettled() {
    if (!autoChime || reacting) return;
    if (Date.now() - lastReactTime < REACT_COOLDOWN_MS) return;
    captureIncremental();
    const sig = readPage().slice(-600);
    if (sig === lastAnswerSig) return;
    lastAnswerSig = sig;
    reactToNewAnswer();
  }

  function startWatching() {
    const main = document.querySelector("main") || document.body;
    let timer = null;
    const obs = new MutationObserver(() => {
      debouncedCapture();
      if (!autoChime) return;
      clearTimeout(timer);
      timer = setTimeout(onSettled, REACT_DEBOUNCE_MS);
    });
    obs.observe(main, { childList: true, subtree: true, characterData: true });
    setInterval(proactiveCheckIn, PROACTIVE_INTERVAL_MS);
  }

  // Page became sensitive mid-session (login/checkout appeared) — Roody packs
  // up and leaves: UI hidden, one-line explanation.
  let sensitiveTripped = false;
  function tripSensitive() {
    if (sensitiveTripped) return;
    sensitiveTripped = true;
    rlog("🙈 sensitive fields appeared — Roody disabling on this page");
    orb.style.display = "none";
    panel.style.display = "none";
    refusalToast();
  }

  // ---- Daily rituals --------------------------------------------------------
  // Returning to a page you've worked on before, Roody SOMETIMES (30%) has an
  // observation waiting. Text-only.
  const FOUND_PROMPT =
    "(The user just came back to a page they've worked on before. Give ONE genuinely useful or interesting observation about what's on the page — if something looks off, flag it. One or two sentences of Markdown.)";
  const MORNING_PROMPT =
    "(First time the user opened their browser today. Greet them in one short line that references what they were working on recently — check your notebook — then offer to pick it back up. Max two sentences of Markdown.)";

  async function dailyRituals() {
    try {
      if (openerSent) return;
      if (document.hidden) return;
      if (orb.style.display === "none") return;
      const today = new Date().toISOString().slice(0, 10);
      const { roodyLastHello, roodyMemory, roodyLastFound } = await chrome.storage.local.get([
        "roodyLastHello", "roodyMemory", "roodyLastFound",
      ]);
      const mem = Array.isArray(roodyMemory) ? roodyMemory : [];

      if (roodyLastHello !== today && mem.length > 0) {
        if (!(await canISpeak())) return;
        await chrome.storage.local.set({ roodyLastHello: today });
        rlog("🌅 morning hello");
        openerSent = true;
        panel.style.display = "flex";
        const thinking = addBubble("roody", "…");
        callRoody(MORNING_PROMPT, recentTask() || "(nothing on screen yet)", (t) => fillBubble(thinking, t), { skipHistory: true });
        return;
      }

      if (mem.some((m) => m.site === location.hostname) && Math.random() < 0.3) {
        const now = Date.now();
        if (roodyLastFound && now - roodyLastFound < 3600000) return;
        if (!(await canISpeak())) return;
        await chrome.storage.local.set({ roodyLastFound: now });
        rlog("👀 found-something moment");
        panel.style.display = "flex";
        const thinking = addBubble("roody", "…");
        callRoody(FOUND_PROMPT, recentTask() || "(nothing on screen yet)", (t) => fillBubble(thinking, t), { skipHistory: true });
      }
    } catch (e) { rlog(`⚠ rituals: ${e.message}`); }
  }

  // ---- Boot -----------------------------------------------------------------
  chrome.storage.local
    .get(["roodyAutoChime", "roodyEnabled", "roodyOpacity"])
    .then((s) => {
      if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
      applyOpacity(s.roodyOpacity);
      applyEnabled(s.roodyEnabled !== false); // default on
      lastAnswerSig = readPage().slice(-600);
      startWatching();
      // The user just SUMMONED Roody — open the panel and greet right away.
      if (!openerSent) {
        openerSent = true;
        panel.style.display = "flex";
        openingHello();
      }
      setTimeout(dailyRituals, 6000);

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.roodyEnabled) applyEnabled(changes.roodyEnabled.newValue !== false);
        if (changes.roodyAutoChime) {
          autoChime = changes.roodyAutoChime.newValue === true;
          rlog(`🔔 auto-suggest ${autoChime ? "ON" : "OFF"} (picked up live)`);
        }
        // Drag the Settings slider and every open Roody restyles instantly.
        if (changes.roodyOpacity) applyOpacity(changes.roodyOpacity.newValue);
      });
    }).catch((e) => { rlog(`⚠ boot failed: ${e.message}`); });
})();
