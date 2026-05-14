import type { ArchProps } from "./types.js";

export function Arch({ nodes }: ArchProps) {
  return (
    <div class="arch">
      {nodes.map((n, i) => (
        <div class="arch-node" key={i}>
          <h4>{n.title}</h4>
          <p>{n.body}</p>
        </div>
      ))}
    </div>
  );
}
