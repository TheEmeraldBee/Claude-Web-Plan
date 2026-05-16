import { toChildArray } from "preact";
import type { ComponentChildren, VNode } from "preact";

export interface TabProps {
  label: string;
  children?: ComponentChildren;
}

export interface TabsProps {
  children?: ComponentChildren;
}

export function Tab({ children }: TabProps) {
  return <>{children}</>;
}

export function Tabs({ children }: TabsProps) {
  const tabs = toChildArray(children).filter(
    (c): c is VNode<TabProps> => typeof c === "object" && c !== null && "props" in c,
  );
  if (!tabs.length) return null;
  return (
    <div class="plan-tabs" data-plan-tabs="">
      <nav class="plan-tab-bar">
        {tabs.map((t, i) => {
          const id = `tab-${i}`;
          return (
            <button type="button" class={`plan-tab-btn${i === 0 ? " active" : ""}`} data-for-tab={id} key={id}>
              {t.props.label}
            </button>
          );
        })}
      </nav>
      {tabs.map((t, i) => {
        const id = `tab-${i}`;
        return (
          <div class="plan-tab-panel" data-tab-id={id} hidden={i !== 0} key={id}>
            {t.props.children}
          </div>
        );
      })}
    </div>
  );
}
