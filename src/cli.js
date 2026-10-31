#!/usr/bin/env node
// cli.js — entry point. Interactive: `rin` with no args drops you into a
// prompt. One-shot: `rin "build a calculator app" --dir ./calc`.
// What Rin DOES lives here; how it LOOKS lives in ui.js; how it READS
// keystrokes lives in editor.js.

const path = require("path");
const fs = require("fs");
const { loadConfig } = require("./config");
const { runAgentLoop, trimHistory } = require("./agent");
const { listModels } = require("./providers");
const { saveSession, loadSession, listSessions, latestSession, clearSession, newSessionId } = require("./session");
const memory = require("./memory");
const tools = require("./tools");
const ui = require("./ui");
const settingsStore = require("./settings");
const { createEditor } = require("./editor");

const { C, T, fit, sectionHeader, fmtAgo } = ui;

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
  if (!line || !line.trim() || line.includes("\n")) return;
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

// People type "rin --resume" into the prompt out of habit. Treat it as the
// command it obviously is instead of sending it to the model as a goal.
function normalizeLine(line) {
  const m = /^(?:rin\s+)?(--continue|-c|--resume|-r)(?:\s+(\S+))?$/.exec(line);
  if (!m) return line;
  if (m[1] === "--continue" || m[1] === "-c") return "/continue";
  return m[2] ? `/resume ${m[2]}` : "/resume";
}

// What this run touched, with a marker for new / modified / read-only. In a
// git repo the marker comes from `git status` (so NEW files show up);
// otherwise it's just the file list.
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

  ui.gutterSection("Files");
  const nameW = Math.min(Math.max(...files.map((p) => p.length)), ui.termWidth() - 24);
  for (const p of files) {
    let lines = "";
    try {
      lines = `${fs.readFileSync(path.join(projectDir, p), "utf8").replace(/\n$/, "").split("\n").length} lines`;
    } catch {}
    const code = status[p];
    let mark;
    if (!isGitRepo) mark = `${T.ok}●${C.reset}`;
    else if (code === "??" || code === "A") mark = `${T.ok}+${C.reset}`;
    else if (code) mark = `${T.warn}~${C.reset}`;
    else mark = `${C.dim}·${C.reset}`;
    ui.emit(`  ${mark} ${fit(p, nameW).padEnd(nameW)}  ${C.dim}${lines}${C.reset}`);
  }
  if (isGitRepo) ui.emit(`\n  ${C.dim}+ new · ~ modified · · unchanged (read only)${C.reset}`);
}

function fmtSessionLine(s, idx) {
  const idxTag = idx != null ? `${C.dim}${idx}${C.reset}  ` : "";
  const goal = fit(s.goal || "(no goal recorded)", Math.max(16, ui.termWidth() - 34));
  return `  ${idxTag}${T.warn}${s.id}${C.reset}  ${goal}${C.dim}  ${s.steps ?? "?"} steps · ${fmtAgo(s.updatedAt)}${C.reset}`;
}

const COMMANDS = [
  { value: "/model", desc: "switch model, or auto split", args: true },
  { value: "/theme", desc: "change the colour theme", args: true },
  { value: "/config", desc: "settings" },
  { value: "/status", desc: "config, sessions, memory check" },
  { value: "/continue", desc: "resume the latest session" },
  { value: "/resume", desc: "pick a saved session", args: true },
  { value: "/clear", desc: "discard a saved session", args: true },
  { value: "/compact", desc: "shrink a session's history", args: true },
  { value: "/memory", desc: "what Rin remembers" },
  { value: "/remember", desc: "save a fact to memory", args: true },
  { value: "/help", desc: "list commands" },
  { value: "/exit", desc: "quit" },
];

