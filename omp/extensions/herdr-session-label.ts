// Publishes the id of the main omp session on its herdr terminal as the label
// `agents.session=<session id>` (removed when the session leaves). Lets other
// herdr mods (herdr-agent-bridge's bridge-trail) tie a session log to the terminal
// it runs in exactly, instead of guessing from the working folder.
// @ts-nocheck

import { execFile } from "node:child_process";

const terminal = process.env.HC_TERMINAL_ID;
const LABEL = "agents.session";

let published = "";
let timer;

const isMain = (ctx) => ctx?.agent?.kind !== "sub";

function sessionId(ctx) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && /^[A-Za-z0-9._-]{8,80}$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

function publish(value) {
  if (!terminal) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    if (value === published) return;
    published = value;
    execFile("hc", ["label", terminal, `${LABEL}=${value}`], { timeout: 5000 }, () => {});
  }, 150);
  timer.unref?.();
}

export default function (pi) {
  if (!terminal) return;

  // A session can change under a running omp (/new, /resume, /fork): the label follows it.
  const refresh = (_event, ctx) => {
    if (!isMain(ctx)) return;
    const id = sessionId(ctx);
    if (id) publish(id);
  };
  for (const name of ["session_start", "session_switch", "session_branch", "session_tree", "agent_start"]) pi.on(name, refresh);

  pi.on("session_shutdown", (_event, ctx) => {
    if (!isMain(ctx)) return;
    clearTimeout(timer);
    published = "";
    execFile("hc", ["label", terminal, `${LABEL}=`], { timeout: 2000 }, () => {});
  });
}
