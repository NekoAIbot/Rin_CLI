// providers.js — one unified chat() function on top of several backends.
// Each provider is a small adapter: given a plain {role, content} message array,
// return assistant text. Adding a new free-tier source (NVIDIA NIM, Nous Research,
// Together AI, etc.) means adding one more entry to PROVIDERS below — nothing else
// in the CLI has to change.

const fs = require("fs");
const path = require("path");

// Disk cache for resolved model ids, so a fresh `rin` session doesn't pay the
// model-discovery round-trip (one extra HTTP call per provider) every single
// time — this is the single biggest real latency win available, since the
// discovery calls were adding a full network round-trip before the actual
// request even started. TTL means a vendor renaming a model again is caught
// within a few hours, not frozen forever.
const CACHE_PATH = path.join(
  process.env.HOME || process.env.PREFIX || "/root",
  ".rin-cli-model-cache.json"
);
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function readDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return raw;
  } catch {
    return {};
  }
}
function writeDiskCache(data) {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data), "utf8");
  } catch {
    // Non-fatal — caching is a speed optimization, not a correctness
    // requirement, so a write failure (e.g. read-only fs) is silently fine.
  }
}
function getCached(key) {
  const cache = readDiskCache();
  const entry = cache[key];
  if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value;
  return null;
}
function setCached(key, value) {
  const cache = readDiskCache();
  cache[key] = { value, at: Date.now() };
  writeDiskCache(cache);
}

// Gemini renames/retires model ids more often than the code gets updated, so
// rather than hardcode one and have it 404 again later, ask Gemini itself
// what's currently available and pick a "flash" tier model, caching for the
// life of this process.
let _cachedGeminiModel = null;
const _geminiBlacklist = new Set();
function extractVersion(name) {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}
async function resolveGeminiModel(apiKey) {
  if (_cachedGeminiModel && !_geminiBlacklist.has(_cachedGeminiModel)) return _cachedGeminiModel;
  const disk = getCached("gemini");
  if (disk && !_geminiBlacklist.has(disk)) {
    _cachedGeminiModel = disk;
    return disk;
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!res.ok) {
    return "gemini-flash-latest";
  }
  const data = await res.json();
  const candidates = (data.models || []).filter(
    (m) =>
      m.supportedGenerationMethods?.includes("generateContent") &&
      /flash/i.test(m.name) &&
      !/vision|embed|preview|exp/i.test(m.name) &&
      !_geminiBlacklist.has(m.name.replace("models/", ""))
  );
  // Google's own model list can still include retired-for-new-accounts
  // entries alongside current ones — sort for the highest version number
  // rather than trusting list order, since "first in the list" kept landing
  // on deprecated ones.
  candidates.sort((a, b) => extractVersion(b.name) - extractVersion(a.name));
  const picked = candidates[0]?.name?.replace("models/", "") || "gemini-flash-latest";
  _cachedGeminiModel = picked;
  setCached("gemini", picked);
  return picked;
}

async function callGemini(messages, { apiKey, model }, _retrying = false) {
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
    // Forces strict JSON output instead of relying on the model to follow
    // formatting instructions on its own — directly fixes the malformed-JSON
    // retry we actually hit in testing, and saves a full extra round-trip
    // every time that would otherwise happen.
    generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 404 && !_retrying) {
      // This specific model turned out to be retired despite passing
      // discovery — blacklist it (and evict it from the disk cache, so a
      // future session doesn't resurrect the same dead model) and try the
      // next-best candidate once.
      _geminiBlacklist.add(model);
      const disk = readDiskCache();
      if (disk.gemini?.value === model) {
        delete disk.gemini;
        writeDiskCache(disk);
      }
      return callGemini(messages, { apiKey }, true);
    }
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  if (!text) throw new Error("Gemini returned no text (possibly blocked or empty candidates)");
  return text;
}

// Groq and OpenRouter both speak the OpenAI chat-completions shape, so one
// function handles both — just a different base URL / key / default model.
async function callOpenAIStyle(messages, { apiKey, model, baseUrl, label }, _noJsonMode = false) {
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
      temperature: 0.3,
      // Most OpenAI-compatible backends honor this and stop the model
      // wrapping JSON in prose/markdown fences — but not every free/open
      // model behind Groq or OpenRouter supports it, so on a 400 we retry
      // once without it rather than hard-failing a model that's otherwise fine.
      ...(_noJsonMode ? {} : { response_format: { type: "json_object" } }),
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 400 && !_noJsonMode) {
      return callOpenAIStyle(messages, { apiKey, model, baseUrl, label }, true);
    }
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
  const disk = getCached("openrouter");
  if (disk) {
    _cachedFreeOpenRouterModel = disk;
    return disk;
  }
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
  setCached("openrouter", preferred.id);
  return preferred.id;
}

