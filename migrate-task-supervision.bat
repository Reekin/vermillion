@echo off
setlocal
if "%~1"=="" (
  node "%~dp0scripts\migrate-task-supervision.mjs" --help
  pause
  exit /b 0
)
node "%~dp0scripts\migrate-task-supervision.mjs" %*
exit /b %errorlevel%
