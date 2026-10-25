# Rin CLI — setup on Termux

No build step, no extra packages beyond Node itself (you already have Node v22,
confirmed from the Supabase CLI error earlier — that version has native
`fetch`, which this uses directly instead of pulling in a dependency).

## 1. Drop this folder in

Unzip this wherever you keep tools, e.g.:

```bash
mkdir -p ~/tools
cd ~/tools
# unzip rin-cli.zip here
chmod +x rin-cli/src/cli.js
```

## 2. Secrets go in `~/.rin-cli.env`, NOT a project `.env`

This keeps the service_role key and your model API keys out of any project
folder that might someday get committed or shared. Create it once:

```bash
cat > ~/.rin-cli.env << 'EOF'
SUPABASE_SERVICE_ROLE_KEY=paste_your_NEW_regenerated_service_role_key_here
GEMINI_API_KEY=your_gemini_key
OPENROUTER_API_KEY=your_openrouter_key_optional
EOF
chmod 600 ~/.rin-cli.env
```

Groq's key and the Supabase URL are picked up automatically from whichever
project's `.env` you run `rin` inside (it already has `GROQ_API_KEY` and
`VITE_SUPABASE_URL` from the companion build) — nothing to duplicate there.

If you'd rather skip the email lookup, you can also set `RIN_USER_ID=` in
`~/.rin-cli.env` directly once you know it; otherwise the CLI resolves it
once from `profiles` by email and you won't need to touch it.

## 3. Make `rin` runnable from anywhere

```bash
npm install -g ~/tools/rin-cli
```

or, without installing globally, just alias it:

```bash
echo 'alias rin="node ~/tools/rin-cli/src/cli.js"' >> ~/.bashrc
source ~/.bashrc
```

## 4. Run it

From inside any project folder (so it can see that project's `.env` for
`GROQ_API_KEY` / `VITE_SUPABASE_URL`, and so the sandbox is scoped there):

```bash
cd ~/some/project
rin "build a simple calculator app with add, subtract, multiply, divide, with tests"
```

Or drop into interactive mode:

```bash
rin
rin› build a simple calculator app...
rin› /model              # see what's available
rin› /model claude-opus  # switch to a paid model for a harder task
rin› /model auto         # back to the free fallback chain
rin› /exit
```

## What happens on first run

1. It loads whatever's relevant from Rin's existing memory (same table the
   Telegram bot reads/writes) so it already knows your conventions and past
   decisions, scoped to `project_context` / `preference` / `fact` categories.
2. It picks a model — Gemini first, falling back to Groq then OpenRouter's
   free pool if one fails — unless you've set one explicitly with `/model`.
3. It runs the loop: think → act (shell/file/test/git) → observe → repeat,
   printing each step live, until it either finishes (after actually
   verifying with `run_tests` or a real command, not just saying so), hits
   something only you can resolve and asks, or hits the safety-net step
   ceiling (150 by default — override with `RIN_CLI_MAX_STEPS` in
   `~/.rin-cli.env`).

## Known limits of this first version (by design — see the build spec)

- No persistence across closing the terminal mid-task; each run is its own
  session. The daemon/Telegram-triggered version is the next phase, once this
  loop's been exercised for real.
- Single task at a time, no queue.
- `git_push` exists in `tools.js` but isn't in the model's default action
  list yet — wire it in deliberately per-task once you actually want that.

## Running from anywhere, after this is on GitHub

```bash
git clone https://github.com/<your-username>/rin-cli.git ~/tools/rin-cli
npm install -g ~/tools/rin-cli

# one file, once, on each machine — everything else comes from the repo
nano ~/.rin-cli.env
```

As long as `~/.rin-cli.env` has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GEMINI_API_KEY` (and optionally `GROQ_API_KEY` / `OPENROUTER_API_KEY`), `rin`
works the same from any directory on any machine — it no longer depends on
being inside a project folder that happens to have its own `.env`.
