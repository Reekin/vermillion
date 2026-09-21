@echo off
setlocal
cd /d "%~dp0"
call pnpm exec tsx scripts/benchmark-session-history-reuse.mjs %*
set "BENCHMARK_EXIT=%ERRORLEVEL%"
if not "%BENCHMARK_EXIT%"=="0" echo Benchmark failed with exit code %BENCHMARK_EXIT%.
exit /b %BENCHMARK_EXIT%
