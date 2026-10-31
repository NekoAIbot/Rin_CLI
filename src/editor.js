// editor.js — Rin's own line editor and pickers.
//
// Node's readline clears everything below the cursor on every redraw, which
// makes a closed, growing input box impossible. So Rin reads raw keystrokes
// itself: it draws the whole box, edits a buffer, and redraws with relative
// cursor moves. It also provides the arrow-key menus (/theme, /config, ...).
//
// Everything that isn't a TTY (piped input, tests) falls back to plain
// line reading so scripts keep working.

const readline = require("readline");
const ui = require("./ui");

const { C, T } = ui;
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

// ── Key parsing ─────────────────────────────────────────────────────────────
// Turns a raw stdin chunk into key tokens. `st` carries bracketed-paste state
// across chunks.
function tokenize(s, st) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (st.paste !== null) {
      const end = s.indexOf("\x1b[201~", i);
      if (end === -1) {
        st.paste += s.slice(i);
        break;
      }
      st.paste += s.slice(i, end);
      out.push({ name: "paste", text: st.paste });
      st.paste = null;
      i = end + 6;
      continue;
    }
    const ch = s[i];
    if (ch === "\x1b") {
      if (s.startsWith("\x1b[200~", i)) {
        st.paste = "";
        i += 6;
        continue;
      }
      const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(s.slice(i, i + 24));
      if (m) {
        i += m[0].length;
        const params = m[1].split(";");
        const mod = parseInt(params[1] || "1", 10);
        const word = mod === 5 || mod === 3;
        const f = m[2];
        if (f === "A") out.push({ name: "up" });
        else if (f === "B") out.push({ name: "down" });
        else if (f === "C") out.push({ name: word ? "wordright" : "right" });
        else if (f === "D") out.push({ name: word ? "wordleft" : "left" });
        else if (f === "H") out.push({ name: "home" });
        else if (f === "F") out.push({ name: "end" });
        else if (f === "Z") out.push({ name: "shifttab" });
        else if (f === "~") {
          const n = parseInt(params[0], 10);
          if (n === 3) out.push({ name: "delete" });
          else if (n === 1 || n === 7) out.push({ name: "home" });
          else if (n === 4 || n === 8) out.push({ name: "end" });
        }
        continue;
      }
      const o = /^\x1bO([A-Z])/.exec(s.slice(i, i + 3));
      if (o) {
        i += 3;
        const map = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
        if (map[o[1]]) out.push({ name: map[o[1]] });
        continue;
      }
      const nx = s[i + 1];
      if (nx === undefined) {
        out.push({ name: "escape" });
        i += 1;
      } else if (nx === "b") {
        out.push({ name: "wordleft" });
        i += 2;
      } else if (nx === "f") {
        out.push({ name: "wordright" });
        i += 2;
      } else if (nx === "\x7f" || nx === "\x08") {
        out.push({ name: "delword" });
        i += 2;
      } else if (nx === "\r" || nx === "\n") {
        out.push({ name: "altenter" });
        i += 2;
      } else {
        // Unknown ESC-prefixed key: treat as a bare escape and drop the rest.
        out.push({ name: "escape" });
        i += 2;
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      // Text right after an Enter in the same chunk means a paste without
      // bracketed-paste support: keep it as a newline rather than submitting.
      out.push({ name: "enter", pasted: i + 1 < s.length && s[i + 1] >= " " });
      i++;
      continue;
    }
    if (code < 32 || code === 127) {
      i++;
      if (code === 9) out.push({ name: "tab" });
      else if (code === 127 || code === 8) out.push({ name: "backspace" });
      else out.push({ name: "ctrl", key: String.fromCharCode(code + 96) }); // \x01 -> "a"
      continue;
    }
    // Printable run (keeps surrogate pairs together).
    let j = i;
    while (j < s.length && s[j] >= " " && s[j] !== "\x7f") j++;
    out.push({ name: "text", text: s.slice(i, j) });
    i = j;
  }
  return out;
}

