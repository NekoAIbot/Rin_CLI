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
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

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

function onEvent(type, payload) {
  switch (type) {
    case "model":
      console.log(`${C.dim}· using ${payload.usedModel}${C.reset}`);
      break;
    case "thought":
      if (payload) console.log(`${C.dim}${payload}${C.reset}`);
      break;
    case "action":
      console.log(`${C.cyan}→ ${payload.action}${C.reset} ${C.dim}${JSON.stringify(payload.args).slice(0, 200)}${C.reset}`);
      break;
    case "result":
      console.log(payload.ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`, trunc(payload.output));
      break;
    case "warn":
      console.log(`${C.yellow}⚠ ${payload}${C.reset}`);
      break;
    case "error":
      console.log(`${C.red}✗ ${payload}${C.reset}`);
      break;
    case "blocked":
      console.log(`${C.yellow}${C.bold}? ${payload}${C.reset}`);
      break;
    case "done":
      console.log(`${C.green}${C.bold}✓ Done:${C.reset} ${payload}`);
      break;
  }
}

function trunc(s, n = 500) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + `\n${C.dim}…(truncated)${C.reset}` : s;
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

  console.log(`${C.magenta}${C.bold}Rin CLI${C.reset} ${C.dim}— working in ${projectDir}${C.reset}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const goalFromArgv = args._.join(" ").trim();

  async function runGoal(goal) {
    const result = await runAgentLoop({
      goal,
      sandboxDir: projectDir,
      cfg,
      model,
      onEvent,
    });

    if (result.status === "blocked") {
      const answer = await ask(rl, `\n${C.yellow}Your answer: ${C.reset}`);
      const resumed = await runAgentLoop({
        sandboxDir: projectDir,
        cfg,
        model,
        onEvent,
        initialHistory: result.history,
        initialSteps: result.steps,
        humanAnswer: answer,
      });
      return resumed;
    }
    return result;
  }

  async function handleModelCommand(rest) {
    const models = listModels();
    if (!rest) {
      console.log(`${C.bold}Available models:${C.reset}`);
      for (const m of models) {
        const marker = m.key === model ? " (current)" : "";
        console.log(`  ${m.key}${marker} ${C.dim}— ${m.label} [${m.tier}]${C.reset}`);
      }
      console.log(`${C.dim}Use "/model <key>" to switch, or "/model auto" for the free fallback chain.${C.reset}`);
      return;
    }
    if (rest === "auto") {
      model = undefined;
      console.log(`${C.green}Switched to automatic free-tier fallback.${C.reset}`);
      return;
    }
    if (!models.find((m) => m.key === rest)) {
      console.log(`${C.red}Unknown model "${rest}". Run /model with no args to see the list.${C.reset}`);
      return;
    }
    model = rest;
    console.log(`${C.green}Switched to ${rest}.${C.reset}`);
  }

  if (goalFromArgv) {
    await runGoal(goalFromArgv);
    rl.close();
    return;
  }

  console.log(`${C.dim}Type a goal, or /model to pick a backend, or /exit to quit.${C.reset}\n`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = (await ask(rl, `${C.bold}rin›${C.reset} `)).trim();
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
