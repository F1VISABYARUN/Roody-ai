// Roody's self-contained PDF text reader — shared by the injected orb
// (content.js) and the standalone Study tab (study.js).
//
// Chrome's built-in PDF viewer keeps the text locked inside a plugin the DOM
// can't reach, so Roody reads PDFs itself: it takes the raw file bytes,
// inflates the FlateDecode streams with the browser's NATIVE
// DecompressionStream (zero libraries, no remote code — stays store-compliant),
// and pulls text out of the content-stream operators. Works on most text PDFs;
// scanned/image PDFs have no text to extract.
(function () {
  if (window.RoodyPDF) return;

  // Byte-accurate string so file offsets line up with the raw bytes.
  function pdfLatin1(bytes) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return s;
  }

  // Inflate a stream. PDFs use zlib ("deflate"); some tools emit raw deflate.
  async function pdfInflate(bytes) {
    for (const fmt of ["deflate", "deflate-raw"]) {
      try {
        const ds = new DecompressionStream(fmt);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (_) {}
    }
    return null;
  }

  // Pull readable text out of a decoded content stream by walking its operators:
  // literal (…) strings are the text; Td/TD/T*/'/" mean a new line.
  function pdfTextFromContent(s) {
    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === "(") {
        let depth = 1;
        let str = "";
        i++;
        while (i < n && depth > 0) {
          const ch = s[i];
          if (ch === "\\") {
            const nx = s[i + 1];
            const esc = { n: "\n", r: "", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
            if (nx !== undefined && nx in esc) { str += esc[nx]; i += 2; continue; }
            const m = s.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
            if (m) { str += String.fromCharCode(parseInt(m[0], 8) & 0xff); i += 1 + m[0].length; continue; }
            i += 2; continue;
          }
          if (ch === "(") { depth++; str += ch; i++; continue; }
          if (ch === ")") { depth--; if (depth === 0) { i++; break; } str += ch; i++; continue; }
          str += ch; i++;
        }
        out += str;
      } else if (c === "<" && s[i + 1] !== "<") {
        // Hex string — usually needs a font CMap to decode, skip it.
        const end = s.indexOf(">", i);
        if (end === -1) break;
        i = end + 1;
      } else if ((c === "T" && (s[i + 1] === "d" || s[i + 1] === "D" || s[i + 1] === "*")) || c === "'" || c === '"') {
        out += "\n"; i += 2;
      } else {
        i++;
      }
    }
    return out;
  }

  // Extract text from a whole PDF file (ArrayBuffer) → plain string.
  async function extractPdfText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const raw = pdfLatin1(bytes);
    let text = "";
    const re = /stream\r?\n/g;
    let m;
    while ((m = re.exec(raw))) {
      const start = m.index + m[0].length;
      const end = raw.indexOf("endstream", start);
      if (end === -1) continue;
      let sEnd = end;
      if (raw[sEnd - 1] === "\n") sEnd--;
      if (raw[sEnd - 1] === "\r") sEnd--;
      const streamBytes = bytes.subarray(start, sEnd);
      const inflated = await pdfInflate(streamBytes);
      const content = inflated ? pdfLatin1(inflated) : pdfLatin1(streamBytes);
      // Only mine streams that carry text operators (skips images/fonts).
      if (content && /(Tj|TJ|BT)/.test(content)) {
        text += pdfTextFromContent(content) + "\n";
      }
      re.lastIndex = end + 9;
    }
    return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  window.RoodyPDF = { extractPdfText };
})();
