// Roody settings — everything you can turn on, off, change, or wipe.

const $ = (id) => document.getElementById(id);
const keyEl = $("key");
const modelEl = $("model");
const gkeyEl = $("gkey");
const voiceEl = $("voice");
const ekeyEl = $("ekey");
const evoiceEl = $("evoice");
const evoiceCustomEl = $("evoicecustom");
const webEl = $("websearch");
const chimeEl = $("autochime");
const cheapVoiceEl = $("cheapvoice");
const enabledEl = $("enabled");
const statusEl = $("status");

function showKeyStatus(el, hasIt) {
  el.textContent = hasIt ? "✓ Key saved on this computer" : "Not set";
  el.classList.toggle("has", hasIt);
}

// Load everything saved.
chrome.storage.local
  .get([
    "roodyApiKey", "roodyModel", "roodyGeminiKey", "roodyElevenKey", "roodyElevenVoice",
    "roodyVoice", "roodyWebSearch", "roodyEnabled", "roodyAutoChime", "roodyVoiceCheapBrain",
  ])
  .then((s) => {
    if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
    if (s.roodyModel) modelEl.value = s.roodyModel;
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyElevenKey) ekeyEl.value = s.roodyElevenKey;
    // If saved voice is one of the known ones, select it; else show as Custom.
    const knownVoices = ["21m00Tcm4TlvDq8ikWAM","EXAVITQu4vr4xnSDxMaL","AZnzlk1XvdvUeBnXmlld","MF3mGyEYCl7XYWbV9V6O","XB0fDUnXU5powFXDhCwa","9BWtsMINqrJLrRacOk9x"];
    if (s.roodyElevenVoice && knownVoices.includes(s.roodyElevenVoice)) {
      evoiceEl.value = s.roodyElevenVoice;
    } else if (s.roodyElevenVoice) {
      evoiceEl.value = "custom";
      evoiceCustomEl.value = s.roodyElevenVoice;
    }
    // Roody is female-voice-only now; if a previously saved male voice (Puck,
    // Charon, etc.) is in storage, snap it back to the default Kore.
    const validFemale = new Set(["Kore","Aoede","Leda","Zephyr","Callirrhoe","Autonoe","Despina","Erinome","Laomedeia","Achernar","Vindemiatrix","Sulafat"]);
    voiceEl.value = s.roodyVoice && validFemale.has(s.roodyVoice) ? s.roodyVoice : "Kore";
    if (s.roodyVoice && !validFemale.has(s.roodyVoice)) {
      chrome.storage.local.set({ roodyVoice: "Kore" }); // persist the snap-back
    }
    webEl.checked = s.roodyWebSearch !== false;
    chimeEl.checked = s.roodyAutoChime === true; // off by default
    cheapVoiceEl.checked = s.roodyVoiceCheapBrain !== false; // ON by default — save $
    enabledEl.checked = s.roodyEnabled !== false;
    showKeyStatus($("keystatus"), !!s.roodyApiKey);
    showKeyStatus($("gstatus"), !!s.roodyGeminiKey);
    showKeyStatus($("estatus"), !!s.roodyElevenKey);
  });

// Clear ElevenLabs key
$("cleare").addEventListener("click", () => {
  if (!confirm("Remove the ElevenLabs key from this browser?")) return;
  ekeyEl.value = "";
  chrome.storage.local.set({ roodyElevenKey: "" });
  showKeyStatus($("estatus"), false);
});

// Auto-save keys the moment the user tabs/clicks away from the field. Most
// people paste a key and expect it to be saved — requiring an extra "Save"
// click is a foot-gun that caused real "voice still robotic" reports.
function autoSaveKey(input, storageKey, statusEl) {
  let lastSaved = input.value.trim();
  input.addEventListener("blur", () => {
    const v = input.value.trim();
    if (v === lastSaved) return;
    lastSaved = v;
    chrome.storage.local.set({ [storageKey]: v });
    showKeyStatus(statusEl, !!v);
    statusEl.textContent = v ? "✓ Saved" : "Not set";
    statusEl.classList.toggle("has", !!v);
    setTimeout(() => showKeyStatus(statusEl, !!v), 1200);
  });
}
autoSaveKey(keyEl, "roodyApiKey", $("keystatus"));
autoSaveKey(gkeyEl, "roodyGeminiKey", $("gstatus"));
autoSaveKey(ekeyEl, "roodyElevenKey", $("estatus"));

