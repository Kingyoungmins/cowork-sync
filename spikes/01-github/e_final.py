"""Final state check after (a)-(d): Actions run count, events feed (webhook proxy), workflows, refs. -> e_final.json"""
import json, os
from common import *
HERE = os.path.dirname(os.path.abspath(__file__))
R = {}
st, _, js = rest("GET", "/actions/runs?per_page=100")
R["actions_runs"] = [{k: r.get(k) for k in ("event", "head_branch", "head_sha", "status", "conclusion", "created_at")} for r in js["workflow_runs"]]
st, _, js = rest("GET", "/actions/workflows")
R["workflows"] = [{k: w.get(k) for k in ("name", "path", "state")} for w in js.get("workflows", [])]
st, h, ev = rest("GET", "/events?per_page=100")
R["events_types"] = {}
for e in ev:
    k = e["type"] + ":" + str((e.get("payload") or {}).get("ref"))
    R["events_types"][k] = R["events_types"].get(k, 0) + 1
R["events_with_refs_cowork_ref"] = sum(str((e.get("payload") or {}).get("ref") or "").startswith("refs/cowork") for e in ev)
R["events_total"] = len(ev)
refs = ls_remote(os.path.join(HERE, "work-a"))
R["remote_refs"] = sorted(refs)
R["ratelimit_remaining"] = h.get("x-ratelimit-remaining")
json.dump(R, open(os.path.join(HERE, "e_final.json"), "w"), indent=1); print(json.dumps(R, indent=1))
