// agent.js — two loop modes:
//
//  - "auto" mode (no explicit /model pin): a Planner/Executor split.
//    The Planner (cfg.plannerModels chain) never writes code itself — it
//    breaks the goal into one precise, single-file instruction at a time and
//    reviews the result. The Executor (cfg.executorModels chain) only ever
//    writes/edits the one file it was told to, from a short, narrow prompt.
//    This is what lets a free/fast model do the bulk of the typing safely:
//    it's never asked to invent the plan, only to fill in one well-specified
//    blank, so there's much less room for it to drift off-task.
//
//  - "single model" mode (explicit /model pin): one model does everything
//    end to end, same as before — useful for comparing a single backend, or
//    when only one provider is configured.
//
// Both modes share one hard rule, enforced by the harness and not just asked
// of the model: a file can't be edit_file'd until it's been read_file'd (or
// written) in this run. That's the direct fix for the loop we hit where a
// model edited against content it never actually looked at and kept getting
// "old_str not found" — now that's refused before the model wastes a call on
// it, with an explicit instruction to read first.

const tools = require("./tools");
const { chat } = require("./providers");
const memory = require("./memory");

function extractJson(text) {
  // Models sometimes wrap JSON in ```json fences or add stray text around it —
  // pull out the first {...} block rather than failing outright.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object found in model response.");
  return JSON.parse(candidate.slice(start, end + 1));
}

// A very simple context manager: keep the system prompt plus the last N
// exchanges verbatim, and collapse anything older into one summary line.
// This is the piece that stops the loop from blowing its own context window
// the way long sessions eventually do.
function trimHistory(history, keepRecent = 16) {
  if (history.length <= keepRecent + 1) return history;
  const [sys, ...rest] = history;
  const older = rest.slice(0, rest.length - keepRecent);
  const recent = rest.slice(rest.length - keepRecent);
  const summary = {
    role: "user",
    content: `[earlier steps compacted: ${older.length} messages omitted — the goal and recent steps below are what matters now]`,
  };
  return [sys, summary, ...recent];
}

// Shared dispatcher for every action that actually touches the sandbox.
// `readState` is a Set of relative paths that have been read_file'd or
// write_file'd (or successfully edit_file'd) so far THIS RUN — edit_file is
// refused against anything not in it, so a model can never edit blind.
async function dispatchDirect(sandboxDir, cfg, action, args, readState) {
  switch (action) {
    case "run_shell":
      return tools.runShell(sandboxDir, args.command);
    case "read_file": {
      const r = tools.readFile(sandboxDir, args.path);
      if (r.ok) readState.add(args.path);
      return r;
    }
    case "write_file": {
      const r = tools.writeFile(sandboxDir, args.path, args.content);
      if (r.ok) readState.add(args.path);
      return r;
    }
    case "edit_file": {
      if (!readState.has(args.path)) {
        return {
          ok: false,
          output: `Refused: edit_file blocked on "${args.path}" — you haven't read_file'd this file in this session yet, so old_str can't be trusted to match. Call read_file("${args.path}") first, then edit against its actual current content.`,
        };
      }
      const r = tools.editFile(sandboxDir, args.path, args.old_str, args.new_str);
      if (r.ok) readState.add(args.path);
      return r;
    }
    case "search_code":
      return tools.searchCode(sandboxDir, args.pattern, args.path);
    case "run_tests":
      return tools.runTests(sandboxDir, args.command);
    case "git_diff":
      return tools.gitDiff(sandboxDir);
    case "git_commit":
      return tools.gitCommit(sandboxDir, args.message);
    case "remember": {
      const result = await memory.saveMemory(cfg, {
        category: args.category || "project_context",
        key: args.key,
        value: args.value,
        tags: args.tags || [],
      });
      return { ok: true, output: `Memory ${result.action}: ${args.key}` };
    }
    default:
      return { ok: false, output: `Unknown action "${action}".` };
  }
}

