# Spike 03: a pilot team's real clean/smudge secret filter under the spec's git operations

Date 2026-10-01. Machine: Windows 11 (10.0.26200), git 2.55.0.windows.3, Python 3.12.10.
Repo: fresh clone of a pilot team's private repository at a fixed commit, 4,353 tracked files, `core.autocrlf=true`.
Push from the clone was disabled (`remote set-url --push origin no-push`). `claude -p` runs used: 0. No GitHub writes, no rate-limit events.

**Names.** The repository, its files, the filter driver, the key file and the constant are shown under neutral placeholder names (`hub.py`, filter `secret`, `tools/secret_filter.py`, `tools/setup_secret_filter.py`, `secrets.local.json`, `DEFAULT_SECRET_URL`, `__SECRET_URL__`). `scripts/` uses the same placeholders. Only the names changed; every measurement below is as recorded.

**Secret handling.** The smudge side of the filter reads a URL from a gitignored local key file (`secrets.local.json`) in the clone root (`.gitignore:70`). I did **not** copy the real value. I wrote a **dummy** URL (99 characters, host `example.invalid`) into the clone's own key file. All checks report oids, lengths and booleans only. A grep of `raw/` for the dummy host found 0 matches.

## Questions

1. Round trip: does clean(smudge(blob)) equal the blob (same oid) for `hub.py` and 20 other files?
2. Idempotency: does clean(clean(x)) equal clean(x)?
3. With `filter.secret.required=true`, does `git add` succeed? With a broken driver, does `add` exit non-zero and leave the index unchanged? How does that compare with `required=false`?
4. Does a private-index snapshot (`GIT_INDEX_FILE=tmp`, `read-tree HEAD`, `add -A`, `write-tree`) equal `HEAD^{tree}` right after clone, and again after every file's mtime is touched?
5. How long do these operations take?
6. Does the filter work in the spec's DAEMON_ENV (`LC_ALL=C`, `LANGUAGE=`, minimal PATH)? Which PATH entries does it need?

## The filter (read from the repo)

- `.gitattributes`: `hub.py filter=secret`. This is the only filtered path.
- `tools/secret_filter.py` processes bytes. **clean** replaces the first `DEFAULT_SECRET_URL = "<value>"` with the placeholder `__SECRET_URL__`. **smudge** puts the value from the key file back, or leaves the placeholder if that file or key is missing. clean does not depend on the key file.
- `tools/setup_secret_filter.py` writes to `.git/config` only: `filter.secret.clean/smudge = "<absolute sys.executable>" tools/secret_filter.py clean|smudge` and **`filter.secret.required=true`**. It also installs a pre-commit hook and re-checks-out `hub.py` so smudge runs. The python path is absolute. **The script path is relative to the work tree root.**
- `hub.py` (a 1.3 MB Python source file): the HEAD blob is 1,277,726 bytes with a BOM, LF line endings and the placeholder (`i/lf w/crlf`). The smudged work-tree file is 1,304,247 bytes: BOM, 26,436 CRLF lines, dummy value.

## Method

