@echo off
rem bf - BusinessFactory task board CLI
if not defined NODE_COMPILE_CACHE set "NODE_COMPILE_CACHE=%~dp0..\node_modules\.cache\bf-compile"
node "%~dp0..\engine\src\cli.ts" %*