// ---------------------------------------------------------------------------
// Single-model mode (explicit /model pin) — one model, full tool access.
// ---------------------------------------------------------------------------

const SINGLE_MODEL_TOOL_DESCRIPTIONS = `
Available actions (respond with ONE JSON object, nothing else — no markdown fences, no prose outside the JSON):

{"thought": "<your reasoning, one or two sentences>", "action": "run_shell", "args": {"command": "..."}}
{"thought": "...", "action": "read_file", "args": {"path": "..."}}
{"thought": "...", "action": "write_file", "args": {"path": "...", "content": "..."}}
{"thought": "...", "action": "edit_file", "args": {"path": "...", "old_str": "...", "new_str": "..."}}
{"thought": "...", "action": "search_code", "args": {"pattern": "...", "path": "."}}
{"thought": "...", "action": "run_tests", "args": {"command": "..."}}
{"thought": "...", "action": "git_diff", "args": {}}
{"thought": "...", "action": "git_commit", "args": {"message": "..."}}
{"thought": "...", "action": "remember", "args": {"category": "...", "key": "...", "value": "...", "tags": []}}
{"thought": "...", "action": "ask_human", "args": {"question": "..."}}
{"thought": "...", "action": "done", "args": {"summary": "what was accomplished, and how it was verified"}}

Rules:
- Take exactly one action per turn. Wait for its result before deciding the next one.
- edit_file will be refused unless you've read_file'd that exact file first in this session — always
  read a file before editing it, never edit from memory or assumption.
- Never claim "done" without having actually run something that verifies it (run_tests, or run_shell to
  execute and check output). A claim of success with no verification step behind it is not allowed.
- Use "remember" for durable facts worth keeping across sessions (a project convention, a preference you
  learned, a decision made and why) — not for routine step-by-step narration.
- Use "ask_human" only when truly blocked on something only a human can resolve: a missing credential, an
  ambiguous product decision, something destructive you shouldn't guess about. This pauses the task.
- git_push is intentionally not offered unless the human explicitly asked this task to push.
`.trim();

async function runSingleModelLoop({
  goal,
  sandboxDir,
  cfg,
  model,
  onEvent,
  memoryCategories,
  initialHistory,
  initialSteps = 0,
  humanAnswer,
  readState,
}) {
  let history = initialHistory;
  if (!history) {
    const relevantMemories = await memory
      .loadRelevantMemories(cfg, { categories: memoryCategories, limit: 20 })
      .catch((err) => {
        onEvent("warn", `Memory unavailable this session: ${err.message}`);
        return [];
      });

    const systemPrompt = `You are Rin, operating as a coding agent in a terminal, working toward a concrete goal.

What you remember about this person and this project so far:
${memory.formatMemoriesForPrompt(relevantMemories)}

Your goal for this session:
${goal}

You are working inside a sandbox directory. You cannot access anything outside it.

${SINGLE_MODEL_TOOL_DESCRIPTIONS}`;

    history = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Begin. Decide and take the first action toward the goal." },
    ];
  } else if (humanAnswer) {
    history = [...history, { role: "user", content: `Human answered: ${humanAnswer}` }];
  }

  let steps = initialSteps;

  while (steps < cfg.maxSteps) {
    steps++;
    history = trimHistory(history);

    let raw;
    try {
      onEvent("thinking_start");
      const result = await chat(history, cfg, model);
      raw = result.text;
      onEvent("model", { usedModel: result.usedModel, ms: result.ms });
    } catch (err) {
      onEvent("error", `LLM call failed: ${err.message}`);
      return { status: "failed", reason: err.message, steps };
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      // Give the model one chance to self-correct rather than dying on a
      // formatting slip.
      history.push({ role: "assistant", content: raw });
      history.push({
        role: "user",
        content: `Your last response wasn't valid JSON in the required format (${err.message}). Respond again with exactly one JSON action object.`,
      });
      continue;
    }

    history.push({ role: "assistant", content: raw });
    onEvent("thought", parsed.thought || "");

    if (parsed.action === "done") {
      onEvent("done", parsed.args?.summary || "");
      return { status: "done", summary: parsed.args?.summary, steps };
    }

    if (parsed.action === "ask_human") {
      onEvent("blocked", parsed.args?.question || "");
      return { status: "blocked", question: parsed.args?.question, steps, history, readState: [...readState] };
    }

    onEvent("action", { action: parsed.action, args: parsed.args });
    let result;
    try {
      result = await dispatchDirect(sandboxDir, cfg, parsed.action, parsed.args || {}, readState);
    } catch (err) {
      // A tool failing (e.g. "remember" with no Supabase configured) should
      // go back to the model as a result to reason about, not crash the
      // whole process.
      result = { ok: false, output: `Tool error: ${err.message}` };
    }
    onEvent("result", result);

    history.push({
      role: "user",
      content: `Result of ${parsed.action}:\n${result.output || "(no output)"}`,
    });
  }

  onEvent("warn", `Hit the step ceiling (${cfg.maxSteps}) without finishing — stopping as a safety net.`);
  return { status: "step_limit", steps };
}

