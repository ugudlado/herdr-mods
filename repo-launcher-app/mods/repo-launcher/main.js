// Repo Launcher: a popup to find a Git repository by a fuzzy name (on this
// computer or on another machine from `hc machine ls`) and start a terminal or
// an installed agent there: in a new tab of the repository's open space, or in
// a new space on the repository's machine.
//
// Three views:
//   list     - the search box and the repositories (recent first)
//   actions  - what to start in the chosen repository, and where
//   settings - the root folders and the agent list
//
// The repository list comes from a cache in shared state. Only Refresh and a
// change of the root folders search the disk again.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { theme, props, closeOverlay, knownAgents, pickFolder, notify, panes, run, shared, machines, window } from "herdr";
import { matchRepo } from "./fuzzy.js";
import { findRepos, displayPath, normalize, pathKey, placeId, validRoot, DEPTH } from "./scan.js";
import { open, spacesFor } from "./launch.js";
import {
  settings, updateSettings, cache, setCache, markOpened, lastOpened,
  agentCache, setAgentCache, remoteAgentCache, setRemoteAgentCache, allRoots,
} from "./store.js";
import {
  icon, tint, spaceColor, repoColor, letterTile, programTile, pill, kbd, hint,
  iconButton, button, segmented, highlighted, ago, sectionTitle,
} from "./ui.js";

// The mods-hub can turn this mod off (shared "herdr-mods.disabled", a list of mod names). Then the mod draws
// nothing and closes its popup.
const kitOff = () => { const v = shared("herdr-mods.disabled"); return Array.isArray(v) && v.includes("repo-launcher"); };
const offView = () => { const o = props()?.overlay; if (o) closeOverlay(o); return div(); };

const RECENT_COUNT = 5;
const ROW_H = 50;
const HEAD_H = 30;
const ACTION_H = 52;
// A popup is as tall as its content, so the lists get a fixed height.
const LIST_MAX = 440;
const EMPTY_H = 300;
const SETTINGS_H = 520;

const SHELL = () => ({ icon: "icons/shell.svg", tint: true, color: theme().foreground, tile: theme().raised });
const ctrl = (key) => (window()?.platform === "macos" ? `⌃${key}` : `Ctrl+${key}`);

// Kept between openings of the popup. `place`: the machine filter of the
// list: "all", "local" or a machine name.
const memory = { scanningSince: 0, checkingAgents: false, checkingRemote: {}, place: "all" };
const isScanning = () => Date.now() - memory.scanningSince < 180000;

// Other machines (`hc machine ls`), by name.
const remoteMachines = () => machines().map((m) => m.name).filter(Boolean);
const homeOf = (machine) => (machine ? cache().machines?.[machine]?.home ?? "" : undefined);
const repoId = (repo) => placeId(repo.machine, repo.path);
const parentOf = (repo) => displayPath(repo.path.slice(0, repo.path.length - repo.name.length), homeOf(repo.machine));
/** A root for people: "vps: ~/src" for another machine. */
function placeLabel(id) {
  const bar = id.indexOf("|");
  if (bar < 0) return displayPath(id);
  const machine = id.slice(0, bar);
  return `${machine}: ${displayPath(id.slice(bar + 1), homeOf(machine))}`;
}

