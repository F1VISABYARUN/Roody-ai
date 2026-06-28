// Roody lives here: a calm orb on top of ChatGPT / Claude.
// It reads the on-page conversation (read-only), watches for new answers,
// talks with you by voice or text, and never touches anything on the page.

(function () {
  if (window.__roodyLoaded) return;
  window.__roodyLoaded = true;

  const history = []; // running chat between the human and Roody
  const synth = window.speechSynthesis;

  // Tuning knobs.
  const REACT_DEBOUNCE_MS = 1800; // how long the page must be quiet = answer finished
  const REACT_COOLDOWN_MS = 7000; // min gap between auto-reactions
  const GATHER_TTL_MS = 60000; // re-scroll-and-read the full thread at most this often
  const MAX_CONTEXT = 30000; // cap how much text we send to Claude

  let autoChime = false; // OFF by default — Roody stays quiet unless tapped
  let lastAnswerSig = ""; // fingerprint of the latest answer we've seen
  let reacting = false; // lock so we don't react on top of a reaction
  let lastReactTime = 0;
  let fullHistoryCache = "";
  let lastGatherTime = 0;
  let geminiVoice = false; // use Gemini for voice? (set at boot if a key exists)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Send a log line to the background so it shows up in Settings.
  function rlog(line) {
    try { chrome.runtime.sendMessage({ type: "roody:log", payload: { line } }); } catch (_) {}
    // also surface to devtools for quick eyeballing
    try { console.log("[Roody]", line); } catch (_) {}
  }
  rlog(`page=${location.hostname} ua=${navigator.userAgent.slice(0, 60)}`);

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

  // ---- Read the page (read-only) -------------------------------------------
  // The text currently rendered on screen — what you can see right now.
  function readPage() {
    const main = document.querySelector("main") || document.body;
    let text = (main.innerText || "").trim();
    if (text.length > 16000) text = text.slice(-16000);
    return text;
  }

  // Just the most recent task — the tail of what's on screen. Cheaper and
  // focused, so Roody talks about what you're doing right now, not the whole day.
  function recentTask() {
    const t = readPage();
    return t ? t.slice(-2500) : "";
  }

  // Find the scrollable container holding the conversation (best effort —
  // the biggest element on the page that actually scrolls).
  function findScrollContainer() {
    const root = document.querySelector("main") || document.body;
    let best = null;
    let bestH = 0;
    for (const el of root.querySelectorAll("*")) {
      const st = getComputedStyle(el);
      if (
        /(auto|scroll)/.test(st.overflowY) &&
        el.scrollHeight > el.clientHeight + 200 &&
        el.scrollHeight > bestH
      ) {
        best = el;
        bestH = el.scrollHeight;
      }
    }
    return best;
  }

  // Auto-scroll the thread to load older messages, collecting every line we
  // see along the way, then put the scroll position back where it was.
  async function gatherFullConversation() {
    const main = document.querySelector("main") || document.body;
    const sc = findScrollContainer();
    if (!sc) return readPage();

    const saved = sc.scrollTop;
    const lines = new Set();
    const capture = () => {
      (main.innerText || "").split("\n").forEach((l) => {
        l = l.trim();
        if (l) lines.add(l);
      });
    };

    sc.scrollTop = 0; // jump to the top to wake up the oldest messages
    await sleep(350);
    capture();

    const step = Math.max(300, sc.clientHeight - 100);
    for (let y = 0; y <= sc.scrollHeight; y += step) {
      sc.scrollTop = y;
      await sleep(220);
      capture();
    }

    sc.scrollTop = saved; // restore — don't disturb the reader
    let text = Array.from(lines).join("\n");
    if (text.length > MAX_CONTEXT) text = text.slice(-MAX_CONTEXT);
    return text;
  }

  // Get the best context to send Claude: the full thread (re-gathered if stale)
  // plus whatever is currently on screen.
  async function buildContext() {
    const now = Date.now();
    if (now - lastGatherTime > GATHER_TTL_MS) {
      fullHistoryCache = await gatherFullConversation();
      lastGatherTime = now;
      return fullHistoryCache;
    }
    let ctx = (fullHistoryCache ? fullHistoryCache + "\n" : "") + readPage();
    if (ctx.length > MAX_CONTEXT) ctx = ctx.slice(-MAX_CONTEXT);
    return ctx;
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
      <button id="roody-close" title="Close">×</button>
    </div>
    <div id="roody-log"></div>
    <div id="roody-toggle-row">
      <button id="roody-toggle" title="Turn voice ON / OFF">
        <span id="roody-toggle-icon">🎙️</span>
        <span id="roody-toggle-label">Voice OFF — tap to start</span>
      </button>
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
    speakToken++; // any in-flight TTS reply is now stale
    try { if (synth) synth.cancel(); } catch (_) {}
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
      }
    } catch (_) {}
    setOrbState("idle");
  }

  // Orb glow: green = speaking, red = stopped/idle, default orange otherwise.
  function setOrbState(state) {
    orb.classList.remove("roody-speaking", "roody-stopped");
    if (state === "speaking") orb.classList.add("roody-speaking");
    else if (state === "idle") orb.classList.add("roody-stopped");
  }

  // Roody's warm voice: Gemini TTS if available, else the free browser voice.
  // onDone fires when Roody finishes speaking (used to auto-listen in voice mode).
  function speak(text, onDone) {
    if (!text) {
      if (onDone) onDone();
      return;
    }
    if (!geminiVoice) return browserSpeak(text, onDone);
    const myToken = speakToken;
    chrome.runtime.sendMessage({ type: "roody:tts", payload: { text } }, (res) => {
      if (myToken !== speakToken) return; // user pressed stop while we waited
      if (chrome.runtime.lastError || !res || !res.ok || !res.audioBase64) {
        if (!ttsWarned && res && res.error) {
          ttsWarned = true;
          addBubble(
            "roody",
            "🔈 (my warm voice isn't connecting — using the plain browser voice. Gemini said: " +
              String(res.error).slice(0, 90) +
              ". Check your Gemini key in settings.)"
          );
        }
        return browserSpeak(text, onDone); // graceful fallback
      }
      try {
        const blob = pcm16ToWav(base64ToBytes(res.audioBase64), rateFromMime(res.mime));
        const url = URL.createObjectURL(blob);
        stopSpeaking(); // clear anything currently playing first
        const audio = new Audio(url);
        currentAudio = audio;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          URL.revokeObjectURL(url);
          setOrbState("idle");
          if (micState === "speaking") setMic("idle");
          if (onDone) onDone();
        };
        audio.onended = finish;
        setOrbState("speaking");
        setMic("speaking");
        audio.play().catch(() => {
          setOrbState("idle");
          if (micState === "speaking") setMic("idle");
          browserSpeak(text, onDone);
        });
      } catch (_) {
        browserSpeak(text, onDone);
      }
    });
  }

  // ---- Talking to Roody's brain --------------------------------------------
  // onText fills the bubble; onSpoken (optional) fires after Roody finishes
  // speaking — used by hands-free voice mode to auto-listen next.
  function callRoody(userText, pageContext, onText, onSpoken) {
    chrome.runtime.sendMessage(
      { type: "roody:ask", payload: { userText, pageContext, history } },
      (res) => {
        if (chrome.runtime.lastError) {
          onText("I lost the connection to my brain for a second. Try again?");
          if (onSpoken) onSpoken();
          return;
        }
        if (!res || !res.ok) {
          onText((res && res.error) || "Something went wrong.");
          if (onSpoken) onSpoken();
          return;
        }
        onText(res.text);
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: res.text });
        if (history.length > 20) history.splice(0, history.length - 20);
        speak(res.text, onSpoken);
      }
    );
  }

  // You asked Roody something.
  async function send(userText) {
    userText = (userText || "").trim();
    if (!userText) return;
    addBubble("you", userText);
    input.value = "";
    const thinking = addBubble("roody", "…");
    setMic("thinking");
    const ctx = await buildContext();
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

  // ---- Live watching: react when a new answer lands ------------------------
  const REACTION_PROMPT =
    "(A new answer just landed. React to it in ONE short spoken sentence, like a friend reading along. If it's code and something looks wrong, point to it; otherwise a quick thought or a question. Keep it tiny.)";

  async function reactToNewAnswer() {
    if (reacting) return;
    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";

    const thinking = addBubble("roody", "…");
    const ctx = recentTask(); // just the latest task, not the whole chat
    callRoody(REACTION_PROMPT, ctx, (t) => {
      thinking.textContent = t;
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    });
  }

  function onSettled() {
    if (!autoChime || reacting) return;
    if (voiceOn) return; // don't chime during a live voice conversation
    if (Date.now() - lastReactTime < REACT_COOLDOWN_MS) return;
    const sig = readPage().slice(-600); // fingerprint of the latest content
    if (sig === lastAnswerSig) return; // nothing actually new
    lastAnswerSig = sig;
    reactToNewAnswer();
  }

  function startWatching() {
    const main = document.querySelector("main") || document.body;
    let timer = null;
    const obs = new MutationObserver(() => {
      if (!autoChime) return;
      clearTimeout(timer);
      timer = setTimeout(onSettled, REACT_DEBOUNCE_MS); // wait for streaming to stop
    });
    obs.observe(main, { childList: true, subtree: true, characterData: true });
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
  // Continuous SpeechRecognition. When ON, Roody listens always; when you talk
  // it cuts Roody off (barge-in) and replies. Echo filter prevents Roody from
  // hearing its own voice. Toggle OFF stops everything cleanly.
  let voiceOn = false;
  let sr = null;
  let recentRoodyWords = ""; // for echo filter

  function buildSR() {
    if (!SR) { rlog("❌ SpeechRecognition unavailable in this browser"); return null; }
    const r = new SR();
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onstart = () => rlog("🎤 SR start (listening)");
    r.onaudiostart = () => rlog("🎤 audio capture began");
    r.onspeechstart = () => rlog("🎤 speech detected — you started talking");
    r.onspeechend = () => rlog("🎤 speech ended");
    r.onresult = (e) => {
      const heard = e.results[0][0].transcript || "";
      const conf = (e.results[0][0].confidence || 0).toFixed(2);
      rlog(`🎤 HEARD: "${heard}" (conf=${conf})`);
      onUserSpoke(heard);
    };
    r.onerror = (e) => rlog(`⚠ SR error: ${e.error || "unknown"}`);
    r.onend = () => {
      rlog("🎤 SR ended");
      if (voiceOn) setTimeout(() => {
        try { sr.start(); rlog("🎤 SR restart"); }
        catch (e) { rlog(`⚠ SR restart failed: ${e.message}`); }
      }, 250);
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
    rlog(`→ sending to brain: "${text}"`);
    stopSpeaking();
    addBubble("you", text);
    const thinking = addBubble("roody", "…");
    setMic("thinking");
    const sentAt = performance.now();
    callRoody(
      text,
      recentTask(),
      (t) => {
        const ms = Math.round(performance.now() - sentAt);
        rlog(`🧠 brain replied in ${ms}ms (${t.length} chars)`);
        thinking.textContent = t;
        recentRoodyWords = t;
      },
      () => { rlog("🔊 Roody finished speaking"); setMic("idle"); }
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

    // Roody opens the conversation based on what's on screen, then starts
    // listening as soon as it finishes speaking.
    const thinking = addBubble("roody", "…");
    callRoody(
      OPENER_PROMPT,
      recentTask() || "(nothing visible yet)",
      (t) => {
        thinking.textContent = t;
        recentRoodyWords = t;
      },
      () => { if (voiceOn) startListening(); }
    );
  }

  function voiceTurnOff() {
    rlog("===== VOICE OFF =====");
    voiceOn = false;
    setToggleVisual(false);
    stopSpeaking();
    stopListening();
    setMic("idle");
  }

  toggleBtn.addEventListener("click", () => {
    if (voiceOn) voiceTurnOff();
    else voiceTurnOn();
  });

  // Keep the legacy stopEverything callable for other paths (auto-chime, etc.)
  function stopEverything() {
    stopSpeaking();
    if (voiceOn) voiceTurnOff();
    setMic("idle");
  }

  // ---- Boot -----------------------------------------------------------------
  chrome.storage.local
    .get(["roodyAutoChime", "roodyGeminiKey", "roodyEnabled"])
    .then((s) => {
      if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
      geminiVoice = !!s.roodyGeminiKey; // warm voice on if a Gemini key is saved
      applyEnabled(s.roodyEnabled !== false); // default on
      reflectListenState();
    // Don't react to whatever is already on the page when we load —
    // only to answers that appear from now on.
    lastAnswerSig = readPage().slice(-600);
    startWatching();

    // React to the master switch flipping in settings without a refresh.
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.roodyEnabled) applyEnabled(changes.roodyEnabled.newValue !== false);
    });
  });
})();
