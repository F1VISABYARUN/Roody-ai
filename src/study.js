// Roody's standalone Study tab. Opens when you click Roody on a page it can't
// attach the orb to (Chrome's PDF viewer, file://, chrome:// pages). It reads a
// PDF with the shared extractor (pdf.js), then talks it through with you using
// the same brain (roody:ask) and warm voice (roody:tts) as the on-page orb.
(function () {
  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const drop = $("drop");
  const input = $("text");
  const sub = $("sub");
  const pdfBtn = $("pdf");
  const pdfFile = $("pdf-file");
  const micBtn = $("mic");

  const history = [];
  let studyDoc = null; // { name, text }
  let speakToken = 0;

  // ---- Chat bubbles ---------------------------------------------------------
  function bubble(who, text) {
    const b = document.createElement("div");
    b.className = "bubble " + who;
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  // ---- Audio helpers (mirror content.js) ------------------------------------
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
  function pcm16ToWav(pcm, sampleRate) {
    const dataSize = pcm.length;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + dataSize, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, dataSize, true);
    new Uint8Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }

  let currentAudio = null;
  function stopSpeaking() {
    speakToken++;
    try { if (currentAudio) currentAudio.close(); } catch (_) {}
    currentAudio = null;
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
  }
  function browserSpeak(text, onDone) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0; u.pitch = 1.05;
      u.onend = () => onDone && onDone();
      window.speechSynthesis.speak(u);
    } catch (_) { onDone && onDone(); }
  }
  function speak(text, onDone) {
    if (!text) return onDone && onDone();
    const myToken = ++speakToken;
    chrome.runtime.sendMessage({ type: "roody:tts", payload: { text } }, async (res) => {
      if (myToken !== speakToken) return;
      if (chrome.runtime.lastError || !res || !res.ok || !res.audioBase64) {
        return browserSpeak(text, onDone);
      }
      try {
        const isPcm = /pcm|L16/i.test(res.mime || "");
        const rawBytes = base64ToBytes(res.audioBase64);
        const blob = isPcm ? pcm16ToWav(rawBytes, rateFromMime(res.mime))
                           : new Blob([rawBytes], { type: res.mime || "audio/mpeg" });
        stopSpeaking();
        const actx = new (window.AudioContext || window.webkitAudioContext)();
        currentAudio = actx;
        const audioBuf = await actx.decodeAudioData(await blob.arrayBuffer());
        const src = actx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(actx.destination);
        src.onended = () => { try { actx.close(); } catch (_) {} if (currentAudio === actx) currentAudio = null; onDone && onDone(); };
        src.start(0);
      } catch (_) { browserSpeak(text, onDone); }
    });
  }

  // ---- Brain ----------------------------------------------------------------
  function callRoody(userText, onText, onDone, skipHistory) {
    let settled = false;
    const finish = (text, speakIt) => {
      if (settled) return; settled = true;
      clearTimeout(watchdog);
      onText(text);
      if (speakIt && !skipHistory) {
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: text });
        if (history.length > 20) history.splice(0, history.length - 20);
      }
      if (speakIt) speak(text, onDone); else onDone && onDone();
    };
    const watchdog = setTimeout(() => finish("That took too long — try once more?", false), 30000);
    try {
      chrome.runtime.sendMessage(
        {
          type: "roody:ask",
          payload: {
            userText,
            pageContext: studyDoc ? studyDoc.text.slice(0, 16000) : "",
            history,
            site: "study",
            title: studyDoc ? studyDoc.name : "Study",
          },
        },
        (res) => {
          if (chrome.runtime.lastError) return finish("I lost the connection to my brain — reload this tab?", false);
          if (!res || !res.ok) return finish((res && res.error) || "Something went wrong.", false);
          finish(res.text, true);
        }
      );
    } catch (_) {
      finish("Roody just updated — reload this tab so I can reconnect.", false);
    }
  }

  // ---- Load a PDF -----------------------------------------------------------
  const OPENER =
    "(The user just loaded a PDF to study. Immediately give the useful decode in 2-3 spoken sentences: what this document is, the ONE key idea that matters most, and one thing people usually get wrong or should focus on. Then, in a short half-sentence, offer to go deeper or quiz them. Lead with substance — do NOT ask 'how do you want to use it?')";

  async function loadPdf(file) {
    if (!file) return;
    const note = bubble("roody", `📄 Reading ${file.name}…`);
    try {
      const text = await window.RoodyPDF.extractPdfText(await file.arrayBuffer());
      if (!text || text.length < 40) {
        studyDoc = null;
        note.textContent = `Hmm, I couldn't pull readable text out of ${file.name} — it's probably a scanned/image PDF. Paste the part you want and I'll study it with you.`;
        return;
      }
      studyDoc = { name: file.name, text };
      sub.textContent = `📄 studying ${file.name} · ${text.length.toLocaleString()} characters`;
      drop.style.display = "none";
      note.textContent = `📄 Got it — I read ${file.name}. Ask me anything, or say "quiz me."`;
      const thinking = bubble("roody", "…");
      callRoody(OPENER, (t) => (thinking.textContent = t), null, true);
    } catch (e) {
      studyDoc = null;
      note.textContent = `I couldn't open that file (${(e && e.message) || "error"}). Mind trying again?`;
    }
  }

  async function loadPdfFromUrl(url) {
    const note = bubble("roody", `📄 Fetching the PDF…`);
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const text = await window.RoodyPDF.extractPdfText(buf);
      if (!text || text.length < 40) { note.textContent = "That PDF looks like scanned images — no text to read. Paste the part you want."; return; }
      const name = decodeURIComponent(url.split("/").pop() || "this PDF");
      studyDoc = { name, text };
      sub.textContent = `📄 studying ${name} · ${text.length.toLocaleString()} characters`;
      drop.style.display = "none";
      note.textContent = `📄 Got it — I read ${name}. Ask me anything, or say "quiz me."`;
      const thinking = bubble("roody", "…");
      callRoody(OPENER, (t) => (thinking.textContent = t), null, true);
    } catch (_) {
      note.textContent = "I couldn't fetch that PDF — click 📄 to pick it from your computer instead.";
    }
  }

  // ---- Send -----------------------------------------------------------------
  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    if (!studyDoc) { bubble("roody", "Load a PDF first (📄) and then ask me about it!"); return; }
    bubble("you", text);
    input.value = "";
    const thinking = bubble("roody", "…");
    callRoody(text, (t) => (thinking.textContent = t));
  }

  // ---- Wiring ---------------------------------------------------------------
  pdfBtn.addEventListener("click", () => pdfFile.click());
  drop.addEventListener("click", () => pdfFile.click());
  pdfFile.addEventListener("change", () => {
    const f = pdfFile.files && pdfFile.files[0];
    pdfFile.value = "";
    if (f) loadPdf(f);
  });
  $("send").addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });

  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document) drop.classList.remove("hot"); })
  );
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("hot");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /pdf/i.test((f.type || "") + " " + (f.name || ""))) loadPdf(f);
  });

  // ---- Voice in (SpeechRecognition) ----------------------------------------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  micBtn.addEventListener("click", () => {
    if (!SR) { bubble("roody", "This browser has no speech recognition — type to me instead."); return; }
    if (listening) { try { rec && rec.stop(); } catch (_) {} return; }
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onstart = () => { listening = true; micBtn.classList.add("on"); };
    rec.onend = () => { listening = false; micBtn.classList.remove("on"); };
    rec.onerror = () => { listening = false; micBtn.classList.remove("on"); };
    rec.onresult = (e) => {
      const said = e.results[e.results.length - 1][0].transcript.trim();
      if (said) send(said);
    };
    try { rec.start(); } catch (_) {}
  });

  // ---- Auto-load a PDF passed from the toolbar click ------------------------
  try {
    const src = new URLSearchParams(location.search).get("src");
    if (src) loadPdfFromUrl(src);
  } catch (_) {}
})();
