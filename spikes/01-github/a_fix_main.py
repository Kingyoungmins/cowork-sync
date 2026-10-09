"""Follow-up to (a): first run's plumbing wrote tree entry 'README.md\r' (Windows text-mode stdin).
Push a fast-forward commit on main with a correct README.md. Appends to a_caps.log."""
import os
from common import *
HERE = os.path.dirname(os.path.abspath(__file__)); W = os.path.join(HERE, "work-a")
log = Log(os.path.join(HERE, "a_caps.log"))
main0 = ls_remote(W, "refs/heads/main")["refs/heads/main"]
git(["fetch", "origin", "main"], cwd=W)
m1 = new_commit(W, [main0], "fix README filename (sandbox for cowork-sync experiments)",
                files={"README.md": "sandbox for cowork-sync experiments\n"})
rc, out, err, dt = push(W, ["origin", f"{m1}:refs/heads/main", f"--force-with-lease=refs/heads/main:{main0}"])
log("fix_main_readme", "rc=%d" % rc, "%.2fs" % dt, err.strip().replace("\n", " | "))
rc, ls, _, _ = git(["ls-tree", m1], cwd=W); log("main tree", repr(ls))
