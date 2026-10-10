// src/version.ts
var PLUGIN_VERSION = "0.1.1-preview";

// src/entry/mcp.ts
if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(`cowork-sync mcp ${PLUGIN_VERSION}
`);
}
