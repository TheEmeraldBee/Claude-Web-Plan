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

export interface TabRef {
  id: string;
  title: string;
  kind: "builtin" | "custom" | "board";
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

export interface Card {
  id: string;
  title: string;
  body: string;
  status: string;
  created: string;
  modified: string;
}

export interface CardBoard {
  id: string;
  title: string;
  statuses: string[];
  cards: Card[];
}

const META_SUFFIX = ".meta.json";
const SOURCE_SUFFIX = ".plan.tsx";
const NOTES_SUFFIX = ".notes.json";
const PROJECT_META = "project.json";
const TAB_SUFFIX = ".tab.tsx";
const BUILTIN_TABS: TabRef[] = [
  { id: "plans", title: "Plans", kind: "builtin" },
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
    ensureDir(this.tabsDir(project));
    const comps = this.componentsPath(project);
    if (!existsSync(comps)) {
      atomicWrite(comps, "// per-project component extensions\n// Claude appends new components here as it invents new block kinds.\n\nexport {};\n");
    }
    const metaPath = join(this.projectDir(project), PROJECT_META);
    if (!existsSync(metaPath)) {
      const now = new Date().toISOString();
      const meta: ProjectMeta = {
        slug: project,
        name: project,
        description: "",
        watchPath: "",
        tabs: BUILTIN_TABS.slice(),
        created: now,
        modified: now,
      };
      atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    }
  }

  tabsDir(project: string): string {
    return join(this.projectDir(project), "tabs");
  }
  tabPath(project: string, tabId: string): string {
    return join(this.tabsDir(project), tabId + TAB_SUFFIX);
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

  writeTab(project: string, id: string, title: string, source: string): ProjectMeta {
    this.ensureProject(project);
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid_tab_id: ${id} (must be lowercase kebab)`);
    if (id === "plans" || id === "layout") throw new Error(`reserved_tab_id: ${id}`);
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

  boardsDir(project: string): string {
    return join(this.projectDir(project), "boards");
  }
  boardPath(project: string, boardId: string): string {
    return join(this.boardsDir(project), boardId + ".json");
  }

  writeCardBoard(project: string, board: CardBoard): void {
    this.ensureProject(project);
    ensureDir(this.boardsDir(project));
    atomicWrite(this.boardPath(project, board.id), JSON.stringify(board, null, 2));
  }

  readCardBoard(project: string, boardId: string): CardBoard | null {
    const path = this.boardPath(project, boardId);
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, "utf8")) as CardBoard; }
    catch { return null; }
  }

  createCardBoard(project: string, id: string, title: string, statuses: string[]): CardBoard {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`invalid_board_id: ${id}`);
    const board: CardBoard = { id, title, statuses, cards: [] };
    this.writeCardBoard(project, board);
    const meta = this.readProject(project)!;
    const i = meta.tabs.findIndex((t) => t.id === id);
    const entry: TabRef = { id, title, kind: "board" };
    if (i === -1) meta.tabs.push(entry);
    else meta.tabs[i] = entry;
    this.writeProject(meta);
    return board;
  }

  updateBoardStatuses(project: string, boardId: string, statuses: string[]): CardBoard {
    if (statuses.length === 0) throw new Error("statuses_empty");
    const board = this.readCardBoard(project, boardId);
    if (!board) throw new Error(`board_not_found: ${boardId}`);
    const statusSet = new Set(statuses);
    board.statuses = statuses;
    board.cards = board.cards.map((c) => ({ ...c, status: statusSet.has(c.status) ? c.status : statuses[0]! }));
    this.writeCardBoard(project, board);
    return board;
  }

  addCard(project: string, boardId: string, title: string, body: string, status: string): Card {
    const board = this.readCardBoard(project, boardId);
    if (!board) throw new Error(`board_not_found: ${boardId}`);
    if (!board.statuses.includes(status)) throw new Error(`invalid_status: ${status}. Valid: ${board.statuses.join(", ")}`);
    const now = new Date().toISOString();
    const card: Card = { id: randomUUID(), title, body, status, created: now, modified: now };
    board.cards.push(card);
    this.writeCardBoard(project, board);
    return card;
  }

  updateCard(project: string, boardId: string, cardId: string, patch: Partial<Pick<Card, "title" | "body" | "status">>): Card {
    const board = this.readCardBoard(project, boardId);
    if (!board) throw new Error(`board_not_found: ${boardId}`);
    const i = board.cards.findIndex((c) => c.id === cardId);
    if (i === -1) throw new Error(`card_not_found: ${cardId}`);
    if (patch.status && !board.statuses.includes(patch.status)) throw new Error(`invalid_status: ${patch.status}`);
    board.cards[i] = { ...board.cards[i]!, ...patch, modified: new Date().toISOString() };
    this.writeCardBoard(project, board);
    return board.cards[i]!;
  }

  deleteCard(project: string, boardId: string, cardId: string): boolean {
    const board = this.readCardBoard(project, boardId);
    if (!board) throw new Error(`board_not_found: ${boardId}`);
    const before = board.cards.length;
    board.cards = board.cards.filter((c) => c.id !== cardId);
    this.writeCardBoard(project, board);
    return board.cards.length < before;
  }

  listCards(project: string, boardId: string, status?: string): Card[] {
    const board = this.readCardBoard(project, boardId);
    if (!board) throw new Error(`board_not_found: ${boardId}`);
    return status ? board.cards.filter((c) => c.status === status) : board.cards;
  }

  tabNotesPath(project: string, tabId: string): string {
    return join(this.tabsDir(project), tabId + ".tab.notes.json");
  }

  readTabNotes(project: string, tabId: string): Record<string, string> {
    const p = this.tabNotesPath(project, tabId);
    if (!existsSync(p)) return {};
    try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, string>; }
    catch { return {}; }
  }

  setTabComment(project: string, tabId: string, blockId: string, text: string) {
    this.ensureProject(project);
    const notes = this.readTabNotes(project, tabId);
    if (text === "") {
      delete notes[blockId];
    } else {
      notes[blockId] = text;
    }
    atomicWrite(this.tabNotesPath(project, tabId), JSON.stringify(notes, null, 2));
  }

  readTabSource(project: string, id: string): string | null {
    const path = this.tabPath(project, id);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
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

  clearComment(project: string, planId: string, blockId: string): boolean {
    const rec = this.readPlan(project, planId);
    if (!rec) return false;
    if (!(blockId in rec.notes)) return false;
    delete rec.notes[blockId];
    const base = this.basePath(project, planId);
    atomicWrite(base + NOTES_SUFFIX, JSON.stringify(rec.notes, null, 2));
    return true;
  }

  deletePlan(project: string, planId: string): boolean {
    const base = this.basePath(project, planId);
    let removed = false;
    for (const ext of [SOURCE_SUFFIX, META_SUFFIX, NOTES_SUFFIX]) {
      const p = base + ext;
      if (existsSync(p)) { rmSync(p); removed = true; }
    }
    return removed;
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
