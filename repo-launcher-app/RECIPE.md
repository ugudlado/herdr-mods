# Repo Launcher (trimmed fork)

A popup for the Herdr app. A key (suggested `cmd-o`) opens it at the top of
the window. Type part of a repository name, the list filters with a fuzzy
match, and Enter shows what to start there: a terminal or an installed agent,
in a new tab of the repository's open space or in a new space.

Based on the Repo Launcher by Douglas Cunha (dougcunha/herdr-mods, MIT).

## What you see

A popup, 760 px wide, 56 px from the top, `popover` background, 13 px text.
Three views, each with a 60 px header, a body and a 38 px footer (`chrome`
fill, key caps with labels).

### List view

- Header: a 34 px `accent` tile with `repo.svg`, `Open a repository` and
  `N repositories in M folders`; a Refresh button (turns while a search runs)
  and a Settings button.
- Search box: 42 px, `accent` border at 60% alpha, `N matches` while a query
  is typed. When the cache has repositories of another machine, a segmented
  control: All / This computer / each machine (`Ctrl+M` cycles).
- List (at most 440 px, drawn as a window of rows, wheel scrolls it):
  - Without a query: **Recent** (5 last opened), then **Repositories**, or
    **On this computer** and **On <machine>** sections.
  - With a query: **Results**, best first.
  - Row (50 px): a 32 px letter tile (the open space's color, else a color
    from the name), the name with matched letters in `accent`, the branch of
    the open space, the parent folder (`~` for that machine's home), a machine
    pill, an open-space pill (spinner when an agent works, dot in `blocked`
    or `done`), `↵` on the selected row.
- Empty states: no root folder (**Add folder…**, and **Folder on another
  machine…** when machines exist), searching, nothing found (**Refresh**), no
  match.
- Footer: `↑ ↓ move`, `↵ choose`, `⌃↵ terminal`, `⌃M machine`; `Scanned …`.

### Choices view

- Header: back button, the repository's letter tile, name and path.
- Banner: `Opens in a new tab of the space <name>.` or
  `Opens in a new space (on <machine>).` When the repository has an open
  space, a segmented control **Its space** / **New space** (`Tab`), saved as
  `settings.reuse`.
- Choices (52 px rows): **Terminal** (`icons/shell.svg`), then each installed
  agent of the repository's machine from `knownAgents()` with its tile and its
  `run` command; key caps `1`–`9`. `Looking for the agents on <machine>…`
  while a remote check runs.

### Settings view

- **Repository folders**: one row per root (folder icon, path, machine pill,
  `N repos` / `not found` / `unknown machine`, trash). For other machines: a
  machine picker, a path field and **Add** (paths must start with `/` or
  `~/`). **Add folder…** (system picker, this computer), **Refresh**,
  `Scanned …`.
- **Agents**: the installed agents of this computer, **Refresh agents** (also
  asks the machines that have root folders), `Checked …`.

### Status bar item

`repo-launcher-status`: a 120 px block for the status row. A 20 px chip with
`repo.svg` and `<key>  repos`, where the key is the one `keys()` binds to
`mod.open:repo-launcher` (only `repos` without one). Click: `mod.open
{name: "repo-launcher"}`.

## How it behaves

- **Fuzzy match** (`fuzzy.js`): each query word must appear in order in the
  name or the parent folder; start-of-word and consecutive letters score
  higher; a name match counts double. Opened repositories add 10.
- **Search** (`scan.js`): one `exec` per machine, run in parallel:
  `exec("sh", ["-c", SH_SCAN, "sh", "4", ...roots], { on, timeout: 120000 })`.
  `SH_SCAN` is a constant. It prints `home<TAB>$HOME`, then `find` with
  `-maxdepth 4`, pruning `node_modules`, `.venv`, `venv`, `__pycache__`,
  `bin`, `obj`, `dist`, `build`, `target`, `packages`, `.idea`, `.vscode`,
  `.gradle`, `.next`, `.cache`, `vendor`, `Pods`, `DerivedData`; at most 2000
  repositories per root. A root that is not absolute (after `~` expansion) or
  not a folder prints `!missing`. The mod drops repositories inside others.
  An unavailable machine is skipped and keeps its old repositories.
- **Cache**: `shared("repo-launcher.cache")` = `{ repos: [{path, name, root,
  machine}], scannedAt, missing: [placeId], machines: {name: {home}} }`. A
  search runs on add/remove of a folder, Refresh, or opening with roots and
  no cache. Removing a folder drops only its repositories.
- **Settings**: `shared("repo-launcher.settings")` = `{ roots, remoteRoots:
  [{machine, path}], reuse, recent: {placeId: time} }` (50 recent at most).
- **Agents**: `shared("repo-launcher.agents")` = `{ list, checkedAt }` for
  this computer (asked once, or on Refresh agents);
  `shared("repo-launcher.agents.remote")` = `{ machine: {list, checkedAt} }`,
  asked when a repository of that machine is chosen. Other kit mods read
  `repo-launcher.agents` and `repo-launcher.cache`; their shapes are kept.
- **Open space** (`launch.js` `spacesFor`): a space of the repository's
  machine with a terminal pane whose live folder is in the repository. Best
  first: named like the repository, start folder in it, shown, most terminals.
- **Start** (`launch.js` `open`): new space: `space.new {folder, machine,
  argv?, tab?}`; open space: `space.select {id}` then `tab.new {space, folder,
  argv?, name?}`. `argv` is the agent's `run` (null for a shell). Then the
  popup focuses the new terminal with `pane.focus {terminal}` (waits at most
  2 s) and closes. The repository goes to Recent.

## Built from

- `mod.json`: `{ "place": "none", "title": "Repo Launcher", "overlay": { "kind": "popup", "at": "top", "offset": 56, "width": 760, "height": 0.78 } }`.
- `keys.json` (for people to merge): `{ "global": { "cmd-o": "mod.open:repo-launcher" } }`.
- `main.js` (views, keys), `fuzzy.js`, `scan.js`, `launch.js`, `store.js`,
  `ui.js` (tiles, pills, key caps, buttons, segmented control, highlighted
  text).
- `kit.json`: description, credit, and the `reuse` setting for the mods-hub.
- Icons: `back`, `branch`, `close`, `folder`, `folder-plus`, `layers`,
  `plus`, `refresh`, `repo`, `search`, `settings`, `spinner`, `terminal`,
  `trash`, and Herdr's `icons/shell.svg`.

## Watch out

- **A popup is as tall as its content**: lists have fixed heights.
- **`v_virtual_list` drew nothing in a popup**: the list draws its own window
  of rows.
- **Esc closes the popup before the mod sees it**: back is `Backspace`/`←`.
- **Focus after a view change**: focus again 40 ms later.
- **`spaces()[i].folder` is where a space was made**: use the terminals' live
  folders.
- **`space.select` does not show a space in every layout**: `pane.focus`
  does.
- **Limits**: 3 folder levels under a root, 2000 repositories per root,
  macOS/Linux machines only. Remote folders are typed, not picked.

## Done when

- `herdr-app check` passes for `mods/repo-launcher` and
  `mods/repo-launcher-status`.
- With no root folder, **Add folder…** opens the folder picker; after it, a
  toast `Repositories updated` and the list shows.
- A root on another machine (`~/code` on a VPS) lists its repositories in an
  `On <machine>` section.
- Typing `hm` shows `herdr-mods` with `h` and `m` highlighted.
- Enter shows Terminal plus the installed agents; `2` starts the first agent.
- With an open space, the choice opens as a new tab there; with **New space**
  (`Tab`), in a new space on the repository's machine.
- The opened repository shows under **Recent** next time.
