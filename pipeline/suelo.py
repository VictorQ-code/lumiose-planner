#!/usr/bin/env python3
"""Detalle del suelo de Barcelona: marcas viales, pasos de cebra, árboles, vías de tren y tranvía,
carriles bici, aparcamientos en superficie y en la calle (OSM + zonas reguladas de Open Data BCN) y semáforos.

Requiere ciudad.py y mapa_base.py (usa sus índices y la caché de OpenStreetMap).

Uso:
    python pipeline/suelo.py
    python pipeline/suelo.py --forzar      # volver a descargar OSM y el arbolado

Produce data/gold/barcelona/suelo/X_Y.json (bloques de 1 km) y añade "suelo" al index.json.
Datos © OpenStreetMap contributors (ODbL) · Arbolado: Ajuntament de Barcelona (Open Data BCN, CC BY 4.0).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, CRS, GOLD, HEADERS, columna, descargar, log  # noqa: E402
from mapa_base import ANCHO, PEATONAL, geometrias, overpass  # noqa: E402

SLUG = "barcelona"
BLOQUE = 1000.0
CKAN = "https://opendata-ajuntament.barcelona.cat/data/api/3/action/package_show?id={}"
ARBOLADO = ["arbrat-viari", "arbrat-zona", "arbrat-parcs"]

CARRILES_DEF = {"motorway": 3, "trunk": 3, "primary": 2, "secondary": 2, "tertiary": 2, "unclassified": 1,
                "motorway_link": 1, "trunk_link": 1, "primary_link": 1, "secondary_link": 1}
CON_MARCAS = set(CARRILES_DEF)
GUION, HUECO = 3.0, 6.0          # marcas discontinuas (m)
RECORTE_CRUCE = 7.0              # sin marcas en los últimos metros de cada tramo (los cruces)
CEBRA_BARRA, CEBRA_PASO, CEBRA_LARGO = 0.5, 1.0, 4.0


def oneway(tags):
    return tags.get("oneway") in ("yes", "1", "-1", "true") or tags.get("junction") == "roundabout"


def carriles(tags, hw):
    try:
        return max(1, int(str(tags.get("lanes", "")).split(";")[0]))
    except ValueError:
        return CARRILES_DEF.get(hw, 1)


def discontinua(linea):
    """Trocea una línea en guiones."""
    from shapely.ops import substring
    L = linea.length
    out, s = [], 0.0
    while s < L:
        seg = substring(linea, s, min(s + GUION, L))
        if seg.length > 0.5:
            out.append(list(seg.coords))
        s += GUION + HUECO
    return out


def barras_cebra(p0, p1):
    """Franjas de un paso de cebra que cruza de p0 a p1 (la calle es perpendicular a p0→p1)."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    if L < 3 or L > 45:
        return []
    ux, uy = dx / L, dy / L           # sentido del cruce
    vx, vy = -uy, ux                  # sentido de la calle
    h = CEBRA_LARGO / 2
    out, s = [], 0.6
    while s + CEBRA_BARRA < L - 0.6:
        a = (p0[0] + ux * s, p0[1] + uy * s)
        b = (p0[0] + ux * (s + CEBRA_BARRA), p0[1] + uy * (s + CEBRA_BARRA))
        out.append([a[0] - vx * h, a[1] - vy * h, b[0] - vx * h, b[1] - vy * h, b[0] + vx * h, b[1] + vy * h, a[0] + vx * h, a[1] + vy * h])
        s += CEBRA_PASO
    return out


