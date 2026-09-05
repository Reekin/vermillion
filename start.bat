@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call pnpm install || exit /b 1
)
node scripts/needs-build.mjs
if errorlevel 1 (
  echo Building...
  call pnpm -r --workspace-concurrency=1 build || exit /b 1
)
call pnpm --filter @vermillion/desktop start
