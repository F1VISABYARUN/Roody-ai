// Guidance popup shown when Roody is clicked on a file:// page (a downloaded
// PDF) before "Allow access to file URLs" is enabled. Extension pages can't be
// injected, so this small toolbar popup explains the one-time switch.

document.getElementById("enable").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
  window.close();
});

document.getElementById("study").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/study.html") });
  window.close();
});
