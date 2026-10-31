#!/usr/bin/env node
// cli.js — entry point. Interactive: `rin` with no args drops you into a
// prompt. One-shot: `rin "build a calculator app" --dir ./calc`.
// What Rin DOES lives here; how it LOOKS lives in ui.js.

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { loadConfig } = require("./config");
const { runAgentLoop, trimHistory } = require("./agent");
const { listModels } = require("./providers");
const { saveSession, loadSession, listSessions, latestSession, clearSession, newSessionId } = require("./session");
const memory = require("./memory");
const tools = require("./tools");
const ui = require("./ui");

const { C, AMBER, MINT, ROSE, PROMPT_GLYPH, ASK_GLYPH, fit, sectionHeader, fmtAgo } = ui;

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
    fs.writeFileSync(HISTORY_PATH, lines.slice(-HISTORY_MAX_LINES).join("\n") + "\n", "utf8");
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

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// What this run touched, with a marker for new / modified / read-only. In a
// git repo the marker comes from `git status` (so NEW files show up — the old
// `git diff --stat` only ever listed already-tracked files and silently
// missed everything Rin created); otherwise it's just the file list.
async function printChangeSummary(projectDir, touched) {
  const files = (touched || []).filter((p) => {
    try {
      return fs.statSync(path.join(projectDir, p)).isFile();
    } catch {
      return false;
    }
  });
  if (!files.length) return;

  const status = {};
  const isGitRepo = fs.existsSync(path.join(projectDir, ".git"));
  if (isGitRepo) {
    const st = await tools.runShell(projectDir, "git status --porcelain -uall 2>/dev/null");
    if (st.ok) {
      for (const l of st.output.split("\n")) {
        if (l.length > 3) status[l.slice(3).trim().replace(/^"|"$/g, "")] = l.slice(0, 2).trim();
      }
    }
  }

  sectionHeader("Files");
  const nameW = Math.min(Math.max(...files.map((p) => p.length)), ui.termWidth() - 24);
  for (const p of files) {
    let lines = "";
    try {
      lines = `${fs.readFileSync(path.join(projectDir, p), "utf8").replace(/\n$/, "").split("\n").length} lines`;
    } catch {}
    const code = status[p];
    let mark;
    if (!isGitRepo) mark = `${MINT}●${C.reset}`;
    else if (code === "??" || code === "A") mark = `${MINT}+${C.reset}`;
    else if (code) mark = `${AMBER}~${C.reset}`;
    else mark = `${C.dim}·${C.reset}`;
    console.log(`  ${mark} ${fit(p, nameW).padEnd(nameW)}  ${C.dim}${lines}${C.reset}`);
  }
  if (isGitRepo) console.log(`\n  ${C.dim}+ new · ~ modified · · unchanged (read only)${C.reset}`);
}

function fmtSessionLine(s, idx) {
  const idxTag = idx != null ? `${C.dim}${idx}${C.reset}  ` : "";
  const goal = fit(s.goal || "(no goal recorded)", Math.max(16, ui.termWidth() - 34));
  return `  ${idxTag}${AMBER}${s.id}${C.reset}  ${goal}${C.dim}  ${s.steps ?? "?"} steps · ${fmtAgo(s.updatedAt)}${C.reset}`;
}

