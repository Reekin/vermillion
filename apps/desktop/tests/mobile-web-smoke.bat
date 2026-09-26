@echo off
setlocal
node "%~dp0mobile-web-smoke.mjs" %*
exit /b %errorlevel%
