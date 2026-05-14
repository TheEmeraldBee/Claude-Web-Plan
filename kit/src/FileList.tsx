import type { FileListProps } from "./types.js";

export function FileList({ items }: FileListProps) {
  return (
    <ul class="file-list">
      {items.map((it) => (
        <li key={it.path}>
          <code class="file-path">{it.path}</code>
          <span class="file-desc">{it.desc}</span>
        </li>
      ))}
    </ul>
  );
}
