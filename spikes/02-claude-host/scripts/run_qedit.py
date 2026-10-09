"""q-edit: Claude Reads f.txt; a PostToolUse(Read) hook (external process) rewrites a DIFFERENT line 1.2 s later;
Claude then Edits the original line without re-reading. Record whether the Edit applied + exact tool_result text."""
import json, os
from runner import Run, SCRATCH, RAW, collect
p = os.path.join(SCRATCH, "qedit")
PROMPT = ("Read f.txt. Then, without reading it again, use the Edit tool once to replace ALPHA-ORIGINAL with "
          "ALPHA-EDITED. If the Edit fails, do not retry and do not read again; just quote the exact error text.")
r = Run("qedit", p, PROMPT, ["--max-turns", "4", "--allowedTools", "Read,Edit", "--permission-mode", "acceptEdits"], 180,
        "q-edit staleness after external modification", keep_all_debug=True).start().wait()
collect("qedit", p)
calls = []
for t, line in r.lines:
    try:
        o = json.loads(line)
    except Exception:
        continue
    for c in (o.get("message") or {}).get("content") or []:
        if isinstance(c, dict) and c.get("type") == "tool_use":
            calls.append({"t_ms": t, "tool": c["name"], "input": c["input"]})
        if isinstance(c, dict) and c.get("type") == "tool_result":
            txt = c.get("content"); txt = txt if isinstance(txt, str) else json.dumps(txt)
            calls.append({"t_ms": t, "tool_result": txt, "is_error": c.get("is_error")})
summary = {"rc": r.rc, "dur": r.dur, "result": r.result_text(), "calls": calls,
           "final_file": open(os.path.join(p, "f.txt"), encoding="utf-8").read()}
json.dump(summary, open(os.path.join(RAW, "qedit__summary.json"), "w"), indent=1)
print(json.dumps(summary, indent=1, ensure_ascii=False))
