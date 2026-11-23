@echo off
rem Abre el visor con un servidor local. El navegador se abre cuando el servidor ya responde
rem (antes se abria a la vez y, con el PC recien encendido, la pagina podia cargar a medias).
cd /d "%~dp0"
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 80;$i++){ try{ (New-Object Net.Sockets.TcpClient('127.0.0.1',8000)).Close(); break }catch{ Start-Sleep -Milliseconds 250 } }; Start-Process 'http://localhost:8000/visor/'"
python servidor.py 8000
