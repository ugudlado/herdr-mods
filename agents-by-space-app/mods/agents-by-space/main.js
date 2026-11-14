// Agents by space: a "Needs you" inbox on top (with each agent's last lines and a reply box),
// then every agent grouped by machine and space. Built on Herdr's shipped `agents` mod.
// Reads terminal screens with `hc read <t> --lines 0` (the visible screen only, never scrolls)
// and replies with `hc send`. Nothing else runs; no network.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, setAgentOrder, layout, hc } from "herdr";

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
const PREVIEW_MS = 15000;   // how old a screen preview may get before it is read again
const PREVIEW_LINES = 3;

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

// The lines worth reading at the bottom of an agent's screen: drop the input box, rules,
// status lines and footers that agents draw under their output.
const CHROME = /^(❯|>\s*$|─|━|═|╭|╰|│\s*$|⏵|\?\s+for shortcuts|Model:|cwd:|Reset:|esc to|ctrl\+|Press up|auto mode|accept edits|bypass permissions)/i;
export function lastLines(text, n = PREVIEW_LINES) {
  const lines = String(text ?? "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i].trim();
    if (!l || CHROME.test(l) || /^[\s─━═│┃╌╍┄┅·•.\-_=]+$/.test(l)) continue;
    out.unshift(l.replace(/^[●⎿✻✳✶✢·*•]+\s*/u, ""));
  }
  return out.filter(Boolean);
}

