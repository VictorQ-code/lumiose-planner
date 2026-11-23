# city3d · pipeline del barrio de prueba

Primer tramo del gemelo digital de Barcelona: edificios (con sótanos) y metro de un barrio,
listos para el visor 3D en estilo tinta sepia.

```
Catastro INSPIRE ─┐
                  ├─► bronze (descargas tal cual) ─► silver (GeoParquet limpio) ─► gold (teselas JSON + informe)
Open Data BCN ────┘                                                                      ▲
GTFS TMB ────────────────────────────────────────────────────────────────────────────────┘ metro.json
```

## Instalación (una vez)

Necesitas Python 3.10 o superior.

```bash
cd city3d
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## 1. Edificios del barrio

```bash
python pipeline/edificios_barrio.py --barrio "la Dreta de l'Eixample"
```

La primera vez descarga el Catastro de **todo Barcelona** (un zip grande) y lo convierte a GeoParquet.
Las siguientes ejecuciones, para este u otro barrio, reutilizan ese silver y tardan segundos.

- Ver los nombres de barrio válidos: `python pipeline/edificios_barrio.py --listar-barrios`
- Si la descarga automática del Catastro falla (a veces cambian el feed), descarga el zip de
  edificios de Barcelona desde el servicio ATOM INSPIRE del Catastro y pásalo:
  `--zip-file ruta/A.ES.SDGC.BU.08900.zip`
- `--forzar` vuelve a descargar y recalcular todo.

**Resultado** en `data/gold/la-dreta-de-l-eixample/`:

| Fichero | Contenido |
|---|---|
| `index.json` | origen de coordenadas (EPSG:25831 y lon/lat), contorno del barrio, lista de teselas, estadísticas |
| `tiles/X_Y.json` | partes de edificio de cada tesela de 250 m |
| `preview.png` | mapa de alturas y distribuciones, para comprobar a ojo que todo cuadra |
| `informe.md` | cifras básicas del barrio (tu primer mini informe) |

Cada parte de edificio en las teselas:

```json
{"id":"…_part1","h":22.0,"d":6.0,"f":7,"fb":2,"y":1912,"u":"residential",
 "o":[[x,z],…],"i":[[[x,z],…]]}
```

- `h` altura sobre la calle (m), `d` profundidad de sótanos (m), `f`/`fb` plantas sobre y bajo rasante
- `y` año de construcción, `u` uso
- `o` contorno exterior e `i` patios interiores, en metros locales: **x = este, z = sur**, origen en el centro del barrio

Alturas estimadas: planta baja 4 m + 3 m por planta; sótanos 3 m por planta (constantes al inicio del script).

## 2. Metro bajo el barrio (opcional)

1. Crea una aplicación gratuita en developer.tmb.cat para obtener `APP_ID` y `APP_KEY`.
2. Ejecuta:

Crea un fichero `.env` en la carpeta del proyecto (git lo ignora) con:

```
TMB_APP_ID=tu_id
TMB_APP_KEY=tu_clave
```

y ejecuta:

```bash
python pipeline/metro_barrio.py --barrio "la Dreta de l'Eixample"
```

Produce `metro.json` con el trazado de cada línea en la zona, su color oficial y las estaciones.
**La profundidad de cada línea es una estimación**, no un dato oficial: está en `PROFUNDIDAD_ESTIMADA`
dentro del script para que la ajustes.

## 3. Simplificar para dibujar (recomendado)

```bash
python pipeline/generalizar_barrio.py --barrio "la Dreta de l'Eixample"
```

Generalización cartográfica: cada edificio pasa de muchas partes del Catastro a 1–3 volúmenes limpios
(cuerpo principal, torre, bajos de patio) más su sótano. Hace el dibujo legible y el visor mucho más ligero.
Escribe `data/gold/<barrio>/lod1/` y el visor lo usa automáticamente.

## 4. Visor 3D del barrio

Haz doble clic en `abrir_visor.bat` (o ejecuta `python -m http.server 8000` en esta carpeta y entra en
http://localhost:8000/visor/). El navegador no deja leer los datos si abres `visor/index.html` directamente.

- **Ciudad**: edificios del Catastro en tinta sepia, contornos como efecto de pantalla y sombras a plumilla.
  Pasa el ratón por un edificio para ver su referencia, plantas, año y uso.
- **Subsuelo**: edificios en línea fantasma, tierra en corte, sótanos y túneles de metro con trenes simulados.
- **Test de rendimiento**: botón arriba a la derecha. Mide dibujo e interacción simulada (girar, desplazar, zoom con rueda y touchpad, pasar el ratón, cambiar de modo) y genera un informe para copiar.
- Otro barrio ya procesado: `http://localhost:8000/visor/?barrio=nombre-del-barrio`.

