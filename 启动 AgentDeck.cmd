@echo off
setlocal
title AgentDeck
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-agentdeck.ps1" %*
exit /b %errorlevel%
