@echo off
setlocal
set "TARGET=%~1"
if not defined TARGET set "TARGET=%~dp0"
node "%~dp0scripts\prepare-worktree.mjs" --worktree "%TARGET%"
exit /b %errorlevel%
