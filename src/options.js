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
