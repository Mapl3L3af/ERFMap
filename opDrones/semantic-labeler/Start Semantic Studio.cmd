@echo off
rem Windows launcher: starts the erfMap server and opens Semantic Studio.
cd /d "%~dp0.."
where node >nul 2>nul || (echo Install Node.js 20 or later from https://nodejs.org, then try again. & pause & exit /b 1)
if not defined PORT set PORT=3000
echo Semantic Studio: http://localhost:%PORT%/semantic-labeler/
echo Keep this window open while labeling.
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%/semantic-labeler/"
node server.js
pause
