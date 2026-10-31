// settings.js — the handful of preferences you can change from /config.
// Stored beside the other Rin dotfiles (never inside a project folder).

const fs = require("fs");
const path = require("path");

const FILE = path.join(process.env.HOME || process.env.PREFIX || "/root", ".rin-cli-settings.json");

const DEFAULTS = {
  theme: null, // null = never chosen yet → first-run theme picker
  showThoughts: true, // the dim italic "thinking" lines
  toolDetail: "compact", // "compact" | "full" tool output
  animations: true, // spinner
  hints: true, // hint row under the input box
};

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(settings) {
  try {
    fs.writeFileSync(FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
  } catch {
    // Non-fatal — a preference failing to persist shouldn't break a session.
  }
}

module.exports = { load, save, DEFAULTS, FILE };
