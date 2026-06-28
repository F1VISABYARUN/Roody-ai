// Roody lives here: a calm orb on top of ChatGPT / Claude.
// It reads the on-page conversation (read-only), talks with you by voice or text,
// and never touches anything on the page.

(function () {
  if (window.__roodyLoaded) return;
  window.__roodyLoaded = true;

  const history = []; // running chat between the human and Roody
  const synth = window.speechSynthesis;

  // ---- Read the page (read-only) -------------------------------------------
  // Grab the visible conversation/code text so Roody can see what you see.
  function readPage() {
    const main = document.querySelector("main") || document.body;
    let text = (main.innerText || "").trim();
    // Keep the most recent chunk — that's what's in view and relevant.
    if (text.length > 16000) text = text.slice(-16000);
    return text;
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
      <span id="roody-title">Roody</span>
      <span id="roody-sub">read-only · here to think with you</span>
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

  orb.addEventListener("click", () => {
    const open = panel.style.display === "none";
    panel.style.display = open ? "flex" : "none";
    if (open && log.childElementCount === 0) {
      addBubble(
        "roody",
        "Hey. I'm Roody. I can see what's on your screen and I'm here to read it with you, talk it through, and spot anything that looks off. I won't change a thing — that part's always yours. What are we looking at?"
      );
    }
  });
  panel.querySelector("#roody-close").addEventListener("click", () => {
    panel.style.display = "none";
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
  async function send(userText) {
    userText = (userText || "").trim();
    if (!userText) return;
    addBubble("you", userText);
    input.value = "";

    const thinking = addBubble("roody", "…");

    chrome.runtime.sendMessage(
      {
        type: "roody:ask",
        payload: { userText, pageContext: readPage(), history },
      },
      (res) => {
        if (chrome.runtime.lastError) {
          thinking.textContent =
            "I lost the connection to my brain for a second. Try again?";
          return;
        }
        if (!res || !res.ok) {
          thinking.textContent = (res && res.error) || "Something went wrong.";
          return;
        }
        thinking.textContent = res.text;
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: res.text });
        if (history.length > 20) history.splice(0, history.length - 20);
        speak(res.text);
      }
    );
  }

  panel.querySelector("#roody-send").addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send(input.value);
  });

  // ---- Voice in (free browser speech recognition) --------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = panel.querySelector("#roody-mic");
  if (SR) {
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    let listening = false;

    rec.addEventListener("result", (e) => {
      const said = e.results[0][0].transcript;
      send(said);
    });
    rec.addEventListener("end", () => {
      listening = false;
      mic.classList.remove("roody-listening");
    });

    mic.addEventListener("click", () => {
      if (listening) {
        rec.stop();
        return;
      }
      try {
        rec.start();
        listening = true;
        mic.classList.add("roody-listening");
      } catch (_) {}
    });
  } else {
    mic.style.display = "none"; // browser can't listen — text still works
  }
})();