// "Load voices my key can use" — calls ElevenLabs /v2/voices with the saved
// key and replaces the dropdown with whatever the account can actually use
// via API. Library voices on the free plan return 402 at TTS time even though
// they show up in the picker, which is what caused the original confusion.
$("evoicefetch").addEventListener("click", async () => {
  const key = ekeyEl.value.trim();
  const status = $("evoicefetchstatus");
  if (!key) {
    status.textContent = "Paste your ElevenLabs key above first.";
    return;
  }
  status.textContent = "Loading…";
  try {
    const resp = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
      headers: { "xi-api-key": key },
    });
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 160);
      status.textContent = `Failed (${resp.status}): ${body}`;
      return;
    }
    const data = await resp.json();
    const voices = data.voices || [];
    if (!voices.length) {
      status.textContent = "No voices found on this account.";
      return;
    }
    // Replace the dropdown with the user's actual voices. Default voices and
    // personal/cloned voices both work on the free plan via API.
    evoiceEl.innerHTML = "";
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.voice_id;
      const tag = v.category ? ` · ${v.category}` : "";
      opt.textContent = `${v.name}${tag}`;
      evoiceEl.appendChild(opt);
    }
    const customOpt = document.createElement("option");
    customOpt.value = "custom";
    customOpt.textContent = "Other → paste a custom voice ID below";
    evoiceEl.appendChild(customOpt);
    // Save whatever's now selected so the background picks it up immediately.
    chrome.storage.local.set({ roodyElevenVoice: evoiceEl.value });
    status.textContent = `✓ Loaded ${voices.length} voices — pick one.`;
  } catch (e) {
    status.textContent = `Network error: ${e.message}`;
  }
});

// Auto-save the picked ElevenLabs voice immediately so the user doesn't have
// to click Save before testing it.
evoiceEl.addEventListener("change", () => {
  const v = evoiceEl.value === "custom"
    ? (evoiceCustomEl.value || "").trim()
    : evoiceEl.value;
  if (v) chrome.storage.local.set({ roodyElevenVoice: v });
});
evoiceCustomEl.addEventListener("blur", () => {
  if (evoiceEl.value !== "custom") return;
  const v = (evoiceCustomEl.value || "").trim();
  if (v) chrome.storage.local.set({ roodyElevenVoice: v });
});

// Master ON/OFF — flip live, no save button needed.
enabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ roodyEnabled: enabledEl.checked });
});

// ✕ buttons — wipe a key clean off this computer, instantly.
$("clearkey").addEventListener("click", () => {
  if (!confirm("Remove the Anthropic key from this browser?")) return;
  keyEl.value = "";
  chrome.storage.local.set({ roodyApiKey: "" });
  showKeyStatus($("keystatus"), false);
});
$("clearg").addEventListener("click", () => {
  if (!confirm("Remove the Gemini key from this browser?")) return;
  gkeyEl.value = "";
  chrome.storage.local.set({ roodyGeminiKey: "" });
  showKeyStatus($("gstatus"), false);
});

// Live cost — shows both USD and INR (approximate ₹85/$).
const USD_TO_INR = 85;
function showSpend() {
  chrome.storage.local.get(["roodyUsage"]).then(({ roodyUsage }) => {
    const u = roodyUsage || { costUSD: 0, calls: 0 };
    const usd = u.costUSD || 0;
    $("spendusd").textContent = "$" + usd.toFixed(4);
    $("spendinr").textContent = "₹" + (usd * USD_TO_INR).toFixed(2);
    $("spendcalls").textContent = u.calls ? `${u.calls} calls so far` : "";
  });
}
showSpend();
$("resetspend").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyUsage: { costUSD: 0, calls: 0, inTok: 0, outTok: 0 },
  });
  showSpend();
});

// ---- Logs panel ----------------------------------------------------------
const logBox = $("logbox");
const autoEl = $("autorefresh");
function showLog() {
  chrome.storage.local.get(["roodyLog"]).then(({ roodyLog }) => {
    const lines = Array.isArray(roodyLog) ? roodyLog : [];
    logBox.value = lines.join("\n");
    logBox.scrollTop = logBox.scrollHeight;
  });
}
showLog();
$("reflog").addEventListener("click", showLog);
$("copylog").addEventListener("click", async () => {
  await navigator.clipboard.writeText(logBox.value || "(empty)");
  $("copylog").textContent = "✓ Copied";
  setTimeout(() => ($("copylog").textContent = "📋 Copy"), 1500);
});
$("clearlog").addEventListener("click", async () => {
  await chrome.storage.local.set({ roodyLog: [] });
  showLog();
});
let autoTimer = setInterval(() => { if (autoEl.checked) showLog(); }, 1500);

// Save the rest.
$("save").addEventListener("click", async () => {
  const elevenVoice =
    evoiceEl.value === "custom"
      ? (evoiceCustomEl.value || "").trim()
      : evoiceEl.value;
  await chrome.storage.local.set({
    roodyApiKey: keyEl.value.trim(),
    roodyModel: modelEl.value,
    roodyGeminiKey: gkeyEl.value.trim(),
    roodyElevenKey: ekeyEl.value.trim(),
    roodyElevenVoice: elevenVoice,
    roodyVoice: voiceEl.value,
    roodyWebSearch: webEl.checked,
    roodyAutoChime: chimeEl.checked,
    roodyVoiceCheapBrain: cheapVoiceEl.checked,
    roodyEnabled: enabledEl.checked,
  });
  showKeyStatus($("keystatus"), !!keyEl.value.trim());
  showKeyStatus($("gstatus"), !!gkeyEl.value.trim());
  showKeyStatus($("estatus"), !!ekeyEl.value.trim());
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
