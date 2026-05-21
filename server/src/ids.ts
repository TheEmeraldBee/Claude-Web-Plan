// Shared id + slug helpers. Used by mcp.ts and http.ts; do not duplicate.

/**
 * UTC-ordered, collision-resistant id: YYYY-MM-DD-HHMMSS-<slug>-<base36rand>
 *
 * Why UTC: meta.json's `created` / `modified` use ISO UTC. Sorting by id and
 * sorting by timestamp must agree across DST and across machines.
 *
 * Why a random suffix: nowId previously collided when two writes landed in
 * the same minute. The 4-char base36 tail makes collisions astronomically
 * unlikely (~1e-6 per same-second pair).
 */
export function nowId(slug: string): string {
  const d = new Date();
  const ts =
    `${d.getUTCFullYear()}-` +
    `${pad(d.getUTCMonth() + 1)}-` +
    `${pad(d.getUTCDate())}-` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${slug}-${rand}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "plan";
}