// ── Layout: soft-wrap a buffer into visual rows ─────────────────────────────
// Each row is a [s,e) range into the buffer; rows are contiguous apart from
// the "\n" characters that separate logical lines. `last` marks the final row
// of a logical line (the only row where the cursor may sit at its very end).
function layout(buf, tw) {
  const rows = [];
  let lineStart = 0;
  for (;;) {
    const nl = buf.indexOf("\n", lineStart);
    const lineEnd = nl === -1 ? buf.length : nl;
    if (lineEnd === lineStart) rows.push({ s: lineStart, e: lineStart, last: true });
    else {
      let s = lineStart;
      while (s < lineEnd) {
        let e = Math.min(s + tw, lineEnd);
        if (e < lineEnd && buf[e] !== " ") {
          const sp = buf.lastIndexOf(" ", e - 1);
          if (sp > s) e = sp + 1; // break after the last space that fits
        }
        rows.push({ s, e, last: e === lineEnd });
        s = e;
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return rows;
}

function locate(rows, cur) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (cur >= r.s && (cur < r.e || (cur === r.e && r.last))) return { row: i, col: cur - r.s };
  }
  const r = rows[rows.length - 1];
  return { row: rows.length - 1, col: r.e - r.s };
}

const sanitize = (t) => t.replace(/\t/g, "  ").replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "");

