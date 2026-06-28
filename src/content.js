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

  let autoChime = true; // react automatically to new answers
  let lastAnswerSig = ""; // fingerprint of the latest answer we've seen
  let reacting = false; // lock so we don't react on top of a reaction
  let lastReactTime = 0;
  let fullHistoryCache = "";
  let lastGatherTime = 0;
  let geminiVoice = false; // use Gemini for voice? (set at boot if a key exists)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        <span id="roody-sub">read-only · here to think with you</span>
      </div>
      <button id="roody-listen" title="Auto-react to new answers">👂</button>
      <button id="roody-close" title="Close">×</button>
    </div>
    <div id="roody-log"></div>
    <div id="roody-inputrow">
      <button id="roody-mic" title="Hold to talk">🎤</button>
      <input id="roody-text" type="text" placeholder="Talk to Roody…" autocomplete="off" />
      <button id="roody-send" title="Send">➤</button>
    </div>
  `;

  document.body.appendChild(orb);
  document.body.appendChild(panel);

  const log = panel.querySelector("#roody-log");
  const input = panel.querySelector("#roody-text");
  const listenBtn = panel.querySelector("#roody-listen");

  orb.addEventListener("click", () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "flex" : "none";
    if (open && log.childElementCount === 0) {
      addBubble(
        "roody",
        "Hey. I'm Roody. I can see what's on your screen and I'm here to read it with you, talk it through, and spot anything that looks off. I'll even chime in on my own when a new answer lands. I won't change a thing — that part's always yours. What are we looking at?"
      );
    }
  });
  panel.querySelector("#roody-close").addEventListener("click", () => {
    panel.style.display = "none";
  });

  function reflectListenState() {
    listenBtn.classList.toggle("roody-on", autoChime);
    listenBtn.title = autoChime
      ? "Auto-reacting to new answers (click to mute)"
      : "Muted — Roody won't chime in (click to enable)";
  }
  listenBtn.addEventListener("click", () => {
    autoChime = !autoChime;
    chrome.storage.local.set({ roodyAutoChime: autoChime });
    reflectListenState();
  });

  function addBubble(who, text) {
    const b = document.createElement("div");
    b.className = `roody-bubble roody-${who}`;
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  let currentAudio = null;
  function browserSpeak(text) {
    if (!synth) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      synth.speak(u);
    } catch (_) {}
  }
  // Roody's warm voice: Gemini TTS if available, else the free browser voice.
  function speak(text) {
    if (!text) return;
    if (!geminiVoice) return browserSpeak(text);
    chrome.runtime.sendMessage({ type: "roody:tts", payload: { text } }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok || !res.audioBase64) {
        return browserSpeak(text); // graceful fallback
      }
      try {
        const blob = pcm16ToWav(base64ToBytes(res.audioBase64), rateFromMime(res.mime));
        const url = URL.createObjectURL(blob);
        if (currentAudio) currentAudio.pause();
        currentAudio = new Audio(url);
        currentAudio.onended = () => URL.revokeObjectURL(url);
        currentAudio.play().catch(() => browserSpeak(text));
      } catch (_) {
        browserSpeak(text);
      }
    });
  }

  // ---- Talking to Roody's brain --------------------------------------------
  function callRoody(userText, pageContext, onText) {
    chrome.runtime.sendMessage(
      { type: "roody:ask", payload: { userText, pageContext, history } },
      (res) => {
        if (chrome.runtime.lastError) {
          onText("I lost the connection to my brain for a second. Try again?");
          return;
        }
        if (!res || !res.ok) {
          onText((res && res.error) || "Something went wrong.");
          return;
        }
        onText(res.text);
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: res.text });
        if (history.length > 20) history.splice(0, history.length - 20);
        speak(res.text);
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
    const ctx = await buildContext();
    callRoody(userText, ctx, (t) => (thinking.textContent = t));
  }

  panel.querySelector("#roody-send").addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send(input.value);
  });

  // ---- Live watching: react when a new answer lands ------------------------
  const REACTION_PROMPT =
    "(Automatic check-in: a new answer just finished on the page. React to the MOST RECENT answer like a friend reading along — about whatever the topic is, not only code. If it's code and something looks wrong, risky, or like it'll loop, say so and point to where. If it's anything else, add a quick thought, ask one sharp question, or gently flag anything that seems off or inaccurate. If it's just genuinely good, you can simply say so. Keep it to a sentence or two, spoken-sounding.)";

  async function reactToNewAnswer() {
    if (reacting) return;
    reacting = true;
    orb.classList.add("roody-thinking");
    if (panel.style.display === "none") panel.style.display = "flex";

    const thinking = addBubble("roody", "…");
    const ctx = await buildContext();
    callRoody(REACTION_PROMPT, ctx, (t) => {
      thinking.textContent = t;
      orb.classList.remove("roody-thinking");
      reacting = false;
      lastReactTime = Date.now();
    });
  }

  function onSettled() {
    if (!autoChime || reacting) return;
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

  // ---- Voice in -------------------------------------------------------------
  // Gemini STT (record the mic, send to Gemini) when a key exists; otherwise the
  // free browser speech recognition. Either way the mic button is press-to-talk.
  const mic = panel.querySelector("#roody-mic");
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function pickRecMime() {
    const types = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm"];
    for (const t of types) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  let recorder = null;
  let recChunks = [];
  let recording = false;

  async function startGeminiRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickRecMime();
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recChunks = [];
      recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mic.classList.remove("roody-listening");
        const blob = new Blob(recChunks, { type: recorder.mimeType || "audio/webm" });
        const audioBase64 = await blobToBase64(blob);
        const mime = (recorder.mimeType || "audio/webm").split(";")[0];
        const thinking = addBubble("you", "🎤 …");
        chrome.runtime.sendMessage(
          { type: "roody:stt", payload: { audioBase64, mime } },
          (res) => {
            thinking.remove();
            if (chrome.runtime.lastError || !res || !res.ok || !res.text) {
              addBubble("roody", "I couldn't quite catch that — mind typing it?");
              return;
            }
            send(res.text);
          }
        );
      };
      recorder.start();
      recording = true;
      mic.classList.add("roody-listening");
    } catch (_) {
      addBubble("roody", "I couldn't reach your microphone. You can still type to me.");
    }
  }

  // Lazily-built browser speech-recognition fallback.
  let sr = null;
  let srListening = false;
  function browserListenToggle() {
    if (!SR) {
      addBubble("roody", "This browser can't listen — but you can always type to me.");
      return;
    }
    if (!sr) {
      sr = new SR();
      sr.lang = "en-US";
      sr.interimResults = false;
      sr.maxAlternatives = 1;
      sr.addEventListener("result", (e) => send(e.results[0][0].transcript));
      sr.addEventListener("end", () => {
        srListening = false;
        mic.classList.remove("roody-listening");
      });
    }
    if (srListening) return sr.stop();
    try {
      sr.start();
      srListening = true;
      mic.classList.add("roody-listening");
    } catch (_) {}
  }

  // One handler, decides Gemini vs browser at click time (after settings load).
  mic.addEventListener("click", () => {
    const canRecord = window.MediaRecorder && navigator.mediaDevices;
    if (geminiVoice && canRecord) {
      if (recording) {
        recording = false;
        try { recorder && recorder.stop(); } catch (_) {}
      } else {
        startGeminiRecording();
      }
    } else {
      browserListenToggle();
    }
  });

  // ---- Boot -----------------------------------------------------------------
  chrome.storage.local.get(["roodyAutoChime", "roodyGeminiKey"]).then((s) => {
    if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
    geminiVoice = !!s.roodyGeminiKey; // warm voice on if a Gemini key is saved
    reflectListenState();
    // Don't react to whatever is already on the page when we load —
    // only to answers that appear from now on.
    lastAnswerSig = readPage().slice(-600);
    startWatching();
  });
})();
