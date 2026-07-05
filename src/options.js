// Roody settings — everything you can turn on, off, change, or wipe.

const $ = (id) => document.getElementById(id);

// Developer door: the machinery panel (own keys, brain picker, spend, proxy)
// is invisible to users. The founder opens the options page with #dev on the
// URL — chrome-extension://<id>/src/options.html#dev — to reveal it.
function applyDevMode() {
  const on = location.hash === "#dev";
  const panel = $("adminonly");
  if (panel) panel.style.display = on ? "block" : "none";
}
applyDevMode();
window.addEventListener("hashchange", applyDevMode);
const keyEl = $("key");
const modelEl = $("model");
const gkeyEl = $("gkey");
const xkeyEl = $("xkey");
const voiceEl = $("voice");
const langEl = $("lang");
const earsEl = $("ears");
const ekeyEl = $("ekey");
const evoiceEl = $("evoice");
const evoiceCustomEl = $("evoicecustom");
const vibeEl = $("vibe");
const webEl = $("websearch");
const chimeEl = $("autochime");
const cheapVoiceEl = $("cheapvoice");
const enabledEl = $("enabled");
const statusEl = $("status");
const profileEl = $("profile");
const profileCountEl = $("profilecount");
const memoryBoxEl = $("memorybox");
const inviteEl = $("invitecode");
const proxyUrlEl = $("proxyurl");

const VIBE_PREVIEWS = {
  normal: "Just Roody — warm, witty, no interruptions.",
  minion: "Roody: \"The bug is on line 12—\" *Minion grabs keyboard* \"BANANA!! Bello! Dis code... why no work?! Bee-do bee-do!\"",
  roadrunner: "Roody: \"That function needs a—\" *MEEP MEEP!* Road Runner zooms past, fixes the typo, vanishes in a dust cloud.",
  coyote: "Roody: \"Let me check that logic—\" Coyote: \"AH HA! I have a GENIUS plan!\" *draws elaborate blueprint* *it explodes*",
  pinkpanther: "Roody: \"There's an issue here—\" *smooth jazz plays* Pink Panther slides in, inspects the code with a magnifying glass, raises one eyebrow.",
  woody: "Roody: \"That variable is undefined—\" Woody: \"Now listen here, partner. There's a SNAKE in that function! Round it up!\"",
  rapunzel: "Roody: \"The API returned an error—\" Rapunzel: \"Oh! I've never seen an error like THIS before! This is the best day EVER! Let's fix it together!\"",
  snowwhite: "Roody: \"This code needs cleanup—\" Snow White: *sings* \"Whistle while you work!\" *birds fly in and refactor the variables*",
  tom: "Roody: \"Watch out for that null—\" Tom: *runs full speed into the null pointer* *crashes through wall* *flattened like a pancake* *shakes it off*",
  jerry: "Roody: \"The bug is hiding in—\" Jerry: *already found it* *waves tiny flag* *does victory dance on the keyboard*",
};

function showKeyStatus(el, hasIt) {
  el.textContent = hasIt ? "✓ Key saved on this computer" : "Not set";
  el.classList.toggle("has", hasIt);
}

// Load everything saved.
chrome.storage.local
  .get([
    "roodyApiKey", "roodyModel", "roodyGeminiKey", "roodyXaiKey", "roodyElevenKey", "roodyElevenVoice",
    "roodyVoice", "roodyLang", "roodyVibe", "roodyWebSearch", "roodyEnabled", "roodyAutoChime", "roodyVoiceCheapBrain",
    "roodyProfile", "roodyInviteCode", "roodyProxyUrl", "roodyEars",
  ])
  .then((s) => {
    if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
    if (s.roodyModel) modelEl.value = s.roodyModel;
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyXaiKey) xkeyEl.value = s.roodyXaiKey;
    if (s.roodyLang) langEl.value = s.roodyLang;
    earsEl.value = s.roodyEars === "accurate" ? "accurate" : "browser";
    if (s.roodyVibe) vibeEl.value = s.roodyVibe;
    $("vibepreview").textContent = VIBE_PREVIEWS[vibeEl.value] || "";
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
    showKeyStatus($("xstatus"), !!s.roodyXaiKey);
    showKeyStatus($("estatus"), !!s.roodyElevenKey);
    if (s.roodyProfile) profileEl.value = s.roodyProfile;
    profileCountEl.textContent = (profileEl.value || "").length;
    if (s.roodyInviteCode) inviteEl.value = s.roodyInviteCode;
    if (s.roodyProxyUrl) proxyUrlEl.value = s.roodyProxyUrl;
    showKeyStatus($("invitestatus"), !!s.roodyInviteCode);
    showUsage(); // values just arrived — paint the usage bar now
  });

