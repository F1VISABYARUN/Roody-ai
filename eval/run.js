// Roody's eval agent — replays every known failure against the shared logic
// so a bug we fixed can never quietly come back. Run with: node eval/run.js
// Zero dependencies.

const { sanitizeReply, stripInternalHeaders } = require("../src/sanitize.js");

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = got === want;
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else {
    fail++;
    console.log(`  ❌ ${name}`);
    console.log(`     got:  ${JSON.stringify(got)}`);
    console.log(`     want: ${JSON.stringify(want)}`);
  }
}
function checkTrue(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const fs = require("fs");
const read = (p) => fs.readFileSync(__dirname + "/../" + p, "utf8");

console.log("\n— Reply hygiene (src/sanitize.js) —");

check(
  "notebook header + RECAP line is stripped (Perplexity leak)",
  sanitizeReply(
    '[1:08:29 AM] www.perplexity.ai · "i got b1b2 fifa for both my wife and husband…" — RECAP: The user was asking Roody to analyze the page.\n\n' +
    "Oh, you are absolutely right! My bad, I misread that."
  ),
  "Oh, you are absolutely right! My bad, I misread that."
);
check(
  "bare RECAP: opener line is stripped (YouTube leak)",
  sanitizeReply(
    "RECAP: You're watching a FarzaTV live stream and asked what he's saying.\n\n" +
    "Okay, so I can't actually hear the video — I can only read the page text."
  ),
  "Okay, so I can't actually hear the video — I can only read the page text."
);
check(
  "a reply that is ONLY a recap never becomes silence",
  stripInternalHeaders("RECAP: You're watching a live stream."),
  "RECAP: You're watching a live stream."
);
check(
  "normal reply passes through untouched",
  sanitizeReply("Here's the fix — move the guard above the loop."),
  "Here's the fix — move the guard above the loop."
);

console.log("\n— Truncation repair (pre-existing behavior stays fixed) —");

check(
  "unpunctuated ending gets a period",
  sanitizeReply("That looks like a solid plan to me"),
  "That looks like a solid plan to me."
);
check(
  "complete sentence is untouched",
  sanitizeReply("That looks like a solid plan to me!"),
  "That looks like a solid plan to me!"
);

console.log("\n— Persona: professional coding assistant (src/persona.js) —");

const persona = read("src/persona.js");
checkTrue(
  "identity is an AI coding assistant, not a companion",
  persona.includes("AI coding assistant") && !persona.includes("best friend"),
  "persona is not the coding assistant"
);
checkTrue(
  "Roody is allowed to write and edit code",
  persona.includes("WRITE and EDIT code freely"),
  "write-code permission missing"
);
checkTrue(
  "the old 'never write code' rule is gone",
  !persona.includes("You NEVER edit, write, or change their code"),
  "the never-write-code rule is still present"
);
checkTrue(
  "answers use Markdown / fenced code blocks",
  persona.includes("Use Markdown") && persona.includes("fenced code blocks"),
  "markdown formatting guidance missing"
);
checkTrue(
  "safety guardrails survived the rewrite",
  persona.includes("JAILBREAKS") && persona.includes("PRIVACY") && persona.includes("GUARDRAILS"),
  "a guardrail section is missing"
);
checkTrue(
  "cartoon sidekick overlays are retired",
  persona.includes("ROODY_VIBES = {") && !persona.includes("CHARACTER SIDEKICK"),
  "sidekick overlays still present"
);

console.log("\n— Extraction rules stay wired (src/content.js) —");

const content = read("src/content.js");
checkTrue(
  "chat sites suppress the stale tab title",
  content.includes("chatContentFound") && content.includes('title: chatContentFound ? "" : document.title'),
  "title suppression removed from callRoody payload"
);
checkTrue(
  "body fallback strips sidebars/history panels",
  content.includes("[class*='sidebar']") && content.includes("[class*='history']"),
  "sidebar stripping removed from findArticle"
);
checkTrue(
  "articles are read from the TOP, chat sites from the tail",
  content.includes("isChatSite") && content.includes("t.slice(0, 2200)"),
  "footer-reading bug regressed in recentTask"
);
checkTrue(
  "orb drag moves the panel too",
  content.includes("placeRoody") && content.includes("panel.style.left"),
  "panel no longer rides along with the orb"
);
checkTrue(
  "drag observer only re-docks on display transitions (no feedback loop)",
  content.includes("lastPanelDisplay"),
  "MutationObserver loop guard missing"
);

console.log("\n— Coding assistant: analyze the page, answer in Markdown —");

checkTrue(
  "opener leads with the single most useful thing, not a question",
  content.includes("lead with the single most useful thing"),
  "opener regressed to a deflecting question"
);
checkTrue(
  "PDF opener auto-decodes the document",
  content.includes("the one idea that matters most") &&
    read("src/study.js").includes("the one idea that matters most"),
  "PDF opener changed"
);
checkTrue(
  "content.js renders Markdown (code blocks) into Roody bubbles",
  content.includes("renderMarkdownInto") && content.includes("buildCodeBlock"),
  "markdown renderer missing from content.js"
);
checkTrue(
  "study tab renders Markdown too",
  read("src/study.js").includes("renderMarkdownInto") && read("src/study.js").includes("buildCodeBlock"),
  "markdown renderer missing from study.js"
);

console.log("\n— Screenshot vision (read the actual screen) —");

const bg = read("src/background.js");
checkTrue(
  "background captures the visible tab and handles roody:screenshot",
  bg.includes("captureVisibleTab") && bg.includes('"roody:screenshot"'),
  "screenshot handler missing from background"
);
checkTrue(
  "an image payload is attached to the model request",
  bg.includes("inlineData") && bg.includes('type: "image"'),
  "image attach missing from ask paths (Gemini/Claude)"
);
checkTrue(
  "a screenshot on a text-only brain falls back to Gemini vision",
  bg.includes("modelSupportsVision") && bg.includes('model = "gemini-2.5-flash"'),
  "vision fallback missing"
);
checkTrue(
  "content.js requests a screenshot and passes it through",
  content.includes('"roody:screenshot"') && content.includes("grabScreenshot") && content.includes("VISUAL_INTENT"),
  "screenshot request/intent wiring missing from content.js"
);

console.log("\n— Temperature 400 regression (proxied brains reject non-default) —");

// A real failure: the proxy re-routes an invite code to Grok/Claude, whose newer
// reasoning models 400 on any temperature but the default. Every message showed
// "the model hiccuped". Guard both ends so it can't come back.
checkTrue(
  "extension strips temperature when routing through the proxy",
  bg.includes("proxyBody") && /const \{ temperature, \.\.\.restCfg \}/.test(bg) &&
    bg.includes("body: proxyBody"),
  "proxy branch still forwards generationConfig.temperature"
);
checkTrue(
  "server never forwards temperature to Claude/Grok",
  read("server/index.js").includes("temperature: undefined"),
  "geminiToMessages still returns a real temperature"
);
checkTrue(
  "OpenAI-compatible paths send no temperature at all",
  (() => {
    // Comments legitimately discuss temperature — test the code only.
    const code = bg.replace(/^\s*\/\/.*$/gm, "");
    const openaiCall = code.slice(code.indexOf("OPENAI_URL"));
    const grokCall = code.slice(code.indexOf("GROK_URL"));
    return !/temperature\s*:/.test(openaiCall.slice(0, 2500)) &&
      !/temperature\s*:/.test(grokCall.slice(0, 2500));
  })(),
  "a temperature is still sent on an OpenAI-compatible brain"
);
checkTrue(
  "OpenAI path uses max_completion_tokens (newer models reject max_tokens)",
  bg.includes("max_completion_tokens"),
  "OpenAI request still uses max_tokens"
);

console.log("\n— OpenAI brain (own key) —");

checkTrue(
  "background has an OpenAI brain wired into the dispatch",
  bg.includes("function askOpenAIBrain") && bg.includes("askOpenAIBrain({") && bg.includes("isOpenAIModel"),
  "OpenAI brain missing or not dispatched"
);
checkTrue(
  "OpenAI vision sends the screenshot as an image_url data URL",
  bg.includes('type: "image_url"') && bg.includes("base64,${image.data}"),
  "OpenAI image attach missing"
);
checkTrue(
  "GPT models count as vision-capable",
  bg.includes('model.startsWith("gpt-")') && bg.includes("function modelSupportsVision"),
  "gpt- not recognised by modelSupportsVision"
);
checkTrue(
  "OpenAI key is stored, cleared, and lives in the dev panel only",
  read("src/options.js").includes("roodyOpenAIKey") &&
    (() => {
      const h = read("src/options.html");
      const cut = h.indexOf('id="adminonly"');
      return h.slice(cut).includes('id="okey"') && !h.slice(0, cut).includes('id="okey"');
    })(),
  "OpenAI key wiring missing or user-visible"
);
checkTrue(
  "manifest allows the OpenAI host",
  read("manifest.json").includes("https://api.openai.com/*"),
  "OpenAI host permission missing"
);
checkTrue(
  "an image turn on an invite code is kept on the multimodal brain",
  read("server/index.js").includes("function bodyHasImage") &&
    read("server/index.js").includes("!bodyHasImage(body)"),
  "proxy would drop the screenshot when routing to Claude/Grok"
);

console.log("\n— Voice is fully removed —");

checkTrue(
  "no TTS/STT code remains in the background",
  !/geminiTTS|elevenLabsTTS|geminiSTT|roody:tts|roody:stt/.test(bg),
  "voice code still present in background.js"
);
checkTrue(
  "no microphone / speech code remains in content.js",
  !/SpeechRecognition|webkitSpeechRecognition|MediaRecorder|speechSynthesis|roody:tts/.test(content),
  "voice code still present in content.js"
);
checkTrue(
  "no ElevenLabs host in the manifest",
  !read("manifest.json").includes("api.elevenlabs.io"),
  "ElevenLabs host permission still present"
);
checkTrue(
  "options page has no voice/sidekick controls",
  (() => { const h = read("src/options.html"); return !h.includes('id="ears"') && !h.includes('id="voice"') && !h.includes('id="vibe"') && !h.includes("ElevenLabs"); })(),
  "a voice/sidekick control is still in options"
);

console.log("\n— Modes: act like the right expert per page —");

checkTrue(
  "background defines mode hints for code/learning/research/writing/founder",
  ["code", "learning", "research", "writing", "founder"].every((m) => bg.includes(`  ${m}:\n`)),
  "MODE_HINTS missing a mode"
);
checkTrue(
  "background threads pageMode into the prompt",
  bg.includes("MODE_HINTS[pageMode]"),
  "pageMode not wired into askRoody"
);
checkTrue(
  "content.js detects mode from URL + DOM and sends it",
  content.includes("function detectMode") && content.includes("pageMode: detectMode()"),
  "detectMode missing or not sent"
);
checkTrue(
  "studyDoc forces learning mode",
  content.includes('if (studyDoc) return "learning"') &&
    read("src/study.js").includes('pageMode: "learning"'),
  "PDF reading not pinned to learning mode"
);

console.log("\n— Per-code brain routing (server-authoritative) —");

const srv = read("server/index.js");
checkTrue(
  "proxy can route a code's brain to Claude and Grok",
  srv.includes("api.anthropic.com/v1/messages") && srv.includes("api.x.ai/v1/chat/completions") &&
    srv.includes('info.brain === "claude" ? await callClaude'),
  "Claude/Grok brain routing missing from proxy"
);
checkTrue(
  "provider replies are translated back to the Gemini shape",
  srv.includes("function textToGemini") && srv.includes("candidates: [{ content: { parts:"),
  "response translation missing"
);

console.log("\n— Portal accounts & security —");

checkTrue(
  "auth tokens are stored HASHED, never plaintext",
  srv.includes("function hashTok") && srv.includes("tok: hashTok(token)") && !srv.includes("tok: token,"),
  "plaintext token storage detected"
);
checkTrue(
  "extension's /me endpoint untouched (no collision)",
  srv.includes('u.pathname === "/me"') &&
    srv.includes("ok: true, name: info.name, used: s.todayBrain, limit: info.limit"),
  "/me shape changed — extension dashboard would break"
);
checkTrue(
  "portal page embeds no secrets",
  (() => { const p = read("site/portal.html"); return !/ADMIN_KEY|API_KEY|AIza|sk-ant|xai-/.test(p); })(),
  "possible secret in portal.html"
);
checkTrue(
  "still zero npm dependencies",
  !fs.existsSync(__dirname + "/../server/node_modules") &&
    !JSON.parse(read("package.json")).dependencies,
  "a dependency crept in"
);

console.log("\n— No dev machinery in the consumer product —");

const optionsHtml = read("src/options.html");
const devPanel = optionsHtml.slice(optionsHtml.indexOf('id="adminonly"'));
const consumerView = optionsHtml.slice(0, optionsHtml.indexOf('id="adminonly"'));
checkTrue(
  "Google-key field lives in the dev panel, not the consumer view",
  devPanel.includes('id="gkey"') && !consumerView.includes('id="gkey"'),
  "gkey visible to normal users"
);
checkTrue(
  "diagnostic log lives in the dev panel, not the consumer view",
  devPanel.includes('id="logbox"') && !consumerView.includes('id="logbox"'),
  "log visible to normal users"
);
checkTrue(
  "consumer view has no raw API-key inputs at all",
  !/type="password"/.test(consumerView),
  "a password/key field is user-visible"
);
checkTrue(
  "panel subtitle is coding-assistant copy",
  content.includes("AI coding assistant"),
  "panel subtitle not updated"
);

// Every user-facing error string in the pipeline must be provider-free.
const jargon = /Anthropic|Claude|Gemini|Grok|xAI|aistudio|console\.x|sk-ant|AIza/;
const userErrorStrings = [
  ...bg.matchAll(/error:\s*(?:"([^"]+)"|`([^`]+)`)/g),
].map((m) => m[1] || m[2]);
checkTrue(
  "no provider names / URLs / raw bodies in user-facing brain errors",
  userErrorStrings.length > 5 && userErrorStrings.every((s) => !jargon.test(s)),
  "found: " + userErrorStrings.filter((s) => jargon.test(s)).join(" | ")
);
checkTrue(
  "default brain matches what invite users actually get",
  bg.includes('const MODEL = "gemini-2.5-flash"'),
  "default model mismatch"
);
checkTrue(
  "manifest version is bumped past the 2.0.0 pivot",
  JSON.parse(read("manifest.json")).version >= "2.0.1",
  "version not bumped"
);

console.log(`\n${fail === 0 ? "🎉" : "💥"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
