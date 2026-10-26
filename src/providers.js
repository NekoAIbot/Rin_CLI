// providers.js — one unified chat() function on top of several backends.
// Each provider is a small adapter: given a plain {role, content} message array,
// return assistant text. Adding a new free-tier source (NVIDIA NIM, Nous Research,
// Together AI, etc.) means adding one more entry to PROVIDERS below — nothing else
// in the CLI has to change.

// Gemini renames/retires model ids more often than the code gets updated, so
// rather than hardcode one and have it 404 again later, ask Gemini itself
// what's currently available and pick a "flash" tier model, caching for the
// life of this process.
let _cachedGeminiModel = null;
async function resolveGeminiModel(apiKey) {
  if (_cachedGeminiModel) return _cachedGeminiModel;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!res.ok) {
    // If discovery itself fails, fall back to a reasonable guess rather than
    // hard-erroring before we've even tried a real call.
    return "gemini-flash-latest";
  }
  const data = await res.json();
  const candidates = (data.models || []).filter(
    (m) =>
      m.supportedGenerationMethods?.includes("generateContent") &&
      /flash/i.test(m.name) &&
      !/vision|embed/i.test(m.name)
  );
  const picked = candidates[0]?.name?.replace("models/", "") || "gemini-flash-latest";
  _cachedGeminiModel = picked;
  return picked;
}

async function callGemini(messages, { apiKey, model }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  if (!model) model = await resolveGeminiModel(apiKey);
  // Gemini wants a different message shape: system prompt separate, turns as
  // {role: "user"|"model", parts: [{text}]}
  const sys = messages.find((m) => m.role === "system");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: turns,
    ...(sys ? { systemInstruction: { parts: [{ text: sys.content }] } } : {}),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("Gemini returned no text (possibly blocked or empty candidates)");
  return text;
}

// Groq and OpenRouter both speak the OpenAI chat-completions shape, so one
// function handles both — just a different base URL / key / default model.
async function callOpenAIStyle(messages, { apiKey, model, baseUrl, label }) {
  if (!apiKey) throw new Error(`${label} API key not set`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${label} ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error(`${label} returned no content`);
  return text;
}

// Registry of everything the CLI knows how to talk to. `tier: "free"` ones are
// what the automatic fallback chain uses; `tier: "paid"` ones only run when
// explicitly chosen via /model, since they cost real money per token.
// Same problem as Gemini's model id: OpenRouter's free-tier slugs rotate as
// models get moved to paid-only, so ask OpenRouter live which ones are
// actually free right now (pricing.prompt === "0") instead of hardcoding one.
let _cachedFreeOpenRouterModel = null;
async function resolveFreeOpenRouterModel(apiKey) {
  if (_cachedFreeOpenRouterModel) return _cachedFreeOpenRouterModel;
  if (!apiKey) throw new Error("OpenRouter API key not set");
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter model list failed: ${res.status}`);
  const data = await res.json();
  const free = (data.data || []).filter(
    (m) => m.pricing?.prompt === "0" && m.pricing?.completion === "0"
  );
  if (!free.length) throw new Error("No free OpenRouter models currently available");
  // Prefer a reasonably capable, well-known family if present; otherwise take
  // whatever's first.
  const preferred =
    free.find((m) => /llama|mistral|gemini|qwen/i.test(m.id)) || free[0];
  _cachedFreeOpenRouterModel = preferred.id;
  return preferred.id;
}

const PROVIDERS = {
  gemini: {
    label: "Gemini",
    tier: "free",
    run: (messages, cfg) => callGemini(messages, { apiKey: cfg.geminiApiKey }),
  },
  groq: {
    label: "Groq",
    tier: "free",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.groqApiKey,
        model: "llama-3.3-70b-versatile",
        baseUrl: "https://api.groq.com/openai/v1",
        label: "Groq",
      }),
  },
  openrouter: {
    label: "OpenRouter (free pool)",
    tier: "free",
    run: async (messages, cfg) => {
      const model = await resolveFreeOpenRouterModel(cfg.openrouterApiKey);
      return callOpenAIStyle(messages, {
        apiKey: cfg.openrouterApiKey,
        model,
        baseUrl: "https://openrouter.ai/api/v1",
        label: "OpenRouter",
      });
    },
  },
  "claude-opus": {
    label: "Claude Opus (via OpenRouter, paid)",
    tier: "paid",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.openrouterApiKey,
        model: "anthropic/claude-opus-4.5",
        baseUrl: "https://openrouter.ai/api/v1",
        label: "OpenRouter/Claude",
      }),
  },
  "gpt-5": {
    label: "GPT-5 (via OpenRouter, paid)",
    tier: "paid",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.openrouterApiKey,
        model: "openai/gpt-5",
        baseUrl: "https://openrouter.ai/api/v1",
        label: "OpenRouter/GPT-5",
      }),
  },
};

const FALLBACK_ORDER = ["gemini", "groq", "openrouter"];

// chat(): if `preferredModel` is set (via /model), use only that one.
// Otherwise walk the free fallback chain until one succeeds.
async function chat(messages, cfg, preferredModel) {
  if (preferredModel) {
    const p = PROVIDERS[preferredModel];
    if (!p) throw new Error(`Unknown model "${preferredModel}". Try /model to see the list.`);
    return { text: await p.run(messages, cfg), usedModel: preferredModel };
  }

  const errors = [];
  for (const key of FALLBACK_ORDER) {
    try {
      const text = await PROVIDERS[key].run(messages, cfg);
      return { text, usedModel: key };
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  throw new Error("All free providers failed:\n" + errors.join("\n"));
}

function listModels() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    label: p.label,
    tier: p.tier,
  }));
}

module.exports = { chat, listModels, PROVIDERS, FALLBACK_ORDER };
