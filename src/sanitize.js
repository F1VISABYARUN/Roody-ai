// Shared reply hygiene for Roody — loaded by the service worker via
// importScripts AND by the eval agent (eval/run.js) via require. Keep this
// file dependency-free and side-effect-free so both hosts stay happy.
(function (root) {
  // Internal context headers must never be spoken. The notebook/recap format
  // ('[1:08:29 AM] www.site.com · "…" — RECAP: …' or a bare 'RECAP: …' line)
  // leaks when the model copies its context header back into the reply.
  // Strip leading header lines; never sanitize a reply into silence.
  function stripInternalHeaders(txt) {
    if (!txt) return txt;
    let s = txt.trim();
    for (let guard = 0; guard < 3; guard++) {
      const before = s;
      s = s.replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\][^\n]*(?:\n+|$)/i, "");
      s = s.replace(/^RECAP:[^\n]*(?:\n+|$)/i, "");
      s = s.trim();
      if (s === before) break;
    }
    return s || txt.trim();
  }

  // Catch obvious LLM truncation — replies that end mid-word or with a
  // dangling contraction. When this happens, tack on a graceful ending so the
  // user hears a complete thought instead of "Okay, we'" hanging in the air.
  function sanitizeReply(txt) {
    if (!txt) return txt;
    const trimmed = stripInternalHeaders(txt);
    // A trailing apostrophe/dash right after a letter is a broken contraction
    // ("Okay, we'"), not closing punctuation — repair it BEFORE the
    // completeness check, which would otherwise bless it as finished.
    if (/[a-z]['\-]$/i.test(trimmed) || /\b(I|we|you|it|they|he|she)$/i.test(trimmed)) {
      return trimmed + "… let me try that again.";
    }
    // Ends properly with punctuation → looks complete
    if (/[.!?…"'\)\]]$/.test(trimmed)) return trimmed;
    // Otherwise just add a period so TTS reads it as a finished sentence
    return trimmed + ".";
  }

  const api = { stripInternalHeaders, sanitizeReply };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RoodySanitize = api;
})(typeof self !== "undefined" ? self : globalThis);
