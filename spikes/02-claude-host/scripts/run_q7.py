"""q7: for `claude -p "/probe"`, does UserPromptSubmit fire, with what text, and before or after the '!' line?"""
import json, os
from runner import Run, SCRATCH, RAW, collect
p = os.path.join(SCRATCH, "q7probe")
r = Run("q7b", p, "/probe", ["--max-turns", "2"], 120, "q7b rerun: bang sleeps 1.5 s to disambiguate order", keep_all_debug=True).start().wait()
collect("q7b", p)
order = [json.loads(l) for l in open(os.path.join(p, "out", "order.jsonl"))] if os.path.exists(os.path.join(p, "out", "order.jsonl")) else []
print(json.dumps({"rc": r.rc, "dur": r.dur, "result": r.result_text(), "order": order}, indent=1, ensure_ascii=False))
