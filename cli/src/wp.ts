import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface Config {
  port: number;
  storageRoot: string;
  openCommand: string;
}
const DEFAULTS: Config = { port: 1248, storageRoot: join(homedir(), ".web-planner"), openCommand: "" };
function loadConfig(): Config {
  const path = process.env["WEB_PLANNER_CONFIG"] ?? join(homedir(), ".web-planner", "config.json");
  if (!existsSync(path)) return DEFAULTS;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return DEFAULTS;
  }
}

const cfg = loadConfig();
const base = `http://localhost:${cfg.port}`;

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(base + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

async function cmdSend(args: string[]) {
  const text = args.join(" ").trim();
  if (!text) die("usage: wp send <message>");
  const r = await api("/api/message", {
    method: "POST",
    body: JSON.stringify({ text, source: "wp-cli" }),
  });
  if (r.ok) {
    console.log("sent.");
  } else {
    const e = await r.json().catch(() => ({}));
    die(`send failed: ${(e as { error?: string }).error ?? r.status}`);
  }
}

async function cmdStatus() {
  const r = await api("/api/state");
  if (!r.ok) die(`status failed: ${r.status}`);
  const s = await r.json() as { kind: string; since: number };
  const age = Math.floor((Date.now() - s.since) / 1000);
  console.log(`${s.kind} (${age}s)`);
}

async function cmdOpen(args: string[]) {
  let url = base + "/";
  if (args[0]) url = base + args[0];
  if (!cfg.openCommand) {
    console.log(url);
    return;
  }
  const cmd = cfg.openCommand.replace(/\{url\}/g, url);
  const parts = cmd.split(/\s+/).filter(Boolean);
  if (parts.length === 0) { console.log(url); return; }
  spawn(parts[0]!, parts.slice(1), { stdio: "ignore", detached: true }).unref();
}

async function cmdPlans() {
  const r = await api("/api/plans");
  if (!r.ok) die(`plans failed: ${r.status}`);
  const obj = await r.json() as Record<string, { id: string; title: string; status: string; modified: string }[]>;
  for (const project of Object.keys(obj)) {
    console.log(`\n${project}`);
    for (const p of obj[project] ?? []) {
      console.log(`  ${p.modified.slice(0,16)}  [${p.status}]  ${p.title}  (${p.id})`);
    }
  }
}

async function cmdFeedback(args: string[]) {
  // wp feedback <project> <plan_id>
  if (args.length < 2) die("usage: wp feedback <project> <plan_id>");
  const r = await api("/api/feedback", {
    method: "POST",
    body: JSON.stringify({ project: args[0], planId: args[1] }),
  });
  if (r.ok) {
    console.log("sent.");
  } else {
    const e = await r.json().catch(() => ({})) as { error?: string };
    die(`feedback failed: ${e.error ?? r.status}`);
  }
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function help() {
  console.log(`wp — web-planner CLI (talks to http://localhost:${cfg.port})

  wp send <message>           send a message to the planner (unblocks wait_for_message)
  wp status                   print current planner activity
  wp open [path]              open the dashboard (or a path) via the configured open-command
  wp plans                    list plans by project
  wp feedback <prj> <plan>    bundle comments and send as feedback
`);
}

const [, , cmd, ...rest] = process.argv;
(async () => {
  try {
    switch (cmd) {
      case "send":     return await cmdSend(rest);
      case "status":   return await cmdStatus();
      case "open":     return await cmdOpen(rest);
      case "plans":    return await cmdPlans();
      case "feedback": return await cmdFeedback(rest);
      case "help":
      case "-h":
      case "--help":
      case undefined:  return help();
      default: die(`unknown command: ${cmd}`);
    }
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
})();
