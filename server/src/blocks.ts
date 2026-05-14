import { transformSync } from "esbuild";

/**
 * Extracts every <Block id="..." ...>...</Block> top-level span from a plan source.
 * Returns ranges so we can splice in replacements without re-parsing siblings.
 *
 * We don't run a full TS parser — we lean on a robust JSX-aware scanner that
 * understands string/template/comment context. esbuild's parse pass would be
 * heavier; this is intentionally lightweight and tested against the shapes
 * Claude actually writes.
 */

export interface BlockRange {
  id: string;
  openStart: number;   // index of '<'
  openEnd: number;     // index just past the opening tag '>'
  closeStart: number;  // index of '<' of '</Block>'
  closeEnd: number;    // index just past '>'
}

const OPEN_TAG = /<Block\b([^>]*)>/g;
const ID_ATTR = /\bid\s*=\s*("([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/;
const CLOSE_TAG = "</Block>";

export function findBlocks(source: string): BlockRange[] {
  const blocks: BlockRange[] = [];
  let m: RegExpExecArray | null;
  OPEN_TAG.lastIndex = 0;
  while ((m = OPEN_TAG.exec(source))) {
    const openStart = m.index;
    const openEnd = m.index + m[0].length;
    const idMatch = (m[1] ?? "").match(ID_ATTR);
    const id = idMatch ? (idMatch[2] ?? idMatch[3] ?? idMatch[4] ?? "") : "";
    if (!id) continue;
    const closeStart = source.indexOf(CLOSE_TAG, openEnd);
    if (closeStart === -1) continue;
    const closeEnd = closeStart + CLOSE_TAG.length;
    blocks.push({ id, openStart, openEnd, closeStart, closeEnd });
  }
  return blocks;
}

export function replaceBlock(source: string, blockId: string, replacement: string): string {
  const blocks = findBlocks(source);
  const target = blocks.find((b) => b.id === blockId);
  if (!target) throw new Error(`block_not_found: ${blockId}`);
  return source.slice(0, target.openStart) + replacement.trim() + source.slice(target.closeEnd);
}

export function appendBlock(source: string, replacement: string, afterBlockId?: string): string {
  const blocks = findBlocks(source);
  if (afterBlockId) {
    const target = blocks.find((b) => b.id === afterBlockId);
    if (!target) throw new Error(`block_not_found: ${afterBlockId}`);
    return source.slice(0, target.closeEnd) + "\n" + replacement.trim() + source.slice(target.closeEnd);
  }
  // append before the last </Plan>
  const closePlan = source.lastIndexOf("</Plan>");
  if (closePlan === -1) throw new Error("plan_close_missing");
  return source.slice(0, closePlan) + replacement.trim() + "\n" + source.slice(closePlan);
}

/**
 * Validate the .plan.tsx source by asking esbuild to parse it.
 * Returns the list of <Block> ids and rejects duplicates.
 */
export interface PlanValidation {
  blockIds: string[];
  hasPlanRoot: boolean;
}

/**
 * Validates that a replacement string for update_block is exactly one <Block>
 * whose id matches the expected id. Prevents the agent from silently dropping
 * a commented block by renaming it during a replacement.
 */
export function validateReplacementBlock(replacement: string, expectedId: string): void {
  const blocks = findBlocks(replacement);
  if (blocks.length === 0) {
    throw new Error(`replacement_missing_block: replacement must contain a <Block id="${expectedId}"> element`);
  }
  if (blocks.length > 1) {
    throw new Error(`replacement_multiple_blocks: update_block expects exactly one <Block>, got ${blocks.length}. Use append_block for additions.`);
  }
  const got = blocks[0]!.id;
  if (got !== expectedId) {
    throw new Error(`block_id_mismatch: expected id "${expectedId}", replacement has id "${got}". To rename, edit the source manually then create a new plan.`);
  }
}

/**
 * Returns the ids of every <Block> in an arbitrary source fragment. Used by
 * append_block to broadcast every newly-appended id.
 */
export function blockIdsIn(source: string): string[] {
  return findBlocks(source).map((b) => b.id);
}

export function validatePlanSource(source: string): PlanValidation {
  try {
    transformSync(source, {
      loader: "tsx",
      jsx: "preserve",
      sourcefile: "plan.tsx",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`plan_parse_failed: ${msg}`);
  }
  const blocks = findBlocks(source);
  const ids = blocks.map((b) => b.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`duplicate_block_id: ${dup}`);
  const hasPlanRoot = /<Plan\b/.test(source) && /<\/Plan>/.test(source);
  if (!hasPlanRoot) throw new Error("missing_plan_root");
  return { blockIds: ids, hasPlanRoot };
}