Scripts are in `scripts/`. They ran from a copy in `<scratch>/s03/`, next to the clone; `common.py` takes that folder from `COWORK_SCRATCH_S03` (default: the scripts' own folder). Logs record oids, sizes, return codes, timings and redacted stderr only.

| Step | Script | What it does |
|---|---|---|
| setup | `00_setup.sh` | Clones the repo, disables push, writes the dummy key file, runs the pilot team's `setup_secret_filter.py` unchanged. |
| Q1/Q2 | `q12_roundtrip.py keys` and `nokeys` | Sample: `hub.py`, the single `i/none` file, 4 random `i/-text` files and 15 random `i/lf` files (seed 20261001). For each file: **Q1a** `hash-object --path=p --stdin < $(cat-file --filters HEAD:p)` equals the blob. **Q2a** `hash-object -w` of the smudged bytes, read it back, hash it again, same oid. **Q2b** `hash-object --path` of the raw blob equals the blob. **disk_eq** checks the work-tree file. **Q2d** runs the python clean twice directly on `hub.py`. The script also runs the spec's D4.1/D4.2 check literally. `nokeys` repeats everything with the key file moved away, so smudge does nothing. |
| D4 detail | `q1_d4_variants.sh` | The spec's D4 refresh check traced with `GIT_TRACE` in 4 variants: spec with `-q`, spec without `-q`, `-c attr.tree=HEAD`, and `.gitattributes` in the scratch index. |
| Q3 | `q3_required.py` | `touch hub.py` and then `git add` on the real index, for each combination of clean driver {team driver, nonexistent command, `sh -c 'exit 3'`, empty string, section really undefined} and `required` {true, false}. Records rc, whether the index fingerprint changed, whether the staged oid equals HEAD, and whether the staged blob contains the dummy secret. Each case is reset afterwards. Also runs `cat-file --filters` with a broken smudge. |
| Q4/Q5 | `q45_snapshot.py` | Private-index snapshot, 3 reps per cell. Variant `task`: read-tree, add -A, write-tree. Variant `engine` (01-engine l.498): read-tree, `update-index -q --refresh`, add -A, write-tree. Flags are either `spec` (`attr.tree=HEAD`, `filter.secret.required=true`, `core.fsmonitor=false`, `core.longpaths=true`, `gc.auto=0`) or `plain`. Phases are `fresh` and `touched` (mtime of all 4,354 files bumped). The script also times single-file operations (5 reps). |
| Q4b | `q4b_touch_on_stat_fresh.py` | Builds a stat-fresh private index, touches every file, then runs add -A and write-tree (3 reps). Also runs the real index's `status` and `add -A` after touching every file. |
| Q6 | `q6_env.py` | Runs smudge (`cat-file --filters`), clean (`hash-object --path`) and a full private snapshot under 7 environments. Each environment has the forced values `LC_ALL=C`, `LANGUAGE=`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `SSH_ASKPASS_REQUIRE=never`, `GIT_OPTIONAL_LOCKS=0`. Each runs with both `Git\cmd\git.exe` and `Git\mingw64\bin\git.exe`. Also covers a hypothetical bare-`python` driver, cwd set to a subdirectory, and a `GIT_TRACE` count of filter processes. |

## Raw data files (not published)

The run wrote these to `raw/`: `setup_output.log`, `env_and_setup_state.log`, `q12_roundtrip_keys.jsonl`, `q12_roundtrip_nokeys.jsonl`, `q1_d4_variants.log`, `q3_required.jsonl`, `q45_snapshot.jsonl`, `q4b_touch_on_stat_fresh.jsonl`, `q6_env.jsonl`. They were removed before publication because they held the pilot repository's file lists and machine-local paths. The names are kept so each citation below still names its source log; every number here was copied from those logs.

## Results

### Q1/Q2: round trip and idempotency (MEASURED: `raw/q12_roundtrip_keys.jsonl`, `raw/q12_roundtrip_nokeys.jsonl`)

| Check (21 files: hub.py + 20) | with dummy key | without key file |
|---|---|---|
| Q1a clean(smudge(B)) == B | 21/21 | 21/21 |
| Q2a clean(clean(x)) == clean(x) | 21/21 | 21/21 |
| Q2b clean(B) == B | 21/21 | 21/21 |
| work-tree file hashes to B (disk_eq) | 21/21 | 21/21 |
| smudge inserted the dummy (hub.py) | yes | no (placeholder kept) |
| python clean run twice on hub.py, same sha256 | yes | yes |

The sample's EOL classes: 1 `i/none` (empty `.gitkeep`), 4 `i/-text` (2 png, 2 xlsx, Korean filenames included) and 16 `i/lf w/crlf`. The repo has no `i/crlf` files and no symlink or gitlink entries, so the ENG-11 `i/crlf` misreport could not be exercised here.

### The spec's own D4 preflight check is broken (MEASURED: `raw/q1_d4_variants.log` and the `D4` field in `raw/q12_roundtrip_*.jsonl`)

D4.1/D4.2 put B in a scratch index with `--cacheinfo` and run `update-index -q --refresh` with `--work-tree=tmp/rt`. "needs update" means failure.

| Variant (work tree holds the smudged file = should pass) | rc | "needs update" printed | filter processes run |
|---|---|---|---|
| spec as written (`-q --refresh`) | 0 | no | **0** |
| spec without `-q` | 1 | yes | **0** |
| `-c attr.tree=HEAD` | 128 | n/a | 1, which **failed**: `can't open file ...\tmp\rt_keys\tools\secret_filter.py` |
| `.gitattributes` added to the scratch index | 128 | n/a (also flags `.gitattributes` itself) | 1, same failure |

There are three separate defects:

- **(a)** A scratch work tree has no `.gitattributes` and the scratch index has no `.gitattributes` entry, so git sees no `filter=` attribute and **never runs the filter**. The check compares raw bytes, which proves nothing about the driver.
- **(b)** `-q` suppresses the "needs update" line and still exits 0. Under the spec's literal command, even an obviously different file reports nothing.
- **(c)** When attributes are supplied, git runs the filter with **cwd = the given work tree**. The pilot team's driver uses a repo-relative script path (`tools/secret_filter.py`), so it fails in any throwaway work tree.

The check that does work here, and that the D4 checks above amount to, runs in the **real** work tree: `cat-file --filters HEAD:p`, then `hash-object --path=p --stdin`, compared with `hash-object --path=p --stdin < cat-file blob B`. Both sides go through the same conversion.

### Q3: `required` (MEASURED: `raw/q3_required.jsonl`; `touch` before every add)

| clean driver | required | `git add` rc | index oid changed | staged == HEAD blob | staged blob contains secret |
|---|---|---|---|---|---|
| team driver | true | 0 | no (stat refreshed only) | yes | no |
| team driver | false | 0 | no | yes | no |
| nonexistent command | **true** | **128** | **no** (index bytes identical) | yes | no |
| nonexistent command | false | **0** | **yes** | **no** | **YES** |
| `sh -c 'exit 3'` | true | 128 | no | yes | no |
| `sh -c 'exit 3'` | false | **0** | yes | no | **YES** |
| empty string | true | 128 | no | yes | no |
| empty string | false | **0, no stderr at all** | yes | no | **YES** |
| section undefined + `-c required=true` | true | 128 | no | yes | no |
| section undefined, no flag | (unset) | **0, no stderr** | yes | no | **YES** |
| smudge = nonexistent (`cat-file --filters`) | true | 128, no stdout | n/a | n/a | n/a |
| smudge = nonexistent | false | 0, outputs the unsmudged blob in work-tree form | n/a | n/a | n/a |

The "index changed" check compares the sha of `ls-files -s` and the sha of the raw `.git/index` bytes. In the failing `required=true` rows both are byte-identical. In the "team driver" rows only stat data changed and the oid stayed equal to HEAD. After the run the clone was clean again (`final_status` 0 lines) and the 3 config keys were restored.

### Q4: private-index snapshot (MEASURED: `raw/q45_snapshot.jsonl`, `raw/q4b_touch_on_stat_fresh.jsonl`)

| Phase / variant | trees == HEAD^{tree} (cold) | trees == HEAD^{tree} (second add -A) |
|---|---|---|
| fresh, task (read-tree, add -A, write-tree), spec flags | 3/3 | 3/3 |
| fresh, task, plain | 3/3 | 3/3 |
| fresh, engine (+`update-index -q --refresh`), spec / plain | 3/3, 3/3 | 3/3, 3/3 |
| touched, all 4 cells | 12/12 | 12/12 |
| stat-fresh private index, then touch all, then add -A | 3/3 | n/a |
| real index after touch all: `status --porcelain` lines / `add -A` staged changes | 0 / 0 | n/a |

There were no phantom paths. `read-tree` gave 4,353 entries every time, and the real `.git/index` was byte-identical before and after all private snapshots (`real_index_unchanged_by_private_snapshots: true`).

### Q5: timings, seconds (MEASURED: `raw/q45_snapshot.jsonl`, `raw/q4b_touch_on_stat_fresh.jsonl`, `raw/q6_env.jsonl`)

| Operation | median (n) |
|---|---|
| `add -A`, private index, cold (right after read-tree, every file re-hashed), spec flags | 0.591 (3); plain 0.581 |
| same, after touch all | 0.617 (3) |
| `update-index -q --refresh` on a cold private index (engine variant) | 0.575 (3); then `add -A` 0.018 |
| `add -A`, stat-fresh private index, nothing changed (warm) | 0.016 (24) |
| `add -A`, stat-fresh private index after touching all files | 0.618 (3) |
| real index `status` after touch all | 0.578 (1) |
| `add hub.py` alone, after touch (real index) | 0.077 (5) |
| `cat-file --filters HEAD:hub.py` | 0.070 (5) |
| `hash-object --path=hub.py` | 0.065 (5) |
| `git --version`, process overhead | 0.011 (5) |
| filter processes per cold `add -A` (GIT_TRACE) | **2** clean runs for hub.py, one to compare and one to stage |

One filter process (`sh.exe` + python) costs about 0.05 s. The cold rescan of 4,353 files is about 0.6 s regardless of the filter.

### Q6: DAEMON_ENV (MEASURED: `raw/q6_env.jsonl`)

Every row below ran with the forced values (`LC_ALL=C`, `LANGUAGE=` etc.). T1 is smudge (the dummy was inserted), T2 is clean (the oid equals the HEAD blob), T3 is the private snapshot (the tree equals HEAD).

| Environment | cmd\git.exe T1/T2/T3 | mingw64\bin\git.exe T1/T2/T3 |
|---|---|---|
| spec allowlist with the session PATH | ok/ok/ok | ok/ok/ok |
| `PATH=C:\Windows\System32;C:\Windows` + SystemRoot | ok/ok/ok | ok/ok/ok |
| same + `Git\usr\bin` | ok/ok/ok | ok/ok/ok |
| same + Python dir | ok/ok/ok | ok/ok/ok |
| `PATH=` (empty) + SystemRoot | ok/ok/ok | ok/ok/ok |
| no PATH at all + SystemRoot | ok/ok/ok | ok/ok/ok |
| System32 only, **no SystemRoot** | ok/ok/ok | ok/ok/ok |
| hypothetical driver `python tools/...` (bare), System32 PATH | **rc 128 (`python: command not found`)**, so add was refused (required=true) | n/a |
| same bare driver + Python dir on PATH | ok/ok/ok | n/a |
| cwd = `clone/docs` (subdirectory) | ok/ok/ok | n/a |

GIT_TRACE shows git starts filters as `'C:/Program Files/Git/usr/bin/sh.exe' -c '<driver>'`, an absolute path that git derives from its own install and not from PATH.

## Answers

| # | Question | Answer | Confidence |
|---|---|---|---|
| 1 | clean(smudge(B)) == B | **YES**, 21/21 files, with and without the key file | high (MEASURED) |
| 2 | clean(clean(x)) == clean(x) | **YES**, 21/21 via git and directly in python | high (MEASURED) |
| 3a | `required=true` with a working driver succeeds | **YES** (rc 0, staged == HEAD) | high (MEASURED) |
| 3b | broken driver + `required=true`: add fails, index unchanged | **YES**: rc 128 for all 4 breakages (missing command, exit 3, empty, undefined), index bytes identical | high (MEASURED) |
| 3c | the same breakages without `required=true` | **rc 0, and the unfiltered (secret-bearing) content is staged**. For an empty or undefined driver this happens with **no stderr at all** | high (MEASURED) |
| 4 | private snapshot tree == HEAD^{tree}, fresh and after touching all files | **YES**: 24/24 cold, 24/24 warm, 3/3 stat-fresh-then-touched; 0 phantom paths | high (MEASURED) |
| 5 | timings | cold or touched full `add -A` **≈0.6 s**; warm 0.016 s; single `add hub.py` 0.077 s; `cat-file --filters` 0.070 s | high for this PC (MEASURED); other PCs NOT MEASURED |
| 6 | filter works in DAEMON_ENV | **YES** with the pilot team's driver, even with an empty or missing PATH and no SystemRoot. It needs **no PATH entries**: python is absolute in the driver and git finds `sh.exe` from its own install. A driver written as bare `python` needs the Python dir on PATH. | high (MEASURED) for this git/python install; other installs NOT MEASURED |
| extra | spec D4 preflight (scratch index + `--work-tree=tmp/*` + `update-index -q --refresh`) detects a broken round trip | **NO**. It never runs the filter (no attributes), `-q` hides "needs update", and with attributes the pilot team's relative script path fails | high (MEASURED: `raw/q1_d4_variants.log`) |
| extra | the pilot team's setup script reports its smudge step correctly | **NO**. It printed a Korean message meaning "key not found in the key file, placeholder kept" although the smudge **did** restore the value (constant length 99). Its check `b"__SECRET_URL__" not in after` is always false because the token appears 3 times in the file. This is cosmetic for the pilot team, but nobody should trust that message. | high (MEASURED: `raw/setup_output.log`, `raw/env_and_setup_state.log`) |

## Implications for the spec

1. **03-data D4 (preflight steps 1–2) must be rewritten. As written it is vacuous.**
   - Run the round-trip and idempotency checks in the **real work tree's context**, so cwd is the real top-level and relative driver paths resolve: compare `hash-object --path=p --stdin` of `cat-file --filters [--path=p] B` with `hash-object --path=p --stdin` of `cat-file blob B`. This is a paired comparison and never a comparison with the stored blob, so it respects ENG-58's ban on comparing `hash-object --path` with a stored blob.
   - If a scratch work tree is kept, it must (i) pass `-c attr.tree=<EPOCH_BASE>`, (ii) not use `-q`, or judge by `diff-files`/rc instead, and (iii) be accepted as failing for drivers with repo-relative paths. Option (iii) would wrongly refuse the pilot team.
   - Also add a **positive control**: the preflight must assert, for example with `GIT_TRACE` or a canary byte change, that the driver actually ran. A check that never invokes the filter must not pass.
2. **Glossary §18 `-c filter.<d>.required=true`: keep it, and treat it as mandatory and load-bearing.** Without it, every breakage (driver missing in DAEMON_ENV, failing command, empty value, section absent) gives `add` rc 0 and stages the secret. Two of those four give no stderr at all. The pilot team's setup already sets `required=true` in `.git/config`, but a clone where setup was never run has no driver at all. Only the daemon's own `-c ...required=true` refuses such a clone (rc 128, verified). Discovery (D3) must therefore take driver names from **attributes**, not from config.
3. **Snapshot failure rule (03-data "Snapshot failure") is confirmed.** With `required=true`, a filter failure gives `add` rc 128 and leaves the index byte-identical, so "run no write-tree" is safe and nothing half-staged remains.
4. **09-security §3.4 DAEMON_ENV: no change needed for the pilot team.** The filter works with an empty PATH. Add a doctor hint for drivers that call bare `python`/`node` (`env.passthrough` of PATH, or an absolute interpreter path). git starts filters via its bundled `usr/bin/sh.exe` regardless of PATH.
5. **Perf budget (01-engine "54–60 ms per loop with a stat-fresh index vs 750–1000 ms reseeded").** Measured here: warm 16 ms and cold or reseeded ≈0.6 s on a 4,353-file repo with one 1.3 MB filtered file. A cold `add -A` runs the clean filter **twice** per changed filtered file (about 0.05 s each). Every reseed (join, lost state, pruned object) or mass-mtime event (branch switch, IDE reformat, AV touch) costs about 0.6 s. That is within budget. No change, but the 2-run cost should be noted where the per-filtered-file budget is set.
6. **EOL/BOM phantom-change risk for this repo: none observed.** BOM + `i/lf w/crlf` + `autocrlf=true` + the filter produced no phantom changes in 51 snapshot trees. The `i/crlf` case (ENG-11) is NOT MEASURED here: the repo has no such files. It needs a synthetic repo.

## Not measured

- Other machines, git versions, or Python installs (for example a venv or the WindowsApps `python3` stub as the driver): only this PC.
- The real secret value: never used, by design. The dummy has the same shape as the real constant line, `https://...sig=...` in double quotes.
- Robustness of the clean regex itself when someone reformats the constant line (single quotes, no spaces). This is out of scope and was not run.
- `i/crlf` files and symlink or gitlink entries: none in this repo.

## Cleanup state

- The scratch clone stays at `<scratch>/s03/clone`, push URL `no-push`, with the dummy key file. Nothing was pushed or committed anywhere.
- Objects written by `hash-object -w` are loose objects in the scratch clone only.
- No background processes were left running.
