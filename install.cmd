@echo off
setlocal
cd /d "%~dp0"
node -e "process.exit(0)"
if errorlevel 1 (
  echo Node.js was not found. Install Node 20 or newer first: https://nodejs.org/
  echo ^(OpenCode needs 22.5+; the rest works on 20.^)
  pause
  exit /b 1
)
node tool\bin\convledger.mjs setup %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo.
if not "%RC%"=="0" echo setup failed with exit %RC% - see the message above.
if not defined CONVLEDGER_NO_PAUSE pause
exit /b %RC%
