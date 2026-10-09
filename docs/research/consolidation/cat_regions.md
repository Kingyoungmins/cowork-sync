# regions — This subsystem turns bytes into regions and regions into verdicts. It never turns a region back into bytes. It is a set of pure, deterministic functions that the daemon, the hooks, the board fold and other groups call:
- a REGION TABLE per blob OID, built by one pinned web-tree-sitter WASM parser with our own per-language queries and one extent convention;
- ONE bundled LINE MAPPER that moves 1-based line ranges between any two versions of a file, in stored or working form;
- ONE TOUCH predicate that decides whether a local hunk lies in a foreign claim;
- claim ops anchored to a live commit as stored-form LINE ranges, never as names, ordinals, hashes or byte offsets;
- a post-merge identity check and relative region tripwires, used by T0 and by the concat fast path;
- the signature classifier and the caller/callee lookup that feed T0's interface check.

Every output is a verdict: ranges, labels, booleans or CS ids. LCM-12 removed the splice operator, per-hunk withdrawal and symbol-range text extraction, and this catalog forbids bringing them back.

Principles applied throughout:
- P3: one parser, one mapper, one touch predicate, one claim shape.
- P1: no region logic can produce or drop a byte.
- P2: every uncertain case degrades to a larger claim or to the conflict path, never to 'no conflict'.
- P4: unsupported files get whole-file or block claims instead of clever handling.
- P5: no clocks anywhere in region identity or in the fold.
- P6: rules cite the sweep/region harness and the new rc_* experiments under sweep/region/wts.

## v1 in scope
- Symbol-level region tables for Python, JavaScript, TypeScript/TSX and C#, built from pinned web-tree-sitter 0.27.x WASM grammars and our own query files. Upstream tags.scm misses C# constructors, properties, structs and records (research/region-detect.md section 1).
- Region units. Python: module-level def/class; methods (nested classes recurse); module-level assignments (const:NAME); class residue as one multi-range unit. JS/TS: function, class and method declarations; const/let/var bound to an arrow function, function or class; object-literal methods of top-level objects; IIFE/UMD wrappers descended into; get/set accessors as distinct units. C#: types (as residue), methods, constructors, destructors, properties, indexers, events, fields and operators, with each overload its own unit. Nested functions, lambdas, callbacks and local functions fold into their named ancestor.
- Extent convention v1: the node including its decorators or attributes, plus directly attached leading comment lines (no blank line between). TS overload signatures belong to the implementation. The extent ends at the last row of the node.
- Line-tracked claims: an anchor commit plus stored-form 1-based inclusive line ranges, mapped in either direction by the bundled Myers mapper with EOL/BOM-insensitive line equality. Ranges the holder deleted become tombstones. Claims on new or moved units are emitted at the publication that first contains them.
- Claim granularity: the innermost unit, whole by default at any length; sub-block claims for very long units only as an opt-in setting pending sign-off. Top-level gap statements: their blank-line block. Markdown: ATX heading sections. Other text files over 300 lines: blank-line blocks (raw-byte split for non-UTF-8 text). Files of 300 lines or fewer without a grammar: whole file.
- Whole-file-only claims for binary, symlink, notebook (.ipynb), filter=-attributed and working-tree-encoding-attributed paths, and for any blob containing conflict markers.
- One TOUCH predicate with three cases: base-line overlap, insertion strictly inside, and boundary insertion decided by the post-image extent. Used by PreToolUse prediction, the B1 publish gate, the board fold (range part only) and holder-side breach detection.
- Group-name rule for C# and TS overloads: adding a member with the same simple name as a held member is an additional conflict. For C# partial types this includes other partial declarations, found by git grep on the private index.
- Pre-merge gate in A coordinates. It returns blocked CS ids (consumed by LCM-12) and is recomputed after every CAS reject.
- Post-merge identity check on every path that both sides changed, claimed or not.
- Relative region tripwires (ERROR/MISSING count, label counts, UTF-8 validity) for T0 and the concat fast path.
- Interface classifier (compatible / breaking / note) on the net per-CS signature delta, for Python, JS/TS, C# and JSON config key paths. On the merged tree it checks callers of breaking changes and callees of calls the CS added or changed. Rename aliases serve only as display and caller-check metadata.
- PreToolUse prediction from memory: normalized locate, then line numbers, then A coordinates. PostToolUse post-diff is authoritative. Also covers the moved-code check, and a regex fallback region when no region table is cached.
- Possible-fork note when a CS copies a foreign-held unit under a new name. Delivered pull-only, to the author only.

## v1 refuse/defer
- Splice operator, per-hunk or per-symbol withdrawal from a file, and symbol text copied into a blob or onto the board: REMOVED, not deferred (LCM-12). Corruption is VERIFIED in S2, S3, S4, S5, S6, S8, S9, x3b and X4b. Any later proposal to bring one back needs a new design review.
- Languages without a pinned grammar (Java, Go, Rust, C/C++, Kotlin, PHP, ...). v1: refuse symbol regions and use block or whole-file claims. v2: add grammars and queries; each addition changes regionSpec.
- Type-aware caller resolution (LSP find-references, receiver types): v2. v1 resolves callers by name, import and same-type rules. A 'possible' hit (a method call on an unknown receiver) never holds a CS; it only produces a note. T1 at checkpoints and save catches the compiled-language breaks these rules miss (LCM-14).
- C# partial-type overload collisions across files that the private-index git grep cannot find (generated partials outside the repo, source generators). v1: caught only by the T1 build (CS0111). v2: a compiler-backed index.
- YAML config-key rename detection: v2, because the zero-dependency bundle has no YAML parser. v1 detects only JSON key-path removals and renames.
- Notebook cell-level claims: v1 whole-file; v2 cell-level by cell id.
- Symbol regions for blobs that are not valid UTF-8 (cp949 sources). v1: refuse symbol regions and use blank-line blocks split on raw bytes, with no decoding. v2: decode via working-tree-encoding or charset detection.
- Human soft claims (claims taken by unattributed human edits): not in v1, because the binding claim lifecycle has no human holder. A human hunk inside a foreign claim is PIN-held via LCM-12 and flagged claim-breach. A human stale buffer reverting Claude's work is handled by LCM-5's revert detector.
- Format-only hunk exemption and team formatter fingerprints: not in v1. Format-only hunks are ordinary hunks, and one inside a foreign claim holds its CS like any other (P3). Prevention is the advisory Bash formatter deny (claude-integration).
- Claims below the blank-line block (statement or expression level): v2.
- provenance-rule-blind-to-withdrawal-deferral-save: owned by local-change-mgmt. LCM-11/12/16/17 remove the knowingly published splits this finding depends on. This subsystem only supplies caller/callee lists (REG-16) for any expected-error notice.
- Patch-bound go-first grants keyed by a hash of symbol text: not used. Grants and requests are keyed by claim id (REG-19, protocol rule 11).

