// Run the shipped zsh prompt in a real zsh, without sourcing personal config.
// Usage: node scripts/check-zsh-prompt.mjs [path-to-zsh]
// This checks prompt expansion, not native WKWebView/Linux keyboard behavior.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync(new URL("../crates/mycli-desktop/src/terminal.rs", import.meta.url), "utf8");
const init = source.match(/let content = r#"(# Mymux zsh init:[\s\S]*?)"#;/)?.[1];
assert.ok(init, "the shipped zsh startup wrapper must exist");
// Everything before setopt is the user's .zshrc delegation. Avoid loading it.
const prompt = init.slice(init.indexOf("setopt "));
const root = mkdtempSync(join(tmpdir(), "mymux-zsh-prompt-"));
const zsh = process.argv[2] ? resolve(process.argv[2]) : "zsh";
const home = join(root, "home");
mkdirSync(home);
const env = { ...process.env, HOME: home, ZDOTDIR: home, MYMUX_USER_ZDOTDIR: "", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm-256color" };
// The fixture uses ASCII and Korean only; Korean glyphs occupy two cells.
const cells = text => [...text].reduce((n, ch) => n + (/\p{Script=Hangul}/u.test(ch) ? 2 : 1), 0);
const stripControls = text => text.replace(/\x1b\][^\x1b]*\x1b\\|\x1b\[[0-9;]*m/g, "");

try {
  for (const name of ["ascii-project", "a".repeat(90), "한글프로젝트".repeat(12), "percent%{folder", "literal%n%}folder"]) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    const script = join(root, "prompt.zsh");
    // Assign the prompt ONCE, then shrink/grow COLUMNS without another precmd.
    // This reproduces prompt expansion while ZLE redraws after a pane resize.
    // Common themes enable PROMPT_SUBST; path percent signs must remain safe.
    writeFileSync(script, 'setopt prompt_subst\n' + prompt + '\nCOLUMNS=120\nfor hook in ${precmd_functions[@]}; do "$hook"; done\nfor COLUMNS in 120 80 40 12 8 4 80; do\nprint -Pr -- "$PROMPT"\ndone\n');
    const result = spawnSync(zsh, ["-f", script], { cwd, env, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trimEnd().split("\n");
    const widths = [120, 80, 40, 12, 8, 4, 80];
    assert.equal(lines.length, widths.length);
    lines.forEach((line, i) => {
      assert.ok(line.includes("\x1b]133;A\x1b\\"), "prompt-start mark retained");
      assert.ok(line.endsWith("\x1b]133;B\x1b\\"), "input-start mark retained");
      const visible = stripControls(line);
      assert.ok(cells(visible) < widths[i], `${name}: ${cells(visible)} cells must fit ${widths[i]} columns`);
      assert.ok(visible.endsWith(" $ "), "input suffix retained");
      if (i === 0 && name.includes("%")) assert.ok(visible.includes(name), "directory percent signs must stay literal");
    });
  }
  console.log("zsh prompt checks passed: ASCII/CJK/percent paths, OSC marks and resize expansion (not native input acceptance).");
} finally {
  assert.equal(dirname(root), resolve(tmpdir()), "cleanup must stay in the temporary directory");
  rmSync(root, { recursive: true, force: true });
}
