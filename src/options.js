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
const gkeyEl = $("gkey");
const xkeyEl = $("xkey");
const okeyEl = $("okey");
const langEl = $("lang");
const webEl = $("websearch");
const chimeEl = $("autochime");
const opacityEl = $("opacity");
// Keep in sync with DEFAULT_ALPHA in content.js and --roody-alpha in content.css.
const DEFAULT_OPACITY = 0.18;
const enabledEl = $("enabled");
const statusEl = $("status");
const profileEl = $("profile");
const profileCountEl = $("profilecount");
const memoryBoxEl = $("memorybox");
const inviteEl = $("invitecode");
const proxyUrlEl = $("proxyurl");

function showKeyStatus(el, hasIt) {
  el.textContent = hasIt ? "✓ Key saved on this computer" : "Not set";
  el.classList.toggle("has", hasIt);
}

// Load everything saved.
chrome.storage.local
  .get([
    "roodyApiKey", "roodyGeminiKey", "roodyXaiKey", "roodyOpenAIKey",
    "roodyLang", "roodyWebSearch", "roodyEnabled", "roodyAutoChime", "roodyOpacity",
    "roodyProfile", "roodyInviteCode", "roodyProxyUrl",
  ])
  .then((s) => {
    if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyXaiKey) xkeyEl.value = s.roodyXaiKey;
    if (s.roodyOpenAIKey) okeyEl.value = s.roodyOpenAIKey;
    if (s.roodyLang) langEl.value = s.roodyLang;
    webEl.checked = s.roodyWebSearch !== false;
    chimeEl.checked = s.roodyAutoChime === true; // off by default
    opacityEl.value = s.roodyOpacity != null ? s.roodyOpacity : DEFAULT_OPACITY;
    enabledEl.checked = s.roodyEnabled !== false;
    showKeyStatus($("keystatus"), !!s.roodyApiKey);
    showKeyStatus($("gstatus"), !!s.roodyGeminiKey);
    showKeyStatus($("xstatus"), !!s.roodyXaiKey);
    showKeyStatus($("ostatus"), !!s.roodyOpenAIKey);
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
    $("usagehello").textContent = me.name ? `Hi ${me.name}!` : "Your Roody plan";
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
      ? `${tc.toLocaleString()} session${tc === 1 ? "" : "s"} together`
      : "";
    const mem = Array.isArray(roodyMemory) ? roodyMemory : [];
    if (mem.length === 0) {
      memoryBoxEl.innerHTML = "<em style='color:var(--muted)'>Empty — Roody will start remembering pages when you talk to it.</em>";
      return;
    }
    memoryBoxEl.innerHTML = mem.slice().reverse().map((m) => {
      const when = m.ts ? new Date(m.ts).toLocaleString() : "";
      const gist = m.summary
        ? `<div style="color:var(--text);font-size:12.5px;margin-top:2px">💬 ${escapeHtml(m.summary)}</div>`
        : `<div style="color:var(--muted);font-size:12px;margin-top:2px">${escapeHtml((m.snippet || "").slice(0, 150))}</div>`;
      return `<div style="padding:6px 0;border-bottom:1px solid var(--border)">
        <div style="font-weight:600">${escapeHtml(m.site)} · <span style="color:var(--muted);font-weight:400">${escapeHtml((m.title || "").slice(0, 60))}</span></div>
        ${gist}
        <div style="color:var(--muted);font-size:11px;margin-top:2px">${when}</div>
      </div>`;
    }).join("");
  });
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
renderMemory();
setInterval(renderMemory, 3000); // refresh live

$("clearmem").addEventListener("click", async () => {
  if (!confirm("Erase Roody's memory of your sessions (pages + session count)?")) return;
  await chrome.storage.local.set({ roodyMemory: [], roodyTalkCount: 0 });
  renderMemory();
});

// Clear OpenAI key
$("clearo").addEventListener("click", () => {
  if (!confirm("Remove the OpenAI key from this browser?")) return;
  okeyEl.value = "";
  chrome.storage.local.set({ roodyOpenAIKey: "" });
  showKeyStatus($("ostatus"), false);
});

// Clear xAI/Grok key
$("clearx").addEventListener("click", () => {
  if (!confirm("Remove the xAI (Grok) key from this browser?")) return;
  xkeyEl.value = "";
  chrome.storage.local.set({ roodyXaiKey: "" });
  showKeyStatus($("xstatus"), false);
});

// Auto-save keys the moment the user tabs/clicks away from the field. Most
// people paste a key and expect it to be saved — requiring an extra "Save"
// click is a foot-gun.
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
    // A new key means a new model list — go find the provider's latest.
    if (v) setTimeout(() => refreshModels(false), 200);
  });
}

