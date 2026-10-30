// memory.js — reads/writes Rin's existing decaying memory store (user_memory /
// user_memory_ranked in Supabase), so the CLI shares one brain with the
// Telegram companion instead of keeping its own separate memory.
//
// Uses the service_role key (RLS bypass) because the CLI runs as a trusted
// local process on your own device, not as an authenticated end-user session.
// It always filters by user_id itself, explicitly, so it only ever touches
// your own rows even though the key could technically see everyone's.

const { runWithRetry } = require("./providers");

async function sbFetch(cfg, pathAndQuery, options = {}) {
  if (!cfg.supabaseUrl) throw new Error("SUPABASE_URL not set");
  if (!cfg.supabaseServiceRoleKey)
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not set — add it to ~/.rin-cli.env (not the project .env)"
    );

  // Same transient-network-blip retry as the LLM providers get — a dropped
  // mobile connection shouldn't silently cost you the whole memory layer for
  // a run, just because the one fetch that happened to hit it was unlucky.
  const res = await runWithRetry(() =>
    fetch(`${cfg.supabaseUrl}/rest/v1/${pathAndQuery}`, {
      ...options,
      headers: {
        apikey: cfg.supabaseServiceRoleKey,
        Authorization: `Bearer ${cfg.supabaseServiceRoleKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    })
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status} on ${pathAndQuery}: ${t.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Resolves and caches the user's id from `profiles` by email, since the CLI
// only ever operates as one person (you).
async function resolveUserId(cfg) {
  if (cfg.rinUserId) return cfg.rinUserId;
  const rows = await sbFetch(
    cfg,
    `profiles?email=eq.${encodeURIComponent(cfg.rinUserEmail)}&select=id&limit=1`
  );
  if (!rows || !rows.length) {
    throw new Error(
      `No profile found for ${cfg.rinUserEmail}. Set RIN_USER_ID directly in ~/.rin-cli.env instead.`
    );
  }
  cfg.rinUserId = rows[0].id;
  return cfg.rinUserId;
}

// Pulls the most relevant, least-decayed memories for context — reads from
// the ranked view so we get effective_weight/memory_tier for free, no decay
// math duplicated here.
async function loadRelevantMemories(cfg, { limit = 20, categories = [] } = {}) {
  const userId = await resolveUserId(cfg);
  let query =
    `user_memory_ranked?user_id=eq.${userId}&is_sensitive=eq.false` +
    `&order=effective_weight.desc&limit=${limit}`;
  if (categories.length) {
    query += `&category=in.(${categories.map(encodeURIComponent).join(",")})`;
  }
  return (await sbFetch(cfg, query)) || [];
}

function formatMemoriesForPrompt(memories) {
  if (!memories.length) return "(no stored memories yet for this category)";
  return memories
    .map((m) => `- [${m.category}/${m.key}] ${m.value} (tier: ${m.memory_tier})`)
    .join("\n");
}

// Writes a fact the way the rest of Rin does: if (user_id, category, key)
// already exists, reinforce it (+0.5 weight, +1 reinforcement_count, bump
// last_reinforced_at) rather than creating a duplicate row; otherwise insert
// fresh at weight 1.0.
async function saveMemory(cfg, { category, key, value, tags = [], isPinned = false }) {
  const userId = await resolveUserId(cfg);

  const existing = await sbFetch(
    cfg,
    `user_memory?user_id=eq.${userId}&category=eq.${encodeURIComponent(
      category
    )}&key=eq.${encodeURIComponent(key)}&select=id,weight,reinforcement_count&limit=1`
  );

  if (existing && existing.length) {
    const row = existing[0];
    await sbFetch(cfg, `user_memory?id=eq.${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        value,
        weight: (row.weight || 1.0) + 0.5,
        reinforcement_count: (row.reinforcement_count || 1) + 1,
        last_reinforced_at: new Date().toISOString(),
      }),
    });
    return { action: "reinforced", id: row.id };
  }

  const created = await sbFetch(cfg, "user_memory", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      user_id: userId,
      category,
      key,
      value,
      tags,
      is_pinned: isPinned,
      source: "rin_cli",
    }),
  });
  return { action: "created", id: created?.[0]?.id };
}

module.exports = { resolveUserId, loadRelevantMemories, formatMemoriesForPrompt, saveMemory };
