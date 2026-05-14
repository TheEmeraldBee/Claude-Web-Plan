import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type PlanStatus = "proposed" | "approved" | "implemented" | "abandoned";

export interface PlanMeta {
  id: string;          // <ts>-<slug>
  title: string;
  slug: string;
  status: PlanStatus;
  created: string;     // ISO
  modified: string;    // ISO
  project: string;
}

export interface PlanRecord {
  meta: PlanMeta;
  source: string;          // .plan.tsx source
  notes: Record<string, string>; // blockId -> comment
}

const META_SUFFIX = ".meta.json";
const SOURCE_SUFFIX = ".plan.tsx";
const NOTES_SUFFIX = ".notes.json";

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function atomicWrite(path: string, content: string) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

export class Storage {
  constructor(private readonly root: string) {
    ensureDir(root);
    ensureDir(join(root, "projects"));
  }

  projectDir(project: string): string {
    return join(this.root, "projects", project);
  }
  plansDir(project: string): string {
    return join(this.projectDir(project), "plans");
  }
  componentsPath(project: string): string {
    return join(this.projectDir(project), "components.tsx");
  }

  ensureProject(project: string) {
    ensureDir(this.plansDir(project));
    const comps = this.componentsPath(project);
    if (!existsSync(comps)) {
      atomicWrite(comps, "// per-project component extensions\n// Claude appends new components here as it invents new block kinds.\n\nexport {};\n");
    }
  }

  basePath(project: string, planId: string): string {
    return join(this.plansDir(project), planId);
  }

  writePlan(rec: PlanRecord): void {
    this.ensureProject(rec.meta.project);
    const base = this.basePath(rec.meta.project, rec.meta.id);
    atomicWrite(base + SOURCE_SUFFIX, rec.source);
    atomicWrite(base + META_SUFFIX, JSON.stringify(rec.meta, null, 2));
    atomicWrite(base + NOTES_SUFFIX, JSON.stringify(rec.notes, null, 2));
  }

  readPlan(project: string, planId: string): PlanRecord | null {
    const base = this.basePath(project, planId);
    if (!existsSync(base + SOURCE_SUFFIX) || !existsSync(base + META_SUFFIX)) return null;
    const meta = JSON.parse(readFileSync(base + META_SUFFIX, "utf8")) as PlanMeta;
    const source = readFileSync(base + SOURCE_SUFFIX, "utf8");
    const notes = existsSync(base + NOTES_SUFFIX)
      ? (JSON.parse(readFileSync(base + NOTES_SUFFIX, "utf8")) as Record<string, string>)
      : {};
    return { meta, source, notes };
  }

  updateSource(project: string, planId: string, source: string): PlanRecord {
    const rec = this.readPlan(project, planId);
    if (!rec) throw new Error(`plan not found: ${project}/${planId}`);
    if (rec.meta.status === "implemented") {
      throw new Error("plan_frozen: implemented plans cannot be edited");
    }
    rec.source = source;
    rec.meta.modified = new Date().toISOString();
    this.writePlan(rec);
    return rec;
  }

  setComment(project: string, planId: string, blockId: string, text: string): PlanRecord {
    const rec = this.readPlan(project, planId);
    if (!rec) throw new Error(`plan not found: ${project}/${planId}`);
    if (rec.meta.status === "implemented") {
      throw new Error("plan_frozen: implemented plans cannot accept comments");
    }
    rec.notes[blockId] = text;
    const base = this.basePath(project, planId);
    atomicWrite(base + NOTES_SUFFIX, JSON.stringify(rec.notes, null, 2));
    return rec;
  }

  setStatus(project: string, planId: string, status: PlanStatus): PlanRecord {
    const rec = this.readPlan(project, planId);
    if (!rec) throw new Error(`plan not found: ${project}/${planId}`);
    rec.meta.status = status;
    rec.meta.modified = new Date().toISOString();
    const base = this.basePath(project, planId);
    atomicWrite(base + META_SUFFIX, JSON.stringify(rec.meta, null, 2));
    return rec;
  }

  listProjects(): string[] {
    const dir = join(this.root, "projects");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  }

  listPlans(project: string): PlanMeta[] {
    const dir = this.plansDir(project);
    if (!existsSync(dir)) return [];
    const metas: PlanMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const full = join(dir, name);
      try {
        metas.push(JSON.parse(readFileSync(full, "utf8")) as PlanMeta);
      } catch {
        // skip corrupt
      }
    }
    return metas.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  appendComponent(project: string, name: string, source: string) {
    this.ensureProject(project);
    const path = this.componentsPath(project);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (new RegExp(`export\\s+(function|const)\\s+${name}\\b`).test(existing)) {
      throw new Error(`component_exists: ${name}`);
    }
    atomicWrite(path, existing + "\n" + source.trim() + "\n");
  }
}
