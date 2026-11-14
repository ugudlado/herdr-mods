// Agents by space: a "Needs you" inbox on top (with each agent's last paragraph and a reply box),
// then every agent grouped by machine and space. Built on Herdr's shipped `agents` mod.
// Reads terminal screens with `hc read <t> --lines 0` (the visible screen only, never scrolls)
// and replies with `hc send`. Nothing else runs; no network.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, spaces, run, theme, setAgentOrder, layout, hc, exec, knownAgents, openOverlay, closeOverlay, props, shared, setShared } from "herdr";
import { lastLines, menuOnScreen } from "./screen.js";

const MOD = "agents-by-space";
const TEAM_MS = 60000;      // how often `hc-team ls` runs on a machine with a team
const QUICK = ["claude", "codex"];  // agents a space label can start, when installed there
const STOP_GAP_MS = 500;    // the confirming click of Stop must come this long after the first
const STOP_ARMED_MS = 4000; // Stop disarms after this long
const INBOX_KEY = "agents-by-space.inbox";  // shared: [{ a: address, at: when it entered }]
const SORT_KEY = "agents-by-space.sort"; // "activity" (default) or "name"
const SPACE_W = 64;         // the space-name column of a row

// `hc-team ls` lines: "<slug>  lead=<status>  workers=<n>" and "box: <machine> <bx_id>".
export function parseTeams(text) {
  const teams = {};
  for (const line of String(text ?? "").split("\n")) {
    const m = /^(\S+)\s+lead=(\S+)\s+workers=(\d+)/.exec(line);
    if (m) teams[m[1]] = { lead: m[2], workers: Number(m[3]), boxes: 0 };
  }
  for (const line of String(text ?? "").split("\n")) {
    const b = /^box:\s+hct-(\S+)-\d+\s/.exec(line);
    if (b && teams[b[1]]) teams[b[1]].boxes++;
  }
  return teams;
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const PREVIEW_MS = 15000;   // how old a screen preview may get before it is read again
const NOT_WAITING = "Not sent: the agent is no longer waiting.";
const MENU_UP = "Not sent: a menu is on screen — Open it.";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// The sticky "Needs you" set. Herdr turns "done" into "idle" as soon as anyone looks
// (Peek too), so the inbox keeps its own list, shared by every copy and kept across restarts.
function readInbox() {
  const v = shared(INBOX_KEY);
  return Array.isArray(v) ? v.filter((e) => e && typeof e.a === "string" && Number.isFinite(e.at)) : [];
}
function leaveInbox(address) {
  const cur = readInbox();
  if (cur.some((e) => e.a === address)) setShared(INBOX_KEY, cur.filter((e) => e.a !== address));
}

const machineOfAddress = (address) => (address.includes("/") ? address.split("/")[0] : null);

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// A sub-agent without a pane isn't in agents(): error counts as blocked, done as idle (its parent reports).
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};

// A title without the noise: walky-talky headers, message ids, hex ids and the space's own name.
const SEP = "\\s·:|/—–-";
export function tidyTitle(s, spaceName) {
  let x = clean(s).replace(/^Walky-talky message\s+wt_\w+/i, "").replace(/\bwt_\w+/g, "")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "");
  if (spaceName) {
    const name = spaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Only the name as a word of its own: "chaduvu-project" keeps its name, or "-project" is left.
    x = x.replace(new RegExp(`(^|\\s)${name}(?=$|\\s|[:·|,])`, "gi"), "$1");
  }
  return x.replace(new RegExp(`^[${SEP}]+|[${SEP}]+$`, "g"), "").replace(/\s{2,}/g, " ").trim();
}

