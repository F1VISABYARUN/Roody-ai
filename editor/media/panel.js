// Roody panel — owns the microphone and the speaker.
// Editors don't ship Chrome's SpeechRecognition, so we record audio ourselves
// (MediaRecorder + silence detection), and the extension host transcribes it
// with Gemini STT. Replies come back as audio we play with AudioContext.
(function () {
  const vscode = acquireVsCodeApi();
  const orb = document.getElementById("orb");
  const statusEl = document.getElementById("status");
  const log = document.getElementById("log");
  const input = document.getElementById("text");
  const sendBtn = document.getElementById("send");

  let voiceOn = false;
  let state = "idle"; // idle | listening | thinking | speaking
  let mediaStream = null;
  let recorder = null;
  let playCtx = null;

  function setStatus(t) { statusEl.textContent = t; }
  function setState(s) {
    state = s;
    orb.className = s;
    if (s === "listening") setStatus("🎤 listening… (tap orb to stop)");
    else if (s === "thinking") setStatus("💭 thinking…");
    else if (s === "speaking") setStatus("🔊 Roody is talking…");
    else setStatus(voiceOn ? "voice on — say something" : "Roody — tap the orb or type");
  }

  function bubble(who, text) {
    const b = document.createElement("div");
    b.className = "bubble " + who;
    b.textContent = text;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  // ---- Recording with silence auto-stop ------------------------------------
  async function startListening() {
    if (state === "listening") return;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      bubble("roody", "I can't reach the mic here (" + e.message + ") — you can still type to me.");
      voiceOn = false;
      setState("idle");
      return;
    }
    const chunks = [];
    recorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm;codecs=opus" });
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      if (!voiceOn) return; // user turned voice off — discard
      const blob = new Blob(chunks, { type: "audio/webm" });
      if (blob.size < 4000) { // too tiny = silence — just listen again
        if (voiceOn) startListening();
        return;
      }
      setState("thinking");
      try {
        const wav = await webmToWav(blob);
        vscode.postMessage({ type: "audio", b64: wav.b64, mime: "audio/wav" });
      } catch (e) {
        bubble("roody", "Couldn't process that audio (" + e.message + ")");
        if (voiceOn) startListening();
      }
    };
    recorder.start();
    setState("listening");
    watchSilence(mediaStream);
  }

  // Stop recording after: speech was heard, then ~1.5s of quiet. Max 15s.
  function watchSilence(stream) {
    const actx = new AudioContext();
    const src = actx.createMediaStreamSource(stream);
    const analyser = actx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let heardSpeech = false;
    let quietSince = 0;
    const startedAt = Date.now();

    const tick = () => {
      if (state !== "listening" || !recorder || recorder.state !== "recording") {
        try { actx.close(); } catch (_) {}
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let rms = 0;
      for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
      rms = Math.sqrt(rms / buf.length);
      const now = Date.now();
      if (rms > 0.015) { heardSpeech = true; quietSince = 0; }
      else if (heardSpeech && !quietSince) quietSince = now;

      const longQuiet = heardSpeech && quietSince && now - quietSince > 1500;
      const tooLong = now - startedAt > 15000;
      if (longQuiet || tooLong) {
        try { actx.close(); } catch (_) {}
        try { recorder.stop(); } catch (_) {}
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  }

  function stopListening() {
    if (recorder && recorder.state === "recording") { try { recorder.stop(); } catch (_) {} }
    if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  }

  // Decode whatever MediaRecorder produced into mono 16-bit WAV base64 —
  // a format Gemini STT reliably accepts.
  async function webmToWav(blob) {
    const arrayBuf = await blob.arrayBuffer();
    const actx = new AudioContext();
    const audio = await actx.decodeAudioData(arrayBuf);
    const ch = audio.getChannelData(0); // mono
    const rate = audio.sampleRate;
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    try { actx.close(); } catch (_) {}
    const wavBuf = new ArrayBuffer(44 + pcm.length * 2);
    const v = new DataView(wavBuf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    new Int16Array(wavBuf, 44).set(pcm);
    // to base64 in chunks (avoids call-stack limits on long audio)
    const bytes = new Uint8Array(wavBuf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { b64: btoa(bin) };
  }

  // ---- Playback --------------------------------------------------------------
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function pcm16ToWavBytes(pcmBytes, rate) {
    const buf = new ArrayBuffer(44 + pcmBytes.length);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + pcmBytes.length, true); str(8, "WAVE");
    str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, pcmBytes.length, true);
    new Uint8Array(buf, 44).set(pcmBytes);
    return buf;
  }

  async function playAudio(b64, mime) {
    stopSpeaking();
    setState("speaking");
    try {
      const raw = b64ToBytes(b64);
      const isPcm = /pcm|L16/i.test(mime || "");
      const rateM = /rate=(\d+)/.exec(mime || "");
      const arrayBuf = isPcm ? pcm16ToWavBytes(raw, rateM ? +rateM[1] : 24000) : raw.buffer;
      playCtx = new AudioContext();
      const audioBuf = await playCtx.decodeAudioData(arrayBuf);
      const src = playCtx.createBufferSource();
      src.buffer = audioBuf;
      src.connect(playCtx.destination);
      src.onended = () => {
        try { playCtx.close(); } catch (_) {}
        playCtx = null;
        setState("idle");
        if (voiceOn) startListening(); // hands-free loop: Roody done → your turn
      };
      src.start(0);
    } catch (e) {
      setState("idle");
      if (voiceOn) startListening();
    }
  }

  function stopSpeaking() {
    if (playCtx) { try { playCtx.close(); } catch (_) {} playCtx = null; }
  }

  // ---- Wiring ------------------------------------------------------------------
  orb.addEventListener("click", () => {
    if (state === "speaking") { stopSpeaking(); setState("idle"); if (voiceOn) startListening(); return; }
    voiceOn = !voiceOn;
    if (voiceOn) startListening();
    else { stopListening(); setState("idle"); }
  });

  function sendText() {
    const t = (input.value || "").trim();
    if (!t) return;
    input.value = "";
    bubble("you", t);
    setState("thinking");
    vscode.postMessage({ type: "ask", text: t });
  }
  sendBtn.addEventListener("click", sendText);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") sendText(); });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "transcript") bubble("you", m.text);
    else if (m.type === "reply") bubble("roody", m.text);
    else if (m.type === "tts") playAudio(m.b64, m.mime);
    else if (m.type === "status") setStatus(m.text);
    else if (m.type === "listen") { setState("idle"); if (voiceOn) startListening(); }
    else if (m.type === "error") {
      bubble("roody", "⚠ " + m.text);
      setState("idle");
      if (voiceOn) startListening();
    }
    else if (m.type === "voiceerror") {
      // Voice failed — text reply is already visible; show why voice went silent
      // as a small note so the user can act (add ElevenLabs key, wait for quota).
      bubble("roody", "🔇 voice: " + m.text);
      setState("idle");
      if (voiceOn) startListening();
    }
  });

  setState("idle");
})();
