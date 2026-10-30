// session.js — per-project session persistence, so a task survives closing
// Termux, losing connectivity, or the app getting killed mid-run, instead of
// losing all progress and having to start over. This is the "known limit"
// the README flagged from day one ("No persistence across closing the
// terminal mid-task") — now fixed.
//
// Stored globally (~/.rin-cli-sessions/), keyed by a hash of the project's
// absolute path — same reasoning as credentials living in ~/.rin-cli.env
// instead of a project .env: nothing ends up inside a folder that might get
// committed or shared, and it works the same regardless of which directory
// you're standing in when you resume.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sessionDir() {
  const home = process.env.HOME || process.env.PREFIX || "/root";
  const dir = path.join(home, ".rin-cli-sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionPath(projectDir) {
  const abs = path.resolve(projectDir);
  const hash = crypto.createHash("md5").update(abs).digest("hex").slice(0, 16);
  return path.join(sessionDir(), `${hash}.json`);
}

// Called after every single step of the agent loop (not just at the end),
// since the process can be killed at any moment — a resume should pick up
// from the last *completed* step, re-doing at most the one step that was
// in flight when it died.
function saveSession(projectDir, data) {
  try {
    const p = sessionPath(projectDir);
    fs.writeFileSync(
      p,
      JSON.stringify(
        { projectDir: path.resolve(projectDir), updatedAt: new Date().toISOString(), ...data },
        null,
        2
      ),
      "utf8"
    );
  } catch {
    // Non-fatal — losing a checkpoint write shouldn't crash an otherwise-working run.
  }
}

function loadSession(projectDir) {
  try {
    const p = sessionPath(projectDir);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function clearSession(projectDir) {
  try {
    const p = sessionPath(projectDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { saveSession, loadSession, clearSession, sessionPath };
