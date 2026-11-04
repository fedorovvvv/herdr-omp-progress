// Shows how far the main omp session is through the subagents it started for the
// current prompt, for sessions that delegate work instead of keeping a todo list:
// - the omp status line (`status` segment, key "subagents"): "⑂ 2/5 40% Audit auth";
// - the herdr terminal, as labels drawn by the herdr app's agents-stacked mod:
//     agents.tasks     "done/total" over the subagents the main agent spawned itself
//                      (failed and aborted ones count as done)
//     agents.tasksPct  0-100: settled ones count whole, running ones by their own
//                      completion estimate (omp's task.completionProbe) or, without
//                      one, by how far their own subagents got
//     agents.tasksNow  the one the session is waiting on: its label and current step
//     agents.tasksFail how many of them failed or were aborted (absent at zero)
//
// A batch starts with the first subagent after a prompt and keeps growing while the
// session spawns more; a new prompt starts a fresh batch once nothing is running.
// The labels go away when a batch is empty.
//
// Lifecycle comes from the public extension events (every subagent session loads this
// extension too), labels, estimates, steps and outcomes from the `task:subagent:progress`
// and `task:subagent:lifecycle` frames on each session's event bus. Queued spawns and the
// current activity come from omp internals (the agent registry and the async job
// manager) when this omp build exposes them; without them the rest still works.
// @ts-nocheck

import { execFile } from "node:child_process";

const terminal = process.env.HC_TERMINAL_ID;
const KEYS = ["agents.tasks", "agents.tasksPct", "agents.tasksNow", "agents.tasksFail"];
const MAX_NOW = 120;
const MAX_STATUS_NOW = 40;
// An estimate drawn only from a running agent's own subagents never reaches 100%:
// the agent still has to report back.
const NESTED_CAP = 0.95;
const REFRESH_MS = 2000;

// One store per process: the main session and every subagent session get their own
// copy of this factory and write their lifecycle here; only the main session reads it.
const shared =
  globalThis.__herdrSubagentProgress ??
  (globalThis.__herdrSubagentProgress = {
    // Subagents of the current batch, by agent id.
    agents: new Map(),
    // Latest task progress frame per agent id: label, estimate, step.
    progress: new Map(),
    // Set by the main session: schedules a recompute.
    wake: undefined,
  });

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function entry(id) {
  let e = shared.agents.get(id);
  if (!e) shared.agents.set(id, (e = { id, parentId: undefined, state: "pending", startedAt: Date.now() }));
  return e;
}

// Fields of a task `AgentProgress` frame worth keeping.
function remember(p) {
  if (!p?.id) return;
  const prev = shared.progress.get(p.id) ?? {};
  shared.progress.set(p.id, {
    label: oneLine(p.description) || prev.label,
    percent: Number.isFinite(p.completionPercent) ? p.completionPercent : prev.percent,
    stage: oneLine(p.stage) || prev.stage,
    intent: oneLine(p.currentToolIntent || p.lastIntent) || prev.intent,
  });
}

// omp internals, loaded once; `undefined` when this build does not expose them. Dynamic on
// purpose: a static import of a missing internal module would fail the whole extension.
let internals;
async function loadInternals() {
  try {
    const { AgentRegistry } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
    if (typeof AgentRegistry?.global === "function") internals = { registry: AgentRegistry.global() };
  } catch {
    internals = undefined;
  }
}

// Pull in what only the internals know: queued spawns that have no session yet and each
// running agent's current activity.
function enrich(mainId) {
  const registry = internals?.registry;
  if (!registry) return new Map();
  const activity = new Map();
  let jobs = [];
  try {
    jobs = registry.get(mainId)?.session?.asyncJobManager?.getAllJobs?.() ?? [];
  } catch {}
  for (const job of jobs) {
    if (job?.type !== "task") continue;
    const id = job.agentId ?? job.id;
    const known = shared.agents.get(id);
    if (job.status === "running") {
      if (!known && !registry.get(id)) {
        // Spawned, still waiting for a concurrency slot.
        const e = entry(id);
        e.parentId = job.ownerId;
        e.state = "pending";
      }
      continue;
    }
    if (!known) continue;
    // A queued spawn that settled without ever starting (cancelled, failed preflight).
    if (known.state === "pending") known.state = "done";
    if (job.status === "failed" || job.status === "cancelled") known.failed = true;
  }
  for (const ref of registry.list?.() ?? []) {
    if (ref?.kind !== "sub") continue;
    const e = shared.agents.get(ref.id);
    if (!e) continue;
    if (e.parentId === undefined) e.parentId = ref.parentId;
    if (ref.status === "aborted") e.failed = true;
    if (ref.status === "running" && ref.activity) activity.set(ref.id, oneLine(ref.activity));
  }
  return activity;
}

