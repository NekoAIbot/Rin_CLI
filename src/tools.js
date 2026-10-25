// tools.js — everything the agent loop is allowed to actually do.
// Every path-taking tool resolves against `sandboxDir` and refuses to escape it.
// run_shell also refuses a short deny-list of obviously destructive patterns.
// This is a floor, not a substitute for the sandboxing — see agent-mode-spec.md.

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const DENY_PATTERNS = [
  /\brm\s+-rf\s+\/(\s|$)/,
  /\brm\s+-rf\s+~(\s|$)/,
  /\bmkfs\./,
  /\bdd\s+if=.*of=\/dev\//,
  />\s*\/dev\/sd[a-z]/,
  /\bshutdown\b|\breboot\b/,
  /:\(\)\{.*:\|:.*\};:/, // fork bomb
];

function resolveInSandbox(sandboxDir, relPath) {
  const resolved = path.resolve(sandboxDir, relPath || ".");
  const normalizedSandbox = path.resolve(sandboxDir);
  if (resolved !== normalizedSandbox && !resolved.startsWith(normalizedSandbox + path.sep)) {
    throw new Error(`Path "${relPath}" resolves outside the sandbox directory — refused.`);
  }
  return resolved;
}

function runShell(sandboxDir, command, { timeoutMs = 60000 } = {}) {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(command)) {
      return Promise.resolve({
        ok: false,
        output: `Refused: command matched a destructive-pattern guard (${pattern}).`,
      });
    }
  }
  return new Promise((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd: sandboxDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          output: (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : ""),
          exitCode: err ? err.code : 0,
        });
      }
    );
  });
}

function readFile(sandboxDir, relPath) {
  const p = resolveInSandbox(sandboxDir, relPath);
  if (!fs.existsSync(p)) return { ok: false, output: `No such file: ${relPath}` };
  return { ok: true, output: fs.readFileSync(p, "utf8") };
}

function writeFile(sandboxDir, relPath, content) {
  const p = resolveInSandbox(sandboxDir, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return { ok: true, output: `Wrote ${content.length} bytes to ${relPath}` };
}

// Diff-based edit, not a whole-file rewrite — safer for the model to use
// correctly and cheaper on tokens for large files.
function editFile(sandboxDir, relPath, oldStr, newStr) {
  const p = resolveInSandbox(sandboxDir, relPath);
  if (!fs.existsSync(p)) return { ok: false, output: `No such file: ${relPath}` };
  const content = fs.readFileSync(p, "utf8");
  const count = content.split(oldStr).length - 1;
  if (count === 0) return { ok: false, output: `old_str not found in ${relPath}` };
  if (count > 1)
    return {
      ok: false,
      output: `old_str occurs ${count} times in ${relPath} — must be unique. Add more context.`,
    };
  fs.writeFileSync(p, content.replace(oldStr, newStr), "utf8");
  return { ok: true, output: `Edited ${relPath}` };
}

async function searchCode(sandboxDir, pattern, relPath = ".") {
  const dir = resolveInSandbox(sandboxDir, relPath);
  return runShell(
    sandboxDir,
    `grep -rn --exclude-dir=node_modules --exclude-dir=.git -- ${JSON.stringify(pattern)} ${JSON.stringify(
      path.relative(sandboxDir, dir) || "."
    )} || true`
  );
}

async function runTests(sandboxDir, command) {
  // Same mechanism as run_shell, but semantically this is the verification
  // gate — the agent loop should only mark a task "done" after this reports ok.
  return runShell(sandboxDir, command, { timeoutMs: 180000 });
}

async function gitClone(sandboxDir, url) {
  return runShell(sandboxDir, `git clone ${JSON.stringify(url)} .`, { timeoutMs: 120000 });
}

async function gitDiff(sandboxDir) {
  return runShell(sandboxDir, "git diff");
}

async function gitCommit(sandboxDir, message) {
  await runShell(sandboxDir, "git add -A");
  return runShell(sandboxDir, `git commit -m ${JSON.stringify(message)}`);
}

// git_push is deliberately NOT wired into the default tool list the agent
// gets — see agent.js. It exists here so it CAN be enabled per-task, but a
// task has to have been explicitly asked to push before that tool is handed
// to the model at all.
async function gitPush(sandboxDir) {
  return runShell(sandboxDir, "git push", { timeoutMs: 60000 });
}

module.exports = {
  resolveInSandbox,
  runShell,
  readFile,
  writeFile,
  editFile,
  searchCode,
  runTests,
  gitClone,
  gitDiff,
  gitCommit,
  gitPush,
};
