# city3d · Lumiose Planner · gemelo digital 3D de Barcelona

Proyecto de portfolio de big data e IA: Barcelona entera en 3D en el navegador (ciudad + subsuelo/metro) con datos en vivo, estilo boceto "tinta sepia retocada". Debe ir fluido en un portátil sin gráfica dedicada (AMD Radeon integrada), en sobremesa con ratón y en móvil. Responde siempre en español.

**Empieza leyendo la sección 0 de `CONTEXTO_COMPLETO.md`** (estado a 25/11/2026, dónde vive todo, lo pendiente y el plan de datos para la IA). Después, si hace falta, el resto de ese archivo, `README.md` y `DECISIONES.md`.

## Reglas
- **Nunca** leas, muestres ni subas `.env` (claves de TMB). Las URLs con claves no se guardan en bronze. Las credenciales (TMB, R2, GitHub) las pone siempre el usuario.
- No crees copias duplicadas de archivos en el PC. Edita en su sitio.
- No borres archivos sin preguntar.
- Python: usa el entorno `.venv` (`.venv\Scripts\python.exe`).
- El usuario no es desarrollador de videojuegos: explica en lenguaje claro y en español. No quiere tocar nada a mano: todo gratis y automático.
- **Prueba siempre en la web publicada** (https://lumiose.victorquero.dev/visor/ y la incrustada en victorquero.dev), no en localhost: commit + push a `main`, esperar el despliegue (40–80 s) y probar con el navegador integrado (con el panel visible).
- Cloudflare: CLI `cf` para R2 y builds; `wrangler.jsonc` existe (deploy lo hace Workers Builds al hacer push).

## Dónde vive todo
- Repositorio GitHub `VictorQ-code/lumiose-planner` (rama `main`) → Cloudflare Workers Builds publica la web.
- `worker/index.js`: cron cada minuto → capturas a R2 (`lumiose-datos/bronze/…`): Bicing, tráfico, tiempo, iBus TMB, incidencias (Ayuntamiento y SCT). API `/api/estado`, `/api/ibus`, `/api/incidencias`, `POST /api/error` (informes del visor → `errores/`).
- `.github/workflows/compactar.yml` + `pipeline/compactar_nube.py`: cada noche bronze → `historico/` (día → semana → mes → año → década, Parquet) y rehace `vivo/tranvia.json`.
- `pipeline/`: Python estático (Catastro/OSM/Open Data → `data/gold/barcelona/`), `buses.py` (TMB + NitBus del AMB), `tranvia.py`, `callejero.py`.
- `visor/`: Three.js r128. `index.html` = ciudad, cámara, LOD, subsuelo, test de rendimiento. `vivo.js` = capas en vivo (`window.CITY3D.frameHooks`).

## Estado de `visor/vivo.js`
- Coches (IDM, semáforos, visibles hasta 2,2 m/px), buses TMB + NitBus (horario + retraso iBus), tranvía (horario TRAM, prioridad en cruces), ciclistas (Bicing real), personas, metro (Subsuelo).
- Incidencias reales en el mapa (escenas animadas + aviso a cualquier zoom), situadas con el callejero.
- Tiempo y alumbrado (shaders por variante para no pagar los `if` en ANGLE).
- Capas protegidas por separado, informes de error/diagnóstico a `/api/error`; depuración en `window.__vivo.stats()`.

## Rendimiento
- Lo caro en la GPU integrada son los píxeles pintados y los `if` de los shaders (en ANGLE/D3D se ejecutan enteros): usa variantes con `#define`.
- Para medir: el panel del navegador visible; forzar el pintado con `readPixels` de 1 px (no `gl.finish`).

## Pendiente (detalle en CONTEXTO_COMPLETO §0.3–0.4)
1. Comprobar la primera noche del flujo nuevo (bronze → `silver/` → `gold/` + `catalogo/`, hecho el 25/11): log de GitHub, `catalogo/LEEME.md` y `catalogo/calidad.parquet` en R2.
2. Gold listo para entrenar (25/11): retrasos de bus (`bus_llegadas`, `bus_retrasos_15min`, `entreno_bus`) e incidencias situadas (`pipeline/situar.py`) con rasgos `inc_*` en todas las `entreno_*`. Falta acumular días.
3. Informe del ordenador del hermano (lag): mirar `errores/` en R2.
4. Incidencias del SCT en el mapa; luego calidad del aire, festivos, agenda.
