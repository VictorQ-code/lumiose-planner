@echo off
rem Pone en marcha el flujo de datos en vivo (Bicing, trafico, tiempo y retrasos de bus) para el visor
cd /d "%~dp0"
title city3d - datos en vivo
set "PY=python"
if exist ".venv\Scripts\python.exe" set "PY=.venv\Scripts\python.exe"
echo Datos en vivo en marcha. Deja esta ventana abierta; cierrala o pulsa Ctrl+C para parar.
echo.
"%PY%" pipeline\vivo.py
echo.
echo El colector se ha parado. Si ves un error arriba, copialo y pasamelo.
pause
