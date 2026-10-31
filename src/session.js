// session.js — per-project session persistence, so a task survives closing
// Termux, losing connectivity, or the app getting killed mid-run, instead of
// losing all progress and having to start over.
//
// Each run gets its own short id (like a git short hash) and its own file,
// instead of one slot per directory — so starting a second task doesn't
// silently erase the checkpoint of a first one you never got back to, and
// `rin --resume` can show you a real list to pick from, the way `claude
// --resume` does, rather than guessing which one you meant.
//
// Stored globally (~/.rin-cli-sessions/<project-hash>/<session-id>.json) —
// same reasoning as credentials living in ~/.rin-cli.env instead of a
// project .env: nothing ends up inside a folder that might get committed or
// shared, and it works the same regardless of which directory you're
// standing in when you resume.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function rootDir() {
  const home = process.env.HOME || process.env.PREFIX || "/root";
  const dir = path.join(home, ".rin-cli-sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectSessionDir(projectDir) {
  const hash = crypto.createHash("md5").update(path.resolve(projectDir)).digest("hex").slice(0, 16);
  const dir = path.join(rootDir(), hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Short, typeable, git-short-hash-style id — not a full UUID, since the
// person has to actually read and type this to pick a session.
function newSessionId() {
  return crypto.randomBytes(4).toString("hex");
}

function sessionFilePath(projectDir, sessionId) {
  return path.join(projectSessionDir(projectDir), `${sessionId}.json`);
}

// Called after every single completed step of the agent loop (not just at
// the end), since the process can be killed at any moment — a resume should
// pick up from the last *completed* step, re-doing at most the one step
// that was in flight when it died.
function saveSession(projectDir, sessionId, data) {
  try {
    fs.writeFileSync(
      sessionFilePath(projectDir, sessionId),
      JSON.stringify(
        {
          id: sessionId,
          projectDir: path.resolve(projectDir),
          updatedAt: new Date().toISOString(),
          ...data,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    // Non-fatal — losing a checkpoint write shouldn't crash an otherwise-working run.
  }
}

function loadSession(projectDir, sessionId) {
  try {
    const p = sessionFilePath(projectDir, sessionId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// All saved sessions for this directory, most recently updated first —
// what `rin --resume` / `/resume` show you to pick from.
function listSessions(projectDir) {
  try {
    const dir = projectSessionDir(projectDir);
    const sessions = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return sessions;
  } catch {
    return [];
  }
}

// What `rin --continue` / `/continue` use — skip the picker, just go.
function latestSession(projectDir) {
  return listSessions(projectDir)[0] || null;
}

function clearSession(projectDir, sessionId) {
  try {
    const p = sessionFilePath(projectDir, sessionId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveSession, loadSession, listSessions, latestSession, clearSession, newSessionId };
