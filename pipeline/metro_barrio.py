#!/usr/bin/env python3
"""Líneas y estaciones de metro bajo un barrio, a partir del GTFS de TMB.

Requiere haber ejecutado antes edificios_barrio.py (usa su index.json para el origen y el recorte).

Uso:
    export TMB_APP_ID=...  TMB_APP_KEY=...          # claves gratuitas de developer.tmb.cat
    python pipeline/metro_barrio.py --barrio "la Dreta de l'Eixample"
    # o con el GTFS ya descargado:
    python pipeline/metro_barrio.py --barrio "la Dreta de l'Eixample" --gtfs ruta/gtfs.zip

Produce data/gold/<barrio>/metro.json con el trazado de cada línea (en metros locales),
su color oficial, una profundidad ESTIMADA y las estaciones con las líneas que pasan.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, CRS, GOLD, descargar, log, slug  # noqa: E402

GTFS_URL = "https://api.tmb.cat/v1/static/datasets/gtfs.zip?app_id={id}&app_key={key}"

# Profundidad media orientativa de cada línea, en metros bajo la calle.
# NO son datos oficiales: son un punto de partida para la visualización.
# Ajústalos con información pública de estaciones concretas cuando la tengas.
PROFUNDIDAD_ESTIMADA = {
    "L1": 15, "L2": 25, "L3": 18, "L4": 18, "L5": 22,
    "L9N": 45, "L9S": 45, "L10N": 45, "L10S": 45, "L11": 12, "FM": 10,
}
PROFUNDIDAD_POR_DEFECTO = 20
MARGEN = 400  # metros alrededor del barrio que se conservan del trazado


def leer_gtfs(zip_path: Path):
    import pandas as pd

    with zipfile.ZipFile(zip_path) as z:
        nombres = set(z.namelist())

        def tabla(nombre, **kw):
            if nombre not in nombres:
                raise SystemExit(f"El GTFS no contiene {nombre}: {sorted(nombres)}")
            with z.open(nombre) as f:
                return pd.read_csv(f, dtype=str, **kw)

        routes = tabla("routes.txt")
        trips = tabla("trips.txt")
        stops = tabla("stops.txt")
        shapes = tabla("shapes.txt") if "shapes.txt" in nombres else None
        stop_times = tabla("stop_times.txt", usecols=["trip_id", "stop_id", "stop_sequence"])
    return routes, trips, stops, shapes, stop_times


def main() -> None:
    import pandas as pd
    from pyproj import Transformer
    from shapely.geometry import LineString, Point, box

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--barrio", default="la Dreta de l'Eixample")
    ap.add_argument("--gtfs", help="ruta a un gtfs.zip de TMB ya descargado")
    ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args()

    salida = GOLD / slug(a.barrio)
    indice_path = salida / "index.json"
    if not indice_path.exists():
        raise SystemExit(f"No existe {indice_path}. Ejecuta antes edificios_barrio.py con el mismo --barrio.")
    indice = json.loads(indice_path.read_text(encoding="utf-8"))
    ox, oy = indice["origin"]

    if a.gtfs:
        gtfs = Path(a.gtfs)
    else:
        env = Path(__file__).resolve().parents[1] / ".env"   # claves en city3d\.env (ignorado por git)
        if env.exists():
            for linea in env.read_text(encoding="utf-8").splitlines():
                if "=" in linea and not linea.strip().startswith("#"):
                    k, v = linea.split("=", 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        app_id, app_key = os.environ.get("TMB_APP_ID"), os.environ.get("TMB_APP_KEY")
        if not app_id or not app_key:
            raise SystemExit("Faltan TMB_APP_ID y TMB_APP_KEY: ponlas en el fichero .env de la carpeta del proyecto (ver README) o pasa --gtfs.")
        gtfs = descargar(GTFS_URL.format(id=app_id, key=app_key), BRONZE / "tmb" / "gtfs.zip", forzar=a.forzar)

    log("leyendo GTFS de TMB")
    routes, trips, stops, shapes, stop_times = leer_gtfs(gtfs)
    metro = routes[routes["route_type"].astype(int) == 1].copy()
    if metro.empty:
        raise SystemExit("No hay rutas de metro (route_type=1) en el GTFS.")
    metro["nombre"] = metro["route_short_name"].fillna(metro.get("route_long_name", "")).str.strip()
    log(f"líneas de metro: {', '.join(metro['nombre'])}")

    a_utm = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    xs = [p[0] for p in indice["outline"]]
    zs = [p[1] for p in indice["outline"]]
    recorte = box(min(xs) - MARGEN, min(zs) - MARGEN, max(xs) + MARGEN, max(zs) + MARGEN)

    def local(lon, lat):
        x, y = a_utm.transform(float(lon), float(lat))
        return round(x - ox, 1), round(-(y - oy), 1)

    lineas = []
    trips_metro = trips[trips["route_id"].isin(metro["route_id"])]
    for r in metro.itertuples():
        t = trips_metro[trips_metro["route_id"] == r.route_id]
        trazos = []
        if shapes is not None and "shape_id" in t.columns and t["shape_id"].notna().any():
            # Los dos recorridos más frecuentes (uno por sentido suele bastar)
            for shape_id in t["shape_id"].value_counts().index[:2]:
                s = shapes[shapes["shape_id"] == shape_id].copy()
                s["shape_pt_sequence"] = s["shape_pt_sequence"].astype(int)
                s = s.sort_values("shape_pt_sequence")
                pts = [local(lo, la) for lo, la in zip(s["shape_pt_lon"], s["shape_pt_lat"])]
                trazos.append(pts)
        else:
            # Sin shapes: unir las paradas en orden del viaje más largo
            st = stop_times[stop_times["trip_id"].isin(t["trip_id"])]
            largo = st.groupby("trip_id").size().idxmax()
            orden = st[st["trip_id"] == largo].assign(seq=lambda d: d["stop_sequence"].astype(int)).sort_values("seq")
            pos = stops.set_index("stop_id").loc[orden["stop_id"], ["stop_lon", "stop_lat"]]
            trazos.append([local(lo, la) for lo, la in pos.itertuples(index=False)])

        tramos = []
        for pts in trazos[:1] if len(trazos) else []:  # un sentido basta para dibujar el túnel
            if len(pts) < 2:
                continue
            g = LineString(pts).intersection(recorte)
            partes = [g] if g.geom_type == "LineString" else list(getattr(g, "geoms", []))
            tramos += [[list(c) for c in p.coords] for p in partes if p.geom_type == "LineString" and len(p.coords) > 1]
        if not tramos:
            continue
        color = getattr(r, "route_color", None)
        lineas.append({
            "name": r.nombre,
            "color": f"#{color}" if isinstance(color, str) and color else None,
            "depth_m": PROFUNDIDAD_ESTIMADA.get(r.nombre, PROFUNDIDAD_POR_DEFECTO),
            "depth_is_estimate": True,
            "paths": tramos,
        })

    # Estaciones: paradas servidas por viajes de metro, agrupadas por estación padre si existe
    st = stop_times[stop_times["trip_id"].isin(trips_metro["trip_id"])][["trip_id", "stop_id"]].drop_duplicates()
    st = st.merge(trips_metro[["trip_id", "route_id"]], on="trip_id").merge(metro[["route_id", "nombre"]], on="route_id")
    paradas = stops.set_index("stop_id")
    if "parent_station" in stops.columns:
        padre = paradas["parent_station"].where(paradas["parent_station"].notna() & (paradas["parent_station"] != ""))
        st["estacion"] = st["stop_id"].map(padre).fillna(st["stop_id"])
    else:
        st["estacion"] = st["stop_id"]
    estaciones = []
    for est_id, grupo in st.groupby("estacion"):
        if est_id not in paradas.index:
            continue
        fila = paradas.loc[est_id]
        x, z = local(fila["stop_lon"], fila["stop_lat"])
        if not recorte.contains(Point(x, z)):
            continue
        estaciones.append({"name": fila["stop_name"], "x": x, "z": z, "lines": sorted(grupo["nombre"].unique())})

    out = {
        "barrio": indice["barrio"],
        "source": "TMB (GTFS) · profundidades estimadas, no oficiales",
        "lines": lineas,
        "stations": sorted(estaciones, key=lambda e: e["name"]),
    }
    (salida / "metro.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"metro.json: {len(lineas)} líneas y {len(estaciones)} estaciones en la zona")
    for l in lineas:
        log(f"  {l['name']}: {sum(len(p) for p in l['paths'])} puntos, profundidad estimada {l['depth_m']} m")


if __name__ == "__main__":
    main()
