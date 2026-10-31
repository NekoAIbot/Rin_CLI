#!/usr/bin/env node
// cli.js — entry point. Interactive: `rin` with no args drops you into a
// prompt. One-shot: `rin "build a calculator app" --dir ./calc`.

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { loadConfig } = require("./config");
const { runAgentLoop, trimHistory } = require("./agent");
const { listModels } = require("./providers");
const { saveSession, loadSession, listSessions, latestSession, clearSession, newSessionId } = require("./session");
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
  white: "\x1b[97m",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    if (lines[lines.length - 1] === line) return;
    lines.push(line);
    const trimmed = lines.slice(-HISTORY_MAX_LINES);
    fs.writeFileSync(HISTORY_PATH, trimmed.join("\n") + "\n", "utf8");
  } catch {}
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--continue" || a === "-c") args.cont = true;
    else if (a === "--resume" || a === "-r") {
      args.resume = true;
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) args.resumeId = argv[++i];
    } else args._.push(a);
  }
  return args;
}

function fmtMs(ms) {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// True-color letter-by-letter gradient — the same trick Vite/Bun/Astro use
// for their banner wordmarks. Degrades harmlessly on terminals that ignore
// 24-bit color (shows as one flat color instead of a gradient); never
// breaks layout, since it's still just `text.length` printable characters.
function gradientText(text, from, to) {
  const n = text.length;
  let out = "";
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return out + C.reset;
}

// Width-aware divider, capped so it never looks absurd on a wide terminal
// and never wraps on a narrow phone screen — the same rule under every
// section header, so the whole CLI reads as one consistent system instead
// of each screen inventing its own look.
function divider() {
  const width = Math.min(Math.max(process.stdout.columns || 44, 28), 56);
  return "─".repeat(width);
}

function sectionHeader(title) {
  console.log(`\n${C.bold}${C.white}${title}${C.reset}`);
  console.log(`${C.dim}${divider()}${C.reset}`);
}

const PROMPT_GLYPH = `${C.bold}\x1b[38;2;34;211;238m❯${C.reset}`;

function printBanner() {
  const wordmark = gradientText("rin", [192, 132, 252], [34, 211, 238]);
  console.log(`  ${C.bold}${wordmark}${C.reset}  ${C.dim}agentic coding for your terminal${C.reset}`);
  console.log(`  ${C.dim}${divider()}${C.reset}`);
}

class Spinner {
  constructor(label) {
    this.label = label;
    this.frame = 0;
    this.start = Date.now();
    this.timer = null;
  }
  go() {
    if (!process.stdout.isTTY) return;
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
      process.stdout.write("\r\x1b[K");
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

async function printChangeSummary(projectDir, touched) {
  const isGitRepo = fs.existsSync(path.join(projectDir, ".git"));
  if (isGitRepo) {
    const diff = await tools.runShell(projectDir, "git diff --stat 2>/dev/null");
    if (diff.ok && diff.output.trim()) {
      sectionHeader("Changed");
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
    sectionHeader("Files touched");
    for (const p of touched) {
      let size = "";
      try {
        size = ` ${C.dim}(${fs.statSync(path.join(projectDir, p)).size}b)${C.reset}`;
      } catch {}
      console.log(`    ${p}${size}`);
    }
  }
}

function fmtSessionLine(s, idx) {
  const idTag = `${C.yellow}${s.id}${C.reset}`;
  const idxTag = idx != null ? `${C.dim}${idx}.${C.reset} ` : "";
  return `  ${idxTag}${idTag}  ${trunc(s.goal || "(no goal recorded)", 56)}${C.dim}  · step ${s.steps ?? "?"} · ${fmtAgo(s.updatedAt)}${C.reset}`;
}

function printHelp() {
  sectionHeader("Commands");
  console.log(`    ${C.bold}/model${C.reset} [key|auto]  switch backend, or "auto" for the Planner/Executor split`);
  console.log(`    ${C.bold}/status${C.reset}            show current config, model chains, and saved sessions`);
  console.log(`    ${C.bold}/continue${C.reset}           resume the most recent saved session — no picker`);
  console.log(`    ${C.bold}/resume${C.reset}             list saved sessions for this directory and pick one`);
  console.log(`    ${C.bold}/clear${C.reset} [id]        discard a saved session (most recent if no id given)`);
  console.log(`    ${C.bold}/compact${C.reset}            shrink a saved session's history before resuming a long one`);
  console.log(`    ${C.bold}/help${C.reset}               this list`);
  console.log(`    ${C.bold}/exit${C.reset}               quit`);
  console.log(`${C.dim}  (from the shell: rin --continue / -c jumps to the latest; rin --resume / -r shows the list)${C.reset}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.dir ? path.resolve(args.dir) : process.cwd();
  fs.mkdirSync(projectDir, { recursive: true });

  const cfg = loadConfig(projectDir);
  let model = args.model;

  process.on("SIGINT", () => {
    console.log(
      `\n${C.yellow}  Interrupted — the last completed step was saved. Resume with: ${C.bold}rin --continue${C.reset}${C.yellow} (or rin --resume to pick from a list).${C.reset}`
    );
    process.exit(130);
  });

  printBanner();
  console.log(`  ${C.dim}project${C.reset}  ${C.white}${projectDir}${C.reset}`);
  console.log(
    `  ${C.dim}mode${C.reset}     ${C.white}${model ? `pinned → ${model}` : "auto · planner → executor"}${C.reset}\n`
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: HISTORY_MAX_LINES,
  });
  rl.history = loadHistoryLines().reverse();

  const onEvent = makeEventHandler();

  const goalFromArgv = args._.join(" ").trim();

  let activeGoal = null;
  let activeSessionId = null;
  function onCheckpoint(payload) {
    saveSession(projectDir, activeSessionId, { ...payload, goal: activeGoal });
  }

  async function finishRun(result) {
    if (result.status === "blocked") {
      const answer = await ask(rl, `\n  ${C.bold}\x1b[38;2;250;204;21m❯${C.reset} ${C.dim}your answer${C.reset} `);
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
      clearSession(projectDir, activeSessionId);
      await printChangeSummary(projectDir, result.readState);
    } else if (result.status === "failed" || result.status === "step_limit") {
      console.log(
        `${C.dim}  Progress saved as ${C.reset}${C.bold}${C.yellow}${activeSessionId}${C.reset}${C.dim} — resume with ${C.reset}${C.bold}rin --continue${C.reset}${C.dim} or ${C.reset}${C.bold}rin --resume${C.reset}${C.dim} to pick it from a list.${C.reset}`
      );
    }

    return result;
  }

  async function runGoal(goal) {
    appendHistoryLine(goal);
    activeGoal = goal;
    activeSessionId = newSessionId();
    const result = await runAgentLoop({ goal, sandboxDir: projectDir, cfg, model, onEvent, onCheckpoint });
    return finishRun(result);
  }

  async function resumeById(sessionId) {
    const session = loadSession(projectDir, sessionId);
    if (!session || !session.history) {
      console.log(`${C.yellow}  No saved session found with id "${sessionId}" in this directory.${C.reset}`);
      return null;
    }
    activeGoal = session.goal || "(resumed session)";
    activeSessionId = sessionId;
    model = session.model;
    console.log(
      `${C.dim}  Resuming ${C.reset}${C.yellow}${sessionId}${C.reset}${C.dim}: ${C.reset}${activeGoal}${C.dim}  (step ${session.steps}, ${fmtAgo(session.updatedAt)})${C.reset}\n`
    );
    const result = await runAgentLoop({
      sandboxDir: projectDir,
      cfg,
      model,
      onEvent,
      onCheckpoint,
      initialHistory: session.history,
      initialSteps: session.steps,
      initialReadState: session.readState,
    });
    return finishRun(result);
  }

  async function continueLatest() {
    const latest = latestSession(projectDir);
    if (!latest) {
      console.log(`${C.yellow}  No previous session found for this directory.${C.reset}`);
      return null;
    }
    return resumeById(latest.id);
  }

  async function resumePicker(presetId) {
    const sessions = listSessions(projectDir);
    if (!sessions.length) {
      console.log(`${C.yellow}  No saved sessions for this directory.${C.reset}`);
      return null;
    }
    if (presetId) return resumeById(presetId);

    sectionHeader("Saved sessions · most recent first");
    sessions.forEach((s, i) => console.log(fmtSessionLine(s, i + 1)));
    const answer = (await ask(rl, `\n  ${PROMPT_GLYPH} ${C.dim}resume which? (number, id, or blank to cancel)${C.reset} `)).trim();
    if (!answer) {
      console.log(`${C.dim}  Cancelled.${C.reset}`);
      return null;
    }
    const byIndex = /^\d+$/.test(answer) ? sessions[parseInt(answer, 10) - 1] : null;
    const chosen = byIndex || sessions.find((s) => s.id === answer);
    if (!chosen) {
      console.log(`${C.red}  No session matches "${answer}".${C.reset}`);
      return null;
    }
    return resumeById(chosen.id);
  }

  async function printStatus() {
    sectionHeader("Status");
    console.log(`    dir: ${C.dim}${projectDir}${C.reset}`);
    console.log(`    mode: ${C.dim}${model ? `pinned → ${model}` : "auto (planner/executor)"}${C.reset}`);
    if (!model) {
      console.log(`    planner chain: ${C.dim}${cfg.plannerModels.join(" → ")}${C.reset}`);
      console.log(`    executor chain: ${C.dim}${cfg.executorModels.join(" → ")}${C.reset}`);
    }
    const sessions = listSessions(projectDir);
    if (!sessions.length) {
      console.log(`    sessions: ${C.dim}none${C.reset}`);
    } else {
      console.log(`    sessions: ${C.yellow}${sessions.length}${C.reset} saved for this directory`);
      sessions.slice(0, 5).forEach((s) => console.log(fmtSessionLine(s)));
      if (sessions.length > 5) console.log(`    ${C.dim}… and ${sessions.length - 5} more (rin --resume to see all)${C.reset}`);
    }
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

  async function compactSession(idArg) {
    const target = idArg ? loadSession(projectDir, idArg) : latestSession(projectDir);
    if (!target || !target.history) {
      console.log(`${C.dim}  Nothing to compact — no matching saved session for this directory.${C.reset}`);
      return;
    }
    const before = target.history.length;
    const compacted = trimHistory(target.history, 6);
    saveSession(projectDir, target.id, { ...target, history: compacted });
    console.log(`${C.green}  Compacted session ${C.yellow}${target.id}${C.reset}${C.green}: ${before} → ${compacted.length} messages.${C.reset}`);
  }

  async function handleModelCommand(rest) {
    const models = listModels();
    if (!rest) {
      sectionHeader("Available models");
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
    await continueLatest();
    rl.close();
    return;
  }

  if (args.resume) {
    await resumePicker(args.resumeId);
    rl.close();
    return;
  }

  if (goalFromArgv) {
    await runGoal(goalFromArgv);
    rl.close();
    return;
  }

  console.log(`  ${C.dim}type a goal · /help for commands · /exit to quit${C.reset}\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = (await ask(rl, `${PROMPT_GLYPH} `)).trim();
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
    if (line.startsWith("/clear")) {
      const idArg = line.slice(6).trim();
      const target = idArg || (latestSession(projectDir) || {}).id;
      const cleared = target ? clearSession(projectDir, target) : false;
      console.log(
        cleared
          ? `${C.green}  Cleared session ${C.yellow}${target}${C.reset}${C.green}.${C.reset}`
          : `${C.dim}  No saved session to clear.${C.reset}`
      );
      continue;
    }
    if (line === "/continue") {
      await continueLatest();
      console.log();
      continue;
    }
    if (line.startsWith("/resume")) {
      await resumePicker(line.slice(7).trim() || undefined);
      console.log();
      continue;
    }
    if (line === "/status") {
      await printStatus();
      continue;
    }
    if (line.startsWith("/compact")) {
      await compactSession(line.slice(8).trim() || undefined);
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
