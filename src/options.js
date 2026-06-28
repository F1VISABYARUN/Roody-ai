// Roody settings — everything you can turn on, off, change, or wipe.

const $ = (id) => document.getElementById(id);
const keyEl = $("key");
const modelEl = $("model");
const gkeyEl = $("gkey");
const voiceEl = $("voice");
const webEl = $("websearch");
const chimeEl = $("autochime");
const enabledEl = $("enabled");
const statusEl = $("status");

function showKeyStatus(el, hasIt) {
  el.textContent = hasIt ? "✓ Key saved on this computer" : "Not set";
  el.classList.toggle("has", hasIt);
}

// Load everything saved.
chrome.storage.local
  .get([
    "roodyApiKey", "roodyModel", "roodyGeminiKey",
    "roodyVoice", "roodyWebSearch", "roodyEnabled", "roodyAutoChime",
  ])
  .then((s) => {
    if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
    if (s.roodyModel) modelEl.value = s.roodyModel;
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyVoice) voiceEl.value = s.roodyVoice;
    webEl.checked = s.roodyWebSearch !== false;
    chimeEl.checked = s.roodyAutoChime === true; // off by default
    enabledEl.checked = s.roodyEnabled !== false;
    showKeyStatus($("keystatus"), !!s.roodyApiKey);
    showKeyStatus($("gstatus"), !!s.roodyGeminiKey);
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

// Live cost.
function showSpend() {
  chrome.storage.local.get(["roodyUsage"]).then(({ roodyUsage }) => {
    const u = roodyUsage || { costUSD: 0, calls: 0 };
    $("spend").textContent = "$" + (u.costUSD || 0).toFixed(4);
    $("spendcalls").textContent = u.calls ? ` · ${u.calls} calls` : "";
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
  await chrome.storage.local.set({
    roodyApiKey: keyEl.value.trim(),
    roodyModel: modelEl.value,
    roodyGeminiKey: gkeyEl.value.trim(),
    roodyVoice: voiceEl.value,
    roodyWebSearch: webEl.checked,
    roodyAutoChime: chimeEl.checked,
    roodyEnabled: enabledEl.checked,
  });
  showKeyStatus($("keystatus"), !!keyEl.value.trim());
  showKeyStatus($("gstatus"), !!gkeyEl.value.trim());
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
