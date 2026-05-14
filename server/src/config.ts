import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  port: number;
  storageRoot: string;
  theme: string;
  openCommand: string;
  autoLaunch: "always" | "on-ask" | "never";
}

const DEFAULTS: Config = {
  port: 1248,
  storageRoot: join(homedir(), ".web-planner"),
  theme: "catppuccin-mocha",
  openCommand: "",
  autoLaunch: "on-ask",
};

function envConfigPath(): string {
  return process.env["WEB_PLANNER_CONFIG"] ?? join(homedir(), ".web-planner", "config.json");
}

export function loadConfig(): Config {
  const path = envConfigPath();
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function projectSlugFromCwd(cwd: string = process.cwd()): string {
  const base = cwd.split("/").filter(Boolean).pop() ?? "default";
  return base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "default";
}
