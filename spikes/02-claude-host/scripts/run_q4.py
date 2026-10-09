"""q4: does a project stdio MCP server inherit CLAUDE_CODE_MESSAGING_SOCKET/TOKEN, CLAUDE_PROJECT_DIR, CLAUDE_PLUGIN_DATA?"""
import json, os
from runner import Run, SCRATCH, RAW, collect, init_info
p = os.path.join(SCRATCH, "q4mcp")
r = Run("q4", p, "Reply with just OK.", ["--settings", os.path.join(SCRATCH, "flag_settings_accept.json"),
        "--max-turns", "1"], 120, "q4 MCP env inheritance (trivial prompt)").start().wait()
collect("q4", p)
print(json.dumps({"rc": r.rc, "dur": r.dur, "result": r.result_text(), "init": init_info(r)}, indent=1))
