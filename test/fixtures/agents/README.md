# Agent definitions (Plan 5 Task 4)

Agent definition files for the worktree refusal (06 §3.10, CCI-29, A4-12): `test/unit/claude.worktree.test.ts` and
`test/integration/loader.worktree.test.ts` copy them into a temp `<repo>/.claude/agents/`, `<home>/.claude/agents/` or an enabled
plugin's `<home>/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/`.

| File | Frontmatter `isolation` | Expected |
|---|---|---|
| `builder.md` | `worktree` | WORKTREE_DENY |
| `reviewer.md` | none (the word appears only in the body) | passes |
| `quoted.md` | `"worktree"` with a comment (the tests also write a CRLF copy: `.gitattributes` keeps fixtures LF) | WORKTREE_DENY |
| `shared.md` | `none` | passes |
