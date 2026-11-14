@echo off
rem Double-click to build the Cutline installers. Needs Node.js 22 or newer.
node "%~dp0build.mjs" %*
pause