function createEditor({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const isTTY = !!(stdin.isTTY && stdout.isTTY);

  // Raw mode is reference-counted so a menu opened from inside another menu
  // (/config → theme) doesn't switch the terminal back to cooked mode.
  let rawDepth = 0;
  function acquire() {
    if (rawDepth++ === 0) {
      stdin.setEncoding("utf8");
      stdin.setRawMode(true);
      stdin.resume();
      stdout.write(PASTE_ON);
    }
  }
  function release() {
    if (--rawDepth === 0) {
      stdout.write(PASTE_OFF + SHOW);
      stdin.setRawMode(false);
      stdin.pause();
    }
  }
  process.on("exit", () => {
    if (rawDepth > 0) {
      try {
        stdout.write(PASTE_OFF + SHOW);
        stdin.setRawMode(false);
      } catch {}
    }
  });

  const up = (n) => (n > 0 ? `\x1b[${n}A` : "");

  // ── Plain (non-TTY) fallback ──────────────────────────────────────────────
  let plainRl = null;
  let plainIter = null;
  async function readPlain(opts) {
    if (!plainRl) {
      plainRl = readline.createInterface({ input: stdin });
      plainIter = plainRl[Symbol.asyncIterator]();
    }
    const { value, done } = await plainIter.next();
    if (done) return { kind: "exit" };
    const text = String(value).trim();
    const kind = opts.ask ? "ask" : text.startsWith("!") ? "shell" : "normal";
    stdout.write("\n" + ui.inputFrame({ texts: [text], kind, title: opts.title || "rin" }).join("\n") + "\n");
    return { kind: "submit", text };
  }

  // ── The input box ─────────────────────────────────────────────────────────
  // opts: { title, right, history[], suggest(buf)→[{value,desc,args}], placeholder,
  //         hintLeft, hints, ask }
  function readInput(opts = {}) {
    if (!isTTY) return readPlain(opts);
    return new Promise((resolve) => {
      let buf = "";
      let cur = 0;
      let shell = false;
      let histIdx = -1;
      let draft = "";
      let notice = "";
      let noticeTimer = null;
      let sel = 0;
      let hideSugg = false;
      let viewTop = 0;
      let prevLine = 0; // how many lines above the bottom the cursor sits (relative anchor)
      let lastCtrlC = 0;
      let done = false;
      const hist = opts.history || [];
      const st = { paste: null };

      const kindNow = () => (opts.ask ? "ask" : shell ? "shell" : "normal");

      function suggestions() {
        if (!opts.suggest || shell || opts.ask || hideSugg || buf.includes("\n") || !buf.startsWith("/")) return [];
        const list = opts.suggest(buf) || [];
        if (list.length === 1 && list[0].value === buf) return [];
        return list;
      }

      function hintLeft() {
        if (notice) return notice;
        if (opts.hints === false) return "";
        if (shell) return "shell mode · esc exits";
        return opts.hintLeft || "/ commands · ! shell";
      }

      function render(final = false) {
        const w = ui.termWidth();
        const tw = w - 6;
        const rows = layout(buf, tw);
        const { row, col } = locate(rows, cur);
        let vis = rows;
        let top = 0;
        if (!final) {
          const maxRows = Math.max(3, Math.min(8, (stdout.rows || 24) - 8));
          if (rows.length > maxRows) {
            if (row < viewTop) viewTop = row;
            if (row >= viewTop + maxRows) viewTop = row - maxRows + 1;
            viewTop = Math.max(0, Math.min(viewTop, rows.length - maxRows));
            top = viewTop;
            vis = rows.slice(top, top + maxRows);
          } else viewTop = 0;
        }
        const texts = vis.map((r) => buf.slice(r.s, r.e));
        const placeholder = !buf ? (shell ? "shell command" : opts.placeholder || "") : "";
        const lines = ui.inputFrame({ texts, firstIndex: top, kind: kindNow(), title: opts.title || "rin", placeholder, width: w });

        let extra = [];
        if (!final) {
          const sg = suggestions();
          if (sg.length) {
            sel = Math.min(sel, sg.length - 1);
            extra = ui.suggestLines(sg, sel, w);
          } else {
            extra = [ui.hintRow({ left: hintLeft(), right: notice ? "" : opts.right || "", leftStyle: notice ? T.warn : "", width: w })];
          }
        }
        const all = lines.concat(extra);
        let out = HIDE + up(prevLine) + "\r\x1b[J" + all.join("\n");
        if (final) {
          out += "\n" + SHOW;
          prevLine = 0;
        } else {
          const curLine = 1 + (row - top);
          const upBy = all.length - 1 - curLine;
          out += up(upBy) + `\x1b[${5 + col}G` + SHOW;
          prevLine = curLine;
        }
        stdout.write(out);
      }

      function setNotice(msg) {
        notice = msg;
        clearTimeout(noticeTimer);
        if (msg) {
          noticeTimer = setTimeout(() => {
            notice = "";
            if (!done) render();
          }, 1500);
        }
      }

      function cleanup() {
        done = true;
        clearTimeout(noticeTimer);
        stdin.removeListener("data", onData);
        stdout.removeListener("resize", onResize);
        release();
      }

      function finish(result) {
        if (result.kind === "submit") {
          render(true);
        } else {
          // Leaving: wipe the box instead of leaving a half-typed one behind.
          stdout.write(up(prevLine) + "\r\x1b[J" + SHOW);
        }
        cleanup();
        resolve(result);
      }

      function insert(t) {
        t = sanitize(t);
        if (!t) return;
        if (t === "!" && buf === "" && cur === 0 && !shell && !opts.ask) {
          shell = true;
          return;
        }
        buf = buf.slice(0, cur) + t + buf.slice(cur);
        cur += t.length;
        sel = 0;
        hideSugg = false;
      }

      function setBuffer(text) {
        if (text.startsWith("!") && !opts.ask) {
          shell = true;
          buf = text.slice(1);
        } else {
          shell = false;
          buf = text;
        }
        cur = buf.length;
      }

      const isWord = (c) => c !== " " && c !== "\n";
      function wordLeft() {
        let i = cur;
        while (i > 0 && !isWord(buf[i - 1])) i--;
        while (i > 0 && isWord(buf[i - 1])) i--;
        return i;
      }
      function wordRight() {
        let i = cur;
        while (i < buf.length && !isWord(buf[i])) i++;
        while (i < buf.length && isWord(buf[i])) i++;
        return i;
      }
      function lineStartOf(i) {
        return buf.lastIndexOf("\n", i - 1) + 1;
      }
      function lineEndOf(i) {
        const n = buf.indexOf("\n", i);
        return n === -1 ? buf.length : n;
      }

      function moveVertical(dir) {
        const rows = layout(buf, ui.termWidth() - 6);
        const { row, col } = locate(rows, cur);
        const t = row + dir;
        if (t < 0 || t >= rows.length) return false;
        const r = rows[t];
        const maxCol = r.e - r.s - (r.last ? 0 : 1);
        cur = r.s + Math.max(0, Math.min(col, maxCol));
        return true;
      }

      function submit() {
        const text = (shell ? "!" : "") + buf.replace(/\s+$/, "");
        if (!buf.trim()) return; // ignore empty Enter
        histIdx = -1;
        finish({ kind: "submit", text });
      }

      function handle(tok) {
        if (tok.name !== "ctrl" || tok.key !== "c") {
          if (notice) setNotice("");
        }
        switch (tok.name) {
          case "text":
            insert(tok.text);
            break;
          case "paste":
            insert(tok.text);
            break;
          case "enter": {
            if (tok.pasted) {
              insert("\n");
              break;
            }
            if (buf.slice(0, cur).endsWith("\\")) {
              buf = buf.slice(0, cur - 1) + "\n" + buf.slice(cur);
              break;
            }
            const sg = suggestions();
            if (sg.length) {
              const pick = sg[Math.min(sel, sg.length - 1)];
              if (pick.value !== buf && pick.value.startsWith(buf)) {
                buf = pick.value;
                cur = buf.length;
              }
            }
            submit();
            break;
          }
          case "altenter":
            insert("\n");
            break;
          case "tab": {
            const sg = suggestions();
            if (sg.length) {
              const pick = sg[Math.min(sel, sg.length - 1)];
              buf = pick.value + (pick.args && !pick.value.endsWith(" ") ? " " : "");
              cur = buf.length;
              sel = 0;
            }
            break;
          }
          case "backspace":
            if (cur > 0) {
              const two = cur > 1 && /[\udc00-\udfff]/.test(buf[cur - 1]) && /[\ud800-\udbff]/.test(buf[cur - 2]);
              const n = two ? 2 : 1;
              buf = buf.slice(0, cur - n) + buf.slice(cur);
              cur -= n;
              sel = 0;
              hideSugg = false;
            } else if (shell) shell = false;
            break;
          case "delete":
            if (cur < buf.length) buf = buf.slice(0, cur) + buf.slice(cur + 1);
            break;
          case "delword": {
            const i = wordLeft();
            buf = buf.slice(0, i) + buf.slice(cur);
            cur = i;
            break;
          }
          case "left":
            if (cur > 0) cur--;
            break;
          case "right":
            if (cur < buf.length) cur++;
            break;
          case "wordleft":
            cur = wordLeft();
            break;
          case "wordright":
            cur = wordRight();
            break;
          case "home":
            cur = lineStartOf(cur);
            break;
          case "end":
            cur = lineEndOf(cur);
            break;
          case "up": {
            const sg = suggestions();
            if (sg.length) {
              sel = (sel - 1 + sg.length) % sg.length;
              break;
            }
            if (moveVertical(-1)) break;
            if (!hist.length || opts.ask) break;
            if (histIdx === -1) {
              draft = (shell ? "!" : "") + buf;
              histIdx = hist.length - 1;
            } else if (histIdx > 0) histIdx--;
            setBuffer(hist[histIdx]);
            break;
          }
          case "down": {
            const sg = suggestions();
            if (sg.length) {
              sel = (sel + 1) % sg.length;
              break;
            }
            if (moveVertical(1)) break;
            if (histIdx === -1) break;
            if (histIdx < hist.length - 1) {
              histIdx++;
              setBuffer(hist[histIdx]);
            } else {
              histIdx = -1;
              setBuffer(draft);
            }
            break;
          }
          case "escape":
            if (suggestions().length) hideSugg = true;
            else if (shell) shell = false;
            break;
          case "ctrl":
            handleCtrl(tok.key);
            break;
        }
      }

      function handleCtrl(k) {
        switch (k) {
          case "c": {
            const now = Date.now();
            if (now - lastCtrlC < 1500) return finish({ kind: "exit" });
            lastCtrlC = now;
            buf = "";
            cur = 0;
            shell = false;
            histIdx = -1;
            setNotice("ctrl+c again to exit");
            break;
          }
          case "d":
            if (buf === "" && !shell) return finish({ kind: "exit" });
            if (cur < buf.length) buf = buf.slice(0, cur) + buf.slice(cur + 1);
            break;
          case "a":
            cur = lineStartOf(cur);
            break;
          case "e":
            cur = lineEndOf(cur);
            break;
          case "b":
            if (cur > 0) cur--;
            break;
          case "f":
            if (cur < buf.length) cur++;
            break;
          case "u": {
            const s = lineStartOf(cur);
            buf = buf.slice(0, s) + buf.slice(cur);
            cur = s;
            break;
          }
          case "k":
            buf = buf.slice(0, cur) + buf.slice(lineEndOf(cur));
            break;
          case "w": {
            const i = wordLeft();
            buf = buf.slice(0, i) + buf.slice(cur);
            cur = i;
            break;
          }
          case "p":
            handle({ name: "up" });
            break;
          case "n":
            handle({ name: "down" });
            break;
          case "l":
            stdout.write("\x1b[2J\x1b[H");
            prevLine = 0;
            break;
        }
      }

      function onData(chunk) {
        if (done) return;
        for (const tok of tokenize(String(chunk), st)) {
          handle(tok);
          if (done) return;
        }
        render();
      }
      const onResize = () => {
        if (!done) render();
      };

      stdout.write("\n");
      acquire();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      render();
    });
  }

  // ── Menus ─────────────────────────────────────────────────────────────────
  // spec: { title, intro[], rows | ()=>rows, initial, numbered, footer,
  //         preview(sel)→lines[], onMove(sel), onActivate(sel)→"close"|other (may be async) }
  // Resolves with the chosen index, or -1 if cancelled.
  function menu(spec) {
    if (!isTTY) return Promise.resolve(-1);
    return new Promise((resolve) => {
      const getRows = () => (typeof spec.rows === "function" ? spec.rows() : spec.rows);
      const numbered = spec.numbered !== false;
      let sel = Math.max(0, Math.min(spec.initial || 0, getRows().length - 1));
      let prevLine = 0;
      let busy = false;
      let done = false;
      const st = { paste: null };

      function draw() {
        const w = ui.termWidth();
        const lines = ui.menuFrame({
          title: spec.title,
          intro: spec.intro || [],
          rows: getRows(),
          sel,
          numbered,
          preview: spec.preview ? spec.preview(sel) : [],
          width: w,
        });
        lines.push(ui.hintRow({ left: spec.footer || (numbered ? "↑/↓ navigate · enter select · esc cancel" : "↑/↓ navigate · enter change · esc close"), width: w }));
        stdout.write(HIDE + up(prevLine) + "\r\x1b[J" + lines.join("\n"));
        prevLine = lines.length - 1;
      }
      function erase() {
        stdout.write(up(prevLine) + "\r\x1b[J");
        prevLine = 0;
      }
      function cleanup() {
        done = true;
        stdin.removeListener("data", onData);
        stdout.removeListener("resize", onResize);
        release();
      }
      function close(idx) {
        erase();
        cleanup();
        resolve(idx);
      }
      function move(to) {
        const n = getRows().length;
        const next = ((to % n) + n) % n;
        if (next !== sel) {
          sel = next;
          if (spec.onMove) spec.onMove(sel);
        }
      }
      async function activate() {
        if (!spec.onActivate) return close(sel);
        busy = true;
        erase();
        let r;
        try {
          r = await spec.onActivate(sel);
        } finally {
          busy = false;
        }
        if (r === "close") return close(sel);
        draw();
      }

      function onData(chunk) {
        if (done || busy) return;
        for (const tok of tokenize(String(chunk), st)) {
          if (tok.name === "up" || (tok.name === "text" && tok.text === "k") || (tok.name === "ctrl" && tok.key === "p")) move(sel - 1);
          else if (tok.name === "down" || (tok.name === "text" && tok.text === "j") || (tok.name === "ctrl" && tok.key === "n")) move(sel + 1);
          else if (tok.name === "home") move(0);
          else if (tok.name === "end") move(getRows().length - 1);
          else if (tok.name === "enter" || (tok.name === "text" && tok.text === " ")) {
            activate();
            return;
          } else if (tok.name === "escape" || (tok.name === "ctrl" && (tok.key === "c" || tok.key === "d")) || (tok.name === "text" && tok.text === "q")) {
            if (spec.onCancel) spec.onCancel();
            return close(-1);
          } else if (tok.name === "text" && numbered && /^[1-9]$/.test(tok.text)) {
            const i = parseInt(tok.text, 10) - 1;
            if (i < getRows().length) {
              sel = i;
              if (spec.onMove) spec.onMove(sel);
              activate();
              return;
            }
          }
        }
        draw();
      }
      const onResize = () => {
        if (!done && !busy) draw();
      };

      stdout.write("\n");
      acquire();
      stdin.on("data", onData);
      stdout.on("resize", onResize);
      draw();
    });
  }

  function close() {
    if (plainRl) plainRl.close();
  }

  return { readInput, menu, close, isTTY, layout, locate, tokenize };
}

module.exports = { createEditor, layout, locate, tokenize };