export default class RepoLauncher extends View {
  init(_props, cx) {
    this.view = "list";
    this.filter = "";
    this.at = 0;
    this.actionAt = 0;
    this.repo = null;
    this.handle = cx.focus_handle();
    // Scroll offsets (px) of the lists. `follow`: keep the selection in view.
    this.scrollTop = { list: 0, actions: 0 };
    this.follow = true;

    this.query = InputState.new({ placeholder: "Search repositories…" });
    this.query.on("change", (_e, cx) => {
      this.filter = this.query.value();
      this.at = 0;
      this.scrollTop.list = 0;
      this.follow = true;
      cx.notify();
    });
    this.query.on("submit", (_e, cx) => this.choose(this.selectedRepo(), cx));
    this.query.focus();
    // A folder on another machine is typed: the system picker shows only this computer.
    this.remotePath = InputState.new({ placeholder: "~/code or /srv/repos" });
    this.remotePath.on("submit", (_e, cx) => this.addRemoteRoot(cx));
    this.remoteTarget = null;
    cx.timer.after(600, () => {
      if (this.view === "list") this.query.focus();
    });

    // knownAgents() starts a shell, so it runs only when no list is saved
    // yet, or on Refresh agents in the settings.
    const saved = agentCache().list;
    this.agents = saved ?? [];
    if (!saved) this.refreshAgents(cx);

    // Folders but no cache: a search stopped by closing the popup.
    if (allRoots().length && !cache().scannedAt && !isScanning()) this.scan(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // A text field keeps the keyboard for a moment after it leaves the
  // screen, so the focus is given again a frame later.
  focusRoot(cx) {
    this.handle.focus();
    cx.timer.after(40, () => this.handle.focus());
  }

  focusQuery(cx) {
    this.query.focus();
    cx.timer.after(40, () => this.query.focus());
  }

  // ---------------------------------------------------------------------------
  // Data

  /**
   * Searches the roots of each machine at the same time. A machine that
   * cannot be reached keeps the repositories of its last search.
   */
  async scanNow(roots) {
    memory.scanningSince = Date.now();
    try {
      const groups = new Map();
      for (const r of roots) groups.set(r.machine, [...(groups.get(r.machine) ?? []), r.path]);
      const results = await Promise.all([...groups].map(async ([on, paths]) => {
        try {
          // An offline machine would make the shell wait for its timeout.
          if (on && machines().find((m) => m.name === on)?.layout === "unavailable") throw new Error(`${on} cannot be reached now`);
          return { on, ...(await findRepos(paths, on)) };
        } catch (error) {
          return { on, error };
        }
      }));
      const prev = cache();
      const repos = [];
      const missing = [];
      const known = { ...prev.machines };
      const failed = [];
      for (const r of results) {
        if (r.error) {
          failed.push(r.on);
          repos.push(...prev.repos.filter((x) => (x.machine ?? null) === r.on));
          notify({ title: r.on ? `Could not read the folders on ${r.on}` : "Could not read the folders", body: String(r.error?.message ?? r.error), level: "error", timeout: 8000 });
          continue;
        }
        repos.push(...r.repos);
        missing.push(...r.missing.map((m) => placeId(r.on, m)));
        if (r.on) known[r.on] = { home: r.home };
      }
      setCache({ repos, scannedAt: Date.now(), missing, machines: known });
      if (missing.length) {
        notify({ title: "Some folders were not found", body: missing.map(placeLabel).join(", "), level: "warning", timeout: 6000 });
      }
      return { count: repos.length, failed };
    } finally {
      memory.scanningSince = 0;
    }
  }

  scan(cx, { quiet = true } = {}) {
    if (isScanning()) return;
    const roots = allRoots(remoteMachines());
    cx.spawn(async (cx) => {
      const { count, failed } = await this.scanNow(roots);
      if (!quiet && !failed.length) notify({ title: "Repositories updated", body: `${count} repositories in ${roots.length} folder${roots.length === 1 ? "" : "s"}`, level: "success", timeout: 3000 });
      cx.notify();
    });
    cx.notify();
  }

  rescan(cx) {
    memory.scanningSince = 0;
    this.scan(cx, { quiet: false });
  }

  addRoot(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Add folder" }).catch(() => null);
      if (!dir) return;
      const path = normalize(dir);
      const roots = settings().roots;
      if (!roots.some((r) => pathKey(r) === pathKey(path))) {
        updateSettings({ roots: [...roots, path] });
        this.rescan(cx);
      }
      cx.notify();
    });
  }

  /** The machine that a new remote folder goes to: the chosen one, else the first. */
  remoteMachine() {
    const list = remoteMachines();
    return list.includes(this.remoteTarget) ? this.remoteTarget : list[0] ?? null;
  }

  addRemoteRoot(cx) {
    const machine = this.remoteMachine();
    const raw = this.remotePath.value().trim();
    const path = raw === "/" ? raw : normalize(raw);
    if (!machine || !path) return;
    if (!validRoot(path)) {
      notify({ title: "Use a full path", body: "Start the folder with / or ~/", level: "warning", timeout: 4000 });
      return;
    }
    const list = settings().remoteRoots;
    if (!list.some((r) => r.machine === machine && pathKey(r.path) === pathKey(path))) {
      updateSettings({ remoteRoots: [...list, { machine, path }] });
      this.rescan(cx);
    }
    this.remotePath.set_value("");
    cx.notify();
  }

  /** `root`: an entry of allRoots(). */
  removeRoot(root, cx) {
    const same = (machine, path) => (machine ?? null) === root.machine && pathKey(path) === pathKey(root.path);
    updateSettings((s) => (root.machine
      ? { remoteRoots: s.remoteRoots.filter((r) => !same(r.machine, r.path)) }
      : { roots: s.roots.filter((r) => !same(null, r)) }));
    // The other folders keep their repositories: drop this folder's only.
    const c = cache();
    setCache({ ...c, repos: c.repos.filter((r) => !same(r.machine, r.root)), missing: c.missing.filter((m) => pathKey(m) !== pathKey(root.id)) });
    cx.notify();
  }

