#!/bin/sh
# Spec D4.1/D4.2 (scratch index + --work-tree=tmp/<x> + update-index --refresh) under 4 variants, traced.
# tmp/rt_keys/hub.py = smudged bytes (dummy secret, CRLF); tmp/id_keys/hub.py = raw blob bytes (LF, placeholder).
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
S=${COWORK_SCRATCH_S03:?set to <scratch>/s03}; T=$S/tmp; IDX=$T/dbg.index
cd $S/clone
B=$(git rev-parse HEAD:hub.py); GA=$(git rev-parse HEAD:.gitattributes)
red() { sed -E 's#https?://[^ ]*#<url>#g' | grep -v exec-cmd | cut -c1-260; }
for wt in id_keys rt_keys; do
  for v in spec_q spec_noq attrtree attr_in_index; do
    rm -f $IDX
    if [ $v = attr_in_index ]; then
      GIT_INDEX_FILE=$IDX git update-index --add --cacheinfo 100644,$B,hub.py --cacheinfo 100644,$GA,.gitattributes
    else
      GIT_INDEX_FILE=$IDX git update-index --add --cacheinfo 100644,$B,hub.py
    fi
    case $v in
      spec_q)   set -- --work-tree=$T/$wt update-index -q --refresh ;;
      spec_noq) set -- --work-tree=$T/$wt update-index --refresh ;;
      attrtree) set -- -c attr.tree=HEAD --work-tree=$T/$wt update-index --refresh ;;
      attr_in_index) set -- --work-tree=$T/$wt update-index --refresh ;;
    esac
    echo "#### worktree=$wt variant=$v"
    GIT_TRACE=1 GIT_INDEX_FILE=$IDX git "$@" > $T/o.txt 2>&1; rc=$?
    red < $T/o.txt; echo "rc=$rc filter_ran=$(grep -c 'run_command' $T/o.txt)"
  done
done
