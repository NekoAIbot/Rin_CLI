#!/usr/bin/env node
// cli.js — entry point. Interactive: `rin` with no args drops you into a
// prompt. One-shot: `rin "build a calculator app" --dir ./calc`.

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { loadConfig } = require("./config");
const { runAgentLoop, trimHistory } = require("./agent");
const { listModels } = require("./providers");
const { saveSession, loadSession, clearSession } = require("./session");
const memory = require("./memory");
const tools = require("./tools");

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Persistent cross-session command history (so ↑ recalls goals from PAST
// `rin` sessions, not just the current process — plain readline only keeps
// history for the life of one process). One goal per line, oldest first;
// capped so the file can't grow forever.
const HISTORY_PATH = path.join(process.env.HOME || process.env.PREFIX || "/root", ".rin-cli-history");
const HISTORY_MAX_LINES = 1000;

function loadHistoryLines() {
  try {
    return fs
      .readFileSync(HISTORY_PATH, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendHistoryLine(line) {
  if (!line || !line.trim()) return;
  try {
    const lines = loadHistoryLines();
    // Don't pile up consecutive duplicates (re-running the same goal twice
    // in a row shouldn't double up the recall list).
    if (lines[lines.length - 1] === line) return;
    lines.push(line);
    const trimmed = lines.slice(-HISTORY_MAX_LINES);
    fs.writeFileSync(HISTORY_PATH, trimmed.join("\n") + "\n", "utf8");
  } catch {
    // Non-fatal — history is a convenience, not a correctness requirement.
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--continue" || a === "-c") args.cont = true;
    else args._.push(a);
  }
  return args;
}

function fmtMs(ms) {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function printBanner() {
  console.log(`${C.magenta}${C.bold}`);
  console.log("  ██▀███   ██▓ ███▄    █ ");
  console.log("  ▓██ ▒ ██▒▓██▒ ██ ▀█   █ ");
  console.log("  ▓██ ░▄█ ▒▒██▒▓██  ▀█ ██▒");
  console.log("  ▒██▀▀█▄  ░██░▓██▒  ▐▌██▒");
  console.log("  ░██▓ ▒██▒░██░▒██░   ▓██░");
  console.log(`${C.reset}${C.dim}  agentic coding, your terminal, your brain${C.reset}`);
}

// A minimal spinner that doesn't need any dependency — just carriage-return
// redraws. Stops cleanly and clears the line so it never leaves garbage
// behind once a real result replaces it.
class Spinner {
  constructor(label) {
    this.label = label;
    this.frame = 0;
    this.start = Date.now();
    this.timer = null;
  }
  go() {
    if (!process.stdout.isTTY) return; // no spinner in non-interactive/piped output
    this.timer = setInterval(() => {
      const elapsed = fmtMs(Date.now() - this.start);
      process.stdout.write(
        `\r${C.cyan}${SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]}${C.reset} ${C.dim}${this.label} (${elapsed})${C.reset}   `
      );
      this.frame++;
    }, 80);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stdout.write("\r\x1b[K"); // clear the spinner line entirely
    }
  }
}

function makeEventHandler() {
  let spinner = null;
  return function onEvent(type, payload) {
    switch (type) {
      case "thinking_start":
        spinner = new Spinner("thinking");
        spinner.go();
        break;
      case "model":
        if (spinner) spinner.stop();
        console.log(`${C.gray}  ${payload.usedModel} · ${fmtMs(payload.ms)}${C.reset}`);
        break;
      case "thought":
        if (payload) console.log(`${C.italic}${C.dim}  ${payload}${C.reset}`);
        break;
      case "action":
        console.log(
          `${C.cyan}  ▸ ${C.bold}${payload.action}${C.reset}${C.dim} ${JSON.stringify(payload.args).slice(0, 160)}${C.reset}`
        );
        break;
      case "result":
        console.log(
          (payload.ok ? `${C.green}  ✓${C.reset}` : `${C.red}  ✗${C.reset}`) +
            " " +
            trunc(payload.output)
        );
        break;
      case "warn":
        console.log(`${C.yellow}  ⚠ ${payload}${C.reset}`);
        break;
      case "error":
        if (spinner) spinner.stop();
        console.log(`${C.red}  ✗ ${payload}${C.reset}`);
        break;
      case "blocked":
        if (spinner) spinner.stop();
        console.log(`${C.yellow}${C.bold}  ? ${payload}${C.reset}`);
        break;
      case "done":
        if (spinner) spinner.stop();
        console.log(`${C.green}${C.bold}  ✓ ${payload}${C.reset}`);
        break;
    }
  };
}

function trunc(s, n = 400) {
  if (!s) return "";
  const oneLine = s.replace(/\n/g, "\n    ");
  return oneLine.length > n ? oneLine.slice(0, n) + `${C.dim} …(truncated)${C.reset}` : oneLine;
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// After a run finishes "done", show what actually changed — a git diff
// --stat if this is a git repo, otherwise the list of files the run
// touched (from readState) with their current size. Claude Code/Codex-style
// CLIs show this as a matter of course; scrolling back through step logs to
// reconstruct "what did it actually change" is not a substitute.
async function printChangeSummary(projectDir, touched) {
  const isGitRepo = fs.existsSync(path.join(projectDir, ".git"));
  if (isGitRepo) {
    const diff = await tools.runShell(projectDir, "git diff --stat 2>/dev/null");
    if (diff.ok && diff.output.trim()) {
      console.log(`\n${C.bold}  Changed:${C.reset}`);
      console.log(
        diff.output
          .trim()
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n")
      );
      return;
    }
  }
  if (touched && touched.length) {
    console.log(`\n${C.bold}  Files touched:${C.reset}`);
    for (const p of touched) {
      let size = "";
      try {
        size = ` ${C.dim}(${fs.statSync(path.join(projectDir, p)).size}b)${C.reset}`;
      } catch {
        // file may have been deleted after being touched — fine to omit size
      }
      console.log(`    ${p}${size}`);
    }
  }
}

function printHelp() {
  console.log(`${C.bold}  Commands${C.reset}`);
  console.log(`    ${C.bold}/model${C.reset} [key|auto]  switch backend, or "auto" for the Planner/Executor split`);
  console.log(`    ${C.bold}/status${C.reset}            show current config, model chains, and any resumable session`);
  console.log(`    ${C.bold}/resume${C.reset}             continue the last saved session for this directory`);
  console.log(`    ${C.bold}/clear${C.reset}              discard the saved session for this directory`);
  console.log(`    ${C.bold}/compact${C.reset}            shrink a saved session's history before resuming a long one`);
  console.log(`    ${C.bold}/help${C.reset}               this list`);
  console.log(`    ${C.bold}/exit${C.reset}               quit`);
  console.log(`${C.dim}  (rin --continue from the shell resumes the last session and exits when done)${C.reset}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.dir ? path.resolve(args.dir) : process.cwd();
  fs.mkdirSync(projectDir, { recursive: true });

  const cfg = loadConfig(projectDir);
  let model = args.model;

  // A session (goal + conversation + progress so far) is checkpointed after
  // EVERY completed step, not just at the end — so if Termux gets killed, the
  // connection drops, or you just close the app mid-task, `rin --continue`
  // (or /resume) picks up from the last completed step instead of starting
  // over from nothing.
  process.on("SIGINT", () => {
    console.log(
      `\n${C.yellow}  Interrupted — the last completed step was saved. Resume with: ${C.bold}rin --continue${C.reset}${C.yellow} (or /resume in here).${C.reset}`
    );
    process.exit(130);
  });

  printBanner();
  console.log(`${C.dim}  → ${projectDir}${C.reset}\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: HISTORY_MAX_LINES,
  });
  // Preload past sessions' goals so ↑ recalls them immediately, not just
  // what's been typed in this process. Node's readline keeps its history
  // array newest-first (index 0 = most recently entered), so the
  // oldest-first file has to be reversed before handing it over.
  rl.history = loadHistoryLines().reverse();

  const onEvent = makeEventHandler();

  const goalFromArgv = args._.join(" ").trim();

  let activeGoal = null;
  function onCheckpoint(payload) {
    saveSession(projectDir, { ...payload, goal: activeGoal });
  }

  // Shared tail end for both a fresh goal and a resumed one: handles the
  // ask_human pause/resume loop, and on a real terminal state either clears
  // the now-finished session or tells you how to pick it back up.
  async function finishRun(result) {
    if (result.status === "blocked") {
      const answer = await ask(rl, `\n${C.yellow}  your answer ›${C.reset} `);
      const next = await runAgentLoop({
        sandboxDir: projectDir,
        cfg,
        model,
        onEvent,
        onCheckpoint,
        initialHistory: result.history,
        initialSteps: result.steps,
        initialReadState: result.readState,
        humanAnswer: answer,
      });
      return finishRun(next);
    }

    if (result.status === "done") {
      clearSession(projectDir);
      await printChangeSummary(projectDir, result.readState);
    } else if (result.status === "failed" || result.status === "step_limit") {
      console.log(
        `${C.dim}  Progress saved — resume with ${C.reset}${C.bold}rin --continue${C.reset}${C.dim} or ${C.reset}${C.bold}/resume${C.reset}${C.dim} in this directory.${C.reset}`
      );
    }

    return result;
  }

  async function runGoal(goal) {
    appendHistoryLine(goal);
    activeGoal = goal;
    const result = await runAgentLoop({ goal, sandboxDir: projectDir, cfg, model, onEvent, onCheckpoint });
    return finishRun(result);
  }

  async function resumeSession() {
    const session = loadSession(projectDir);
    if (!session || !session.history) {
      console.log(`${C.yellow}  No previous session found for this directory.${C.reset}`);
      return null;
    }
    activeGoal = session.goal || "(resumed session)";
    console.log(
      `${C.dim}  Resuming: ${C.reset}${activeGoal}${C.dim}  (step ${session.steps}, last updated ${session.updatedAt})${C.reset}\n`
    );
    const result = await runAgentLoop({
      sandboxDir: projectDir,
      cfg,
      model: session.model,
      onEvent,
      onCheckpoint,
      initialHistory: session.history,
      initialSteps: session.steps,
      initialReadState: session.readState,
    });
    return finishRun(result);
  }

  async function printStatus() {
    console.log(`${C.bold}  Status${C.reset}`);
    console.log(`    dir: ${C.dim}${projectDir}${C.reset}`);
    console.log(`    mode: ${C.dim}${model ? `pinned → ${model}` : "auto (planner/executor)"}${C.reset}`);
    if (!model) {
      console.log(`    planner chain: ${C.dim}${cfg.plannerModels.join(" → ")}${C.reset}`);
      console.log(`    executor chain: ${C.dim}${cfg.executorModels.join(" → ")}${C.reset}`);
    }
    const session = loadSession(projectDir);
    console.log(
      `    resumable session: ${
        session
          ? `${C.yellow}yes${C.reset} ${C.dim}("${trunc(session.goal || "", 60)}", step ${session.steps}, updated ${session.updatedAt})${C.reset}`
          : `${C.dim}none${C.reset}`
      }`
    );
    process.stdout.write(`    memory: ${C.dim}checking…${C.reset}`);
    try {
      await Promise.race([
        memory.resolveUserId(cfg),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 6s")), 6000)),
      ]);
      process.stdout.write(`\r    memory: ${C.green}connected${C.reset}                    \n`);
    } catch (err) {
      process.stdout.write(`\r    memory: ${C.red}unavailable — ${err.message}${C.reset}                    \n`);
    }
  }

  async function compactSession() {
    const session = loadSession(projectDir);
    if (!session || !session.history) {
      console.log(`${C.dim}  Nothing to compact — no saved session for this directory.${C.reset}`);
      return;
    }
    const before = session.history.length;
    const compacted = trimHistory(session.history, 6);
    saveSession(projectDir, { ...session, history: compacted });
    console.log(`${C.green}  Compacted saved session: ${before} → ${compacted.length} messages.${C.reset}`);
  }

  async function handleModelCommand(rest) {
    const models = listModels();
    if (!rest) {
      console.log(`${C.bold}  Available models${C.reset}`);
      for (const m of models) {
        const marker = m.key === model ? `${C.green} ← current${C.reset}` : "";
        const tierTag = m.tier === "paid" ? `${C.yellow}[paid]${C.reset}` : `${C.dim}[free]${C.reset}`;
        console.log(`    ${C.bold}${m.key}${C.reset}  ${tierTag}  ${C.dim}${m.label}${C.reset}${marker}`);
      }
      console.log(`${C.dim}  /model <key> to switch · /model auto for the free fallback chain${C.reset}`);
      return;
    }
    if (rest === "auto") {
      model = undefined;
      console.log(`${C.green}  switched to automatic free-tier fallback${C.reset}`);
      return;
    }
    if (!models.find((m) => m.key === rest)) {
      console.log(`${C.red}  unknown model "${rest}" — run /model with no args to see the list${C.reset}`);
      return;
    }
    model = rest;
    console.log(`${C.green}  switched to ${rest}${C.reset}`);
  }

  if (args.cont) {
    await resumeSession();
    rl.close();
    return;
  }

  if (goalFromArgv) {
    await runGoal(goalFromArgv);
    rl.close();
    return;
  }

  console.log(`${C.dim}  type a goal · /help for commands · /exit to quit${C.reset}\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = (await ask(rl, `${C.magenta}${C.bold}rin›${C.reset} `)).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      printHelp();
      continue;
    }
    if (line.startsWith("/model")) {
      await handleModelCommand(line.slice(6).trim());
      continue;
    }
    if (line === "/clear") {
      const cleared = clearSession(projectDir);
      console.log(
        cleared
          ? `${C.green}  Cleared the saved session for this directory.${C.reset}`
          : `${C.dim}  No saved session to clear.${C.reset}`
      );
      continue;
    }
    if (line === "/resume" || line === "/continue") {
      await resumeSession();
      console.log();
      continue;
    }
    if (line === "/status") {
      await printStatus();
      continue;
    }
    if (line === "/compact") {
      await compactSession();
      continue;
    }
    await runGoal(line);
    console.log();
  }
  rl.close();
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.stack || err.message}${C.reset}`);
  process.exit(1);
});