// The agent's tab name, or its own title when the tab has no name of its own.
function labelOf(a, tab) {
  const prog = a.program?.name;
  const live = clean(a.title);
  const path = /^[~/]/.test((a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== a.program?.key;
  if (tab?.named && tab.name !== prog) return tab.name;
  return telling ? live : prog || a.address;
}

export default class AgentsBySpace extends View {
  init(_props, cx) {
    // Fold choices the person made (id -> true folded / false open), kept across restarts.
    this.fold = JSON.parse(localStorage.getItem("fold") ?? "{}");
    // Each agent's last state and when it changed, kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.preview = {};      // address -> { lines, at }
    this.reading = new Set();
    this.hovered = null;
    this.stopArmed = null;  // the address whose Stop needs a second click
    this.replyTo = null;
    this.input = InputState.new({ placeholder: "Reply, then Enter" });
    this.input.on("submit", (_e, cx) => this.sendReply(cx));
    cx.timer.every(PREVIEW_MS, (cx) => { this.refreshInbox(cx); cx.notify(); });
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

  read(address, cx, force = false) {
    const p = this.preview[address];
    if (this.reading.has(address) || (!force && p && Date.now() - p.at < PREVIEW_MS)) return;
    this.reading.add(address);
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", address, "--lines", "0"]);
        if (r.code === 0) this.preview[address] = { lines: lastLines(r.stdout), at: Date.now() };
      } catch {}
      this.reading.delete(address);
      cx.notify();
    });
  }

  refreshInbox(cx) {
    for (const a of agents()) if (a.status === "blocked" || a.status === "done") this.read(a.address, cx);
  }

  sendReply(cx) {
    const text = this.input.value().trim();
    const to = this.replyTo;
    if (!text || !to) return;
    // Checked again at send time: the agent may have moved on to a prompt meanwhile.
    if (agents().find((a) => a.address === to)?.status !== "done") { this.replyTo = null; cx.notify(); return; }
    this.input.set_value("");
    this.replyTo = null;
    cx.spawn(async (cx) => {
      try { await hc(["send", to, text]); } catch {}
      delete this.preview[to];
      this.read(to, cx, true);
      cx.notify();
    });
    cx.notify();
  }

  isFolded(id, auto) { return this.fold[id] ?? auto; }
  toggle(id, auto, cx) {
    this.fold[id] = !this.isFolded(id, auto);
    localStorage.setItem("fold", JSON.stringify(this.fold));
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

  // Peek, pin and stop; stop needs a second click.
  actions(t, a) {
    const armed = this.stopArmed === a.address;
    return h_flex().gap(1).flex_none()
      .child(this.iconButton(t, `peek-${a.address}`, "mods/workspace-chrome/eye.svg", "Peek without switching", () => run("terminal.peek", { terminal: a.address })))
      .child(this.iconButton(t, `pin-${a.address}`, `mods/workspace-chrome/${a.pinned ? "pin-off" : "pin"}.svg`, a.pinned ? "Unpin" : "Pin to the top",
        (cx) => { run("terminal.pin", { terminal: a.address, pinned: !a.pinned }); this.hovered = null; cx.notify(); }))
      .child(this.iconButton(t, `stop-${a.address}`, armed ? "Stop?" : "■", armed ? "Click again to end this agent" : "Stop this agent", (cx) => {
        if (!armed) { this.stopArmed = a.address; cx.notify(); return; }
        this.stopArmed = null;
        run("terminal.kill", { terminal: a.address });
        cx.notify();
      }, armed));
  }

  row(t, a, now, opts = {}) {
    const pic = icon(a.program, 16, t.foreground);
    const on = this.hovered === a.address;
    const idle = a.status === "idle" && !a.focused;
    const when = this.since(a);
    const age = when ? (a.status === "idle" || a.status === "done" ? `idle ${duration(now - when)}` : duration(now - when)) : "";
    const tip = (this.preview[a.address]?.lines ?? []).join("\n");
    return h_flex().id(`${opts.prefix ?? "ag"}-${a.address}`).px(8).h(30).flex_none().rounded(8).items_center().gap(9)
      .when(a.focused, (el) => el.bg(t.selected))
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((h, cx) => {
        if (h) { this.hovered = a.address; this.read(a.address, cx); }
        else if (this.hovered === a.address) { this.hovered = null; if (this.stopArmed === a.address) this.stopArmed = null; }
        cx.notify();
      })
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .when(Boolean(tip) && !opts.noTip, (el) => el.tooltip(tip))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(h_flex().flex_1().min_w(0).gap(5).items_center()
        .child(div().min_w(0).truncate().text_color(idle ? t.muted : t.foreground).child(opts.name ?? a.label))
        .when(Boolean(opts.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`· ${opts.detail}`))))
      .when(on, (el) => el.child(this.actions(t, a)))
      .when(!on && Boolean(age), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(age)))
      .child(this.status(t, a.status, opts.compact ?? true));
  }

  subRow(t, s, listed) {
    const k = s.t;
    const st = kidStatus(k, listed);
    const pic = icon(k.program, 14, t.foreground);
    return h_flex().id(`sub-${k.address}`).pl(30 + s.depth * 14).pr(8).h(26).flex_none().rounded(8).gap(8).items_center().text_size(12.5)
      .hover((el) => el.bg(t.hover))
      .on_click(() => (listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : run("terminal.peek", { terminal: k.address })))
      .child(div().text_color(t.dim).child("└"))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().truncate().text_color(t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, st));
  }

  // One inbox card: the row, the last lines on screen, and Reply.
  card(t, a, now) {
    const lines = this.preview[a.address]?.lines;
    const replying = this.replyTo === a.address;
    return v_flex().flex_none().mb(4).pb(6).rounded(9).border(1).border_color(a.status === "blocked" ? t.blocked + "66" : t.border).bg(t.surface)
      .child(this.row(t, a, now, { prefix: "in", name: a.space_name || a.label, detail: a.space_name ? a.label : null, compact: false, noTip: true }))
      .child(v_flex().px(12).gap(1).text_size(11.5).text_color(t.muted)
        .children((lines ?? ["…"]).map((l, i) => div().id(`ln-${a.address}-${i}`).truncate().child(l))))
      .child(h_flex().px(10).pt(5).gap(6).items_center()
        .when(replying, (el) => el.child(Input.new(this.input).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12).text_color(t.foreground)))
        // No Reply for a blocked agent: it is usually at a permission prompt, and typed text plus
        // Enter could answer it. Open it and answer there.
        .when(!replying && a.status === "done", (el) => el
          .child(this.pill(t, `reply-${a.address}`, "Reply", (cx) => { this.replyTo = a.address; this.input.set_value(""); this.input.focus(); cx.notify(); })))
        .when(!replying, (el) => el
          .child(this.pill(t, `open-${a.address}`, "Open", () => run("pane.focus", { pane: a.pane })))
          .child(this.pill(t, `peek2-${a.address}`, "Peek", () => run("terminal.peek", { terminal: a.address }))))
        .when(replying, (el) => el.child(this.pill(t, `cancel-${a.address}`, "Esc", (cx) => { this.replyTo = null; cx.notify(); }))));
  }

  pill(t, id, text, action) {
    return div().id(id).h(22).px(8).rounded(6).flex().items_center().text_size(11.5).border_1().border_color(t.input).bg(t.raised)
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(text);
  }

  header(t, id, text, opts) {
    const folded = this.isFolded(id, opts.autoFold ?? false);
    return h_flex().id(id).px(opts.indent ?? 8).pt(opts.top ?? 6).h(opts.h ?? 28).flex_none().gap(6).items_center()
      .text_size(opts.size ?? 11).font_medium().cursor_pointer()
      .on_click((_e, cx) => this.toggle(id, opts.autoFold ?? false, cx))
      .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(10).flex_none().text_color(t.dim))
      .child(div().truncate().text_color(opts.color ?? t.dim).child(text))
      .when(Boolean(opts.count), (el) => el.child(div().text_color(t.dim).child(opts.count)))
      .child(div().flex_1())
      .when(Boolean(opts.top_status) && folded, (el) => el.child(this.status(t, opts.top_status)));
  }

  // ---- render -----------------------------------------------------------------------------

  render(cx) {
    const t = theme();
    const now = Date.now();
    const all = terminals();
    let list = agents();
    const listed = new Map(list.map((a) => [a.address, a.status]));
    this.track(list, now);

    // Sub-agents shown under their parent get no row of their own, unless pinned.
    const nested = new Set(list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));

    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((tab) => [tab.id, tab]));
    const machineOf = new Map(spaces().map((s) => [s.id, s.machine ?? null]));
    for (const a of list) a.label = labelOf(a, tabs.get(a.tab));
    const urgency = (a) => Math.max(RANK[a.status] ?? 0, ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, listed)] ?? 0));
    const order = (x, y) => urgency(y) - urgency(x) || this.since(y) - this.since(x) || y.seq - x.seq;

    // Narrow rail: numbers and status only, as Herdr's own.
    if (narrow()) {
      const sorted = [...list].sort(order);
      setAgentOrder(sorted.map((a) => a.address));
      return v_flex().size_full().bg(t.chrome).border_t(1).border_color(t.border).text_size(13).pt(8)
        .children(sorted.map((a, i) => h_flex().id(`n-${a.address}`).h(26).px(8).items_center().gap(4).hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).justify_center().child(this.status(t, a.status)))));
    }

    const inbox = list.filter((a) => a.status === "blocked" || a.status === "done").sort(order);
    if (inbox.some((a) => !this.preview[a.address])) this.refreshInbox(cx);
    const pinned = list.filter((a) => a.pinned).sort(order);

    // machine -> space -> agents, machines: this computer first, then by name.
    const machines = new Map();
    for (const a of list.filter((a) => !a.pinned)) {
      const m = machineOf.get(a.space) ?? (a.address.includes("/") ? a.address.split("/")[0] : null);
      if (!machines.has(m)) machines.set(m, new Map());
      const sp = machines.get(m);
      if (!sp.has(a.space)) sp.set(a.space, { id: a.space, name: a.space_name || "space", members: [] });
      sp.get(a.space).members.push(a);
    }
    const machineList = [...machines.entries()].sort(([x], [y]) => (x === null ? -1 : y === null ? 1 : x.localeCompare(y)));

    const rows = [];
    const navOrder = [];
    const withKids = (a, opts) => {
      navOrder.push(a.address);
      return [this.row(t, a, now, opts), ...this.tree(all, a.address).map((s) => this.subRow(t, s, listed))];
    };

    if (inbox.length) {
      rows.push(this.header(t, "inbox", "Needs you", { color: t.blocked, count: String(inbox.length), top: 4 }));
      if (!this.isFolded("inbox", false)) rows.push(...inbox.map((a) => this.card(t, a, now)));
    }
    if (pinned.length) {
      rows.push(this.header(t, "pinned", "Pinned", { count: String(pinned.length) }));
      if (!this.isFolded("pinned", false)) for (const a of pinned) rows.push(...withKids(a, { name: a.space_name || a.label, detail: a.label }));
    }
    for (const [m, sp] of machineList) {
      const mid = `m-${m ?? "local"}`;
      const n = [...sp.values()].reduce((c, s) => c + s.members.length, 0);
      if (machineList.length > 1 || m !== null) rows.push(this.header(t, mid, m ?? "This computer", { size: 11.5, color: t.muted, count: String(n), top: 10 }));
      if (this.isFolded(mid, false)) continue;
      const spacesSorted = [...sp.values()].sort((x, y) => Math.max(...y.members.map(urgency)) - Math.max(...x.members.map(urgency)) || x.name.localeCompare(y.name));
      for (const s of spacesSorted) {
        s.members.sort(order);
        const allIdle = s.members.every((a) => a.status === "idle");
        const top = s.members.reduce((best, a) => ((RANK[a.status] ?? 0) > (RANK[best] ?? 0) ? a.status : best), null);
        const sid = `s-${s.id}`;
        // A space where every agent is idle folds by itself until you open it.
        rows.push(this.header(t, sid, s.name, { indent: 14, count: s.members.length > 1 || allIdle ? String(s.members.length) : null, autoFold: allIdle, top_status: top, top: 2, h: 26 }));
        if (this.isFolded(sid, allIdle)) { navOrder.push(...s.members.map((a) => a.address)); continue; }
        for (const a of s.members) rows.push(...withKids(a, {}));
      }
    }
    setAgentOrder([...inbox.map((a) => a.address), ...navOrder.filter((x) => !inbox.some((a) => a.address === x))]);

    return v_flex().size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center().justify_between()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
        .child(div().text_size(11).text_color(t.dim).child(`${list.length} · ${list.filter((a) => a.status === "working").length} working`)))
      .when(list.length === 0, (el) => el.child(div().px(16).text_size(12).text_color(t.dim).child("No agents yet. Agents show up here when they report their status.")))
      .child(v_flex().id("abs-list").flex_1().min_h(0).px(8).overflow_y_scrollbar().children(rows));
  }
}
