#!/bin/sh
# Cut a release: bump package.json, commit + tag on main, push.
# The tag runs .github/workflows/publish.yml → npm @zecalis/fapony (Trusted Publishing).
# usage: scripts/release.sh [patch|minor|major]   (default patch)
set -eu
cd "$(git rev-parse --show-toplevel)"

pkg=@zecalis/fapony
part=${1:-patch}
case $part in patch | minor | major) ;; *) echo "usage: $0 [patch|minor|major]" >&2; exit 2 ;; esac

[ -z "$(git status --porcelain)" ] || { echo "release: working tree is dirty — commit or stash first" >&2; exit 1; }
# dependabot PRs don't block — they carry no work of ours
prs=$(gh pr list --state open --base main --json number,author --jq '[.[] | select(.author.login != "app/dependabot") | "#\(.number)"] | join(" ")')
[ -z "$prs" ] || { echo "release: open PR(s) into main: $prs — merge or close them first" >&2; exit 1; }
git checkout -q main
git pull -q --ff-only

# the bump commit is a direct push, so the commit under it must already be green
# — a run still queued or going (a merge made seconds ago) is waited on, not refused
sha=$(git rev-parse HEAD)
ci_run=
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  ci_run=$(gh run list --workflow ci.yml --commit "$sha" -L1 --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$ci_run" ] && break
  sleep 5
done
if [ -n "$ci_run" ]; then
  echo "release: waiting on CI run $ci_run for $(git rev-parse --short HEAD)"
  gh run watch "$ci_run" --exit-status >/dev/null || true
fi
ci=$(gh run list --workflow ci.yml --commit "$sha" -L1 --json status,conclusion --jq '.[] | "\(.status) \(.conclusion)"')
[ "$ci" = "completed success" ] || { echo "release: CI on main $(git rev-parse --short HEAD) is '${ci:-not run}' — fix it first" >&2; exit 1; }

old=$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json | head -n1)
IFS=. read -r major minor patch <<V
$old
V
case $part in
patch) patch=$((patch + 1)) ;;
minor) minor=$((minor + 1)); patch=0 ;;
major) major=$((major + 1)); minor=0; patch=0 ;;
esac
new=$major.$minor.$patch

git rev-parse -q --verify "refs/tags/v$new" >/dev/null && { echo "release: tag v$new already exists" >&2; exit 1; }

# ponytail: perl, not `npm version` — no package manager in the loop, and bun.lock carries no version
perl -0pi -e "s/^  \"version\": \"\Q$old\E\"/  \"version\": \"$new\"/m" package.json

git commit -q -am "release v$new"
git tag -a "v$new" -m "release v$new"
git push -q origin main --follow-tags

echo "v$old -> v$new pushed."

# wait for the tag's publish.yml, then move this machine's global install onto it
run=
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  run=$(gh run list --workflow publish.yml --branch "v$new" -L1 --json databaseId --jq '.[0].databaseId // empty')
  [ -n "$run" ] && break
  sleep 5
done
[ -n "$run" ] || { echo "release: no publish.yml run for v$new after 60s — check Actions" >&2; exit 1; }
gh run watch "$run" --exit-status >/dev/null || { echo "release: publish.yml run $run failed — gh run rerun $run --failed" >&2; exit 1; }
echo "publish.yml $run green"

# registry lag has no fixed length (usually seconds) — poll up to 5 min instead of guessing a sleep
for _ in $(seq 30); do
  [ "$(npm view "$pkg@$new" version 2>/dev/null)" = "$new" ] && break
  sleep 10
done

npm i -g "$pkg@$new" >/dev/null || { echo "release: npm i -g $pkg@$new failed" >&2; exit 1; }
echo "local fapony -> $new (npm)"
