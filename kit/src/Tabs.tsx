import { toChildArray } from "preact";
import type { ComponentChildren, VNode } from "preact";

export interface TabProps {
  label: string;
  /**
   * Stable id for this tab panel. If omitted, derived from the label by
   * lower-casing and slugifying. Comment keys are `${blockId}~${tabId}`, so
   * an unstable id (the old `tab-0`, `tab-1`) silently rebound comments to
   * the wrong panel when tabs were reordered. Provide an explicit id when
   * the label might change.
   */
  id?: string;
  children?: ComponentChildren;
}

export interface TabsProps {
  children?: ComponentChildren;
}

function slugifyLabel(label: string, fallback: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || fallback;
}

export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

export function Tabs({ children }: TabsProps) {
  const tabs = toChildArray(children).filter(
    (c): c is VNode<TabProps> => typeof c === "object" && c !== null && "props" in c,
  );
  if (!tabs.length) return null;
  // Resolve ids up front so the button-bar and panel arrays agree. If labels
  // collide after slugifying, suffix with the index to keep them unique.
  const seen = new Set<string>();
  const ids = tabs.map((t, i) => {
    const base = t.props.id?.trim() || slugifyLabel(t.props.label, `tab-${i}`);
    let id = base;
    let n = 2;
    while (seen.has(id)) { id = `${base}-${n}`; n++; }
    seen.add(id);
    return id;
  });
  return (
    <div class="plan-tabs" data-plan-tabs="">
      <nav class="plan-tab-bar">
        {tabs.map((t, i) => {
          const id = ids[i]!;
          return (
            <button type="button" class={`plan-tab-btn${i === 0 ? " active" : ""}`} data-for-tab={id} key={id}>
              {t.props.label}
            </button>
          );
        })}
      </nav>
      {tabs.map((t, i) => {
        const id = ids[i]!;
        return (
          <div class="plan-tab-panel" data-tab-id={id} hidden={i !== 0} key={id}>
            {t.props.children}
          </div>
        );
      })}
    </div>
  );
}
