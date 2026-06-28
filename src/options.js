// Load and save Roody's settings (stored locally in this browser only).
const keyEl = document.getElementById("key");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["roodyApiKey", "roodyModel"]).then((s) => {
  if (s.roodyApiKey) keyEl.value = s.roodyApiKey;
  if (s.roodyModel) modelEl.value = s.roodyModel;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    roodyApiKey: keyEl.value.trim(),
    roodyModel: modelEl.value,
  });
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 2000);
});
