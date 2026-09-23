@echo off
cd /d "%~dp0"
node scripts\diagnose-session-loads.mjs %*
if "%~1"=="" pause
