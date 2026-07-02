// Roody for editors — extension host.
// The webview (media/panel.js) owns the mic and the speaker; this file owns
// the API calls (no CORS in Node) and reading the editor state.
const vscode = require("vscode");
const persona = require("./persona.js");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const GROK_URL = "https://api.x.ai/v1/chat/completions";

const LANG_NAMES = {
  te: "Telugu", hi: "Hindi", ta: "Tamil", kn: "Kannada", ml: "Malayalam",
  es: "Spanish", fr: "French", de: "German", ja: "Japanese", ko: "Korean", zh: "Chinese",
};

// Same acting directions as the browser version — the voice performs the vibe.
const SIDEKICK_TTS_STYLES = {
  normal: "Say this warmly and casually, like a close friend mid-conversation — natural pauses, a smile in the voice. If the text has laughter (haha, pfft) actually chuckle it; if it has 'hmm' or 'ohh', perform them as real thinking sounds, not read them as words",
  minion: "Perform this like a small, silly, hyperactive creature. HIGH-PITCHED, squeaky, excited. Speed up on gibberish words. Goofy, chaotic, adorable",
  roadrunner: "Perform with bursts of extreme speed and energy. 'MEEP MEEP' sharp and high-pitched. Calm narration, then sudden ZOOM",
  coyote: "Perform like a dramatic narrator of a tragic comedy. Scheming and sophisticated, then deadpan disappointment when plans fail",
  pinkpanther: "Smooth, cool, suave — like a secret agent. Slow, deliberate, effortlessly mysterious",
  woody: "Cheerful bold cowboy. Warm and friendly, COMMANDING when rallying. Catchphrases enthusiastic and startled",
  rapunzel: "OVERWHELMING excitement and wonder. Breathless amazement, sing-songy on musical parts",
  snowwhite: "Sweet, gentle, melodic — almost singing. Soft, kind, impossibly caring",
  tom: "Big dramatic slapstick energy. Crashes loud and startled, scheming parts whispered and sneaky",
  jerry: "Clever, smug, mischievous. Quick and nimble, tiny triumphant victory moments",
};

function cfg() {
  const c = vscode.workspace.getConfiguration("roody");
  return {
    anthropicKey: c.get("anthropicKey") || "",
    geminiKey: c.get("geminiKey") || "",
    xaiKey: c.get("xaiKey") || "",
    elevenKey: c.get("elevenKey") || "",
    elevenVoice: c.get("elevenVoice") || "21m00Tcm4TlvDq8ikWAM",
    model: c.get("model") || "claude-haiku-4-5",
    voice: c.get("voice") || "Kore",
    vibe: c.get("vibe") || "normal",
    language: c.get("language") || "en-US",
  };
}

function langName(code) {
  if (!code) return null;
  return LANG_NAMES[code.split("-")[0]] || null;
}

// What Roody "sees": active file, selection, and current problems.
function editorContext() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return "(no file open right now)";
  const doc = ed.document;
  const sel = ed.selection && !ed.selection.isEmpty ? doc.getText(ed.selection) : "";
  // Visible portion of the file — what the user is literally looking at.
  const vis = ed.visibleRanges && ed.visibleRanges.length ? doc.getText(ed.visibleRanges[0]) : "";
  const diags = vscode.languages.getDiagnostics(doc.uri)
    .filter((d) => d.severity <= 1) // errors + warnings
    .slice(0, 5)
    .map((d) => `- line ${d.range.start.line + 1}: ${d.message}`)
    .join("\n");
  let out = `File: ${vscode.workspace.asRelativePath(doc.uri)} (${doc.languageId})\n`;
  if (sel) out += `\nSelected code:\n"""\n${sel.slice(0, 3000)}\n"""\n`;
  else if (vis) out += `\nVisible on screen:\n"""\n${vis.slice(0, 3000)}\n"""\n`;
  if (diags) out += `\nCurrent problems:\n${diags}\n`;
  return out;
}

// ---- Brains ----------------------------------------------------------------
function systemPrompt(vibe) {
  const overlay = persona.VIBES[vibe] || "";
  return overlay ? persona.SYSTEM + "\n" + overlay : persona.SYSTEM;
}

function buildUserMessage(userText, context, language) {
  const lName = langName(language);
  const langInstr = lName ? `IMPORTANT: Reply in ${lName}. The user is speaking ${lName}.\n\n` : "";
  const voiceInstr =
    "Reply in 1-2 COMPLETE short spoken sentences. This is read aloud — no lists, no markdown, end with punctuation.\n\n";
  const ctx = `You are sitting with the user in their code editor. Here is what they can see right now (context, NOT their message):\n\n${context}\n\n`;
  return langInstr + voiceInstr + ctx + userText;
}

async function askClaude(key, model, sys, history, userMsg) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      temperature: 0.5,
      system: [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }],
      messages: [...history, { role: "user", content: userMsg }],
    }),
  });
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = await resp.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

async function askGemini(key, model, sys, history, userMsg) {
  const contents = [
    ...history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: userMsg }] },
  ];
  const resp = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: 0.5, maxOutputTokens: 200 },
    }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = await resp.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join("").trim();
}

