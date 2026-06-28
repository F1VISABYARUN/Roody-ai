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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function speak(text) {
    if (!synth) return;
    try {
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      u.pitch = 1.0;
      synth.speak(u);
    } catch (_) {}
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
    "(Automatic check-in: a new answer just finished on the page. Look at the MOST RECENT answer. If something looks wrong, risky, or like it'll cause a loop, say so in a sentence and point to where. Otherwise give one quick thought or ask one sharp question. Keep it short and spoken-sounding.)";

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

  // ---- Voice in (free browser speech recognition) --------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = panel.querySelector("#roody-mic");
  if (SR) {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let listening = false;

    rec.addEventListener("result", (e) => send(e.results[0][0].transcript));
    rec.addEventListener("end", () => {
      listening = false;
      mic.classList.remove("roody-listening");
    });
    mic.addEventListener("click", () => {
      if (listening) return rec.stop();
      try {
        rec.start();
        listening = true;
        mic.classList.add("roody-listening");
      } catch (_) {}
    });
  } else {
    mic.style.display = "none";
  }

  // ---- Boot -----------------------------------------------------------------
  chrome.storage.local.get(["roodyAutoChime"]).then((s) => {
    if (typeof s.roodyAutoChime === "boolean") autoChime = s.roodyAutoChime;
    reflectListenState();
    // Don't react to whatever is already on the page when we load —
    // only to answers that appear from now on.
    lastAnswerSig = readPage().slice(-600);
    startWatching();
  });
})();