function printHelp() {
  sectionHeader("Commands");
  const rows = [
    ["/model [key|auto]", "switch model, or auto split"],
    ["/status", "config, sessions, memory check"],
    ["/continue", "resume the latest session"],
    ["/resume [id]", "pick a saved session"],
    ["/clear [id]", "discard a saved session"],
    ["/compact [id]", "shrink a session's history"],
    ["/memory", "what Rin remembers"],
    ["/remember <text>", "save a fact to memory"],
    ["/help", "this list"],
    ["/exit", "quit"],
  ];
  for (const [cmd, desc] of rows) console.log(`  ${C.bold}${cmd.padEnd(18)}${C.reset}${C.dim}${fit(desc, ui.termWidth() - 22)}${C.reset}`);
  console.log(`\n  ${C.dim}${fit("Tab completes · shell: rin -c latest, rin -r list", ui.termWidth() - 4)}${C.reset}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.dir ? path.resolve(args.dir) : process.cwd();
  fs.mkdirSync(projectDir, { recursive: true });

  const cfg = loadConfig(projectDir);
  let model = args.model;

  let version = "";
  try {
    version = require("../package.json").version;
  } catch {}
  const selfDir = path.resolve(__dirname, "..");
  const inOwnSource = projectDir === selfDir || projectDir.startsWith(selfDir + path.sep);

  const existingSessions = listSessions(projectDir);
  ui.welcome({
    projectDir,
    mode: model ? `pinned → ${model}` : "auto · planner → executor",
    sessionCount: existingSessions.length,
    lastGoal: existingSessions[0] && existingSessions[0].goal,
    memoryConfigured: !!(cfg.supabaseUrl && cfg.supabaseServiceRoleKey),
    version,
    inOwnSource,
  });

  // Tab completion: slash commands, then session ids / model keys as arguments.
  const COMMANDS = ["/model", "/status", "/continue", "/resume", "/clear", "/compact", "/memory", "/remember", "/help", "/exit"];
  function completer(line) {
    if (!line.startsWith("/")) return [[], line];
    if (line.includes(" ")) {
      const cmd = line.split(" ")[0];
      const arg = line.slice(cmd.length + 1);
      let pool = [];
      if (["/resume", "/clear", "/compact"].includes(cmd)) pool = listSessions(projectDir).map((s) => s.id);
      else if (cmd === "/model") pool = ["auto", ...listModels().map((m) => m.key)];
      return [pool.filter((p) => p.startsWith(arg)).map((p) => `${cmd} ${p}`), line];
    }
    const hits = COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: HISTORY_MAX_LINES,
    completer,
  });
  rl.history = loadHistoryLines().reverse();

  const renderer = ui.createRenderer();
  const onEvent = renderer.onEvent;

  const goalFromArgv = args._.join(" ").trim();

  let activeGoal = null;
  let activeSessionId = null;
  let running = false;
  let lastSigint = 0;

  function onCheckpoint(payload) {
    saveSession(projectDir, activeSessionId, { ...payload, goal: activeGoal });
  }

  function interrupted() {
    renderer.stop();
    console.log(
      `\n\n  ${AMBER}■ Interrupted${C.reset} ${C.dim}— last completed step saved${activeSessionId ? ` as ${C.reset}${C.bold}${activeSessionId}${C.reset}${C.dim}` : ""}.${C.reset}`
    );
    console.log(`  ${C.dim}Pick up with ${C.reset}${C.bold}rin --continue${C.reset}${C.dim} (latest) or ${C.reset}${C.bold}rin --resume${C.reset}${C.dim} (choose from a list).${C.reset}\n`);
    process.exit(130);
  }

  // At the idle prompt, one Ctrl+C just clears the line (like every modern
  // CLI); a second within 1.5s exits. During a run it saves and exits.
  rl.on("SIGINT", () => {
    if (running) return interrupted();
    const now = Date.now();
    if (now - lastSigint < 1500) {
      console.log();
      process.exit(0);
    }
    lastSigint = now;
    console.log(`\n  ${C.dim}press ctrl+c again to exit${C.reset}`);
    try {
      // Ctrl+U clears the typed text AND redraws the prompt in one refresh.
      rl.write(null, { ctrl: true, name: "u" });
    } catch {}
  });
  process.on("SIGINT", () => {
    if (running) interrupted();
    else process.exit(0);
  });

  // Shared tail for fresh and resumed runs: ask_human loop, session cleanup,
  // change summary, footer.
  async function finishRun(result, t0) {
    if (result.status === "blocked") {
      running = false;
      const answer = await ask(rl, `\n  ${ASK_GLYPH} ${C.dim}your answer${C.reset} `);
      running = true;
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
      return finishRun(next, t0);
    }

    if (result.status === "done") {
      clearSession(projectDir, activeSessionId);
      await printChangeSummary(projectDir, result.readState);
    } else if (result.status === "failed" || result.status === "step_limit") {
      console.log(
        `\n  ${C.dim}Progress saved as ${C.reset}${C.bold}${AMBER}${activeSessionId}${C.reset}${C.dim} — ${C.reset}${C.bold}rin --continue${C.reset}${C.dim} or ${C.reset}${C.bold}rin --resume${C.reset}${C.dim} to pick it back up.${C.reset}`
      );
    }
    ui.runFooter({ status: result.status, steps: result.steps, ms: Date.now() - t0, models: renderer.takeUsage() });
    return result;
  }

  async function tracked(fn) {
    running = true;
    renderer.takeUsage(); // discard any stale counts from an aborted earlier run
    const t0 = Date.now();
    try {
      const result = await fn();
      return await finishRun(result, t0);
    } finally {
      running = false;
    }
  }

  async function runGoal(goal) {
    appendHistoryLine(goal);
    activeGoal = goal;
    activeSessionId = newSessionId();
    return tracked(() => runAgentLoop({ goal, sandboxDir: projectDir, cfg, model, onEvent, onCheckpoint }));
  }

  async function resumeById(sessionId) {
    const session = loadSession(projectDir, sessionId);
    if (!session || !session.history) {
      console.log(`  ${AMBER}No saved session with id "${sessionId}" in this directory.${C.reset}`);
      return null;
    }
    activeGoal = session.goal || "(resumed session)";
    activeSessionId = sessionId;
    model = session.model;
    console.log(
      `  ${C.dim}Resuming${C.reset} ${AMBER}${sessionId}${C.reset} ${C.dim}· step ${session.steps} · ${fmtAgo(session.updatedAt)}${C.reset}`
    );
    console.log(`  ${fit(activeGoal, ui.termWidth() - 4)}`);
    return tracked(() =>
      runAgentLoop({
        sandboxDir: projectDir,
        cfg,
        model,
        onEvent,
        onCheckpoint,
        initialHistory: session.history,
        initialSteps: session.steps,
        initialReadState: session.readState,
      })
    );
  }

  async function continueLatest() {
    const latest = latestSession(projectDir);
    if (!latest) {
      console.log(`  ${AMBER}No previous session found for this directory.${C.reset}`);
      return null;
    }
    return resumeById(latest.id);
  }

  async function resumePicker(presetId) {
    const sessions = listSessions(projectDir);
    if (!sessions.length) {
      console.log(`  ${AMBER}No saved sessions for this directory.${C.reset}`);
      return null;
    }
    if (presetId) return resumeById(presetId);

    sectionHeader("Saved sessions");
    sessions.forEach((s, i) => console.log(fmtSessionLine(s, i + 1)));
    const answer = (await ask(rl, `\n  ${PROMPT_GLYPH} ${C.dim}resume which? number or id · enter to cancel${C.reset} `)).trim();
    if (!answer) {
      console.log(`  ${C.dim}Cancelled.${C.reset}`);
      return null;
    }
    const byIndex = /^\d+$/.test(answer) ? sessions[parseInt(answer, 10) - 1] : null;
    const chosen = byIndex || sessions.find((s) => s.id === answer);
    if (!chosen) {
      console.log(`  ${ROSE}No session matches "${answer}".${C.reset}`);
      return null;
    }
    return resumeById(chosen.id);
  }

  async function printStatus() {
    sectionHeader("Status");
    const row = (k, v) => console.log(`  ${C.dim}${k.padEnd(10)}${C.reset}${v}`);
    row("dir", ui.shortPath(projectDir, ui.termWidth() - 14));
    row("mode", model ? `pinned → ${model}` : "auto (planner/executor)");
    if (!model) {
      row("planner", cfg.plannerModels.join(` ${C.dim}→${C.reset} `));
      row("executor", cfg.executorModels.join(` ${C.dim}→${C.reset} `));
    }
    const sessions = listSessions(projectDir);
    row("sessions", sessions.length ? `${AMBER}${sessions.length}${C.reset} saved` : `${C.dim}none${C.reset}`);
    sessions.slice(0, 5).forEach((s) => console.log(fmtSessionLine(s)));
    if (sessions.length > 5) console.log(`  ${C.dim}… and ${sessions.length - 5} more (/resume to see all)${C.reset}`);
    process.stdout.write(`  ${C.dim}${"memory".padEnd(10)}${C.reset}${C.dim}checking…${C.reset}`);
    try {
      await Promise.race([
        memory.resolveUserId(cfg),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 6s")), 6000)),
      ]);
      process.stdout.write(`\r  ${C.dim}${"memory".padEnd(10)}${C.reset}${MINT}connected${C.reset}                    \n`);
    } catch (err) {
      process.stdout.write(`\r  ${C.dim}${"memory".padEnd(10)}${C.reset}${ROSE}unavailable${C.reset} ${C.dim}${fit(err.message, 40)}${C.reset}\n`);
    }
  }

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);

  function memoryProblem(err) {
    console.log(`  ${ROSE}✗${C.reset} Memory unavailable`);
    for (const l of ui.wrap(err.message, ui.termWidth() - 6).slice(0, 4)) console.log(`    ${C.dim}${l}${C.reset}`);
    for (const l of ui.wrap("Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and RIN_USER_EMAIL in ~/.rin-cli.env", ui.termWidth() - 6)) {
      console.log(`    ${C.dim}${l}${C.reset}`);
    }
  }

  async function showMemory() {
    sectionHeader("Memory");
    try {
      const rows = await withTimeout(memory.loadRelevantMemories(cfg, { limit: 15 }), 8000);
      if (!rows.length) {
        console.log(`  ${MINT}●${C.reset} Linked, but nothing stored yet.`);
        console.log(`    ${C.dim}/remember <text> to add something.${C.reset}`);
        return;
      }
      for (const r of rows) {
        console.log(`  ${C.dim}${fit(r.category, 16).padEnd(16)}${C.reset}${C.bold}${fit(r.key, 22)}${C.reset}`);
        for (const l of ui.wrap(String(r.value), ui.termWidth() - 8).slice(0, 2)) console.log(`      ${C.dim}${l}${C.reset}`);
      }
      console.log(`\n  ${MINT}●${C.reset} ${C.dim}${rows.length} strongest memories · shared with the Telegram bot${C.reset}`);
    } catch (err) {
      memoryProblem(err);
    }
  }

  async function rememberText(text) {
    if (!text) {
      console.log(`  ${C.dim}Usage: /remember <something worth keeping>${C.reset}`);
      return;
    }
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "note";
    try {
      const r = await withTimeout(memory.saveMemory(cfg, { category: "fact", key, value: text }), 8000);
      console.log(`  ${MINT}✓${C.reset} ${r.action === "reinforced" ? "Reinforced" : "Remembered"} ${C.dim}fact/${key}${C.reset}`);
    } catch (err) {
      memoryProblem(err);
    }
  }

  async function compactSession(idArg) {
    const target = idArg ? loadSession(projectDir, idArg) : latestSession(projectDir);
    if (!target || !target.history) {
      console.log(`  ${C.dim}Nothing to compact — no matching saved session.${C.reset}`);
      return;
    }
    const before = target.history.length;
    const compacted = trimHistory(target.history, 6);
    saveSession(projectDir, target.id, { ...target, history: compacted });
    console.log(`  ${MINT}✓${C.reset} Compacted ${AMBER}${target.id}${C.reset} ${C.dim}${before} → ${compacted.length} messages${C.reset}`);
  }

  async function handleModelCommand(rest) {
    const models = listModels();
    if (!rest) {
      sectionHeader("Models");
      for (const m of models) {
        const current = m.key === model ? `  ${MINT}● current${C.reset}` : "";
        const tier = `${m.tier === "paid" ? AMBER : C.dim}${(m.tier === "paid" ? "paid" : "free").padEnd(5)}${C.reset}`;
        console.log(`  ${C.bold}${m.key.padEnd(14)}${C.reset}${tier} ${C.dim}${fit(m.label, ui.termWidth() - 26)}${C.reset}${current}`);
      }
      console.log(`\n  ${C.dim}/model <key> to pin · /model auto for the free fallback chain${C.reset}`);
      return;
    }
    if (rest === "auto") {
      model = undefined;
      console.log(`  ${MINT}✓${C.reset} Auto mode — planner/executor on the free tier`);
      return;
    }
    if (!models.find((m) => m.key === rest)) {
      console.log(`  ${ROSE}Unknown model "${rest}"${C.reset} ${C.dim}— /model lists them${C.reset}`);
      return;
    }
    model = rest;
    console.log(`  ${MINT}✓${C.reset} Pinned to ${C.bold}${rest}${C.reset}`);
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(ui.rule());
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
          ? `  ${MINT}✓${C.reset} Cleared ${AMBER}${target}${C.reset}`
          : `  ${C.dim}No saved session to clear.${C.reset}`
      );
      continue;
    }
    if (line === "/continue") {
      await continueLatest();
      continue;
    }
    if (line.startsWith("/resume")) {
      await resumePicker(line.slice(7).trim() || undefined);
      continue;
    }
    if (line === "/status") {
      await printStatus();
      continue;
    }
    if (line === "/memory") {
      await showMemory();
      continue;
    }
    if (line.startsWith("/remember")) {
      await rememberText(line.slice(9).trim());
      continue;
    }
    if (line.startsWith("/compact")) {
      await compactSession(line.slice(8).trim() || undefined);
      continue;
    }
    await runGoal(line);
  }
  rl.close();
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.stack || err.message}${C.reset}`);
  process.exit(1);
});
