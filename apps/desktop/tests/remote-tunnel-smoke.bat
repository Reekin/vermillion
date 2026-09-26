@echo off
node "%~dp0remote-tunnel-smoke.mjs" %*
exit /b %errorlevel%