// Keep in sync with ROODY_PROXY_URL in background.js.
const DEFAULT_PROXY = "https://midnightblue-wolf-859857.hostingersite.com/";

// User usage dashboard — "You've used 12 of 50 free messages today".
async function showUsage() {
  const code = (inviteEl.value || "").trim();
  const box = $("usagebox");
  if (!code) { box.style.display = "none"; return; }
  try {
    const base = ((proxyUrlEl.value || "").trim() || DEFAULT_PROXY).replace(/\/+$/, "");
    const r = await fetch(`${base}/me?code=${encodeURIComponent(code)}`);
    const me = await r.json();
    if (!me.ok) {
      box.style.display = "block";
      $("usagehello").textContent = "⚠ This code isn't active";
      $("usagefill").style.width = "0%";
      $("usagetext").textContent = "Check the code, or ask the Roody team for a fresh one.";
      return;
    }
    box.style.display = "block";
    $("usagehello").textContent = me.name ? `Hi ${me.name}! 🟠` : "Your Roody plan 🟠";
    const pct = Math.min(100, Math.round((me.used / me.limit) * 100));
    $("usagefill").style.width = pct + "%";
    $("usagetext").textContent =
      `${me.used} of ${me.limit} free messages used today · refills at midnight UTC · ${me.allTime.toLocaleString()} messages all-time`;
  } catch (_) {
    box.style.display = "none"; // offline / proxy unreachable — stay quiet
  }
}
showUsage();
setInterval(showUsage, 20000);
inviteEl.addEventListener("blur", () => setTimeout(showUsage, 300));

// Invite code + proxy URL — auto-save on blur like the key fields.
autoSaveKey(inviteEl, "roodyInviteCode", $("invitestatus"));
proxyUrlEl.addEventListener("blur", () => {
  chrome.storage.local.set({ roodyProxyUrl: proxyUrlEl.value.trim() });
});
$("clearinvite").addEventListener("click", () => {
  if (!confirm("Remove the invite code?")) return;
  inviteEl.value = "";
  chrome.storage.local.set({ roodyInviteCode: "" });
  showKeyStatus($("invitestatus"), false);
});

// Auto-save profile as user types (debounced 400ms)
let profileSaveTimer = null;
profileEl.addEventListener("input", () => {
  profileCountEl.textContent = profileEl.value.length;
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ roodyProfile: profileEl.value.trim() });
  }, 400);
});

