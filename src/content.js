// Roody lives here: a calm orb on top of ChatGPT / Claude.
// It reads the on-page conversation (read-only), watches for new answers,
// talks with you by voice or text, and never touches anything on the page.

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
    t.textContent = "🙈 Roody stays out of personal pages (logins, banking, email, chats). Summon me on a task page!";
    t.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:2147483647;background:#3a2c1e;color:#fff;padding:12px 16px;border-radius:12px;font:13px/1.4 sans-serif;max-width:300px;box-shadow:0 4px 20px rgba(0,0,0,.35)";
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
  const synth = window.speechSynthesis;

  // Tuning knobs.
  const REACT_DEBOUNCE_MS = 1800; // how long the page must be quiet = answer finished
  const REACT_COOLDOWN_MS = 15000; // min gap between auto-reactions (was 7s, too spammy)
  const MAX_CONTEXT = 30000; // cap how much text we send to Claude
  const PROACTIVE_INTERVAL_MS = 180000; // 3 min — voice-first users hated 45s spam
  const TAB_LEADER_TTL_MS = 8000; // how long a tab claims the "active speaker" role

  let autoChime = false; // OFF by default — Roody stays quiet unless tapped
  let lastAnswerSig = ""; // fingerprint of the latest answer we've seen
  let reacting = false; // lock so we don't react on top of a reaction
  let lastReactTime = 0;
  let pageCache = ""; // incrementally built — NO scrolling ever
  const seenLines = new Set(); // dedup by exact line, not substring
  let lastCacheSnapshot = ""; // detect meaningful changes
  let geminiVoice = false; // use Gemini for voice? (set at boot if a key exists)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Send a log line to the background so it shows up in Settings.
  function rlog(line) {
    try { chrome.runtime.sendMessage({ type: "roody:log", payload: { line } }); } catch (_) {}
    // also surface to devtools for quick eyeballing
    try { console.log("[Roody]", line); } catch (_) {}
  }
  rlog(`page=${location.hostname} ua=${navigator.userAgent.slice(0, 60)}`);

  // ---- Tab leader election ------------------------------------------------
  // Only ONE tab across the whole browser can speak/react at a time. Without
  // this, every open AI tab runs its own Roody, and they all speak on top of
  // each other every 45s. Uses chrome.storage.local as a shared lock.
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

  // ---- Audio helpers (turn Gemini's raw PCM into something playable) --------
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function rateFromMime(mime) {
    const m = /rate=(\d+)/.exec(mime || "");
    return m ? parseInt(m[1], 10) : 24000;
  }
  // Wrap signed-16-bit mono PCM in a WAV header so an <audio> element can play it.
  function pcm16ToWav(pcm, sampleRate) {
    const dataSize = pcm.length;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const str = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    str(0, "RIFF");
    v.setUint32(4, 36 + dataSize, true);
    str(8, "WAVE");
    str(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate
    v.setUint16(32, 2, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    str(36, "data");
    v.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => {
        const s = String(r.result);
        resolve(s.slice(s.indexOf(",") + 1));
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // ---- Read the page (SMART extraction, ZERO scrolling) --------------------
  // Different strategy per site type:
  //   - AI chat sites: find the chat container, extract user/AI turns only
  //   - Regular pages: find the article/main content, skip menus & UI chrome
  //   - Fallback: main.innerText tail (old behavior)

  // Site-specific chat container selectors — where the actual conversation
  // lives on each supported AI chat site. Falls through to generic if none hit.
  const CHAT_CONTAINERS = [
    { host: "chatgpt.com", sel: 'main [role="presentation"], main div[class*="conversation"]' },
    { host: "chat.openai.com", sel: 'main [role="presentation"]' },
    { host: "claude.ai", sel: 'main div[data-testid*="conversation"], main div[class*="conversation"]' },
    { host: "gemini.google.com", sel: 'main #chat-history, main [class*="conversation"]' },
    { host: "perplexity.ai", sel: 'main [class*="thread"]' },
    { host: "www.perplexity.ai", sel: 'main [class*="thread"]' },
    { host: "grok.com", sel: 'main [class*="conversation"], main [class*="thread"]' },
    { host: "x.com", sel: 'main [aria-label*="conversation"]' },
    { host: "www.kimi.com", sel: 'main [class*="chat"], main [class*="conversation"]' },
    { host: "kimi.com", sel: 'main [class*="chat"]' },
    { host: "chat.deepseek.com", sel: 'main [class*="conversation"], main [class*="chat"]' },
  ];

  // Find the biggest article-like block on a regular page — biggest <article>,
  // <main>, or content-heavy <div>. Skips nav/header/footer/aside/menus.
  function findArticle() {
    // Try semantic tags first
    const article = document.querySelector("article");
    if (article && article.innerText && article.innerText.length > 300) return article;
    const main = document.querySelector("main");
    if (main && main.innerText && main.innerText.length > 300) {
      // Strip common UI noise inside main
      const clone = main.cloneNode(true);
      clone.querySelectorAll("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='complementary'], .menu, .sidebar, button").forEach((el) => el.remove());
      return clone;
    }
    // Last resort — body
    return document.body;
  }

  function readPage() {
    // The page can BECOME sensitive after summon (SPA navigates to a login or
    // checkout view). Re-check on every read; trip the shield if so.
    if (pageIsSensitive()) { tripSensitive(); return ""; }
    try {
      const host = location.hostname;
      const chatSite = CHAT_CONTAINERS.find((c) => c.host === host);
      let text = "";
      if (chatSite) {
        const container = document.querySelector(chatSite.sel);
        if (container && container.innerText) {
          text = container.innerText.trim();
        }
      }
      if (!text) {
        // Regular page: find the article, strip UI chrome
        const el = findArticle();
        text = (el.innerText || "").trim();
      }
      if (!text) text = (document.body.innerText || "").trim();
      // Collapse blank lines — Readability's cheap trick that helps a lot
      text = text.replace(/\n\s*\n+/g, "\n\n").replace(/[ \t]+/g, " ");
      if (text.length > 16000) text = text.slice(-16000);
      return text;
    } catch (_) {
      return (document.body.innerText || "").trim().slice(-16000);
    }
  }

  // Save a lightweight memory of the current page — only called when the user
  // actually engages with Roody (voice or text). No LLM cost, just a heuristic
  // summary: site + title + first 200 chars of extracted content.
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
      // If we already remember this URL+title recently, just update ts
      const dupIdx = mem.findIndex((m) => m.site === entry.site && m.title === entry.title);
      if (dupIdx >= 0) {
        mem[dupIdx] = entry;
      } else {
        mem.push(entry);
      }
      while (mem.length > 20) mem.shift(); // keep last 20 only
      await chrome.storage.local.set({
        roodyMemory: mem,
        roodyTalkCount: (roodyTalkCount || 0) + 1, // relationship depth, made visible
      });
    } catch (_) {}
  }

  // The most recent task — tail of what's on screen. Cheap, focused.
  function recentTask() {
    const t = readPage();
    return t ? t.slice(-2500) : "";
  }

  // Incrementally capture new content as it appears — called by
  // MutationObserver. Merges new lines into pageCache without scrolling.
  let captureTimer = null;
  function captureIncremental() {
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
    // Keep Set from growing unbounded
    if (seenLines.size > 5000) {
      seenLines.clear();
      pageCache.split("\n").forEach((l) => { const t = l.trim(); if (t) seenLines.add(t); });
    }
  }
  function debouncedCapture() {
    if (captureTimer) return;
    captureTimer = setTimeout(() => { captureTimer = null; captureIncremental(); }, 800);
  }

  // Best context to send the brain — cached history + current screen.
  function buildContext() {
    captureIncremental();
    return pageCache;
  }

  // ---- UI -------------------------------------------------------------------
  const orb = document.createElement("div");
  orb.id = "roody-orb";
  orb.title = "Talk to Roody";
  orb.textContent = "🟠";

  const panel = document.createElement("div");
  panel.id = "roody-panel";
  panel.style.display = "none";
  panel.innerHTML = `
    <div id="roody-header">
      <div id="roody-headtext">
        <span id="roody-title">Roody</span>
        <span id="roody-sub">read-only · one switch · conversation flows</span>
      </div>
      <button id="roody-gear" title="Settings" style="background:none;border:none;font-size:15px;cursor:pointer;opacity:.65;padding:2px 6px">⚙</button>
      <button id="roody-close" title="Close">×</button>
    </div>
    <div id="roody-log"></div>
    <div id="roody-toggle-row">
      <button id="roody-toggle" title="Turn voice ON / OFF">
        <span id="roody-toggle-icon">🎙️</span>
        <span id="roody-toggle-label">Voice OFF — tap to start</span>
      </button>
    </div>
    <div id="roody-hearing" style="display:none;padding:4px 12px;font-size:12px;color:#8a7560;background:#fff7ec;border-top:1px solid #f0e2cf;font-style:italic;min-height:18px">
      <span id="roody-hearing-text"></span>
    </div>
    <div id="roody-inputrow">
      <input id="roody-text" type="text" placeholder="…or just type to Roody" autocomplete="off" />
      <button id="roody-send" title="Send">➤</button>
    </div>
  `;

  document.body.appendChild(orb);
  document.body.appendChild(panel);

  // ---- Draggable orb (any corner / edge of the screen) ---------------------
  // Click = open panel. Drag = move it. Position persists across pages.
  (function makeDraggable() {
    let down = null;
    let moved = false;

    chrome.storage.local.get(["roodyOrbPos"]).then(({ roodyOrbPos }) => {
      if (roodyOrbPos) applyOrbPos(roodyOrbPos);
    });

    function applyOrbPos(p) {
      orb.style.right = "auto";
      orb.style.bottom = "auto";
      orb.style.left = p.left + "px";
      orb.style.top = p.top + "px";
    }

    orb.addEventListener("mousedown", (e) => {
      const r = orb.getBoundingClientRect();
      down = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
      moved = false;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.sx;
      const dy = e.clientY - down.sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return; // tiny = still a click
      moved = true;
      const w = orb.offsetWidth, h = orb.offsetHeight;
      const left = Math.max(4, Math.min(window.innerWidth - w - 4, down.ox + dx));
      const top = Math.max(4, Math.min(window.innerHeight - h - 4, down.oy + dy));
      applyOrbPos({ left, top });
    });
    window.addEventListener("mouseup", () => {
      if (!down) return;
      if (moved) {
        const r = orb.getBoundingClientRect();
        chrome.storage.local.set({ roodyOrbPos: { left: r.left, top: r.top } });
      }
      down = null;
      setTimeout(() => (moved = false), 50);
    });
    // Swallow the click that follows a drag so it doesn't accidentally open.
    orb.addEventListener("click", (e) => { if (moved) e.stopImmediatePropagation(); }, true);
  })();

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

  // Roody talks first: looks at JUST the latest task on the page and opens up.
  const OPENER_PROMPT =
    "(The user just opened you. Look ONLY at the most recent thing on the page — their latest message and the latest answer. Open the conversation out loud: one warm, short line about what they're working on, then ask them one thing. One or two sentences, spoken. Don't summarize the whole page.)";

  function openingHello() {
    const recent = recentTask();
    if (!recent) {
      const hi = "Hey, I'm Roody. What are we looking at?";
      addBubble("roody", hi);
      speak(hi);
      return;
    }
    const thinking = addBubble("roody", "…");
    callRoody(OPENER_PROMPT, recent, (t) => (thinking.textContent = t));
  }
  panel.querySelector("#roody-close").addEventListener("click", () => {
    panel.style.display = "none";
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
        else { panel.style.display = "none"; orb.style.display = "none"; stopEverything(); }
        sendResponse({ ok: true });
      }
    });
  } catch (_) {}

  // Auto-chime is now a settings checkbox (off by default). The header has no
  // toggle for it — keeps the UI dead simple.
  function reflectListenState() {}

  function addBubble(who, text) {
    const b = document.createElement("div");
    b.className = `roody-bubble roody-${who}`;
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  let currentAudio = null;
  let speakToken = 0; // bumped on stop so stale TTS replies don't start playing
  let ttsWarned = false;

  // Pick a female-sounding voice for the browser fallback. Browsers don't expose
  // a gender flag, so we score by known-female names. Cached after first pick.
  let pickedFemaleVoice = null;
  function pickFemaleVoice() {
    if (pickedFemaleVoice) return pickedFemaleVoice;
    if (!synth) return null;
    const voices = synth.getVoices() || [];
    if (!voices.length) return null; // Chrome loads voices async — try again later
    const femaleHints = /(female|samantha|victoria|karen|tessa|allison|ava|susan|zira|hazel|fiona|moira|kate|serena|catherine|jenny|aria|emma|sophie|amy|joanna|salli|kimberly|kendra|sara|nora|nicole|google us english|google uk english female)/i;
    // Prefer English female voices first
    const enFemale = voices.find((v) => /^en/i.test(v.lang) && femaleHints.test(v.name));
    if (enFemale) return (pickedFemaleVoice = enFemale);
    const anyFemale = voices.find((v) => femaleHints.test(v.name));
    if (anyFemale) return (pickedFemaleVoice = anyFemale);
    // Last resort: any English voice (likely sounds neutral, beats nothing)
    return voices.find((v) => /^en/i.test(v.lang)) || null;
  }
  // Some browsers load the voice list asynchronously — listen for it.
  if (synth && typeof synth.onvoiceschanged !== "undefined") {
    synth.addEventListener("voiceschanged", () => { pickedFemaleVoice = null; pickFemaleVoice(); });
  }

  function browserSpeak(text, onDone) {
    if (!synth) {
      if (onDone) onDone();
      return;
    }
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickFemaleVoice();
      if (v) u.voice = v;
      u.rate = 1.0;
      u.pitch = 1.05; // a touch higher = slightly warmer/femme on system voices
      setOrbState("speaking");
      setMic("speaking");
      u.onend = () => {
        setOrbState("idle");
        if (micState === "speaking") setMic("idle");
        if (onDone) onDone();
      };
      synth.speak(u);
    } catch (_) {
      setOrbState("idle");
      if (micState === "speaking") setMic("idle");
      if (onDone) onDone();
    }
  }

  // Stop Roody talking, right now.
  function stopSpeaking() {
    speakToken++;
    isRoodySpeaking = false;
    try { if (synth) synth.cancel(); } catch (_) {}
    try {
      if (currentAudio) {
        if (typeof currentAudio.close === "function") {
          currentAudio.close();
        } else {
          currentAudio.pause();
          currentAudio.currentTime = 0;
        }
        currentAudio = null;
      }
    } catch (_) {}
    setOrbState("idle");
  }

  // Orb glow: green = speaking, red = stopped/idle, default orange otherwise.
  function setOrbState(state) {
    orb.classList.remove("roody-speaking", "roody-stopped");
    if (state === "speaking") orb.classList.add("roody-speaking");
    // idle = back to default orange (no class), not red
  }

  // Roody's warm voice: Gemini TTS if available, else the free browser voice.
  // onDone fires when Roody finishes speaking (used to auto-listen in voice mode).
  function speak(text, onDone) {
    if (!text) {
      if (onDone) onDone();
      return;
    }
    if (!geminiVoice) { rlog("🔈 ROBOTIC voice (no premium key set — add ElevenLabs or Gemini key in Settings)"); return browserSpeak(text, onDone); }
    rlog("→ requesting warm voice from background");
    const myToken = speakToken;
    chrome.runtime.sendMessage({ type: "roody:tts", payload: { text } }, async (res) => {
      if (myToken !== speakToken) return; // user pressed stop while we waited
      if (chrome.runtime.lastError || !res || !res.ok || !res.audioBase64) {
        const why = (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                    (res && res.error) || "no response";
        rlog(`🔈 ROBOTIC voice (warm TTS failed: ${String(why).slice(0, 120)})`);
        if (!ttsWarned) {
          ttsWarned = true;
          addBubble(
            "roody",
            "🔈 (warm voice didn't connect: " + String(why).slice(0, 120) +
              ". Open Settings, check your ElevenLabs/Gemini key, then refresh this tab.)"
          );
        }
        return browserSpeak(text, onDone); // graceful fallback
      }
      const sizeKB = Math.round((res.audioBase64.length * 3) / 4 / 1024);
      rlog(`🔊 Roody warm voice playing (${res.mime}, ${sizeKB}KB)`);
      try {
        // ElevenLabs returns MP3 (audio/mpeg) — play as-is.
        // Gemini returns raw PCM with rate hint in mime — wrap in WAV header.
        const isPcm = /pcm|L16/i.test(res.mime || "");
        const rawBytes = base64ToBytes(res.audioBase64);
        const blob = isPcm
          ? pcm16ToWav(rawBytes, rateFromMime(res.mime))
          : new Blob([rawBytes], { type: res.mime || "audio/mpeg" });

        stopSpeaking(); // clear anything currently playing first
        setOrbState("speaking");
        setMic("speaking");

        // Use AudioContext.decodeAudioData for playback. The standard
        // new Audio(blobURL) path silently fails on some sites (claude.ai)
        // due to CSP or autoplay restrictions, causing a hidden fallback to
        // the robotic browser voice with no log entry.
        const arrayBuf = await blob.arrayBuffer();
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        currentAudio = actx;
        let audioBuf;
        try {
          audioBuf = await actx.decodeAudioData(arrayBuf);
        } catch (decodeErr) {
          try { actx.close(); } catch (_) {}
          if (currentAudio === actx) currentAudio = null;
          throw decodeErr;
        }
        const src = actx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(actx.destination);
        src.onended = () => {
          try { actx.close(); } catch (_) {}
          if (currentAudio === actx) currentAudio = null;
          setOrbState("idle");
          if (micState === "speaking") setMic("idle");
          if (onDone) onDone();
        };
        src.start(0);
        rlog(`▶ AudioContext playback started (${(audioBuf.duration).toFixed(1)}s)`);
      } catch (e) {
        rlog(`⚠ AudioContext failed (${e.message}) → robotic fallback`);
        browserSpeak(text, onDone);
      }
    });
  }

  // ---- Talking to Roody's brain --------------------------------------------
  // onText fills the bubble; onSpoken (optional) fires after Roody finishes
  // speaking — used by hands-free voice mode to auto-listen next. `mode` is
  // "voice" when this comes from the voice loop (triggers speed-tuned settings
  // in the background: no web search, smaller context, shorter reply, etc).
  function callRoody(userText, pageContext, onText, onSpoken, mode, opts) {
    const skipHistory = opts && opts.skipHistory;
    const noSpeak = opts && opts.noSpeak; // text bubble only — used by rituals
    let settled = false;
    const finish = (text, speakIt) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      onText(text);
      if (speakIt) {
        if (!skipHistory) {
          history.push({ role: "user", content: userText });
          history.push({ role: "assistant", content: text });
          if (history.length > 20) history.splice(0, history.length - 20);
        }
        if (noSpeak) {
          if (onSpoken) onSpoken();
        } else {
          speak(text, onSpoken);
        }
      } else if (onSpoken) {
        onSpoken();
      }
    };

    // Safety net: if the brain doesn't answer in 30s (asleep service worker,
    // dead network, lost message channel) — say so instead of spinning on "…".
    const watchdog = setTimeout(() => {
      rlog("⏱ brain timed out (no reply in 30s)");
      finish("That took too long and I didn't hear back — try once more?", false);
    }, 30000);

    try {
      chrome.runtime.sendMessage(
        { type: "roody:ask", payload: { userText, pageContext, history, mode, site: location.hostname, title: document.title } },
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
      finish("Roody just updated — please refresh this page so I can reconnect.", false);
    }
  }

  // You asked Roody something.
  function send(userText) {
    userText = (userText || "").trim();
    if (!userText) return;
    rememberPage(); // engagement: user talked to Roody on this page
    addBubble("you", userText);
    input.value = "";
    const thinking = addBubble("roody", "…");
    setMic("thinking");
    const ctx = buildContext();
    callRoody(
      userText,
      ctx,
      (t) => (thinking.textContent = t),
      () => setMic("idle") // back to a tap-to-talk mic when Roody's done speaking
    );
  }

  panel.querySelector("#roody-send").addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send(input.value);
  });

  // ---- Live watching: react when new content appears -----------------------
  const REACTION_PROMPT =
    "(A new answer just appeared on the page. You're reading along with the user. React naturally in ONE short spoken sentence — like a friend looking over their shoulder. Be helpful: if something looks wrong, point it out. If it's interesting, say so. If you spot a bug, warn them. If it's a good answer, celebrate. Make a joke if the moment calls for it. Keep it to one or two sentences, spoken aloud.)";

  const PROACTIVE_PROMPTS = [
    "(You're their best friend hanging out while they work. Glance at what's on screen and say ONE thing — a genuinely useful tip, a playful tease about what they're doing, or a quick idea they might not have thought of. Be specific to what's actually on screen. One sentence, spoken, friend-energy.)",
    "(Best friend check-in: look at what they're doing. If something's off, warn them like a friend — 'hold up, that's gonna bite you.' If they seem stuck or idle, throw out a quick idea to unstick them. If it's going well, hype them or crack a joke. One sentence, spoken.)",
    "(You've been quietly reading along. Say something that makes them smile OR gives them a genuinely useful thought — a connection to something they did earlier, a better approach, or just a funny observation about the situation. One sentence, spoken, never generic.)",
  ];

  async function reactToNewAnswer() {
    if (reacting) return;
    if (!(await canISpeak())) return; // another tab is the active speaker
    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";

    const thinking = addBubble("roody", "…");
    const ctx = recentTask();
    callRoody(REACTION_PROMPT, ctx, (t) => {
      thinking.textContent = t;
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    }, undefined, undefined, { skipHistory: true });
  }

  // Proactive check-in: Roody glances at what you're doing and says something
  // useful without being asked. Only fires when auto-chime is on, tab is visible,
  // this tab is the leader, and the page has changed significantly.
  async function proactiveCheckIn() {
    if (!autoChime || reacting || voiceOn) return;
    if (Date.now() - lastReactTime < REACT_COOLDOWN_MS) return;
    if (document.hidden) return; // don't speak from background tabs
    // Require a meaningful change — 800 chars can differ by a cursor blink
    const current = readPage().slice(-1200);
    if (!lastCacheSnapshot) { lastCacheSnapshot = current; return; }
    const diffLen = Math.abs(current.length - lastCacheSnapshot.length);
    const changedALot = diffLen > 200 || current.slice(-200) !== lastCacheSnapshot.slice(-200);
    if (!changedALot) return;
    if (!(await canISpeak())) return; // another tab is the active speaker
    lastCacheSnapshot = current;

    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";
    const thinking = addBubble("roody", "…");
    const prompt = PROACTIVE_PROMPTS[Math.floor(Math.random() * PROACTIVE_PROMPTS.length)];
    callRoody(prompt, recentTask(), (t) => {
      thinking.textContent = t;
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    }, undefined, undefined, { skipHistory: true });
  }

  function onSettled() {
    if (!autoChime || reacting) return;
    if (voiceOn) return;
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

    // Proactive check-in timer — Roody periodically glances at what you're
    // doing and says something useful. Only when auto-chime is ON.
    setInterval(proactiveCheckIn, PROACTIVE_INTERVAL_MS);
  }

  // ---- THE one switch: Voice ON / OFF -------------------------------------
  // ON  = Roody talks first, listens always, you interrupt by talking.
  // OFF = full silence, no listening, no talking.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const toggleBtn = panel.querySelector("#roody-toggle");
  const toggleIcon = panel.querySelector("#roody-toggle-icon");
  const toggleLabel = panel.querySelector("#roody-toggle-label");
  // micState is kept for orb/CSS hooks elsewhere; meanings here are advisory.
  let micState = "idle";
  function setMic(state) { micState = state; }
  function setToggleVisual(on) {
    toggleBtn.classList.toggle("on", on);
    toggleIcon.textContent = on ? "🔴" : "🎙️";
    toggleLabel.textContent = on ? "Voice ON — tap to stop" : "Voice OFF — tap to start";
  }
  setToggleVisual(false);

  // ---- The voice loop -----------------------------------------------------
  // Continuous SpeechRecognition. When ON, Roody listens; we PAUSE the mic
  // while Roody speaks to kill self-echo. Toggle OFF cancels everything in
  // flight via turnSession so late callbacks bail cleanly.
  let voiceOn = false;
  let sr = null;
  let recentRoodyWords = ""; // for echo filter (second line of defense)
  let isRoodySpeaking = false; // gates SR auto-restart
  let turnSession = 0; // bumped on Voice OFF — late Claude/TTS replies bail
  // Short interrupt words the user can say to CUT ROODY OFF while it's talking.
  // Matches optional name prefix — "roody stop", "hey rudy wait", plus common
  // speech-recognition mishearings of "Roody" (rory, ruby, rudi, woody, buddy).
  const INTERRUPT_PATTERN = /^(hey |ok |okay )?(roody|rudy|rudi|rory|ruby|woody|buddy|rudey)?[\s,]*(stop|wait|pause|shush|hush|hold on|hang on|shut up|quiet|be quiet|silence|nope|no wait|cancel|nevermind|never mind|enough)[\s.,!?]*$/i;
  // Full voice-off by voice: "roody go to sleep", "roody voice off", "bye roody".
  const VOICE_OFF_PATTERN = /^(hey |ok |okay )?(roody|rudy|rudi|rory|ruby|woody|buddy|rudey)?[\s,]*(go to sleep|sleep now|turn off|voice off|power down|good ?night|goodbye|bye bye)[\s.,!?]*$/i;

  let srLang = "en-US"; // updated from settings at boot + on change

  function buildSR() {
    if (!SR) { rlog("❌ SpeechRecognition unavailable in this browser"); return null; }
    const r = new SR();
    r.lang = srLang;
    // continuous + interim = the recognition stays alive and streams partials,
    // which is far more reliable than the stop-after-one-phrase mode that was
    // silently dropping whole utterances.
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let gotResult = false;
    r.onstart = () => {
      rlog("🎤 SR start (listening)");
      const h = document.getElementById("roody-hearing");
      const ht = document.getElementById("roody-hearing-text");
      if (h) { h.style.display = "block"; ht.textContent = "🎤 listening…"; }
    };
    r.onaudiostart = () => rlog("🎤 audio capture began");
    r.onspeechstart = () => {
      rlog("🎤 speech detected — you started talking");
      const ht = document.getElementById("roody-hearing-text");
      if (ht) ht.textContent = "🎤 hearing you…";
    };
    r.onspeechend = () => rlog("🎤 speech ended");
    r.onresult = (e) => {
      const hearingEl = document.getElementById("roody-hearing");
      const hearingText = document.getElementById("roody-hearing-text");
      // Walk results from resultIndex; show interims live, act on finals.
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const transcript = (res[0].transcript || "").trim();
        if (!res.isFinal) {
          if (transcript && hearingEl) {
            hearingEl.style.display = "block";
            hearingText.textContent = `🎤 hearing: "${transcript}"`;
          }
          // BARGE-IN: if Roody is speaking and user says a short interrupt
          // word, cut Roody off immediately — don't wait for final transcript.
          if (isRoodySpeaking && INTERRUPT_PATTERN.test(transcript)) {
            rlog(`⚡ INTERRUPT detected: "${transcript}" — cutting Roody off`);
            stopSpeaking();
            if (hearingEl) hearingText.textContent = "⚡ stopped";
            return;
          }
          continue;
        }
        const conf = (res[0].confidence || 0).toFixed(2);
        if (!transcript) continue;
        gotResult = true;
        // Show final transcript briefly, then hide
        if (hearingEl) {
          hearingEl.style.display = "block";
          hearingText.textContent = `✓ heard: "${transcript}" (${conf})`;
          setTimeout(() => { hearingEl.style.display = "none"; }, 3000);
        }
        rlog(`🎤 HEARD: "${transcript}" (conf=${conf})`);
        onUserSpoke(transcript);
        return;
      }
    };
    r.onnomatch = () => rlog("🎤 no match — heard sound but couldn't make out words");
    r.onerror = (e) => rlog(`⚠ SR error: ${e.error || "unknown"}`);
    r.onend = () => {
      const h = document.getElementById("roody-hearing");
      const ht = document.getElementById("roody-hearing-text");
      if (!gotResult) {
        rlog("🎤 SR ended (no transcript — speech backend returned nothing)");
        if (h) { h.style.display = "block"; ht.textContent = "🎤 didn't catch that — try again"; setTimeout(() => { h.style.display = "none"; }, 2500); }
      } else {
        rlog("🎤 SR ended");
      }
      // Keep the mic active even during Roody's speech so we can hear
      // barge-in interrupts ("stop", "wait"). Echo cancellation + the
      // INTERRUPT_PATTERN filter keep it from picking up Roody's own voice.
      if (!voiceOn) return;
      setTimeout(() => {
        if (!voiceOn) return;
        sr = buildSR();
        try { sr && sr.start(); rlog("🎤 SR restart (fresh)"); }
        catch (e) { rlog(`⚠ SR restart failed: ${e.message}`); }
      }, 300);
    };
    return r;
  }

  function startListening() {
    if (!voiceOn) return;
    if (!sr) sr = buildSR();
    if (!sr) {
      addBubble("roody", "This browser can't listen hands-free — you can still type to me.");
      voiceTurnOff();
      return;
    }
    try { sr.start(); } catch (_) {}
  }

  function stopListening() {
    if (!sr) return;
    try { sr.onend = null; sr.stop(); } catch (_) {}
    sr = null;
  }

  // Cheap echo filter: was that 'user speech' actually Roody's voice echoing
  // back through the speakers? If most of it appears in what Roody just said,
  // skip it. Not perfect — true barge-in needs Deepgram + echo cancellation —
  // but works well in normal use.
  function isProbablyEcho(text) {
    if (!recentRoodyWords) return false;
    const t = (text || "").toLowerCase().trim();
    if (t.length < 6) return false;
    const haystack = recentRoodyWords.toLowerCase();
    // If a 12-char chunk appears verbatim in Roody's recent speech → echo.
    for (let i = 0; i + 12 <= t.length; i += 4) {
      if (haystack.includes(t.slice(i, i + 12))) return true;
    }
    return false;
  }

  function onUserSpoke(rawText) {
    const text = (rawText || "").trim();
    if (!voiceOn) { rlog("…ignored (voiceOn=false)"); return; }
    if (!text) { rlog("…ignored (empty)"); return; }
    if (isProbablyEcho(text)) { rlog(`…ignored as ECHO of Roody's last reply: "${text}"`); return; }
    // Full voice-off by voice — works any time, even mid-speech.
    if (VOICE_OFF_PATTERN.test(text)) {
      rlog(`😴 voice-off command: "${text}"`);
      addBubble("roody", "😴 Going quiet — tap the mic when you want me back.");
      voiceTurnOff();
      return;
    }
    // If Roody is currently speaking, only interrupt-words are actioned
    // (already handled at the interim level). Full sentences during Roody's
    // turn are ignored so we don't queue up a new brain call while the old
    // one is playing.
    if (isRoodySpeaking && !INTERRUPT_PATTERN.test(text)) {
      rlog(`…ignored (Roody is speaking, not an interrupt word): "${text}"`);
      return;
    }
    rlog(`→ sending to brain: "${text}"`);
    rememberPage(); // engagement: user spoke to Roody on this page
    stopListening();
    stopSpeaking();
    addBubble("you", text);
    const thinking = addBubble("roody", "…");
    setMic("thinking");
    const sentAt = performance.now();
    const mySession = turnSession;
    isRoodySpeaking = true; // claim the speaking lane immediately
    callRoody(
      text,
      recentTask(),
      (t) => {
        if (mySession !== turnSession) { rlog("…dropped reply (Voice was turned OFF)"); return; }
        const ms = Math.round(performance.now() - sentAt);
        rlog(`🧠 brain replied in ${ms}ms (${t.length} chars)`);
        thinking.textContent = t;
        recentRoodyWords = t;
      },
      () => {
        // This fires after Roody finishes speaking the reply (or fails to).
        isRoodySpeaking = false;
        if (mySession !== turnSession) { rlog("…suppressed listen-resume (Voice OFF)"); return; }
        rlog("🔊 Roody finished speaking → resume listening");
        setMic("idle");
        if (voiceOn) startListening();
      },
      "voice" // speed-tuned: no web search, short reply, trimmed history
    );
  }

  async function voiceTurnOn() {
    if (voiceOn) return;
    if (!SR) {
      rlog("❌ Can't turn voice on — no SpeechRecognition support");
      addBubble("roody", "This browser can't do hands-free voice — try Chrome. You can still type to me.");
      return;
    }
    rlog("===== VOICE ON =====");
    voiceOn = true;
    setToggleVisual(true);
    if (panel.style.display === "none") panel.style.display = "flex";

    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      s.getTracks().forEach((t) => t.stop());
      rlog("✓ mic permission OK (echo-cancellation on)");
    } catch (e) { rlog(`⚠ mic permission: ${e.message}`); }

    // If Roody already greeted from the orb-open, DON'T greet again — just
    // start listening straight away. This was the double-opener bug that made
    // two API calls fire and the second TTS 500.
    if (openerSent) {
      rlog("⤳ Roody already greeted — starting to listen straight away");
      startListening();
      return;
    }

    // First-ever greeting: Roody opens the conversation, then listens after.
    openerSent = true;
    const mySession = turnSession;
    isRoodySpeaking = true;
    const thinking = addBubble("roody", "…");
    callRoody(
      OPENER_PROMPT,
      recentTask() || "(nothing visible yet)",
      (t) => {
        if (mySession !== turnSession) return;
        thinking.textContent = t;
        recentRoodyWords = t;
      },
      () => {
        isRoodySpeaking = false;
        if (mySession !== turnSession) return;
        if (voiceOn) startListening();
      },
      "voice"
    );
  }

  function voiceTurnOff() {
    rlog("===== VOICE OFF =====");
    voiceOn = false;
    turnSession++; // any in-flight Claude/TTS callbacks will now bail
    isRoodySpeaking = false;
    reacting = false; // release the reaction lock too
    setToggleVisual(false);
    stopSpeaking();
    stopListening();
    setMic("idle");
    releaseLeadership(); // let other tabs take over
    const h = document.getElementById("roody-hearing");
    if (h) h.style.display = "none";
  }

  // Debounce the toggle so rapid clicks can't double-fire voiceTurnOn while
  // the previous one is still awaiting getUserMedia — that's the "loop" bug.
  let toggleLock = false;
  toggleBtn.addEventListener("click", async () => {
    if (toggleLock) return;
    toggleLock = true;
    try {
      if (voiceOn) voiceTurnOff();
      else await voiceTurnOn();
    } finally {
      setTimeout(() => { toggleLock = false; }, 500);
    }
  });

  // Keep the legacy stopEverything callable for other paths (auto-chime, etc.)
  function stopEverything() {
    stopSpeaking();
    if (voiceOn) voiceTurnOff();
    setMic("idle");
  }

  // Page became sensitive mid-session (login/checkout appeared) — Roody
  // packs up and leaves: voice off, mic off, UI hidden, one-line explanation.
  let sensitiveTripped = false;
  function tripSensitive() {
    if (sensitiveTripped) return;
    sensitiveTripped = true;
    rlog("🙈 sensitive fields appeared — Roody disabling on this page");
    try { stopEverything(); } catch (_) {}
    orb.style.display = "none";
    panel.style.display = "none";
    refusalToast();
  }

  // ---- Daily rituals (the Hook loop) ----------------------------------------
  // Morning hello: first browser-open of the day, Roody greets you with one
  // line referencing yesterday's notebook. Found-something: returning to a
  // site you've worked on before, Roody SOMETIMES (30%) has an observation
  // waiting — the variable reward. Both are text bubbles (autoplay rules
  // block audio before the user interacts with the page).
  const MORNING_PROMPT =
    "(First time the user opened their browser today. Greet them like a best friend starting the day — ONE warm short line that references what they were working on recently (check your notebook). Like 'Morning! Still fighting that visa form?' Then stop. Max two sentences.)";
  const FOUND_PROMPT =
    "(The user just came back to a page they've worked on before. You were 'reading while they were away' — give ONE genuinely useful or interesting observation about what's on the page, casually. If something looks off, flag it. Max two sentences.)";

  async function dailyRituals() {
    try {
      // In click-to-summon mode the summon greeting already served as the
      // hello — skip rituals to avoid double greetings and double API calls.
      // (Kept for a future auto-appear mode.)
      if (openerSent) return;
      if (document.hidden) return;
      if (orb.style.display === "none") return; // Roody is disabled
      const today = new Date().toISOString().slice(0, 10);
      const { roodyLastHello, roodyMemory, roodyLastFound } = await chrome.storage.local.get([
        "roodyLastHello", "roodyMemory", "roodyLastFound",
      ]);
      const mem = Array.isArray(roodyMemory) ? roodyMemory : [];

      // Morning hello — once per day, only if there's a notebook to reference.
      if (roodyLastHello !== today && mem.length > 0) {
        if (!(await canISpeak())) return;
        await chrome.storage.local.set({ roodyLastHello: today });
        rlog("🌅 morning hello");
        openerSent = true; // counts as the greeting — no double-opener later
        panel.style.display = "flex";
        const thinking = addBubble("roody", "…");
        callRoody(MORNING_PROMPT, recentTask() || "(nothing on screen yet)", (t) => {
          thinking.textContent = t;
        }, undefined, undefined, { skipHistory: true, noSpeak: true });
        return;
      }

      // Found-something — returning to a site you've engaged Roody on before.
      // SOMETIMES (30%), max once an hour. Variability is the point.
      if (mem.some((m) => m.site === location.hostname) && Math.random() < 0.3) {
        const now = Date.now();
        if (roodyLastFound && now - roodyLastFound < 3600000) return;
        if (!(await canISpeak())) return;
        await chrome.storage.local.set({ roodyLastFound: now });
        rlog("👀 found-something moment");
        panel.style.display = "flex";
        const thinking = addBubble("roody", "…");
        callRoody(FOUND_PROMPT, recentTask() || "(nothing on screen yet)", (t) => {
          thinking.textContent = t;
        }, undefined, undefined, { skipHistory: true, noSpeak: true });
      }
    } catch (e) { rlog(`⚠ rituals: ${e.message}`); }
  }

  // ---- Boot -----------------------------------------------------------------
  chrome.storage.local
    .get(["roodyAutoChime", "roodyGeminiKey", "roodyElevenKey", "roodyInviteCode", "roodyEnabled", "roodyLang"])
    .then((s) => {
      if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
      if (s.roodyLang) srLang = s.roodyLang;
      geminiVoice = !!(s.roodyElevenKey || s.roodyGeminiKey || s.roodyInviteCode);
      applyEnabled(s.roodyEnabled !== false); // default on
      reflectListenState();
    // Don't react to whatever is already on the page when we load —
    // only to answers that appear from now on.
    lastAnswerSig = readPage().slice(-600);
    startWatching();
    // The user just SUMMONED Roody (clicked the toolbar icon) — open the
    // panel and greet right away. That click IS the invitation.
    if (!openerSent) {
      openerSent = true;
      panel.style.display = "flex";
      openingHello();
    }
    // Rituals only matter for long-lived pages after the greeting.
    setTimeout(dailyRituals, 6000);

    // React to the master switch flipping in settings without a refresh.
    // Also live-update the warm-voice flag when either TTS key is added/cleared
    // — otherwise pages opened BEFORE the key was set stay stuck on robotic
    // voice forever (the boot-time read of geminiVoice never re-runs).
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.roodyEnabled) applyEnabled(changes.roodyEnabled.newValue !== false);
      if (changes.roodyElevenKey || changes.roodyGeminiKey || changes.roodyInviteCode) {
        chrome.storage.local
          .get(["roodyElevenKey", "roodyGeminiKey", "roodyInviteCode"])
          .then(({ roodyElevenKey, roodyGeminiKey, roodyInviteCode }) => {
            const before = geminiVoice;
            geminiVoice = !!(roodyElevenKey || roodyGeminiKey || roodyInviteCode);
            ttsWarned = false; // let the next failure re-surface, if any
            if (before !== geminiVoice) {
              rlog(`🔈 warm voice ${geminiVoice ? "ENABLED" : "DISABLED"} (key change picked up live)`);
            }
          });
      }
      if (changes.roodyLang) {
        srLang = changes.roodyLang.newValue || "en-US";
        rlog(`🌍 language changed to ${srLang}`);
      }
      if (changes.roodyAutoChime) {
        autoChime = changes.roodyAutoChime.newValue === true;
        rlog(`🔔 auto-chime ${autoChime ? "ON" : "OFF"} (picked up live)`);
      }
    });
  }).catch((e) => { rlog(`⚠ boot failed: ${e.message}`); });
})();
