# Agents by space

A Herdr app mod (`agents-by-space`) for the sidebar's Agents block. It is built on Herdr's shipped
`agents` mod and adds three things:

- **Grouped by machine and space.** This computer first, then each machine of `hc machine ls`, then
  each space as a plain label with its agents under it. Agents that need you go to the top of their
  space, and spaces with the most urgent agents come first. Sub-agents
  (terminals an agent started with `hc run`, such as an hc-team lead's workers) show under their parent.
- **A "Needs you" inbox on top.** Every blocked or done agent, from every machine, as a card with the
  last lines on its screen, so you can read the question without switching. **Open** goes there,
  **Peek** looks without switching, and on a done agent **Reply** types an answer and presses Enter.
  Reply shows only on a done agent with no choice menu on screen (a permission prompt, a question
  with options), and the screen is read again right before sending: Enter could otherwise pick the
  menu's selected option. Answer menus in the agent's own pane (Open).
- **hc-team spaces.** A space with an hc-team lead (labels `role=lead`, `task=<slug>`) shows
  `hc-team · lead <status> · N workers · B boxes` under its name, from `hc-team ls` on that machine
  (box workers are two hops away, so only that machine sees them).
- **Start an agent in a space.** Hover a space's name for `+ Claude` and `+ Codex` (when installed
  on that machine): a new tab in that space.
- **Useful rows.** How long since the agent last changed (`idle 40m`), its last lines on hover, and
  Peek, Pin and Stop (Stop asks for a second click).

## What it runs

- `hc read <terminal> --lines 0`: the visible screen of blocked and done agents (every 15 s) and of
  the row under the pointer. `--lines 0` reads only the screen, so it never scrolls the agent's view.
- `hc send <terminal> <text>`: only when you press Enter in a Reply box.
- `sh -lc "command -v hc-team >/dev/null && hc-team ls"` on a machine that shows an hc-team lead, at most once a minute.
- `knownAgents()` once per machine, for the `+` buttons.
- The app's own commands: `pane.focus`, `terminal.peek`, `terminal.pin`, `terminal.kill`, `tab.new`.

No network requests, no files read or written. "Last changed" times stay in the mod's `localStorage`.

## Install

```sh
cp agents-by-space-app/mods/agents-by-space/mod.json -t ~/.config/herdr-app/mods/agents-by-space/ 2>/dev/null \
  || { mkdir -p ~/.config/herdr-app/mods/agents-by-space && cp agents-by-space-app/mods/agents-by-space/mod.json ~/.config/herdr-app/mods/agents-by-space/; }
cp agents-by-space-app/mods/agents-by-space/{main.js,kit.json} ~/.config/herdr-app/mods/agents-by-space/
herdr-app check ~/.config/herdr-app/mods/agents-by-space
```

Copy `mod.json` first: without it Herdr docks a stray copy into your layout. Then, in a clone of the
main layout (`herdr-app do layout.clone '{"name":"main","as":"my-main"}'`), change the block whose
`content.mod` is `agents` to `agents-by-space`.

Credit: the row, status and sub-agent code comes from Herdr's shipped `agents` mod.
