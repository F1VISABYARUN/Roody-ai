// Offscreen reader: extension pages (unlike content scripts and the service
// worker) may XHR file:// URLs once the user enables "Allow access to file
// URLs" — this page reads a local PDF's bytes and hands them back as base64.

const MAX_BYTES = 40 * 1024 * 1024; // sanity cap — nobody discusses a 40MB+ PDF live

function bytesToBase64(bytes) {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "roody:offscreenRead") return;
  const x = new XMLHttpRequest();
  x.open("GET", msg.url);
  x.responseType = "arraybuffer";
  x.onload = () => {
    const buf = x.response;
    if (!buf || !buf.byteLength) return sendResponse({ ok: false, error: "empty file" });
    if (buf.byteLength > MAX_BYTES) return sendResponse({ ok: false, error: "file too large" });
    sendResponse({ ok: true, b64: bytesToBase64(new Uint8Array(buf)) });
  };
  x.onerror = () => sendResponse({ ok: false, error: "read blocked (is file access on?)" });
  try { x.send(); } catch (e) { sendResponse({ ok: false, error: e.message }); }
  return true; // async sendResponse
});
