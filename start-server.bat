@echo off
title SSH Remote File Viewer Server

echo [INFO] Starting the SSH Remote File Viewer server...

:: Start the Node.js server
node server.js &

echo [INFO] Server is running. Opening the web browser...
timeout /t 2 /nobreak > nul

:: Open the default web browser to the application URL
start http://localhost:3000

echo [INFO] The browser has been opened. The server is running in the background.
