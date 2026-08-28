// Model discovery. Asks each provider what models the user's key can actually
// use, then picks the newest flagship. This is why Roody doesn't need a
// hardcoded version: when the provider ships a new model, the next refresh
// picks it up on its own.
//
// Shared by options.js (refresh on key paste / button) and background.js
// (fallback refresh when nothing is cached yet). Zero dependencies.
(function (root) {
  // Last-resort defaults if a provider's list endpoint is unreachable or the
  // key can't list models. Deliberately conservative — a stable older model
  // beats erroring out.
  const FALLBACK_MODELS = {
    claude: "claude-sonnet-4-5",
    openai: "gpt-4o",
    gemini: "gemini-2.5-flash",
    grok: "grok-3",
  };

  // Models we never want to auto-select even if the API lists them: embeddings,
  // audio/image/video, moderation, search/realtime variants, and dated
  // snapshots (we prefer the rolling alias, e.g. "gpt-5" over "gpt-5-2026-03-01").
  const EXCLUDE = /(embed|whisper|tts|audio|speech|image|vision-preview|dall|moderation|rerank|search|realtime|transcribe|guard|nano)/i;
  const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{8}$/;

  // Pull the numeric version out of a model id so we can sort newest-first.
  // "gpt-5.6-turbo" -> 5.6 ; "claude-sonnet-4-5" -> 4.5 ; "gemini-2.5-pro" -> 2.5
  function versionOf(id) {
    // Strip a dated snapshot suffix first — otherwise "gpt-5-2026-03-01" reads
    // as version 2026.03 and beats every real model.
    id = id.replace(DATED_SNAPSHOT, "");
    // Anthropic style: name-<major>-<minor>  (claude-sonnet-4-5 => 4.5)
    const dashed = /-(\d+)-(\d+)(?:$|-)/.exec(id);
    if (dashed) return parseFloat(`${dashed[1]}.${dashed[2]}`);
    // Dotted style: gpt-5.6, gemini-2.5-pro
    const dotted = /(\d+)\.(\d+)/.exec(id);
    if (dotted) return parseFloat(`${dotted[1]}.${dotted[2]}`);
    // Bare integer: gpt-5, grok-3
    const bare = /(?:^|[^\d.])(\d+)(?:$|[^\d.])/.exec(id);
    if (bare) return parseFloat(bare[1]);
    return 0;
  }

  // Rank a model within its family. Higher = preferred. We want the strongest
  // *general* model, so full-size beats mini/lite, and newer beats older.
  function scoreModel(id) {
    const lower = id.toLowerCase();
    let score = versionOf(lower) * 100;
    // Prefer full-size over the cheap tiers, but still allow them if that's
    // all the key has.
    if (/(mini|lite|flash-8b|haiku|small|tiny)/.test(lower)) score -= 30;
    if (/(opus|pro|ultra|large)/.test(lower)) score += 10;
    // Slightly prefer a rolling alias over a dated snapshot of the same model.
    if (DATED_SNAPSHOT.test(lower)) score -= 5;
    // Preview/experimental builds are riskier as a default.
    if (/(preview|exp|experimental|alpha|beta|rc)/.test(lower)) score -= 20;
    return score;
  }

  function pickBest(ids, familyRe) {
    const candidates = ids
      .filter((id) => familyRe.test(id))
      .filter((id) => !EXCLUDE.test(id));
    if (!candidates.length) return null;
    candidates.sort((a, b) => scoreModel(b) - scoreModel(a));
    return candidates[0];
  }

  // ---- Per-provider listing -----------------------------------------------
  // Each returns the chosen model id, or null if we couldn't determine one.
  async function listOpenAI(key) {
    const r = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    // Chat-capable families only — o-series and gpt-*, never the embedding or
    // audio SKUs (EXCLUDE handles those).
    return pickBest(ids, /^(gpt-|o[1-9])/i);
  }

  async function listAnthropic(key) {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    return pickBest(ids, /^claude-/i);
  }

  async function listGemini(key) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
      headers: { "x-goog-api-key": key },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    // Names come back as "models/gemini-2.5-flash" — strip the prefix. Only
    // keep ones that actually support generateContent.
    const ids = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""));
    return pickBest(ids, /^gemini-/i);
  }

  async function listXai(key) {
    // xAI is OpenAI-compatible, including /v1/models.
    const r = await fetch("https://api.x.ai/v1/models", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id);
    return pickBest(ids, /^grok-/i);
  }

  const LISTERS = {
    openai: listOpenAI,
    claude: listAnthropic,
    gemini: listGemini,
    grok: listXai,
  };

  // Storage key holding the auto-discovered model for a provider.
  const STORAGE_KEY = {
    openai: "roodyOpenAIModel",
    claude: "roodyClaudeModel",
    gemini: "roodyGeminiModel",
    grok: "roodyGrokModel",
  };

  // Discover + cache the best model for one provider. Returns
  // { ok, model, error }. Never throws.
  async function refreshProvider(provider, key) {
    if (!key) return { ok: false, error: "no key" };
    const lister = LISTERS[provider];
    if (!lister) return { ok: false, error: "unknown provider" };
    try {
      const model = await lister(key);
      if (!model) return { ok: false, error: "no usable model in list" };
      await chrome.storage.local.set({ [STORAGE_KEY[provider]]: model });
      return { ok: true, model };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // The model to actually use for a provider: whatever we discovered, else the
  // conservative fallback.
  async function modelFor(provider) {
    try {
      const k = STORAGE_KEY[provider];
      const got = await chrome.storage.local.get([k]);
      const cached = (got[k] || "").trim();
      if (cached) return cached;
    } catch (_) {}
    return FALLBACK_MODELS[provider] || FALLBACK_MODELS.gemini;
  }

  root.RoodyModels = {
    FALLBACK_MODELS,
    STORAGE_KEY,
    versionOf,
    scoreModel,
    pickBest,
    refreshProvider,
    modelFor,
  };
})(typeof self !== "undefined" ? self : this);
