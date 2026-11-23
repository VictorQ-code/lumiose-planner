# city3d · gemelo digital 3D de Barcelona

Proyecto de portfolio de big data e IA: Barcelona entera en 3D en el navegador (ciudad + subsuelo/metro) con datos en vivo, estilo boceto "tinta sepia retocada". Debe ir fluido en un portátil sin gráfica dedicada (AMD Radeon integrada, Windows, Chrome). Responde siempre en español.

Lee también `CONTEXTO_COMPLETO.md` (todo el detalle: arquitectura, formatos, decisiones, tests, problemas resueltos y pendientes), `README.md` (orden de ejecución) y `DECISIONES.md` (alcance inicial).

## Reglas
- **Nunca** leas, muestres ni subas `.env` (claves de TMB). Las URLs con claves no se guardan en bronze.
- No crees copias duplicadas de archivos en el PC. Edita en su sitio.
- No borres archivos sin preguntar.
- Python: usa el entorno `.venv` (`.venv\Scripts\python.exe`).
- El usuario no es desarrollador de videojuegos: explica en lenguaje claro y en español.

## Cómo se arranca
- `iniciar_todo.bat`: colector de datos en vivo (`pipeline\vivo.py`) + servidor del visor (`servidor.py`, puerto 8000) + navegador en `http://localhost:8000/visor/`.
- Pipeline estático (solo si cambian los datos): ver README, sección de orden de ejecución.

## Arquitectura en dos líneas
- `pipeline/`: Python. Catastro/OSM/Open Data → teselas en `data/gold/barcelona/`. `vivo.py` = streaming por sondeo con capas bronze/silver/gold + `manifest.json` (Bicing, tráfico, Open-Meteo, iBus de TMB).
- `visor/`: Three.js r128. `index.html` = ciudad, LOD, subsuelo, test de rendimiento (`runCityTest`). `vivo.js` = capas en vivo, enganchadas por `window.CITY3D.frameHooks`.

## Estado de `visor/vivo.js` (lo más vivo)
- Coches: IDM sobre `red.json`, semáforos de 2 fases, cruces ocupados, aparcados desde plazas de `suelo`.
- Buses: horario GTFS + retraso real iBus; paran en rojo y ceden en cruces.
- Ciclistas: eventos reales de Bicing, ruta A* por `bici.json`, paran en rojo.
- Metro: `metro_horario.json` (horario real), solo en «Subsuelo».
- Tiempo: altura real del sol, nubes ancladas al suelo que viajan con el viento, lluvia/nieve con texturas, niebla, relámpagos, árboles que se mecen; botón «Clima» para forzar sol/nublado/lluvia/nieve/tormenta/niebla/atardecer/noche.
- Alumbrado: ~97.500 farolas + focos en 22 monumentos (un único `THREE.Points` aditivo), de noche y con niebla/nieve/tormenta.
- Cargas con reintento; depuración en `window.__vivo` (`stats()`, `wx()`, `setWx()`, `wxSnap()`).

## Rendimiento
- Mide con el **test exhaustivo** (botón «Test de rendimiento»): 11 fases, incluye capas en vivo y «Tiempo y alumbrado» (coste de cada clima frente a sol en el mismo test).
- El portátil se calienta y baja de velocidad entre tests seguidos: compara siempre dentro del mismo test.
- Lo caro en la GPU integrada son los píxeles pintados (relleno), no los vértices: evita pasadas a pantalla completa y sprites grandes.

## Pendiente
1. Colector en la nube (GitHub Actions u otro gratuito) para acumular histórico 24 h.
2. Personas estimadas (aceras, pasos de cebra, bocas de metro según horario, paradas de bus, hora y lluvia).
3. Análisis sobre el histórico y modelos de predicción (tráfico, Bicing a 30 min).
