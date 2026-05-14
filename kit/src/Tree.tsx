import type { TreeNode, TreeProps } from "./types.js";

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return (
    <>
      <li class="tree-row" style={{ paddingLeft: `${depth * 16}px` }}>
        <code class="tree-name">{node.name}</code>
        {node.desc ? <span class="tree-desc">{node.desc}</span> : null}
      </li>
      {(node.children ?? []).map((c, i) => (
        <TreeRow node={c} depth={depth + 1} key={`${depth}-${i}`} />
      ))}
    </>
  );
}

export function Tree({ root }: TreeProps) {
  return (
    <ul class="tree">
      <TreeRow node={root} depth={0} />
    </ul>
  );
}
