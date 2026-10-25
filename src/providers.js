// providers.js — one unified chat() function on top of several backends.
// Each provider is a small adapter: given a plain {role, content} message array,
// return assistant text. Adding a new free-tier source (NVIDIA NIM, Nous Research,
// Together AI, etc.) means adding one more entry to PROVIDERS below — nothing else
// in the CLI has to change.

async function callGemini(messages, { apiKey, model = "gemini-2.0-flash" }) {
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
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
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.openrouterApiKey,
        model: "meta-llama/llama-3.3-70b-instruct:free",
        baseUrl: "https://openrouter.ai/api/v1",
        label: "OpenRouter",
      }),
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
