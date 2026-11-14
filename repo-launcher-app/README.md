# Repo Launcher for the Herdr app (trimmed fork)

A small Herdr app mod: press a key, fuzzy-find a Git repository, and start
Claude Code, Codex (or any other installed agent) or a plain terminal there.

This is a trimmed fork of the Repo Launcher by Douglas Cunha
([dougcunha/herdr-mods](https://github.com/dougcunha/herdr-mods), MIT, see
`../LICENSE`). The fork removed Windows support, multiple accounts, per-agent
arguments, favorites, split and "go to space" modes, and the in-app shortcut
editor, so the code is small enough to audit.

`preview.png` and `preview-src.png` are upstream screenshots: they show
features (favorites, the reuse switch) that this fork no longer has.

## What it does

- **Fuzzy search** of the repositories under your root folders. `hm` finds
  `herdr-mods`; the matched letters are highlighted.
- **This computer and other machines.** Root folders can be on this computer
  (added with the system folder picker) or on a machine from `hc machine ls`
  (typed, `/…` or `~/…`). Each machine gets its own section, and a filter
  (`Ctrl+M`) shows one machine.
- **Recent** repositories (the last 5 opened) at the top.
- **Cached list.** The folders are searched only when you add or remove one,
  or click Refresh (`Ctrl+R`).
- **Choices:** Terminal, then each installed agent from Herdr's
  `knownAgents()` (on the repository's machine).
- **Where:** a new tab in the repository's open space (a space whose
  terminal works in the repository), or a new space on the repository's
  machine. `Tab` switches; the choice is remembered.
- **Status bar item** (`repo-launcher-status`): `⌘O  repos`; a click opens
  the launcher.

## The key

The launcher has no shortcut editor. Bind it yourself in
`~/.config/herdr-app/keys.json` (see `keys.json` here):

```json
{ "global": { "cmd-o": "mod.open:repo-launcher" } }
```

`cmd-o` is suggested. Not `ctrl-p`: a bound Ctrl+letter key stops reaching the
programs in your terminals, and shells and Claude Code use `Ctrl+P` for the
previous command/history.

## Keys in the popup

| Keys | List | Choices |
|---|---|---|
| `↑` `↓`, `PgUp` `PgDn` | move | move |
| `Enter` | show the choices | start the choice |
| `1`–`9` | | start that choice |
| `Ctrl+Enter` | a terminal at once | |
| `Tab` | | its space / new space |
| `Ctrl+R` | search the folders again | |
| `Ctrl+M` | next machine filter | |
| `Backspace`, `←` | | back |
| `Esc` | close | close |

## Install

`Read ~/.config/herdr-app/AGENTS.md, then add this mod: <this folder>`: copy
`mods/repo-launcher` and `mods/repo-launcher-status` to
`~/.config/herdr-app/mods/`, merge `keys.json`, and put the status block
`{ "id": "repo-launcher-status", "type": "block", "content": { "mod": "repo-launcher-status" }, "size": { "px": 120 } }`
at the end of your layout's status row.

## What it runs and reads

- `exec("sh", ["-c", <fixed find script>, "sh", "4", ...rootFolders], { on, timeout: 120000 })`
  per machine (`on`: null for this computer). Root folders are arguments,
  never part of the script.
- `knownAgents()` and `knownAgents({ on: machine })`.
- `pickFolder()` for local root folders.
- No network, no file reads or writes, no credential files.
  State lives in `shared()`: `repo-launcher.settings`, `repo-launcher.cache`,
  `repo-launcher.agents`, `repo-launcher.agents.remote`.

See `RECIPE.md` for the details.
