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
rem 按 Agent 选装，不再一键把所有检测到的全装上：
rem   install.cmd              列出现有 Agent，问你装哪一个
rem   install.cmd qoder        只装 Qoder（每家也有独立脚本 install-<agent>.cmd）
rem   install.cmd all          装全部
rem   install.cmd --check      只体检不写
set "FIRST=%~1"
if "%FIRST%"=="" (
  node tool\bin\convledger.mjs setup --choose
) else (
  echo %FIRST% | findstr /b /c:"-" >nul
  if errorlevel 1 (
    node tool\bin\convledger.mjs setup --client %FIRST%
  ) else (
    node tool\bin\convledger.mjs setup %*
  )
)
set RC=%ERRORLEVEL%
if not "%RC%"=="0" echo.
if not "%RC%"=="0" echo setup failed with exit %RC% - see the message above.
if not defined CONVLEDGER_NO_PAUSE pause
exit /b %RC%
