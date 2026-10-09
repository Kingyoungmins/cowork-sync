"""Creates the throwaway project folders under cowork-sync-scratch/s02/ (project-level config only)."""
import os, json, shutil
from runner import SCRATCH, write_json

S = os.path.dirname(os.path.abspath(__file__)).replace("\\", "/")  # <repo>/spikes/02-claude-host/scripts


def node(script, *args):
    return " ".join([f'node "{S}/{script}"'] + [f'"{a}"' if " " in a else a for a in args])


def project(name, settings, mcp=None, files=None):
    p = os.path.join(SCRATCH, name)
    if os.path.exists(p):
        shutil.rmtree(p)
    os.makedirs(os.path.join(p, "out"))
    write_json(os.path.join(p, ".claude", "settings.json"), settings)
    if mcp:
        write_json(os.path.join(p, ".mcp.json"), mcp)
    for rel, text in (files or {}).items():
        fp = os.path.join(p, rel)
        os.makedirs(os.path.dirname(fp), exist_ok=True)
        with open(fp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    return p


def cmd(command, timeout=10):
    return {"type": "command", "command": command, "timeout": timeout}


def main():
    flag = os.path.join(SCRATCH, "flag_settings_accept.json")
    write_json(flag, {"crossSessionInbound": "accept"})

    # q3 / q3idle: inbox socket
    project("q3inbox", {"hooks": {
        "SessionStart": [{"hooks": [cmd(node("hook_env.js", "sessionstart", "--token-out"))]}],
        "UserPromptSubmit": [{"hooks": [cmd(node("hook_env.js", "userpromptsubmit", "--token-out"))]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [cmd(node("hook_env.js", "pretooluse_bash", "--token-out"))]}],
    }}, files={"wait.js": open(os.path.join(S, "wait.js")).read()})

    # q4: MCP env inheritance
    q4 = os.path.join(SCRATCH, "q4mcp")
    project("q4mcp", {"enableAllProjectMcpServers": True, "hooks": {
        "SessionStart": [{"hooks": [cmd(node("hook_env.js", "sessionstart"))]}]}},
        mcp={"mcpServers": {"probe": {"command": "node", "args": [f"{S}/mcp_probe.js", q4.replace("\\", "/") + "/out"]}}})

    # q5: detached daemon survival
    project("q5daemon", {"hooks": {"SessionStart": [{"hooks": [cmd(node("spawn_daemon.js"))]}]}})

    # q7: UserPromptSubmit vs '!' preprocessing
    q7out = os.path.join(SCRATCH, "q7probe", "out").replace("\\", "/")
    project("q7probe", {"hooks": {"UserPromptSubmit": [{"hooks": [cmd(node("ups_q7.js"))]}]}},
            files={".claude/commands/probe.md":
                   "---\ndescription: probe ordering\nallowed-tools: Bash(node:*)\n---\n"
                   f"Bang output: !`node \"{S}/bang_q7.js\" \"{q7out}\"`\n\nReply with just: PROBE-OK\n"})

    # q7c: same command, plus UserPromptExpansion and PreToolUse(Bash) recorders
    q7c_out = os.path.join(SCRATCH, "q7probe2", "out").replace("\\", "/")
    project("q7probe2", {"hooks": {
        "UserPromptSubmit": [{"hooks": [cmd(node("hook_rec.js", "UserPromptSubmit"))]}],
        "UserPromptExpansion": [{"hooks": [cmd(node("hook_rec.js", "UserPromptExpansion"))]}],
        "PreToolUse": [{"matcher": "Bash", "hooks": [cmd(node("hook_rec.js", "PreToolUse_Bash"))]}]}},
            files={".claude/commands/probe.md":
                   "---\ndescription: probe ordering\nallowed-tools: Bash(node:*)\n---\n"
                   f"Bang output: !`node \"{S}/bang_q7.js\" \"{q7c_out}\"`\n\nReply with just: PROBE-OK\n"})

    # q10: hook types / failure modes
    q10 = os.path.join(SCRATCH, "q10hooks")
    project("q10hooks", {"enableAllProjectMcpServers": True, "hooks": {
        "PreToolUse": [{"matcher": "Write", "hooks": [
            cmd(node("hook_q10.js", "pre"), timeout=3),
            {"type": "mcp_tool", "server": "probe", "tool": "hookprobe",
             "input": {"file": "${tool_input.file_path}"}, "timeout": 10}]}],
        "PostToolUse": [{"matcher": "Write", "hooks": [cmd(node("hook_q10.js", "post"))]}],
    }}, mcp={"mcpServers": {"probe": {"command": "node", "args": [f"{S}/mcp_probe.js", q10.replace("\\", "/") + "/out"]}}})

    # q-edit: edit staleness
    project("qedit", {"hooks": {"PostToolUse": [{"matcher": "Read", "hooks": [cmd(node("mutate_qedit.js"))]}]}},
            files={"f.txt": "ALPHA-ORIGINAL\nline two\nline three\nline four\nline five\nZULU-TAIL\n"})
    print("ok")


if __name__ == "__main__":
    main()