function printHelp() {
  sectionHeader("Commands");
  for (const c of COMMANDS) {
    const name = c.value + (c.args ? " …" : "");
    console.log(`  ${C.bold}${name.padEnd(14)}${C.reset}${C.dim}${fit(c.desc, ui.termWidth() - 18)}${C.reset}`);
  }
  console.log(`  ${C.bold}${"!<command>".padEnd(14)}${C.reset}${C.dim}${fit("run a shell command here", ui.termWidth() - 18)}${C.reset}`);
  sectionHeader("Keys");
  const keys = [
    ["tab", "complete a command"],
    ["↑ ↓", "history, or move in a menu"],
    ["\\ + enter", "new line in the box"],
    ["ctrl+u / ctrl+k", "delete to start / end"],
    ["ctrl+c", "clear · twice to exit"],
  ];
  for (const [k, d] of keys) console.log(`  ${C.bold}${k.padEnd(16)}${C.reset}${C.dim}${fit(d, ui.termWidth() - 20)}${C.reset}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.dir ? path.resolve(args.dir) : process.cwd();
  fs.mkdirSync(projectDir, { recursive: true });

  const cfg = loadConfig(projectDir);
  let model = args.model;

  let settings = settingsStore.load();
  ui.applySettings(settings);
  const ed = createEditor();

  let version = "";
  try {
    version = require("../package.json").version;
  } catch {}
  const selfDir = path.resolve(__dirname, "..");
  const inOwnSource = projectDir === selfDir || projectDir.startsWith(selfDir + path.sep);

  const goalFromArgv = args._.join(" ").trim();
  const interactive = !(args.cont || args.resume || goalFromArgv);

  const modeLabel = () => (model ? `pinned → ${model}` : "auto · planner → executor");
  const changeSetting = (key, value) => {
    settings = { ...settings, [key]: value };
    settingsStore.save(settings);
    ui.applySettings(settings);
  };

  // ── Theme picker (also the first-run screen) ───────────────────────────────
  async function pickTheme({ first = false } = {}) {
    const before = settings.theme || "rin";
    const ids = ui.THEME_ORDER;
    const idx = await ed.menu({
      title: first ? "Welcome to Rin" : "Theme",
      intro: [first ? "Let's pick a look. Move to preview it live — you can change it any time with /theme." : "Pick a look. It previews live and is saved when you choose."],
      rows: ids.map((id) => ({ label: ui.THEMES[id].label, hint: ui.THEMES[id].desc, current: !first && id === before })),
      initial: ids.indexOf(before),
      preview: () => ui.previewLines(),
      onMove: (i) => ui.setTheme(ids[i]),
    });
    const chosen = idx === -1 ? (first ? "rin" : before) : ids[idx];
    ui.setTheme(chosen);
    if (idx !== -1 || first) changeSetting("theme", chosen);
    if (idx !== -1) console.log(`  ${T.ok}✓${C.reset} Theme set to ${C.bold}${ui.THEMES[chosen].label}${C.reset}`);
    else if (!first) console.log(`  ${C.dim}Theme unchanged.${C.reset}`);
  }

  async function handleTheme(arg) {
    if (!arg) {
      if (!ed.isTTY) {
        console.log(`  ${C.dim}Themes: ${ui.THEME_ORDER.join(", ")} · /theme <name>${C.reset}`);
        return;
      }
      return pickTheme();
    }
    if (!ui.THEMES[arg]) {
      console.log(`  ${T.err}Unknown theme "${arg}"${C.reset} ${C.dim}— ${ui.THEME_ORDER.join(", ")}${C.reset}`);
      return;
    }
    changeSetting("theme", arg);
    console.log(`  ${T.ok}✓${C.reset} Theme set to ${C.bold}${ui.THEMES[arg].label}${C.reset}`);
  }

  // ── /config ────────────────────────────────────────────────────────────────
  async function openConfig() {
    if (!ed.isTTY) {
      console.log(`  ${C.dim}/config needs an interactive terminal.${C.reset}`);
      return;
    }
    const onoff = (b) => (b ? "on" : "off");
    const items = [
      { label: "Theme", value: () => `${ui.THEMES[settings.theme || "rin"].label} ›` },
      { label: "Show thinking", value: () => onoff(settings.showThoughts) },
      { label: "Tool output", value: () => settings.toolDetail },
      { label: "Spinner animation", value: () => onoff(settings.animations) },
      { label: "Input hints", value: () => onoff(settings.hints) },
    ];
    await ed.menu({
      title: "Settings",
      intro: ["Changes apply immediately and are saved."],
      numbered: false,
      rows: () => items.map((it) => ({ label: it.label, value: it.value() })),
      onActivate: async (i) => {
        if (i === 0) await pickTheme();
        else if (i === 1) changeSetting("showThoughts", !settings.showThoughts);
        else if (i === 2) changeSetting("toolDetail", settings.toolDetail === "compact" ? "full" : "compact");
        else if (i === 3) changeSetting("animations", !settings.animations);
        else if (i === 4) changeSetting("hints", !settings.hints);
        return "stay";
      },
    });
  }

  // First run: let them choose a look before the welcome card.
  if (interactive && ed.isTTY && settings.theme == null) await pickTheme({ first: true });

  const existingSessions = listSessions(projectDir);
  ui.welcome({
    projectDir,
    mode: modeLabel(),
    sessionCount: existingSessions.length,
    lastGoal: existingSessions[0] && existingSessions[0].goal,
    memoryConfigured: !!(cfg.supabaseUrl && cfg.supabaseServiceRoleKey),
    version,
    inOwnSource,
  });

  // Suggestions shown under the box while typing "/…".
  function suggest(line) {
    if (!line.includes(" ")) return COMMANDS.filter((c) => c.value.startsWith(line));
    const cmd = line.split(" ")[0];
    const arg = line.slice(cmd.length + 1);
    let pool = [];
    if (["/resume", "/clear", "/compact"].includes(cmd)) pool = listSessions(projectDir).map((s) => s.id);
    else if (cmd === "/model") pool = ["auto", ...listModels().map((m) => m.key)];
    else if (cmd === "/theme") pool = ui.THEME_ORDER;
    return pool.filter((p) => p.startsWith(arg)).map((p) => ({ value: `${cmd} ${p}`, desc: "" }));
  }

  const renderer = ui.createRenderer();
  const onEvent = renderer.onEvent;
  const history = loadHistoryLines();

  let activeGoal = null;
  let activeSessionId = null;
  let running = false;

  function onCheckpoint(payload) {
    saveSession(projectDir, activeSessionId, { ...payload, goal: activeGoal });
  }

  function interrupted() {
    renderer.stop();
    console.log(
      `\n\n  ${T.warn}■ Interrupted${C.reset} ${C.dim}— last completed step saved${activeSessionId ? ` as ${C.reset}${C.bold}${activeSessionId}${C.reset}${C.dim}` : ""}.${C.reset}`
    );
    console.log(`  ${C.dim}Pick up with ${C.reset}${C.bold}rin --continue${C.reset}${C.dim} (latest) or ${C.reset}${C.bold}rin --resume${C.reset}${C.dim} (choose from a list).${C.reset}\n`);
    process.exit(130);
  }

  // The editor handles Ctrl+C itself at the prompt; this covers runs and any
  // cooked-mode moment (status checks, shell commands).
  process.on("SIGINT", () => {
    if (running) interrupted();
    else {
      console.log();
      process.exit(0);
    }
  });

  // Shared tail for fresh and resumed runs: ask_human loop, session cleanup,
  // change summary, footer.
  async function finishRun(result, t0) {
    if (result.status === "blocked") {
      running = false;
      const r = await ed.readInput({
        title: "answer",
        ask: true,
        placeholder: "type your answer",
        right: "enter sends",
        hintLeft: "Rin is waiting on you",
      });
      if (r.kind === "exit") interrupted();
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
        humanAnswer: r.text,
      });
      return finishRun(next, t0);
    }

    if (result.status === "done") {
      clearSession(projectDir, activeSessionId);
      await printChangeSummary(projectDir, result.readState);
    } else if (result.status === "failed" || result.status === "step_limit") {
      console.log(
        `\n  ${C.dim}Progress saved as ${C.reset}${C.bold}${T.warn}${activeSessionId}${C.reset}${C.dim} — ${C.reset}${C.bold}/continue${C.reset}${C.dim} or ${C.reset}${C.bold}/resume${C.reset}${C.dim} to pick it back up.${C.reset}`
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
    activeGoal = goal;
    activeSessionId = newSessionId();
    return tracked(() => runAgentLoop({ goal, sandboxDir: projectDir, cfg, model, onEvent, onCheckpoint }));
  }

  async function resumeById(sessionId) {
    const session = loadSession(projectDir, sessionId);
    if (!session || !session.history) {
      console.log(`  ${T.warn}No saved session with id "${sessionId}" in this directory.${C.reset}`);
      return null;
    }
    activeGoal = session.goal || "(resumed session)";
    activeSessionId = sessionId;
    model = session.model;
    console.log(`\n  ${C.dim}Resuming${C.reset} ${T.warn}${sessionId}${C.reset} ${C.dim}· step ${session.steps} · ${fmtAgo(session.updatedAt)}${C.reset}`);
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
      console.log(`  ${T.warn}No previous session found for this directory.${C.reset}`);
      return null;
    }
    return resumeById(latest.id);
  }

  async function resumePicker(presetId) {
    const sessions = listSessions(projectDir);
    if (!sessions.length) {
      console.log(`  ${T.warn}No saved sessions for this directory.${C.reset}`);
      return null;
    }
    if (presetId) return resumeById(presetId);

    if (ed.isTTY) {
      const idx = await ed.menu({
        title: "Resume a session",
        intro: [`${sessions.length} saved in this folder, newest first.`],
        rows: sessions.map((s) => ({
          tag: s.id,
          label: s.goal || "(no goal recorded)",
          hint: `${s.steps ?? "?"} steps · ${fmtAgo(s.updatedAt)}`,
        })),
      });
      if (idx === -1) {
        console.log(`  ${C.dim}Cancelled.${C.reset}`);
        return null;
      }
      return resumeById(sessions[idx].id);
    }

    sectionHeader("Saved sessions");
    sessions.forEach((s, i) => console.log(fmtSessionLine(s, i + 1)));
    const r = await ed.readInput({ title: "resume", placeholder: "number or id" });
    const answer = r.kind === "submit" ? r.text.trim() : "";
    if (!answer) return null;
    const byIndex = /^\d+$/.test(answer) ? sessions[parseInt(answer, 10) - 1] : null;
    const chosen = byIndex || sessions.find((s) => s.id === answer);
    if (!chosen) {
      console.log(`  ${T.err}No session matches "${answer}".${C.reset}`);
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
    row("theme", ui.THEMES[settings.theme || "rin"].label);
    const sessions = listSessions(projectDir);
    row("sessions", sessions.length ? `${T.warn}${sessions.length}${C.reset} saved` : `${C.dim}none${C.reset}`);
    sessions.slice(0, 5).forEach((s) => console.log(fmtSessionLine(s)));
    if (sessions.length > 5) console.log(`  ${C.dim}… and ${sessions.length - 5} more (/resume to see all)${C.reset}`);
    process.stdout.write(`  ${C.dim}${"memory".padEnd(10)}${C.reset}${C.dim}checking…${C.reset}`);
    try {
      await Promise.race([
        memory.resolveUserId(cfg),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 6s")), 6000)),
      ]);
      process.stdout.write(`\r  ${C.dim}${"memory".padEnd(10)}${C.reset}${T.ok}connected${C.reset}                    \n`);
    } catch (err) {
      process.stdout.write(`\r  ${C.dim}${"memory".padEnd(10)}${C.reset}${T.err}unavailable${C.reset} ${C.dim}${fit(err.message, 40)}${C.reset}\n`);
    }
  }

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms))]);

  function memoryProblem(err) {
    console.log(`  ${T.err}✗${C.reset} Memory unavailable`);
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
        console.log(`  ${T.ok}●${C.reset} Linked, but nothing stored yet.`);
        console.log(`    ${C.dim}/remember <text> to add something.${C.reset}`);
        return;
      }
      for (const r of rows) {
        console.log(`  ${C.dim}${fit(r.category, 16).padEnd(16)}${C.reset}${C.bold}${fit(r.key, 22)}${C.reset}`);
        for (const l of ui.wrap(String(r.value), ui.termWidth() - 8).slice(0, 2)) console.log(`      ${C.dim}${l}${C.reset}`);
      }
      console.log(`\n  ${T.ok}●${C.reset} ${C.dim}${rows.length} strongest memories · shared with the Telegram bot${C.reset}`);
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
      console.log(`  ${T.ok}✓${C.reset} ${r.action === "reinforced" ? "Reinforced" : "Remembered"} ${C.dim}fact/${key}${C.reset}`);
    } catch (err) {
      memoryProblem(err);
    }
  }

  // `!ls -la` — run a shell command directly, rendered on the run rail.
  async function runShellLine(cmd) {
    if (!cmd) {
      console.log(`  ${C.dim}Usage: !<shell command>${C.reset}`);
      return;
    }
    ui.emit(`\n  ${T.brand}$${C.reset} ${fit(cmd, ui.termWidth() - 6)}`);
    const r = await tools.runShell(projectDir, cmd);
    const text = String(r.output || "").replace(/\s+$/, "");
    const lines = text ? text.split("\n") : ["(no output)"];
    for (const l of lines.slice(0, 40)) ui.emit(`    ${C.dim}${fit(l, ui.termWidth() - 8)}${C.reset}`);
    if (lines.length > 40) ui.emit(`    ${C.dim}… +${lines.length - 40} more lines${C.reset}`);
    ui.emit("");
    ui.closeBar(r.ok ? "done" : "exited with an error", r.ok);
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
    console.log(`  ${T.ok}✓${C.reset} Compacted ${T.warn}${target.id}${C.reset} ${C.dim}${before} → ${compacted.length} messages${C.reset}`);
  }

  function pinModel(key) {
    if (key === "auto") {
      model = undefined;
      console.log(`  ${T.ok}✓${C.reset} Auto mode — planner/executor on the free tier`);
    } else {
      model = key;
      console.log(`  ${T.ok}✓${C.reset} Pinned to ${C.bold}${key}${C.reset}`);
    }
  }

  async function handleModelCommand(rest) {
    const models = listModels();
    if (rest) {
      if (rest !== "auto" && !models.find((m) => m.key === rest)) {
        console.log(`  ${T.err}Unknown model "${rest}"${C.reset} ${C.dim}— /model lists them${C.reset}`);
        return;
      }
      return pinModel(rest);
    }
    if (ed.isTTY) {
      const keys = ["auto", ...models.map((m) => m.key)];
      const idx = await ed.menu({
        title: "Model",
        intro: ["auto uses the planner → executor split on free tiers. Pick one to pin a single model."],
        rows: [
          { label: "auto", hint: "free planner → executor chain", current: !model },
          ...models.map((m) => ({ label: m.key, hint: `${m.tier === "paid" ? "paid" : "free"} · ${m.label}`, current: m.key === model })),
        ],
        initial: Math.max(0, keys.indexOf(model || "auto")),
      });
      if (idx === -1) console.log(`  ${C.dim}Model unchanged.${C.reset}`);
      else pinModel(keys[idx]);
      return;
    }
    sectionHeader("Models");
    for (const m of models) {
      const current = m.key === model ? `  ${T.ok}● current${C.reset}` : "";
      console.log(`  ${C.bold}${m.key.padEnd(14)}${C.reset}${C.dim}${m.tier === "paid" ? "paid" : "free"} ${fit(m.label, ui.termWidth() - 26)}${C.reset}${current}`);
    }
  }

  // Echo a submitted-from-argv goal in the same closed box the editor draws.
  function echoGoal(goal) {
    const rows = ui.wrap(goal, ui.termWidth() - 6);
    console.log("\n" + ui.inputFrame({ texts: rows.length ? rows : [""], kind: "normal", title: "rin" }).join("\n"));
  }

  if (args.cont) {
    await continueLatest();
    ed.close();
    return;
  }
  if (args.resume) {
    await resumePicker(args.resumeId);
    ed.close();
    return;
  }
  if (goalFromArgv) {
    echoGoal(goalFromArgv);
    appendHistoryLine(goalFromArgv);
    await runGoal(goalFromArgv);
    ed.close();
    return;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await ed.readInput({
      title: "rin",
      right: modeLabel(),
      history,
      suggest,
      hints: settings.hints,
      placeholder: "Describe what to build or fix",
    });
    if (r.kind === "exit") {
      console.log();
      break;
    }
    const raw = r.text.trim();
    if (!raw) continue;
    if (history[history.length - 1] !== raw) history.push(raw);
    appendHistoryLine(raw);

    if (raw.startsWith("!")) {
      await runShellLine(raw.slice(1).trim());
      continue;
    }
    const line = normalizeLine(raw);
    if (line === "/exit" || line === "/quit") break;
    if (line === "/help") {
      printHelp();
      continue;
    }
    if (line === "/theme" || line.startsWith("/theme ")) {
      await handleTheme(line.slice(6).trim());
      continue;
    }
    if (line === "/config" || line === "/settings") {
      await openConfig();
      continue;
    }
    if (line === "/model" || line.startsWith("/model ")) {
      await handleModelCommand(line.slice(6).trim());
      continue;
    }
    if (line === "/clear" || line.startsWith("/clear ")) {
      const idArg = line.slice(6).trim();
      const target = idArg || (latestSession(projectDir) || {}).id;
      const cleared = target ? clearSession(projectDir, target) : false;
      console.log(cleared ? `  ${T.ok}✓${C.reset} Cleared ${T.warn}${target}${C.reset}` : `  ${C.dim}No saved session to clear.${C.reset}`);
      continue;
    }
    if (line === "/continue") {
      await continueLatest();
      continue;
    }
    if (line === "/resume" || line.startsWith("/resume ")) {
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
    if (line === "/remember" || line.startsWith("/remember ")) {
      await rememberText(line.slice(9).trim());
      continue;
    }
    if (line === "/compact" || line.startsWith("/compact ")) {
      await compactSession(line.slice(8).trim() || undefined);
      continue;
    }
    if (line.startsWith("/") && !line.includes(" ") && line.length < 20) {
      console.log(`  ${T.warn}Unknown command ${line}${C.reset} ${C.dim}— /help lists them${C.reset}`);
      continue;
    }
    await runGoal(line);
  }
  ed.close();
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.stack || err.message}${C.reset}`);
  process.exit(1);
});