## interfaces
- regionTable(blobOid | diskSnapshotId, path) -> {grammar, regionSpec, decodable, units:[{unitId, kind, label:{kind, qualname, simple, type, disc}, ranges:[[lo,hi],...], parentUnitId, sigSlice}], errorSpans:[[lo,hi],...], errorCount, labelCounts:{labelKey:n}}. Cached by blob OID; computed only in the worker_threads pool.
- hunks(fromBlob|lines, toBlob|lines) -> [{aStart, aLen, bStart, bLen}]. Starts are 0-based. Uses the bundled Myers mapper with EOL/BOM-insensitive line equality, never git diff output.
- mapRanges(fromBlob, toBlob, ranges, mode: fold|local) -> ranges | TOMBSTONE | WHOLE_FILE. WHOLE_FILE when D > 5,000 (both modes), or when a mapping takes > 200 ms (local mode only).
- touch(hunk, claimRangesInA, postImageRef) -> {touch: bool, reason: base-overlap | insert-inside | boundary-in-extent | boundary-in-error | group-name | degraded-whole-file | none}.
- computeClaims(seatId, path, localHunks(disk coords), A[p], anchorCommit) -> claim op list; reanchorClaims(seatId, path, oldAnchor, newAnchor) -> claim ops; emitLocalOnlyClaims(seatId, publishedLiveCode) -> claim ops for new or moved units.
- gate(A, S_disk, csAttribution, foldState(leasedBoardTip)) -> {blocked:[{cs_id, claim_id, holder, path, reason}]}. Consumed by LCM-12 (PIN) and by the U6 notices. It never returns hunks to remove.
- identityCheck(A, S_pub, OUT) -> [path], the paths to route to the data-handling conflict function.
- regionTripwire(TIP[p], S_pub[p] | LOCAL[p], output[p]) -> [violation]. Used by LCM-14 T0 and by the insertion-concat tripwire.
- interfaceCheck(A, S_pub, OUT, cs) -> {breaking:[{label, kind, old, new}], incompatibleCallers:[{path, line, label}], orphanCalls:[{path, line, callee}], notes:[...]}. Consumed by LCM-14 T0 and by the LCM-13 dependency hold.
- predict(seatId, tool_name, tool_input, diskBytes(fs read), lastReadSnapshot) -> {lines:[[lo,hi]] in disk rows, hunksInA, touches, movedFrom?, fallbackUsed}. Answers from memory only.
- Hook -> daemon payload for edit prediction and confirmation: {seat_id, tool_use_id, path (repo-relative POSIX NFC), matched disk line ranges (1-based), replace_all, pre_image_blob_oid (captured under the fence)}. No byte, char or UTF-16 offsets.
- Board op claim fields: {claim_id, path, anchor (= live_code of the carrying board commit; explicit commit oid), base_blob (anchor:path), ranges:[[lo,hi],...] (stored-form 1-based inclusive), tombstones:[{anchor, ranges}], granularity: symbol|subblock|block|file, label{kind, qualname, simple, type, disc} (display and the group-name rule only), regionSpec, cs_id, holder{peer, seat, agent}}. No code text, and no byte range used for matching.
- Board ops join and seat_start carry regionSpec = sha256 over the grammar .wasm hashes, query file hashes, extent-convention version, label-convention version and mapper version.
- Consumes: the A[p], S_disk, S_pub, TIP and OUT trees (engine); CS attribution (LCM-10); the fold state at the leased board tip (protocol); EPOCH_BASE attributes via -c attr.tree (data-handling).

