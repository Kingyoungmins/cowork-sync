"""q10: command vs mcp_tool PreToolUse hooks on Write; exit 1 (uncaught throw), exit 2, and hook timeout behaviour."""
import json, os
from runner import Run, SCRATCH, RAW, collect, init_info
p = os.path.join(SCRATCH, "q10hooks")
FILES = ["a1.txt", "a2.txt", "throw.txt", "exit2.txt", "sleep.txt", "a3.txt"]
PROMPT = ("Use the Write tool to create these files one at a time, in this order, each containing the single word x: "
          + ", ".join(FILES) + ". If a write fails or is blocked, do not retry it; go on to the next file. Finally reply DONE.")
r = Run("q10", p, PROMPT, ["--max-turns", "10", "--allowedTools", "Write", "--permission-mode", "acceptEdits"], 300,
        "q10 hook types/latency/fail-open/exit2/timeout", keep_all_debug=True).start().wait()
collect("q10", p)
tools = {}
for t, line in r.lines:
    try:
        o = json.loads(line)
    except Exception:
        continue
    for c in (o.get("message") or {}).get("content") or []:
        if not isinstance(c, dict):
            continue
        if c.get("type") == "tool_use":
            tools[c["id"]] = {"file": os.path.basename(c["input"].get("file_path", "")), "t_use_ms": t}
        if c.get("type") == "tool_result" and c.get("tool_use_id") in tools:
            txt = c.get("content")
            txt = txt if isinstance(txt, str) else json.dumps(txt)
            tools[c["tool_use_id"]].update({"t_result_ms": t, "is_error": c.get("is_error"), "result": txt[:400]})
exists = {f: os.path.exists(os.path.join(p, f)) for f in FILES}
summary = {"rc": r.rc, "dur": r.dur, "result": r.result_text(), "init": init_info(r),
           "tool_calls": list(tools.values()), "files_exist_after": exists}
json.dump(summary, open(os.path.join(RAW, "q10__summary.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