// The agent's tab name, or its own title when the tab has no name of its own; the program's
// name when nothing is left after tidying.
function labelOf(a, tab, spaceName) {
  const prog = a.program?.name;
  const live = tidyTitle(a.title, spaceName);
  const path = /^[~/]/.test((a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  if (tab?.named && tab.name !== prog) {
    const named = tidyTitle(tab.name, spaceName);
    if (named) return named;
  }
  return telling ? live : prog || a.address;
}

export default class AgentsBySpace extends View {
  init(_props, cx) {
    if (props()?.quickMenu) return;
    // Each agent's last state and when it changed, kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.preview = {};      // address -> { text, menu, at }, from the raw screen
    this.reading = new Set();
    this.hovered = null;
    this.stopArmed = null;  // the address whose Stop needs a second click
    this.armedAt = 0;
    this.replyTo = null;
    this.draftFor = null;   // whose reply the input holds
    this.note = null;       // { to, text }: why a reply was not sent
    this.sending = false;
    this.input = InputState.new({ placeholder: "Reply, then Enter" });
    this.input.on("submit", (_e, cx) => this.sendReply(cx));
    this.teams = {};        // machine -> { slug: { lead, workers, boxes } } or { failed: true }
    this.teamAt = {};       // machine -> when it was asked
    this.quick = {};        // machine -> installed agents of QUICK, from knownAgents(); absent = checking
    this.quickAsked = new Set();
    this.downAt = null;     // where the last + was pressed, for its popup
    cx.timer.every(PREVIEW_MS, (cx) => { this.refreshInbox(cx); cx.notify(); });
  }

  // Team counts from `hc-team ls` on the lead's machine: box workers are two hops away, so
  // only that machine's core sees them. Only machines that show a lead are asked.
  readTeams(machine, cx) {
    const key = machine ?? "";
    if (this.teamAt[key] && Date.now() - this.teamAt[key] < TEAM_MS) return;
    this.teamAt[key] = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-lc", 'PATH="$HOME/.local/bin:$PATH"; command -v hc-team >/dev/null && hc-team ls'], { on: machine, timeout: 20000 });
        this.teams[key] = r.code === 0 ? parseTeams(r.stdout) : this.teams[key] ?? { failed: true };
      } catch { this.teams[key] = this.teams[key] ?? { failed: true }; }
      cx.notify();
    });
  }

  readQuick(machine, cx) {
    const key = machine ?? "";
    if (this.quickAsked.has(key)) return;
    this.quickAsked.add(key);
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on: machine });
        this.quick[key] = QUICK.map((k) => list.find((a) => a.key === k && a.installed)).filter(Boolean)
          .map((a) => ({ key: a.key, name: a.name, run: a.run }));
      } catch { this.quick[key] = []; }  // nothing to start there until the mod reloads
      cx.notify();
    });
  }

  // ---- data -------------------------------------------------------------------------------

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }
  since(a) { return this.changed[a.address]?.at ?? 0; }

  age(a, now, entered) {
    if (a.status === "idle" && entered) return `done ${duration(now - entered)}`;
    const when = this.since(a);
    if (!when) return "";
    const d = duration(now - when);
    return { done: `done ${d}`, blocked: `waiting ${d}`, idle: `idle ${d}` }[a.status] ?? d;
  }

  // The screen as read: the paragraph to show and whether a menu is up (from the raw text).
  remember(address, raw) {
    this.preview[address] = { text: lastLines(raw), menu: menuOnScreen(raw), at: Date.now() };
  }

  read(address, cx, force = false) {
    const p = this.preview[address];
    if (this.reading.has(address) || (!force && p && Date.now() - p.at < PREVIEW_MS)) return;
    this.reading.add(address);
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", address, "--lines", "0"]);
        if (r.code === 0) this.remember(address, r.stdout);
      } catch {}
      this.reading.delete(address);
      cx.notify();
    });
  }

  refreshInbox(cx) {
    const sticky = new Set(readInbox().map((e) => e.a));
    for (const a of agents()) if (a.status === "blocked" || a.status === "done" || sticky.has(a.address)) this.read(a.address, cx);
  }

  // Keeps the sticky set in step: an agent enters when it turns done or blocked, and leaves
  // when it works again or its terminal is gone. Open, a sent Reply and Dismiss remove it too.
  syncInbox(list, all, now) {
    const cur = readInbox();
    const status = new Map(list.map((a) => [a.address, a.status]));
    const live = new Set(all.filter((x) => x.state === "live").map((x) => x.address));
    const next = cur.filter((e) => status.get(e.a) !== "working" && (live.has(e.a) || status.has(e.a) || !all.length));
    for (const a of list) if ((a.status === "done" || a.status === "blocked") && !next.some((e) => e.a === a.address)) next.push({ a: a.address, at: now });
    if (next.length !== cur.length || next.some((e, i) => e.a !== cur[i]?.a)) setShared(INBOX_KEY, next);
    return new Map(next.map((e) => [e.a, e.at]));
  }

  // Go to an agent of the inbox: that is answering it, so it leaves the inbox.
  openAgent(a) {
    leaveInbox(a.address);
    run("pane.focus", { pane: a.pane });
  }

  // Reply needs an agent that is not working or blocked, with no menu on screen. Unknown
  // (not read yet) counts as a menu.
  canReply(a) {
    return a.status !== "working" && a.status !== "blocked" && this.preview[a.address]?.menu === false;
  }

  openReply(address, cx) {
    if (this.draftFor !== address) { this.input.set_value(""); this.draftFor = address; }
    this.replyTo = address;
    this.note = null;
    this.input.focus();
    cx.notify();
  }

  cancelReply(cx) {
    this.replyTo = null;
    this.note = null;
    cx.notify();
  }

  // The text stays in the box until `hc send` succeeds; otherwise the card says why.
  sendReply(cx) {
    const text = this.input.value().trim();
    const to = this.replyTo;
    if (!text || !to || this.sending) return;
    const waiting = () => { const s = agents().find((a) => a.address === to)?.status; return Boolean(s) && s !== "working" && s !== "blocked"; };
    const fail = (why) => { this.note = { to, text: why }; };
    if (!waiting()) { fail(NOT_WAITING); cx.notify(); return; }
    if (this.preview[to]?.menu !== false) { fail(MENU_UP); cx.notify(); return; }
    this.sending = true;
    this.note = null;
    cx.spawn(async (cx) => {
      try {
        // Read the screen again right before typing: Enter would pick a menu's selected option.
        const r = await hc(["read", to, "--lines", "0"]);
        if (r.code !== 0) fail("Not sent: could not read the agent's screen.");
        else {
          this.remember(to, r.stdout);
          if (this.preview[to].menu) fail(MENU_UP);
          else if (!waiting()) fail(NOT_WAITING);
          else {
            const s = await hc(["send", to, text]);
            if (s.code !== 0) fail(`Not sent: ${(s.stderr || "hc send failed").trim().split("\n")[0]}`);
            else {
              if (this.draftFor === to) { this.input.set_value(""); this.draftFor = null; }
              if (this.replyTo === to) this.replyTo = null;
              leaveInbox(to);
              this.read(to, cx, true);
            }
          }
        }
      } catch { fail("Not sent: hc did not answer."); }
      this.sending = false;
      cx.notify();
    });
    cx.notify();
  }

  // Live sub-agents of `addr` (an hc-team lead's workers, say), depth first.
  tree(all, addr, depth = 0) {
    return all.filter((k) => k.parent === addr && k.state === "live")
      .flatMap((k) => [{ t: k, depth }, ...this.tree(all, k.address, depth + 1)]);
  }

  // ---- pieces -----------------------------------------------------------------------------

  status(t, s, compact = true) {
    if (s === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (s === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (s === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    if (s === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(s === "done" ? t.done : t.dim + "00");
  }

  iconButton(t, id, glyph, tip, action, danger = false) {
    return div().id(id).flex_none().px(4).h(20).rounded(4).flex().items_center().text_size(11)
      .text_color(danger ? t.blocked : t.dim).cursor_pointer()
      .hover((s) => s.bg(t.hover).text_color(danger ? t.blocked : t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(glyph.endsWith(".svg") ? svg(glyph).size(13) : glyph);
  }

  // Stop asks for a second click, at least STOP_GAP_MS after the first; it disarms on
  // hover-out and after STOP_ARMED_MS.
  stopButton(t, a, machine) {
    const armed = this.stopArmed === a.address;
    const where = machine ?? "This computer";
    return this.iconButton(t, `stop-${a.address}`, armed ? "Stop?" : "■", armed ? `End ${a.label} on ${where}` : "Stop this agent", (cx) => {
      const now = Date.now();
      if (!armed) {
        this.stopArmed = a.address;
        this.armedAt = now;
        cx.timer.after(STOP_ARMED_MS, (cx) => {
          if (this.stopArmed === a.address && Date.now() - this.armedAt >= STOP_ARMED_MS - 50) { this.stopArmed = null; cx.notify(); }
        });
        cx.notify();
        return;
      }
      if (now - this.armedAt < STOP_GAP_MS) return;
      this.stopArmed = null;
      run("terminal.kill", { terminal: a.address });
      cx.notify();
    }, armed);
  }

  // Peek and pin; rows add Stop (inbox cards don't).
  actions(t, a, opts) {
    return h_flex().gap(1).flex_none()
      .child(this.iconButton(t, `peek-${opts.prefix}-${a.address}`, "mods/workspace-chrome/eye.svg", "Peek without switching", () => run("terminal.peek", { terminal: a.address })))
      .child(this.iconButton(t, `pin-${opts.prefix}-${a.address}`, `mods/workspace-chrome/${a.pinned ? "pin-off" : "pin"}.svg`, a.pinned ? "Unpin" : "Pin to the top",
        (cx) => { run("terminal.pin", { terminal: a.address, pinned: !a.pinned }); this.hovered = null; cx.notify(); }))
      .when(!opts.noStop, (el) => el.child(this.stopButton(t, a, opts.machine)));
  }

  tag(t, text, color) {
    return div().flex_none().px(5).h(16).rounded(4).border_1().border_color(color ? color + "66" : t.border).text_size(10)
      .text_color(color ?? t.muted).flex().items_center().child(text);
  }

  // One agent on one line: [space] icon label [team] [machine] age status. Inbox cards use it
  // as their head; under a machine every agent is one of these.
  row(t, a, now, opts = {}) {
    const prefix = opts.prefix ?? "ag";
    const pic = icon(a.program, 14, t.foreground);
    const key = `${prefix}-${a.address}`;
    const on = this.hovered === key;
    const idle = a.status === "idle" && !a.focused && !opts.marker;
    const age = this.age(a, now, opts.entered);
    const tip = this.preview[a.address]?.text ?? "";
    return h_flex().id(key).px(6).h(opts.h ?? 27).flex_none().rounded(7).items_center().gap(6)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => {
        if (h) { this.hovered = key; this.read(a.address, cx); }
        else if (this.hovered === key) { this.hovered = null; if (this.stopArmed === a.address) this.stopArmed = null; }
        cx.notify();
      })
      .on_click(() => (opts.marker || opts.inbox ? this.openAgent(a) : run("pane.focus", { pane: a.pane })))
      .when(Boolean(tip) && !opts.noTip, (el) => el.tooltip(tip))
      .when(opts.space != null, (el) => el.child(div().w(SPACE_W).flex_none().truncate().text_size(11).text_color(t.muted).child(opts.space)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).truncate().text_size(opts.inbox ? 13 : 12.5).text_color(idle ? t.muted : t.foreground).child(opts.name ?? a.label))
        .when(Boolean(opts.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(`· ${opts.detail}`))))
      .when(Boolean(opts.team) && !on, (el) => el.child(this.tag(t, opts.team.text, opts.team.color)))
      .when(Boolean(opts.tag) && !on, (el) => el.child(this.tag(t, opts.tag)))
      .when(on, (el) => el.child(this.actions(t, a, { ...opts, prefix })))
      .when(!on && Boolean(opts.marker), (el) => el.child(div().flex_none().text_size(10.5).text_color(opts.marker?.color).child(opts.marker?.text)))
      .when(!on && !opts.marker && Boolean(age), (el) => el.child(div().flex_none().text_size(11).text_color(t.muted).child(age)))
      .child(this.status(t, a.status, opts.compact ?? true));
  }

  subRow(t, s, listed) {
    const k = s.t;
    const st = kidStatus(k, listed);
    const pic = icon(k.program, 13, t.foreground);
    return h_flex().id(`sub-${k.address}`).pl(12 + SPACE_W + s.depth * 12).pr(6).h(24).flex_none().rounded(7).gap(6).items_center().text_size(12)
      .hover((el) => el.bg(t.hover))
      .on_click(() => (listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
      .child(div().text_color(t.dim).child("└"))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, st));
  }

  // One inbox card: "space · label" with the machine, the agent's last paragraph (3 lines at
  // most), and Reply / Open / Peek / Dismiss.
  card(t, a, now, entered) {
    const p = this.preview[a.address];
    const replying = this.replyTo === a.address;
    const note = this.note?.to === a.address ? this.note.text : null;
    const machine = machineOfAddress(a.address);
    return v_flex().flex_none().mb(4).pb(6).rounded(9).border(1).border_color(a.status === "blocked" ? t.blocked + "66" : t.border).bg(t.surface)
      .child(this.row(t, a, now, { prefix: "in", inbox: true, h: 30, name: a.space_name || a.label, detail: a.space_name ? a.label : null, compact: false, noTip: true, noStop: true, tag: machine, entered }))
      .child(div().id(`pv-${a.address}`).mx(12).text_size(11.5).line_height("16px").max_h(48).overflow_hidden().text_color(t.muted)
        .child(p ? p.text || "Nothing to read on screen." : "…"))
      .when(Boolean(note), (el) => el.child(div().id(`note-${a.address}`).mx(12).pt(4).text_size(11).text_color(t.blocked).child(note)))
      .child(h_flex().px(10).pt(5).gap(6).items_center()
        .when(replying, (el) => el
          .child(div().id(`reply-box-${a.address}`).flex_1().min_w(0)
            .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.cancelReply(cx); } })
            .child(Input.new(this.input).w_full().h(26).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground)))
          .child(this.pill(t, `cancel-${a.address}`, this.sending ? "Sending…" : "Cancel", (cx) => this.cancelReply(cx))))
        // No Reply while the agent works or is blocked, or with a menu on screen: typed text plus
        // Enter could answer it. Open it and answer there.
        .when(!replying && this.canReply(a), (el) => el.child(this.pill(t, `reply-${a.address}`, "Reply", (cx) => this.openReply(a.address, cx))))
        .when(!replying, (el) => el
          .child(this.pill(t, `open-${a.address}`, "Open", () => this.openAgent(a)))
          .child(this.pill(t, `peek2-${a.address}`, "Peek", () => run("terminal.peek", { terminal: a.address })))
          .child(div().flex_1())
          .child(this.iconButton(t, `dismiss-${a.address}`, "✓", "Dismiss: take it off Needs you", (cx) => {
            leaveInbox(a.address);
            if (this.note?.to === a.address) this.note = null;
            cx.notify();
          }))));
  }

  pill(t, id, text, action) {
    return div().id(id).flex_none().h(22).px(8).rounded(6).flex().items_center().text_size(11.5).border_1().border_color(t.input).bg(t.raised)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
  }

  // The inbox and Pinned labels.
  label(t, id, text, opts = {}) {
    return h_flex().id(id).px(8).pt(opts.top ?? 6).h(28).flex_none().gap(6).items_center()
      .text_size(11).font_medium()
      .child(div().truncate().text_color(opts.color ?? t.muted).child(text))
      .when(Boolean(opts.count), (el) => el.child(div().text_color(t.muted).child(opts.count)));
  }

  // A machine: a section divider with a thin rule above it, and a + that starts a terminal, Claude or
  // Codex in one of its spaces.
  machineLabel(t, m, need, spaceList) {
    const key = m ?? "";
    return h_flex().id(`m-${m ?? "local"}`).mt(8).pl(6).pr(4).pt(6).pb(2).flex_none().gap(4).items_center()
      .border_t(1).border_color(t.border).text_size(11).font_semibold()
      .child(div().truncate().text_color(t.muted).child((m ?? "This computer").toUpperCase()))
      .when(need > 0, (el) => el.child(div().flex_none().text_color(t.blocked).child(`· ${need} need you`)))
      .child(div().flex_1())
      .child(div().id(`q-${m ?? "local"}`).flex_none().w(20).h(18).rounded(4).flex().items_center().justify_center()
        .text_size(14).font_medium().text_color(t.muted).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
        .tooltip(`New terminal, Claude or Codex tab in a space on ${m ?? "this computer"}`)
        .on_mouse_down("left", (e) => { this.downAt = e?.position ? { x: e.position.x, y: e.position.y } : null; })
        .on_click((_e, cx) => {
          cx.stop_propagation();
          openOverlay({ mod: MOD, kind: "popup", width: 260, at: this.downAt ?? "pointer",
            props: { quickMenu: { machine: m, spaces: spaceList, choices: this.quick[key] ?? null } } });
        })
        .child("+"));
  }

  // The hc-team tag on a lead's row, from `hc-team ls` on its machine.
  teamTag(t, team) {
    if (!team.lead) return { text: team.failed ? "team · ?" : team.missing ? "team · not listed" : "team · loading" };
    const counts = plural(team.workers, "worker", "workers") + (team.boxes ? ` · ${plural(team.boxes, "box", "boxes")}` : "");
    return team.lead === "blocked" ? { text: `team · lead needs you · ${counts}`, color: t.blocked } : { text: `team · ${counts}` };
  }

  // The + popup: each space of the machine with a button per installed agent.
  quickMenu(t, q) {
    const where = q.machine ?? "this computer";
    // A terminal is always there (the machine's own shell); agents only when installed.
    const choices = [{ key: "terminal", name: "Terminal", run: null }, ...(q.choices ?? [])];
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.5)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.muted).child(`New tab on ${where}`))
      .when(!q.choices, (el) => el.child(div().px(8).pb(6).text_size(11).text_color(t.muted).child(`Checking for Claude and Codex on ${where}…`)))
      .children((q.spaces ?? []).map((s) => h_flex().id(`qs-${s.id}`).h(30).px(8).gap(6).rounded(7).items_center()
        .hover((st) => st.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(s.name))
        .children(choices.map((a) => this.pill(t, `qm-${s.id}-${a.key}`, `+ ${a.name.replace(/ Code$/, "")}`, () => {
          run("tab.new", a.run ? { space: s.id, name: a.name, argv: a.run } : { space: s.id });
          closeOverlay(props().overlay);
        }).tooltip(`New ${a.name.toLowerCase() === "terminal" ? "terminal" : a.name} tab in ${s.name}`)))));
  }

  // ---- render -----------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const q = props()?.quickMenu;
    if (q) return this.quickMenu(t, q);
    const now = Date.now();
    const all = terminals();
    let list = agents();
    const listed = new Map(list.map((a) => [a.address, a.status]));
    this.track(list, now);
    const sticky = this.syncInbox(list, all, now);

    // Sub-agents shown under their parent get no row of their own, unless pinned.
    const nested = new Set(list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));

    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const machineOf = new Map(spaces().map((s) => [s.id, s.machine ?? null]));
    const machineFor = (a) => machineOf.get(a.space) ?? machineOfAddress(a.address);
    for (const a of list) a.label = labelOf(a, tabs.get(a.tab), a.space_name);
    // An agent of the sticky inbox ranks as done even after it turned idle.
    const rankOf = (address, s) => Math.max(RANK[s] ?? 0, sticky.has(address) ? RANK.done : 0);
    const urgency = (a) => Math.max(rankOf(a.address, a.status), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, listed)] ?? 0));
    // "activity": most urgent first, then most recently changed. "name": spaces and agents A to Z.
    const byName = shared(SORT_KEY) === "name";
    const byText = (x, y) => x.localeCompare(y, undefined, { sensitivity: "base", numeric: true });
    const latest = (s) => Math.max(...s.members.map((a) => this.since(a)));
    const order = byName
      ? (x, y) => byText(x.space_name || "", y.space_name || "") || byText(x.label || "", y.label || "")
      : (x, y) => urgency(y) - urgency(x) || this.since(y) - this.since(x) || y.seq - x.seq;
    const spaceOrder = byName
      ? (x, y) => byText(x.name, y.name)
      : (x, y) => Math.max(...y.members.map(urgency)) - Math.max(...x.members.map(urgency)) || latest(y) - latest(x) || byText(x.name, y.name);

    const inbox = list.filter((a) => sticky.has(a.address))
      .sort((x, y) => (y.status === "blocked") - (x.status === "blocked") || sticky.get(y.address) - sticky.get(x.address));
    if (inbox.some((a) => !this.preview[a.address])) this.refreshInbox(cx);
    const pinned = list.filter((a) => a.pinned).sort(order);

    // machine -> its agents, grouped by space (spaces by urgency, then name). This computer first.
    const machines = new Map();
    for (const a of list.filter((a) => !a.pinned)) {
      const m = machineFor(a);
      if (!machines.has(m)) machines.set(m, new Map());
      const sp = machines.get(m);
      if (!sp.has(a.space)) sp.set(a.space, { id: a.space, name: a.space_name || "space", members: [] });
      sp.get(a.space).members.push(a);
    }
    const machineList = [...machines.entries()].sort(([x], [y]) => (x === null ? -1 : y === null ? 1 : x.localeCompare(y)))
      .map(([m, sp]) => {
        const spacesSorted = [...sp.values()].sort(spaceOrder);
        for (const s of spacesSorted) s.members.sort(order);
        return [m, spacesSorted];
      });

    // One order for both modes and for keyboard navigation: the inbox, Pinned, then machine and space.
    const seen = new Set();
    const ordered = [];
    const add = (a) => { if (!seen.has(a.address)) { seen.add(a.address); ordered.push(a); } };
    inbox.forEach(add);
    pinned.forEach(add);
    for (const [, ss] of machineList) for (const s of ss) s.members.forEach(add);
    setAgentOrder(ordered.map((a) => a.address));

    // Narrow rail: numbers and status only, as Herdr's own, in the same order as the wide list.
    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).text_size(13).pt(8)
        .children(ordered.map((a, i) => h_flex().id(`n-${a.address}`).h(26).px(8).items_center().gap(4).hover((s) => s.bg(t.hover))
          .tooltip(`${a.space_name || "space"} · ${a.label} · ${machineFor(a) ?? "This computer"}`)
          .on_click(() => (sticky.has(a.address) ? this.openAgent(a) : run("pane.focus", { pane: a.pane })))
          .child(div().flex_1().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).justify_center().child(this.status(t, a.status)))));
    }

    const rows = [];
    const withKids = (a, opts) => [this.row(t, a, now, opts), ...this.tree(all, a.address).map((s) => this.subRow(t, s, listed))];

    if (inbox.length) {
      rows.push(this.label(t, "inbox", "Needs you", { color: t.blocked, count: String(inbox.length), top: 4 }));
      rows.push(...inbox.map((a) => this.card(t, a, now, sticky.get(a.address))));
    }
    if (pinned.length) {
      rows.push(this.label(t, "pinned", "Pinned", { count: String(pinned.length) }));
      for (const a of pinned) rows.push(...withKids(a, { prefix: "pin", space: a.space_name || "", tag: machineOfAddress(a.address), machine: machineFor(a), entered: sticky.get(a.address) }));
    }
    // hc-team leads (labels role=lead, task=<slug>).
    const leadOf = new Map();
    for (const term of all) {
      if (term.state === "live" && term.labels?.role === "lead" && term.labels?.task) leadOf.set(term.address, term.labels.task);
    }
    for (const [m, ss] of machineList) {
      this.readQuick(m, cx);
      if (ss.some((s) => s.members.some((a) => leadOf.has(a.address)))) this.readTeams(m, cx);
      const need = ss.reduce((n, s) => n + s.members.filter((a) => sticky.has(a.address)).length, 0);
      const spaceList = spaces().filter((s) => (s.machine ?? null) === m).map((s) => ({ id: s.id, name: s.name }));
      rows.push(this.machineLabel(t, m, need, spaceList));
      const known = this.teams[m ?? ""];
      for (const s of ss) {
        for (const a of s.members) {
          const slug = leadOf.get(a.address);
          const team = !slug ? null : this.teamTag(t, !known ? {} : known.failed ? known : known[slug] ?? { missing: true });
          const blocked = a.status === "blocked";
          const marker = sticky.has(a.address) ? { text: blocked ? "↑ needs you" : "↑ done", color: blocked ? t.blocked : t.done } : null;
          rows.push(...withKids(a, { space: s.name, team, marker, machine: m }));
        }
      }
    }

    const working = list.filter((a) => a.status === "working").length;
    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("Agents"))
          .child(div().id("abs-sort").h(18).px(6).rounded(5).flex().items_center().gap(3).text_size(10.5)
            .text_color(t.muted).border_1().border_color(t.border).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(byName ? "Sorted by name. Click to sort by activity" : "Sorted by activity. Click to sort by name")
            .on_click(() => setShared(SORT_KEY, byName ? "activity" : "name"))
            .child(byName ? "A–Z" : "Activity").child("⇅")))
        .child(inbox.length
          ? div().text_size(11).font_medium().text_color(t.blocked).child(`${inbox.length} need you`)
          : div().text_size(11).text_color(t.muted).child(`${plural(list.length, "agent", "agents")} · ${working} working`)))
      .when(list.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.muted).child("No agents yet. Agents show up here when they report their status.")))
      .child(v_flex().id("abs-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scrollbar().children(rows));
  }
}
