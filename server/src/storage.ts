import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const STATUSES = ["designing", "ready", "implemented", "rejected"] as const;
export type PlanStatus = typeof STATUSES[number];

const STATUS_MIGRATION: Record<string, PlanStatus> = {
  proposed: "designing",
  approved: "ready",
  designed: "designing",
  implemented: "implemented",
  abandoned: "rejected",
};

function migrateStatus(raw: string): PlanStatus {
  if ((STATUSES as readonly string[]).includes(raw)) return raw as PlanStatus;
  return STATUS_MIGRATION[raw] ?? "designing";
}

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
}

export interface TabRef {
  id: string;
  title: string;
  kind: "builtin" | "custom";
}

export interface ProjectMeta {
  slug: string;
  name: string;
  description: string;
  watchPath: string;       // absolute path to source dir; "" means none
  tabs: TabRef[];
  theme?: string | Record<string, string>;
  created: string;
  modified: string;
}

export interface ModalMeta {
  id: string;         // <ts>-<slug>
  title: string;
  project: string;
  created: string;    // ISO
}

export interface ModalRecord {
  meta: ModalMeta;
  source: string;     // .modal.tsx source
  html: string;       // compiled body html (cache)
}

export type CommentTargetKind = "plan" | "tab";
export interface Comment {
  id: string;
  target_kind: CommentTargetKind;
  target_id: string;
  block_id: string;
  text: string;
  created: string;
  modified: string;
}