  /** The choices of the machine filter: none when all repositories are on this computer. */
  places() {
    const names = [...new Set(cache().repos.map((r) => r.machine).filter(Boolean))].sort();
    if (!names.length) return [];
    return [{ value: "all", label: "All" }, { value: "local", label: "This computer" }, ...names.map((m) => ({ value: m, label: m }))];
  }

  /** The machine filter now; "all" when its machine has no repositories any more. */
  place() {
    return this.places().some((p) => p.value === memory.place) ? memory.place : "all";
  }

  setPlace(value, cx) {
    memory.place = value;
    this.at = 0;
    this.scrollTop.list = 0;
    this.follow = true;
    cx.notify();
  }

  /** The rows of the list view: section titles and repositories. */
  rows() {
    const place = this.place();
    const repos = cache().repos
      .filter((r) => place === "all" || (place === "local" ? !r.machine : r.machine === place))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const q = this.filter.trim();
    const rows = [];
    const add = (title, items, symbol) => {
      if (!items.length) return;
      rows.push({ kind: "head", title, count: items.length, symbol });
      for (const r of items) rows.push({ kind: "repo", ...r });
    };

    if (q) {
      const hits = [];
      for (const repo of repos) {
        const parent = parentOf(repo);
        const match = matchRepo(q, repo.name, parent);
        if (!match) continue;
        hits.push({ repo, parent, match, score: match.score + (lastOpened(repoId(repo)) ? 10 : 0) });
      }
      hits.sort((a, b) => b.score - a.score || a.repo.name.localeCompare(b.repo.name));
      add("Results", hits, "search");
      return rows;
    }

    const entry = (repo) => ({ repo, parent: parentOf(repo), match: null });
    const recent = repos.filter((r) => lastOpened(repoId(r)) > 0)
      .sort((a, b) => lastOpened(repoId(b)) - lastOpened(repoId(a)))
      .slice(0, RECENT_COUNT);
    const recentKeys = new Set(recent.map((r) => pathKey(repoId(r))));
    const others = repos.filter((r) => !recentKeys.has(pathKey(repoId(r))));
    add("Recent", recent.map(entry), "refresh");
    // This computer's repositories, then one section for each other machine.
    const groups = new Map([[null, []]]);
    for (const r of others) groups.set(r.machine ?? null, [...(groups.get(r.machine ?? null) ?? []), r]);
    const remote = groups.size > 1;
    for (const [machine, items] of groups) {
      add(machine ? `On ${machine}` : remote ? "On this computer" : "Repositories", items.map(entry), "repo");
    }
    return rows;
  }

  selectable(rows = this.rows()) {
    return rows.filter((r) => r.kind === "repo");
  }

  selectedRepo() {
    const list = this.selectable();
    return list[Math.min(this.at, list.length - 1)]?.repo ?? null;
  }

  /** The installed agents of a machine (null: this computer). */
  agentsOn(machine) {
    return machine ? remoteAgentCache(machine).list ?? [] : this.agents;
  }

  /** Asks another machine for its agents once; Refresh agents asks again. */
  checkRemoteAgents(machine, cx, { force = false } = {}) {
    if (!machine || memory.checkingRemote[machine]) return;
    if (!force && remoteAgentCache(machine).list) return;
    memory.checkingRemote[machine] = true;
    cx.spawn(async (cx) => {
      try {
        setRemoteAgentCache(machine, (await knownAgents({ on: machine })).filter((a) => a.installed));
      } catch (e) {
        notify({ title: `Could not read the agents on ${machine}`, body: String(e?.message ?? e), level: "error" });
      } finally {
        memory.checkingRemote[machine] = false;
      }
      cx.notify();
    });
  }

  /** The choices: Terminal, then each installed agent of the repository's machine. */
  actions() {
    const out = [{ id: "terminal", title: "Terminal", subtitle: "A shell in the repository", argv: null, program: SHELL() }];
    for (const agent of this.agentsOn(this.repo?.machine ?? null)) {
      const argv = agent.run ?? [agent.key];
      out.push({ id: agent.key, title: agent.name, subtitle: argv.join(" "), argv, name: agent.name, program: agent });
    }
    return out;
  }

