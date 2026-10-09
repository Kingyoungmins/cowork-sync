#!/bin/sh
# Clone + filter setup used by spike 03 (run from <scratch>/s03). No credentials stored in this script.
# The run used a pilot team's private repository; its URL and branch are withheld. Set them to try this on your own repo.
export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
git -c core.autocrlf=true clone --branch "$PILOT_BRANCH" --single-branch "$PILOT_REPO_URL" clone
cd clone
git config core.autocrlf true
git remote set-url --push origin no-push          # this clone can never push
# DUMMY secret (NOT the pilot team's real value) in the clone-local, gitignored key file the smudge filter reads.
# The URL is 99 characters long, the same length as the dummy used in the measured run:
printf '{"secretUrl": "https://example.invalid/api/dummy/hooks/incoming/endpoint/notify/run?api-version=1&sig=DUMMYSIG0000"}\n' > secrets.local.json
python tools/setup_secret_filter.py > ../setup.log 2>&1   # the pilot team's own setup script, unchanged
# then: python ../q12_roundtrip.py keys; python ../q12_roundtrip.py nokeys; sh ../q1_d4_variants.sh > ../logs/q1_d4_variants.log 2>&1
#       python ../q3_required.py; python ../q45_snapshot.py; python ../q4b_touch_on_stat_fresh.py; python ../q6_env.py
