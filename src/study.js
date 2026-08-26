// Roody's standalone Read tab. Opens when you click Roody on a page it can't
// attach the orb to (Chrome's PDF viewer, file://, chrome:// pages). It reads a
// PDF with the shared extractor (pdf.js), then talks it through with you using
// the same brain (roody:ask) as the on-page orb. Answers render as Markdown.
(function () {
  const $ = (id) => document.getElementById(id);
  const log = $("log");
  const drop = $("drop");
  const input = $("text");
  const sub = $("sub");
  const pdfBtn = $("pdf");
  const pdfFile = $("pdf-file");

  const history = [];
  let studyDoc = null; // { name, text }

  // ---- Markdown rendering (dependency-free, XSS-safe) ----------------------
  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
  function renderInline(target, text) {
    let i = 0; const n = text.length; let buf = "";
    const flush = () => { if (buf) { target.appendChild(document.createTextNode(buf)); buf = ""; } };
    while (i < n) {
      const c = text[i];
      if (c === "`") { const end = text.indexOf("`", i + 1); if (end > i) { flush(); target.appendChild(el("code", "md-code-inline", text.slice(i + 1, end))); i = end + 1; continue; } }
      if (c === "*" && text[i + 1] === "*") { const end = text.indexOf("**", i + 2); if (end > i) { flush(); const st = el("strong"); renderInline(st, text.slice(i + 2, end)); target.appendChild(st); i = end + 2; continue; } }
      if (c === "*") { const end = text.indexOf("*", i + 1); if (end > i) { flush(); const em = el("em"); renderInline(em, text.slice(i + 1, end)); target.appendChild(em); i = end + 1; continue; } }
      buf += c; i++;
    }
    flush();
  }
  function buildCodeBlock(code, lang) {
    const wrap = el("div", "md-codewrap");
    const bar = el("div", "md-codebar");
    bar.appendChild(el("span", "md-codelang", lang || "code"));
    const copy = el("button", "md-copy", "Copy");
    copy.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); copy.textContent = "Copied"; }
      catch (_) { copy.textContent = "Copy failed"; }
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });
    bar.appendChild(copy);
    wrap.appendChild(bar);
    const pre = el("pre", "md-pre");
    pre.appendChild(el("code", null, code));
    wrap.appendChild(pre);
    return wrap;
  }
  function renderTextBlock(container, text) {
    const lines = text.split("\n");
    let list = null, listType = null, para = [];
    const flushPara = () => { if (!para.length) return; const p = el("p", "md-p"); renderInline(p, para.join(" ")); container.appendChild(p); para = []; };
    const flushList = () => { if (list) { container.appendChild(list); list = null; listType = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const ul = /^\s*[-*]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushPara();
        const t = ul ? "ul" : "ol";
        if (listType !== t) { flushList(); list = el(t, "md-list"); listType = t; }
        const li = el("li"); renderInline(li, ul ? ul[1] : ol[1]); list.appendChild(li);
        continue;
      }
      if (line.trim() === "") { flushPara(); flushList(); continue; }
      para.push(line.trim());
    }
    flushPara(); flushList();
  }
  function renderMarkdownInto(container, md) {
    container.textContent = "";
    const segments = String(md == null ? "" : md).split("```");
    segments.forEach((seg, idx) => {
      if (idx % 2 === 1) {
        let code = seg, lang = "";
        const nl = seg.indexOf("\n");
        if (nl >= 0) { const first = seg.slice(0, nl).trim(); if (/^[a-zA-Z0-9+#._-]*$/.test(first)) { lang = first; code = seg.slice(nl + 1); } }
        code = code.replace(/\n$/, "");
        container.appendChild(buildCodeBlock(code, lang));
      } else if (seg) {
        renderTextBlock(container, seg);
      }
    });
  }

  // ---- Chat bubbles ---------------------------------------------------------
  function bubble(who, text) {
    const b = document.createElement("div");
    b.className = "bubble " + who;
    b.dataset.who = who;
    fillBubble(b, text);
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function fillBubble(b, text) {
    if (b.dataset && b.dataset.who === "you") b.textContent = text == null ? "" : String(text);
    else renderMarkdownInto(b, text);
    log.scrollTop = log.scrollHeight;
  }

  // ---- Brain ----------------------------------------------------------------
  function callRoody(userText, onText, skipHistory) {
    let settled = false;
    const finish = (text, ok) => {
      if (settled) return; settled = true;
      clearTimeout(watchdog);
      onText(text);
      if (ok && !skipHistory) {
        history.push({ role: "user", content: userText });
        history.push({ role: "assistant", content: text });
        if (history.length > 20) history.splice(0, history.length - 20);
      }
    };
    const watchdog = setTimeout(() => finish("That took too long — try once more?", false), 30000);
    try {
      chrome.runtime.sendMessage(
        {
          type: "roody:ask",
          payload: {
            userText,
            pageContext: studyDoc ? studyDoc.text.slice(0, 16000) : "",
            history,
            site: "read",
            title: studyDoc ? studyDoc.name : "Read",
            pageMode: "learning",
          },
        },
        (res) => {
          if (chrome.runtime.lastError) return finish("I lost the connection to my brain — reload this tab?", false);
          if (!res || !res.ok) return finish((res && res.error) || "Something went wrong.", false);
          finish(res.text, true);
        }
      );
    } catch (_) {
      finish("We got disconnected — reload this tab and I'll be right back.", false);
    }
  }

  // ---- Load a PDF -----------------------------------------------------------
  const OPENER =
    "(The user just loaded a PDF. In 2-3 sentences of Markdown, give the useful decode: what this document is, the one idea that matters most, and one thing people usually get wrong or should focus on. Then briefly offer to go deeper or quiz them. Lead with substance.)";

  async function loadPdf(file) {
    if (!file) return;
    const note = bubble("roody", `📄 Reading ${file.name}…`);
    try {
      const text = await window.RoodyPDF.extractPdfText(await file.arrayBuffer());
      if (!text || text.length < 40) {
        studyDoc = null;
        fillBubble(note, `Hmm, I couldn't pull readable text out of ${file.name} — it's probably a scanned/image PDF. Paste the part you want and I'll read it with you.`);
        return;
      }
      studyDoc = { name: file.name, text };
      sub.textContent = `📄 reading ${file.name} · ${text.length.toLocaleString()} characters`;
      drop.style.display = "none";
      fillBubble(note, `📄 Got it — I read ${file.name}. Ask me anything.`);
      const thinking = bubble("roody", "…");
      callRoody(OPENER, (t) => fillBubble(thinking, t), true);
    } catch (e) {
      studyDoc = null;
      fillBubble(note, "I couldn't open that file — mind trying again?");
    }
  }

  async function loadPdfFromUrl(url) {
    const note = bubble("roody", `📄 Fetching the PDF…`);
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const text = await window.RoodyPDF.extractPdfText(buf);
      if (!text || text.length < 40) { fillBubble(note, "That PDF looks like scanned images — no text to read. Paste the part you want."); return; }
      const name = decodeURIComponent(url.split("/").pop() || "this PDF");
      studyDoc = { name, text };
      sub.textContent = `📄 reading ${name} · ${text.length.toLocaleString()} characters`;
      drop.style.display = "none";
      fillBubble(note, `📄 Got it — I read ${name}. Ask me anything.`);
      const thinking = bubble("roody", "…");
      callRoody(OPENER, (t) => fillBubble(thinking, t), true);
    } catch (_) {
      fillBubble(note, "I couldn't fetch that PDF — click 📄 to pick it from your computer instead.");
    }
  }

  // ---- Send -----------------------------------------------------------------
  function send(text) {
    text = (text || "").trim();
    if (!text) return;
    if (!studyDoc) { bubble("roody", "Load a PDF first (📄) and then ask me about it!"); return; }
    bubble("you", text);
    input.value = "";
    const thinking = bubble("roody", "…");
    callRoody(text, (t) => fillBubble(thinking, t));
  }

  // ---- Wiring ---------------------------------------------------------------
  pdfBtn.addEventListener("click", () => pdfFile.click());
  drop.addEventListener("click", () => pdfFile.click());
  pdfFile.addEventListener("change", () => {
    const f = pdfFile.files && pdfFile.files[0];
    pdfFile.value = "";
    if (f) loadPdf(f);
  });
  $("send").addEventListener("click", () => send(input.value));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") send(input.value); });

  ["dragenter", "dragover"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); })
  );
  ["dragleave", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "drop" || e.target === document) drop.classList.remove("hot"); })
  );
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("hot");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /pdf/i.test((f.type || "") + " " + (f.name || ""))) loadPdf(f);
  });

  // ---- Auto-load a PDF passed from the toolbar click ------------------------
  try {
    const src = new URLSearchParams(location.search).get("src");
    if (src) loadPdfFromUrl(src);
  } catch (_) {}
})();
