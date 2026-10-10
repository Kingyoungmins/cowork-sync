// src/version.ts
var PLUGIN_VERSION = "0.1.1-preview";

// src/entry/hook.ts
if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(`cowork-sync hook ${PLUGIN_VERSION}
`);
}
