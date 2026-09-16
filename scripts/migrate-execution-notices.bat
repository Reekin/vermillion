@echo off
setlocal
cd /d "%~dp0\.."
echo Converts stored work items in this workspace from execution.message to execution.notices.
echo Impact: rewrites .vermillion\workitems\*.json in place; the pending delivery text is kept as one notice.
echo Close the Vermillion desktop before continuing, or its in-memory copy will overwrite this change.
set /p answer="Type Y to convert %CD%: "
if /i not "%answer%"=="Y" (echo Cancelled.& exit /b 1)
node scripts\migrate-execution-notices.mjs "%CD%" --yes || exit /b 1
echo Done.
