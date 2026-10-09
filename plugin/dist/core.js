// src/version.ts
var PLUGIN_VERSION = "0.1.0-preview";

// src/entry/core.ts
if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(`cowork-sync core ${PLUGIN_VERSION}
`);
}
