// agent.js — the ReAct loop: ask the model for exactly one next action,
// execute it, feed the result back, repeat until done/blocked/step-ceiling.

const tools = require("./tools");
const { chat } = require("./providers");
const memory = require("./memory");

const TOOL_DESCRIPTIONS = `
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
- Never claim "done" without having actually run something that verifies it (run_tests, or run_shell to execute and check output). A claim of success with no verification step behind it is not allowed.
- Use "remember" for durable facts worth keeping across sessions (a project convention, a preference you learned, a decision made and why) — not for routine step-by-step narration.
- Use "ask_human" only when truly blocked on something only a human can resolve: a missing credential, an ambiguous product decision, something destructive you shouldn't guess about. This pauses the task.
- git_push is intentionally not offered unless the human explicitly asked this task to push.
`.trim();

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

async function dispatch(sandboxDir, cfg, action, args) {
  switch (action) {
    case "run_shell":
      return tools.runShell(sandboxDir, args.command);
    case "read_file":
      return tools.readFile(sandboxDir, args.path);
    case "write_file":
      return tools.writeFile(sandboxDir, args.path, args.content);
    case "edit_file":
      return tools.editFile(sandboxDir, args.path, args.old_str, args.new_str);
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

async function runAgentLoop({
  goal,
  sandboxDir,
  cfg,
  model, // explicit /model choice, or undefined for the free fallback chain
  onEvent, // (type, payload) => void — for live terminal output
  memoryCategories = ["project_context", "preference", "fact"],
  initialHistory, // pass this (plus initialSteps) to resume after an ask_human pause
  initialSteps = 0,
  humanAnswer, // the person's reply to the last ask_human question, when resuming
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

${TOOL_DESCRIPTIONS}`;

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
      const result = await chat(history, cfg, model);
      raw = result.text;
      onEvent("model", { usedModel: result.usedModel });
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
      return { status: "blocked", question: parsed.args?.question, steps, history };
    }

    onEvent("action", { action: parsed.action, args: parsed.args });
    let result;
    try {
      result = await dispatch(sandboxDir, cfg, parsed.action, parsed.args || {});
    } catch (err) {
      // A tool failing (e.g. "remember" with no Supabase configured) should
      // go back to the model as a result to reason about, not crash the
      // whole process — this is what lets the CLI run fine with zero memory
      // setup at all, for anyone who just wants the plain coding agent.
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

module.exports = { runAgentLoop, extractJson, trimHistory };
