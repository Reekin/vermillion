@echo off
setlocal
cd /d "%~dp0"
echo Checking dependencies...
call pnpm install --frozen-lockfile || exit /b 1
node scripts/needs-build.mjs
if errorlevel 1 (
  echo Building...
  call pnpm -r --workspace-concurrency=1 build || exit /b 1
)
call pnpm --filter @vermillion/desktop start
