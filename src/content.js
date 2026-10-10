// Roody lives here: a companion orb you summon on a work page. Chat, shared
// goals, and task progress stay in this panel. Live voice and API key settings
// open in extension-owned windows, away from the host page's DOM. Page access
// remains read-only; this panel does not click or edit the underlying page.

(function () {
  if (window.__roodyLoaded) return;
  window.__roodyLoaded = true;
  const passiveSummon = window.__roodyPassiveSummon === true;
  delete window.__roodyPassiveSummon;

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
        if (msg?.type === "roody:readVoiceContext") send({ sensitive: true });
      });
    } catch (_) {}
    return;
  }

  const history = []; // running chat between the human and Roody
  let exchangeCount = 0; // total exchanges ever — history caps at 20, this doesn't
  let roodyEnabled = true;

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

  // ---- Read the code editor -----------------------------------------------
  // HackerRank/LeetCode/CodeSandbox use Monaco, CodeMirror, or Ace. All of them
  // render code inside virtualised, line-per-<div> DOMs with NO literal
  // newlines. Reading them via findArticle's textContent path flattens the
  // whole program into one run-on string with the line-number gutter
  // concatenated in — completely unusable for a coding assistant. Read each
  // editor family the way its authors intended it to be read.
  const CODE_SITES = /(leetcode\.com|hackerrank\.com|codesignal\.com|codewars\.com|hackerearth\.com|atcoder\.jp|codeforces\.com|codepen\.io|codesandbox\.io|replit\.com|jsfiddle\.net|stackblitz\.com)/;
  function extractEditorCode() {
    try {
      // Keep split editors separate: sorting all Monaco rows together mixes
      // two files at the same vertical position into an invalid program.
      const editors = [];
      const visible = node => node.getClientRects().length > 0 && !node.closest('#roody-panel');
      const labelFor = (node, index) => {
        const group = node.closest('.editor-group-container, .editor-pane, [data-file], [data-filename]');
        const selected = group?.querySelector('[role="tab"][aria-selected="true"], .tab.active .label-name, .tab.active');
        const name = node.getAttribute('data-file') || node.getAttribute('data-filename') ||
          group?.getAttribute('data-file') || group?.getAttribute('data-filename') || selected?.textContent || node.getAttribute('aria-label');
        return (name || `visible editor ${index + 1}`).trim().slice(0, 160);
      };
      const addEditor = (node, kind, selector, sorted) => {
        if (!visible(node)) return;
        const rows = Array.from(node.querySelectorAll(selector)).map(line => {
          const match = /top\s*:\s*(-?\d+(?:\.\d+)?)px/.exec(line.getAttribute('style') || '');
          return { top: match ? Number(match[1]) : Number.MAX_SAFE_INTEGER, text: line.textContent || '' };
        });
        if (sorted) rows.sort((a, b) => a.top - b.top);
        const code = rows.map(row => row.text).join('\n').trimEnd();
        if (code.trim()) editors.push({ kind, code, label: labelFor(node, editors.length) });
      };
      document.querySelectorAll('.monaco-editor').forEach(node => addEditor(node, 'monaco', '.view-lines .view-line', true));
      document.querySelectorAll('.cm-content').forEach(node => addEditor(node, 'cm6', '.cm-line', false));
      document.querySelectorAll('.CodeMirror-code').forEach(node => addEditor(node, 'cm5', '.CodeMirror-line', false));
      document.querySelectorAll('.ace_editor .ace_text-layer').forEach(node => addEditor(node, 'ace', '.ace_line', false));
      if (editors.length) {
        const selected = editors.slice(0, 4);
        const budget = Math.floor(12000 / selected.length);
        return {
          kind: selected.map(editor => editor.kind).join(' + '),
          code: selected.map(editor => `FILE / EDITOR: ${editor.label}\n${editor.code.slice(0, budget)}${editor.code.length > budget ? '\n… (visible code truncated)' : ''}`).join('\n\n'),
          virtualised: true,
        };
      }
      // ---- Plain <textarea> the user is actively typing in ----
      // (Anything > 40 chars — an editor input, not the search bar.)
      const ta = document.activeElement;
      if (ta && ta.tagName === "TEXTAREA" && !ta.closest('#roody-panel') && (ta.value || "").length > 40) {
        return { kind: "textarea", code: ta.value, virtualised: false };
      }
    } catch (e) { rlog(`⚠ editor extract: ${e.message}`); }
    return null;
  }
  // The problem statement / prose surrounding the editor. On coding sites the
  // question is usually in a panel next to the editor — grab it, but drop the
  // editor's own container so we don't double-count and drop obvious UI chrome.
  function extractProblemStatement() {
    try {
      // Common problem containers across coding platforms.
      const candidates = [
        '[data-track-load="description_content"]', // LeetCode
        '.question-container',                     // HackerRank
        '.problem-statement',                       // Codeforces
        'article',
        'main',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        // Read the live element (real innerText with line breaks), then strip
        // the editor's own text so we don't include the code twice.
        let txt = (el.innerText || "").trim();
        if (txt.length < 60) continue;
        // Chop off the editor block by finding the first 30-char run that also
        // appears in the extracted code — simplest heuristic that works.
        txt = txt.replace(/\s{2,}/g, " ").trim();
        if (txt.length > 3000) txt = txt.slice(0, 3000);
        return txt;
      }
    } catch (_) {}
    return "";
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
  function bodyTextWithoutRoody() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('#roody-panel, #roody-orb, #roody-refusal, script, style, noscript').forEach(node => node.remove());
    return (clone.innerText || clone.textContent || '').trim();
  }
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
        "[aria-hidden='true'], button, #roody-panel, #roody-orb, #roody-refusal"
      ).forEach((el) => el.remove());
      return clone;
    }
    try {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll(
        "nav, aside, header, footer, script, style, noscript, " +
        "[role='navigation'], [role='banner'], [role='complementary'], " +
        "[class*='sidebar'], [class*='side-bar'], [class*='history'], " +
        ".menu, .nav, .navbar, [aria-hidden='true'], #roody-panel, #roody-orb, #roody-refusal"
      ).forEach((el) => el.remove());
      if ((clone.innerText || "").trim().length > 200) return clone;
    } catch (_) {}
    // Small pages still need a clone; reading the live body includes Roody's
    // transcript, which would feed its own speech back as new page context.
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('#roody-panel, #roody-orb, #roody-refusal, script, style, noscript').forEach(node => node.remove());
    return clone;
  }

  function readPage() {
    // A PDF the user handed us wins over whatever's in the DOM.
    if (studyDoc && studyDoc.text) return studyDoc.text.slice(0, 16000);
    // The page can BECOME sensitive after summon (SPA navigates to a login or
    // checkout view). Re-check on every read; trip the shield if so.
    if (pageIsSensitive()) { tripSensitive(); return ""; }
    try {
      // Code editor path: on a page with Monaco/CodeMirror/Ace, the code is
      // the point. Present it as PROBLEM + CODE so the brain isn't guessing at
      // the flattened blob findArticle would produce.
      const editor = extractEditorCode();
      if (editor) {
        const problem = extractProblemStatement();
        const virtNote = editor.virtualised
          ? "(Note: this editor virtualises rows — only the visible portion of the code is shown. If lines seem missing, tell the user.)\n"
          : "";
        const codeBlock = editor.code.length > 12000 ? editor.code.slice(0, 12000) + "\n... (code truncated)" : editor.code;
        const problemBlock = problem ? `PROBLEM:\n${problem}\n\n` : "";
        return `${problemBlock}${virtNote}CODE (${editor.kind}):\n${codeBlock}`;
      }
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
        text = (el.innerText || el.textContent || "").trim();
      }
      if (!text) text = bodyTextWithoutRoody();
      text = text.replace(/\n\s*\n+/g, "\n\n").replace(/[ \t]+/g, " ");
      if (text.length > 16000) text = text.slice(-16000);
      return text;
    } catch (_) {
      return bodyTextWithoutRoody().slice(-16000);
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
    if (/(github\.com|gitlab\.com|bitbucket\.org|stackoverflow\.com|stackexchange\.com|codepen\.io|codesandbox\.io|replit\.com|jsfiddle\.net|stackblitz\.com|leetcode\.com|hackerrank\.com|codesignal\.com|codewars\.com|hackerearth\.com|atcoder\.jp|codeforces\.com)/.test(host)) return "code";
    // If the page has any known code editor mounted, we're in code mode
    // regardless of the host. Cheaper than the .length>=3 heuristic below.
    if (document.querySelector(".monaco-editor .view-lines, .cm-content, .CodeMirror-code, .ace_editor .ace_text-layer")) return "code";
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
  orb.title = "Roody Companion 3.1 · click to open, drag to move";
  orb.setAttribute("role", "button");
  orb.setAttribute("aria-label", "Open Roody Companion");
  orb.tabIndex = 0;

  const panel = document.createElement("div");
  panel.id = "roody-panel";
  panel.dataset.version = "3.1.0";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Roody companion");
  panel.style.display = "none";
  panel.innerHTML = `
    <div id="roody-header">
      <div id="roody-headtext">
        <span id="roody-title">Roody</span>
        <span id="roody-sub">Your companion · 3.1</span>
      </div>
      <button id="roody-gear" title="Settings">⚙</button>
      <button id="roody-close" title="Close">×</button>
    </div>
    <div id="roody-companion-controls">
      <div id="roody-preferences">
        <label for="roody-persona">I'm here as
          <select id="roody-persona">
            <option value="developer">Developer</option>
            <option value="grandparent">Grandparent</option>
            <option value="founder">Founder</option>
          </select>
        </label>
        <label for="roody-language">Language
          <select id="roody-language">
            <option value="auto">Auto</option>
            <option value="en">English</option>
            <option value="te">తెలుగు</option>
          </select>
        </label>
      </div>
      <div id="roody-modes" role="group" aria-label="How Roody helps">
        <button data-mode="teach" type="button" aria-pressed="false">Teach me</button>
        <button data-mode="with" type="button" aria-pressed="true">Do with me</button>
        <button data-mode="for" type="button" aria-pressed="false" title="Draft a plan or answer for review; browser automation is not available">Do for me</button>
      </div>
      <div id="roody-tools">
        <button id="roody-voice" type="button" title="Open a live voice window. Your microphone is used only after you start a session.">◉ Voice</button>
        <button id="roody-pause-voice" type="button" hidden title="Stop microphone, page following, and screen sharing">Pause voice</button>
        <button id="roody-look" type="button" title="Share one screenshot of this tab for analysis">▣ Look at this</button>
        <button id="roody-demo" type="button" title="Load a labeled sample prompt for the selected persona">Try a sample</button>
      </div>
      <div id="roody-live-status" hidden role="status" aria-live="polite"></div>
      <p id="roody-live-transcript" hidden></p>
      <div id="roody-companion-status" role="status" aria-live="polite">Goals and tasks are saved on this browser.</div>
    </div>
    <details id="roody-planner" open>
      <summary>My goal &amp; tasks <span id="roody-task-count">0 tasks</span></summary>
      <div id="roody-plan-body">
        <label id="roody-goal-label" for="roody-goal">What are we working toward?</label>
        <div id="roody-goal-row">
          <input id="roody-goal" type="text" maxlength="500" placeholder="e.g. Prepare my hackathon demo" autocomplete="off">
          <button id="roody-save-goal" type="button">Save</button>
        </div>
        <div id="roody-tasks"></div>
        <form id="roody-task-form">
          <input id="roody-new-task" type="text" maxlength="300" placeholder="Add the next small step…" aria-label="New task" autocomplete="off">
          <button id="roody-add-task" type="submit">+ Add</button>
        </form>
      </div>
    </details>
    <div id="roody-log" role="log" aria-label="Conversation"></div>
    <div id="roody-inputrow">
      <textarea id="roody-text" rows="1" placeholder="Ask, learn, or plan with Roody…" aria-label="Message to Roody"></textarea>
      <button id="roody-send" title="Send (Enter)" aria-label="Send message">➤</button>
    </div>
    <div id="roody-resize" title="Drag to resize"></div>
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
    const pw = panel.offsetWidth || 440;
    const ph = panel.offsetHeight || Math.min(H * 0.7, 460);
    // Prefer docking the panel on the same side of the screen the orb is on,
    // so it doesn't cover the middle of the page (where the editor lives).
    // Orb in the right half → panel hangs LEFT of the orb; orb in the left
    // half → panel hangs RIGHT. Clamp inside the viewport in either case.
    const orbCenter = x + ow / 2;
    let px = orbCenter > W / 2
      ? x + ow - pw               // right-half orb → panel's right edge to orb's right edge
      : x;                        // left-half orb → panel's left edge to orb's left edge
    px = Math.max(4, Math.min(W - pw - 4, px));
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
      orb.setAttribute("aria-expanded", String(d !== "none"));
      if (d === lastPanelDisplay) return;
      lastPanelDisplay = d;
      if (orbPos && d !== "none") placeRoody(orbPos.x, orbPos.y);
    }).observe(panel, { attributes: true, attributeFilter: ["style"] });
    chrome.storage.local.get("roodyOrbPos").then(({ roodyOrbPos: p }) => {
      if (p && typeof p.x === "number" && typeof p.y === "number") placeRoody(p.x, p.y);
    }).catch(() => {});
  })();

  // ---- Resize the panel ----------------------------------------------------
  // CSS `resize` doesn't cooperate with fixed positioning, so we hand-roll a
  // corner grabber. Bottom-left of the panel: drag left = wider, drag down =
  // shorter (the panel opens above the orb, so growing "down" from its
  // top-anchored position means shrinking height). Persists to roodyPanelSize.
  (function makeResizable() {
    const handle = panel.querySelector("#roody-resize");
    if (!handle) return;
    let sx = 0, sy = 0, sw = 0, sh = 0, sleft = 0, resizing = false;
    handle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      resizing = true;
      sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect();
      sw = r.width; sh = r.height; sleft = r.left;
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
    });
    handle.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      // Bottom-LEFT grip: moving left grows width and shifts panel left;
      // moving down grows height and keeps top anchored.
      const newW = Math.max(320, Math.min(720, sw - dx));
      const newH = Math.max(320, Math.min(window.innerHeight * 0.9, sh + dy));
      // Keep the right edge stable (so growing left doesn't yank the panel
      // out from under the pointer).
      const rightEdge = sleft + sw;
      const newLeft = Math.max(4, rightEdge - newW);
      panel.style.width = newW + "px";
      panel.style.height = newH + "px";
      panel.style.left = newLeft + "px";
    });
    handle.addEventListener("pointerup", (e) => {
      if (!resizing) return;
      resizing = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      const w = parseInt(panel.style.width, 10);
      const h = parseInt(panel.style.height, 10);
      if (w && h) chrome.storage.local.set({ roodyPanelSize: { w, h } }).catch(() => {});
    });
    // Restore on boot.
    chrome.storage.local.get("roodyPanelSize").then(({ roodyPanelSize: s }) => {
      if (s && typeof s.w === "number" && typeof s.h === "number") {
        panel.style.width = Math.max(320, Math.min(720, s.w)) + "px";
        panel.style.height = Math.max(320, Math.min(window.innerHeight * 0.9, s.h)) + "px";
      }
    }).catch(() => {});
  })();

  // How see-through the panel is (Settings → Transparency). Drives the
  // --roody-alpha CSS variable that every glass surface derives from.
  const DEFAULT_ALPHA = 0.78;
  function applyOpacity(v) {
    const a = Math.min(0.95, Math.max(0.1, Number(v) || DEFAULT_ALPHA));
    panel.style.setProperty("--roody-alpha", String(a));
    orb.style.setProperty("--roody-alpha", String(a));
  }

  // Honor the "Roody is off" master switch — hide everything and bail.
  function applyEnabled(enabled) {
    roodyEnabled = enabled;
    orb.style.display = enabled ? "flex" : "none";
    if (!enabled) panel.style.display = "none";
  }

  const log = panel.querySelector("#roody-log");
  const input = panel.querySelector("#roody-text");

  // Shared companion memory is managed by the extension, never the website.
  // User text is always rendered with textContent rather than HTML.
  const statusLine = panel.querySelector("#roody-companion-status");
  const personaSelect = panel.querySelector("#roody-persona");
  const languageSelect = panel.querySelector("#roody-language");
  const goalInput = panel.querySelector("#roody-goal");
  const taskInput = panel.querySelector("#roody-new-task");
  let companionState = { goal: "", tasks: [], preferences: { persona: "developer", mode: "with", language: "auto" } };
  let samplePrompt = null;

  function companionStatus(text, error) {
    statusLine.textContent = text;
    statusLine.dataset.error = error ? "true" : "false";
  }

  function runtimeRequest(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (result) => {
          const err = chrome.runtime.lastError;
          if (err) { reject(new Error(err.message)); return; }
          if (!result || !result.ok) {
            reject(new Error((result && result.error) || "Roody could not complete that action."));
            return;
          }
          resolve(result);
        });
      } catch (error) { reject(error); }
    });
  }

  function renderCompanion(state) {
    if (!state) return;
    companionState = state;
    const preferences = state.preferences || {};
    personaSelect.value = preferences.persona || "developer";
    languageSelect.value = preferences.language || "auto";
    panel.querySelectorAll("#roody-modes [data-mode]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.mode === (preferences.mode || "with")));
    });
    // Leave a half-written goal intact if another tab updates its task board.
    if (document.activeElement !== goalInput) goalInput.value = state.goal || "";
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const done = tasks.filter((task) => task.status === "done").length;
    panel.querySelector("#roody-task-count").textContent = tasks.length ? `${done}/${tasks.length} done` : "0 tasks";
    const taskList = panel.querySelector("#roody-tasks");
    taskList.textContent = "";
    if (!tasks.length) {
      taskList.appendChild(el("p", "roody-empty-tasks", "One small step is enough to start."));
    }
    tasks.forEach((task) => {
      const row = el("div", "roody-task-row");
      row.dataset.status = task.status || "pending";
      const taskText = el("div", "roody-task-text");
      taskText.appendChild(el("span", "roody-task-title", task.title));
      if (task.blocker) taskText.appendChild(el("small", "roody-task-blocker", task.blocker));
      row.appendChild(taskText);
      const status = el("select", "roody-task-status");
      status.setAttribute("aria-label", `Status of ${task.title}`);
      [["pending", "To do"], ["active", "Doing"], ["done", "Done"], ["blocked", "Blocked"]].forEach(([value, label]) => {
        const option = el("option", null, label);
        option.value = value;
        status.appendChild(option);
      });
      status.value = task.status || "pending";
      status.addEventListener("change", async () => {
        status.disabled = true;
        const saved = await updateCompanion({ type: "task", id: task.id, status: status.value }, "Task progress saved.");
        if (!saved) { status.value = task.status || "pending"; status.disabled = false; }
      });
      row.appendChild(status);
      taskList.appendChild(row);
    });
  }

  async function updateCompanion(payload, message) {
    try {
      const result = await runtimeRequest({ type: "roody:companionUpdate", payload });
      renderCompanion(result.state);
      companionStatus(message || "Saved on this browser.");
      return true;
    } catch (error) {
      companionStatus(`Couldn't save: ${error.message}`, true);
      return false;
    }
  }

  async function refreshCompanion() {
    try {
      const result = await runtimeRequest({ type: "roody:companionState" });
      renderCompanion(result.state);
    } catch (error) {
      companionStatus(`Couldn't load goals and tasks: ${error.message}`, true);
    }
  }
  refreshCompanion();

  async function savePreferences(mode) {
    await updateCompanion({
      type: "preferences",
      mode: mode || companionState.preferences?.mode || "with",
      persona: personaSelect.value,
      language: languageSelect.value,
    }, "Roody's persona, help mode, and language saved.");
  }
  personaSelect.addEventListener("change", () => savePreferences());
  languageSelect.addEventListener("change", () => savePreferences());
  panel.querySelectorAll("#roody-modes [data-mode]").forEach((button) => {
    button.addEventListener("click", () => savePreferences(button.dataset.mode));
  });

  async function saveGoal() {
    const saved = await updateCompanion({ type: "goal", text: goalInput.value.trim() }, "Goal saved. Roody will keep it in mind.");
    if (saved) goalInput.value = companionState.goal || "";
  }
  panel.querySelector("#roody-save-goal").addEventListener("click", saveGoal);
  goalInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); saveGoal(); }
  });
  panel.querySelector("#roody-task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const text = taskInput.value.trim();
    if (!text) { taskInput.focus(); return; }
    const button = panel.querySelector("#roody-add-task");
    button.disabled = true;
    const saved = await updateCompanion({ type: "add-task", text }, "Task added. Choose Doing when you begin.");
    if (saved) taskInput.value = "";
    button.disabled = false;
  });

  panel.querySelector("#roody-voice").addEventListener("click", async () => {
    if (pageIsSensitive()) { tripSensitive(); return; }
    try {
      await runtimeRequest({
        type: "roody:openVoice",
        payload: { pageContext: readPage().slice(-12000), site: location.hostname, title: document.title, pageMode: detectMode() },
      });
      companionStatus("Voice controls opened. Start once, then enable Follow browser or Share screen. You can minimize the controls while Roody talks.");
    } catch (error) { companionStatus(`Couldn't open voice: ${error.message}`, true); }
  });

  let liveVoiceStatus = null;
  function renderVoiceStatus(value) {
    liveVoiceStatus = value && typeof value === 'object' ? value : null;
    const active = liveVoiceStatus?.active === true;
    const state = active && ['connecting', 'listening', 'speaking'].includes(liveVoiceStatus.state) ? liveVoiceStatus.state : 'paused';
    orb.dataset.voice = state;
    const status = panel.querySelector('#roody-live-status');
    status.hidden = !active;
    const sources = [liveVoiceStatus?.following ? 'following browser' : '', liveVoiceStatus?.sharing ? 'screen shared' : ''].filter(Boolean);
    status.textContent = active ? `◉ ${state === 'speaking' ? 'Roody is speaking' : state === 'connecting' ? 'Connecting voice' : 'Roody is listening'}${sources.length ? ' · ' + sources.join(' · ') : ''}` : '';
    const transcript = panel.querySelector('#roody-live-transcript');
    const latest = active && typeof liveVoiceStatus.transcript === 'string' ? liveVoiceStatus.transcript.slice(0, 600) : '';
    transcript.hidden = !latest;
    transcript.textContent = latest;
    panel.querySelector('#roody-pause-voice').hidden = !active;
    panel.querySelector('#roody-voice').textContent = active ? '◉ Voice controls' : '◉ Voice';
    orb.title = active ? `Roody ${state}${sources.length ? ' · ' + sources.join(' · ') : ''} · click for controls` : 'Roody Companion 3.1 · click to open, drag to move';
    orb.setAttribute('aria-label', active ? `Open Roody. Voice is ${state}.` : 'Open Roody Companion');
  }
  panel.querySelector('#roody-pause-voice').addEventListener('click', async () => {
    try {
      await runtimeRequest({ type: 'roody:pauseVoice' });
      renderVoiceStatus({ state: 'paused', active: false });
      companionStatus('Voice paused. Microphone and sharing are off.');
    } catch (error) { companionStatus(`Couldn't pause voice: ${error.message}`, true); }
  });
  runtimeRequest({ type: 'roody:getVoiceStatus' }).then(result => renderVoiceStatus(result.status)).catch(() => {});

  panel.querySelector("#roody-look").addEventListener("click", async () => {
    const button = panel.querySelector("#roody-look");
    button.disabled = true;
    try {
      await send(input.value.trim() || "Look at this page. Explain what I should understand and suggest my next small step.", { screenshot: true });
    } finally { button.disabled = false; }
  });

  const SAMPLE_SCENARIOS = {
    developer: {
      goal: "Understand and fix a sample login bug",
      prompt: "SAMPLE SCENARIO — use only the fictional example below, not the current page. My app sends POST /login and receives 401. The UI catches every error and shows 'Something went wrong'. Walk me through how to investigate it, teach me what 401 means, and suggest a small improvement I can review. Ask me one useful question.",
    },
    grandparent: {
      goal: "Learn to understand a booking page",
      prompt: "SAMPLE SCENARIO — use only the fictional example below, not the current page. A booking page shows departure city, destination, date, passenger count, and a Search button. Explain these slowly in simple language and help me decide what to fill in first. Ask me one question at a time. Do not pretend to make a booking.",
    },
    founder: {
      goal: "Choose the next onboarding improvement",
      prompt: "SAMPLE SCENARIO — use only these fictional numbers, not the current page. Of 100 new signups, 60 start onboarding, 25 finish it, and 8 return the next day. Help me read these numbers, choose one hypothesis, and make a small three-step experiment plan. Ask me what success should look like.",
    },
  };
  panel.querySelector("#roody-demo").addEventListener("click", async () => {
    const sample = SAMPLE_SCENARIOS[personaSelect.value] || SAMPLE_SCENARIOS.developer;
    input.value = sample.prompt;
    samplePrompt = sample.prompt;
    goalInput.value = sample.goal;
    autoGrow();
    input.focus();
    await updateCompanion({ type: "goal", text: sample.goal }, "Sample scenario loaded. Review the fictional example, then press Send.");
  });

  let openerSent = false; // guarantees Roody only greets you once per page
  orb.addEventListener("click", () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "flex" : "none";
    if (open && !openerSent && !liveVoiceStatus?.active) {
      openerSent = true;
      openingHello();
    }
  });
  orb.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); orb.click(); }
  });

  // Roody opens by looking at what's on the screen and leading with substance.
  const OPENER_PROMPT =
    "(The user just opened you on this page. Look at what's on their screen and lead with the single most useful thing — the bug you spot, the key point, or a sharp observation about what they're doing. One or two sentences in Markdown. Do NOT ask 'what are you working on?' — you can see. No whole-page summary.)";

  function openingHello() {
    const recent = recentTask();
    if (!recent) {
      addBubble("roody", "Hey — I'm Roody, your companion. Pick a persona, share your goal, or try a sample. We can learn and plan together.");
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
      if (msg?.type === 'roody:voiceStatus') {
        renderVoiceStatus(msg.payload);
        sendResponse({ ok: true });
      }
      if (msg?.type === 'roody:readVoiceContext') {
        if (!roodyEnabled || document.hidden) { sendResponse({ unavailable: true }); return; }
        if (sensitiveTripped || domainBlocked(location.hostname) || pageIsSensitive()) {
          tripSensitive();
          sendResponse({ sensitive: true });
        } else {
          sendResponse({ text: readPage().slice(0, 16000), title: document.title.slice(0, 300), site: location.hostname, pageMode: detectMode(), sensitive: false });
        }
      }
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
  // Each user turn gets a monotonic id. If a later turn starts (the user sent
  // a new question), older in-flight turns become stale and their late replies
  // are dropped. But within a single turn, a "still working…" watchdog message
  // is NOT terminal — a real answer that lands later still replaces it,
  // instead of being thrown away like the old `settled` latch did.
  let lastTurnId = 0;
  function callRoody(userText, pageContext, onText, opts) {
    opts = opts || {};
    const skipHistory = opts.skipHistory;
    const image = opts.image || null;
    const myTurnId = ++lastTurnId;
    let commit = false;      // true = a real answer landed; further updates ignored
    let historyRecorded = false;
    const commitAnswer = (text, ok) => {
      if (myTurnId !== lastTurnId) return; // a newer user turn superseded this one
      if (commit) return;
      clearTimeout(watchdog);
      onText(text);
      if (ok) {
        commit = true;
        if (!skipHistory && !historyRecorded) {
          historyRecorded = true;
          history.push({ role: "user", content: userText });
          history.push({ role: "assistant", content: text });
          if (history.length > 20) history.splice(0, history.length - 20);
          exchangeCount++; // monotonic — history.length freezes at the 20-cap
        }
      } else {
        commit = true; // error path terminates too
      }
    };
    // The watchdog now only NUDGES the bubble — the actual reply, if it
    // eventually lands, replaces it. Bumped to 60s to cover the retry budget
    // in background.js's fetchWithRetry (up to ~5.5s of backoff + real work).
    const softNudge = () => {
      if (myTurnId !== lastTurnId || commit) return;
      rlog("⏱ brain slow (no reply in 60s) — still waiting");
      onText("_(still working on it — the model is being slow…)_");
    };
    const watchdog = setTimeout(softNudge, 60000);

    try {
      chrome.runtime.sendMessage(
        { type: "roody:ask", payload: { userText, pageContext, history, site: location.hostname, title: chatContentFound ? "" : document.title, pageMode: detectMode(), image } },
        (res) => {
          if (chrome.runtime.lastError) {
            rlog(`⚠ ask failed: ${chrome.runtime.lastError.message}`);
            commitAnswer("I lost the connection to my brain — refresh this page and try again?", false);
            return;
          }
          if (!res || !res.ok) {
            commitAnswer((res && res.error) || "Something went wrong.", false);
            return;
          }
          commitAnswer(res.text, true);
        }
      );
    } catch (e) {
      // Thrown synchronously when the extension was reloaded/updated while this
      // page stayed open ("Extension context invalidated"). A refresh fixes it.
      rlog(`⚠ ask threw: ${e.message}`);
      commitAnswer("We got disconnected — refresh this page and I'll be right back.", false);
    }
  }

  // ---- Screenshot ----------------------------------------------------------
  // Ask the background to capture the visible tab. Returns { mime, data } or null.
  // We hide Roody's own orb + panel first — otherwise they're baked into the
  // JPEG and the vision model reads Roody's own bubble text as if it were page
  // content (the "58 min 24 sec h" bug). `visibility: hidden` keeps layout so
  // nothing on the page reflows; two rAFs guarantee the compositor painted the
  // hidden state before captureVisibleTab fires. Restore in `finally`.
  function grabScreenshot() {
    if (pageIsSensitive()) { tripSensitive(); return Promise.resolve(null); }
    return new Promise((resolve) => {
      const orbVis = orb.style.visibility;
      const panelVis = panel.style.visibility;
      const restore = () => {
        orb.style.visibility = orbVis;
        panel.style.visibility = panelVis;
      };
      try {
        orb.style.visibility = "hidden";
        panel.style.visibility = "hidden";
        requestAnimationFrame(() => requestAnimationFrame(() => {
          try {
            chrome.runtime.sendMessage({ type: "roody:screenshot" }, (res) => {
              restore();
              if (chrome.runtime.lastError || !res || !res.ok) {
                const why = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (res && res.error) || "no response";
                rlog(`⚠ screenshot failed: ${String(why).slice(0, 200)}`);
                resolve(null);
                return;
              }
              resolve({ mime: res.mime, data: res.data });
            });
          } catch (e) {
            restore();
            rlog(`⚠ screenshot threw: ${e.message}`);
            resolve(null);
          }
        }));
      } catch (e) {
        restore();
        rlog(`⚠ screenshot threw: ${e.message}`);
        resolve(null);
      }
    });
  }

  // "attach a screenshot to my next message" — set by the 📷 button, and
  // auto-triggered on wording that clearly means "look at my screen". Coders
  // rarely say "this diagram" — they say "why does my code fail" or "what's
  // wrong with this". Match those too.
  const VISUAL_INTENT = /\b(screenshot|on[-\s]?screen|on my screen|this (image|picture|photo|diagram|chart|graph|screen|ui|design|mockup|layout|render|error|output|test|result)|what('?s| is) (shown|on screen|wrong|the (error|issue|problem|bug))|what do you see|look at (this|my) (screen|image|picture|page|code|editor|error|output|test|result)|see (this|my) screen|the (image|picture|diagram|chart|screenshot|error|output|console|test result|test case)|visually|my (code|solution|function|answer|program|script|attempt)|why does .{0,20}(fail|break|error|crash|not work)|why (is|are|does|isn't|aren't|doesn't) (it|this|that|my) .{0,30}(fail|work|error|break|wrong)|debug|fix my|find the (bug|issue|error))\b/i;
  // On a page detected as code mode, mentioning code should auto-arm — the
  // screenshot is usually the answer to "what does Roody see" on those pages.
  const CODE_TALK = /\b(bug|error|fail|compile|syntax|runtime|exception|traceback|stack trace|nullpointer|segfault|test case|failing test|off by one|edge case|line \d+|function|method|class|variable|null|undefined|nan|infinity|infinite loop)\b/i;

  // You asked Roody something.
  async function send(userText, options) {
    options = options || {};
    userText = (userText || "").trim();
    if (!userText) return;
    if (pageIsSensitive() || sensitiveTripped) { tripSensitive(); return; }
    const isSample = samplePrompt === userText && !options.screenshot;
    samplePrompt = null;
    rememberPage();
    addBubble("you", userText);
    input.value = "";
    autoGrow();
    // The explicit Look at this button captures exactly once. Otherwise a
    // screenshot rides along whenever the wording clearly means "look at my
    // screen" (VISUAL_INTENT), or the page is a code page and the message
    // talks about code (CODE_TALK). Labeled sample prompts use only their
    // supplied example and do not capture the current page.
    const inCodeMode = detectMode() === "code";
    const wantShot = options.screenshot === true || (!isSample && (VISUAL_INTENT.test(userText) || (inCodeMode && CODE_TALK.test(userText))));
    const thinking = addBubble("roody", "…");
    const ctx = isSample ? "" : buildContext();
    let image = null;
    if (wantShot) {
      // Deliberately leave the thinking bubble as "…" — anything visible here
      // gets captured into the screenshot itself and read back by the model.
      image = await grabScreenshot();
      if (!image) addBubble("roody", "_(couldn't grab a screenshot — answering from the page text)_");
      companionStatus(image ? "One screenshot shared for this message." : "Screenshot unavailable. Roody will use the page text.", !image);
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

  // ---- Auto-read a PDF if Roody was summoned on one ------------------------
  // The visible 📄 button is gone (removed for a cleaner input row), but if
  // the user clicks the toolbar icon while sitting on a PDF URL, silently
  // load the text so questions about it Just Work. Chrome's built-in PDF
  // viewer usually blocks injection, in which case background.js opens the
  // Study tab instead — this path only fires when injection succeeds.
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
        if (sub) sub.textContent = `Your companion · 3.1 · reading PDF`;
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
      if (!passiveSummon && s.roodyEnabled !== false && !openerSent) {
        openerSent = true;
        panel.style.display = "flex";
        openingHello();
      }
      if (!passiveSummon) setTimeout(dailyRituals, 6000);

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.roodyEnabled) applyEnabled(changes.roodyEnabled.newValue !== false);
        if (changes.roodyAutoChime) {
          autoChime = changes.roodyAutoChime.newValue === true;
          rlog(`🔔 auto-suggest ${autoChime ? "ON" : "OFF"} (picked up live)`);
        }
        // Drag the Settings slider and every open Roody restyles instantly.
        if (changes.roodyOpacity) applyOpacity(changes.roodyOpacity.newValue);
        if (changes.roodyCompanion) renderCompanion(changes.roodyCompanion.newValue);
      });
    }).catch((e) => { rlog(`⚠ boot failed: ${e.message}`); });
})();