// Same deal as Gemini/OpenRouter — Groq retires/renames model ids too
// (llama-3.3-70b-versatile stopped existing between when this was written
// and when it was actually run). Ask Groq live instead of hardcoding.
let _cachedGroqModel = null;
async function resolveGroqModel(apiKey) {
  if (_cachedGroqModel) return _cachedGroqModel;
  const disk = getCached("groq");
  if (disk) {
    _cachedGroqModel = disk;
    return disk;
  }
  if (!apiKey) throw new Error("Groq API key not set");
  const res = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Groq model list failed: ${res.status}`);
  const data = await res.json();
  const models = data.data || [];
  const preferred =
    models.find((m) => /70b|versatile/i.test(m.id)) ||
    models.find((m) => /8b|instant/i.test(m.id)) ||
    models[0];
  if (!preferred) throw new Error("No Groq models available");
  _cachedGroqModel = preferred.id;
  setCached("groq", preferred.id);
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
    run: async (messages, cfg) => {
      const model = await resolveGroqModel(cfg.groqApiKey);
      return callOpenAIStyle(messages, {
        apiKey: cfg.groqApiKey,
        model,
        baseUrl: "https://api.groq.com/openai/v1",
        label: "Groq",
      });
    },
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
  nvidia: {
    // No credit card, 40 req/min, NO daily cap — verified against
    // freellm.net before adding. This is the best "almost unlimited free"
    // option in the chain, so it's placed early in the fallback order.
    label: "NVIDIA NIM",
    tier: "free",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.nvidiaApiKey,
        model: "meta/llama-3.3-70b-instruct",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        label: "NVIDIA NIM",
      }),
  },
  mistral: {
    label: "Mistral AI",
    tier: "free",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.mistralApiKey,
        model: "mistral-small-latest",
        baseUrl: "https://api.mistral.ai/v1",
        label: "Mistral",
      }),
  },
  nous: {
    // Real and OpenAI-compatible, but may require card verification at
    // signup and starts with $5 in credits rather than being unlimited — so
    // this is selectable via /model, not silently in the automatic chain.
    label: "Nous Portal (Hermes 3 70B — may need signup/card verification)",
    tier: "free",
    run: (messages, cfg) =>
      callOpenAIStyle(messages, {
        apiKey: cfg.nousApiKey,
        model: "Hermes-3-Llama-3.1-70B",
        baseUrl: "https://inference-api.nousresearch.com/v1",
        label: "Nous Portal",
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

// NVIDIA NIM goes right after the two fastest/most reliable ones since it has
// no daily cap at all (just a 40 req/min ceiling) — OpenRouter moves to last
// since its free pool has a hard 50-requests/day wall we've already hit once.
// Nous isn't in the auto chain (signup friction), so /model nous is required.
const FALLBACK_ORDER = ["gemini", "groq", "nvidia", "mistral", "openrouter"];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Node's fetch throws a bare "fetch failed" for a network-level failure — the
// request never reached the server at all. That is different from a provider
// responding with an HTTP error (429, 503, etc.), which means the network is
// fine. On Termux in particular, Android can quietly suspend network access
// for a backgrounded app for a few seconds even with termux-wake-lock held
// (that only keeps the CPU awake, not the radio/socket) — so a "fetch
// failed" is usually a transient blip worth retrying briefly, rather than a
// real reason to give up on that provider.
function isTransientNetworkError(err) {
  return /fetch failed/i.test(err.message);
}

async function runWithRetry(fn, { retries = 2, delayMs = 1500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientNetworkError(err)) {
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// chat(): three ways to call it —
//   preferredModel is a string   -> use exactly that one provider (explicit /model choice)
//   preferredModel is an array   -> walk that specific ordered chain until one succeeds
//                                    (this is how the Planner/Executor role chains work —
//                                    see cfg.plannerModels / cfg.executorModels in agent.js)
//   preferredModel is omitted    -> walk the default free fallback chain
async function chat(messages, cfg, preferredModel) {
  const t0 = Date.now();

  if (typeof preferredModel === "string") {
    const p = PROVIDERS[preferredModel];
    if (!p) throw new Error(`Unknown model "${preferredModel}". Try /model to see the list.`);
    const text = await runWithRetry(() => p.run(messages, cfg));
    return { text, usedModel: preferredModel, ms: Date.now() - t0 };
  }

  const order = Array.isArray(preferredModel) && preferredModel.length ? preferredModel : FALLBACK_ORDER;
  const errors = [];
  for (const key of order) {
    const p = PROVIDERS[key];
    if (!p) {
      errors.push(`${key}: unknown model (check RIN_CLI_PLANNER_MODELS / RIN_CLI_EXECUTOR_MODELS)`);
      continue;
    }
    try {
      const text = await runWithRetry(() => p.run(messages, cfg));
      return { text, usedModel: key, ms: Date.now() - t0 };
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  throw new Error(`All providers in chain [${order.join(", ")}] failed:\n` + errors.join("\n"));
}

function listModels() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({
    key,
    label: p.label,
    tier: p.tier,
  }));
}

module.exports = { chat, listModels, PROVIDERS, FALLBACK_ORDER };