async function askGrok(key, model, sys, history, userMsg) {
  const resp = await fetch(GROK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: sys }, ...history, { role: "user", content: userMsg }],
      max_tokens: 200,
      temperature: 0.6,
    }),
  });
  if (!resp.ok) throw new Error(`Grok ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
  const data = await resp.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function askBrain(userText, history) {
  const c = cfg();
  const sys = systemPrompt(c.vibe);
  const userMsg = buildUserMessage(userText, editorContext(), c.language);
  const trimmed = history.slice(-6);
  if (c.model.startsWith("gemini-")) {
    if (!c.geminiKey) throw new Error("Gemini brain selected but no Gemini key — set roody.geminiKey in Settings.");
    return askGemini(c.geminiKey, c.model, sys, trimmed, userMsg);
  }
  if (c.model.startsWith("grok-")) {
    if (!c.xaiKey) throw new Error("Grok brain selected but no xAI key — set roody.xaiKey in Settings.");
    return askGrok(c.xaiKey, c.model, sys, trimmed, userMsg);
  }
  if (!c.anthropicKey) throw new Error("Claude brain selected but no Anthropic key — set roody.anthropicKey in Settings (or switch roody.model to gemini-2.5-flash).");
  return askClaude(c.anthropicKey, c.model, sys, trimmed, userMsg);
}

// ---- Ears (STT) — Gemini transcribes the webview's recording ---------------
async function speechToText(audioBase64, mime) {
  const c = cfg();
  if (!c.geminiKey) throw new Error("Voice needs a Gemini key (free at aistudio.google.com/apikey) — set roody.geminiKey.");
  const resp = await fetch(`${GEMINI_BASE}/gemini-2.5-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": c.geminiKey },
    body: JSON.stringify({
      contents: [{
        parts: [
          { text: "Transcribe this audio to plain text. Return ONLY the exact words spoken — no commentary, no quotes. If there is no clear speech, return an empty string." },
          { inlineData: { mimeType: mime, data: audioBase64 } },
        ],
      }],
    }),
  });
  if (!resp.ok) throw new Error(`STT ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  const data = await resp.json();
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join(" ").trim();
}

// ---- Mouth (TTS) — ElevenLabs first, Gemini fallback ------------------------
async function textToSpeech(text) {
  const c = cfg();
  if (c.elevenKey) {
    try {
      const resp = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${c.elevenVoice}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": c.elevenKey, "content-type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
          }),
        }
      );
      if (resp.ok) {
        const buf = Buffer.from(await resp.arrayBuffer());
        return { audioBase64: buf.toString("base64"), mime: "audio/mpeg" };
      }
    } catch (_) { /* fall through to Gemini */ }
  }
  if (!c.geminiKey) throw new Error("No TTS available — set roody.geminiKey or roody.elevenKey.");
  const style = SIDEKICK_TTS_STYLES[c.vibe] || SIDEKICK_TTS_STYLES.normal;
  const styled = `${style} (do not say this instruction, just perform what follows):\n\n${text}`;
  const resp = await fetch(`${GEMINI_BASE}/gemini-2.5-flash-preview-tts:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": c.geminiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: styled }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } } },
      },
    }),
  });
  if (!resp.ok) throw new Error(`TTS ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
  const data = await resp.json();
  const part = (data.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData);
  if (!part) throw new Error("TTS returned no audio");
  return { audioBase64: part.inlineData.data, mime: part.inlineData.mimeType };
}

// ---- Webview panel -----------------------------------------------------------
class RoodyPanel {
  constructor(context) {
    this.context = context;
    this.history = [];
  }

  resolveWebviewView(view) {
    this.view = view;
    this.wireWebview(view.webview);
  }

  wireWebview(wv) {
    this.wv = wv;
    wv.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    const js = wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.js"));
    const css = wv.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "panel.css"));
    wv.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${wv.cspSource}; script-src ${wv.cspSource}; media-src blob: data: mediastream:; img-src ${wv.cspSource} data:;">
<link rel="stylesheet" href="${css}">
</head>
<body>
  <div id="orb">🟠</div>
  <div id="status">Roody — tap the orb or type</div>
  <div id="log"></div>
  <div id="inputrow">
    <input id="text" type="text" placeholder="…or type to Roody" />
    <button id="send">➤</button>
  </div>
  <script src="${js}"></script>
</body>
</html>`;

    wv.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === "ask") {
          await this.handleAsk(msg.text);
        } else if (msg.type === "audio") {
          const transcript = await speechToText(msg.b64, msg.mime);
          if (!transcript) {
            wv.postMessage({ type: "status", text: "didn't catch that — try again" });
            wv.postMessage({ type: "listen" }); // resume the loop
            return;
          }
          wv.postMessage({ type: "transcript", text: transcript });
          await this.handleAsk(transcript);
        }
      } catch (e) {
        wv.postMessage({ type: "error", text: String(e.message || e).slice(0, 300) });
      }
    });
  }

  async handleAsk(text) {
    const wv = this.wv;
    wv.postMessage({ type: "status", text: "thinking…" });
    const reply = await askBrain(text, this.history);
    this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
    if (this.history.length > 12) this.history.splice(0, this.history.length - 12);
    wv.postMessage({ type: "reply", text: reply });
    try {
      const tts = await textToSpeech(reply);
      wv.postMessage({ type: "tts", b64: tts.audioBase64, mime: tts.mime });
    } catch (e) {
      // No voice available — text reply already shown; resume listening.
      wv.postMessage({ type: "status", text: `(voice off: ${String(e.message).slice(0, 80)})` });
      wv.postMessage({ type: "listen" });
    }
  }
}

function activate(context) {
  const panel = new RoodyPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("roody.panel", panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("roody.open", () =>
      vscode.commands.executeCommand("roody.panel.focus")
    ),
    // Editor-tab mode: some editors deny mic permission to SIDEBAR webviews
    // but grant it to full editor panels. If the sidebar orb says
    // "Permission denied", try this instead.
    vscode.commands.registerCommand("roody.openTab", () => {
      const tab = vscode.window.createWebviewPanel(
        "roody.tab",
        "Roody",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")] }
      );
      const session = new RoodyPanel(context);
      session.wireWebview(tab.webview);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
