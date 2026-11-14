# Agents by space

A Herdr app mod (`agents-by-space`) for the sidebar's Agents block: one glanceable list of which
agents need you, what they asked, and a way to act. It is built on Herdr's shipped `agents` mod.

- **A "Needs you" inbox on top.** Every agent that finished or is blocked, from every machine, as a
  card: `space · label`, a machine tag for an agent on another machine (`vps`), how long it has
  waited (`done 3m`, `waiting 3m`), and its last paragraph (3 lines at most). **Open** goes there,
  **Peek** looks without switching, **✓** dismisses the card, and **Reply** types an answer and
  presses Enter. The header says `N need you` while the inbox has cards, otherwise
  `N agents · M working`.
- **The inbox is sticky.** Herdr turns "done" into "idle" as soon as anyone looks at an agent, Peek
  included, so the mod keeps its own list (shared key `agents-by-space.inbox`: every copy of the mod
  and every restart see the same cards). An agent enters when it turns done or blocked, and leaves
  only when you click **Open** (or its row), a Reply is actually sent, the agent goes back to work,
  you click **✓**, or its terminal is gone. Peeking or hovering keeps it there.
- **Reply never types into a menu.** Reply shows only when the agent is not working or blocked and
  no choice menu is on screen (a permission prompt, a question with options: a `❯ 1.` line, numbered
  options with no input box below them, or "Enter to select" / "Esc to cancel"). A plain question
  keeps Reply. A screen not read yet counts as a menu. The screen is read again right before
  sending; if a menu came up or the agent moved on, nothing is sent, your text stays in the box and
  the card says why ("Not sent: a menu is on screen — Open it."). Esc or **Cancel** closes the box.
- **One compact row per agent, by machine.** `THIS COMPUTER` first, then each other machine, as
  section dividers (with `· N need you`). Under a divider every agent is one row:
  `space  label  age  status`, the space name in a fixed column so the rows scan as a table.
  Agents of one space sit together, spaces with the most urgent agents first. An agent that also
  has an inbox card shows `↑ needs you` / `↑ done` instead of its age. Sub-agents (terminals an agent
  started with `hc run`, such as an hc-team lead's workers) show under their parent.
- **hc-team leads.** A lead's row (labels `role=lead`, `task=<slug>`) gets a tag
  `team · N workers · B boxes` from `hc-team ls` on that machine (box workers are two hops away, so
  only that machine sees them), `team · loading` until it answers, and `team · lead needs you` in
  the blocked color when the lead is blocked.
- **Start an agent.** The `+` on a machine divider opens a small menu of that machine's spaces with
  `+ Claude` / `+ Codex` (the ones installed there): a new tab in that space.
- **Row actions.** Hover a row for Peek, Pin and Stop. Stop asks again (`Stop?`, "End <agent> on
  <machine>"); the second click counts only after half a second, and Stop disarms when the pointer
  leaves or after 4 s. Inbox cards have no Stop.
- **Narrow rail.** When the sidebar is a narrow rail: numbers and status in the same order as the
  wide list (inbox first), with `space · label · machine` as each row's tooltip.

- **Sort.** The `Activity ⇅` / `A–Z ⇅` button in the Agents header switches the order under each
  machine: by activity (agents that need you, then working, then most recently changed) or by space
  and agent name. The choice is kept in `shared("agents-by-space.sort")`. The inbox keeps its own order.

## What it runs

- `hc read <terminal> --lines 0`: the visible screen of the inbox's agents (every 15 s) and of the
  row under the pointer. `--lines 0` reads only the screen, so it never scrolls the agent's view.
  The menu check works on this raw text; the preview is the last paragraph above the input box,
  without status lines (`✻ Churned for 2s`, `Ran 2 shell commands`, …), a `※ recap:` when it is the
  latest thing on screen (`screen.js`).
- `hc send <terminal> <text>`: only when you press Enter in a Reply box.
- `sh -lc 'PATH="$HOME/.local/bin:$PATH"; command -v hc-team >/dev/null && hc-team ls'` on a machine
  that shows an hc-team lead, at most once a minute.
- `knownAgents()` once per machine, for the `+` menu.
- The app's own commands: `pane.focus`, `terminal.peek`, `terminal.pin`, `terminal.kill`, `tab.new`.

No network requests, no files read or written. "Last changed" times stay in the mod's `localStorage`;
the inbox list is in the app's shared state.

## Install

```sh
cp agents-by-space-app/mods/agents-by-space/mod.json -t ~/.config/herdr-app/mods/agents-by-space/ 2>/dev/null \
  || { mkdir -p ~/.config/herdr-app/mods/agents-by-space && cp agents-by-space-app/mods/agents-by-space/mod.json ~/.config/herdr-app/mods/agents-by-space/; }
cp agents-by-space-app/mods/agents-by-space/{main.js,screen.js,kit.json} ~/.config/herdr-app/mods/agents-by-space/
herdr-app check ~/.config/herdr-app/mods/agents-by-space
```

Copy `mod.json` first: without it Herdr docks a stray copy into your layout. Then, in a clone of the
main layout (`herdr-app do layout.clone '{"name":"main","as":"my-main"}'`), change the block whose
`content.mod` is `agents` to `agents-by-space`, and give it `"size": { "weight": 2 }` so it gets
twice the height of the Spaces block.

Credit: the row, status and sub-agent code comes from Herdr's shipped `agents` mod.