function summarize(mainId) {
  const activity = enrich(mainId);
  const all = [...shared.agents.values()];
  const kids = new Map();
  for (const e of all) {
    const list = kids.get(e.parentId);
    if (list) list.push(e);
    else kids.set(e.parentId, [e]);
  }
  // Roots: started by the main agent, or by something outside this batch.
  const roots = all.filter((e) => e.parentId === mainId || !shared.agents.has(e.parentId));
  if (!roots.length) return null;

  const share = (e, seen = new Set()) => {
    if (e.state === "done") return 1;
    if (e.state === "pending" || seen.has(e.id)) return 0;
    seen.add(e.id);
    const own = shared.progress.get(e.id)?.percent;
    if (Number.isFinite(own)) return Math.min(1, Math.max(0, own / 100));
    const below = kids.get(e.id) ?? [];
    if (!below.length) return 0;
    return (NESTED_CAP * below.reduce((s, k) => s + share(k, seen), 0)) / below.length;
  };

  const shares = new Map(roots.map((e) => [e.id, share(e)]));
  const done = roots.filter((e) => e.state === "done").length;
  const failed = roots.filter((e) => e.failed).length;
  const pct = Math.round((100 * roots.reduce((s, e) => s + shares.get(e.id), 0)) / roots.length);

  // What the batch is waiting on: the running root furthest from done, oldest first.
  const waiting = roots
    .filter((e) => e.state === "running")
    .sort((a, b) => shares.get(a.id) - shares.get(b.id) || a.startedAt - b.startedAt)[0];
  let now = "";
  if (waiting) {
    const p = shared.progress.get(waiting.id) ?? {};
    const name = p.label || waiting.id;
    const step = p.stage || activity.get(waiting.id) || p.intent || "";
    now = step && step !== name ? `${name}: ${step}` : name;
  } else if (done < roots.length) {
    now = "queued";
  }
  return { done, total: roots.length, pct, failed, now: clip(oneLine(now), MAX_NOW) };
}

const isMain = (ctx) => ctx?.agent?.kind === "main";
const isSub = (ctx) => ctx?.agent?.kind === "sub" && ctx.agent.id !== "advisor";

export default async function (pi) {
  await loadInternals();

  // ---- every subagent session: report its own lifecycle ----
  pi.on("agent_start", (_event, ctx) => {
    if (!isSub(ctx)) return;
    const e = entry(ctx.agent.id);
    e.parentId = ctx.agent.parentId;
    e.state = "running";
    e.failed = false;
    shared.wake?.();
  });

  pi.on("agent_end", (event, ctx) => {
    if (!isSub(ctx) || event?.willContinue === true) return;
    const e = shared.agents.get(ctx.agent.id);
    if (!e) return;
    e.state = "done";
    shared.wake?.();
  });

  // Task subagents report on the event bus of the session that spawned them.
  pi.events?.on?.("task:subagent:progress", (frame) => remember(frame?.progress));
  pi.events?.on?.("task:subagent:lifecycle", (frame) => {
    const e = frame?.id && shared.agents.get(frame.id);
    if (!e) return;
    if (frame.description) remember({ id: frame.id, description: frame.description });
    e.state = "done";
    e.failed = frame.status === "failed" || frame.status === "aborted";
    shared.wake?.();
  });

  // ---- the main session: publish ----
  let mainId;
  let published;
  let timer;
  let interval;
  let ui;

  const publish = () => {
    const s = mainId ? summarize(mainId) : null;
    const status = s ? `⑂ ${s.done}/${s.total} ${s.pct}%${s.now ? ` ${clip(s.now, MAX_STATUS_NOW)}` : ""}` : undefined;
    try {
      ui?.setStatus?.("subagents", status);
    } catch {}
    if (!terminal) return;
    const values = s
      ? [`${s.done}/${s.total}`, String(s.pct), s.now, s.failed ? String(s.failed) : ""]
      : ["", "", "", ""];
    const value = values.join("\u0000");
    if (value === published) return;
    published = value;
    execFile("hc", ["label", terminal, ...KEYS.map((k, i) => `${k}=${values[i]}`)], { timeout: 5000 }, () => {});
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        publish();
      } catch {}
    }, 150);
    timer.unref?.();
  };

  const reset = () => {
    shared.agents.clear();
    shared.progress.clear();
  };

  const attach = (_event, ctx) => {
    if (!isMain(ctx)) return;
    mainId = ctx.agent.id;
    ui = ctx.ui;
    shared.wake = schedule;
    if (interval === undefined) {
      // Estimates, steps and queue state change without a lifecycle event.
      interval = ctx.setInterval(() => {
        if ([...shared.agents.values()].some((e) => e.state !== "done")) publish();
      }, REFRESH_MS);
    }
    schedule();
  };
  pi.on("session_start", attach);

  // Another session in this process: the old batch is not its work.
  for (const name of ["session_switch", "session_branch", "session_tree"]) {
    pi.on(name, (event, ctx) => {
      if (!isMain(ctx)) return;
      reset();
      attach(event, ctx);
    });
  }

  // A prompt after the batch has settled starts the next one; while subagents are
  // still running, the prompt steers the same work and the batch keeps counting.
  pi.on("input", (_event, ctx) => {
    if (!isMain(ctx)) return;
    if ([...shared.agents.values()].some((e) => e.state !== "done")) return;
    if (!shared.agents.size) return;
    reset();
    schedule();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isMain(ctx)) return;
    clearTimeout(timer);
    if (interval !== undefined) ctx.clearTimer?.(interval);
    interval = undefined;
    shared.wake = undefined;
    reset();
    published = undefined;
    if (terminal) execFile("hc", ["label", terminal, ...KEYS.map((k) => `${k}=`)], { timeout: 2000 }, () => {});
  });
}