def arboles(forzar, a_utm):
    """Arbolado municipal (viario, zonas y parques) -> lista de (x, y, tamaño) en UTM."""
    import pandas as pd
    pts = []
    for ds in ARBOLADO:
        try:
            meta = requests.get(CKAN.format(ds), headers=HEADERS, timeout=60).json()["result"]["resources"]
            csvs = [r for r in meta if (r.get("format") or "").lower() == "csv"]
            if not csvs:
                log(f"  {ds}: sin CSV"); continue
            rec = sorted(csvs, key=lambda r: r.get("last_modified") or r.get("created") or "")[-1]
            ruta = descargar(rec["url"], BRONZE / "arbolado" / f"{ds}.csv", forzar=forzar)
            df = pd.read_csv(ruta, low_memory=False)
            cx, cy = columna(df, "x_etrs89", obligatoria=False), columna(df, "y_etrs89", obligatoria=False)
            if cx and cy:
                xs, ys = pd.to_numeric(df[cx], errors="coerce"), pd.to_numeric(df[cy], errors="coerce")
            else:
                lat, lon = columna(df, "latitud"), columna(df, "longitud")
                ll = df[[lon, lat]].apply(pd.to_numeric, errors="coerce").dropna()
                xs, ys = zip(*[a_utm(o, a) for o, a in ll.itertuples(index=False)]) if len(ll) else ([], [])
                xs, ys = pd.Series(xs), pd.Series(ys)
            n0 = len(pts)
            for x, y in zip(xs, ys):
                if x == x and y == y:
                    pts.append((float(x), float(y), 2.4 + (hash((round(x), round(y))) % 100) / 100 * 2.2))
            log(f"  {ds}: {len(pts) - n0:,} árboles")
        except Exception as e:  # noqa: BLE001
            log(f"  {ds}: no se pudo cargar ({e}); se sigue sin él")
    return pts


def trams_aparcament(forzar, a_utm):
    """Tramos de aparcamiento regulado en superficie (Open Data BCN, 'trams-aparcament-superficie').

    El formato del CSV ha cambiado con los años, así que se lee de forma tolerante: se busca la columna con
    las coordenadas (lista de números, en lon/lat o en UTM) y la del color/tipo de zona.
    Devuelve [(capa, LineString UTM)] con capa en {"azul", "verde", "dum"}.
    """
    import re
    import pandas as pd
    from shapely.geometry import LineString
    try:
        meta = requests.get(CKAN.format("trams-aparcament-superficie"), headers=HEADERS, timeout=60).json()["result"]["resources"]
        recs = [r for r in meta if (r.get("format") or "").lower() in ("csv", "zip") or (r.get("url") or "").lower().endswith((".csv", ".zip"))]
        if not recs:
            log("  zonas reguladas: el dataset no tiene CSV"); return []
        rec = sorted(recs, key=lambda r: r.get("last_modified") or r.get("created") or "")[-1]
        nombre = (rec.get("url") or "trams.csv").split("?")[0].rsplit("/", 1)[-1] or "trams.csv"
        ruta = descargar(rec["url"], BRONZE / "aparcament" / nombre, forzar=forzar)
        comp = "zip" if open(ruta, "rb").read(2) == b"PK" else None    # el recurso se baja como "download" (zip sin extensión)
        df = None
        for enc in ("utf-8-sig", "latin-1"):
            try:
                df = pd.read_csv(ruta, sep=None, engine="python", encoding=enc, dtype=str, compression=comp); break
            except UnicodeDecodeError:
                continue
        if df is None or not len(df):
            log("  zonas reguladas: CSV vacío"); return []
        df.columns = [c.strip() for c in df.columns]
        if {"UTM_IX", "UTM_IY", "UTM_FX", "UTM_FY", "TIPUS_TRAM"} <= set(df.columns):
            # Formato actual (2026): un tramo recto por fila, de (UTM_IX, UTM_IY) a (UTM_FX, UTM_FY) en ETRS89 UTM 31N.
            # TIPUS_TRAM: AZL Àrea Blava, VM Àrea Verda, VR Verda solo residentes, DUM carga y descarga, BUS (se ignora).
            tipos = {"AZL": "azul", "VM": "verde", "VR": "verde", "DUM": "dum"}
            out = []
            for f in df.itertuples(index=False):
                capa = tipos.get(str(getattr(f, "TIPUS_TRAM")).strip())
                try:
                    a0 = (float(f.UTM_IX), float(f.UTM_IY)); a1 = (float(f.UTM_FX), float(f.UTM_FY))
                except (TypeError, ValueError):
                    continue
                if capa and a0 != a1:
                    out.append((capa, LineString([a0, a1])))
            log(f"  zonas reguladas: {len(out):,} tramos leídos ({nombre})")
            return out
        num = re.compile(r"-?\d+(?:\.\d+)?")
        def numeros(s):
            return [float(x) for x in num.findall(str(s).replace(",", " ") if str(s).count(",") > 1 else str(s))]
        muestra = df.head(200)
        col_geo = max(df.columns, key=lambda c: sum(len(numeros(v)) for v in muestra[c].dropna()) / max(1, muestra[c].notna().sum()))
        col_col = next((c for c in df.columns if "color" in c.lower() or "colour" in c.lower() or "tipus" in c.lower()), None)
        log(f"  zonas reguladas: columnas {list(df.columns)} -> coordenadas '{col_geo}', tipo '{col_col}'")

        def capa_de(v):
            v = str(v).upper()
            if any(k in v for k in ("AZL", "BLAU", "BLAV", "AZUL", "BLUE")): return "azul"
            if any(k in v for k in ("VM", "VR", "VERD", "GREEN")): return "verde"
            if any(k in v for k in ("DUM", "MERCA", "CARGA", "CÀRREGA", "CARREGA")): return "dum"
            return None
        out = []
        for _, fila in df.iterrows():
            capa = capa_de(fila[col_col]) if col_col else "azul"
            if capa is None:
                continue
            v = numeros(fila[col_geo])
            pts = []
            for i in range(0, len(v) - 1, 2):
                x, y = v[i], v[i + 1]
                if 0 < x < 5 and 40 < y < 43:      pts.append(a_utm(x, y))
                elif 40 < x < 43 and 0 < y < 5:    pts.append(a_utm(y, x))
                elif 3e5 < x < 6e5 and 4.4e6 < y < 4.7e6: pts.append((x, y))
            if len(pts) >= 2:
                out.append((capa, LineString(pts)))
        log(f"  zonas reguladas: {len(out):,} tramos leídos")
        return out
    except Exception as e:  # noqa: BLE001
        log(f"  zonas reguladas (Open Data BCN): no se pudieron cargar ({e}); se sigue solo con OSM")
        return []