// Render Roody's notebook memory
function renderMemory() {
  chrome.storage.local.get(["roodyMemory", "roodyTalkCount"]).then(({ roodyMemory, roodyTalkCount }) => {
    const tc = roodyTalkCount || 0;
    $("talkstats").textContent = tc > 0
      ? `🧡 You & Roody: ${tc.toLocaleString()} conversation${tc === 1 ? "" : "s"} together`
      : "";
    const mem = Array.isArray(roodyMemory) ? roodyMemory : [];
    if (mem.length === 0) {
      memoryBoxEl.innerHTML = "<em style='color:#8a7560'>Empty — Roody will start remembering pages when you talk to it.</em>";
      return;
    }
    memoryBoxEl.innerHTML = mem.slice().reverse().map((m) => {
      const when = m.ts ? new Date(m.ts).toLocaleString() : "";
      // A session recap reads like a diary line — show it instead of the raw
      // page snippet when we have one.
      const gist = m.summary
        ? `<div style="color:#3a2c1e;font-size:12.5px;margin-top:2px">💬 ${escapeHtml(m.summary)}</div>`
        : `<div style="color:#6b4a2b;font-size:12px;margin-top:2px">${escapeHtml((m.snippet || "").slice(0, 150))}</div>`;
      return `<div style="padding:6px 0;border-bottom:1px solid #f0e2cf">
        <div style="font-weight:600">${escapeHtml(m.site)} · <span style="color:#8a7560;font-weight:400">${escapeHtml((m.title || "").slice(0, 60))}</span></div>
        ${gist}
        <div style="color:#a89880;font-size:11px;margin-top:2px">${when}</div>
      </div>`;
    }).join("");
  });
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
renderMemory();
setInterval(renderMemory, 3000); // refresh live

$("clearmem").addEventListener("click", async () => {
  if (!confirm("Clear Roody's notebook of remembered pages?")) return;
  await chrome.storage.local.set({ roodyMemory: [] });
  renderMemory();
});

// Clear xAI/Grok key
$("clearx").addEventListener("click", () => {
  if (!confirm("Remove the xAI (Grok) key from this browser?")) return;
  xkeyEl.value = "";
  chrome.storage.local.set({ roodyXaiKey: "" });
  showKeyStatus($("xstatus"), false);
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
// Live vibe preview + auto-save
vibeEl.addEventListener("change", () => {
  $("vibepreview").textContent = VIBE_PREVIEWS[vibeEl.value] || "";
  chrome.storage.local.set({ roodyVibe: vibeEl.value });
});

autoSaveKey(keyEl, "roodyApiKey", $("keystatus"));
autoSaveKey(gkeyEl, "roodyGeminiKey", $("gstatus"));
autoSaveKey(xkeyEl, "roodyXaiKey", $("xstatus"));
autoSaveKey(ekeyEl, "roodyElevenKey", $("estatus"));

// Auto-save all dropdowns and checkboxes on change — no Save button needed.
modelEl.addEventListener("change", () => chrome.storage.local.set({ roodyModel: modelEl.value }));
voiceEl.addEventListener("change", () => chrome.storage.local.set({ roodyVoice: voiceEl.value }));
langEl.addEventListener("change", () => chrome.storage.local.set({ roodyLang: langEl.value }));
earsEl.addEventListener("change", () => chrome.storage.local.set({ roodyEars: earsEl.value }));
webEl.addEventListener("change", () => chrome.storage.local.set({ roodyWebSearch: webEl.checked }));
chimeEl.addEventListener("change", () => chrome.storage.local.set({ roodyAutoChime: chimeEl.checked }));
cheapVoiceEl.addEventListener("change", () => chrome.storage.local.set({ roodyVoiceCheapBrain: cheapVoiceEl.checked }));

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

// "Preview this voice" — TTS a short sample sentence with whichever voice is
// currently selected, so the user can hear it BEFORE running a real
// conversation and burning quota. Plays inline on the options page.
$("evoicepreview").addEventListener("click", async () => {
  const key = ekeyEl.value.trim();
  const status = $("evoicefetchstatus");
  if (!key) {
    status.textContent = "Paste your ElevenLabs key first.";
    return;
  }
  const voiceId = evoiceEl.value === "custom"
    ? (evoiceCustomEl.value || "").trim()
    : evoiceEl.value;
  if (!voiceId) {
    status.textContent = "Pick a voice first.";
    return;
  }
  status.textContent = "Generating preview…";
  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_64`,
      {
        method: "POST",
        headers: { "xi-api-key": key, "content-type": "application/json" },
        body: JSON.stringify({
          text: "Hi, I'm Roody. This is how I'll sound when we chat — does this voice feel right to you?",
          model_id: "eleven_turbo_v2_5",
          voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
        }),
      }
    );
    if (!resp.ok) {
      const body = (await resp.text()).slice(0, 200);
      status.textContent = `Preview failed (${resp.status}): ${body}`;
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play();
    status.textContent = `✓ Playing preview (${Math.round(blob.size / 1024)}KB)`;
  } catch (e) {
    status.textContent = `Preview error: ${e.message}`;
  }
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
  chrome.storage.local.get(["roodyUsage", "roodyElevenChars"]).then(({ roodyUsage, roodyElevenChars }) => {
    const u = roodyUsage || { costUSD: 0, calls: 0 };
    const usd = u.costUSD || 0;
    $("spendusd").textContent = "$" + usd.toFixed(4);
    $("spendinr").textContent = "₹" + (usd * USD_TO_INR).toFixed(2);
    $("spendcalls").textContent = u.calls ? `${u.calls} calls so far` : "";
    const ec = roodyElevenChars || 0;
    $("elevencredits").textContent = ec
      ? `🔊 ElevenLabs: ~${ec.toLocaleString()} / 10,000 free credits used this month`
      : "";
  });
}
showSpend();
$("resetspend").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyUsage: { costUSD: 0, calls: 0, inTok: 0, outTok: 0 },
    roodyElevenChars: 0,
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
    roodyXaiKey: xkeyEl.value.trim(),
    roodyElevenKey: ekeyEl.value.trim(),
    roodyElevenVoice: elevenVoice,
    roodyVoice: voiceEl.value,
    roodyLang: langEl.value,
    roodyEars: earsEl.value,
    roodyVibe: vibeEl.value,
    roodyWebSearch: webEl.checked,
    roodyAutoChime: chimeEl.checked,
    roodyVoiceCheapBrain: cheapVoiceEl.checked,
    roodyEnabled: enabledEl.checked,
    roodyProfile: (profileEl.value || "").trim(),
  });
  showKeyStatus($("keystatus"), !!keyEl.value.trim());
  showKeyStatus($("gstatus"), !!gkeyEl.value.trim());
  showKeyStatus($("xstatus"), !!xkeyEl.value.trim());
  showKeyStatus($("estatus"), !!ekeyEl.value.trim());
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