autoSaveKey(keyEl, "roodyApiKey", $("keystatus"));
autoSaveKey(gkeyEl, "roodyGeminiKey", $("gstatus"));
autoSaveKey(xkeyEl, "roodyXaiKey", $("xstatus"));
autoSaveKey(okeyEl, "roodyOpenAIKey", $("ostatus"));

// Auto-save all dropdowns and checkboxes on change — no Save button needed.
// ---- Model auto-discovery -------------------------------------------------
// Roody asks each provider what the user's key can use and caches the newest
// flagship, so a new model release doesn't need an extension update. These
// readouts show what it landed on.
const MODEL_LINE = {
  claude: "claudemodel",
  openai: "openaimodel",
  gemini: "geminimodel",
  grok: "grokmodel",
};
function paintModelLines() {
  chrome.storage.local.get(Object.values(RoodyModels.STORAGE_KEY)).then((s) => {
    for (const [provider, elId] of Object.entries(MODEL_LINE)) {
      const el = $(elId);
      if (!el) continue;
      const found = s[RoodyModels.STORAGE_KEY[provider]];
      el.textContent = found ? `using ${found}` : "";
    }
  });
}
function refreshModels(showStatus) {
  const status = $("refreshstatus");
  if (showStatus && status) status.textContent = "Checking…";
  try {
    chrome.runtime.sendMessage({ type: "roody:refreshModels" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        if (showStatus && status) status.textContent = "Couldn't reach the providers.";
        return;
      }
      paintModelLines();
      if (!showStatus || !status) return;
      const results = res.results || {};
      const names = Object.keys(results);
      if (!names.length) { status.textContent = "Paste a key first."; return; }
      const okd = names.filter((n) => results[n].ok);
      status.textContent = okd.length
        ? `✓ Updated ${okd.length} of ${names.length}`
        : "No models found — check your keys.";
      setTimeout(() => { status.textContent = ""; }, 4000);
    });
  } catch (_) {
    if (showStatus && status) status.textContent = "Couldn't reach the providers.";
  }
}
$("refreshmodels").addEventListener("click", () => refreshModels(true));
paintModelLines();
refreshModels(false); // quiet refresh whenever Settings opens

// ---- Preferred-brain chips ------------------------------------------------
// The consumer-view control. Writes roodyBrainPref = "auto" | "claude" |
// "openai" | "gemini" | "grok". background.js reads it and picks a sensible
// default model for that provider — no model IDs for the user to remember.
const brainprefEl = $("brainpref");
if (brainprefEl) {
  const chips = brainprefEl.querySelectorAll(".chip");
  function paintActive(pref) {
    chips.forEach((c) => c.classList.toggle("active", c.dataset.pref === pref));
  }
  chips.forEach((c) => {
    c.addEventListener("click", () => {
      const pref = c.dataset.pref || "auto";
      paintActive(pref);
      chrome.storage.local.set({ roodyBrainPref: pref });
    });
  });
  chrome.storage.local.get(["roodyBrainPref"]).then(({ roodyBrainPref }) => {
    paintActive(roodyBrainPref || "auto");
  });
}
langEl.addEventListener("change", () => chrome.storage.local.set({ roodyLang: langEl.value }));
webEl.addEventListener("change", () => chrome.storage.local.set({ roodyWebSearch: webEl.checked }));
chimeEl.addEventListener("change", () => chrome.storage.local.set({ roodyAutoChime: chimeEl.checked }));

// Transparency — save as the user drags so open panels restyle live (the
// content script listens on storage.onChanged).
opacityEl.addEventListener("input", () => {
  chrome.storage.local.set({ roodyOpacity: Number(opacityEl.value) });
});
$("opacityreset").addEventListener("click", () => {
  opacityEl.value = DEFAULT_OPACITY;
  chrome.storage.local.set({ roodyOpacity: DEFAULT_OPACITY });
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

// Save the rest (belt-and-braces — most fields already auto-save above).
$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyApiKey: keyEl.value.trim(),
    roodyGeminiKey: gkeyEl.value.trim(),
    roodyXaiKey: xkeyEl.value.trim(),
    roodyOpenAIKey: okeyEl.value.trim(),
    roodyLang: langEl.value,
    roodyWebSearch: webEl.checked,
    roodyAutoChime: chimeEl.checked,
    roodyOpacity: Number(opacityEl.value),
    roodyEnabled: enabledEl.checked,
    roodyProfile: (profileEl.value || "").trim(),
  });
  showKeyStatus($("keystatus"), !!keyEl.value.trim());
  showKeyStatus($("gstatus"), !!gkeyEl.value.trim());
  showKeyStatus($("xstatus"), !!xkeyEl.value.trim());
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
