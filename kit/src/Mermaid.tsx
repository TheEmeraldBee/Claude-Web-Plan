import type { MermaidProps } from "./types.js";

export function Mermaid({ children }: MermaidProps) {
  const src = typeof children === "string" ? children : String(children ?? "");
  return (
    <pre class="mermaid" data-mermaid>
      {src.trim()}
    </pre>
  );
}
