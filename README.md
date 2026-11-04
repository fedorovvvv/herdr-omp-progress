# herdr-omp-agents

Shows what [omp](https://github.com/can1357/oh-my-pi) agents are doing in the
[Herdr](https://herdr.dev) desktop app's **Agents** panel and in omp's own status line:

- **Subagent count**: how many omp subagents are working, per nesting level (`⑂ 2 › 1`).
- **Todo progress**: a progress bar, `done/total`, and the task in hand, under the agent's name.
- **omp status line**: `☑ 4/11 Current task` in the `status` segment.

## Parts

| Path | What it does |
| --- | --- |
| `omp/extensions/herdr-subagent-count.ts` | Publishes working subagents on the herdr terminal as the label `agents.subs` (`"2,1"`). |
| `omp/extensions/herdr-todo-progress.ts` | Publishes the main session's todo list as `agents.todo` (`"4/11"`) and `agents.todoNow`, and sets the omp status `todo`. |
| `herdr/mods/agents-stacked/` | Agents panel (a fork of Herdr's built-in `agents` mod 0.1.12) that draws those labels. |

The extensions talk to Herdr only through `hc label`, so they do nothing outside Herdr
(except the status line, which works anywhere).

## Install

```sh
git clone https://github.com/fedorovvvv/herdr-omp-agents.git
cd herdr-omp-agents
./install.sh            # symlinks; `git pull` updates in place
./install.sh --copy     # copies instead
./install.sh --uninstall
```

Existing files of the same name are backed up as `*.bak`. Paths can be overridden with
`OMP_EXTENSIONS_DIR` and `HERDR_MODS_DIR`.

Then:

1. Restart running omp sessions so they load the extensions.
2. In Herdr, put the `agents-stacked` mod where the Agents panel goes (it ships with
   `"place": "none"`), or point your layout at it.
3. For the status line with `statusLine.preset: custom`, keep `status` in
   `leftSegments` or `rightSegments`.

## Try it without an agent

```sh
hc label t12 'agents.todo=4/11' 'agents.todoNow=Some task' 'agents.subs=2,1'
hc label t12 'agents.todo=' 'agents.todoNow=' 'agents.subs='
```

## License

MIT
