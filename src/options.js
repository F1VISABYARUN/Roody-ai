// Load and save Roody's settings (stored locally in this browser only).
const keyEl = document.getElementById("key");
const modelEl = document.getElementById("model");
const gkeyEl = document.getElementById("gkey");
const voiceEl = document.getElementById("voice");
const statusEl = document.getElementById("status");

chrome.storage.local
  .get(["roodyApiKey", "roodyModel", "roodyGeminiKey", "roodyVoice"])
  .then((s) => {
    if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
    if (s.roodyModel) modelEl.value = s.roodyModel;
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyVoice) voiceEl.value = s.roodyVoice;
  });

// Show the running cost estimate.
const spendEl = document.getElementById("spend");
const spendCallsEl = document.getElementById("spendcalls");
function showSpend() {
  chrome.storage.local.get(["roodyUsage"]).then(({ roodyUsage }) => {
    const u = roodyUsage || { costUSD: 0, calls: 0 };
    spendEl.textContent = "$" + (u.costUSD || 0).toFixed(4);
    spendCallsEl.textContent = u.calls ? ` · ${u.calls} calls` : "";
  });
}
showSpend();
document.getElementById("resetspend").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyUsage: { costUSD: 0, calls: 0, inTok: 0, outTok: 0 },
  });
  showSpend();
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyApiKey: keyEl.value.trim(),
    roodyModel: modelEl.value,
    roodyGeminiKey: gkeyEl.value.trim(),
    roodyVoice: voiceEl.value,
  });
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
