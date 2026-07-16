// Offscreen reader: extension pages (unlike content scripts and the service
// worker) may XHR file:// URLs once the user enables "Allow access to file
// URLs" — and they can run PDF.js with a real worker. This page turns a PDF
// (by URL or raw bytes) into plain text for the orb.

const MAX_BYTES = 40 * 1024 * 1024; // sanity cap — nobody discusses a 40MB+ PDF live
const MAX_PAGES = 300;
const MAX_CHARS = 200000;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("src/vendor/pdf.worker.min.js");

function xhrBytes(url) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("GET", url);
    x.responseType = "arraybuffer";
    x.onload = () => {
      if (!x.response || !x.response.byteLength) return reject(new Error("empty file"));
      if (x.response.byteLength > MAX_BYTES) return reject(new Error("file too large"));
      resolve(x.response);
    };
    x.onerror = () => reject(new Error("read blocked (is file access on?)"));
    try { x.send(); } catch (e) { reject(e); }
  });
}

function b64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// PDF.js extraction: per page, join text items, keeping rough line breaks.
async function extractText(buf) {
  const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  let out = "";
  const pages = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= pages && out.length < MAX_CHARS; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    let line = "";
    for (const item of tc.items) {
      line += item.str;
      if (item.hasEOL) { out += line + "\n"; line = ""; }
      else line += " ";
    }
    out += line + "\n\n";
  }
  try { doc.destroy(); } catch (_) {}
  return out.replace(/[ \t]+\n/g, "\n").trim().slice(0, MAX_CHARS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "roody:offscreenRead") return;
  (async () => {
    try {
      const buf = msg.b64 ? b64ToBuffer(msg.b64) : await xhrBytes(msg.url);
      const text = await extractText(buf);
      if (!text || text.length < 40) return sendResponse({ ok: false, error: "no extractable text (scanned PDF?)" });
      sendResponse({ ok: true, text });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async sendResponse
});
