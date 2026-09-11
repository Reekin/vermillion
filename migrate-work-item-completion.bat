@echo off
setlocal
echo Close all Vermillion instances before running this one-time migration.
echo It adds contract revisions, converts old verification booleans to explicit statuses, and writes backups.
node "%~dp0scripts\migrate-work-item-completion.mjs" %*
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" echo Migration stopped without completing all records.
exit /b %exitCode%