const META_SUFFIX = ".meta.json";
const SOURCE_SUFFIX = ".plan.tsx";
const NOTES_SUFFIX = ".notes.json"; // legacy — migrated then deleted
const COMMENTS_FILE = "comments.json";
const PROJECT_META = "project.json";
const TAB_SUFFIX = ".tab.tsx";
const MODAL_SUFFIX = ".modal.tsx";
const MODAL_META_SUFFIX = ".modal.meta.json";
const MODAL_HTML_SUFFIX = ".modal.html";
const BUILTIN_TABS: TabRef[] = [
  { id: "plans", title: "Plans", kind: "builtin" },
  { id: "modals", title: "Modals", kind: "builtin" },
  { id: "layout", title: "Layout", kind: "builtin" },
];

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
    this.migrateAll();
  }

  // ---------- paths ----------
  projectDir(project: string): string { return join(this.root, "projects", project); }
  plansDir(project: string): string { return join(this.projectDir(project), "plans"); }
  tabsDir(project: string): string { return join(this.projectDir(project), "tabs"); }
  modalsDir(project: string): string { return join(this.projectDir(project), "modals"); }
  componentsPath(project: string): string { return join(this.projectDir(project), "components.tsx"); }
  tabPath(project: string, tabId: string): string { return join(this.tabsDir(project), tabId + TAB_SUFFIX); }
  modalPath(project: string, id: string): string { return join(this.modalsDir(project), id + MODAL_SUFFIX); }
  modalMetaPath(project: string, id: string): string { return join(this.modalsDir(project), id + MODAL_META_SUFFIX); }
  modalHtmlPath(project: string, id: string): string { return join(this.modalsDir(project), id + MODAL_HTML_SUFFIX); }
  commentsPath(project: string): string { return join(this.projectDir(project), COMMENTS_FILE); }
  basePath(project: string, planId: string): string { return join(this.plansDir(project), planId); }

  // ---------- project ----------
  ensureProject(project: string) {
    ensureDir(this.plansDir(project));
    ensureDir(this.tabsDir(project));
    ensureDir(this.modalsDir(project));
    const comps = this.componentsPath(project);
    if (!existsSync(comps)) {
      atomicWrite(comps, "// per-project component extensions\n// Claude appends new components here as it invents new block kinds.\n\nexport {};\n");
    }
    const metaPath = join(this.projectDir(project), PROJECT_META);
    if (!existsSync(metaPath)) {
      const now = new Date().toISOString();
      const meta: ProjectMeta = {
        slug: project, name: project, description: "", watchPath: "",
        tabs: BUILTIN_TABS.slice(), created: now, modified: now,
      };
      atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    }
  }

  readProject(project: string): ProjectMeta | null {
    const metaPath = join(this.projectDir(project), PROJECT_META);
    if (!existsSync(metaPath)) return null;
    try {
      return JSON.parse(readFileSync(metaPath, "utf8")) as ProjectMeta;
    } catch {
      return null;
    }
  }

  writeProject(meta: ProjectMeta) {
    this.ensureProject(meta.slug);
    meta.modified = new Date().toISOString();
    atomicWrite(join(this.projectDir(meta.slug), PROJECT_META), JSON.stringify(meta, null, 2));
  }

  setProjectMeta(project: string, patch: Partial<Pick<ProjectMeta, "name" | "description" | "watchPath">>): ProjectMeta {
    this.ensureProject(project);
    const existing = this.readProject(project)!;
    const next: ProjectMeta = { ...existing, ...patch };
    this.writeProject(next);
    return next;
  }

  setTheme(project: string, theme: string | Record<string, string>): ProjectMeta {
    this.ensureProject(project);
    const existing = this.readProject(project)!;
    const next: ProjectMeta = { ...existing, theme };
    this.writeProject(next);
    return next;
  }

  getTheme(project: string): string | Record<string, string> | undefined {
    return this.readProject(project)?.theme;
  }

  // ---------- tabs ----------
  writeTab(project: string, id: string, title: string, source: string): ProjectMeta {
    this.ensureProject(project);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid_tab_id: ${id} (must be lowercase kebab)`);
    if (id === "plans" || id === "layout" || id === "modals") throw new Error(`reserved_tab_id: ${id}`);
    atomicWrite(this.tabPath(project, id), source);
    const meta = this.readProject(project)!;
    const i = meta.tabs.findIndex((t) => t.id === id);
    const entry: TabRef = { id, title, kind: "custom" };
    if (i === -1) {
      if (id === "home") {
        const firstCustom = meta.tabs.findIndex((t) => t.kind !== "builtin");
        meta.tabs.splice(firstCustom === -1 ? 0 : firstCustom, 0, entry);
      } else {
        meta.tabs.push(entry);
      }
    } else {
      meta.tabs[i] = entry;
    }
    this.writeProject(meta);
    return meta;
  }

  readTabSource(project: string, id: string): string | null {
    const path = this.tabPath(project, id);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  // ---------- plans ----------
  writePlan(rec: PlanRecord): void {
    this.ensureProject(rec.meta.project);
    const base = this.basePath(rec.meta.project, rec.meta.id);
    atomicWrite(base + SOURCE_SUFFIX, rec.source);
    atomicWrite(base + META_SUFFIX, JSON.stringify(rec.meta, null, 2));
  }

  readPlan(project: string, planId: string): PlanRecord | null {
    const base = this.basePath(project, planId);
    if (!existsSync(base + SOURCE_SUFFIX) || !existsSync(base + META_SUFFIX)) return null;
    const raw = JSON.parse(readFileSync(base + META_SUFFIX, "utf8")) as PlanMeta;
    raw.status = migrateStatus(raw.status as unknown as string);
    const source = readFileSync(base + SOURCE_SUFFIX, "utf8");
    return { meta: raw, source };
  }

  updateSource(project: string, planId: string, source: string): PlanRecord {
    const rec = this.readPlan(project, planId);
    if (!rec) throw new Error(`plan not found: ${project}/${planId}`);
    rec.source = source;
    rec.meta.modified = new Date().toISOString();
    this.writePlan(rec);
    return rec;
  }

  deletePlan(project: string, planId: string): boolean {
    const base = this.basePath(project, planId);
    let removed = false;
    for (const ext of [SOURCE_SUFFIX, META_SUFFIX, NOTES_SUFFIX]) {
      const p = base + ext;
      if (existsSync(p)) { rmSync(p); removed = true; }
    }
    // also drop any comments scoped to this plan
    this.clearCommentsForTarget(project, "plan", planId);
    return removed;
  }

  setStatus(project: string, planId: string, status: PlanStatus): PlanRecord {
    const rec = this.readPlan(project, planId);
    if (!rec) throw new Error(`plan not found: ${project}/${planId}`);
    rec.meta.status = status;
    rec.meta.modified = new Date().toISOString();
    const base = this.basePath(project, planId);
    atomicWrite(base + META_SUFFIX, JSON.stringify(rec.meta, null, 2));
    // Keep the source's <Plan status="..."> attribute in sync so re-renders
    // and re-compiles don't show stale state. Same regex the migration uses.
    const patchedSource = rec.source.replace(/(<Plan\b[^>]*\sstatus=")([^"]+)(")/, (_m, a, _b, c) => `${a}${status}${c}`);
    if (patchedSource !== rec.source) {
      atomicWrite(base + SOURCE_SUFFIX, patchedSource);
      rec.source = patchedSource;
    }
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
        const raw = JSON.parse(readFileSync(full, "utf8")) as PlanMeta;
        raw.status = migrateStatus(raw.status as unknown as string);
        metas.push(raw);
      } catch {
        // skip corrupt
      }
    }
    return metas.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  // ---------- modals ----------
  writeModal(rec: ModalRecord): void {
    this.ensureProject(rec.meta.project);
    atomicWrite(this.modalPath(rec.meta.project, rec.meta.id), rec.source);
    atomicWrite(this.modalMetaPath(rec.meta.project, rec.meta.id), JSON.stringify(rec.meta, null, 2));
    atomicWrite(this.modalHtmlPath(rec.meta.project, rec.meta.id), rec.html);
  }

  readModal(project: string, id: string): ModalRecord | null {
    const metaP = this.modalMetaPath(project, id);
    const srcP = this.modalPath(project, id);
    const htmlP = this.modalHtmlPath(project, id);
    if (!existsSync(metaP) || !existsSync(srcP) || !existsSync(htmlP)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaP, "utf8")) as ModalMeta;
      const source = readFileSync(srcP, "utf8");
      const html = readFileSync(htmlP, "utf8");
      return { meta, source, html };
    } catch { return null; }
  }

  listModals(project: string): ModalMeta[] {
    const dir = this.modalsDir(project);
    if (!existsSync(dir)) return [];
    const metas: ModalMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(MODAL_META_SUFFIX)) continue;
      try {
        metas.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ModalMeta);
      } catch { /* skip */ }
    }
    return metas.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  deleteModal(project: string, id: string): boolean {
    let removed = false;
    for (const ext of [MODAL_SUFFIX, MODAL_META_SUFFIX, MODAL_HTML_SUFFIX]) {
      const p = join(this.modalsDir(project), id + ext);
      if (existsSync(p)) { rmSync(p); removed = true; }
    }
    return removed;
  }

  clearModals(project: string): number {
    const dir = this.modalsDir(project);
    if (!existsSync(dir)) return 0;
    let n = 0;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try { rmSync(p); n++; } catch { /* skip */ }
    }
    return n;
  }

  // ---------- comments (unified) ----------
  private readComments(project: string): Comment[] {
    const p = this.commentsPath(project);
    if (!existsSync(p)) return [];
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Comment[];
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  private writeComments(project: string, comments: Comment[]) {
    this.ensureProject(project);
    atomicWrite(this.commentsPath(project), JSON.stringify(comments, null, 2));
  }

  listComments(project: string): Comment[] {
    return this.readComments(project);
  }

  getComments(project: string, target_kind: CommentTargetKind, target_id: string): Comment[] {
    return this.readComments(project).filter((c) => c.target_kind === target_kind && c.target_id === target_id);
  }

  setComment(project: string, target_kind: CommentTargetKind, target_id: string, block_id: string, text: string): Comment | null {
    const comments = this.readComments(project);
    const i = comments.findIndex((c) => c.target_kind === target_kind && c.target_id === target_id && c.block_id === block_id);
    const now = new Date().toISOString();
    if (text === "") {
      if (i === -1) return null;
      comments.splice(i, 1);
      this.writeComments(project, comments);
      return null;
    }
    if (i === -1) {
      const c: Comment = { id: randomUUID(), target_kind, target_id, block_id, text, created: now, modified: now };
      comments.push(c);
      this.writeComments(project, comments);
      return c;
    }
    comments[i] = { ...comments[i]!, text, modified: now };
    this.writeComments(project, comments);
    return comments[i]!;
  }

  clearComment(project: string, target_kind: CommentTargetKind, target_id: string, block_id: string): boolean {
    const comments = this.readComments(project);
    const i = comments.findIndex((c) => c.target_kind === target_kind && c.target_id === target_id && c.block_id === block_id);
    if (i === -1) return false;
    comments.splice(i, 1);
    this.writeComments(project, comments);
    return true;
  }

  clearCommentsForTarget(project: string, target_kind: CommentTargetKind, target_id: string): number {
    const comments = this.readComments(project);
    const before = comments.length;
    const next = comments.filter((c) => !(c.target_kind === target_kind && c.target_id === target_id));
    if (next.length === before) return 0;
    this.writeComments(project, next);
    return before - next.length;
  }

  // notes shaped for a target — convenience for HTML decoration
  notesFor(project: string, target_kind: CommentTargetKind, target_id: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const c of this.readComments(project)) {
      if (c.target_kind === target_kind && c.target_id === target_id) out[c.block_id] = c.text;
    }
    return out;
  }

  // ---------- components ----------
  appendComponent(project: string, name: string, source: string) {
    this.ensureProject(project);
    const path = this.componentsPath(project);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (new RegExp(`export\\s+(function|const)\\s+${name}\\b`).test(existing)) {
      throw new Error(`component_exists: ${name}`);
    }
    atomicWrite(path, existing + "\n" + source.trim() + "\n");
  }

  // ---------- one-shot migration ----------
  private migrateAll() {
    const projectsDir = join(this.root, "projects");
    if (!existsSync(projectsDir)) return;
    for (const project of readdirSync(projectsDir)) {
      const pd = join(projectsDir, project);
      if (!statSync(pd).isDirectory()) continue;
      this.migrateProject(project);
    }
  }

  private migrateProject(project: string) {
    // 0. Ensure the builtin 'modals' tab is present (added in the open_modal feature).
    const metaPath = join(this.projectDir(project), PROJECT_META);
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ProjectMeta;
        if (!meta.tabs.some((t) => t.id === "modals")) {
          const layoutIdx = meta.tabs.findIndex((t) => t.id === "layout");
          const entry: TabRef = { id: "modals", title: "Modals", kind: "builtin" };
          if (layoutIdx === -1) meta.tabs.push(entry);
          else meta.tabs.splice(layoutIdx, 0, entry);
          atomicWrite(metaPath, JSON.stringify(meta, null, 2));
        }
      } catch { /* skip */ }
    }

    // 1. Migrate plan meta.json statuses + drop legacy notes files (folding into comments.json)
    const aggregated: Comment[] = this.readComments(project);
    const seen = new Set(aggregated.map((c) => `${c.target_kind}|${c.target_id}|${c.block_id}`));
    const now = new Date().toISOString();

    const plansDir = this.plansDir(project);
    if (existsSync(plansDir)) {
      for (const name of readdirSync(plansDir)) {
        const full = join(plansDir, name);
        if (name.endsWith(META_SUFFIX)) {
          try {
            const raw = JSON.parse(readFileSync(full, "utf8")) as PlanMeta;
            const next = migrateStatus(raw.status as unknown as string);
            if (next !== raw.status) {
              const updated: PlanMeta = { ...raw, status: next };
              atomicWrite(full, JSON.stringify(updated, null, 2));
              // also patch source's status="..."
              const base = full.slice(0, -META_SUFFIX.length);
              const sourcePath = base + SOURCE_SUFFIX;
              if (existsSync(sourcePath)) {
                const src = readFileSync(sourcePath, "utf8");
                const patched = src.replace(/(<Plan\b[^>]*\sstatus=")([^"]+)(")/, (_m, a, _b, c) => `${a}${next}${c}`);
                if (patched !== src) atomicWrite(sourcePath, patched);
              }
            }
          } catch { /* skip */ }
        }
        if (name.endsWith(NOTES_SUFFIX)) {
          // legacy per-plan notes — fold into comments.json
          const planId = name.slice(0, -NOTES_SUFFIX.length);
          try {
            const notes = JSON.parse(readFileSync(full, "utf8")) as Record<string, string>;
            for (const [block_id, text] of Object.entries(notes)) {
              const key = `plan|${planId}|${block_id}`;
              if (seen.has(key) || !text) continue;
              aggregated.push({
                id: randomUUID(), target_kind: "plan", target_id: planId,
                block_id, text, created: now, modified: now,
              });
              seen.add(key);
            }
          } catch { /* skip */ }
          rmSync(full);
        }
      }
    }

    // 2. Migrate per-tab notes
    const tabsDir = this.tabsDir(project);
    if (existsSync(tabsDir)) {
      for (const name of readdirSync(tabsDir)) {
        if (!name.endsWith(".tab.notes.json")) continue;
        const tabId = name.slice(0, -".tab.notes.json".length);
        const full = join(tabsDir, name);
        try {
          const notes = JSON.parse(readFileSync(full, "utf8")) as Record<string, string>;
          for (const [block_id, text] of Object.entries(notes)) {
            const key = `tab|${tabId}|${block_id}`;
            if (seen.has(key) || !text) continue;
            aggregated.push({
              id: randomUUID(), target_kind: "tab", target_id: tabId,
              block_id, text, created: now, modified: now,
            });
            seen.add(key);
          }
        } catch { /* skip */ }
        rmSync(full);
      }
    }

    if (aggregated.length > 0 || existsSync(this.commentsPath(project))) {
      this.writeComments(project, aggregated);
    }
  }
}
