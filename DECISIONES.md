# Proyecto ciudad · decisiones tomadas

Gemelo digital de Barcelona en 3D para portfolio de big data e IA, inspirado en CityRT pero sin parte jugable.

## Alcance
- Ciudad: **Barcelona** (mucho histórico descargable en Open Data BCN).
- Objetivo: web siempre operativa + informes detallados generados desde los datos.
- Presupuesto: portátil sin GPU + VPS pequeño (~5–10 €/mes). LLM por API cuando haga falta.

## Fuentes
- En tiempo real: tráfico por tramos (cada 5 min, con previsión a 15 min), Bicing (token), calidad del aire (horaria), Rodalies GTFS-RT (posiciones reales), meteo.
- Estimado: autobuses TMB (llegadas por parada, no GPS) y metro (posición teórica según GTFS).
- Tráfico en calles sin sensor: "sensor virtual" con un modelo sobre el grafo de OSM, validado con TomTom (no Google Maps, por sus términos).
- 3D: Catastro INSPIRE (plantas sobre y bajo rasante, año), terreno ICGC, arbolado de Open Data BCN.

## Estilo visual
- **Tinta sepia retocada** (boceto renacentista): contorno grueso, aguadas suaves por material, sombras a plumilla, trama solo en las caras en sombra.
- Datos en vivo en color sobre la ciudad dibujada.
- Cámara ortográfica estilo CityRT, motor Three.js.
- Subsuelo en vista de corte: edificios en línea fantasma, tierra con trama de estratos, túneles limpios.

## Para escalar a toda la ciudad
Contornos como posprocesado de pantalla, sombras y oclusión precalculadas en el pipeline, teselas con 3 niveles de detalle, todo estático en Cloudflare R2.

## Estado
1. Pipeline del barrio de prueba (la Dreta de l'Eixample): `pipeline/edificios_barrio.py` y `pipeline/metro_barrio.py`. Pendiente de la primera ejecución real.
2. Siguiente paso: el visor del barrio con datos reales en el estilo elegido.