def main() -> None:
    import numpy as np
    import shapely
    from pyproj import Transformer
    from shapely.geometry import LineString, Point, Polygon, box
    from shapely.ops import unary_union

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args()
    t0 = time.time()

    salida = GOLD / SLUG
    indice = json.loads((salida / "index.json").read_text(encoding="utf-8"))
    ox, oy = indice["origin"]
    to_utm = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    a_ll = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    a_utm = lambda lon, lat: to_utm.transform(lon, lat)  # noqa: E731
    utm = lambda x, z: (x + ox, -z + oy)                  # noqa: E731
    loc = lambda x, y: [round(x - ox, 2), round(-(y - oy), 2)]  # noqa: E731

    ciudad = unary_union([Polygon([utm(*p) for p in o]) for o in indice["outlines"]]).buffer(0)
    minx, miny, maxx, maxy = ciudad.bounds
    w, s = a_ll.transform(minx, miny); e, n = a_ll.transform(maxx, maxy)
    bb = f"({s:.5f},{w:.5f},{n:.5f},{e:.5f})"
    osm = BRONZE / "osm"
    bloques: dict = {}

    def bloque(x, y):
        return (int((x - minx) // BLOQUE), int((y - miny) // BLOQUE))

    def meter(clave, tipo, sub, valor):
        bloques.setdefault(clave, {}).setdefault(tipo, {}).setdefault(sub, []).append(valor) if sub else \
            bloques.setdefault(clave, {}).setdefault(tipo, []).append(valor)

    # ---------------- Vías: marcas viales ----------------
    vias = geometrias(overpass(f"[out:json][timeout:360];( way[\"highway\"~\"^({'|'.join(list(ANCHO)+list(PEATONAL))})$\"][\"area\"!=\"yes\"]{bb}; );out geom;",
                               osm / "vias.json", a.forzar).get("elements", []), a_utm)
    log(f"marcas viales sobre {len(vias):,} tramos")
    lineas_calle = []      # para orientar los pasos de cebra que vienen como punto
    n_marcas = 0
    for tags, g in vias:
        hw = tags.get("highway")
        if g.geom_type != "LineString" or hw not in ANCHO:
            continue
        if tags.get("tunnel") in ("yes", "building_passage") or str(tags.get("layer", "0")).startswith("-"):
            continue
        lineas_calle.append((g, ANCHO[hw]))
        if hw not in CON_MARCAS or g.length < 2 * RECORTE_CRUCE + GUION:
            continue
        from shapely.ops import substring
        tramo = substring(g, RECORTE_CRUCE, g.length - RECORTE_CRUCE)
        W, nl = ANCHO[hw], carriles(tags, hw)
        if not oneway(tags) and nl < 2:
            nl = 2
        offsets = [-W / 2 + i * W / nl for i in range(1, nl)]
        for d in offsets:
            try:
                lin = tramo if abs(d) < 0.01 else tramo.offset_curve(d)
            except Exception:  # noqa: BLE001
                continue
            if lin.is_empty or lin.geom_type != "LineString":
                continue
            centro_doble = (not oneway(tags)) and abs(d) < 0.01 and nl >= 4
            trozos = [list(lin.coords)] if centro_doble else discontinua(lin)
            for c in trozos:
                meter(bloque(*c[0]), "lineas", "marca", [v for p in c for v in loc(*p)])
                n_marcas += 1
    log(f"  {n_marcas:,} marcas")

    # ---------------- Pasos de cebra y semáforos ----------------
    # Cada paso se guarda como su eje [ax, az, bx, bz] (de bordillo a bordillo); el visor dibuja un único
    # cuadrilátero con las franjas en el shader (antes: una geometría por franja, ~8 veces más triángulos).
    cruces = geometrias(overpass(f'[out:json][timeout:300];( way["footway"="crossing"]{bb}; node["highway"="crossing"]{bb}; );out geom;',
                                 osm / "cruces.json", a.forzar).get("elements", []), a_utm)
    arbol_calles = shapely.STRtree([l for l, _ in lineas_calle])
    marcado = lambda t: t.get("crossing") not in ("unmarked", "no", "informal")                    # noqa: E731
    con_sem = lambda t: t.get("crossing") == "traffic_signals" or t.get("crossing:signals") == "yes"  # noqa: E731
    lineas_cruce = [(t, g) for t, g in cruces if g.geom_type == "LineString"]
    arbol_cruces = shapely.STRtree([g for _, g in lineas_cruce]) if lineas_cruce else None
    semaforos: dict = {}                       # celda de 3 m -> (x, y, ángulo): evita postes duplicados
    n_cebra = 0

    def semaforo(x, y, ang):
        semaforos.setdefault((round(x / 3), round(y / 3)), (x, y, ang))

    def poner_paso(p0, p1, cebra, sem):
        nonlocal n_cebra
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        L = math.hypot(dx, dy)
        if L < 3 or L > 45:
            return
        ux, uy = dx / L, dy / L               # sentido del cruce
        vx, vy = -uy, ux                      # sentido de la calle
        if cebra:
            pa = (p0[0] + ux * 0.6, p0[1] + uy * 0.6); pb = (p1[0] - ux * 0.6, p1[1] - uy * 0.6)
            meter(bloque((pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2), "pasos", None, [*loc(*pa), *loc(*pb)]); n_cebra += 1
        if sem:                               # un poste en cada acera, a un lado del paso, mirando a la calzada
            h, ang = CEBRA_LARGO / 2 + 0.7, math.atan2(uy, ux)
            semaforo(p0[0] - ux * 0.4 - vx * h, p0[1] - uy * 0.4 - vy * h, ang)
            semaforo(p1[0] + ux * 0.4 + vx * h, p1[1] + uy * 0.4 + vy * h, ang + math.pi)

    for t, g in lineas_cruce:
        c = list(g.coords)
        for p0, p1 in zip(c[:-1], c[1:]):
            poner_paso(p0, p1, marcado(t), con_sem(t))
    for t, g in cruces:              # cruces que solo están como punto: se orientan con la calle más cercana
        if g.geom_type != "Point" or not (marcado(t) or con_sem(t)):
            continue
        if arbol_cruces is not None and len(arbol_cruces.query(g.buffer(6), predicate="intersects")):
            continue
        idx = arbol_calles.query(g.buffer(10), predicate="intersects")
        if not len(idx):
            continue
        k = min(idx, key=lambda i: lineas_calle[i][0].distance(g))
        linea, ancho = lineas_calle[k]
        sp = linea.project(g)
        a1, b1 = linea.interpolate(max(0, sp - 1)), linea.interpolate(min(linea.length, sp + 1))
        tx, ty = b1.x - a1.x, b1.y - a1.y; tl = math.hypot(tx, ty) or 1
        nx, ny = -ty / tl, tx / tl
        c0 = linea.interpolate(sp)
        poner_paso((c0.x - nx * ancho / 2, c0.y - ny * ancho / 2), (c0.x + nx * ancho / 2, c0.y + ny * ancho / 2), marcado(t), con_sem(t))
    log(f"pasos de cebra: {n_cebra:,}")

    # Semáforos de cruce de calzadas (highway=traffic_signals) que no estén ya junto a un paso semaforizado
    try:
        luces = overpass(f'[out:json][timeout:200];( node["highway"="traffic_signals"]{bb}; );out;', osm / "semaforos.json", a.forzar).get("elements", [])
    except Exception as e:  # noqa: BLE001
        log(f"  semáforos de OSM: no se pudieron descargar ({e}); solo los de los pasos"); luces = []
    ya = shapely.STRtree([Point(x, y) for x, y, _ in semaforos.values()]) if semaforos else None
    for el in luces:
        if "lon" not in el:
            continue
        g = Point(*a_utm(el["lon"], el["lat"]))
        if ya is not None and len(ya.query(g.buffer(15), predicate="intersects")):
            continue
        idx = arbol_calles.query(g.buffer(8), predicate="intersects")
        if not len(idx):
            continue
        k = min(idx, key=lambda i: lineas_calle[i][0].distance(g))
        linea, ancho = lineas_calle[k]
        sp = linea.project(g)
        a1, b1 = linea.interpolate(max(0, sp - 1)), linea.interpolate(min(linea.length, sp + 1))
        tx, ty = b1.x - a1.x, b1.y - a1.y; tl = math.hypot(tx, ty) or 1
        nx, ny = -ty / tl, tx / tl
        c0 = linea.interpolate(sp); h = ancho / 2 + 0.6
        semaforo(c0.x - nx * h, c0.y - ny * h, math.atan2(ny, nx))
        semaforo(c0.x + nx * h, c0.y + ny * h, math.atan2(ny, nx) + math.pi)
    for x, y, ang in semaforos.values():
        meter(bloque(x, y), "semaforos", None, [*loc(x, y), round(ang, 2)])
    n_sem = len(semaforos)
    log(f"semáforos: {n_sem:,} postes")

    # ---------------- Tren y tranvía en superficie, carriles bici ----------------
    otras = geometrias(overpass(
        f'[out:json][timeout:300];( way["railway"~"^(rail|tram|light_rail|narrow_gauge)$"]{bb}; way["highway"="cycleway"]{bb}; );out geom;',
        osm / "vias_tren_bici.json", a.forzar).get("elements", []), a_utm)
    n_rail = n_bici = 0
    for t, g in otras:
        if g.geom_type != "LineString":
            continue
        if t.get("tunnel") in ("yes", "building_passage") or str(t.get("layer", "0")).startswith("-"):
            continue
        if not g.intersects(ciudad):
            continue
        if "railway" in t:
            ancho = 0.72 if t["railway"] != "narrow_gauge" else 0.5
            for d in (-ancho, ancho):
                try:
                    r = g.offset_curve(d)
                except Exception:  # noqa: BLE001
                    continue
                if not r.is_empty and r.geom_type == "LineString":
                    c = list(r.coords); meter(bloque(*c[0]), "lineas", "rail", [v for p in c for v in loc(*p)])
            balasto = g.buffer(2.0 if t["railway"] in ("rail", "narrow_gauge") else 1.5, cap_style=2)
            meter(bloque(*g.coords[0]), "areas", "via", {"o": [loc(*p) for p in balasto.exterior.coords][:-1], "i": []})
            n_rail += 1
        else:
            c = list(g.coords); meter(bloque(*c[0]), "lineas", "bici", [v for p in c for v in loc(*p)]); n_bici += 1
    log(f"vías de tren/tranvía: {n_rail:,} · carriles bici: {n_bici:,}")

    # ---------------- Aparcamientos en superficie ----------------
    aparc = geometrias(overpass(f'[out:json][timeout:200];( way["amenity"="parking"]["parking"!~"underground|multi-storey|rooftop"]{bb}; );out geom;',
                                osm / "aparcamientos.json", a.forzar).get("elements", []), a_utm)
    n_ap = 0
    for t, g in aparc:
        if g.geom_type == "Polygon" and g.area > 40 and g.intersects(ciudad):
            g = g.intersection(ciudad)
            for p in ([g] if g.geom_type == "Polygon" else [x for x in getattr(g, "geoms", []) if x.geom_type == "Polygon"]):
                c = p.representative_point()
                meter(bloque(c.x, c.y), "areas", "aparcamiento", {"o": [loc(*q) for q in p.exterior.coords][:-1], "i": [[loc(*q) for q in r.coords][:-1] for r in p.interiors]}); n_ap += 1
    log(f"aparcamientos en superficie: {n_ap:,}")

    # ---------------- Aparcamiento en la calle ----------------
    # 1) Zonas reguladas del Ajuntament (Àrea Blava / Verda / carga y descarga); 2) etiquetas parking:* de OSM.
    # Cada banda es un polígono (área "calle"/"azul"/"verde"/"dum") más las rayas que separan las plazas.
    FONDO = {"parallel": 2.2, "diagonal": 4.5, "perpendicular": 5.0}
    ORIENT_COD = {"parallel": 0, "diagonal": 1, "perpendicular": 2}   # para los coches aparcados del visor
    PASO_PLAZA = {"parallel": 5.0, "diagonal": 3.0, "perpendicular": 2.5}
    SI_APARCA = {"lane", "yes", "street_side", "on_kerb", "half_on_kerb", "parallel", "diagonal", "perpendicular", "marked"}
    bandas = []
    n_calle = 0

    def banda(centro, orient, capa):
        """Banda de aparcamiento a lo largo de 'centro' (línea por el medio de las plazas)."""
        nonlocal n_calle
        if centro.is_empty or centro.geom_type != "LineString" or centro.length < 4:
            return
        f = FONDO.get(orient, 2.2)
        pol = centro.buffer(f / 2, cap_style=2, join_style=2)
        if pol.is_empty or pol.geom_type != "Polygon" or any(b.intersection(pol).area > 0.3 * pol.area for b in arbol_bandas_q(pol)):
            return
        bandas.append(pol)
        c = pol.representative_point()
        meter(bloque(c.x, c.y), "areas", capa, {"o": [loc(*q) for q in pol.exterior.coords][:-1], "i": []})
        s, paso = 0.0, PASO_PLAZA.get(orient, 5.0)
        while s <= centro.length:              # rayas entre plazas, perpendiculares a la banda
            p, q = centro.interpolate(max(0, s - 0.5)), centro.interpolate(min(centro.length, s + 0.5))
            tx, ty = q.x - p.x, q.y - p.y; tl = math.hypot(tx, ty) or 1
            nx, ny = -ty / tl * f / 2, tx / tl * f / 2
            m = centro.interpolate(s)
            meter(bloque(m.x, m.y), "lineas", "plaza", [*loc(m.x - nx, m.y - ny), *loc(m.x + nx, m.y + ny)])
            s += paso
        if capa != "dum":                      # una plaza por hueco: el visor (vivo.js) aparca coches aquí
            s = paso / 2
            while s < centro.length - 0.5:
                p, q = centro.interpolate(max(0, s - 0.5)), centro.interpolate(min(centro.length, s + 0.5))
                m = centro.interpolate(s)
                meter(bloque(m.x, m.y), "plazas", None, [*loc(m.x, m.y), round(math.atan2(q.y - p.y, q.x - p.x), 2), ORIENT_COD.get(orient, 0)])
                s += paso
        n_calle += 1

    previas = {"arbol": None, "lista": []}     # bandas de Open Data BCN: OSM no las duplica

    def arbol_bandas_q(pol):
        if previas["arbol"] is None:
            return []
        return [previas["lista"][i] for i in previas["arbol"].query(pol)]

    n_bcn = 0
    for capa, linea_t in trams_aparcament(a.forzar, a_utm):
        if linea_t.length < 4 or not linea_t.intersects(ciudad):
            continue
        m = linea_t.interpolate(0.5, normalized=True)
        idx = arbol_calles.query(m.buffer(15), predicate="intersects")
        if not len(idx):
            continue
        calle = lineas_calle[min(idx, key=lambda i: lineas_calle[i][0].distance(m))][0]
        p = calle.interpolate(calle.project(m))
        d = math.hypot(m.x - p.x, m.y - p.y)
        try:
            if d < 0.8:                        # el tramo va por el eje: se pega al lado derecho de la calle
                centro = linea_t.offset_curve(-1.1)
            else:                              # se desplaza hacia la calzada medio fondo de plaza
                a0, a1 = linea_t.interpolate(0.45, normalized=True), linea_t.interpolate(0.55, normalized=True)
                cruz = (a1.x - a0.x) * (p.y - m.y) - (a1.y - a0.y) * (p.x - m.x)   # >0: la calle queda a la izquierda
                centro = linea_t.offset_curve(1.1 if cruz > 0 else -1.1)
        except Exception:  # noqa: BLE001
            continue
        banda(centro, "parallel", capa); n_bcn += 1
    log(f"  zonas reguladas (Open Data BCN): {n_bcn:,} tramos")
    if bandas:
        previas["lista"] = list(bandas); previas["arbol"] = shapely.STRtree(previas["lista"])

    from shapely.ops import substring
    for tags, g in vias:
        hw = tags.get("highway")
        if g.geom_type != "LineString" or hw not in ANCHO or g.length < 16:
            continue
        if tags.get("tunnel") in ("yes", "building_passage") or str(tags.get("layer", "0")).startswith("-"):
            continue
        W = ANCHO[hw]
        tramo = substring(g, 6, g.length - 6)    # sin plazas en las esquinas
        for lado, signo in (("left", 1), ("right", -1)):
            v = tags.get(f"parking:{lado}") or tags.get("parking:both") or tags.get(f"parking:lane:{lado}") or tags.get("parking:lane:both")
            if v not in SI_APARCA:
                continue
            orient = tags.get(f"parking:{lado}:orientation") or tags.get("parking:both:orientation") or (v if v in FONDO else "parallel")
            f = FONDO.get(orient, 2.2)
            if W / 2 < f + 1.2:                  # no cabe con el ancho estimado de la calle
                if f > 2.2 and W / 2 >= 3.4:
                    orient, f = "parallel", 2.2
                else:
                    continue
            try:
                centro = tramo.offset_curve(signo * (W / 2 - f / 2))
            except Exception:  # noqa: BLE001
                continue
            banda(centro, orient, "calle")
    log(f"aparcamiento en la calle: {n_calle:,} bandas")

    # ---------------- Árboles ----------------
    log("arbolado municipal (Open Data BCN)")
    n_arb = 0
    for x, y, r in arboles(a.forzar, a_utm):
        if minx <= x <= maxx and miny <= y <= maxy:
            meter(bloque(x, y), "arboles", None, [*loc(x, y), round(r, 1)]); n_arb += 1

    # ---------------- Guardar ----------------
    carpeta = salida / "suelo"
    carpeta.mkdir(exist_ok=True)
    for viejo in carpeta.glob("*.json"):
        viejo.unlink()
    lista = []
    for (i, j), datos in sorted(bloques.items()):
        nombre = f"suelo/{i}_{j}.json"
        (salida / nombre).write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        x0, y0 = minx + i * BLOQUE, miny + j * BLOQUE
        lx0, lz1 = loc(x0, y0); lx1, lz0 = loc(x0 + BLOQUE, y0 + BLOQUE)
        lista.append({"file": nombre, "bbox": [lx0 - 50, lz0 - 50, lx1 + 50, lz1 + 50],
                      "arboles": len(datos.get("arboles", [])), "cebras": len(datos.get("pasos", [])),
                      "semaforos": len(datos.get("semaforos", []))})
    indice["suelo"] = {"tiles": lista, "marcas": n_marcas, "cebras": n_cebra, "arboles": n_arb, "rail": n_rail, "bici": n_bici,
                       "aparcamientos": n_ap, "semaforos": n_sem, "aparca_calle": n_calle}
    if "Open Data BCN" not in indice.get("source", "") or "Arbolado" not in indice.get("source", ""):
        indice["source"] = indice.get("source", "") + " · Arbolado: Open Data BCN"
    (salida / "index.json").write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"listo en {time.time() - t0:.0f} s: {len(lista)} bloques · {n_marcas:,} marcas · {n_cebra:,} pasos de cebra · {n_sem:,} semáforos · "
        f"{n_arb:,} árboles · {n_rail:,} vías · {n_bici:,} carriles bici · {n_ap:,} aparcamientos · {n_calle:,} bandas de aparcamiento en la calle")


if __name__ == "__main__":
    main()