// ---------------------------------------------------------------------------
// Auto mode — Planner/Executor split.
// ---------------------------------------------------------------------------

const PLANNER_TOOL_DESCRIPTIONS = `
You are the PLANNER. You never write or edit code yourself — you break the goal into small, fully
specified steps and hand each one to an Executor model (a separate, faster/free model), then check its
work before deciding what happens next.

Respond with exactly ONE JSON object, nothing else (no markdown fences, no prose outside the JSON):

{"thought": "...", "action": "instruct", "args": {"path": "relative/path/to/one/file", "task": "an exact, unambiguous instruction for this one file — name the function signatures, imports, and behavior precisely, don't leave design decisions open"}}
{"thought": "...", "action": "read_file", "args": {"path": "..."}}
{"thought": "...", "action": "search_code", "args": {"pattern": "...", "path": "."}}
{"thought": "...", "action": "run_shell", "args": {"command": "..."}}
{"thought": "...", "action": "run_tests", "args": {"command": "..."}}
{"thought": "...", "action": "git_diff", "args": {}}
{"thought": "...", "action": "git_commit", "args": {"message": "..."}}
{"thought": "...", "action": "remember", "args": {"category": "...", "key": "...", "value": "...", "tags": []}}
{"thought": "...", "action": "ask_human", "args": {"question": "..."}}
{"thought": "...", "action": "done", "args": {"summary": "what was accomplished, and how it was verified"}}

Rules:
- You cannot call write_file or edit_file yourself — that's refused. Use "instruct" and give the Executor
  ONE file and ONE precise task at a time. Never bundle multiple files or multiple concerns into one
  instruction — that's exactly what makes a fast/free model drift off-task.
- Every "instruct" result includes the Executor's full output (what it wrote, or the edit it made, or an
  error). Actually read it before deciding the next step — the Executor is a weaker, cheaper model and
  will sometimes get something wrong. If it did, issue another "instruct" that states exactly what's
  wrong and what it should be instead, rather than assuming it worked.
- Keep each instruction scoped to what will fit cleanly in one file change. For a new module needing
  several pieces (e.g. functions + a CLI + tests), that's several separate "instruct" calls, one per file
  (or even one per logical chunk of a file), not one giant instruction.
- Never claim "done" without having actually run something that verifies it (run_tests, or run_shell to
  execute and check output). A claim of success with no verification step behind it is not allowed.
- Use "remember" for durable facts worth keeping across sessions — not routine step-by-step narration.
- Use "ask_human" only when truly blocked on something only a human can resolve.
- git_push is intentionally not offered unless the human explicitly asked this task to push.
`.trim();

