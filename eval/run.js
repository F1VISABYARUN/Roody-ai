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
  "Study tab's PDF opener still auto-decodes the document",
  // The in-panel PDF button was removed for a cleaner input row; the Study
  // tab remains the only visible PDF UI, so the opener assertion moves there.
  read("src/study.js").includes("the one idea that matters most"),
  "Study-tab PDF opener changed"
);
checkTrue(
  "the removed PDF + screenshot buttons are gone from the panel input row",
  !content.includes('id="roody-pdf"') && !content.includes('id="roody-shot"') &&
    !read("src/content.css").includes("#roody-pdf") && !read("src/content.css").includes("#roody-shot"),
  "an in-panel PDF or screenshot button is still present"
);
checkTrue(
  "screenshot still auto-arms from wording / code-mode even without the button",
  content.includes("VISUAL_INTENT.test(userText)") && content.includes("CODE_TALK.test(userText)"),
  "auto-arm path lost when the manual button was removed"
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
  "OpenAI key is stored and lives in the consumer view (founder's ask)",
  read("src/options.js").includes("roodyOpenAIKey") &&
    (() => {
      const h = read("src/options.html");
      const cut = h.indexOf('id="adminonly"');
      // Now REQUIRED to be in the consumer half, not the dev half.
      return h.slice(0, cut).includes('id="okey"');
    })(),
  "OpenAI key wiring missing or still stuck behind #dev"
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
  "spend meter + proxy override live in the dev panel, not the consumer view",
  devPanel.includes('id="spendusd"') && !consumerView.includes('id="spendusd"') &&
    devPanel.includes('id="proxyurl"') && !consumerView.includes('id="proxyurl"'),
  "dev-only machinery leaked to consumer view"
);
// The founder asked for Claude/OpenAI/Grok keys "directly in the settings" —
// so the brain picker and those three keys now belong in the consumer view.
// (Only the Gemini own-key stays dev-only, since invite codes already cover
// the free-Gemini path.)
checkTrue(
  "the three own-key fields are in the consumer view",
  consumerView.includes('id="key"') && consumerView.includes('id="okey"') && consumerView.includes('id="xkey"') &&
    consumerView.includes('id="clearkey"') && consumerView.includes('id="clearo"') && consumerView.includes('id="clearx"'),
  "own-key controls are still hidden behind #dev"
);
checkTrue(
  "each consumer-view key has a status line and a getkey link",
  consumerView.includes('id="keystatus"') && consumerView.includes('id="ostatus"') && consumerView.includes('id="xstatus"') &&
    /console\.anthropic\.com/.test(consumerView) && /platform\.openai\.com/.test(consumerView) && /console\.x\.ai/.test(consumerView),
  "status labels or provider links missing from consumer view"
);
// The consumer view no longer asks the user to type a model string at all.
// Provider chips + auto-pick from whichever key is set.
checkTrue(
  "consumer view has no model-string input at all",
  !consumerView.includes('id="model"'),
  "a model-ID field is still user-visible"
);
checkTrue(
  "consumer view has the Preferred-brain chip selector",
  consumerView.includes('id="brainpref"') &&
    /data-pref="auto"/.test(consumerView) && /data-pref="claude"/.test(consumerView) &&
    /data-pref="openai"/.test(consumerView) && /data-pref="gemini"/.test(consumerView) &&
    /data-pref="grok"/.test(consumerView),
  "Preferred-brain chip selector missing from consumer view"
);
checkTrue(
  "options.js persists the chip choice and paints the active chip",
  read("src/options.js").includes("roodyBrainPref") && read("src/options.js").includes("brainpref"),
  "chip wiring missing from options.js"
);
// Model override still exists — in #dev only, for the founder.
checkTrue(
  'model-ID override lives in #dev only ("Advanced: override model ID")',
  devPanel.includes('id="model"') && /Advanced:\s*override model ID/.test(devPanel),
  "the founder's model override is missing or in the wrong place"
);
// Auto-pick: background has a DEFAULT_MODELS table and a pickBrain() helper
// that walks the keys in the documented order.
checkTrue(
  "background has DEFAULT_MODELS with all four provider defaults",
  /DEFAULT_MODELS\s*=\s*\{[\s\S]{0,400}claude:[\s\S]{0,400}openai:[\s\S]{0,400}gemini:[\s\S]{0,400}grok:/.test(bg),
  "DEFAULT_MODELS table missing or incomplete"
);
checkTrue(
  "pickBrain() honors the dev override, then the chip, then walks keys",
  /function pickBrain\(prefs\)[\s\S]{0,1800}prefs\.roodyModel[\s\S]{0,500}prefs\.roodyBrainPref[\s\S]{0,500}prefs\.roodyApiKey[\s\S]{0,300}prefs\.roodyOpenAIKey[\s\S]{0,300}prefs\.roodyGeminiKey[\s\S]{0,300}prefs\.roodyXaiKey/.test(bg),
  "pickBrain missing or does the key walk in the wrong order"
);

console.log("\n— Roody knows its own state (fix for 'parroted the page') —");

// pickBrain now returns { model, provider, reason } so the LLM can be told
// which provider is running and why, instead of guessing from page text.
checkTrue(
  "pickBrain returns { model, provider, reason }",
  /return\s*\{\s*model:[^}]*provider:[^}]*reason:/.test(bg),
  "pickBrain still returns a bare model string"
);
// providerOf maps a model string to its provider tag so a dev override still
// gets labeled correctly.
checkTrue(
  "providerOf() derives the provider from the model prefix",
  /function providerOf\(model\)[\s\S]{0,400}claude-[\s\S]{0,400}gemini-[\s\S]{0,400}grok-[\s\S]{0,400}gpt-/.test(bg),
  "providerOf missing — dev overrides won't be tagged"
);
// The ROODY STATE block is what actually reaches the LLM every turn.
checkTrue(
  "buildRoodyState emits a CURRENT ROODY STATE block with model + keys + vision",
  /function buildRoodyState[\s\S]{0,1200}CURRENT ROODY STATE[\s\S]{0,600}Current brain:[\s\S]{0,200}Keys set:[\s\S]{0,300}Vision available:/.test(bg),
  "ROODY STATE block missing or incomplete"
);
checkTrue(
  "askRoody threads the ROODY STATE into the system prompt",
  bg.includes("const stateBlock = buildRoodyState(") &&
    /systemPrompt\s*=\s*stateBlock\s*\+/.test(bg),
  "ROODY STATE isn't wired into the prompt path"
);
// The Claude cache-split now carries the dynamic state block on the uncached
// side so it isn't stale across turns.
checkTrue(
  "Claude system-messages split keeps ROODY STATE uncached (per-turn accuracy)",
  /system:\s*\[[\s\S]{0,300}cache_control:\s*\{[\s\S]{0,100}stateBlock/.test(bg),
  "Claude system-messages structure lost the state block"
);
// Persona guardrail — the whole reason we're here.
checkTrue(
  "persona has the ABOUT YOU / meta-questions rule",
  /ABOUT YOU \(meta-questions\)/.test(persona) &&
    /never quote the page or a chat transcript back as if it described you/i.test(persona),
  "persona is still missing the meta-questions guardrail"
);
checkTrue(
  '"isn\'t set up" errors mention keys, not just invite codes',
  (() => {
    const setup = bg.match(/Roody isn't set up yet[^"]*/g) || [];
    return setup.length > 0 && setup.every((s) => /api key/i.test(s));
  })(),
  "the setup-error copy still tells users to paste an invite code only"
);
checkTrue(
  "panel subtitle is coding-assistant copy",
  content.includes("AI coding assistant"),
  "panel subtitle not updated"
);
checkTrue(
  "panel is transparent glass and the transparency slider is wired live",
  read("src/content.css").includes("--roody-alpha") &&
    read("src/content.css").includes("backdrop-filter") &&
    content.includes("applyOpacity") && content.includes("changes.roodyOpacity") &&
    read("src/options.js").includes("roodyOpacity"),
  "transparency control missing or not live-updating"
);
checkTrue(
  "no descendant re-opaques the glass (header/input row stay transparent)",
  (() => {
    const css = read("src/content.css");
    const hdr = css.slice(css.indexOf("#roody-header {"));
    const row = css.slice(css.indexOf("#roody-inputrow {"));
    return /background:\s*transparent/.test(hdr.slice(0, 400)) &&
      /background:\s*transparent/.test(row.slice(0, 400));
  })(),
  "a panel child paints an opaque fill over the glass"
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

console.log("\n— Coding-assistant fitness for the HackerRank/LeetCode use case —");

// Screenshots hide Roody's own UI first — otherwise the vision model reads
// Roody's own bubble text as if it were page content (the "58 min 24 sec h" bug).
checkTrue(
  "grabScreenshot hides orb + panel before captureVisibleTab",
  /grabScreenshot[\s\S]{0,1200}orb\.style\.visibility[\s\S]{0,400}panel\.style\.visibility[\s\S]{0,400}requestAnimationFrame[\s\S]{0,300}"roody:screenshot"/.test(content),
  "screenshot capture still bakes Roody's UI into the image"
);
checkTrue(
  "capture message doesn't sit in the same bubble the model will read",
  !content.includes('"📸 capturing your screen…"') || !content.includes('fillBubble(thinking, "📸'),
  "the 'capturing your screen' text is still visible during capture"
);

// Editor extraction — Monaco/CodeMirror/Ace, not just textContent.
checkTrue(
  "content.js extracts Monaco lines by sorted top-px",
  content.includes(".view-lines .view-line") && content.includes('top\\s*:\\s*(-?\\d+') &&
    content.includes(".cm-content") && content.includes(".CodeMirror-code") && content.includes(".ace_editor .ace_text-layer"),
  "editor extraction missing a family or reading DOM order for Monaco (which reorders)"
);
checkTrue(
  "readPage sends PROBLEM + CODE blocks when an editor is on the page",
  content.includes("extractEditorCode") && content.includes("PROBLEM:") && content.includes("CODE ("),
  "coding pages still fall through to the run-on textContent path"
);
checkTrue(
  "code mode detects LeetCode/HackerRank/Codeforces/etc",
  // Sites live inside a regex literal, so the source contains escaped dots.
  content.includes("leetcode\\.com") && content.includes("hackerrank\\.com") && content.includes("codesignal\\.com") &&
    content.includes("codeforces\\.com") && content.includes("atcoder\\.jp"),
  "coding platforms missing from code-mode detector"
);

// Failure handling.
checkTrue(
  "background retries 429/5xx/network on every brain",
  bg.includes("fetchWithRetry") && bg.includes("RETRIABLE_STATUS") &&
    /await\s+fetchWithRetry\(ANTHROPIC_URL/.test(bg) &&
    /await\s+fetchWithRetry\(OPENAI_URL/.test(bg) &&
    /await\s+fetchWithRetry\(GROK_URL/.test(bg) &&
    /await\s+fetchWithRetry\(`\$\{GEMINI_BASE\}/.test(bg),
  "retry helper not applied to every brain fetch"
);
checkTrue(
  "watchdog nudges rather than discards a late reply",
  content.includes("lastTurnId") && content.includes("commitAnswer") &&
    !/setTimeout\([\s\S]{0,120}"That took too long/.test(content),
  "the old 30s discard-on-timeout latch is still in place"
);

// Silent image drop — moved outside the geminiReachable guard.
checkTrue(
  "vision fallback fires even without Gemini reachable (no silent image drop)",
  bg.includes("imageDropReason") && /if\s*\(\s*image\s*\)\s*\{[\s\S]{0,600}modelSupportsVision/.test(bg),
  "screenshots are still silently dropped on non-vision own-key brains"
);

// UI polish.
checkTrue(
  "panel is resizable and its size persists",
  content.includes('#roody-resize') && content.includes("roodyPanelSize") &&
    read("src/content.css").includes("#roody-resize"),
  "resize handle missing"
);
checkTrue(
  "default panel width bumped for readable code blocks",
  /#roody-panel\s*\{[\s\S]{0,600}width:\s*440px/.test(read("src/content.css")),
  "default panel is still too narrow for code"
);
checkTrue(
  "placeRoody keeps the panel on the orb's side of the screen",
  content.includes("orbCenter") && content.includes("W / 2"),
  "panel would still hang across the middle of the page"
);

// VISUAL_INTENT covers the coder phrasings.
checkTrue(
  "VISUAL_INTENT catches the phrasings a coder actually uses",
  (() => {
    const m = /const VISUAL_INTENT\s*=\s*(\/[\s\S]+?\/i)\s*;/.exec(content);
    if (!m) return false;
    // eslint-disable-next-line no-eval
    const re = eval(m[1]);
    return re.test("what's wrong with my code?") &&
      re.test("why does this fail") &&
      re.test("look at my editor") &&
      re.test("the error");
  })(),
  "VISUAL_INTENT regex too narrow for a coding assistant"
);

console.log(`\n${fail === 0 ? "🎉" : "💥"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
