#!/usr/bin/env bash
# Alfred release script — handles the full multi-ha.N publish workflow:
#   1. Auto-bump multi-ha.N in packages/cli/package.json
#   2. Sync the version badge in README.md
#   3. Verify CHANGELOG has an entry for the new version
#   4. Run pnpm build + bundle
#   5. Commit (signed-off, no Claude-Code attribution per project convention)
#   6. Push to gitlab + github in parallel
#   7. npm publish --tag multi-ha
#   8. Optionally deploy to .92 + .93 via SSH
#
# Usage:
#   ./scripts/release.sh -m "feat: ..."
#   ./scripts/release.sh -m "fix: ..." --deploy
#   ./scripts/release.sh -m "..." --no-publish     # skip npm publish
#   ./scripts/release.sh --dry-run -m "..."         # show what would happen
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  dirty working tree
#   3  missing CHANGELOG entry
#   4  build/bundle failure
#   5  publish failure
#   6  deploy failure
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Argument parsing ─────────────────────────────────────
COMMIT_MSG=""
DO_DEPLOY=false
DO_PUBLISH=true
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)   COMMIT_MSG="$2"; shift 2 ;;
    --deploy)       DO_DEPLOY=true; shift ;;
    --no-publish)   DO_PUBLISH=false; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    -h|--help)
      grep -E '^#( |$)' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "❌ Unknown argument: $1" >&2
      echo "   Use --help for usage" >&2
      exit 1 ;;
  esac
done

if [[ -z "$COMMIT_MSG" ]]; then
  echo "❌ Missing commit message. Use: $0 -m \"feat: ...\"" >&2
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────
log()   { printf '\033[36m▶\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m⚠\033[0m %s\n' "$*" >&2; }
fail()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; }

run() {
  if $DRY_RUN; then
    printf '\033[35m[dry-run]\033[0m %s\n' "$*"
  else
    eval "$@"
  fi
}

# ── Step 1: Verify clean working tree (apart from our targets) ──
log "Checking working tree state..."
if [[ -n "$(git status --porcelain | grep -v -E '(packages/cli/package\.json|README\.md|CHANGELOG\.md|packages/cli/bundle/)')" ]]; then
  fail "Working tree has uncommitted changes outside of release-managed files."
  git status --short
  fail "Commit or stash those changes first."
  exit 2
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
log "On branch: $CURRENT_BRANCH"

