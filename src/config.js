// config.js — loads .env from the current project directory (no npm dependency,
// just a tiny parser so this works with zero `npm install` on a fresh Termux box).

const fs = require("fs");
const path = require("path");

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadConfig(cwd) {
  // Credentials are global (~/.rin-cli.env) by design, NOT read from whatever
  // project folder you happen to be standing in — that's what makes `rin`
  // work identically from any directory, on any machine, once that one file
  // is filled in. A project's own .env is still checked as a fallback, so
  // GROQ_API_KEY etc. get picked up automatically if you haven't set up the
  // global file yet, but the global one always wins when both exist.
  const home = process.env.HOME || process.env.PREFIX || "/root";
  const globalEnv = parseEnvFile(path.join(home, ".rin-cli.env"));
  const projectEnv = parseEnvFile(path.join(cwd, ".env"));

  const merged = { ...projectEnv, ...globalEnv, ...process.env };

  const supabaseUrl =
    merged.SUPABASE_URL || merged.VITE_SUPABASE_URL || merged.SUPABASE_PROJECT_URL;

  return {
    supabaseUrl,
    supabaseAnonKey:
      merged.SUPABASE_ANON_KEY || merged.VITE_SUPABASE_PUBLISHABLE_KEY || merged.VITE_SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: merged.SUPABASE_SERVICE_ROLE_KEY,
    rinUserEmail: merged.RIN_USER_EMAIL || "nekocopytrader@gmail.com",
    rinUserId: merged.RIN_USER_ID,

    geminiApiKey: merged.GEMINI_API_KEY,
    groqApiKey: merged.GROQ_API_KEY,
    openrouterApiKey: merged.OPENROUTER_API_KEY,

    defaultModel: merged.RIN_CLI_DEFAULT_MODEL || "gemini",
    maxSteps: parseInt(merged.RIN_CLI_MAX_STEPS || "150", 10),
  };
}

module.exports = { loadConfig, parseEnvFile };
