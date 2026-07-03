// Roody credits proxy — Supabase Edge Function.
// The founder's Gemini API key lives HERE (as a secret), never in the
// extension. The extension sends { code, kind, model, body }; we validate the
// invite code, count credits for brain calls, and forward to Gemini.
//
// Deploy:  supabase functions deploy roody-proxy --no-verify-jwt
// Secret:  supabase secrets set GEMINI_API_KEY=AIza...

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Only the models Roody actually uses — nobody turns your key into a free
// general-purpose Gemini endpoint.
const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash",
  "gemini-2.5-flash-preview-tts",
]);

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let payload: { code?: string; kind?: string; model?: string; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "bad-json" }, 400);
  }
  const { code, kind, model, body } = payload;
  if (!code || !model || !body) return json({ error: "missing-fields" }, 400);
  if (!ALLOWED_MODELS.has(model)) return json({ error: "model-not-allowed" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Brain calls burn a credit; TTS/STT ride along on a validated code.
  if (kind === "brain") {
    const { data, error } = await supabase.rpc("use_credit", { p_code: code });
    if (error) return json({ error: "db", detail: error.message }, 500);
    if (!data?.ok) {
      if (data?.reason === "limit") {
        return json({ error: "out-of-credits", used: data.used, limit: data.limit }, 402);
      }
      return json({ error: "invalid-code" }, 403);
    }
  } else {
    const { data, error } = await supabase.rpc("check_code", { p_code: code });
    if (error) return json({ error: "db", detail: error.message }, 500);
    if (!data) return json({ error: "invalid-code" }, 403);
  }

  // Forward to Gemini with the founder's secret key.
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!,
      },
      body: JSON.stringify(body),
    },
  );
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...CORS, "content-type": "application/json" },
  });
});
