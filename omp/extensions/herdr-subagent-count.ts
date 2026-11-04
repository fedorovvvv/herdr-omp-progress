// Publishes how many omp subagents are working, per nesting level, on this
// herdr terminal as the label `agents.subs` ("2,1" = two at level 1, one at
// level 2; removed at zero). The herdr app's agents-stacked mod draws it.
// @ts-nocheck

import { execFile } from "node:child_process";

const terminal = process.env.HC_TERMINAL_ID;
const LABEL = "agents.subs";

// Every session in this process (main and each subagent) gets its own copy of
// this factory; they share one registry so the main terminal sees the whole tree.
const shared =
  globalThis.__herdrSubagentCount ??
  (globalThis.__herdrSubagentCount = { working: new Map(), timer: undefined, published: "" });

function encode() {
  const levels = [];
  for (const level of shared.working.values()) levels[level - 1] = (levels[level - 1] ?? 0) + 1;
  return Array.from(levels, (n) => n ?? 0).join(",");
}

function publish() {
  clearTimeout(shared.timer);
  shared.timer = setTimeout(() => {
    shared.timer = undefined;
    const value = encode();
    if (value === shared.published) return;
    shared.published = value;
    execFile("hc", ["label", terminal, `${LABEL}=${value}`], { timeout: 5000 }, () => {});
  }, 150);
  shared.timer.unref?.();
}

export default function (pi) {
  if (!terminal) return;

  pi.on("agent_start", (_event, ctx) => {
    const agent = ctx?.agent;
    if (agent?.kind !== "sub") return;
    // `depth` counts task nesting only; /tan clones are subagents at depth 0.
    shared.working.set(agent.id, Math.max(1, agent.depth ?? 1));
    publish();
  });

  pi.on("agent_end", (event, ctx) => {
    const agent = ctx?.agent;
    if (agent?.kind !== "sub" || event?.willContinue === true) return;
    if (shared.working.delete(agent.id)) publish();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const agent = ctx?.agent;
    if (agent?.kind === "sub") {
      if (shared.working.delete(agent.id)) publish();
      return;
    }
    // The main session is leaving: nothing it spawned outlives it.
    shared.working.clear();
    clearTimeout(shared.timer);
    shared.published = "";
    execFile("hc", ["label", terminal, `${LABEL}=`], { timeout: 2000 }, () => {});
  });
}
