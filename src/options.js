// Roody settings — everything you can turn on, off, change, or wipe.
// Every control auto-saves; there is no Save button.

const $ = (id) => document.getElementById(id);

const gkeyEl = $("gkey");
const voiceEl = $("voice");
const langEl = $("lang");
const earsEl = $("ears");
const vibeEl = $("vibe");
const chimeEl = $("autochime");
const hintsEl = $("typinghints");
const enabledEl = $("enabled");
const profileEl = $("profile");
const profileCountEl = $("profilecount");
const memoryBoxEl = $("memorybox");
const inviteEl = $("invitecode");

const VIBE_PREVIEWS = {
  normal: "Just Roody — warm, witty, no interruptions.",
  minion: "Roody: \"The bug is on line 12—\" *Minion grabs keyboard* \"BANANA!! Bello! Dis code... why no work?! Bee-do bee-do!\"",
  roadrunner: "Roody: \"That function needs a—\" *MEEP MEEP!* Road Runner zooms past, fixes the typo, vanishes in a dust cloud.",
  coyote: "Roody: \"Let me check that logic—\" Coyote: \"AH HA! I have a GENIUS plan!\" *draws elaborate blueprint* *it explodes*",
  pinkpanther: "Roody: \"There's an issue here—\" *smooth jazz plays* Pink Panther slides in, inspects the code with a magnifying glass, raises one eyebrow.",
  woody: "Roody: \"That variable is undefined—\" Woody: \"Now listen here, partner. There's a SNAKE in that function! Round it up!\"",
  rapunzel: "Roody: \"The API returned an error—\" Rapunzel: \"Oh! I've never seen an error like THIS before! This is the best day EVER! Let's fix it together!\"",
  snowwhite: "Roody: \"This code needs cleanup—\" Snow White: *sings* \"Whistle while you work!\" *birds fly in and refactor the variables*",
  tom: "Roody: \"Watch out for that null—\" Tom: *runs full speed into the null pointer* *crashes through wall* *flattened like a pancake* *shakes it off*",
  jerry: "Roody: \"The bug is hiding in—\" Jerry: *already found it* *waves tiny flag* *does victory dance on the keyboard*",
};

function showKeyStatus(el, hasIt) {
  el.textContent = hasIt ? "✓ Saved on this computer" : "Not set";
  el.classList.toggle("has", hasIt);
}

// Load everything saved.
let savedProxyUrl = "";
chrome.storage.local
  .get([
    "roodyGeminiKey", "roodyVoice", "roodyLang", "roodyVibe", "roodyEnabled",
    "roodyAutoChime", "roodyTypingHints", "roodyProfile", "roodyInviteCode", "roodyProxyUrl", "roodyEars",
  ])
  .then((s) => {
    if (s.roodyGeminiKey) gkeyEl.value = s.roodyGeminiKey;
    if (s.roodyLang) langEl.value = s.roodyLang;
    earsEl.value = s.roodyEars === "accurate" ? "accurate" : "browser";
    if (s.roodyVibe) vibeEl.value = s.roodyVibe;
    $("vibepreview").textContent = VIBE_PREVIEWS[vibeEl.value] || "";
    // Roody is female-voice-only now; if a previously saved male voice (Puck,
    // Charon, etc.) is in storage, snap it back to the default Kore.
    const validFemale = new Set(["Kore","Aoede","Leda","Zephyr","Callirrhoe","Autonoe","Despina","Erinome","Laomedeia","Achernar","Vindemiatrix","Sulafat"]);
    voiceEl.value = s.roodyVoice && validFemale.has(s.roodyVoice) ? s.roodyVoice : "Kore";
    if (s.roodyVoice && !validFemale.has(s.roodyVoice)) {
      chrome.storage.local.set({ roodyVoice: "Kore" }); // persist the snap-back
    }
    chimeEl.checked = s.roodyAutoChime === true; // off by default
    hintsEl.checked = s.roodyTypingHints !== false; // on by default
    enabledEl.checked = s.roodyEnabled !== false;
    showKeyStatus($("gstatus"), !!s.roodyGeminiKey);
    if (s.roodyProfile) profileEl.value = s.roodyProfile;
    profileCountEl.textContent = (profileEl.value || "").length;
    if (s.roodyInviteCode) inviteEl.value = s.roodyInviteCode;
    savedProxyUrl = s.roodyProxyUrl || "";
    showKeyStatus($("invitestatus"), !!s.roodyInviteCode);
    showUsage(); // values just arrived — paint the usage bar now
  });

