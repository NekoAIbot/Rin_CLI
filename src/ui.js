// ui.js — everything about how Rin looks. Kept separate from cli.js (which
// is about what Rin does) so the visual system lives in exactly one place:
// palette, welcome card, tool-call rendering, section headers, run footer.

const path = require("path");

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

const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const VIOLET = rgb(192, 132, 252); // planner / brand
const AQUA = rgb(34, 211, 238); // executor / prompt
const AMBER = rgb(250, 204, 21); // needs attention
const MINT = rgb(74, 222, 128); // success
const ROSE = rgb(248, 113, 113); // failure

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const vlen = (s) => s.replace(ANSI_RE, "").length;
// Leave a 2-column margin: a line exactly as wide as the terminal sits in the
// "pending wrap" state, which Termux (and copy/paste out of it) treats as a
// soft-wrapped line — that's what glued box edges and the prompt together.
const termWidth = () => Math.min(Math.max((process.stdout.columns || 62) - 2, 24), 72);

// Inline markdown-lite for text the model writes (summaries, thoughts):
// **bold** and `code`. Applied per wrapped line, so a marker pair split
// across a line break simply stays literal instead of corrupting colors.
function md(line) {
  return String(line)
    .replace(/`([^`]+)`/g, `${AQUA}$1${C.reset}`)
    .replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`);
}

function fmtMs(ms) {
  if (ms == null) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
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
  return `${Math.floor(h / 24)}d ago`;
}

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

// Plain-text helpers (operate BEFORE styling so widths stay exact).
function fit(text, max) {
  text = String(text);
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + "…";
}

function shortPath(p, max) {
  const home = process.env.HOME;
  const s = home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
  return s.length <= max ? s : "…" + s.slice(s.length - (max - 1));
}

