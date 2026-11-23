@echo off
rem Arranca todo: datos en vivo + servidor del visor, cada uno en su ventana, y abre el navegador
cd /d "%~dp0"

rem Datos en vivo (si ya hay una ventana del colector abierta, no se abre otra)
tasklist /v /fi "WINDOWTITLE eq city3d - datos en vivo*" | find /i "cmd.exe" >nul
if errorlevel 1 (start "city3d - datos en vivo" "%~dp0iniciar_vivo.bat") else (echo El colector de datos en vivo ya estaba en marcha.)

rem Visor (si el servidor ya escucha en el puerto 8000, solo se abre el navegador)
netstat -ano | find ":8000 " | find "LISTENING" >nul
if errorlevel 1 (start "city3d - visor" "%~dp0abrir_visor.bat") else (start "" "http://localhost:8000/visor/")

echo Todo en marcha. Para pararlo, cierra las ventanas "city3d - datos en vivo" y "city3d - visor".
timeout /t 5 >nul