// Keep in sync with ROODY_PROXY_URL in background.js.
const DEFAULT_PROXY = "https://midnightblue-wolf-859857.hostingersite.com/";

// User usage dashboard — "You've used 12 of 50 free messages today".
async function showUsage() {
  const code = (inviteEl.value || "").trim();
  const box = $("usagebox");
  if (!code) { box.style.display = "none"; return; }
  try {
    const base = (savedProxyUrl.trim() || DEFAULT_PROXY).replace(/\/+$/, "");
    const r = await fetch(`${base}/me?code=${encodeURIComponent(code)}`);
    const me = await r.json();
    if (!me.ok) {
      box.style.display = "block";
      $("usagehello").textContent = "⚠ This code isn't active";
      $("usagefill").style.width = "0%";
      $("usagetext").textContent = "Check the code, or ask the Roody team for a fresh one.";
      return;
    }
    box.style.display = "block";
    $("usagehello").textContent = me.name ? `Hi ${me.name}! 🟠` : "Your Roody plan 🟠";
    const pct = Math.min(100, Math.round((me.used / me.limit) * 100));
    $("usagefill").style.width = pct + "%";
    $("usagetext").textContent =
      `${me.used} of ${me.limit} free messages used today · refills at midnight UTC · ${me.allTime.toLocaleString()} messages all-time`;
  } catch (_) {
    box.style.display = "none"; // offline / proxy unreachable — stay quiet
  }
}
showUsage();
setInterval(showUsage, 20000);
inviteEl.addEventListener("blur", () => setTimeout(showUsage, 300));

// Auto-save keys the moment the user tabs/clicks away from the field. Most
// people paste a key and expect it to be saved — requiring an extra "Save"
// click is a foot-gun that caused real "voice still robotic" reports.
function autoSaveKey(input, storageKey, statusEl) {
  let lastSaved = input.value.trim();
  input.addEventListener("blur", () => {
    const v = input.value.trim();
    if (v === lastSaved) return;
    lastSaved = v;
    chrome.storage.local.set({ [storageKey]: v });
    showKeyStatus(statusEl, !!v);
    statusEl.textContent = v ? "✓ Saved" : "Not set";
    statusEl.classList.toggle("has", !!v);
    setTimeout(() => showKeyStatus(statusEl, !!v), 1200);
  });
}
autoSaveKey(inviteEl, "roodyInviteCode", $("invitestatus"));
autoSaveKey(gkeyEl, "roodyGeminiKey", $("gstatus"));

$("clearinvite").addEventListener("click", () => {
  if (!confirm("Remove the invite code?")) return;
  inviteEl.value = "";
  chrome.storage.local.set({ roodyInviteCode: "" });
  showKeyStatus($("invitestatus"), false);
});
$("clearg").addEventListener("click", () => {
  if (!confirm("Remove the Gemini key from this browser?")) return;
  gkeyEl.value = "";
  chrome.storage.local.set({ roodyGeminiKey: "" });
  showKeyStatus($("gstatus"), false);
});

// Auto-save profile as user types (debounced 400ms)
let profileSaveTimer = null;
profileEl.addEventListener("input", () => {
  profileCountEl.textContent = profileEl.value.length;
  clearTimeout(profileSaveTimer);
  profileSaveTimer = setTimeout(() => {
    chrome.storage.local.set({ roodyProfile: profileEl.value.trim() });
  }, 400);
});

