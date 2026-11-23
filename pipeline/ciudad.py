#!/usr/bin/env python3
"""Toda Barcelona: edificios generalizados en dos niveles de detalle, en paralelo.

Requiere el silver del Catastro (lo crea edificios_barrio.py la primera vez).

Uso:
    python pipeline/ciudad.py                 # usa todos los núcleos menos uno
    python pipeline/ciudad.py --procesos 4

Produce data/gold/barcelona/:
    index.json      origen, contorno de la ciudad, 73 barrios (contorno, centro, cifras), teselas y estadísticas
    lod1/X_Y.json   volúmenes por edificio (cuerpo, torre, bajos, sótano): para ver de cerca
    lod2/X_Y.json   volúmenes por manzana (+ torres): para ver la ciudad entera
Después, para el metro de toda la ciudad:
    python pipeline/metro_barrio.py --barrio barcelona
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import CRS, GOLD, SILVER, columna, log  # noqa: E402
from edificios_barrio import ALTURA_SOTANO, altura, tabla_barrios  # noqa: E402
from generalizar_barrio import generalizar_edificio, limpiar, mediana_ponderada, restar, unir, valida  # noqa: E402

SLUG = "barcelona"
TILE = 250.0
GRUPO = 4                # el nivel 2 se guarda en bloques de 4×4 teselas (1 km)
# Nivel 2 (manzanas): más simplificado
LOD2_FUSION_M = 0.6      # cierra las separaciones entre fincas de la misma manzana
LOD2_APERTURA_M = 1.5
LOD2_SIMPLIFICAR_M = 2.0
LOD2_TORRE_EXTRA_M = 12  # una torre destaca si supera la manzana en 12 m o más
LOD2_AREA_MIN = 60.0


def local_fn(ox, oy):
    def local(coords):
        out = [[round(x - ox, 1), round(-(y - oy), 1)] for x, y, *_ in coords]
        return out[:-1] if len(out) > 1 and out[0] == out[-1] else out
    return local


def manzana(refcat: str) -> str:
    """La referencia catastral (14 caracteres) = 5 de manzana + 2 de parcela + 7 de hoja del plano."""
    r = str(refcat)
    return r[:5] + r[7:14] if len(r) >= 14 else r[:5]


def procesar_tesela(args):
    """Se ejecuta en un proceso aparte: genera los volúmenes de nivel 1 y 2 de una tesela."""
    from shapely.ops import unary_union

    clave, grupo_tesela, ox, oy = args
    local = local_fn(ox, oy)
    lod1, por_manzana, errores = [], {}, 0
    for refcat, grupo in grupo_tesela.groupby("refcat"):
        ano = grupo["ano"].dropna()
        uso = grupo["uso"].dropna()
        info = {"y": int(ano.iloc[0]) if len(ano) else None,
                "u": str(uso.mode().iloc[0]) if len(uso) else None,
                "fmax": int(grupo["plantas_sobre"].max()),
                "b": int(grupo["barrio"].mode().iloc[0])}
        try:
            volumenes = generalizar_edificio(grupo)
        except Exception:
            errores += 1
            continue
        for k, (clase, poly, f, fb) in enumerate(volumenes):
            h = altura(f) if f > 0 else 0.0
            lod1.append({"id": f"{refcat}_{clase}{k}", "c": clase, "h": h, "d": round(fb * ALTURA_SOTANO, 1),
                         "f": f, "fb": fb, **info,
                         "o": local(poly.exterior.coords), "i": [local(r.coords) for r in poly.interiors]})
            if clase in ("cuerpo", "torre"):
                por_manzana.setdefault(manzana(refcat), []).append((poly, h, clase, info["b"]))
            elif clase == "bajos":
                por_manzana.setdefault("bajos:" + manzana(refcat), []).append((poly, h, clase, info["b"]))

    # ---- Nivel 2: una manzana = un volumen (+ torres que destacan)
    lod2 = []
    for mz, vols in por_manzana.items():
        if mz.startswith("bajos:") and mz[6:] in por_manzana:
            continue  # la manzana ya tiene cuerpo: los bajos del patio no se dibujan de lejos
        try:
            lod2 += manzana_lod2(mz, vols, local)
        except Exception:
            errores += 1
    return clave, lod1, lod2, errores


def manzana_lod2(mz, vols, local):
    """Una manzana -> un volumen (más las torres que destacan)."""
    from shapely.ops import unary_union
    lod2 = []
    if True:
        alturas = [v[1] for v in vols if v[2] != "torre"] or [v[1] for v in vols]
        areas = [v[0].area for v in vols if v[2] != "torre"] or [v[0].area for v in vols]
        h_mz = mediana_ponderada(alturas, areas)
        torres = [v[0] for v in vols if v[1] >= h_mz + LOD2_TORRE_EXTRA_M and v[0].area >= 150]
        g = unir([v[0].buffer(LOD2_FUSION_M, join_style=2) for v in vols]).buffer(-LOD2_FUSION_M, join_style=2)
        g = g.buffer(-LOD2_APERTURA_M, join_style=2).buffer(LOD2_APERTURA_M, join_style=2)
        g_torres = unir(torres) if torres else None
        if g_torres is not None:
            g = restar(g, g_torres.buffer(0.1))
        g = g.simplify(LOD2_SIMPLIFICAR_M, preserve_topology=True).buffer(-0.3, join_style=2)
        b = vols[0][3]
        polys = [g] if g.geom_type == "Polygon" else [p for p in getattr(g, "geoms", []) if p.geom_type == "Polygon"]
        for n, p in enumerate(polys):
            if p.area >= LOD2_AREA_MIN:
                lod2.append({"id": f"{mz}_m{n}", "c": "manzana", "h": round(h_mz, 1), "d": 0, "b": b,
                             "o": local(p.exterior.coords), "i": [local(r.coords) for r in p.interiors]})
        for n, t in enumerate(torres):
            ht = max(v[1] for v in vols if v[0] is t)
            for p in limpiar(t):
                lod2.append({"id": f"{mz}_t{n}", "c": "torre", "h": ht, "d": 0, "b": b,
                             "o": local(p.exterior.coords), "i": [local(r.coords) for r in p.interiors]})
    return lod2


def tabla_barrios_gdf():
    import geopandas as gpd
    from shapely import wkt

    df = tabla_barrios(False)
    c_nom = columna(df, "nom_barri")
    c_cod = columna(df, "codi_barri", obligatoria=False)
    c_dis = columna(df, "nom_districte", obligatoria=False)
    c_geo, crs = columna(df, "geometria", "etrs89", obligatoria=False), CRS
    if c_geo is None:
        c_geo, crs = columna(df, "geometria", "wgs84"), "EPSG:4326"
    return gpd.GeoDataFrame({
        "codi": df[c_cod].astype(int) if c_cod else range(1, len(df) + 1),
        "nom": df[c_nom].astype(str),
        "districte": df[c_dis].astype(str) if c_dis else "",
    }, geometry=[wkt.loads(x) for x in df[c_geo]], crs=crs).to_crs(CRS)


def main() -> None:
    import geopandas as gpd
    import pandas as pd
    from pyproj import Transformer
    from shapely.ops import unary_union

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--municipio", default="BARCELONA")
    ap.add_argument("--procesos", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    t0 = time.time()

    silver_path = SILVER / "catastro" / f"partes_edificio_{a.municipio.lower()}.parquet"
    if not silver_path.exists():
        raise SystemExit(f"No existe {silver_path}. Ejecuta antes edificios_barrio.py (crea el silver de toda la ciudad).")
    log("leyendo el silver del Catastro")
    partes = gpd.read_parquet(silver_path)
    partes["geometry"] = partes.geometry.buffer(0)
    partes["uso"] = partes["uso"].astype("string").str.replace(r"^(\d+_)+", "", regex=True)
    partes["ano"] = pd.to_numeric(partes["ano"], errors="coerce")
    partes.loc[partes["ano"] < 1100, "ano"] = pd.NA

    log("asignando cada parte a su barrio")
    barrios = tabla_barrios_gdf()
    puntos = gpd.GeoDataFrame(partes[["refcat"]], geometry=partes.representative_point(), crs=CRS)
    union = gpd.sjoin(puntos, barrios[["codi", "geometry"]], predicate="within", how="inner")
    union = union[~union.index.duplicated()]          # puntos justo en el límite entre dos barrios
    partes = partes.loc[union.index].copy()
    partes["barrio"] = union["codi"].values
    partes["cx"] = puntos.loc[partes.index].geometry.x.values
    partes["cy"] = puntos.loc[partes.index].geometry.y.values
    log(f"{len(partes):,} partes de {partes['refcat'].nunique():,} edificios en {barrios['codi'].nunique()} barrios")

    ciudad = unary_union(list(barrios.geometry))
    cx, cy = ciudad.centroid.x, ciudad.centroid.y
    ox, oy = round(cx / 10) * 10, round(cy / 10) * 10
    local = local_fn(ox, oy)
    minx, miny = partes["cx"].min(), partes["cy"].min()

    # Cada edificio va entero a una tesela (la de su punto medio)
    centro = partes.groupby("refcat")[["cx", "cy"]].mean()
    centro["ti"] = ((centro["cx"] - minx) // TILE).astype(int)
    centro["tj"] = ((centro["cy"] - miny) // TILE).astype(int)
    partes = partes.join(centro[["ti", "tj"]], on="refcat")
    tareas = [((int(i), int(j)), g.drop(columns=["ti", "tj"]), ox, oy) for (i, j), g in partes.groupby(["ti", "tj"])]
    log(f"generalizando {len(tareas):,} teselas con {a.procesos} procesos…")

    salida = GOLD / SLUG
    for sub in ("lod1", "lod2"):
        (salida / sub).mkdir(parents=True, exist_ok=True)
        for viejo in (salida / sub).glob("*.json"):
            viejo.unlink()
    idx1, idx2, n1, n2 = [], [], 0, 0
    lod2_grupos: dict[tuple[int, int], list] = {}     # nivel 2 agrupado en bloques de GRUPO×GRUPO teselas (menos llamadas de dibujo)

    def bbox(vols):
        xs = [p[0] for v in vols for p in v["o"]]
        zs = [p[1] for v in vols for p in v["o"]]
        return [min(xs), min(zs), max(xs), max(zs)]

    errores_total = 0

    def guardar(clave, lod1, lod2, errores=0):
        nonlocal n1, n2, errores_total
        errores_total += errores
        i, j = clave
        if lod1:
            nombre = f"lod1/{i}_{j}.json"
            (salida / nombre).write_text(json.dumps({"tile": [i, j], "parts": lod1}, ensure_ascii=False, separators=(",", ":")),
                                         encoding="utf-8")
            idx1.append({"file": nombre, "i": i, "j": j, "count": len(lod1), "bbox": bbox(lod1),
                         "hmax": max(v["h"] for v in lod1), "dmax": max(v["d"] for v in lod1)})
        for v in lod2:
            v["t"] = [i, j]
        if lod2:
            lod2_grupos.setdefault((i // GRUPO, j // GRUPO), []).extend(lod2)
        n1 += len(lod1); n2 += len(lod2)

    hechas = 0
    if a.procesos > 1:
        with ProcessPoolExecutor(max_workers=a.procesos) as pool:
            futuros = [pool.submit(procesar_tesela, t) for t in tareas]
            for fut in as_completed(futuros):
                guardar(*fut.result()); hechas += 1
                if hechas % 100 == 0:
                    log(f"  {hechas:,} / {len(tareas):,} teselas ({time.time() - t0:.0f} s)")
    else:
        for t in tareas:
            guardar(*procesar_tesela(t)); hechas += 1
            if hechas % 100 == 0:
                log(f"  {hechas:,} / {len(tareas):,} teselas ({time.time() - t0:.0f} s)")

    for (gi, gj), vols in sorted(lod2_grupos.items()):
        nombre = f"lod2/{gi}_{gj}.json"
        (salida / nombre).write_text(json.dumps({"group": [gi, gj], "parts": vols}, ensure_ascii=False, separators=(",", ":")),
                                     encoding="utf-8")
        idx2.append({"file": nombre, "count": len(vols), "bbox": bbox(vols)})
    grid = [max(t["i"] for t in idx1) + 1, max(t["j"] for t in idx1) + 1] if idx1 else [1, 1]

    # ---- Barrios: contorno, centro y cifras
    log("resumiendo barrios")
    h = partes["plantas_sobre"].map(altura)
    partes["h"] = h
    lista_barrios = []
    for b in barrios.itertuples():
        sel = partes[partes["barrio"] == b.codi]
        geom = b.geometry if b.geometry.geom_type == "Polygon" else max(b.geometry.geoms, key=lambda g: g.area)
        geom = geom.simplify(4.0)
        c = b.geometry.representative_point()
        anos = sel.drop_duplicates("refcat")["ano"].dropna()
        lista_barrios.append({
            "codi": int(b.codi), "nom": b.nom, "districte": b.districte,
            "outline": local(geom.exterior.coords), "center": [round(c.x - ox, 1), round(-(c.y - oy), 1)],
            "edificios": int(sel["refcat"].nunique()),
            "altura_mediana_m": round(float(sel.loc[sel["h"] > 0, "h"].median()), 1) if (sel["h"] > 0).any() else None,
            "ano_mediano": int(anos.median()) if len(anos) else None,
        })

    piezas = [ciudad] if ciudad.geom_type == "Polygon" else sorted(ciudad.geoms, key=lambda g: -g.area)
    contornos = [local(p.simplify(4.0).exterior.coords) for p in piezas if p.area > 20000]
    lon, lat = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True).transform(ox, oy)
    anos = partes.drop_duplicates("refcat")["ano"].dropna()
    stats = {
        "edificios": int(partes["refcat"].nunique()), "partes": int(len(partes)),
        "altura_mediana_m": round(float(h[h > 0].median()), 1), "altura_max_m": round(float(h.max()), 1),
        "ano_mediano": int(anos.median()) if len(anos) else None,
        "partes_con_sotano": int((partes["plantas_bajo"] > 0).sum()),
        "volumenes_lod1": n1, "volumenes_lod2": n2,
    }
    indice = {
        "barrio": "Barcelona", "ciudad": True, "crs": CRS, "origin": [ox, oy],
        "origin_lonlat": [round(lon, 6), round(lat, 6)], "axes": "x = este (m), z = sur (m), y = altura (m)",
        "tile_size": TILE, "grid": grid, "outline": contornos[0], "outlines": contornos,
        "barrios": lista_barrios, "lod1": {"tiles": idx1, "volumes": n1}, "lod2": {"tiles": idx2, "volumes": n2},
        "stats": stats,
        "source": "Dirección General del Catastro (INSPIRE Buildings) · Ajuntament de Barcelona (Open Data BCN)",
    }
    (salida / "index.json").write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    if errores_total:
        log(f"aviso: {errores_total} edificios o manzanas con geometría irrecuperable se han omitido")
    log(f"listo en {time.time() - t0:.0f} s: {n1:,} volúmenes de cerca, {n2:,} de lejos, "
        f"{len(idx1)} teselas de cerca y {len(idx2)} bloques de lejos -> {salida}")
    print(json.dumps(stats, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
