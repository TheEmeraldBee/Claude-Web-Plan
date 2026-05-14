import type { CalloutProps } from "./types.js";

export function Callout({ variant = "info", children }: CalloutProps) {
  return <div class={`callout callout-${variant}`}>{children}</div>;
}