// Render Roody's notebook memory
function renderMemory() {
  chrome.storage.local.get(["roodyMemory", "roodyTalkCount"]).then(({ roodyMemory, roodyTalkCount }) => {
    const tc = roodyTalkCount || 0;
    $("talkstats").textContent = tc > 0
      ? `🧡 You & Roody: ${tc.toLocaleString()} conversation${tc === 1 ? "" : "s"} together`
      : "";
    const mem = Array.isArray(roodyMemory) ? roodyMemory : [];
    if (mem.length === 0) {
      memoryBoxEl.innerHTML = "<em style='color:#97836d'>Empty — Roody will start remembering pages when you talk to it.</em>";
      return;
    }
    memoryBoxEl.innerHTML = mem.slice().reverse().map((m) => {
      const when = m.ts ? new Date(m.ts).toLocaleString() : "";
      // A session recap reads like a diary line — show it instead of the raw
      // page snippet when we have one.
      const gist = m.summary
        ? `<div style="color:#33261a;font-size:12.5px;margin-top:2px">💬 ${escapeHtml(m.summary)}</div>`
        : `<div style="color:#6b4a2b;font-size:12px;margin-top:2px">${escapeHtml((m.snippet || "").slice(0, 150))}</div>`;
      return `<div style="padding:6px 0;border-bottom:1px solid #f0e2cf">
        <div style="font-weight:600">${escapeHtml(m.site)} · <span style="color:#97836d;font-weight:400">${escapeHtml((m.title || "").slice(0, 60))}</span></div>
        ${gist}
        <div style="color:#a89880;font-size:11px;margin-top:2px">${when}</div>
      </div>`;
    }).join("");
  });
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
renderMemory();
setInterval(renderMemory, 3000); // refresh live

$("clearmem").addEventListener("click", async () => {
  if (!confirm("Erase Roody's memory of your time together (pages + conversation count)?")) return;
  await chrome.storage.local.set({ roodyMemory: [], roodyTalkCount: 0 });
  renderMemory();
});

// The "what Roody has learned about you" note — visible and erasable.
function renderLearned() {
  chrome.storage.local.get(["roodyLearned"]).then(({ roodyLearned }) => {
    const box = $("learnedbox");
    box.textContent = (roodyLearned || "").trim() ||
      "";
    if (!box.textContent) {
      box.innerHTML = "<em style='color:#97836d'>Nothing yet — Roody learns a little after each conversation.</em>";
    }
  });
}
renderLearned();
setInterval(renderLearned, 5000);
$("clearlearned").addEventListener("click", async () => {
  if (!confirm("Forget everything Roody has learned about you?")) return;
  await chrome.storage.local.set({ roodyLearned: "", roodyLearnedTs: 0 });
  renderLearned();
});

// Live vibe preview + auto-save
vibeEl.addEventListener("change", () => {
  $("vibepreview").textContent = VIBE_PREVIEWS[vibeEl.value] || "";
  chrome.storage.local.set({ roodyVibe: vibeEl.value });
});

// Auto-save all dropdowns and switches on change.
voiceEl.addEventListener("change", () => chrome.storage.local.set({ roodyVoice: voiceEl.value }));
langEl.addEventListener("change", () => chrome.storage.local.set({ roodyLang: langEl.value }));
earsEl.addEventListener("change", () => chrome.storage.local.set({ roodyEars: earsEl.value }));
chimeEl.addEventListener("change", () => chrome.storage.local.set({ roodyAutoChime: chimeEl.checked }));
hintsEl.addEventListener("change", () => chrome.storage.local.set({ roodyTypingHints: hintsEl.checked }));
enabledEl.addEventListener("change", () => chrome.storage.local.set({ roodyEnabled: enabledEl.checked }));