## rules
- **REG-01** COORDINATES. The only region coordinates that cross a component boundary MUST be (blob OID or disk-snapshot id, repo-relative POSIX NFC path, 1-based inclusive line ranges). Boundaries are hook <-> daemon IPC, daemon <-> board, and the region module <-> any other module. Lines are split on byte 0x0A only, never on U+2028/2029 and never with splitlines. Tree-sitter results MUST be read only through startPosition.row and endPosition.row. startIndex, endIndex and any byte, char or UTF-16 offset MUST NOT be used outside one line-table helper that converts rows of a single in-memory Buffer; a CI lint fails the build on any other use. BOM stripping, CRLF->LF and folding of U+2018/2019/201C/201D quotes are allowed only to locate old_string, and the result MUST be converted to line numbers immediately. None of these normalizations changes the 0x0A count. Text decoding is read-only (TextDecoder {fatal:true, ignoreBOM:true}); the region module never encodes text back to bytes. [P3, P6]  _(covers: offset-units-form-drift, edit-normalization-breaks-symbol-mapping, daemon-text-handling-corrupts-cp949-bom)_
- **REG-02** NO REGION-SCOPED BYTES. Components MUST NOT produce blob bytes, working-file bytes or board content from a region or a line range. That rules out splicing 'published symbol text', subtracting hunks by symbol range, and copying symbol text into a record. Region functions return verdicts only: ranges, labels, booleans and CS ids. Bytes enter blobs only through the private-index add, hash-object --path, or the git merge machinery owned by other groups. The board carries only OIDs and line ranges. A CI lint ensures the region module imports no fs write API and no git command that writes objects or refs. The board schema has no code-text field at all; the only free-text fields are REQUEST.reason and NOTE.text (<= 280 chars, secret-scanned per the messaging-security rule). [P1, P3]  _(covers: splice-text-from-worktree-leaks-secret, splice-source-stale-board-text, move-splice-duplicates, csharp-overload-group-splice, ordinal-shift-duplicates-holder-code, toplevel-after-x-coalesce-loss, subblock-anchor-drift, intra-file-withdrawal-mangles-file, hunk-withdrawal-publishes-signature-without-callers, board-plaintext-and-permanence)_
- **REG-03** ONE PARSER, ONE REGIONSPEC. Region tables MUST come from the bundled web-tree-sitter 0.27.x runtime, the bundled grammar .wasm files (python, javascript, typescript, tsx, c_sharp) and cowork's own query files. These are copied to CLAUDE_PLUGIN_DATA/runtime/<version>/ and loaded eagerly. No second parser (Python ast, ctags, regex) may supply ranges. The regex fallback (REG-17) serves PreToolUse prediction only, and its output is never published. regionSpec = sha256 over the grammar .wasm hashes, query file hashes, extent-convention version, label-convention version and mapper version. It is published in join and seat_start ops and carried by every claim op. A reader whose regionSpec differs from a claim's MUST treat that claim as a whole-file claim on its path (touch reason 'degraded-whole-file'), and status MUST show 'region rules differ from <peer>; update cowork-sync'. The board fold never uses regionSpec (REG-20). [P3, P4]  _(covers: extent-convention-mismatch, version-skew-board-and-guards)_
- **REG-04** REGION TABLE. For each blob OID of a path with a pinned grammar that decodes as UTF-8, the daemon MUST compute the unit list defined in v1_in_scope. It runs in a worker thread and is cached by OID. Extent: start at the decorated_definition, the first attribute_list or the leading TS overload signature, then extend upward over contiguous comment lines with no blank line between. End at the node's last row (end row - 1 when endPosition.column == 0). Each unit carries:
- a label: (kind, qualname, simple name, enclosing type, discriminator), where the discriminator is get, set, setter, deleter, overload or branch ordinal;
- a signature slice (REG-15);
- its ranges (class/type residue is multi-range).
The table also records every ERROR/MISSING span, their count, and per-label counts. Labels serve only as display text, for duplicate accounting (REG-14) and for the additive group-name test (REG-09). A label MUST NOT be used to find, match or clear a claim. VERIFIED rc_touch.mjs R1: 432 units, with identical rows and labels for the BOM+CRLF working bytes (big_wt.py) and the LF stored bytes (big_lf.py). VERIFIED R2: the decorator-only edit on handler touches, and so does a decorator inserted under the attached comment. [P3, P6]  _(covers: extent-convention-mismatch, offset-units-form-drift)_
- **REG-05** ONE LINE MAPPER. All region hunk computation and all range mapping MUST use one bundled deterministic Myers line diff with common prefix/suffix trimming. Its line equality ignores one trailing \r and a leading U+FEFF on line 1.
The image of [lo,hi] from X to Y is:
- the images of unchanged lines in [lo,hi];
- the whole replacement block of any hunk whose deleted lines intersect [lo,hi];
- any pure insertion strictly inside (lo <= after < hi).
An insertion at after == hi or after == lo-1 is not included; REG-07 decides boundary insertions. A range whose lines are all deleted maps to TOMBSTONE.
Caps: if the edit distance D exceeds 5,000 lines, the result is WHOLE_FILE everywhere. D is the unique minimal edit distance, so this cap is deterministic across peers. A wall-time cap (one mapping > 200 ms -> WHOLE_FILE) is allowed ONLY in local decision paths: REG-17 prediction, the REG-12 gate and the REG-13 identity check. It MUST NOT be used by the fold (REG-20), because a time cap differs between machines.
git diff output MUST NOT feed claim mapping, the fold or the touch test. The mapper version is part of the board protocol (a change bumps proto and minWriter), because the fold depends on it.
VERIFIED:
- fwd_results.json: exact mapping in 4/4 insertion variants, including the same-tail case.
- rc_touch R1: 0 hunks between the BOM+CRLF and LF forms with this equality, against 5,960/5,960 lines changed under exact equality.
- R3: 1.3 ms at D=60 and 30-37 ms at D=2,000 on 5,960 lines.
- git (fwd.py) placed the same 9-line same-tail insertion after line 5339; the bundled Myers placed it after 5341. Both mappings were exact, but they differ, so two diff engines must never both feed claim decisions. [P3, P5, P6]  _(covers: ordinal-shift-duplicates-holder-code, subblock-anchor-drift, toplevel-after-x-coalesce-loss, rename-claim-bypass-generation-mismatch, eol-bom-stored-form-flip, eol-renormalization-whole-file-conflict, transform-holds-as-hunks)_
- **REG-06** CLAIM SHAPE AND ANCHORING. A claim op MUST carry {claim_id, path, anchor commit, base_blob = anchor:path, ranges, tombstones, granularity, label, regionSpec, cs_id, holder} and nothing else about code. anchor = live_code(the board commit that carries the op), so code and claim form one CAS unit (protocol D).

Computing ranges: the holder maps local hunk lines (disk rows) to A[p] with REG-05, then to the anchor blob with REG-05, then takes the REG-08 claim units in the anchor blob's region table.

New and moved units: a confirmed claim on a unit absent from TIP is LOCAL-ONLY until publication. This covers a brand-new unit and the new location of a moved unit. Until then it blocks only this daemon's other seats. It MUST be emitted as a claim op in the board commit whose live_code first contains the unit, with anchor = that commit and ranges = the unit's extent in that blob. A move, in the same file or across files, therefore publishes the new-location claim and the old-location tombstone in the same op batch, so no published copy is ever unclaimed.

Re-anchoring: whenever the holder's own push changes a path, the holder MUST re-anchor each of its held claims on that path to the new anchor (image via REG-05, snapped to the same units' extents in the new table). Drift is therefore bounded by one holder push.

Tombstones: a claimed range all of whose lines the holder's own CS deleted (delete or move-away) MUST NOT be re-anchored. It stays a tombstone at its last anchor until the holder releases the claim or a save includes the deletion. A peer whose base still has those lines is therefore still blocked there.

Readers map every claim from its anchor (or tombstone anchor) to their A[p] with REG-05. A claim is never looked up by name, so a rename, a same-name insertion above, a deleted neighbour or a lagging board cannot detach it. VERIFIED: the line-tracked variants were byte-correct in S1, S3 (py, js), S4, S6a and S9 (results_all.json line_tracked entries). [P1, P3, P5]  _(covers: rename-claim-bypass-generation-mismatch, false-alias-on-insert-at-offset, ordinal-shift-duplicates-holder-code, toplevel-after-x-coalesce-loss, move-splice-duplicates, non-atomic-pair-and-fence, version-skew-board-and-guards)_
- **REG-07** ONE TOUCH PREDICATE. Exactly one function MUST decide whether a local hunk h of diff(A[p], post[p]) lies in a claim c, with c mapped into A[p] coordinates as [lo,hi] by REG-05:
(1) h deletes or modifies any base line in [lo,hi]: touch.
(2) h is a pure insertion after base line k with lo <= k < hi: touch.
(3) h is a pure insertion with k == hi or k == lo-1: touch iff any of these holds:
  - the inserted post-image lines lie inside the post-image extent of the innermost unit containing c's image (for block and section claims: inside the blank-line block or heading section containing c's image);
  - an ERROR/MISSING span of the post-image covers any inserted line;
  - the post-image has no region table.
