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
  const MAX_CONTEXT = 30000; // cap how much text we send to Claude
  const PROACTIVE_INTERVAL_MS = 45000; // how often proactive Roody checks in

  let autoChime = false; // OFF by default — Roody stays quiet unless tapped
  let lastAnswerSig = ""; // fingerprint of the latest answer we've seen
  let reacting = false; // lock so we don't react on top of a reaction
  let lastReactTime = 0;
  let pageCache = ""; // incrementally built — NO scrolling ever
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

  // ---- Read the page (read-only, ZERO scrolling) ---------------------------
  // Reads whatever is currently rendered — never moves the scroll position.
  function readPage() {
    const main = document.querySelector("main") || document.body;
    let text = (main.innerText || "").trim();
    if (text.length > 16000) text = text.slice(-16000);
    return text;
  }

  // The most recent task — tail of what's on screen. Cheap, focused.
  function recentTask() {
    const t = readPage();
    return t ? t.slice(-2500) : "";
  }

  // Incrementally capture new content as it appears — called by
  // MutationObserver. Merges new lines into pageCache without scrolling.
  function captureIncremental() {
    const fresh = readPage();
    if (!pageCache) { pageCache = fresh; return; }
    const newLines = fresh.split("\n").filter((l) => l.trim() && !pageCache.includes(l.trim()));
    if (newLines.length > 0) {
      pageCache += "\n" + newLines.join("\n");
    }
    if (pageCache.length > MAX_CONTEXT) pageCache = pageCache.slice(-MAX_CONTEXT);
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
        // currentAudio can be an AudioContext (new path) or an Audio element (legacy).
        if (typeof currentAudio.close === "function") {
          currentAudio.close(); // AudioContext
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
    else if (state === "idle") orb.classList.add("roody-stopped");
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
        currentAudio = actx; // so stopSpeaking() can close it
        const audioBuf = await actx.decodeAudioData(arrayBuf);
        const src = actx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(actx.destination);
        src.onended = () => {
          try { actx.close(); } catch (_) {}
          currentAudio = null;
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
  function callRoody(userText, pageContext, onText, onSpoken, mode) {
    let settled = false;
    // One place that ends the turn — fills the bubble, optionally speaks, and
    // guarantees the "…" placeholder NEVER hangs forever.
    const finish = (text, speakIt) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      onText(text);
      if (speakIt) {
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: text });
        if (history.length > 20) history.splice(0, history.length - 20);
        speak(text, onSpoken);
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
        { type: "roody:ask", payload: { userText, pageContext, history, mode } },
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
    "(Check what the user is working on right now. Give them ONE useful observation — a tip, a suggestion, a heads-up about something you noticed, or just a warm check-in. Be specific to what's on screen. Don't repeat yourself. One sentence, spoken.)",
    "(Look at what's on screen. If you see anything the user might want to know — a potential issue, a better approach, an interesting detail — mention it casually. If nothing stands out, crack a quick joke about what they're doing. One sentence, spoken.)",
    "(You're sitting with the user. Glance at what they're doing and say something useful or encouraging. Maybe suggest something, point out a pattern, or just be supportive. Keep it natural and short — one sentence.)",
  ];

  function reactToNewAnswer() {
    if (reacting) return;
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
    });
  }

  // Proactive check-in: Roody glances at what you're doing and says something
  // useful without being asked. Only fires when auto-chime is on and the page
  // has changed since the last check.
  function proactiveCheckIn() {
    if (!autoChime || reacting || voiceOn) return;
    if (Date.now() - lastReactTime < REACT_COOLDOWN_MS) return;
    const current = readPage().slice(-800);
    if (current === lastCacheSnapshot) return;
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
    });
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
      captureIncremental();
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
          // Show interim (partial) transcript so user can see what mic hears
          if (transcript && hearingEl) {
            hearingEl.style.display = "block";
            hearingText.textContent = `🎤 hearing: "${transcript}"`;
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
      // Don't restart while Roody is talking — that's how echo gets in.
      // When speak() finishes, it'll call startListening() itself.
      if (!voiceOn || isRoodySpeaking) {
        if (isRoodySpeaking) rlog("⏸ SR paused (Roody is speaking)");
        return;
      }
      setTimeout(() => {
        if (!voiceOn || isRoodySpeaking) return;
        // Build a FRESH recognition each cycle. Reusing one object across many
        // start/stop cycles makes Chrome's speech backend silently stop
        // returning results (exactly the "speech detected, no HEARD" symptom).
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
    rlog(`→ sending to brain: "${text}"`);
    stopListening(); // we won't listen again until Roody is done speaking
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
    setToggleVisual(false);
    stopSpeaking();
    stopListening();
    setMic("idle");
    const h = document.getElementById("roody-hearing");
    if (h) h.style.display = "none";
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
    .get(["roodyAutoChime", "roodyGeminiKey", "roodyElevenKey", "roodyEnabled", "roodyLang"])
    .then((s) => {
      if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
      if (s.roodyLang) srLang = s.roodyLang;
      geminiVoice = !!(s.roodyElevenKey || s.roodyGeminiKey);
      applyEnabled(s.roodyEnabled !== false); // default on
      reflectListenState();
    // Don't react to whatever is already on the page when we load —
    // only to answers that appear from now on.
    lastAnswerSig = readPage().slice(-600);
    startWatching();

    // React to the master switch flipping in settings without a refresh.
    // Also live-update the warm-voice flag when either TTS key is added/cleared
    // — otherwise pages opened BEFORE the key was set stay stuck on robotic
    // voice forever (the boot-time read of geminiVoice never re-runs).
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.roodyEnabled) applyEnabled(changes.roodyEnabled.newValue !== false);
      if (changes.roodyElevenKey || changes.roodyGeminiKey) {
        chrome.storage.local
          .get(["roodyElevenKey", "roodyGeminiKey"])
          .then(({ roodyElevenKey, roodyGeminiKey }) => {
            const before = geminiVoice;
            geminiVoice = !!(roodyElevenKey || roodyGeminiKey);
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
    });
  });
})();
