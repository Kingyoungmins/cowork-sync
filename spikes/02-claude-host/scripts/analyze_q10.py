"""q10 latency per Write, from the hooks' own timestamps + Claude Code's debug-log timestamps.
mcp_tool: debug 'mcp_tool calling' -> MCP server's own call time -> debug 'success' line.
command:  same hook-phase start -> node process start (t_start_ms - node uptime) -> debug 'Hook output does not start with {' (command done)."""
import json, os, re, datetime as dt
RAW = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "raw")
def ms(ts):
    return int(dt.datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
dbg = open(os.path.join(RAW, "q10.debug.filtered.log"), encoding="utf-8").read().splitlines()
mcp_calls = [json.loads(l) for l in open(os.path.join(RAW, "q10__mcp_calls.jsonl"))]
hooks = [json.loads(l) for l in open(os.path.join(RAW, "q10__q10_hook.jsonl")) if '"pre"' in l and '"start"' in l]
phases = []  # one per Write: index of 'mcp_tool calling' line
for i, l in enumerate(dbg):
    if "mcp_tool calling probe/hookprobe" in l:
        phases.append(i)
rows = []
for n, i in enumerate(phases):
    t0 = ms(dbg[i][:24])
    mcp_done = next(ms(dbg[j][:24]) for j in range(i, len(dbg)) if "PreToolUse) success" in dbg[j])
    cmd_done = next((ms(dbg[j][:24]), dbg[j][25:110]) for j in range(i + 1, len(dbg))
                    if "Hook output does not start with {" in dbg[j] or "Slow PreToolUse hooks" in dbg[j])
    h = hooks[n]
    rows.append({"file": h["file"], "mcp_tool_total_ms": mcp_done - t0, "mcp_server_saw_call_after_ms": mcp_calls[n]["t_ms"] - t0,
                 "command_process_created_after_ms": h["t_start_ms"] - h["node_uptime_at_start_ms"] - t0,
                 "command_total_ms": cmd_done[0] - t0, "command_done_marker": cmd_done[1].strip()})
json.dump(rows, open(os.path.join(RAW, "q10__latency.json"), "w"), indent=1)
for r in rows:
    print(r)
