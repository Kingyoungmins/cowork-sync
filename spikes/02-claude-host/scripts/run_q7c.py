"""q7c: same /probe, plus UserPromptExpansion and PreToolUse(Bash) recorders: which hooks fire, in which order vs the '!' line."""
import json, os
from runner import Run, SCRATCH, RAW, collect
p = os.path.join(SCRATCH, "q7probe2")
r = Run("q7c", p, "/probe", ["--max-turns", "2"], 120, "q7c: UserPromptExpansion + PreToolUse(Bash) vs ! line").start().wait()
collect("q7c", p)
order = [json.loads(l) for l in open(os.path.join(p, "out", "order.jsonl"))]
print(json.dumps({"rc": r.rc, "dur": r.dur, "result": r.result_text(), "order": order}, indent=1, ensure_ascii=False))
