#!/usr/bin/env bash
# Lists the test files (backend and web) related to a change, one per line, for
# `bun test <files...>`.
#
# Usage (from the repository root):
#   related-tests.sh                # uncommitted changes, including untracked files
#   related-tests.sh main...HEAD    # any range `git diff --name-only` accepts
#   related-tests.sh <sha>^!        # a single commit
#
# A test is related when it was changed itself, or when it imports a changed module directly,
# through that module's directory index, or through a test helper that imports it. This is a
# starting point: add tests the change affects in ways imports do not show.
set -euo pipefail

if [ $# -gt 0 ]; then
  changed=$(git diff --name-only "$@")
else
  changed=$({ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
fi

backend_tests=$(ls tests/*.test.ts 2>/dev/null || true)
helpers=$(ls tests/helpers/*.ts 2>/dev/null || true)
web_tests=$(find web/src -name '*.test.ts' -o -name '*.test.tsx' 2>/dev/null || true)

importers() { # importers <fixed-string> <files...>
  local needle=$1
  shift
  [ $# -gt 0 ] && grep -lF -- "$needle" "$@" 2>/dev/null || true
}

{
  for file in $changed; do
    [ -f "$file" ] || continue
    case "$file" in
      tests/helpers/*.ts)
        # shellcheck disable=SC2086
        importers "helpers/$(basename "$file")" $backend_tests
        ;;
      tests/*.test.ts | web/src/*.test.ts | web/src/*.test.tsx)
        echo "$file"
        ;;
      src/*.ts)
        for needle in "$file" "$(dirname "$file")/index.ts"; do
          # shellcheck disable=SC2086
          importers "$needle" $backend_tests
          # shellcheck disable=SC2086
          for helper in $(importers "$needle" $helpers); do
            # shellcheck disable=SC2086
            importers "helpers/$(basename "$helper")" $backend_tests
          done
        done
        ;;
      web/src/*.ts | web/src/*.tsx)
        module=$(basename "$file")
        # shellcheck disable=SC2086
        importers "/${module%.*}" $web_tests
        ;;
    esac
  done
} | sort -u | sed 's#^#./#' # bun test treats only ./-prefixed arguments as paths
