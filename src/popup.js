// Help popup shown when Roody can't attach to the current page. Two cases:
// a downloaded file (file://) before "Allow access to file URLs" is enabled,
// or a browser-internal page where no extension may run. The background
// records which case applies in roodyHelpReason before arming this popup.

(async () => {
  let kind = "blocked";
  try {
    const [{ roodyHelpReason }, [tab]] = await Promise.all([
      chrome.storage.local.get(["roodyHelpReason"]),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    if (roodyHelpReason && (!tab || roodyHelpReason.tabId === tab.id)) {
      kind = roodyHelpReason.kind || "blocked";
    } else if (tab && /^file:/.test(tab.url || "")) {
      kind = "file";
    }
  } catch (_) {}
  document.getElementById("title").textContent =
    kind === "file" ? "Roody on this PDF" : "Roody can't run here";
  document.getElementById(kind === "file" ? "filecase" : "blockedcase").style.display = "block";
})();

document.getElementById("enable").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/?id=" + chrome.runtime.id });
  window.close();
});