function wrap(text, width) {
  const words = String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let cur = "";
  for (let w of words) {
    while (w.length > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= width) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function rule() {
  return `${C.dim}${"─".repeat(termWidth())}${C.reset}`;
}

function sectionHeader(title) {
  console.log(`\n${C.bold}${C.white}${title}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(Math.min(termWidth(), 56))}${C.reset}`);
}

// Cut a styled string to `max` VISIBLE characters, copying escape sequences
// through untouched so colors never leak or break.
function clipAnsi(s, max) {
  if (vlen(s) <= max) return s;
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (seen >= max - 1) break;
    out += s[i++];
    seen++;
  }
  return out + "…" + C.reset;
}

function box(lines, width) {
  const cw = width - 4;
  const out = [];
  out.push(`${C.dim}╭${"─".repeat(width - 2)}╮${C.reset}`);
  for (const raw of lines) {
    const line = clipAnsi(raw, cw);
    const pad = Math.max(0, cw - vlen(line));
    out.push(`${C.dim}│${C.reset} ${line}${" ".repeat(pad)} ${C.dim}│${C.reset}`);
  }
  out.push(`${C.dim}╰${"─".repeat(width - 2)}╯${C.reset}`);
  return out.join("\n");
}

const PROMPT_GLYPH = `${C.bold}${AQUA}❯${C.reset}`;
const ASK_GLYPH = `${C.bold}${AMBER}❯${C.reset}`;

function welcome({ projectDir, mode, sessionCount, lastGoal, memoryConfigured, version, inOwnSource }) {
  const w = termWidth();
  const cw = w - 4;
  const label = (k) => `${C.dim}${k.padEnd(9)}${C.reset}`;
  const rows = [
    `${C.bold}${gradientText("✻ rin", [192, 132, 252], [34, 211, 238])}${C.reset}${version ? `  ${C.dim}v${version}${C.reset}` : ""}`,
    `${C.dim}${fit("agentic coding · free-tier models · shared memory", cw)}${C.reset}`,
    "",
    `${label("cwd")}${shortPath(projectDir, cw - 9)}`,
    `${label("mode")}${fit(mode, cw - 9)}`,
    `${label("memory")}${memoryConfigured ? `${MINT}●${C.reset} linked ${C.dim}· /memory${C.reset}` : `${C.dim}○ not configured${C.reset}`}`,
  ];
  if (sessionCount) {
    rows.push("");
    rows.push(`${label("resume")}${AMBER}↳${C.reset} ${fit(lastGoal || "last session", cw - 12)}`);
    rows.push(`${label("")}${C.dim}${sessionCount} saved · /continue latest · /resume pick${C.reset}`);
  }
  console.log();
  console.log(box(rows, w));
  console.log(`  ${C.dim}${fit("/help commands · ↑ history · ctrl+c twice to exit", w - 4)}${C.reset}`);
  if (inOwnSource) {
    console.log(
      `\n  ${AMBER}⚠${C.reset} ${C.dim}You're inside Rin's own source folder — edits here change the tool itself. cd to a project folder first.${C.reset}`
    );
  }
  console.log();
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
    const FR = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.timer = setInterval(() => {
      process.stdout.write(
        `\r  ${AQUA}${FR[this.frame % FR.length]}${C.reset} ${C.dim}${this.label} · ${fmtDuration(Date.now() - this.start)}${C.reset}   `
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

const VERBS = {
  write_file: "Write",
  edit_file: "Edit",
  read_file: "Read",
  run_shell: "Run",
  run_tests: "Test",
  instruct: "Plan",
  ask_human: "Ask",
  remember: "Remember",
  git_status: "Git status",
  git_diff: "Git diff",
  git_commit: "Git commit",
  git_push: "Git push",
};

function firstStringArg(args) {
  if (!args || typeof args !== "object") return "";
  for (const k of ["path", "command", "cmd", "query", "message", "key"]) {
    if (typeof args[k] === "string") return args[k];
  }
  for (const v of Object.values(args)) if (typeof v === "string") return v;
  return "";
}

function createRenderer() {
  let spinner = null;
  let lastName = "";
  // role -> { provider -> call count } for the current run, so the footer can
  // say who actually did the work (and which fallbacks kicked in).
  let usage = {};
  const stopSpinner = () => {
    if (spinner) {
      spinner.stop();
      spinner = null;
    }
  };
  const w = () => termWidth();

  function diffLines(text, sign, color) {
    const lines = String(text ?? "").split("\n");
    const shown = lines.slice(0, 5);
    for (const l of shown) {
      console.log(`      ${color}${sign}${C.reset} ${C.dim}${fit(l, w() - 10)}${C.reset}`);
    }
    if (lines.length > 5) console.log(`      ${C.dim}  … +${lines.length - 5} more lines${C.reset}`);
  }

  function onEvent(type, payload) {
    switch (type) {
      case "thinking_start":
        stopSpinner();
        spinner = new Spinner("Thinking");
        spinner.go();
        break;

      case "model": {
        stopSpinner();
        const m = String(payload.usedModel);
        let role = null;
        let name = m;
        if (m.startsWith("planner:") || m.startsWith("executor:")) {
          const i = m.indexOf(":");
          role = m.slice(0, i);
          name = m.slice(i + 1);
        }
        const roleKey = role || "model";
        usage[roleKey] = usage[roleKey] || {};
        usage[roleKey][name] = (usage[roleKey][name] || 0) + 1;
        const tag =
          role === "planner"
            ? `${VIOLET}◆ planner${C.reset}`
            : role === "executor"
              ? `${AQUA}◆ executor${C.reset}`
              : `${C.gray}◆ model${C.reset}`;
        console.log(`\n  ${tag} ${C.dim}${name} · ${fmtMs(payload.ms)}${C.reset}`);
        break;
      }

      case "thought": {
        if (!payload) break;
        const lines = wrap(payload, w() - 6);
        const shown = lines.slice(0, 3);
        if (lines.length > 3) shown[2] = fit(shown[2], w() - 7) + "…";
        for (const l of shown) console.log(`    ${C.italic}${C.dim}${l.replace(/[`*]/g, "")}${C.reset}`);
        break;
      }

      case "action": {
        stopSpinner();
        const raw = String(payload.action);
        const exec = raw.startsWith("executor:");
        const name = exec ? raw.slice(9) : raw;
        lastName = name;
        const args = payload.args || {};
        const dot = exec ? AQUA : VIOLET;
        const verb = VERBS[name] || name;
        let target = fit(firstStringArg(args), w() - verb.length - 12);
        let extra = "";
        if (name === "write_file" && typeof args.content === "string") {
          extra = ` ${C.dim}· ${args.content.replace(/\n$/, "").split("\n").length} lines${C.reset}`;
        }
        console.log(`  ${dot}●${C.reset} ${C.bold}${verb}${C.reset} ${C.dim}${name === "instruct" ? "→ " : ""}${C.reset}${target}${extra}`);
        if (name === "instruct" && typeof args.task === "string") {
          const tl = wrap(args.task, w() - 8);
          for (const l of tl.slice(0, 2)) console.log(`    ${C.dim}${l}${C.reset}`);
          if (tl.length > 2) console.log(`    ${C.dim}…${C.reset}`);
        }
        if (name === "edit_file" && args.old_str != null) {
          diffLines(args.old_str, "-", ROSE);
          diffLines(args.new_str, "+", MINT);
        }
        break;
      }

      case "result": {
        const out = String(payload.output ?? "").replace(/\s+$/, "");
        const lines = out ? out.split("\n") : [];
        const showAll = lastName === "run_shell" || lastName === "run_tests";
        const limit = 6;
        let shown;
        if (lines.length <= (payload.ok && !showAll ? 1 : limit)) shown = lines.map((t) => ({ t }));
        else if (payload.ok && !showAll) shown = [{ t: lines[0] }, { more: lines.length - 1 }];
        else {
          const head = limit - 2;
          shown = [...lines.slice(0, head).map((t) => ({ t })), { more: lines.length - head - 1 }, { t: lines[lines.length - 1] }];
        }
        if (!shown.length) shown = [{ t: "(no output)" }];
        const mark = payload.ok ? `${MINT}✓${C.reset}` : `${ROSE}✗${C.reset}`;
        shown.forEach((s, i) => {
          const lead = i === 0 ? `    ${C.dim}⎿${C.reset} ${mark} ` : "        ";
          if (s.more != null) console.log(`        ${C.dim}… +${s.more} lines${C.reset}`);
          else console.log(`${lead}${i === 0 && payload.ok ? "" : C.dim}${fit(s.t, w() - 12)}${C.reset}`);
        });
        break;
      }

      case "warn": {
        const ls = wrap(payload, w() - 6);
        console.log(`  ${AMBER}⚠${C.reset} ${C.dim}${ls[0] || ""}${C.reset}`);
        for (const l of ls.slice(1, 4)) console.log(`    ${C.dim}${l}${C.reset}`);
        break;
      }

      case "error": {
        stopSpinner();
        const ls = wrap(payload, w() - 6);
        console.log(`  ${ROSE}✗${C.reset} ${ls[0] || ""}`);
        for (const l of ls.slice(1, 6)) console.log(`    ${C.dim}${l}${C.reset}`);
        if (ls.length > 6) console.log(`    ${C.dim}…${C.reset}`);
        break;
      }

      case "blocked": {
        stopSpinner();
        console.log(`\n  ${AMBER}${C.bold}? Rin needs your input${C.reset}`);
        for (const l of wrap(payload, w() - 6)) console.log(`    ${md(l)}`);
        break;
      }

      case "done": {
        stopSpinner();
        console.log(`\n  ${MINT}${C.bold}✓ Done${C.reset}`);
        for (const l of wrap(payload, w() - 6)) console.log(`    ${md(l)}`);
        break;
      }
    }
  }

  // "planner groq ×3 · executor groq ×4, nvidia ×1" — and resets for the next run.
  function takeUsage() {
    const order = ["planner", "executor", "model"];
    const parts = [];
    for (const role of order) {
      const m = usage[role];
      if (!m) continue;
      const list = Object.entries(m)
        .map(([n, c]) => `${n} ×${c}`)
        .join(", ");
      parts.push(`${role} ${list}`);
    }
    usage = {};
    return parts.join(" · ");
  }

  return { onEvent, stop: stopSpinner, takeUsage };
}

function runFooter({ status, steps, ms, models }) {
  const ok = status === "done";
  const bits = [ok ? "completed" : `stopped (${status})`];
  if (typeof steps === "number") bits.push(`${steps} step${steps === 1 ? "" : "s"}`);
  bits.push(fmtDuration(ms));
  console.log(`\n  ${ok ? MINT : AMBER}${ok ? "✓" : "■"}${C.reset} ${C.dim}${bits.join(" · ")}${C.reset}`);
  if (models) {
    for (const l of wrap(models, termWidth() - 4)) console.log(`    ${C.dim}${l}${C.reset}`);
  }
}

module.exports = {
  C,
  VIOLET,
  AQUA,
  AMBER,
  MINT,
  ROSE,
  PROMPT_GLYPH,
  ASK_GLYPH,
  vlen,
  md,
  clipAnsi,
  termWidth,
  fmtMs,
  fmtDuration,
  fmtAgo,
  fit,
  shortPath,
  wrap,
  rule,
  sectionHeader,
  box,
  welcome,
  createRenderer,
  runFooter,
};
