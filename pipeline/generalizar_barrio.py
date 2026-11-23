#!/usr/bin/env python3
"""Generalización cartográfica: de partes del Catastro a volúmenes limpios para dibujar.

El Catastro divide cada edificio en muchas partes (casetas de azotea, patios de una planta,
retranqueos de pocos centímetros). Para una ilustración legible, cada edificio se reduce a:

    bajos   -> construcciones de 1-2 plantas (patios de manzana, locales)
    cuerpo  -> el volumen principal, con su altura típica (mediana ponderada por superficie)
    torre   -> partes claramente más altas que el cuerpo y con superficie suficiente
    sótano  -> la huella bajo rasante, con su profundidad típica

Cada grupo se une, se limpia (apertura morfológica), se simplifica y se separa un poco de sus
vecinos para que el contorno de tinta tenga sitio. Requiere haber ejecutado edificios_barrio.py.

Uso:
    python pipeline/generalizar_barrio.py --barrio "la Dreta de l'Eixample"

Produce data/gold/<barrio>/lod1/X_Y.json y añade "lod1" al index.json (el visor lo usa si existe).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import GOLD, SILVER, log, slug  # noqa: E402
from edificios_barrio import ALTURA_SOTANO, altura, poligono_barrio, tabla_barrios  # noqa: E402

SIMPLIFICAR_M = 0.9     # tolerancia de simplificación (m)
APERTURA_M = 0.6        # elimina salientes y huecos más estrechos que ~1,2 m
SEPARACION_M = 0.15     # hueco entre edificios vecinos para el contorno
AREA_MIN = {"bajos": 15.0, "cuerpo": 25.0, "torre": 40.0, "sotano": 30.0}


def mediana_ponderada(valores, pesos) -> float:
    import numpy as np
    v = np.asarray(valores, dtype=float); w = np.asarray(pesos, dtype=float)
    orden = np.argsort(v); v, w = v[orden], w[orden]
    acum = np.cumsum(w)
    return float(v[np.searchsorted(acum, acum[-1] / 2)])


def valida(g):
    """Repara geometrías inválidas y fija la precisión a 1 cm (evita errores topológicos de GEOS)."""
    import shapely
    from shapely.validation import make_valid
    if g is None or g.is_empty:
        return g
    if not g.is_valid:
        g = make_valid(g)
    g = shapely.set_precision(g, 0.01)
    if g.geom_type == "GeometryCollection":   # quedarse solo con las superficies
        from shapely.ops import unary_union
        g = unary_union([x for x in g.geoms if x.geom_type in ("Polygon", "MultiPolygon")])
    return g


def unir(geoms):
    from shapely.ops import unary_union
    return valida(unary_union([valida(g) for g in geoms]))


def restar(a, b):
    """a - b sin romperse: si GEOS falla incluso con geometrías reparadas, devuelve a."""
    try:
        return valida(valida(a).difference(valida(b)))
    except Exception:
        try:
            return valida(valida(a).buffer(0).difference(valida(b).buffer(0)))
        except Exception:
            return valida(a)


def limpiar(geom):
    """Apertura morfológica + simplificación + pequeña separación. Devuelve lista de polígonos."""
    from shapely.geometry import MultiPolygon, Polygon
    geom = valida(geom)
    if geom is None or geom.is_empty:
        return []
    g = geom.buffer(-APERTURA_M, join_style=2).buffer(APERTURA_M, join_style=2)
    g = g.simplify(SIMPLIFICAR_M, preserve_topology=True).buffer(-SEPARACION_M, join_style=2)
    if g.is_empty:
        return []
    polys = [g] if isinstance(g, Polygon) else [p for p in getattr(g, "geoms", []) if isinstance(p, Polygon)]
    if isinstance(g, MultiPolygon):
        polys = list(g.geoms)
    return [p for p in polys if p.is_valid and not p.is_empty]


def generalizar_edificio(grupo):
    """grupo: GeoDataFrame con las partes de una referencia catastral. Devuelve lista de volúmenes."""
    from shapely.ops import unary_union

    vol = []
    sobre = grupo[grupo["plantas_sobre"] > 0]
    if len(sobre):
        bajos = sobre[sobre["plantas_sobre"] <= 2]
        altos = sobre[sobre["plantas_sobre"] > 2]
        g_torre = None
        if len(altos):
            cuerpo_f = int(round(mediana_ponderada(altos["plantas_sobre"], altos.area)))
            cand = altos[(altos["plantas_sobre"] >= cuerpo_f + 2) & (altos.area >= AREA_MIN["torre"])]
            if len(cand):
                torre_f = int(round(mediana_ponderada(cand["plantas_sobre"], cand.area)))
                g_torre = unir(list(cand.geometry))
                for p in limpiar(g_torre):
                    if p.area >= AREA_MIN["torre"]:
                        vol.append(("torre", p, torre_f, 0))
            g_cuerpo = unir(list(altos.geometry))
            if g_torre is not None:
                g_cuerpo = restar(g_cuerpo, g_torre.buffer(0.05))
            for p in limpiar(g_cuerpo):
                if p.area >= AREA_MIN["cuerpo"]:
                    vol.append(("cuerpo", p, cuerpo_f, 0))
        if len(bajos):
            bajos_f = int(round(mediana_ponderada(bajos["plantas_sobre"], bajos.area)))
            g_bajos = unir(list(bajos.geometry))
            if len(altos):
                g_bajos = restar(g_bajos, unir(list(altos.geometry)).buffer(0.05))
            for p in limpiar(g_bajos):
                if p.area >= AREA_MIN["bajos"]:
                    vol.append(("bajos", p, max(1, bajos_f), 0))
    bajo = grupo[grupo["plantas_bajo"] > 0]
    if len(bajo):
        fb = int(round(mediana_ponderada(bajo["plantas_bajo"], bajo.area)))
        for p in limpiar(unir(list(bajo.geometry))):
            if p.area >= AREA_MIN["sotano"]:
                vol.append(("sotano", p, 0, fb))
    return vol


def main() -> None:
    import geopandas as gpd
    import pandas as pd

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--barrio", default="la Dreta de l'Eixample")
    ap.add_argument("--municipio", default="BARCELONA")
    a = ap.parse_args()

    salida = GOLD / slug(a.barrio)
    indice_path = salida / "index.json"
    if not indice_path.exists():
        raise SystemExit(f"No existe {indice_path}. Ejecuta antes edificios_barrio.py con el mismo --barrio.")
    indice = json.loads(indice_path.read_text(encoding="utf-8"))
    ox, oy = indice["origin"]
    tile = float(indice["tile_size"])

    _, barrio_geom = poligono_barrio(tabla_barrios(False), a.barrio)
    silver = gpd.read_parquet(SILVER / "catastro" / f"partes_edificio_{slug(a.municipio)}.parquet")
    zona = silver[silver.intersects(barrio_geom)].copy()
    zona = zona[zona.representative_point().within(barrio_geom.buffer(1.0))]
    zona["geometry"] = zona.geometry.buffer(0)
    zona["uso"] = zona["uso"].astype("string").str.replace(r"^(\d+_)+", "", regex=True)
    zona["ano"] = pd.to_numeric(zona["ano"], errors="coerce")
    zona.loc[zona["ano"] < 1100, "ano"] = pd.NA
    log(f"generalizando {zona['refcat'].nunique():,} edificios ({len(zona):,} partes)")

    def local(coords):
        out = [[round(x - ox, 1), round(-(y - oy), 1)] for x, y, *_ in coords]
        return out[:-1] if len(out) > 1 and out[0] == out[-1] else out

    minx, miny, _, _ = zona.total_bounds
    teselas: dict[tuple[int, int], list] = {}
    n_vol = 0
    for i, (refcat, grupo) in enumerate(zona.groupby("refcat")):
        ano = grupo["ano"].dropna()
        uso = grupo["uso"].dropna()
        info = {"y": int(ano.iloc[0]) if len(ano) else None,
                "u": str(uso.mode().iloc[0]) if len(uso) else None,
                "fmax": int(grupo["plantas_sobre"].max())}
        for k, (clase, poly, f, fb) in enumerate(generalizar_edificio(grupo)):
            pt = poly.representative_point()
            clave = (int((pt.x - minx) // tile), int((pt.y - miny) // tile))
            teselas.setdefault(clave, []).append({
                "id": f"{refcat}_{clase}{k}", "c": clase,
                "h": altura(f) if f > 0 else 0.0, "d": round(fb * ALTURA_SOTANO, 1),
                "f": f, "fb": fb, "fmax": info["fmax"], "y": info["y"], "u": info["u"],
                "o": local(poly.exterior.coords), "i": [local(r.coords) for r in poly.interiors],
            })
            n_vol += 1
        if (i + 1) % 500 == 0:
            log(f"  {i + 1:,} edificios…")

    carpeta = salida / "lod1"
    carpeta.mkdir(exist_ok=True)
    for viejo in carpeta.glob("*.json"):
        viejo.unlink()
    lista = []
    for (i, j), vols in sorted(teselas.items()):
        nombre = f"lod1/{i}_{j}.json"
        (salida / nombre).write_text(json.dumps({"tile": [i, j], "parts": vols}, ensure_ascii=False, separators=(",", ":")),
                                     encoding="utf-8")
        lista.append({"file": nombre, "count": len(vols)})
    vertices = sum(len(v["o"]) + sum(len(r) for r in v["i"]) for vs in teselas.values() for v in vs)
    indice["lod1"] = {"tiles": lista, "volumes": n_vol, "vertices": vertices,
                      "params": {"simplificar_m": SIMPLIFICAR_M, "apertura_m": APERTURA_M, "separacion_m": SEPARACION_M}}
    indice_path.write_text(json.dumps(indice, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"lod1: {n_vol:,} volúmenes ({vertices:,} vértices) frente a {len(zona):,} partes originales")


if __name__ == "__main__":
    main()
