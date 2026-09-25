#!/bin/sh
# macOS one-click start: double-click in Finder, or run ./start.command.
cd "$(dirname "$0")" || exit 1
echo "Checking dependencies..."
pnpm install --frozen-lockfile || exit 1
if ! node scripts/needs-build.mjs; then
  echo "Building..."
  pnpm -r --workspace-concurrency=1 build || exit 1
fi
exec pnpm --filter @vermillion/desktop start
