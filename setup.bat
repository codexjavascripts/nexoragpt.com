@echo off
setlocal
cd /d "%~dp0"
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22 || (major===22 && minor>=13) ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.13 or later is required. Install it from https://nodejs.org/ and run setup again.
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
echo Installing the file and mail support packages...
npm install
if errorlevel 1 (
  echo Setup could not install packages. Check your internet connection and try again.
  pause
  exit /b 1
)
echo.
echo Setup is complete. Edit .env only if you want to change AI Horde or plugin settings.
echo Then double-click start.bat to launch NEXORAGPT.
pause
