// ui.js — everything about how Rin looks. Kept separate from cli.js (which
// is about what Rin does) so the visual system lives in exactly one place:
// themes, boxes, welcome card, input box, pickers, tool-call rendering.

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

// ── Themes ──────────────────────────────────────────────────────────────────
// A colour is either [r,g,b] (truecolor) or a raw escape string (16-colour).
const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const col = (x) => (Array.isArray(x) ? rgb(x[0], x[1], x[2]) : x || "");

const THEMES = {
  rin: {
    label: "Rin",
    desc: "violet → aqua",
    brand: [192, 132, 252],
    accent: [34, 211, 238],
    warn: [250, 204, 21],
    ok: [74, 222, 128],
    err: [248, 113, 113],
    text: "\x1b[97m",
    logo: [[192, 132, 252], [34, 211, 238]],
  },
  ocean: {
    label: "Ocean",
    desc: "blue → teal",
    brand: [96, 165, 250],
    accent: [45, 212, 191],
    warn: [251, 191, 36],
    ok: [52, 211, 153],
    err: [251, 113, 133],
    text: "\x1b[97m",
    logo: [[96, 165, 250], [45, 212, 191]],
  },
  sunset: {
    label: "Sunset",
    desc: "coral → amber",
    brand: [251, 113, 133],
    accent: [251, 146, 60],
    warn: [250, 204, 21],
    ok: [163, 230, 53],
    err: [239, 68, 68],
    text: "\x1b[97m",
    logo: [[244, 114, 182], [251, 191, 36]],
  },
  light: {
    label: "Light",
    desc: "for light backgrounds",
    brand: [109, 40, 217],
    accent: [14, 116, 144],
    warn: [180, 83, 9],
    ok: [21, 128, 61],
    err: [185, 28, 28],
    text: "\x1b[39m",
    logo: [[109, 40, 217], [14, 116, 144]],
  },
  mono: {
    label: "Mono",
    desc: "no colour, just weight",
    brand: "",
    accent: "\x1b[1m",
    warn: "\x1b[1m",
    ok: "",
    err: "\x1b[1m",
    text: "\x1b[39m",
    logo: null,
  },
  ansi: {
    label: "ANSI",
    desc: "16 basic colours, max compatibility",
    brand: "\x1b[35m",
    accent: "\x1b[36m",
    warn: "\x1b[33m",
    ok: "\x1b[32m",
    err: "\x1b[31m",
    text: "\x1b[39m",
    logo: null,
  },
};
const THEME_ORDER = ["rin", "ocean", "sunset", "light", "mono", "ansi"];

// The live palette. Everything reads T.x at draw time, so switching theme
// (even mid-picker, for the live preview) restyles the next frame.
const T = {};
function setTheme(id) {
  const th = THEMES[id] || THEMES.rin;
  T.id = THEMES[id] ? id : "rin";
  T.brand = col(th.brand);
  T.accent = col(th.accent);
  T.warn = col(th.warn);
  T.ok = col(th.ok);
  T.err = col(th.err);
  T.text = col(th.text);
  T.border = `${C.dim}${T.brand}`;
  T.borderHi = T.brand;
  T.logo = th.logo;
  return T.id;
}
setTheme(process.env.NO_COLOR ? "mono" : "rin");

// Behaviour switches from /config (see settings.js).
const S = { showThoughts: true, toolDetail: "compact", animations: true, hints: true };
function applySettings(s) {
  if (!s) return;
  if (s.theme) setTheme(s.theme);
  for (const k of Object.keys(S)) if (k in s) S[k] = s[k];
}

// ── Text helpers ────────────────────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const vlen = (s) => s.replace(ANSI_RE, "").length;
// Leave a 2-column margin: a line exactly as wide as the terminal sits in the
// "pending wrap" state, which Termux (and copy/paste out of it) treats as a
// soft-wrapped line — that's what glued box edges and the prompt together.
const termWidth = () => Math.min(Math.max((process.stdout.columns || 62) - 2, 24), 72);

