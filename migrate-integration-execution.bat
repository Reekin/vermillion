@echo off
setlocal
echo This converts legacy integration takeover records and creates backups.
echo Registered workspaces are discovered automatically.
echo Exit the application before continuing.
choice /m "Has the owning application exited"
if errorlevel 2 exit /b 1
node "%~dp0scripts\migrate-integration-execution.mjs" --owner-stopped
pause
