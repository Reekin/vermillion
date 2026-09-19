@echo off
setlocal
cd /d "%~dp0\.."
echo Converts stored work items from execution.message to execution.notices.
echo Scope: every workspace in the registry, or only the roots passed as arguments.
echo Impact: rewrites .vermillion\workitems\*.json in place; the pending delivery text is kept as one notice.
echo Close the Vermillion desktop before continuing, or its in-memory copy will overwrite this change.
node scripts\migrate-execution-notices.mjs %*
set /p answer="Type Y to convert the workspaces listed above: "
if /i not "%answer%"=="Y" (echo Cancelled.& exit /b 1)
node scripts\migrate-execution-notices.mjs %* --yes || exit /b 1
echo Done.
