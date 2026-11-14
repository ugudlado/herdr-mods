// Reading an agent's screen (the raw text of `hc read <t> --lines 0`): the paragraph worth
// showing in the inbox, and whether a choice menu is up. No host calls: plain functions.

const RULE = /^\s*─{8,}/;
const PROMPT = /^\s*[❯›>](\s|$)/;
const OPTION = /^\s*[❯›]\s*\d+[.)]/;          // the selected option of a menu
const NUMBERED = /^\s*(?:[❯›]\s*)?\d+[.)]\s+\S/;
const MENU_HINT = /enter to (select|confirm)|esc to cancel/i;
const OUTPUT = /^[⏺●•]\s/;                       // a line the agent wrote (Claude: ⏺, Codex/others: ●)

const lastIndex = (arr, f) => { for (let i = arr.length - 1; i >= 0; i--) if (f(arr[i])) return i; return -1; };
const lines = (raw) => String(raw ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));

// Index of the first line of the input box at the bottom (the rule above the last prompt
// line), or -1 when there is none (a menu replaces Claude's input box).
function promptBox(ls) {
  let i = ls.length - 1;
  while (i >= 0 && !PROMPT.test(ls[i])) i--;
  if (i < 0 || OPTION.test(ls[i])) return -1;
  for (let j = i - 1; j >= Math.max(0, i - 2); j--) if (RULE.test(ls[j])) return j;
  // Codex draws no rule: its `›` input line is near the bottom.
  if (/^\s*›/.test(ls[i]) && ls.slice(i + 1).filter((l) => l.trim()).length <= 6) return i;
  return -1;
}

// A choice menu (a permission prompt, a question with options) after the agent's last
// output line: Enter would pick its selected option. Prose questions are not menus.
export function menuOnScreen(raw) {
  const ls = lines(raw);
  let from = ls.length - 1;
  while (from >= 0 && !OUTPUT.test(ls[from])) from--;
  const box = promptBox(ls);
  const region = ls.slice(from + 1);
  if (region.some((l) => OPTION.test(l) || MENU_HINT.test(l))) return true;
  // Two or more numbered lines in a row read as options only when no input box is below
  // them: with the input box up, the agent waits for typed text and the list is prose.
  if (box > from) return false;
  let run = 0;
  for (const l of region) {
    run = NUMBERED.test(l) ? run + 1 : l.trim() ? 0 : run;
    if (run >= 2) return true;
  }
  return false;
}

// Lines that are the agent's chrome, not what it said.
const CHROME = [
  RULE, /^\s*[━═╭╰│┃]/, /^\s*⏵/, /^\s*\?\s+for shortcuts/i, /^\s*(Model|cwd|Reset):/,
  /^\s*esc to/i, /^\s*ctrl\+/i, /^\s*Press up/i, /^\s*(auto mode|accept edits|bypass permissions)/i,
  /^\s*[✻✳✶✢✽*]\s*\S+ for \d+[smh]/u,          // "✻ Churned for 2s · done 1:50 PM"
  /\/effort\b/, /paste again to expand/i, /^\s*Waiting for \d+ background agent/i,
  /^\s*(⎿\s*)?Ran \d+ .*commands?\s*$/i,
];
const MARK = /^([⏺●⎿※✻!]|[-*•]|\d+[.)])\s+/u;

// The last paragraph worth reading: the screen above the input box, without status lines,
// with wrapped lines joined. A `※ recap:` with no output after it wins.
export function lastLines(raw) {
  let ls = lines(raw);
  const box = promptBox(ls);
  if (box >= 0) ls = ls.slice(0, box);
  const menu = menuOnScreen(raw);
  if (menu) {  // stop before the options: the question is what to read
    const out = lastIndex(ls, (x) => OUTPUT.test(x));
    const first = ls.findIndex((l, i) => i > out && NUMBERED.test(l));
    if (first >= 0) ls = ls.slice(0, first);
  }
  const paras = [];
  let cur = null;
  let block = 0;  // paragraphs between two blank lines share a block
  for (const l of ls) {
    if (!l.trim()) { cur = null; block++; continue; }
    if (CHROME.some((re) => re.test(l)) || /^[\s─━═│┃╌╍┄┅·•.\-_=]+$/.test(l)) { cur = null; continue; }
    const indent = l.length - l.trimStart().length;
    const body = l.trimStart();
    const mark = MARK.exec(body);
    if (cur && !mark && indent >= cur.col) { cur.text += " " + body; continue; }
    cur = { col: indent + (mark ? mark[0].length : 0), text: body, out: OUTPUT.test(l), item: Boolean(mark) && !/^[⏺●⎿※✻]/u.test(mark[0]), block, recap: /^※\s*recap:/i.test(body) };
    paras.push(cur);
  }
  const tidy = (p) => p.text.replace(/^[⏺●•⎿✻]\s+/u, "").replace(/^※\s*recap:\s*/i, "")
    .replace(/\s*\(disable recaps in \/config\)/i, "").replace(/\s+/g, " ").trim();
  const recap = lastIndex(paras, (p) => p.recap);
  if (recap >= 0 && !paras.slice(recap + 1).some((p) => p.out)) return tidy(paras[recap]);
  if (!paras.length) return "";
  // A menu's question often needs the line above it (the command it asks about).
  let from = paras.length - (menu ? 2 : 1);
  // A list at the end: start at the line that leads into it ("Four things are waiting on
  // you:"), so the clamp shows the lead-in and the first items rather than the last item.
  const last = paras[paras.length - 1];
  if (!menu && last.item) {
    while (from > 0 && paras[from - 1].item && paras[from - 1].block === last.block) from--;
    if (from > 0 && !paras[from - 1].item && paras[from - 1].block === last.block) from--;
  }
  const take = paras.slice(Math.max(0, from));
  return take.map(tidy).filter(Boolean).join(menu ? " · " : " ");
}
