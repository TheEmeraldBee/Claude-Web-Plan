// dev entry: HTTP sidecar only, no MCP. Useful for hand-testing the UI.
import { startHttp, storage } from "./http.js";
import { state } from "./state.js";
import { startWatch } from "./layout.js";

async function main() {
  await startHttp();
  for (const p of storage.listProjects()) {
    const meta = storage.readProject(p);
    if (meta?.watchPath) {
      startWatch(p, meta.watchPath, (pr) => state.broadcast({ type: "layout:changed", project: pr }));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
