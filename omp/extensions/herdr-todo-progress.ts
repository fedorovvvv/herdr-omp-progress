// Shows the main omp session's todo progress in two places:
// - the omp status line (`status` segment, key "todo"): "☑ 4/11 Current task";
// - the herdr terminal, as labels drawn by the herdr app's agents-stacked mod:
//     agents.todo     "done/total" (completed and abandoned count as done)
//     agents.todoNow  the task in progress, or the next pending one
// Both go away when there is no todo list.
// @ts-nocheck

import { execFile } from "node:child_process";

const terminal = process.env.HC_TERMINAL_ID;
const TODO = "agents.todo";
const NOW = "agents.todoNow";
const MAX_NOW = 120;
const MAX_STATUS_NOW = 40;

let published = "";
let timer;

function summarize(phases) {
  const tasks = (Array.isArray(phases) ? phases : []).flatMap((p) => (Array.isArray(p?.tasks) ? p.tasks : []));
  if (!tasks.length) return { todo: "", now: "" };
  const done = tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
  const current = tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending");
  const now = done === tasks.length ? "" : String(current?.content ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOW);
  return { todo: `${done}/${tasks.length}`, now };
}

function publish(phases, ctx) {
  const { todo, now } = summarize(phases);
  const short = now.length > MAX_STATUS_NOW ? `${now.slice(0, MAX_STATUS_NOW - 1)}…` : now;
  try {
    ctx?.ui?.setStatus?.("todo", todo ? `☑ ${todo}${short ? ` ${short}` : ""}` : undefined);
  } catch {}
  if (!terminal) return;
  const value = `${todo}\u0000${now}`;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    if (value === published) return;
    published = value;
    execFile("hc", ["label", terminal, `${TODO}=${todo}`, `${NOW}=${now}`], { timeout: 5000 }, () => {});
  }, 150);
  timer.unref?.();
}

// The latest todo snapshot on the branch: a successful `todo` result or a /todo edit.
function phasesFromBranch(ctx) {
  let branch;
  try {
    branch = ctx?.sessionManager?.getBranch?.() ?? [];
  } catch {
    return [];
  }
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    const m = e?.message;
    if (e?.type === "message" && m?.role === "toolResult" && m.toolName === "todo" && !m.isError && Array.isArray(m.details?.phases)) {
      return m.details.phases;
    }
    if (e?.type === "custom" && e.customType === "user_todo_edit" && Array.isArray(e.data?.phases)) return e.data.phases;
    if (e?.type === "user_todo_edit" && Array.isArray(e.phases)) return e.phases;
  }
  return [];
}

const isMain = (ctx) => ctx?.agent?.kind !== "sub";

export default function (pi) {
  const restore = (_event, ctx) => {
    if (isMain(ctx)) publish(phasesFromBranch(ctx), ctx);
  };
  for (const name of ["session_start", "session_switch", "session_branch", "session_tree", "session_compact"]) pi.on(name, restore);

  pi.on("tool_result", (event, ctx) => {
    if (!isMain(ctx) || event?.toolName !== "todo" || event.isError) return;
    const phases = event.details?.phases;
    if (Array.isArray(phases)) publish(phases, ctx);
  });

  pi.on("todo_auto_clear", (_event, ctx) => {
    if (isMain(ctx)) publish([], ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isMain(ctx) || !terminal) return;
    clearTimeout(timer);
    published = "";
    execFile("hc", ["label", terminal, `${TODO}=`, `${NOW}=`], { timeout: 2000 }, () => {});
  });
}
