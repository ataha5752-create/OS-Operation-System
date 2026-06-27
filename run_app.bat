@echo off
title Ops Reporting System - Bootstrapper
echo ========================================================
echo        Ops Reporting System - Express & SQLite Setup
echo ========================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js was NOT found on your system!
    echo.
    echo Please follow these steps to continue:
    echo 1. Open your browser and go to: https://nodejs.org/
    echo 2. Download and run the installer for the "LTS" version.
    echo 3. Once installed, close this window and double-click "run_app.bat" again.
    echo.
    pause
    exit
)

echo [INFO] Node.js is detected!
echo [INFO] Installing required packages (express, sqlite3, bcryptjs, jsonwebtoken, cors)...
echo.
call npm install

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Failed to install dependencies! Please check your internet connection and try again.
    pause
    exit
)

echo.
echo [INFO] All packages installed successfully.
echo [INFO] Starting the backend server...
echo [INFO] The dashboard will open automatically in your browser.
echo.

:: Start the browser pointing to local server in 2 seconds
timeout /t 2 /nobreak >nul
start https://localhost:3000

:: Start the Express server
npm start
pause