  /**
   * Asks Herdr for the installed agents and saves the list in shared state.
   * `loud`: also ask the machines with folders, and show a toast.
   */
  refreshAgents(cx, { loud = false } = {}) {
    if (loud) for (const m of new Set(settings().remoteRoots.map((r) => r.machine))) this.checkRemoteAgents(m, cx, { force: true });
    if (memory.checkingAgents) return;
    memory.checkingAgents = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const list = (await knownAgents()).filter((a) => a.installed);
        this.agents = list;
        setAgentCache(list);
        if (loud) notify({ title: "Agents updated", body: `${list.length} installed agent${list.length === 1 ? "" : "s"} found.`, level: "success" });
      } catch (e) {
        if (loud) notify({ title: "Could not read the agents", body: String(e?.message ?? e), level: "error" });
      } finally {
        memory.checkingAgents = false;
      }
      cx.notify();
    });
  }

  // ---------------------------------------------------------------------------
  // Actions

  /** The best open space of the chosen repository, or null. */
  openSpace() {
    const repo = this.repo;
    return repo ? spacesFor(repo.path, repo.machine ?? null)[0] ?? null : null;
  }

  /** Where the choice opens: the repository's open space (setting on), else a new space. */
  targetSpace() {
    return settings().reuse ? this.openSpace() : null;
  }

  setReuse(on, cx) {
    updateSettings({ reuse: on });
    cx.notify();
  }

  choose(repo, cx) {
    if (!repo) return;
    this.repo = repo;
    this.checkRemoteAgents(repo.machine, cx);
    this.view = "actions";
    this.actionAt = 0;
    this.scrollTop.actions = 0;
    this.follow = true;
    this.focusRoot(cx);
    cx.notify();
  }

  back(cx) {
    this.view = "list";
    this.focusQuery(cx);
    cx.notify();
  }

  openSettings(cx) {
    this.view = "settings";
    this.focusRoot(cx);
    cx.notify();
  }

  /** Starts `action` in the chosen repository and closes the popup. */
  launch(action, cx) {
    const repo = this.repo;
    if (!repo || !action || this.launching) return;
    this.launching = true;
    const before = new Set(panes().map((p) => p.terminal).filter(Boolean));
    try {
      open(repo.path, { argv: action.argv, name: action.name, machine: repo.machine ?? null, space: this.targetSpace() });
    } catch (e) {
      this.close();
      notify({ title: `Could not open ${repo.name}`, body: String(e?.message ?? e), level: "error" });
      return;
    }
    markOpened(repoId(repo));
    // Focus the new terminal, so every layout shows it (a layout can follow
    // the focused pane rather than the selected space). The popup stays open
    // for at most 2 s while the terminal starts.
    let tries = 0;
    const focusNew = (cx) => {
      const fresh = panes().find((p) => p.terminal && !before.has(p.terminal));
      if (fresh) run("pane.focus", { terminal: fresh.terminal });
      if (fresh || ++tries >= 20) return this.close();
      cx.timer.after(100, focusNew);
    };
    cx.spawn(async (cx) => focusNew(cx));
  }

  onKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    const mod = m.control || m.platform;

    if (this.view === "settings") {
      // A focused text field keeps Esc from Herdr: close the popup here.
      if (k === "escape") {
        cx.stop_propagation();
        this.close();
      }
      return;
    }

    if (this.view === "actions") {
      const actions = this.actions();
      if (k === "backspace" || k === "left") {
        cx.stop_propagation();
        return this.back(cx);
      }
      if (k === "down" || k === "up") {
        this.actionAt = (this.actionAt + (k === "down" ? 1 : actions.length - 1)) % actions.length;
        this.follow = true;
      } else if (k === "enter") {
        this.launch(actions[this.actionAt], cx);
      } else if (/^[1-9]$/.test(k) && !mod && !m.alt) {
        const a = actions[Number(k) - 1];
        if (a) this.launch(a, cx);
      } else if (k === "tab") {
        if (this.openSpace()) this.setReuse(!settings().reuse, cx);
      } else return;
      cx.stop_propagation();
      cx.notify();
      return;
    }

    // The list view.
    const list = this.selectable();
    if (k === "escape") return this.close();
    if (k === "down" || k === "up") {
      if (!list.length) return;
      this.at = (this.at + (k === "down" ? 1 : list.length - 1)) % list.length;
      this.follow = true;
    } else if (k === "pagedown" || k === "pageup") {
      if (!list.length) return;
      this.at = Math.max(0, Math.min(list.length - 1, this.at + (k === "pagedown" ? 8 : -8)));
      this.follow = true;
    } else if (mod && k === "r") {
      this.rescan(cx);
    } else if (mod && k === "m") {
      const places = this.places();
      if (!places.length) return;
      const i = places.findIndex((p) => p.value === this.place());
      cx.stop_propagation();
      return this.setPlace(places[(i + 1) % places.length].value, cx);
    } else if (mod && k === "enter") {
      // A shell at once, without the choices view.
      const repo = this.selectedRepo();
      if (repo) {
        this.repo = repo;
        this.launch(this.actions()[0], cx);
      }
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---------------------------------------------------------------------------
  // Drawing

  render() {
    if (kitOff()) return offView();
    const t = theme();
    const body = this.view === "actions" ? this.renderActions(t)
      : this.view === "settings" ? this.renderSettings(t)
      : this.renderList(t);
    return v_flex().id("repo-launcher").size_full().min_h(0).bg(t.popover).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(body);
  }

  header(t, title, subtitle, { leading, trailing = [] }) {
    return h_flex().h(60).flex_none().px(16).gap(12).items_center().border_b(1).border_color(t.border)
      .child(leading)
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(15).font_semibold().truncate().child(title))
        .when(Boolean(subtitle), (e) => e.child(div().text_size(11.5).text_color(t.dim).truncate().child(subtitle))))
      .children(trailing)
      .when(Boolean(props()?.overlay), (e) => e.child(iconButton(t, "rl-close", "close", () => this.close(), { tooltip: "Close", size: 26 })));
  }

  brandTile(t) {
    return h_flex().size(34).flex_none().rounded(10).items_center().justify_center().bg(t.accent)
      .child(svg(icon("repo")).size(18).text_color(t.accent_foreground ?? "#ffffff"));
  }

  footer(t) {
    return h_flex().h(38).flex_none().px(16).gap(14).items_center().border_t(1).border_color(t.border).bg(t.chrome ?? t.popover);
  }

  // --- list ------------------------------------------------------------------

  renderList(t) {
    const c = cache();
    const scanning = isScanning();
    const rows = this.rows();
    const list = this.selectable(rows);
    if (this.at >= list.length) this.at = Math.max(0, list.length - 1);
    const sel = list[this.at]?.repo ?? null;
    const places = this.places();

    const roots = allRoots();
    const subtitle = roots.length === 0
      ? "Add a folder to start"
      : `${c.repos.length} repositories in ${roots.length} folder${roots.length === 1 ? "" : "s"}`;

    const head = this.header(t, "Open a repository", subtitle, {
      leading: this.brandTile(t),
      trailing: [
        iconButton(t, "rl-refresh", "refresh", (cx) => this.rescan(cx), { tooltip: `Search the folders again (${ctrl("R")})`, spin: scanning }),
        iconButton(t, "rl-settings", "settings", (cx) => this.openSettings(cx), { tooltip: "Settings" }),
      ],
    });

    const search = h_flex().mx(16).mt(14).mb(8).h(42).flex_none().px(14).gap(10).items_center().rounded(11)
      .bg(t.background).border_1().border_color(tint(t.accent, "99"))
      .child(svg(icon("search")).size(16).text_color(t.accent))
      .child(Input.new(this.query).flex_1().h_full().text_size(14).text_color(t.foreground))
      .when(Boolean(this.filter), (e) => e.child(div().text_size(11).text_color(t.dim).child(`${list.length} match${list.length === 1 ? "" : "es"}`)))
      .when(places.length > 0, (e) => e.child(div().flex_none().tooltip(`Show the repositories of one machine (${ctrl("M")})`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(segmented(t, "rl-place", places, this.place(), (v, cx) => this.setPlace(v, cx)))));

    let content;
    if (roots.length === 0) {
      content = this.emptyState(t, "folder-plus", "Add the folders that hold your repositories",
        "The launcher searches them once and keeps the list. Refresh searches again.",
        h_flex().gap(8)
          .child(button(t, "rl-add-first", "Add folder…", (cx) => this.addRoot(cx), { primary: true, symbol: "plus" }))
          .when(remoteMachines().length > 0, (e) => e.child(button(t, "rl-add-remote-first", "Folder on another machine…", (cx) => this.openSettings(cx), { symbol: "folder-plus" }))));
    } else if (c.repos.length === 0 && scanning) {
      content = this.emptyState(t, null, "Looking for repositories…", roots.map((r) => placeLabel(r.id)).join("  ·  "));
    } else if (c.repos.length === 0) {
      content = this.emptyState(t, "repo", "No repositories found",
        `The search opens ${DEPTH} folder levels under each root folder.`,
        button(t, "rl-rescan", "Refresh", (cx) => this.rescan(cx), { symbol: "refresh" }));
    } else if (list.length === 0) {
      content = this.emptyState(t, "search", `No repository matches “${this.filter.trim()}”`, "Try fewer letters, or Refresh if the repository is new.");
    } else {
      const sizes = rows.map((r) => (r.kind === "head" ? HEAD_H : ROW_H));
      const selRow = rows.findIndex((r) => r.kind !== "head" && r.repo === sel);
      // Show the section title above the first row of a section too.
      const focusRow = selRow > 0 && rows[selRow - 1].kind === "head" ? [selRow - 1, selRow] : [selRow, selRow];
      content = this.scrollList(t, "list", rows, sizes, LIST_MAX, focusRow, (r) => (r.kind === "head"
        ? sectionTitle(t, r.title, { symbol: r.symbol, count: r.count })
        : this.repoRow(t, r, r.repo === sel)));
    }

    const footer = this.footer(t)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "choose"))
      .child(hint(t, [ctrl("↵")], "terminal"))
      .when(places.length > 0, (e) => e.child(hint(t, [ctrl("M")], "machine")))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(scanning ? "Scanning…" : c.scannedAt ? `Scanned ${ago(c.scannedAt)}` : ""));

    return v_flex().size_full().min_h(0).child(head).child(search).child(content).child(footer);
  }

  /**
   * A list that draws only the rows in view. Rows sit at fixed offsets in
   * one strip; the wheel moves the strip, and while `follow` is on the
   * strip moves just enough to show the rows `focus` names ([first, last]).
   */
  scrollList(t, id, items, heights, maxHeight, focus, draw) {
    const tops = [];
    let y = 0;
    for (const h of heights) {
      tops.push(y);
      y += h;
    }
    const total = y;
    const height = Math.min(maxHeight, total);
    const max = Math.max(0, total - height);
    let top = this.scrollTop[id] ?? 0;
    const [first, last] = focus;
    if (this.follow && first >= 0 && last >= 0) {
      if (tops[first] < top) top = tops[first];
      if (tops[last] + heights[last] > top + height) top = tops[last] + heights[last] - height;
    }
    top = Math.max(0, Math.min(top, max));
    this.scrollTop[id] = top;

    const rows = [];
    items.forEach((item, i) => {
      if (tops[i] + heights[i] <= top || tops[i] >= top + height) return;
      rows.push(div().absolute().left(0).right(0).top(tops[i] - top).h(heights[i]).child(draw(item, i)));
    });
    const thumb = total > height ? Math.max(24, (height * height) / total) : 0;
    return div().id(`rl-scroll-${id}`).relative().w_full().h(height).flex_none().overflow_hidden()
      .on_scroll_wheel((e, cx) => {
        this.follow = false;
        this.scrollTop[id] = Math.max(0, Math.min((this.scrollTop[id] ?? 0) - e.delta.y, max));
        cx.notify();
      })
      .children(rows)
      .when(thumb > 0, (el) => el.child(div().absolute().right(3).w(4).rounded(2).bg(tint(t.foreground, "33"))
        .top(max ? ((height - thumb) * top) / max : 0).h(thumb)));
  }

  emptyState(t, symbol, title, detail, action = null) {
    return v_flex().h(EMPTY_H).w_full().flex_none().items_center().justify_center().gap(10).p(28)
      .child(h_flex().size(54).rounded(27).items_center().justify_center().bg(tint(t.accent, "1a"))
        .child(symbol
          ? svg(icon(symbol)).size(24).text_color(t.accent)
          : svg(icon("spinner")).size(24).text_color(t.accent).spin(900)))
      .child(div().mt(4).text_size(14).font_semibold().child(title))
      .when(Boolean(detail), (e) => e.child(div().max_w(460).text_size(12).text_color(t.dim).child(detail)))
      .when(Boolean(action), (e) => e.child(div().mt(8).child(action)));
  }

  /** The pill of a repository's open space: its name, and its agents' status. */
  spaceBadge(t, open) {
    if (!open.length) return null;
    const space = open[0];
    const color = spaceColor(t, space) ?? t.accent;
    const label = `${space.name}${open.length > 1 ? ` +${open.length - 1}` : ""}`;
    if (space.status === "working") return pill(t, label, { color: t.working, symbol: "spinner", spin: true, max: 130 });
    if (space.status === "blocked") return pill(t, label, { color: t.blocked, dot: t.blocked, max: 130 });
    if (space.status === "done") return pill(t, label, { color: t.done, dot: t.done, max: 130 });
    return pill(t, label, { color, dot: color, max: 130 });
  }

  repoRow(t, r, selected) {
    const { repo, parent, match } = r;
    const open = spacesFor(repo.path, repo.machine ?? null);
    const badge = this.spaceBadge(t, open);
    const branch = open[0]?.branch;
    return h_flex().id(`rl-row-${repoId(repo)}`).h(ROW_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => {
          this.at = Math.max(0, this.selectable().findIndex((x) => x.repo === repo));
          this.choose(repo, cx);
        })
        .child(letterTile(repo.name, open.length ? spaceColor(t, open[0]) : repoColor(repo.name), 32))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(6).items_center()
            .child(highlighted(repo.name, match?.name, { color: t.foreground, hit: t.accent, size: 13.5, bold: true }))
            .when(Boolean(branch), (e) => e.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(t.dim)
              .child(svg(icon("branch")).size(11))
              .child(div().max_w(140).truncate().child(branch)))))
          .child(highlighted(parent, match?.path, { color: t.dim, hit: t.accent, size: 11 })))
        .when(Boolean(repo.machine), (e) => e.child(pill(t, repo.machine, { max: 110 })))
        .when(Boolean(badge), (e) => e.child(badge))
        .when(selected, (e) => e.child(kbd(t, "↵"))));
  }

  // --- actions ---------------------------------------------------------------

  renderActions(t) {
    const repo = this.repo;
    const actions = this.actions();
    if (this.actionAt >= actions.length) this.actionAt = 0;
    const openSpace = this.openSpace();
    const target = this.targetSpace();
    const color = openSpace ? spaceColor(t, openSpace) ?? t.accent : repoColor(repo.name);

    const head = this.header(t, repo.name, repo.machine ? placeLabel(repoId(repo)) : displayPath(repo.path), {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "rl-back", "back", (cx) => this.back(cx), { tooltip: "Back (⌫)" }))
        .child(letterTile(repo.name, color, 34)),
    });

    // Where the choice opens.
    const where = target
      ? ["Opens in a new tab of the space ", target.name, "."]
      : ["Opens in a new space", repo.machine ? ` on ${repo.machine}` : "", "."];
    const banner = h_flex().mx(16).mt(14).p(12).gap(10).flex_none().items_center().rounded(11)
      .bg(target ? tint(color, "14") : t.raised)
      .border_1().border_color(target ? tint(color, "40") : t.border)
      .child(svg(icon("layers")).size(16).text_color(target ? color : t.muted))
      .child(h_flex().flex_1().min_w(0).text_size(12.5).text_color(t.muted)
        .child(div().flex_none().child(where[0]))
        .child(div().flex_none().font_semibold().text_color(t.foreground).child(where[1]))
        .child(div().truncate().child(where[2])))
      .when(Boolean(openSpace), (e) => e.child(segmented(t, "rl-where", [
        { value: "space", label: "Its space", symbol: "repo" },
        { value: "new", label: "New space", symbol: "plus" },
      ], target ? "space" : "new", (v, cx) => this.setReuse(v === "space", cx))));

    const listEl = div().mt(10).mb(8).w_full().flex_none()
      .child(this.scrollList(t, "actions", actions, actions.map(() => ACTION_H), LIST_MAX, [this.actionAt, this.actionAt], (a, i) => this.actionRow(t, a, i)))
      .when(Boolean(repo.machine && memory.checkingRemote[repo.machine]), (e) => e.child(h_flex().h(30).px(18).gap(8).items_center()
        .text_size(11.5).text_color(t.dim)
        .child(svg(icon("spinner")).size(12).text_color(t.accent).spin(900))
        .child(div().child(`Looking for the agents on ${repo.machine}…`))));

    const footer = this.footer(t)
      .child(hint(t, ["↑", "↓"], "move"))
      .child(hint(t, ["↵"], "open"))
      .child(hint(t, ["1–9"], "pick"))
      .when(Boolean(openSpace), (e) => e.child(hint(t, ["Tab"], "space")))
      .child(div().flex_1())
      .child(hint(t, ["⌫"], "back"))
      .child(hint(t, ["Esc"], "close"));

    return v_flex().size_full().min_h(0).child(head).child(banner).child(listEl).child(footer);
  }

  actionRow(t, a, index) {
    const selected = index === this.actionAt;
    return h_flex().id(`rl-act-${a.id}`).h(ACTION_H).px(8).flex_none()
      .child(h_flex().size_full().px(10).gap(12).items_center().rounded(10).cursor_pointer()
        .border_1().border_color(selected ? tint(t.accent, "80") : "#00000000")
        .bg(selected ? tint(t.accent, "1c") : "#00000000")
        .when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.launch(a, cx))
        .child(programTile(t, a.program, 34))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(13.5).font_semibold().child(a.title))
          .child(div().text_size(11).text_color(t.dim).truncate().child(a.subtitle)))
        .child(index < 9 ? kbd(t, String(index + 1)) : div()));
  }

  // --- settings ----------------------------------------------------------------

  card(t, title, detail, body) {
    return v_flex().gap(10).p(14).flex_none().rounded(12).bg(t.background).border_1().border_color(t.border)
      .child(v_flex().gap(2)
        .child(div().text_size(13).font_semibold().child(title))
        .when(Boolean(detail), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(detail))))
      .child(body);
  }

  renderSettings(t) {
    const c = cache();
    const scanning = isScanning();

    const head = this.header(t, "Settings", "Repo Launcher", {
      leading: h_flex().gap(8).items_center()
        .child(iconButton(t, "rl-back", "back", (cx) => this.back(cx), { tooltip: "Back" }))
        .child(this.brandTile(t)),
    });

    // Root folders.
    const counts = {};
    for (const r of c.repos) {
      const k = pathKey(placeId(r.machine, r.root));
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const known = remoteMachines();
    const target = this.remoteMachine();
    const remoteAdd = known.length === 0 ? null : h_flex().gap(8).items_center()
      .child(known.length > 1
        ? segmented(t, "rl-remote-machine", known.map((m) => ({ value: m, label: m })), target, (v, cx) => { this.remoteTarget = v; cx.notify(); })
        : pill(t, target, { max: 140 }))
      .child(h_flex().flex_1().h(30).px(10).items_center().rounded(8).bg(t.raised).border_1().border_color(t.border)
        .child(Input.new(this.remotePath).flex_1().h_full().text_size(12)))
      .child(button(t, "rl-add-remote", "Add", (cx) => this.addRemoteRoot(cx), { symbol: "plus" }));
    const roots = v_flex().gap(6)
      .children(allRoots().map((root, i) => {
        const missing = c.missing.some((m) => pathKey(m) === pathKey(root.id));
        const offline = root.machine && !known.includes(root.machine);
        return h_flex().id(`rl-root-${i}`).h(40).px(10).gap(10).items_center().rounded(9).bg(t.raised)
          .child(svg(icon("folder")).size(16).text_color(missing || offline ? t.blocked : t.accent))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(displayPath(root.path, homeOf(root.machine))))
          .when(Boolean(root.machine), (e) => e.child(pill(t, root.machine, { max: 110 })))
          .child(offline ? pill(t, "unknown machine", { color: t.blocked })
            : missing ? pill(t, "not found", { color: t.blocked })
            : pill(t, `${counts[pathKey(root.id)] ?? 0} repos`))
          .child(iconButton(t, `rl-root-del-${i}`, "trash", (cx) => this.removeRoot(root, cx), { tooltip: "Remove this folder", size: 28 }));
      }))
      .when(Boolean(remoteAdd), (e) => e.child(div().pt(4).text_size(11.5).text_color(t.dim).child("A folder on another machine (type its path, / or ~/):")).child(remoteAdd))
      .child(h_flex().gap(8).pt(2)
        .child(button(t, "rl-add-root", "Add folder…", (cx) => this.addRoot(cx), { primary: true, symbol: "folder-plus" }))
        .child(button(t, "rl-refresh-all", scanning ? "Scanning…" : "Refresh", (cx) => this.rescan(cx), { symbol: "refresh" }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(c.scannedAt ? `Scanned ${ago(c.scannedAt)}` : "")));

    // Agents.
    const agents = v_flex().gap(8)
      .children(this.agents.map((agent) => h_flex().gap(10).items_center()
        .child(programTile(t, agent, 26))
        .child(div().w(140).flex_none().truncate().text_size(12.5).child(agent.name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child((agent.run ?? [agent.key]).join(" ")))))
      .when(this.agents.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim)
        .child(memory.checkingAgents ? "Looking for installed agents…" : "No installed agents found.")))
      .child(h_flex().gap(8).pt(2).items_center()
        .child(button(t, "rl-refresh-agents", memory.checkingAgents ? "Checking…" : "Refresh agents",
          (cx) => this.refreshAgents(cx, { loud: true }), { symbol: "refresh" }))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim)
          .child(agentCache().checkedAt ? `Checked ${ago(agentCache().checkedAt)}` : "")));

    const body = v_flex().id("rl-settings").h(SETTINGS_H).w_full().flex_none().overflow_y_scrollbar().p(16).gap(12)
      .child(this.card(t, "Repository folders", `The launcher looks for Git repositories down to ${DEPTH} folder levels under each folder. It searches again only when you add or remove a folder, or click Refresh. A repository on another machine opens in a space on that machine.`, roots))
      .child(this.card(t, "Agents", "The installed agents (Herdr's knownAgents()). Click Refresh agents after you install or remove one.", agents));

    return v_flex().size_full().min_h(0).child(head).child(body)
      .child(this.footer(t)
        .child(div().text_size(11).text_color(t.dim).child("Changes are saved at once."))
        .child(div().flex_1())
        .child(hint(t, ["Esc"], "close")));
  }
}