## Toda Barcelona

```bash
python pipeline/ciudad.py                          # 73 barrios, en paralelo con todos los núcleos
python pipeline/metro_barrio.py --barrio barcelona  # red de metro completa
python pipeline/mapa_base.py                        # parques, agua, playas, calles y monumentos (OpenStreetMap)
python pipeline/suelo.py                            # marcas viales, pasos de cebra, carril bici, vías, aparcamientos y árboles
```

Orden importante: `mapa_base.py` marca los edificios de los monumentos dentro de las teselas, así que
**si vuelves a ejecutar `ciudad.py`, ejecuta después `mapa_base.py` y `suelo.py`** (usan la caché, tardan poco).
La lista de monumentos está al principio de `mapa_base.py`: puedes añadir los que quieras.

`ciudad.py` reutiliza el silver del Catastro y genera `data/gold/barcelona/` con dos niveles de detalle:
**lod1** (volúmenes por edificio, teselas de 250 m) para ver de cerca y **lod2** (una manzana = un volumen,
más las torres que destacan, en bloques de 1 km) para ver la ciudad entera. El visor abre Barcelona por defecto,
carga el detalle solo de la zona que miras (en segundo plano, con Web Workers) y libera la memoria de lo que dejas atrás.
Un barrio suelto sigue funcionando con `http://localhost:8000/visor/?barrio=la-dreta-de-l-eixample`.

## Datos en vivo (flujo de big data)

```bash
python pipeline/red_viaria.py      # una vez: grafo de calles para los vehículos (usa la caché de mapa_base.py)
python pipeline/buses.py           # autobuses y metro de TMB: recorridos y horarios del GTFS (buses.json + metro_horario.json) (reejecutar cuando TMB publique horarios nuevos)
python pipeline/vivo.py            # déjalo abierto en otra ventana: captura Bicing (1 min), tráfico (5 min) y tiempo (15 min)
python pipeline/vivo.py --estado   # cuánto histórico se ha acumulado
```

Cada captura recorre las tres capas del lakehouse:

| Capa | Dónde | Qué guarda |
|---|---|---|
| bronze | `data/stream/bronze/<fuente>/fecha=AAAA-MM-DD/` | la respuesta original de la API, comprimida |
| silver | `data/stream/silver/<fuente>/fecha=…/*.parquet` | registros limpios con esquema común (`fuente, ts_captura, id, x, z, …`) |
| silver | `data/stream/silver/<fuente>_eventos/` | cambios entre capturas: bicis cogidas/dejadas, tramos que cambian de estado |
| gold | `data/gold/barcelona/vivo/*.json` + `manifest.json` | último estado, compacto, que lee el visor cada 30 s |

El visor dibuja lo que encuentra: tramos de tráfico coloreados por estado, coches y autobuses circulando por la red viaria
con la densidad y velocidad del tráfico real (de cerca), barras de Bicing por estación y el tiempo en el panel «En vivo».
Para añadir una fuente: una clase en `pipeline/vivo.py` (capturar, normalizar, eventos, gold) y un manejador en `visor/vivo.js`.

## Si algo falla

Es la primera ejecución contra los servicios reales: es normal que haya que ajustar algún nombre de
campo. El script imprime las columnas disponibles cuando no encuentra una; copia el error completo
y lo corregimos.

## Fuentes y licencias

- Edificios: Dirección General del Catastro, INSPIRE Buildings.
- Límites de barrio: Ajuntament de Barcelona, Open Data BCN (CC BY 4.0).
- Metro: TMB, GTFS (requiere registro).

Cita las fuentes en la web del proyecto.
