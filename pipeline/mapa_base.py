#!/usr/bin/env python3
"""Mapa base de Barcelona desde OpenStreetMap: zonas verdes, agua, playas, calles y monumentos.

Requiere haber ejecutado ciudad.py (usa su index.json para el origen y el contorno).

Uso:
    python pipeline/mapa_base.py
    python pipeline/mapa_base.py --forzar      # volver a descargar de OpenStreetMap

Produce en data/gold/barcelona/:
    base/X_Y.json   polígonos por capa (verde, agua, playa, calzada, peatonal) en bloques de 1 km
    index.json      añade "base" (lista de bloques) y "landmarks" (monumentos con posición, contorno y altura)
    lod1/ y lod2/   marca con "lm" los volúmenes que forman parte de un monumento

Datos © OpenStreetMap contributors (ODbL).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, CRS, GOLD, HEADERS, log  # noqa: E402

SLUG = "barcelona"
BLOQUE = 1000.0
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]

# Ancho total (m) de cada tipo de vía. Peatonales aparte, con otro color.
ANCHO = {"motorway": 24, "trunk": 22, "primary": 18, "secondary": 14, "tertiary": 11, "unclassified": 8,
         "residential": 8, "service": 5, "motorway_link": 9, "trunk_link": 9, "primary_link": 9,
         "secondary_link": 8, "tertiary_link": 8}
PEATONAL = {"pedestrian": 7, "living_street": 7}

CAPAS = {
    "verde": """(
      way["leisure"~"^(park|garden|nature_reserve|playground|pitch)$"]{bb}; relation["leisure"~"^(park|garden|nature_reserve)$"]{bb};
      way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|allotments)$"]{bb};
      relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery)$"]{bb};
      way["natural"~"^(wood|scrub|grassland|heath)$"]{bb}; relation["natural"~"^(wood|scrub|grassland)$"]{bb};
    );""",
    "agua": """( way["natural"="water"]{bb}; relation["natural"="water"]{bb}; way["landuse"="basin"]{bb}; );""",
    "playa": """( way["natural"~"^(beach|sand)$"]{bb}; relation["natural"~"^(beach|sand)$"]{bb}; );""",
    "plaza": """( way["highway"="pedestrian"]["area"="yes"]{bb}; way["place"="square"]{bb}; relation["place"="square"]{bb}; );""",
    "vias": """( way["highway"~"^(%s)$"]["area"!="yes"]{bb}; );""" % "|".join(list(ANCHO) + list(PEATONAL)),
}

# Monumentos.
#   modo "catastro": el Catastro ya da bien su volumen; solo se pintan en sanguina.
#   modo "osm": el Catastro no refleja su altura (templos, arcos, estadios, torres): se dibuja con la forma de
#               OpenStreetMap y la altura indicada (o la de OSM si existe), sustituyendo los bloques del Catastro.
#   aguja: "sagrada" (torres del templo), "mastil" (torre de telecomunicaciones) o "aguja" (campanario/columna).
#   Alturas en metros, aproximadas, solo como respaldo cuando OSM no trae altura.
MONUMENTOS = [
    dict(nombre="Sagrada Família", rx=r"Sagrada Fam", lat=41.4036, lon=2.1744, modo="osm", cuerpo=45, aguja="sagrada", alto=172.5),
    dict(nombre="Arc de Triomf", rx=r"^Arc de Triomf$", lat=41.3910, lon=2.1806, modo="osm", cuerpo=30),
    dict(nombre="Casa Batlló", rx=r"Casa Batll", lat=41.3916, lon=2.1650, modo="catastro"),
    dict(nombre="La Pedrera", rx=r"Casa Mil|Pedrera", lat=41.3953, lon=2.1620, modo="catastro"),
    dict(nombre="Catedral", rx=r"Catedral de (la Santa Creu|Barcelona)", lat=41.3839, lon=2.1763, modo="osm", cuerpo=28, aguja="aguja", alto=70),
    dict(nombre="Santa Maria del Mar", rx=r"Santa Maria del Mar", lat=41.3837, lon=2.1820, modo="osm", cuerpo=32),
    dict(nombre="Palau de la Música", rx=r"Palau de la M[uú]sica", lat=41.3875, lon=2.1753, modo="catastro"),
    dict(nombre="Sant Pau", rx=r"Recinte Modernista de Sant Pau|Hospital de la Santa Creu i Sant Pau", lat=41.4115, lon=2.1744, modo="catastro"),
    dict(nombre="Torre Glòries", rx=r"Torre (Gl[oò]ries|Agbar)", lat=41.4034, lon=2.1895, modo="osm", cuerpo=144),
    dict(nombre="Park Güell", rx=r"Par[ck] G[uü]ell", lat=41.4145, lon=2.1527, modo="catastro"),
    dict(nombre="Camp Nou", rx=r"Camp Nou", lat=41.3809, lon=2.1228, modo="osm", cuerpo=45),
    dict(nombre="MNAC", rx=r"Museu Nacional d.Art de Catalunya|Palau Nacional", lat=41.3685, lon=2.1534, modo="osm", cuerpo=35),
    dict(nombre="Mirador de Colom", rx=r"Monument a Col[oó]m|Mirador de Col", lat=41.3758, lon=2.1778, modo="osm", cuerpo=8, aguja="aguja", alto=60),
    dict(nombre="Hotel Arts", rx=r"^Hotel Arts", lat=41.3864, lon=2.1964, modo="catastro"),
    dict(nombre="Torre Mapfre", rx=r"Torre Mapfre", lat=41.3884, lon=2.1979, modo="catastro"),
    dict(nombre="Hotel W", rx=r"^(W Barcelona|Hotel W)", lat=41.3684, lon=2.1900, modo="catastro"),
    dict(nombre="Castell de Montjuïc", rx=r"Castell de Montju", lat=41.3637, lon=2.1665, modo="osm", cuerpo=14),
    dict(nombre="Torre de Collserola", rx=r"Torre de Collserola", lat=41.4172, lon=2.1143, modo="osm", cuerpo=0, aguja="mastil", alto=288),
    dict(nombre="Tibidabo", rx=r"Temple Expiatori del Sagrat Cor", lat=41.4219, lon=2.1189, modo="osm", cuerpo=30, aguja="aguja", alto=75),
    dict(nombre="La Boqueria", rx=r"Boqueria", lat=41.3817, lon=2.1716, modo="catastro"),
    dict(nombre="Las Arenas", rx=r"Arenas de Barcelona|Les Arenes", lat=41.3762, lon=2.1491, modo="catastro"),
    dict(nombre="Plaça de Catalunya", rx=r"^Pla[cç]a de Catalunya$", lat=41.3870, lon=2.1700, modo="plaza"),
]


def overpass(query: str, cache: Path, forzar: bool):
    if cache.exists() and not forzar:
        log(f"OSM en caché: {cache.name}")
        return json.loads(cache.read_text(encoding="utf-8"))
    cache.parent.mkdir(parents=True, exist_ok=True)
    ultimo = None
    for intento in range(3):
        for url in OVERPASS:
            try:
                log(f"consultando OpenStreetMap ({cache.stem}) en {url.split('/')[2]}…")
                r = requests.post(url, data={"data": query}, headers=HEADERS, timeout=400)
                if r.status_code == 200:
                    cache.write_text(r.text, encoding="utf-8")
                    return r.json()
                ultimo = f"HTTP {r.status_code}"
            except Exception as e:  # noqa: BLE001
                ultimo = str(e)
        time.sleep(15 * (intento + 1))
    raise SystemExit(f"No se pudo descargar {cache.stem} de OpenStreetMap ({ultimo}). Prueba más tarde.")


def geometrias(elementos, a_utm):
    """Elementos OSM (out geom) -> lista de (tags, geometría shapely en UTM)."""
    from shapely.geometry import LineString, Point, Polygon
    from shapely.ops import polygonize, unary_union

    def linea(geom):
        pts = [a_utm(p["lon"], p["lat"]) for p in geom if p]
        return pts

    out = []
    for el in elementos:
        tags = el.get("tags", {})
        try:
            if el["type"] == "node":
                out.append((tags, Point(*a_utm(el["lon"], el["lat"]))))
            elif el["type"] == "way" and "geometry" in el:
                pts = linea(el["geometry"])
                if len(pts) >= 4 and pts[0] == pts[-1]:
                    out.append((tags, Polygon(pts).buffer(0)))
                elif len(pts) >= 2:
                    out.append((tags, LineString(pts)))
            elif el["type"] == "relation":
                outer, inner = [], []
                for m in el.get("members", []):
                    if m.get("type") == "way" and "geometry" in m:
                        pts = linea(m["geometry"])
                        if len(pts) >= 2:
                            (inner if m.get("role") == "inner" else outer).append(LineString(pts))
                if outer:
                    g = unary_union(list(polygonize(unary_union(outer))))
                    if inner:
                        g = g.difference(unary_union(list(polygonize(unary_union(inner)))))
                    if not g.is_empty:
                        out.append((tags, g.buffer(0)))
        except Exception:  # noqa: BLE001
            continue
    return out


def main() -> None:
    import shapely
    from pyproj import Transformer
    from shapely.geometry import Point, Polygon, box, shape
    from shapely.ops import unary_union

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--forzar", action="store_true")
    a = ap.parse_args()
    t0 = time.time()

    salida = GOLD / SLUG
    indice_path = salida / "index.json"
    if not indice_path.exists():
        raise SystemExit("No existe data/gold/barcelona/index.json. Ejecuta antes pipeline/ciudad.py.")
    indice = json.loads(indice_path.read_text(encoding="utf-8"))
    ox, oy = indice["origin"]
    a_ll = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    to_utm = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    a_utm = lambda lon, lat: to_utm.transform(lon, lat)  # noqa: E731
    utm = lambda x, z: (x + ox, -z + oy)                  # noqa: E731  local -> UTM
    def local(coords):
        out = [[round(x - ox, 1), round(-(y - oy), 1)] for x, y, *_ in coords]
        return out[:-1] if len(out) > 1 and out[0] == out[-1] else out

    ciudad = unary_union([Polygon([utm(*p) for p in o]) for o in indice["outlines"]]).buffer(0)
    minx, miny, maxx, maxy = ciudad.bounds
    w, s = a_ll.transform(minx, miny); e, n = a_ll.transform(maxx, maxy)
    bb = f"({s:.5f},{w:.5f},{n:.5f},{e:.5f})"

    # ---------------- Capas ----------------
    capas_geom = {}
    for capa, q in CAPAS.items():
        datos = overpass(f"[out:json][timeout:360];{q.replace('{bb}', bb)}out geom;", BRONZE / "osm" / f"{capa}.json", a.forzar)
        capas_geom[capa] = geometrias(datos.get("elements", []), a_utm)
        log(f"{capa}: {len(capas_geom[capa]):,} elementos")

    log("construyendo calles con su ancho (puede tardar un poco)")
    calzada, peatonal = [], []
    for tags, g in capas_geom.pop("vias"):
        hw = tags.get("highway")
        if g.geom_type != "LineString":
            continue
        # Túneles y vías bajo tierra no se pintan en la superficie (Rondas, pasos inferiores…)
        if tags.get("tunnel") in ("yes", "building_passage", "culvert") or str(tags.get("layer", "0")).strip().startswith("-") \
                or tags.get("covered") == "yes":
            continue
        if hw in ANCHO:
            calzada.append(g.buffer(ANCHO[hw] / 2, cap_style=2, join_style=2))
        elif hw in PEATONAL:
            peatonal.append(g.buffer(PEATONAL[hw] / 2, cap_style=2, join_style=2))
    poligonos = lambda lst: [g for _, g in lst if g.geom_type in ("Polygon", "MultiPolygon")]  # noqa: E731
    fuentes = {
        "verde": poligonos(capas_geom["verde"]), "agua": poligonos(capas_geom["agua"]),
        "playa": poligonos(capas_geom["playa"]), "peatonal": peatonal + poligonos(capas_geom["plaza"]), "calzada": calzada,
    }

    # Unión y recorte por bloques de 1 km (más rápido que unir toda la ciudad de golpe)
    log("uniendo y recortando por bloques de 1 km")
    bloques = {}
    gx0, gy0 = minx, miny
    recortes = {}                       # celda ∩ ciudad, calculado una vez por celda
    def recorte(i, j):
        if (i, j) not in recortes:
            celda = box(gx0 + i * BLOQUE, gy0 + j * BLOQUE, gx0 + (i + 1) * BLOQUE, gy0 + (j + 1) * BLOQUE)
            recortes[(i, j)] = (celda, celda.intersection(ciudad))
        return recortes[(i, j)]
    for capa, geoms in fuentes.items():
        if not geoms:
            continue
        arr = shapely.make_valid(shapely.set_precision(shapely.from_wkb([g.wkb for g in geoms]), 0.05))
        tree = shapely.STRtree(arr)
        for i in range(int((maxx - minx) // BLOQUE) + 1):
            for j in range(int((maxy - miny) // BLOQUE) + 1):
                celda, zona = recorte(i, j)
                if zona.is_empty:
                    continue
                idx = tree.query(celda, predicate="intersects")
                if not len(idx):
                    continue
                g = shapely.union_all(arr[idx]).intersection(zona)
                g = g.simplify(0.6, preserve_topology=True)
                polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
                polys = [p for p in polys if p.area > 8]
                if polys:
                    bloques.setdefault((i, j), {}).setdefault(capa, []).extend(
                        {"o": local(p.exterior.coords), "i": [local(r.coords) for r in p.interiors]} for p in polys)
        log(f"  {capa} listo ({time.time() - t0:.0f} s)")

    carpeta = salida / "base"
    carpeta.mkdir(exist_ok=True)
    for viejo in carpeta.glob("*.json"):
        viejo.unlink()
    lista = []
    for (i, j), capas in sorted(bloques.items()):
        nombre = f"base/{i}_{j}.json"
        (salida / nombre).write_text(json.dumps({"layers": capas}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        lista.append({"file": nombre, "count": sum(len(v) for v in capas.values())})
    indice["base"] = {"tiles": lista, "layers": list(fuentes)}

    # ---------------- Monumentos ----------------
    log("buscando monumentos en OpenStreetMap")
    patron = "|".join(f"({m['rx']})" for m in MONUMENTOS)
    datos = overpass(f'[out:json][timeout:180];nwr["name"~"{patron}",i]{bb};out geom;', BRONZE / "osm" / "monumentos.json", a.forzar)
    candidatos = geometrias(datos.get("elements", []), a_utm)
    landmarks = []
    for k, M in enumerate(MONUMENTOS):
        nombre, rx = M["nombre"], M["rx"]
        ref = Point(*a_utm(M["lon"], M["lat"]))
        mejores = []
        for tags, g in candidatos:
            if not re.search(rx, tags.get("name", ""), re.I):
                continue
            d = g.distance(ref)
            if d > 600:
                continue
            area = g.area if g.geom_type in ("Polygon", "MultiPolygon") else 0
            peso = (area > 0) * 2 + ("building" in tags or "historic" in tags or "tourism" in tags or "place" in tags)
            mejores.append((peso, area, -d, tags, g))
        if mejores:
            mejores.sort(key=lambda m: (m[0], m[1], m[2]), reverse=True)
            _, area, _, tags, g = mejores[0]
        else:
            tags, g, area = {}, ref, 0
        altura = None
        for kt in ("height", "building:height"):
            try:
                altura = float(str(tags.get(kt, "")).replace("m", "").replace(",", ".").strip())
                break
            except ValueError:
                pass
        c = g.representative_point() if area else (g if g.geom_type == "Point" else g.centroid)
        poly, eje = None, None
        if area:
            pg = g if g.geom_type == "Polygon" else max(g.geoms, key=lambda x: x.area)
            pg = pg.simplify(0.8)
            poly = local(pg.exterior.coords)
            # eje principal (para colocar las torres de la Sagrada Família)
            r = list(pg.minimum_rotated_rectangle.exterior.coords)
            l1 = ((r[1][0] - r[0][0]) ** 2 + (r[1][1] - r[0][1]) ** 2) ** 0.5
            l2 = ((r[2][0] - r[1][0]) ** 2 + (r[2][1] - r[1][1]) ** 2) ** 0.5
            a_, b_ = (r[0], r[1]) if l1 >= l2 else (r[1], r[2])
            L = max(l1, l2) or 1
            eje = {"u": [round((b_[0] - a_[0]) / L, 4), round(-(b_[1] - a_[1]) / L, 4)], "len": round(max(l1, l2), 1), "wid": round(min(l1, l2), 1)}
        modo = M.get("modo", "catastro")
        alto = M.get("alto")
        if altura and modo == "osm" and M.get("aguja"):
            alto = max(alto or 0, altura)            # la altura de OSM suele ser la de la torre más alta
        cuerpo = M.get("cuerpo", 0)
        if altura and modo == "osm" and not M.get("aguja"):
            cuerpo = altura
        landmarks.append({"k": k, "name": nombre, "x": round(c.x - ox, 1), "z": round(-(c.y - oy), 1), "poly": poly, "axis": eje,
                          "mode": modo, "body_h": cuerpo, "spire": M.get("aguja"), "spire_h": alto,
                          "found": bool(mejores), "square": modo == "plaza"})
        log(f"  {nombre}: {'encontrado' if mejores else 'NO encontrado (uso coordenadas aproximadas)'}"
            + (f", altura OSM {altura:.0f} m" if altura else "") + (f" · se dibuja a {cuerpo} m" if modo == "osm" else ""))
    indice["landmarks"] = landmarks

    # ---------------- Marcar volúmenes de cada monumento ----------------
    log("marcando los edificios de cada monumento")
    zonas = []
    for lm in landmarks:
        if lm["square"]:
            continue
        g = Polygon(lm["poly"]).buffer(2) if lm["poly"] and len(lm["poly"]) >= 3 else Point(lm["x"], lm["z"]).buffer(25)
        zonas.append((lm["k"], g, lm["mode"] == "osm" and lm["poly"] is not None))
    marcados = sustituidos = 0
    for nivel in ("lod1", "lod2"):
        for t in indice[nivel]["tiles"]:
            tb = box(*t["bbox"])
            relevantes = [z for z in zonas if z[1].intersects(tb)]
            ruta = salida / t["file"]
            if not relevantes:
                continue
            datos_t = json.loads(ruta.read_text(encoding="utf-8"))
            for v in datos_t["parts"]:
                v.pop("lm", None); v.pop("lmx", None)
                if len(v["o"]) < 3:
                    continue
                pv = Polygon(v["o"]).buffer(0)
                for k, g, sustituir in relevantes:
                    if not pv.intersects(g):
                        continue
                    dentro = pv.intersection(g).area
                    if sustituir and dentro > 0.5 * pv.area:
                        v["lmx"] = k; sustituidos += 1; break       # lo dibuja la forma de OSM
                    if dentro > 0.3 * min(pv.area, g.area):
                        v["lm"] = k; marcados += 1; break
            ruta.write_text(json.dumps(datos_t, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    indice["source"] = indice.get("source", "").split(" · OpenStreetMap")[0] + " · OpenStreetMap contributors (ODbL)"
    indice_path.write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"listo en {time.time() - t0:.0f} s: {len(lista)} bloques de mapa base, {len(landmarks)} monumentos, {marcados} volúmenes en sanguina y {sustituidos} sustituidos por su forma real")


if __name__ == "__main__":
    main()
