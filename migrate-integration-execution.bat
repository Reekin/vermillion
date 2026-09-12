@echo off
setlocal
echo This converts legacy integration takeover records and creates backups.
echo Exit the application owning the target workspace before continuing.
set "TARGET=%~1"
if not defined TARGET set /p "TARGET=Workspace directory: "
if not defined TARGET exit /b 1
choice /m "Has the owning application exited"
if errorlevel 2 exit /b 1
node "%~dp0scripts\migrate-integration-execution.mjs" "%TARGET%" --owner-stopped
pause