// Inline markdown-lite for text the model writes: **bold** and `code`.
function md(line) {
  return String(line)
    .replace(/`([^`]+)`/g, `${T.accent}$1${C.reset}`)
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

// Gradient across a string; themes without a gradient get a solid brand colour.
function gradientText(text, from, to) {
  if (!Array.isArray(from) || !Array.isArray(to)) return `${C.bold}${T.brand}${text}${C.reset}`;
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
const brandGradient = (text) => (T.logo ? gradientText(text, T.logo[0], T.logo[1]) : `${C.bold}${T.brand}${text}${C.reset}`);

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
  console.log(`\n${C.bold}${T.text}${title}${C.reset}`);
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

// ── Boxes ───────────────────────────────────────────────────────────────────
// Every returned line is exactly `width` visible columns, so the right edge
// always lines up. `lines` are already-styled strings; they get clipped and
// padded to the inner width (width - 4: border + space on each side).
function frame(lines, { width = termWidth(), title = "", color = T.border } = {}) {
  const cw = width - 4;
  const edge = (s) => `${color}${s}${C.reset}`;
  const out = [];
  if (title) {
    const t = clipAnsi(title, Math.max(1, width - 6));
    const fill = Math.max(0, width - 5 - vlen(t));
    out.push(`${edge("╭─")} ${t} ${edge("─".repeat(fill) + "╮")}`);
  } else {
    out.push(edge("╭" + "─".repeat(width - 2) + "╮"));
  }
  for (const raw of lines) {
    const line = clipAnsi(raw, cw);
    const pad = " ".repeat(Math.max(0, cw - vlen(line)));
    out.push(`${edge("│")} ${line}${C.reset}${pad} ${edge("│")}`);
  }
  out.push(edge("╰" + "─".repeat(width - 2) + "╯"));
  return out;
}

// Kept for older callers/tests: print a plain dim box.
function box(lines, width) {
  return frame(lines, { width, color: `${C.dim}` }).join("\n");
}

// One dim row under a box: hint on the left, mode on the right.
function hintRow({ left = "", right = "", leftStyle = "", width = termWidth() } = {}) {
  const avail = width - 2;
  if (right && right.length + 4 > avail) right = "";
  if (right && left && left.length + right.length + 2 > avail) right = "";
  if (left && left.length + (right ? right.length + 2 : 0) > avail) left = fit(left, avail - (right ? right.length + 2 : 0));
  const gap = Math.max(1, avail - left.length - right.length);
  const l = left ? `${leftStyle || C.dim}${left}${C.reset}` : "";
  const r = right ? `${C.dim}${right}${C.reset}` : "";
  return `  ${l}${" ".repeat(gap)}${r}`;
}

// ── The run rail ────────────────────────────────────────────────────────────
// Everything Rin does during a run hangs off one vertical bar on the left,
// opened under the submitted input box and closed by the footer's ╰.
// `emit` turns any line starting with two spaces into a bar line, so
// renderers just write indented text.
const bar = () => `${T.border}│${C.reset}`;

function emit(s = "") {
  for (const seg of String(s).split("\n")) {
    if (seg === "") console.log(bar());
    else if (seg.startsWith("  ")) console.log(bar() + seg.slice(1));
    else console.log(seg);
  }
}

function gutterSection(title) {
  emit(`\n  ${C.bold}${T.text}${title}${C.reset}`);
}

function closeBar(text, ok = true) {
  console.log(`${T.border}╰${C.reset} ${ok ? T.ok : T.warn}${ok ? "✓" : "■"}${C.reset} ${C.dim}${text}${C.reset}`);
}

// ── The logo ────────────────────────────────────────────────────────────────
// Original block-letter mark, drawn with half-blocks (3 rows × 17 cols).
const LOGO = [
  "█▀▀▀▄  ▀█▀  █▄  █",
  "█▄▄▄▀   █   █ ▀▄█",
  "█  ▀▄  ▄█▄  █   █",
];

function paintLogo(rows) {
  const W = Math.max(...rows.map((r) => r.length));
  const H = rows.length;
  return rows.map((row, y) => {
    let out = "";
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === " ") {
        out += " ";
        continue;
      }
      if (T.logo) {
        const t = Math.min(1, (x / (W - 1)) * 0.75 + (y / (H - 1)) * 0.25);
        const [a, b] = T.logo;
        out += rgb(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)) + ch;
      } else {
        out += T.brand + ch;
      }
    }
    return `${C.bold}${out}${C.reset}`;
  });
}

// ── Welcome card ────────────────────────────────────────────────────────────
function welcomeLines({ projectDir, mode, sessionCount, lastGoal, memoryConfigured, width = termWidth() }) {
  const cw = width - 4;
  const logo = paintLogo(LOGO);
  const logoW = LOGO[0].length;
  const side = [`${C.bold}${T.text}agentic coding${C.reset}`, `${C.dim}in your terminal${C.reset}`, `${C.dim}free-tier · shared memory${C.reset}`];
  const wide = cw >= logoW + 3 + 26;

  const out = [""];
  if (wide) {
    for (let i = 0; i < logo.length; i++) out.push(`${logo[i]}   ${side[i]}`);
  } else {
    for (const l of logo) out.push(l);
    for (const s of side) out.push(s);
  }
  out.push("");

  const label = (k) => `${C.dim}${k.padEnd(8)}${C.reset}`;
  const avail = cw - 8;
  out.push(`${label("cwd")}${shortPath(projectDir, avail)}`);
  out.push(`${label("mode")}${fit(mode, avail)}`);
  out.push(
    `${label("memory")}${memoryConfigured ? `${T.ok}●${C.reset} linked ${C.dim}· /memory${C.reset}` : `${C.dim}○ not configured${C.reset}`}`
  );
  if (sessionCount) {
    out.push(`${label("resume")}${T.warn}↳${C.reset} ${fit(lastGoal || "last session", avail - 2)}`);
    out.push(`${label("")}${C.dim}${fit(`${sessionCount} saved · /continue · /resume`, avail)}${C.reset}`);
  }
  out.push("");
  return out;
}

function welcome({ projectDir, mode, sessionCount, lastGoal, memoryConfigured, version, inOwnSource }) {
  const w = termWidth();
  const title = `${C.bold}${T.text}Rin${C.reset}${version ? ` ${C.dim}v${version}${C.reset}` : ""}`;
  console.log();
  console.log(frame(welcomeLines({ projectDir, mode, sessionCount, lastGoal, memoryConfigured, width: w }), { width: w, title, color: T.border }).join("\n"));
  console.log(hintRow({ left: "/help · /theme · /config · ctrl+c twice exits", width: w }));
  if (inOwnSource) {
    for (const [i, l] of wrap("⚠ You're inside Rin's own source folder — edits here change the tool itself. cd to a project folder first.", w - 4).entries()) {
      console.log(`  ${i === 0 ? T.warn : C.dim}${l}${C.reset}`);
    }
  }
}

// ── The input box ───────────────────────────────────────────────────────────
//   ╭─ rin ────────────────────────────╮
//   │ ❯ type here…                     │
//   ╰──────────────────────────────────╯
//     / commands · ! shell     auto · planner → executor
// `texts` are the (plain) visible rows, `firstIndex` the global index of the
// first one (the glyph only shows on global row 0).
function inputFrame({ texts, firstIndex = 0, kind = "normal", title = "rin", placeholder = "", width = termWidth() }) {
  const shell = kind === "shell";
  const ask = kind === "ask";
  const glyph = shell ? `${C.bold}${T.warn}!${C.reset}` : ask ? `${C.bold}${T.warn}?${C.reset}` : `${C.bold}${T.accent}❯${C.reset}`;
  const color = shell || ask ? T.warn : T.borderHi;
  const ttl = shell ? `${C.bold}${T.warn}shell${C.reset}` : ask ? `${C.bold}${T.warn}${title}${C.reset}` : brandGradient(title);
  const lines = texts.map((t, i) => {
    const lead = firstIndex + i === 0 ? `${glyph} ` : "  ";
    return `${lead}${t}`;
  });
  if (!lines.length) lines.push(`${glyph} `);
  if (placeholder && texts.length === 1 && texts[0] === "" && firstIndex === 0) {
    lines[0] = `${glyph} ${C.dim}${fit(placeholder, width - 6)}${C.reset}`;
  }
  return frame(lines, { width, title: ttl, color });
}

// Command/argument suggestions shown under the box while typing "/".
function suggestLines(items, sel, width = termWidth(), maxRows = 7) {
  const total = items.length;
  let start = 0;
  if (total > maxRows) start = Math.min(Math.max(0, sel - Math.floor(maxRows / 2)), total - maxRows);
  const shown = items.slice(start, start + maxRows);
  const vw = Math.min(Math.max(...items.map((i) => i.value.length)), Math.floor(width / 2));
  const out = shown.map((it, k) => {
    const on = start + k === sel;
    const v = fit(it.value, vw).padEnd(vw);
    const d = it.desc ? fit(it.desc, Math.max(0, width - vw - 8)) : "";
    return on
      ? `  ${T.brand}${C.bold}❯ ${v}${C.reset}  ${T.text}${d}${C.reset}`
      : `    ${C.dim}${v}  ${d}${C.reset}`;
  });
  if (total > maxRows) out.push(`  ${C.dim}  ${start + shown.length < total ? `↓ ${total - start - shown.length} more` : `↑ ${start} above`} · tab completes${C.reset}`);
  return out.map((l) => clipAnsi(l, width));
}

// ── Pickers (the numbered ❯ lists) ──────────────────────────────────────────
// rows: [{ label, hint?, value?, tag?, current? }]
//   hint  — dim text on the right      value — right-aligned setting value
//   tag   — short coloured text before the label (e.g. a session id)
function menuFrame({ title, intro = [], rows, sel, numbered = true, preview = [], width = termWidth() }) {
  const cw = width - 4;
  const body = [];
  for (const p of intro) for (const l of wrap(p, cw)) body.push(`${C.dim}${l}${C.reset}`);
  if (intro.length) body.push("");

  const numW = String(rows.length).length;
  rows.forEach((r, i) => {
    const on = i === sel;
    const lead = on ? `${T.brand}${C.bold}❯${C.reset} ` : "  ";
    const num = numbered ? `${on ? T.brand : C.dim}${String(i + 1).padStart(numW)}.${C.reset} ` : "";
    const numLen = numbered ? numW + 2 : 0;
    const tag = r.tag ? `${r.tag}  ` : "";
    const tick = r.current ? " ✔" : "";
    const right = r.value != null ? String(r.value) : r.hint || "";
    const used = 2 + numLen + tag.length + tick.length;

    let label = String(r.label);
    let rightText = right;
    if (rightText) {
      const maxRight = r.value != null ? rightText.length : Math.max(0, cw - used - Math.min(label.length, 12) - 3);
      rightText = fit(rightText, maxRight);
    }
    const labelMax = Math.max(4, cw - used - (rightText ? rightText.length + 2 : 0));
    label = fit(label, labelMax);
    const gap = Math.max(1, cw - used - label.length - rightText.length);

    const tagS = r.tag ? `${T.warn}${r.tag}${C.reset}  ` : "";
    const labelS = on ? `${C.bold}${T.brand}${label}${C.reset}` : `${T.text}${label}${C.reset}`;
    const tickS = r.current ? ` ${T.ok}✔${C.reset}` : "";
    const rightS = rightText ? `${r.value != null && on ? T.accent : C.dim}${rightText}${C.reset}` : "";
    body.push(`${lead}${num}${tagS}${labelS}${tickS}${" ".repeat(gap)}${rightS}`);
  });
  if (preview.length) {
    body.push("");
    for (const p of preview) body.push(p);
  }
  return frame(body, { width, title: `${C.bold}${T.text}${title}${C.reset}`, color: T.borderHi });
}

// A little sample of how a run looks, for the theme picker's live preview.
function previewLines() {
  return [
    `${C.dim}preview${C.reset}`,
    `${T.brand}◆ planner${C.reset} ${C.dim}groq · 1.2s${C.reset}`,
    `${T.accent}●${C.reset} ${C.bold}Edit${C.reset} src/app.js`,
    `  ${T.err}-${C.reset} ${C.dim}const total = a + b${C.reset}`,
    `  ${T.ok}+${C.reset} ${C.dim}const total = add(a, b)${C.reset}`,
    `${T.ok}✓${C.reset} ${C.bold}Done${C.reset} ${C.dim}· ${T.warn}⚠${C.reset}${C.dim} warning · ${T.err}✗${C.reset}${C.dim} error${C.reset}`,
  ];
}

// ── Spinner ─────────────────────────────────────────────────────────────────
class Spinner {
  constructor(label) {
    this.label = label;
    this.frame = 0;
    this.start = Date.now();
    this.timer = null;
    this.drawn = false;
  }
  go() {
    if (!process.stdout.isTTY) return;
    if (!S.animations) {
      process.stdout.write(`${bar()} ${T.accent}◌${C.reset} ${C.dim}${this.label}…${C.reset}`);
      this.drawn = true;
      return;
    }
    const FR = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this.timer = setInterval(() => {
      process.stdout.write(
        `\r${bar()} ${T.accent}${FR[this.frame % FR.length]}${C.reset} ${C.dim}${this.label} · ${fmtDuration(Date.now() - this.start)}${C.reset}   `
      );
      this.frame++;
      this.drawn = true;
    }, 80);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.drawn) {
      this.drawn = false;
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
  const full = () => S.toolDetail === "full";

  function diffLines(text, sign, color) {
    const max = full() ? 12 : 5;
    const lines = String(text ?? "").split("\n");
    for (const l of lines.slice(0, max)) {
      emit(`      ${color}${sign}${C.reset} ${C.dim}${fit(l, w() - 10)}${C.reset}`);
    }
    if (lines.length > max) emit(`      ${C.dim}  … +${lines.length - max} more lines${C.reset}`);
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
            ? `${T.brand}◆ planner${C.reset}`
            : role === "executor"
              ? `${T.accent}◆ executor${C.reset}`
              : `${C.gray}◆ model${C.reset}`;
        emit(`\n  ${tag} ${C.dim}${name} · ${fmtMs(payload.ms)}${C.reset}`);
        break;
      }

      case "thought": {
        if (!payload || !S.showThoughts) break;
        const max = full() ? 6 : 3;
        const lines = wrap(payload, w() - 6);
        const shown = lines.slice(0, max);
        if (lines.length > max) shown[max - 1] = fit(shown[max - 1], w() - 7) + "…";
        for (const l of shown) emit(`    ${C.italic}${C.dim}${l.replace(/[`*]/g, "")}${C.reset}`);
        break;
      }

      case "action": {
        stopSpinner();
        const raw = String(payload.action);
        const exec = raw.startsWith("executor:");
        const name = exec ? raw.slice(9) : raw;
        lastName = name;
        const args = payload.args || {};
        const dot = exec ? T.accent : T.brand;
        const verb = VERBS[name] || name;
        const target = fit(firstStringArg(args), w() - verb.length - 12);
        let extra = "";
        if (name === "write_file" && typeof args.content === "string") {
          extra = ` ${C.dim}· ${args.content.replace(/\n$/, "").split("\n").length} lines${C.reset}`;
        }
        emit(`  ${dot}●${C.reset} ${C.bold}${verb}${C.reset} ${C.dim}${name === "instruct" ? "→ " : ""}${C.reset}${target}${extra}`);
        if (name === "instruct" && typeof args.task === "string") {
          const tl = wrap(args.task, w() - 8);
          const max = full() ? 6 : 2;
          for (const l of tl.slice(0, max)) emit(`    ${C.dim}${l}${C.reset}`);
          if (tl.length > max) emit(`    ${C.dim}…${C.reset}`);
        }
        if (name === "edit_file" && args.old_str != null) {
          diffLines(args.old_str, "-", T.err);
          diffLines(args.new_str, "+", T.ok);
        }
        break;
      }

      case "result": {
        const out = String(payload.output ?? "").replace(/\s+$/, "");
        const lines = out ? out.split("\n") : [];
        const showAll = lastName === "run_shell" || lastName === "run_tests";
        const limit = full() ? 16 : 6;
        const collapseOk = payload.ok && !showAll && !full();
        let shown;
        if (lines.length <= (collapseOk ? 1 : limit)) shown = lines.map((t) => ({ t }));
        else if (collapseOk) shown = [{ t: lines[0] }, { more: lines.length - 1 }];
        else {
          const head = limit - 2;
          shown = [...lines.slice(0, head).map((t) => ({ t })), { more: lines.length - head - 1 }, { t: lines[lines.length - 1] }];
        }
        if (!shown.length) shown = [{ t: "(no output)" }];
        const mark = payload.ok ? `${T.ok}✓${C.reset}` : `${T.err}✗${C.reset}`;
        shown.forEach((s, i) => {
          const lead = i === 0 ? `    ${C.dim}⎿${C.reset} ${mark} ` : "        ";
          if (s.more != null) emit(`        ${C.dim}… +${s.more} lines${C.reset}`);
          else emit(`${lead}${i === 0 && payload.ok ? "" : C.dim}${fit(s.t, w() - 12)}${C.reset}`);
        });
        break;
      }

      case "warn": {
        const ls = wrap(payload, w() - 6);
        emit(`  ${T.warn}⚠${C.reset} ${C.dim}${ls[0] || ""}${C.reset}`);
        for (const l of ls.slice(1, 4)) emit(`    ${C.dim}${l}${C.reset}`);
        break;
      }

      case "error": {
        stopSpinner();
        const ls = wrap(payload, w() - 6);
        emit(`  ${T.err}✗${C.reset} ${ls[0] || ""}`);
        for (const l of ls.slice(1, 6)) emit(`    ${C.dim}${l}${C.reset}`);
        if (ls.length > 6) emit(`    ${C.dim}…${C.reset}`);
        break;
      }

      case "blocked": {
        stopSpinner();
        emit(`\n  ${T.warn}${C.bold}? Rin needs your input${C.reset}`);
        for (const l of wrap(payload, w() - 6)) emit(`    ${md(l)}`);
        break;
      }

      case "done": {
        stopSpinner();
        emit(`\n  ${T.ok}${C.bold}✓ Done${C.reset}`);
        for (const l of wrap(payload, w() - 6)) emit(`    ${md(l)}`);
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
  emit("");
  closeBar(bits.join(" · "), ok);
  if (models) {
    for (const l of wrap(models, termWidth() - 4)) console.log(`  ${C.dim}${l}${C.reset}`);
  }
}

module.exports = {
  C,
  T,
  S,
  THEMES,
  THEME_ORDER,
  setTheme,
  applySettings,
  bar,
  emit,
  gutterSection,
  closeBar,
  LOGO,
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
  frame,
  hintRow,
  welcome,
  welcomeLines,
  inputFrame,
  suggestLines,
  menuFrame,
  previewLines,
  brandGradient,
  createRenderer,
  runFooter,
};