const EXECUTOR_TOOL_DESCRIPTIONS = `
You are the EXECUTOR. The Planner has given you exactly ONE task, scoped to exactly ONE file. Do only
that — don't invent additional changes, don't touch other files, don't make project-level decisions; that
is the Planner's job, not yours.

Respond with exactly ONE JSON object, nothing else (no markdown fences, no prose outside the JSON, no
"thought" field needed):

{"action": "write_file", "args": {"path": "...", "content": "..."}}
{"action": "edit_file", "args": {"path": "...", "old_str": "...", "new_str": "..."}}
{"action": "run_shell", "args": {"command": "..."}}

Rules:
- write_file replaces the file's ENTIRE contents — use it for a brand-new file, or when the task is
  genuinely a full rewrite of this one file. For a small change to an existing file, use edit_file
  instead so you don't accidentally drop unrelated content.
- edit_file's old_str must match the file's CURRENT content exactly — it's shown to you below. Copy it
  verbatim; don't paraphrase or reconstruct it from memory.
- run_shell is only for things the task explicitly calls for, like installing a dependency — not for
  writing code.
- Output nothing except that single JSON action.
`.trim();

function buildExecutorHistory(sandboxDir, task, filePath, readState) {
  let fileBlock;
  if (filePath) {
    const existing = tools.readFile(sandboxDir, filePath);
    if (existing.ok) {
      readState.add(filePath);
      fileBlock = `Target file: ${filePath}\nCurrent content:\n---\n${existing.output}\n---`;
    } else {
      fileBlock = `Target file: ${filePath}\n(This file does not exist yet — use write_file to create it.)`;
    }
  } else {
    fileBlock = `No specific target file was given — infer the right file from the task below, or use run_shell if the task doesn't need a file at all.`;
  }

  return [
    { role: "system", content: EXECUTOR_TOOL_DESCRIPTIONS },
    { role: "user", content: `${fileBlock}\n\nYour task:\n${task || "(no task text given)"}` },
  ];
}

async function runExecutorStep({ sandboxDir, cfg, task, filePath, readState, onEvent }) {
  const history = buildExecutorHistory(sandboxDir, task, filePath, readState);

  let raw, usedModel, ms;
  try {
    onEvent("thinking_start");
    const result = await chat(history, cfg, cfg.executorModels);
    raw = result.text;
    usedModel = result.usedModel;
    ms = result.ms;
    onEvent("model", { usedModel: `executor:${usedModel}`, ms });
  } catch (err) {
    return { ok: false, output: `Executor call failed: ${err.message}` };
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { ok: false, output: `Executor produced invalid JSON (${err.message}). Raw: ${raw.slice(0, 300)}` };
  }

  if (!["write_file", "edit_file", "run_shell"].includes(parsed.action)) {
    return {
      ok: false,
      output: `Executor attempted disallowed action "${parsed.action}" — only write_file, edit_file, and run_shell are permitted for the Executor.`,
    };
  }

  onEvent("action", { action: `executor:${parsed.action}`, args: parsed.args });
  const result = await dispatchDirect(sandboxDir, cfg, parsed.action, parsed.args || {}, readState);
  onEvent("result", result);
  return result;
}

