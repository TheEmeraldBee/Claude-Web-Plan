import type { CodeBlockProps } from "./types.js";

export function CodeBlock({ lang, children }: CodeBlockProps) {
  return (
    <pre class={`code-block lang-${lang ?? "text"}`}>
      <code>{children}</code>
    </pre>
  );
}
