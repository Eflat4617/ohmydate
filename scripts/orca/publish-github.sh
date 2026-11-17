#!/usr/bin/env bash
# Publish the integration branch to the public GitHub repository.
#
# The published copy is the local history with two things changed, nothing else:
#   - the author/committer e-mail of this machine's git identity becomes the
#     GitHub no-reply address of the signed-in `gh` account;
#   - this machine's tailnet name (from `tailscale status`) becomes "example-tailnet"
#     in file contents and commit messages.
# The rewrite is deterministic: the same local commits always give the same
# published commits, so each run is a plain fast-forward of the published main.
# The local repository is never touched (the rewrite happens in a temporary clone).
#
# Usage: scripts/orca/publish-github.sh            # fast-forward only
#        PUBLISH_FORCE=1 scripts/orca/publish-github.sh   # replace the published history
# Needs: git-filter-repo (uv tool install git-filter-repo), gh (signed in), tailscale.
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
branch=${PUBLISH_BRANCH:-torgal/ohmydate}
remote_url=${PUBLISH_URL:-https://github.com/Eflat4617/ohmydate.git}

command -v git-filter-repo >/dev/null || { echo "git-filter-repo is missing: uv tool install git-filter-repo" >&2; exit 2; }

local_email=$(git -C "$repo_root" config user.email)
local_name=$(git -C "$repo_root" config user.name)
gh_id=$(gh api user --jq .id)
gh_login=$(gh api user --jq .login)
noreply="${gh_id}+${gh_login}@users.noreply.github.com"
tailnet=$(tailscale status --json 2>/dev/null | python3 -I -c '
import json, sys
try:
    suffix = json.load(sys.stdin).get("MagicDNSSuffix") or ""
except Exception:
    suffix = ""
print(suffix.split(".")[0] if suffix.endswith(".ts.net") else "")
')

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone --quiet --no-local --single-branch --branch "$branch" "$repo_root" "$work/repo"

printf '%s <%s> <%s>\n' "$local_name" "$noreply" "$local_email" > "$work/mailmap"
: > "$work/replacements"
if [ -n "$tailnet" ]; then printf '%s==>example-tailnet\n' "$tailnet" >> "$work/replacements"; fi

(cd "$work/repo" && git-filter-repo --force --quiet \
  --mailmap "$work/mailmap" \
  --replace-text "$work/replacements" \
  --replace-message "$work/replacements")

# Refuse to publish if anything was missed.
cd "$work/repo"
emails=$(git log --format='%ae%n%ce' | sort -u)
if printf '%s\n' "$emails" | grep -qixF "$local_email"; then echo "refusing: the local e-mail is still in the history" >&2; exit 3; fi
if git log --format=%B | grep -qiF "$local_email"; then echo "refusing: the local e-mail is in a commit message" >&2; exit 3; fi
if [ -n "$(git log -S"$local_email" --format=%h | head -1)" ]; then echo "refusing: the local e-mail is in a file" >&2; exit 3; fi
if [ -n "$tailnet" ]; then
  if [ -n "$(git log -S"$tailnet" --format=%h | head -1)" ] || git log --format=%B | grep -qF "$tailnet"; then
    echo "refusing: the tailnet name is still in the history" >&2; exit 3
  fi
fi

echo "publishing $(git rev-list --count HEAD) commits, head $(git rev-parse --short HEAD), authors: $(printf '%s\n' "$emails" | tr '\n' ' ')"
if [ "${PUBLISH_FORCE:-0}" = 1 ]; then
  git push --force "$remote_url" HEAD:refs/heads/main
else
  git push "$remote_url" HEAD:refs/heads/main
fi
