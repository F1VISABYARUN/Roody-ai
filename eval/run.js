// Roody's eval agent — replays every known failure against the shared logic
// so a bug we fixed can never quietly come back. Run with: node eval/run.js
// Every user-reported screenshot becomes a case here. Zero dependencies.

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

console.log("\n— Reply hygiene (src/sanitize.js) —");

// CASE: Perplexity leak, 2026-07-04 screenshot. Roody spoke its internal
// notebook header out loud: '[1:08:29 AM] www.perplexity.ai · "…" — RECAP: …'
check(
  "notebook header + RECAP line is stripped (Perplexity leak)",
  sanitizeReply(
    '[1:08:29 AM] www.perplexity.ai · "i got b1b2 fifa for both my wife and husband…" — RECAP: The user was asking Roody to analyze the page.\n\n' +
    "Oh, you are absolutely right! My bad, I misread that."
  ),
  "Oh, you are absolutely right! My bad, I misread that."
);

// CASE: YouTube leak, same day. Replies opened with a bare "RECAP: …" line.
check(
  "bare RECAP: opener line is stripped (YouTube leak)",
  sanitizeReply(
    "RECAP: You're watching a FarzaTV live stream and asked what he's saying.\n\n" +
    "Okay, so I can't actually hear the video — I can only read the page text."
  ),
  "Okay, so I can't actually hear the video — I can only read the page text."
);

check(
  "stacked header lines are all stripped",
  sanitizeReply(
    "[12:27:45 AM] claude.ai · \"Claude Code\"\nRECAP: The user was starting a new conversation.\n\nHey! What are we looking at?"
  ),
  "Hey! What are we looking at?"
);

check(
  "a reply that is ONLY a recap never becomes silence",
  stripInternalHeaders("RECAP: You're watching a live stream."),
  "RECAP: You're watching a live stream."
);

check(
  "normal reply passes through untouched",
  sanitizeReply("Haha okay, bold question. So — what's the plan?"),
  "Haha okay, bold question. So — what's the plan?"
);

check(
  "mid-reply timestamps are NOT stripped (only leading headers)",
  sanitizeReply("The stream started at [1:08:29 AM] according to the page."),
  "The stream started at [1:08:29 AM] according to the page."
);

console.log("\n— Truncation repair (pre-existing behavior stays fixed) —");

check(
  "dangling contraction gets a graceful ending",
  sanitizeReply("Okay, we'"),
  "Okay, we'… let me try that again."
);
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

console.log("\n— Persona guardrails present (src/persona.js) —");

const fs = require("fs");
const persona = fs.readFileSync(__dirname + "/../src/persona.js", "utf8");
checkTrue(
  "content-beats-title rule exists",
  persona.includes("TRUST THE CONTENT, NOT THE TAB TITLE"),
  "guardrail line missing from persona"
);
checkTrue(
  "never-output-internal-formats rule exists",
  persona.includes("NEVER OUTPUT INTERNAL FORMATS"),
  "guardrail line missing from persona"
);
checkTrue(
  "editor persona is in sync with src persona",
  fs.readFileSync(__dirname + "/../editor/persona.js", "utf8").includes("TRUST THE CONTENT, NOT THE TAB TITLE"),
  "regenerate editor/persona.js from src/persona.js"
);

console.log("\n— Extraction rules stay wired (src/content.js) —");

const content = fs.readFileSync(__dirname + "/../src/content.js", "utf8");
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

console.log("\n— Thinking Partner: lead with substance, never deflect —");

checkTrue(
  "persona has the Thinking Partner / page-is-the-prompt rule",
  persona.includes("THINKING PARTNER") && persona.includes("The page IS the prompt"),
  "thinking-partner rule missing from persona"
);
checkTrue(
  "persona bans the deflection replies from the logs",
  persona.includes("What's on your mind?") && persona.includes("BANNED"),
  "deflection ban missing from persona"
);
checkTrue(
  "persona demands judgment over description",
  persona.includes("JUDGING the page = valuable") || persona.includes("Lead with JUDGMENT"),
  "judgment>description rule missing"
);
checkTrue(
  "opener prompt leads with substance, not a question",
  content.includes("single most USEFUL thing you notice") &&
    !content.includes("then ask them one thing"),
  "opener still deflects with a question"
);
checkTrue(
  "PDF opener auto-decodes instead of asking how to use it",
  content.includes("ONE key idea that matters most") &&
    fs.readFileSync(__dirname + "/../src/study.js", "utf8").includes("ONE key idea that matters most"),
  "PDF opener still asks 'how do you want to use it?'"
);

console.log("\n— Modes: act like the right expert per page —");

const bg = fs.readFileSync(__dirname + "/../src/background.js", "utf8");
checkTrue(
  "background defines mode hints for code/learning/research/writing/founder",
  ["code", "learning", "research", "writing", "founder"].every((m) => bg.includes(`  ${m}:\n`)),
  "MODE_HINTS missing a mode"
);
checkTrue(
  "background threads pageMode into the prompt",
  bg.includes("pageMode }") && bg.includes("MODE_HINTS[pageMode]"),
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
    fs.readFileSync(__dirname + "/../src/study.js", "utf8").includes('pageMode: "learning"'),
  "PDF study not pinned to learning mode"
);