(4) A REG-09 group-name hit: touch.
(5) A claim degraded by REG-03: touch on any hunk of the path.
Otherwise: no touch.
The predicate takes no input from the hold registry, from the caller's own claims, or from labels except in (4). Claims never exempt anything (LCM-4).
Callers:
- PreToolUse prediction (G1);
- the B1 publish gate (REG-12);
- holder-side breach detection: an incoming hunk of diff(A, TIP) from a CS that is not the holder's and that touches the holder's claim raises the data-handling 'claim-breach' case;
- LCM-13's denied-symbol dependency scan.
A touch verdict is consumed per change-set: one touching hunk blocks every CS the hunk is attributed to.
VERIFIED rc_touch.mjs R2, 15 scenarios, all as expected:
- Appending a statement after the last line of compute_total's body touches only through case (3) (post extent 5331-5340).
- No touch: a new def and a same-tail def inserted after it; @overload stubs above it (blank-line separated); a JS getter above a held setter; a new method after a held setter; an edit in sibling parse.
- Touch: a decorator added under the attached comment; a decorator-only edit on handler; an attached comment line added above; a statement appended to a held setter body; a half-typed boundary insertion (ERROR). [P2, P3, P6]  _(covers: race-loser-hunk-lands, a-race-window-overlap-leaks-code, extent-convention-mismatch, ordinal-shift-duplicates-holder-code, human-claim-breach-and-claude-tramples-human, claim-launders-held-revert, formatter-whole-file-rewrites, e-formatter-and-write-livelock)_
- **REG-08** CLAIM GRANULARITY. The claim for touched lines MUST be:
(a) the innermost unit containing them, with nested defs, lambdas, callbacks and local functions folded into their named ancestor;
(b) for lines in class/type residue, the residue ranges only, never the members;
(c) for an edit spanning several units, each touched unit, never the parent wholesale;
(d) by default the whole unit, whatever its length (U4 function-level). Sub-block claims are an opt-in per-repo setting (.cowork/config.json claims.subBlockOverLines, default off, NEEDS USER SIGN-OFF). When enabled, a unit longer than that many lines (suggested 300) is claimed by the blank-line-delimited block(s) of the anchor blob that contain the touched lines, plus the unit's signature rows as a separate range when they are touched. Blocks are fixed at claim time and then line-tracked by REG-05; they are never recomputed from blank lines on other peers and never identified by ordinal or hash;
(e) for top-level statements outside any unit, their blank-line-delimited block;
(f) never the <imports> block (REG-10);
(g) Markdown: the ATX heading section (^#{1,6} through the line before the next heading of the same or higher level). Other text without a grammar: the blank-line block if the file has more than 300 lines (non-UTF-8 text is split on raw 0x0A bytes), otherwise the whole file;
(h) the whole file for binary paths (NUL in the first 8,000 bytes, or a -text/binary attribute at EPOCH_BASE), symlinks, .ipynb files, paths with a filter= or working-tree-encoding attribute, and any blob with conflict-marker lines;
(i) for a Write or any whole-file rewrite, exactly the units its REG-05 diff touches. There is no '>50% changed' whole-file threshold, and EOL/BOM-only differences produce no hunks under REG-05.
Ordinals (#n), neighbour names (after=X) and content hashes are never claim identity. [P3, P4]  _(covers: subblock-anchor-drift, toplevel-after-x-coalesce-loss, splice-text-from-worktree-leaks-secret, formatter-whole-file-rewrites, e-formatter-and-write-livelock)_
- **REG-09** GROUP-NAME ADDITION (labels may add a conflict, never clear one). This rule applies to C# (methods, constructors, operators, indexers) and to TypeScript function overload sets. A local CS that ADDS a member whose (enclosing type qualname, simple name) equals that of a member covered by a foreign claim MUST touch that claim, even when no range overlaps. The risk is overload resolution and CS0111.
For C# partial types, the type's other partial declarations MUST be found with `git grep -z -n -E 'partial[[:space:]]+(class|struct|record|interface)[[:space:]]+<Name>\b' --cached` on the private index, under LC_ALL=C, with a 100 ms budget. If the grep fails or times out, a claim on any member of that partial type touches every hunk in every file that declares a partial part of it.
The rule does NOT apply to Python or JavaScript: @overload stubs and a getter added beside a held setter raise no conflict (S3 expectation; rc_touch R2). A merged duplicate is still caught by REG-14(b).
VERIFIED rc_touch R2 cs_new_overload_not_adjacent_to_held: the range test said 'disjoint', the group-name rule hit Calc@30, and the result was touch. See also results_all.json S6. [P2, P6]  _(covers: csharp-overload-group-splice)_
- **REG-10** IMPORTS AND SHARED INSERTION POINTS ARE NOT CLAIM UNITS. The <imports> pseudo-region MUST never be claimed and never block. It is the contiguous import/from/using/require/export-from block at the top of a file, including comments and blank lines inside it. A pure insertion outside every unit's post-image extent claims only the new unit, and only once published. Examples: between units, at end of file, at the end of a class after its last member. Concurrent changes at these points are textual matters. Clean merges pass. Conflicts go to the data-handling insertion-concat fast path or to the general conflict function. T0 checks the result (REG-14, REG-16). Two claims that touch without overlapping are never an overlap. VERIFIED e7/e7b: adjacent lines and shared insertion points conflict textually without any claim overlap. VERIFIED DH6: the ordered concat parses where --union fails. [P3]  _(covers: disjoint-claims-textual-conflict, d-shared-insertion-point-collisions)_
- **REG-11** ERROR TREES.
(a) A new claim range or label MUST NOT be derived from a tree whose ERROR/MISSING spans cover the touched lines. The claim MUST instead use the path's LAST-GOOD region table, mapped forward with REG-05. The last-good table is the newest cached blob of that path whose covering top-level unit has no ERROR/MISSING. If the touched lines map to no last-good unit, the claim is the span strictly between the nearest last-good units above and below. With no last-good table, the claim is the whole file.
(b) Existing claims MUST NOT be re-derived from an erroring tree. They keep mapping by REG-05, which needs no parse.
(c) REG-07 case (3) answers 'touch' when an ERROR/MISSING span covers an inserted line.
(d) A blob containing conflict-marker lines (^<<<<<<< , ^=======$, ^>>>>>>> ) gets no region table. Such a path is whole-file for claims and is never published (engine assert (d)).
VERIFIED results_all.json S7: one unclosed triple quote dropped keys from 437 to 106, and an unclosed paren hid 279 functions. Incremental and cold parses gave identical results (fwd_results.json), so name-derived keys from broken trees are unusable. VERIFIED rc_touch R2 py_boundary_insert_half_typed: touch via ERROR. [P2, P4, P6]  _(covers: error-tree-claims-evaporate, autosave-propagates-half-typed-code)_
- **REG-12** PRE-MERGE PUBLISH GATE (the B1 boundary function). Before every merge-tree that produces an outgoing tree, the daemon MUST run gate() over every hunk of diff(A[p], S_disk[p]), computed by REG-05 over canon'd stored blobs. It runs in A[p] coordinates, against the fold state of the exact board tip the push will lease. It MUST be recomputed from scratch after every CAS reject and refetch.

A claim is foreign when both hold: its holder seat differs from the seat(s) the hunk is attributed to (another seat on the same PC is foreign), and it is earlier in board order than any claim the hunk's seat holds on overlapping lines. Tentative and unpublished own claims are always later.

Every CS with a touching hunk (REG-07) is returned as blocked with (claim_id, holder, path, reason). LCM-12 holds it whole (PIN), and the U6 notices name the holder.

Human CSs are gated the same way: never denied, but held and flagged claim-breach. Exception: for hunks attributed to this PC's human, claims held by any seat under this same daemon are NOT foreign. It is the same working tree and the same bytes, and the holder's own human is not a teammate. A user's fix inside a function their own Claude holds is therefore not frozen.

gate() never returns hunks to remove and never consults the hold registry. Because gate() runs in the daemon on the delta, it covers Bash/PowerShell writes, failed-open hooks, a dead MCP server and human editors; hook denies are early warnings only. Running the gate before the merge is what prevents the same-tail misplacement. VERIFIED premerge_results.json: pre-merge withdrawal was byte-correct, while merge-tree moved 'return round(total, 2)' into compute_tax with exit 0. [P2, P3, P6]  _(covers: race-loser-hunk-lands, a-race-window-overlap-leaks-code, non-atomic-pair-and-fence, splice-source-stale-board-text, merge-misplaces-edit-into-same-tail-neighbor, hunk-withdrawal-publishes-signature-without-callers, intra-file-withdrawal-mangles-file, human-claim-breach-and-claude-tramples-human, bash-powershell-bypass-after-deny, deny-then-bash-workaround, gate-fails-open-on-every-hook-failure, claim-launders-held-revert)_
- **REG-13** POST-MERGE IDENTITY CHECK. After OUT = merge-tree(A, S_pub, TIP), and after every re-merge, the daemon MUST check every path with a grammar where both S_pub[p] != A[p] and TIP[p] != A[p]. For each local hunk of diff(A[p], S_pub[p]), two labels must be equal:
- the label of the innermost unit containing the hunk's post-image lines in S_pub[p];
- the label of the innermost unit containing their REG-05 image in OUT[p].
The comparison is within one peer and one parser, so labels are comparable here. A mismatch, or an image that is TOMBSTONE or WHOLE_FILE, MUST route the path to the data-handling conflict function, never to a push. That function sends TIP's entry out and makes the local blob the conflict hold. The check runs on every such path, claimed or not, because git misplaces same-tail edits even without any claim. It reuses T0's parse of OUT. VERIFIED in the region-gap inspection run: merge-tree and merge-file exited 0 with B's edit landing in compute_tax, and the identity check flagged symbol_in_SNAP=compute_total vs symbol_in_OUT=compute_tax. [P2, P6]  _(covers: merge-misplaces-edit-into-same-tail-neighbor, move-splice-duplicates)_
- **REG-14** RELATIVE REGION TRIPWIRES. These are the region part of LCM-14 T0 and of the insertion-concat tripwire. They run on every outgoing blob (after every merge and re-merge) and on every concat output, per path with a grammar:
(a) ERROR+MISSING count(output) <= count(TIP[p]), or 0 for a new path;
(b) for every label key (kind, qualname, discriminator): count(output) <= max(count(TIP[p]), count(S_pub[p])). For concat outputs: max(count(TIP), count(LOCAL));
(c) the output decodes as UTF-8 if TIP[p] did.
A violation MUST hold the CS (LCM-12) and the path is not pushed. Output is never repaired.
The absolute forms ('no ERROR/MISSING nodes', 'no duplicate qualnames') MUST NOT be used, because valid code violates both:
- VERIFIED rc_valid_errors.mjs: valid C# with #if/#else around a method header yields MISSING ';', ERROR and MISSING #endif in tree-sitter-c-sharp 0.23.5.
- VERIFIED rc_dupes.mjs: the valid base fixture already contains Account.value x2 (property getter/setter) and open_console x2 (platform branches).
Parsing alone is not a safety net. VERIFIED parse-ok-is-not-a-safety-net: every corrupt splice in S2-S9 had parses_clean=true, and it was the count rule (b) that flagged them (guard_results.json G6). [P2, P4, P6]  _(covers: parse-ok-is-not-a-safety-net, move-splice-duplicates, error-tree-claims-evaporate, autosave-propagates-half-typed-code)_
- **REG-15** INTERFACE CLASSIFIER ON THE NET CS DELTA. For each unit an outgoing CS changes, the daemon MUST compare the signature slices of A[p] and S_pub[p]. The comparison is net over the whole CS, never per edit.
Signature slices:
- Python function: parameter list (positional-only, positional, keyword-only, *args, **kwargs, names, presence of defaults), decorators, return annotation.
- Python class: bases, the set of method names, class-level assignment names.
- Python module: __all__ and UPPER_CASE names.
- JS/TS: formal parameters (count, rest, defaults, destructured names), export status and exported name, class member names.
- C#: modifiers, return type and parameter list (types, ref/out/in/params, defaults) of non-private members; property and field types; the overload set.
- JSON: key paths (JSON.parse of both blobs).
Classes:
- breaking: a unit or export removed; a rename whose old name is still referenced; a positional parameter removed, reordered or renamed; a new required parameter; *args/**kwargs removed; a C# parameter list change that leaves no overload accepting the old calls; a JSON key path removed or renamed.
- compatible: body-only change; an appended parameter with a default; a new optional keyword-only parameter; an added overload.
- note: a decorator change or a default-value change.
A rename alias (display and caller check only) is recorded only when the old qualname is absent in S_pub, the new qualname is absent in A, and at least 60% of body lines are equal under REG-05. An insertion before a unit never produces an alias. VERIFIED extra_results.json false_alias: offset re-resolution gave parse -> parse_v2 while parse still existed. The research classifier test classified an appended `_extra_flag=None` as compatible. [P3, P6]  _(covers: c-interface-break-invisible-to-claims, false-alias-on-insert-at-offset)_
- **REG-16** CALLER AND CALLEE CHECK ON THE MERGED TREE (the interface part of T0). After every merge and re-merge, these checks run on OUT.
(a) Callers of a breaking change. For each breaking change from REG-15, run `git -c attr.tree=<EPOCH_BASE> grep -z -n -w -F -e <name> <OUT tree oid> -- <grammar and JSON paths>` under LC_ALL=C. Drop hits inside the definition itself. Drop comment and string hits, except for const/UPPER_CASE names and JSON key names. Classify each call:
  - definite: a bare-name call that resolves to the defining module (same file, `from m import name`, or a relative JS/TS named import), or a self./this./same-type C# member call;
  - possible: an attribute call on an unknown receiver.
A definite call that this CS did not write, and whose arity or keywords are incompatible with the new signature, MUST fail T0. The CS is held (LCM-12/13), and the author is told with the caller list.
(b) Callees of new calls. For every call node this CS added or changed, resolve the callee by the same rules in OUT and check arity and keywords against its OUT signature. An incompatible definite call MUST fail T0. This catches the orphan call when a teammate's breaking change landed first.
Possible hits, more than 50 hits, and stoplist names (get, set, run, main, init, __init__, update, load, save, close) produce a count or a note only, and never hold a CS.
Budget: grep plus filtering <= 150 ms on 611 files (research: grep itself takes 73-80 ms). Hit files are parsed from the OID cache.
VERIFIED X7 (x5x6x7.log): the re-merged tree published a 2-argument caller, Carol hit a TypeError, and an ast caller-arity scan of the merged tree found orders.py:14. VERIFIED x2/x3: the TypeError/ImportError cases passed py_compile. [P2, P6]  _(covers: cas-remerge-breaks-cs-invariant, c-interface-break-invisible-to-claims, hunk-withdrawal-publishes-signature-without-callers, syntax-smoke-check-misses-python-atomicity-breaks, path-quoting-and-git-locale)_
- **REG-17** PRETOOLUSE PREDICTION AND POSTTOOLUSE AUTHORITY. The gate MUST answer from memory. For an Edit it:
1. reads the target file's current bytes with fs, never git;
2. locates old_string in the normalized view (BOM stripped, CRLF->LF, curly quotes folded);
3. lists every match when replace_all is set, and every candidate when a single match is ambiguous;
4. converts the matches to disk line ranges;
5. maps disk rows to A[p] with REG-05 against the cached A[p] line array;
6. forms the predicted hunks and runs REG-07 against foreign claims.
For a Write, the predicted hunks come from a REG-05 diff of current disk against the new content. NotebookEdit and REG-08(h) paths are whole-file.
If the needed region table is not cached, the prediction uses a fallback region: from the nearest preceding column-0 line that starts a definition (per-language regex) to the line before the next such line. The fallback serves the G1/G2 decision only and is never published. If locating fails, the gate returns G2 and PostToolUse decides.
PostToolUse MUST recompute the authoritative hunks as the REG-05 diff of the pre-image captured under the fence against the post-image. Only those hunks produce confirmed claims (REG-08) and touch verdicts.
Moved-code check: if old_string's innermost unit has different labels in the seat's last-read snapshot and in current disk (via the REG-05 image), or the image is a TOMBSTONE, the gate denies with 'the code you are editing moved from <a> to <b>'.
VERIFIED sweep/edit: Edit applied an LF old_string to a BOM+CRLF file and a straight-quote old_string to curly quotes, so raw matching misses. VERIFIED e12: a main-thread parse of the 1.3 MB file blocks 337-368 ms, hence worker parsing and the fallback. [P2, P3, P6]  _(covers: edit-normalization-breaks-symbol-mapping, false-alias-on-insert-at-offset, edit-rematch-lands-in-moved-code, hook-latency-event-loop-stall)_
- **REG-18** POSSIBLE-FORK NOTE. At publish, a unit MUST produce one note 'possible fork of <holder>'s <label>' when all of these hold: it is NEW in the outgoing CS; it is at least 5 lines long; and its multiset of leaf tokens has Jaccard similarity >= 0.8 with a unit covered by a foreign claim. Leaf tokens are tree-sitter leaf node type+text, excluding identifiers equal to the unit's own name. The note appears in the author seat's own next hook output and in status. It never holds a CS, never wakes anyone, and never notifies the holder (U6/U7 cost). [P2, P3]  _(covers: deny-workarounds-by-agent)_
- **REG-19** REQUEST AND SHADOW KEYING. Denied-edit shadows, requests and handoff records MUST be keyed by (seat_id, foreign claim_id, path), never by symbol name, ordinal or hash. Chained denials on the same claim therefore compose on one shadow, even after renames or line shifts. Displays (cowork_show, the T1-T3 templates) render the symbol by reading base_blob/proposed_blob by OID and selecting the claim's mapped lines with REG-04/REG-05. That text is shown, never written. Applying a request is a whole-blob 3-way merge owned by other groups; no region-scoped apply exists. [P1, P3]  _(covers: handoff-patch-rot-and-orphaned-returns, board-plaintext-and-permanence)_
- **REG-20** DETERMINISTIC FOLD OVERLAP. The board fold MUST decide claim validity from ranges, not keys. When a claim op C2 is folded, every active claim C1 of a different holder seat on the same path, tombstones included, is mapped from its anchor to C2's anchor with the bundled REG-05 mapper. Both blobs are reachable through the board's last-parent links. C2 is invalid if any of these holds:
- any mapped C1 range and any C2 range intersect as closed intervals;
- either claim is a whole-file claim;
- the D-capped mapping returns WHOLE_FILE.
An invalid C2 is a deterministic no-op: the writer is told, and the writer's CS is held per LCM-12. An op carrying an existing claim_id of the same seat replaces that claim's anchor, ranges and tombstones (re-anchor); a seat may hold several claims on one path. The fold uses only op fields and the mapper with its deterministic D cap: no parse, no regionSpec, no labels, no git diff, no clock and no time-based cap. A checkpoint that differs from a daemon's own fold is a protocol P2 alert. [P3, P5]  _(covers: op-identity-cursors-board-merge, version-skew-board-and-guards, non-atomic-pair-and-fence)_
- **REG-21** BUDGETS AND ISOLATION. Parsing, mapping and the interface check MUST run in the worker_threads pool. The main thread only reads cached region tables and line arrays (event-loop block <= 20 ms). Region tables are cached by blob OID; they are small (432 units for a 5,960-line file). At most 8 parse trees are kept live for incremental reparse.
Targets:
- gate, daemon side: <= 15 ms p95 from cache;
- one mapping: <= 40 ms at D=2,000 on 5,960 lines, capped by REG-05 (D > 5,000 -> WHOLE_FILE everywhere; > 200 ms -> WHOLE_FILE in local decision paths only);
- parse of the 1.3 MB file: <= 400 ms in a worker;
- the whole T0 region part: <= 0.5 s on the 1.3 MB file.
Exceeding any budget is shown in status and never turns into 'no conflict'. [P2, P6]  _(covers: hook-latency-event-loop-stall)_
- **REG-22** RESIDUAL DISK SUBTRACTION GUARD. Another group may keep an operation that removes a tool_use's changes from a working file by region (claude-integration's Bash/Edit 'restore exactly those hunks'). If it does, the restore MUST be computed as the inverse of complete hunks of that tool_use's own REG-05 pre->post diff: never partial hunks, never symbol-range slicing. Its result MUST pass REG-14 against the pre-image, plus symbol accounting: units equal the pre-image units, with no duplicate or missing label relative to the pre-image. On any failure the disk is left untouched and the CS is PIN-held instead. The default, per LCM-12, is no disk rewrite at all. [P1, P2]  _(covers: intra-file-withdrawal-mangles-file, posttooluse-restore-induces-workarounds)_

## invariants
- **INV-REG-COORD** No IPC message, board op, region-module API value or log record carries a byte, char or UTF-16 offset of file content. All region coordinates are (blob OID or disk snapshot id, path, 1-based inclusive line ranges).
  TEST: Three checks: a schema test on every IPC and board message type; a lint that fails on startIndex/endIndex/byte offsets outside the line-table helper; and a property test over fixtures with BOM, CRLF, LF, Hangul, astral emoji, curly quotes and U+2028, asserting that web-tree-sitter rows equal 0x0A-split line numbers in both blob forms.
- **INV-REG-NOWRITE** Region logic never changes a byte. For any outgoing tree, dropping every region verdict except the blocked-CS list leaves the pushed blobs byte-identical, because blobs come only from S_pub or the merge output.
  TEST: A static lint (no fs write and no object-writing git call in the region module), plus a harness assertion that every pushed blob equals TIP[p], S_pub[p] or the merge-tree output for that path.
- **INV-REG-FENCE** Take any live commit C landed on the remote and any claim c active at the board tip C was leased on. The lines of c, mapped into C, differ from the previous live tip only by hunks from c's holder seat. Two exceptions: changes flagged claim-breach (human), which are visible on the board; and a base-move commit (Cowork-Base trailer, R3), whose branch-merge changes raise the claim-breach notice to the holder.
  TEST: Shared harness (3-4 peers, file:// remote, a BOM+CRLF file of at least 5k lines, a filter). After every push, read the remote with git cat-file, map every active claim with the bundled mapper, and assert the condition. Use seeded random interleavings of Claude edits, Bash rewrites, human saves, external commits to main, CAS rejects and ambiguous pushes.
- **INV-REG-MAP** A claim's mapped range always equals the true extent (the oracle) of the lines it was taken on. This holds across any sequence of peer insertions and deletions above, inside and below the range, and across stored and working forms.
  TEST: S9 800-block generator and the fwd fixtures: apply random blank-line and code insertions and deletions, and compare the mapped ranges with the generator's oracle after every step. Repeat with the CRLF+BOM working form.
- **INV-REG-FOLD** All peers that folded the same board tip agree on the validity of every claim op.
  TEST: 4 simulated peers fold the same board, built from interleaved overlapping, disjoint, re-anchor and tombstone claim ops, including concurrent claims with different anchors. Assert identical validity sets and equal checkpoints. Include one peer whose mapper is artificially slowed 10x: its validity set must still equal the others' (no time-based cap in the fold).
- **INV-REG-TRIPWIRE** No pushed blob has more ERROR/MISSING nodes than TIP's blob of that path, more occurrences of any label key than max(TIP, S_pub), or invalid UTF-8 where TIP was valid.
  TEST: A harness post-push check over every pushed path with a grammar. In addition, the corrupting fixtures S2, S3x3, S4, S5x2, S6x2, S8 and S9, forced through merge outputs, must all be held.
- **INV-REG-NOLABEL** No claim is ever found, matched, released or cleared by its label. Labels only add conflicts (REG-09) or are displayed.
  TEST: Mutation test: randomize every label string in claim ops at fold and gate time. The set of blocked CSs must not shrink; it may change only by the C#/TS group-name additions.

## tests
- T-REG-01 Region-gap regression suite in the shared harness. Run S1-S10 and the fwd/premerge fixtures from sweep/region through the real gate, merge and tripwires. Assert that every correct case pushes output byte-identical to the oracle. Assert that every corrupting case (S2, S3x3, S4, S5x2, S6x2, S8, S9) ends in a held CS with zero pushes of the affected path.
- T-REG-02 Touch predicate unit table, from rc_touch.mjs R2 (15 cases), with expected verdicts:
- touch (T): edit inside the body; append after the last body line (case 3); decorator under the attached comment; attached comment added above; half-typed boundary insertion (ERROR); decorator-only edit on handler; append to a setter body; JS append in a setter; C# new same-name overload (group-name).
- no touch (F): new def after; same-tail def after; @overload stubs above; sibling edit; new method after a setter; JS getter above a held setter.
- T-REG-03 Form invariance. big_wt.py (BOM+CRLF) vs big_lf.py (LF): 0 mapper hunks and identical region tables (432 units). The exact-equality control shows 5,960 changed lines. A lint forbids startIndex/endIndex outside the helper.
- T-REG-04 Rename in the propagation window (S1), with an injected board lag and with the board ahead of the code. In both orders the requester's edit inside the renamed body is blocked (CS held). No 'key missing' path exists.
- T-REG-05 Move within a file and to another file (S2). Before the holder's push, the tombstone denies or holds the requester's edit at the old location. After the push, the new-location claim published in the same op batch denies the requester's PreToolUse edit at the NEW location. The requester's modify/delete conflict at the old location goes to the conflict function. No pushed blob contains two compute_total definitions.
- T-REG-06 Same-tail misplacement (premerge.py fixture), with a claim and without one. In the claimed variant the pre-merge gate holds the requester's CS. In the unclaimed variant the identity check routes the path to the conflict function. compute_tax is byte-identical to D's version in every pushed blob.
- T-REG-07 ERROR trees. Use the S7 fixtures (unclosed triple quote, unclosed paren, JS and C# unclosed brace) as TIP and as the local post-image. Existing claims still block edits in their mapped lines. No claim op is computed from an erroring tree, and last-good mapping is used. A clean tree restores symbol-level claims.
- T-REG-08 Relative tripwires, on the rc_valid_errors C# #if/#else file and on the Python getter/setter + platform-branch file. Unrelated edits publish (no false hold). A merge output with an extra def or an extra ERROR node is held.
- T-REG-09 Interface checks:
- X7 (a CAS re-merge introduces an old-arity caller) is held until fixed, and Carol stays green.
- Orphan call: foo(a,b)->foo(a) lands first and Bob's CS adds foo(1,2); the callee check holds Bob's CS.
- A CS that updates all callers publishes.
- Possible-only hits produce a note and no hold.
- A JSON key rename read in .py and .cs reports both sites.
- An insertion before a unit produces no alias (false_alias fixture).
- T-REG-10 Group-name rule:
- S6(b) inserts Calc(decimal) while Calc(int) is held: the CS is held.
- Calc(long) added in Svc.Part2.cs is held via the partial-type grep.
- With the grep forced to fail, the claim covers every partial file whole.
- Python @overload stubs and a JS getter are not held.
- T-REG-11 Edit normalization, with a scripted real Claude Code session and a hook that dumps stdin. Cases: an LF old_string on a BOM+CRLF file; curly quotes; replace_all across 5 functions; an old_string spanning two units; NotebookEdit. Predicted hunks equal the PostToolUse authoritative hunks. Any foreign claim among them yields a deny or a held CS, asserted on the remote ref.
- T-REG-12 Bypass: a Bash python -c / sed -i / PowerShell Set-Content rewrite of a held function, and a human editor save into it from another PC. The remote live ref never contains the change (INV-REG-FENCE), the CS is held, and the human case is flagged claim-breach.
- T-REG-13 Filtered and special paths: a filter=secret file, a working-tree-encoding file, a symlink, a notebook and a cp949 file. Claims are whole-file (raw-byte blocks for cp949). No region code path reads working-tree bytes into a blob (runtime assert).
- T-REG-14 Fold determinism. 4 peers, 1,000 seeded claim ops, including concurrent overlapping claims with different anchors, re-anchors, tombstones and whole-file claims. Validity and checkpoints are identical on all peers, and the later of two overlapping claims is always the invalid one.
- T-REG-15 Performance on a 26,436-line BOM+CRLF fixture. Gate p95 <= 15 ms from cache. Event-loop delay <= 20 ms during a worker parse. Measure the mapper at D=2,000. The D>5,000 cap returns WHOLE_FILE everywhere; the 200 ms cap returns WHOLE_FILE only in local paths.
- T-REG-16 Version skew: two daemons with different regionSpec. The mismatched reader treats the other's claims as whole-file. No pushed blob gains or loses a decorator line. Status shows the mismatch.
- T-REG-17 Fork note: a CS adds handle_upload_v2, copied from a foreign-held handle_upload. Exactly one note goes to the author; there is no hold and no wake.
- T-REG-18 Own-PC human vs own seat. This PC's human edits a function its own Claude seat holds: published normally, not held. Another PC's human edits the same function: the CS is held and flagged claim-breach.
- T-REG-19 Sub-block setting. Default off: two seats editing different blocks of a 3,069-line function (S9 generator) conflict at unit level. Setting on: they do not conflict, and block claims stay exact under random blank-line insertions (INV-REG-MAP).

## numbers
- 300 lines: suggested threshold for the OPT-IN sub-block setting (claims.subBlockOverLines, default off pending sign-off). Source: research/region-detect.md section 1. Not measured on the real hub.py, which was deliberately not touched.
- 300 lines: text files without a grammar at or below this length are claimed whole-file; longer ones are claimed by blank-line block.
- Mapper caps: D > 5,000 lines -> WHOLE_FILE everywhere (deterministic; used by the fold). > 200 ms -> WHOLE_FILE only in local decision paths. Measured with rc_touch R3 (Node 24, web-tree-sitter 0.27): 1.3 ms at D=60 (41 hunks) and 30-37 ms at D=2,000 on 5,960 lines. An exact-equality diff of the CRLF vs LF forms took 536 ms, so the EOL-insensitive equality is also the fast path.
- Parse: 11 ms for the 120 KB / 5,960-line Python fixture in WASM (warm). e12 measured 337-368 ms for the 1.3 MB file on the main thread, so parsing runs only in a worker, with a budget of <= 400 ms there.
- Gate daemon-side <= 15 ms p95 from cache; end-to-end <= 60 ms p95 on Windows; event-loop block <= 20 ms. These are binding claude-integration numbers this subsystem must fit.
- T0 region part (parse + identity check + tripwires + interface check): <= 0.5 s on the 1.3 MB file. x10 measured ast + symbol table at 397 ms for 1.34 MB.
- Caller grep: <= 150 ms total on 611 files (research: git grep -w -F takes 73-80 ms). More than 50 hits, or a stoplist name, gives a count or note only.
- Partial-type grep budget: 100 ms. On failure, the claim covers every partial file whole.
- Rename alias: >= 60% equal body lines, old name absent after, new name absent before.
- Possible-fork note: new unit of >= 5 lines with leaf-token Jaccard >= 0.8 against a foreign-held unit.
- Attached comments: contiguous comment lines directly above a unit, with zero blank lines between.
- Binary detection: a NUL in the first 8,000 bytes, or a -text/binary attribute at EPOCH_BASE.
- Parse cache: region tables per blob OID (432 units for 5,960 lines, so small); at most 8 live trees for incremental reparse.

## open questions
- NEEDS USER SIGN-OFF: 300줄이 넘는 아주 긴 함수는 함수 전체가 아니라 '빈 줄로 나뉜 구간' 단위로 잡아서, 두 사람이 같은 함수의 서로 다른 부분을 동시에 고칠 수 있게 해도 될까요? (지금 승인된 규칙은 함수 단위라서, 이 규칙집은 기본값을 '함수 전체'로 두고 이 기능은 저장소 설정으로 켰을 때만 동작하게 했습니다)
- The protocol board op defines claim.anchor{path, base_blob, stored-form byte range}. VERIFIED offset-units-form-drift and data-handling ('reads stored blobs by line rows only') both point to lines. This catalog uses stored-form LINE ranges. If the protocol group keeps a byte range, it must be derived inside the one line-table helper of the same blob and never matched on. Please confirm the field change.
- The protocol fold says 'a claim on a key held by an earlier claim is a deterministic no-op', which is name-keyed. REG-20 replaces it with range overlap computed by the bundled mapper, so the mapper version becomes part of proto/minWriter. The fold deliberately avoids git diff: on the same input its slider placement differed from the bundled Myers (rc_touch vs fwd.py), and its output across git >= 2.43 versions was not verified here.
- The claude-integration 'Claim confirmation' rule says the prediction is 'mapped back to raw offsets'. Under REG-01 this must read 'mapped back to line numbers'. Please confirm the wording change.
- Two binding resolutions contradict each other. claude-integration's Bash/Edit rule (3) restores 'exactly those hunks' on the author's disk. LCM-12 says PostToolUse never rewrites the author's disk, and VERIFIED intra-file-withdrawal-mangles-file shows hunk subtraction can duplicate or drop functions. REG-22 supplies the guard if a restore survives. The orchestrator should pick one; this catalog assumes LCM-12 (no restore).
- LCM-14 T0 states absolute rules: 'no ERROR/MISSING nodes' and 'no duplicate qualnames'. REG-14 makes them relative, because valid code triggers both (rc_valid_errors.mjs: C# #if/#else; rc_dupes.mjs: getter/setter and platform branches). Please confirm that LCM-14 adopts the relative form.
- A regionSpec mismatch makes a reader treat that peer's claims as whole-file. During a plugin rollout, every symbol claim on the shared 1.3 MB file could then lock the whole file for the skew period. The alternative is to make regionSpec changes bump minWriter, which makes old peers read-only. Which is preferred?
- Without type information, Python method-signature changes rarely have 'definite' callers (obj.method(...) counts as 'possible'). REG-16 therefore mostly notes rather than holds them, with T1 at checkpoint and save as the backstop. Is that acceptable for v1?
- The C#/TS group-name rule deliberately does not apply to Python or JS, because S3 expects @overload stubs and getters to raise no conflict. Please confirm the asymmetry.
- Under the extent convention, a boundary insertion directly above a unit with no blank line between (an attached comment) touches the unit. That can block a teammate who only adds a comment above a held function. Accept this as conservative, or exclude comment-only insertions?
- REG-12 treats a human hunk inside a claim held by a seat of the SAME daemon as not foreign: the user's fix in a function their own Claude holds publishes normally. Under the strict reading (every seat is foreign to the human), the user's own path would be PIN-held, and LCM-12 bundling would freeze their own Claude's work too. Please confirm.
- The D cap (5,000) and the opt-in sub-block threshold were not measured on the real hub.py (26,436 lines), which this work did not read. Measure them once on a copy before release.