# ── Step 2: Parse + bump version ─────────────────────────
PKG_JSON="packages/cli/package.json"
CURRENT_VERSION=$(grep '"version":' "$PKG_JSON" | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')
log "Current version: $CURRENT_VERSION"

# Expected format: 0.19.0-multi-ha.N
if [[ ! "$CURRENT_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-multi-ha\.([0-9]+)$ ]]; then
  fail "Version '$CURRENT_VERSION' doesn't match 'X.Y.Z-multi-ha.N' format. Bump manually first."
  exit 1
fi
BASE="${BASH_REMATCH[1]}"
COUNTER="${BASH_REMATCH[2]}"
NEW_COUNTER=$((COUNTER + 1))
NEW_VERSION="${BASE}-multi-ha.${NEW_COUNTER}"
ok "Bumping → $NEW_VERSION"

# ── Step 3: Verify CHANGELOG entry exists for new version ──
if ! grep -q "## \[$NEW_VERSION\]" CHANGELOG.md; then
  fail "No CHANGELOG entry for [$NEW_VERSION]."
  fail "Add a section: ## [$NEW_VERSION] - $(date -u +%Y-%m-%d)"
  fail "Then re-run."
  exit 3
fi
ok "CHANGELOG entry found for [$NEW_VERSION]"

# ── Step 4: Apply version bump to files ──────────────────
log "Writing new version to package.json + README badge..."
if ! $DRY_RUN; then
  # package.json: replace the version line
  sed -i.bak -E "s/(\"version\": \")[^\"]+(\")/\1${NEW_VERSION}\2/" "$PKG_JSON"
  rm -f "${PKG_JSON}.bak"
  # README badge: shields.io has dashes URL-encoded, double-escape
  README_VERSION=$(echo "$NEW_VERSION" | sed 's/-/--/g')
  sed -i.bak -E "s|(version-)[^-]+--multi--ha\.[0-9]+(-blue)|\1${BASE}--multi--ha.${NEW_COUNTER}\2|" README.md
  rm -f README.md.bak
fi
ok "Version files updated"

# ── Step 5: Build + bundle ───────────────────────────────
log "Running pnpm build..."
if ! run "pnpm build"; then
  fail "Build failed"
  exit 4
fi
log "Running bundle..."
if ! run "node scripts/bundle.mjs"; then
  fail "Bundle failed"
  exit 4
fi
ok "Build + bundle complete"

# ── Step 6: Commit ──────────────────────────────────────
log "Staging release files..."
run "git add packages/cli/package.json README.md CHANGELOG.md packages/cli/bundle/"
# Also pick up any source/test files the user has already changed for this release
DIRTY_SRC=$(git status --porcelain | grep -E 'packages/(core|llm|storage|skills|messaging|security)/src|apps/web/src' | awk '{print $2}' || true)
if [[ -n "$DIRTY_SRC" ]]; then
  log "Including source changes:"
  echo "$DIRTY_SRC" | sed 's/^/  /'
  run "git add $(echo "$DIRTY_SRC" | tr '\n' ' ')"
fi

log "Creating commit..."
if $DRY_RUN; then
  printf '\033[35m[dry-run]\033[0m git commit -m "%s"\n' "$COMMIT_MSG"
else
  git commit -m "$COMMIT_MSG"
fi
ok "Committed: $COMMIT_MSG"

# ── Step 7: Push to both remotes ────────────────────────
log "Pushing to gitlab + github..."
if $DRY_RUN; then
  printf '\033[35m[dry-run]\033[0m git push gitlab %s && git push github %s\n' "$CURRENT_BRANCH" "$CURRENT_BRANCH"
else
  # Parallel push, but capture each result
  PUSH_GITLAB_LOG=$(mktemp); PUSH_GITHUB_LOG=$(mktemp)
  git push gitlab "$CURRENT_BRANCH" >"$PUSH_GITLAB_LOG" 2>&1 &
  PID_GITLAB=$!
  git push github "$CURRENT_BRANCH" >"$PUSH_GITHUB_LOG" 2>&1 &
  PID_GITHUB=$!
  wait "$PID_GITLAB" || { fail "Push to gitlab failed:"; cat "$PUSH_GITLAB_LOG" >&2; exit 1; }
  wait "$PID_GITHUB" || { fail "Push to github failed:"; cat "$PUSH_GITHUB_LOG" >&2; exit 1; }
  rm -f "$PUSH_GITLAB_LOG" "$PUSH_GITHUB_LOG"
fi
ok "Pushed to both remotes"

# ── Step 8: npm publish ─────────────────────────────────
if $DO_PUBLISH; then
  log "Publishing to npm (tag: multi-ha)..."
  if $DRY_RUN; then
    printf '\033[35m[dry-run]\033[0m cd packages/cli && npm publish --tag multi-ha\n'
  else
    if ! (cd packages/cli && npm publish --tag multi-ha); then
      fail "npm publish failed"
      exit 5
    fi
  fi
  ok "Published @madh-io/alfred-ai@${NEW_VERSION} as tag 'multi-ha'"
else
  warn "Skipping npm publish (--no-publish)"
fi

# ── Step 9: Optional deploy ─────────────────────────────
if $DO_DEPLOY; then
  if ! $DO_PUBLISH; then
    fail "--deploy requires npm publish (don't combine --no-publish + --deploy)"
    exit 1
  fi
  log "Deploying to .92 and .93..."
  for HOST in 192.168.1.92 192.168.1.93; do
    log "  → $HOST: install + restart"
    if $DRY_RUN; then
      printf '\033[35m[dry-run]\033[0m ssh madh@%s "sudo npm install -g @madh-io/alfred-ai@multi-ha && sudo systemctl restart alfred"\n' "$HOST"
    else
      if ! ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=no "madh@${HOST}" \
        "sudo npm install -g @madh-io/alfred-ai@multi-ha && sudo systemctl restart alfred"; then
        fail "Deploy to $HOST failed"
        exit 6
      fi
      ok "  ✓ $HOST deployed + restarted"
    fi
  done
  ok "Deployment complete on both nodes"
fi

# ── Summary ─────────────────────────────────────────────
echo
ok "Release $NEW_VERSION complete"
echo "  Branch:   $CURRENT_BRANCH"
echo "  Commit:   $(git rev-parse --short HEAD)"
if $DO_PUBLISH; then
  echo "  Package:  @madh-io/alfred-ai@${NEW_VERSION} (tag: multi-ha)"
fi
if $DO_DEPLOY; then
  echo "  Deployed: .92 + .93"
else
  echo "  Deploy:   skipped — run with --deploy or manually:"
  echo "            ssh madh@192.168.1.92 'sudo npm install -g @madh-io/alfred-ai@multi-ha && sudo systemctl restart alfred'"
fi