async function runPlannerExecutorLoop({
  goal,
  sandboxDir,
  cfg,
  onEvent,
  memoryCategories,
  initialHistory,
  initialSteps = 0,
  humanAnswer,
  readState,
}) {
  let history = initialHistory;
  if (!history) {
    const relevantMemories = await memory
      .loadRelevantMemories(cfg, { categories: memoryCategories, limit: 20 })
      .catch((err) => {
        onEvent("warn", `Memory unavailable this session: ${err.message}`);
        return [];
      });

    const systemPrompt = `You are Rin's Planner, directing a separate Executor model toward a concrete goal.

What you remember about this person and this project so far:
${memory.formatMemoriesForPrompt(relevantMemories)}

Your goal for this session:
${goal}

You are working inside a sandbox directory. You cannot access anything outside it.

${PLANNER_TOOL_DESCRIPTIONS}`;

    history = [
      { role: "system", content: systemPrompt },
      { role: "user", content: "Begin. Decide and take the first action toward the goal." },
    ];
  } else if (humanAnswer) {
    history = [...history, { role: "user", content: `Human answered: ${humanAnswer}` }];
  }

  const hasExecutor = Array.isArray(cfg.executorModels) && cfg.executorModels.length > 0;
  let steps = initialSteps;

  while (steps < cfg.maxSteps) {
    steps++;
    history = trimHistory(history);

    let raw;
    try {
      onEvent("thinking_start");
      const result = await chat(history, cfg, cfg.plannerModels);
      raw = result.text;
      onEvent("model", { usedModel: `planner:${result.usedModel}`, ms: result.ms });
    } catch (err) {
      onEvent("error", `LLM call failed: ${err.message}`);
      return { status: "failed", reason: err.message, steps };
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      history.push({ role: "assistant", content: raw });
      history.push({
        role: "user",
        content: `Your last response wasn't valid JSON in the required format (${err.message}). Respond again with exactly one JSON action object.`,
      });
      continue;
    }

    history.push({ role: "assistant", content: raw });
    onEvent("thought", parsed.thought || "");

    if (parsed.action === "done") {
      onEvent("done", parsed.args?.summary || "");
      return { status: "done", summary: parsed.args?.summary, steps };
    }

    if (parsed.action === "ask_human") {
      onEvent("blocked", parsed.args?.question || "");
      return { status: "blocked", question: parsed.args?.question, steps, history, readState: [...readState] };
    }

    if (parsed.action === "write_file" || parsed.action === "edit_file") {
      const msg = `Refused: the Planner cannot call "${parsed.action}" directly. Use "instruct" to hand a precise, single-file task to the Executor instead.`;
      onEvent("warn", msg);
      history.push({ role: "user", content: msg });
      continue;
    }

    let result;
    if (parsed.action === "instruct") {
      const args = parsed.args || {};
      if (!hasExecutor) {
        // Graceful degrade: no executor configured, so don't dead-end the
        // whole run — tell the Planner plainly so it can fall back to
        // run_shell-based workarounds, rather than silently doing nothing.
        result = {
          ok: false,
          output:
            "No executor model is configured (RIN_CLI_EXECUTOR_MODELS is empty and none of the default executor providers have a key set). Set at least one executor API key, or run this task with an explicit /model to use single-model mode instead.",
        };
        onEvent("result", result);
      } else {
        onEvent("action", { action: "instruct", args });
        result = await runExecutorStep({ sandboxDir, cfg, task: args.task, filePath: args.path, readState, onEvent });
      }
    } else {
      try {
        result = await dispatchDirect(sandboxDir, cfg, parsed.action, parsed.args || {}, readState);
      } catch (err) {
        result = { ok: false, output: `Tool error: ${err.message}` };
      }
      onEvent("result", result);
    }

    history.push({
      role: "user",
      content: `Result of ${parsed.action}:\n${result.output || "(no output)"}`,
    });
  }

  onEvent("warn", `Hit the step ceiling (${cfg.maxSteps}) without finishing — stopping as a safety net.`);
  return { status: "step_limit", steps };
}

// ---------------------------------------------------------------------------
// Entry point — picks the mode. An explicit /model pin means "I want exactly
// this one model doing everything" (single-model mode); no pin means "auto",
// which is the Planner/Executor split.
// ---------------------------------------------------------------------------

async function runAgentLoop(opts) {
  const readState = new Set(opts.initialReadState || []);
  const memoryCategories = opts.memoryCategories || ["project_context", "preference", "fact"];
  const shared = { ...opts, memoryCategories, readState };

  if (opts.model) {
    return runSingleModelLoop(shared);
  }
  return runPlannerExecutorLoop(shared);
}

module.exports = { runAgentLoop, extractJson, trimHistory };
