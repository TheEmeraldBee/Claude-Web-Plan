// dev entry: HTTP sidecar only, no MCP. Useful for hand-testing the UI.
import { startHttp } from "./http.js";

startHttp().catch((e) => {
  console.error(e);
  process.exit(1);
});
