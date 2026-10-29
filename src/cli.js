#!/usr/bin/env node
// cli.js — entry point. Interactive: `rin` with no args drops you into a
// prompt. One-shot: `rin "build a calculator app" --dir ./calc`.

const path = require("path");
const fs = require("fs");
const readline = require("readline");
const { loadConfig } = require("./config");
const { runAgentLoop } = require("./agent");
const { listModels } = require("./providers");

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

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--model") args.model = argv[++i];
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = args.dir ? path.resolve(args.dir) : process.cwd();
  fs.mkdirSync(projectDir, { recursive: true });

  const cfg = loadConfig(projectDir);
  let model = args.model;

  printBanner();
  console.log(`${C.dim}  → ${projectDir}${C.reset}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const onEvent = makeEventHandler();

  const goalFromArgv = args._.join(" ").trim();

  async function runGoal(goal) {
    const result = await runAgentLoop({ goal, sandboxDir: projectDir, cfg, model, onEvent });

    if (result.status === "blocked") {
      const answer = await ask(rl, `\n${C.yellow}  your answer ›${C.reset} `);
      return runAgentLoop({
        sandboxDir: projectDir,
        cfg,
        model,
        onEvent,
        initialHistory: result.history,
        initialSteps: result.steps,
        humanAnswer: answer,
      });
    }
    return result;
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

  if (goalFromArgv) {
    await runGoal(goalFromArgv);
    rl.close();
    return;
  }

  console.log(`${C.dim}  type a goal · /model to switch backend · /exit to quit${C.reset}\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = (await ask(rl, `${C.magenta}${C.bold}rin›${C.reset} `)).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line.startsWith("/model")) {
      await handleModelCommand(line.slice(6).trim());
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
