#!/usr/bin/env bash
# No pnpm install here: this volume stalls on executable launches (Gatekeeper scan) and on links and renames.
set -euo pipefail
[ $# -ge 2 ] || { echo "usage: $0 <name> <branch> [<base>]" >&2; exit 2; }
name=$1 branch=$2 base=${3:-main}
[ "$(git rev-parse --git-common-dir)" = "$(git rev-parse --git-dir)" ] || { echo "run from the main checkout" >&2; exit 2; }
main=$(git rev-parse --show-toplevel)
wt="$main/.claude/worktrees/$name"
start=$SECONDS
git -c core.createObject=rename worktree add "$wt" -b "$branch" "$base"
if cmp -s "$main/package.json" "$wt/package.json" && cmp -s "$main/pnpm-lock.yaml" "$wt/pnpm-lock.yaml"; then
  ln -s "$main/node_modules" "$wt/node_modules"
else
  echo "package.json or pnpm-lock.yaml differs from the main checkout; run: (cd '$wt' && pnpm install --package-import-method=copy --store-dir '/Volumes/Local Files/.pnpm-store')"
  exit 3
fi
for d in runs originals; do
  [ -e "$main/data/$d" ] && ln -s "$main/data/$d" "$wt/data/$d"
done
echo "$wt ($((SECONDS - start))s)"
