@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call pnpm install || exit /b 1
)
if not exist apps\desktop\dist-electron\main.js (
  call pnpm --filter @vermillion/desktop build || exit /b 1
)
call pnpm --filter @vermillion/desktop start
