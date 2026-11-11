@echo off
setlocal
cd /d "%~dp0"
node -e "const [major,minor]=process.versions.node.split('.').map(Number); process.exit(major>22 || (major===22 && minor>=13) ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
  echo Node.js 22.13 or later is required. Install it from https://nodejs.org/.
  pause
  exit /b 1
)
if not exist .env (
  echo .env is missing. Double-click setup.bat first.
  pause
  exit /b 1
)
start "NEXORAGPT Server" cmd /k npm start
timeout /t 2 /nobreak >nul
start "" http://localhost:3000