console.log("\n— Accurate ears (Whisper) wiring —");

const server = fs.readFileSync(__dirname + "/../server/index.js", "utf8");
checkTrue(
  "proxy routes STT to Whisper when OPENAI_API_KEY is set",
  server.includes("api.openai.com/v1/audio/transcriptions") && server.includes('kind === "stt" && OPENAI_KEY'),
  "Whisper branch missing from server"
);
checkTrue(
  "Whisper reply is wrapped in a Gemini-shaped response",
  server.includes("candidates: [{ content: { parts: [{ text: out.text"),
  "extension-compatible response shape missing"
);
checkTrue(
  "content.js dispatches ears mode in startListening",
  content.includes('earsMode === "accurate"') && content.includes("recStartListening"),
  "accurate-ears dispatch missing"
);
checkTrue(
  "options page exposes the ears setting",
  fs.readFileSync(__dirname + "/../src/options.html", "utf8").includes('id="ears"') &&
    fs.readFileSync(__dirname + "/../src/options.js", "utf8").includes("roodyEars"),
  "ears setting missing from options"
);

console.log("\n— Per-code brain/voice (admin-selectable, server-authoritative) —");

const srv = fs.readFileSync(__dirname + "/../server/index.js", "utf8");
checkTrue(
  "proxy can route a code's brain to Claude and Grok",
  srv.includes("api.anthropic.com/v1/messages") && srv.includes("api.x.ai/v1/chat/completions") &&
    srv.includes('info.brain === "claude" ? await callClaude'),
  "Claude/Grok brain routing missing from proxy"
);
checkTrue(
  "proxy can route a code's voice to ElevenLabs",
  srv.includes("api.elevenlabs.io/v1/text-to-speech") && srv.includes('info.voice === "eleven"'),
  "ElevenLabs voice routing missing"
);
checkTrue(
  "provider replies are translated back to the Gemini shape",
  srv.includes("function textToGemini") && srv.includes("candidates: [{ content: { parts:"),
  "response translation missing"
);
checkTrue(
  "a brain/voice falls back to Gemini when its founder key is absent",
  srv.includes("function resolveBrain") && srv.includes("function resolveVoice"),
  "missing key-absent fallback guard"
);
checkTrue(
  "admin mint form offers brain and voice dropdowns",
  srv.includes('name="brain"') && srv.includes('name="voice"') &&
    srv.includes("brain, voice,") && srv.includes('["gemini", "claude", "grok"].includes'),
  "admin brain/voice selection missing"
);

console.log("\n— Portal accounts & waitlist (Antigravity's plan + the 4 fixes) —");

const srv2 = fs.readFileSync(__dirname + "/../server/index.js", "utf8");
checkTrue(
  "auth tokens are stored HASHED, never plaintext (fix #1)",
  srv2.includes("function hashTok") && srv2.includes("tok: hashTok(token)") && !srv2.includes("tok: token,"),
  "plaintext token storage detected"
);
checkTrue(
  "inputs validated + growth caps on waitlist/accounts/tokens (fix #2)",
  srv2.includes("function validEmail") && srv2.includes("WAITLIST_CAP") &&
    srv2.includes("ACCOUNTS_PER_CODE") && srv2.includes("TOKENS_PER_USER"),
  "validation/caps missing"
);
checkTrue(
  "extension's /me endpoint untouched (no collision)",
  srv2.includes('u.pathname === "/me"') && srv2.includes('u.pathname === "/me/profile"') &&
    srv2.includes("ok: true, name: info.name, used: s.todayBrain, limit: info.limit"),
  "/me shape changed — extension dashboard would break"
);
checkTrue(
  "portal served from site/ like the other public pages",
  srv2.includes('"portal.html"') && fs.existsSync(__dirname + "/../site/portal.html"),
  "portal route or file missing"
);
checkTrue(
  "portal page embeds no secrets",
  (() => { const p = fs.readFileSync(__dirname + "/../site/portal.html", "utf8"); return !/ADMIN_KEY|API_KEY|AIza|sk-ant|xai-/.test(p); })(),
  "possible secret in portal.html"
);
checkTrue(
  "still zero npm dependencies",
  !fs.existsSync(__dirname + "/../server/node_modules") &&
    !JSON.parse(fs.readFileSync(__dirname + "/../package.json", "utf8")).dependencies,
  "a dependency crept in"
);
checkTrue(
  "privacy pages no longer claim 'no servers, no data ever'",
  !fs.readFileSync(__dirname + "/../PRIVACY.md", "utf8").includes("no servers") &&
    !fs.readFileSync(__dirname + "/../site/privacy.html", "utf8").includes("no servers"),
  "outdated no-servers claim still present"
);

console.log(`\n${fail === 0 ? "🎉" : "💥"} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
