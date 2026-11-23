#!/usr/bin/env python3
"""Edificios de un barrio de Barcelona: Catastro INSPIRE -> bronze / silver / gold.

Uso:
    python pipeline/edificios_barrio.py --barrio "la Dreta de l'Eixample"
    python pipeline/edificios_barrio.py --listar-barrios

Qué produce (en data/gold/<barrio>/):
    index.json       metadatos, origen de coordenadas, contorno del barrio y lista de teselas
    tiles/X_Y.json   partes de edificio de cada tesela, en metros locales, listas para extruir
    preview.png      mapa de alturas y distribuciones (control visual rápido)
    informe.md       cifras básicas del barrio
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from collections import Counter
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, CRS, GOLD, HEADERS, SILVER, columna, descargar, log, norm, slug  # noqa: E402

ATOM_PROVINCIA = "https://www.catastro.hacienda.gob.es/INSPIRE/buildings/08/ES.SDGC.bu.atom_08.xml"
CKAN_BARRIS = "https://opendata-ajuntament.barcelona.cat/data/api/3/action/package_show?id=20170706-districtes-barris"
ATOM_NS = {"a": "http://www.w3.org/2005/Atom"}

ALTURA_PB = 4.0      # planta baja (m)
ALTURA_PLANTA = 3.0  # resto de plantas (m)
ALTURA_SOTANO = 3.0  # plantas bajo rasante (m)


# --------------------------------------------------------------------------- Catastro
def _zip_en_entrada(entrada) -> str | None:
    for l in entrada.findall("a:link", ATOM_NS):
        href = l.get("href") or ""
        if href.lower().endswith(".zip"):
            return href
    ident = entrada.findtext("a:id", default="", namespaces=ATOM_NS)
    return ident if ident.lower().endswith(".zip") else None


def buscar_zip_catastro(xml: bytes, municipio: str) -> tuple[str, str]:
    """Devuelve (título, url del zip) del municipio dentro del feed ATOM de la provincia."""
    raiz = ET.fromstring(xml)
    objetivo = norm(municipio)
    candidatos = []
    for e in raiz.findall("a:entry", ATOM_NS):
        titulo = e.findtext("a:title", default="", namespaces=ATOM_NS)
        m = re.search(r"(\d{5})-(.+)", titulo)
        nombre = norm(m.group(2)) if m else norm(titulo)
        # El título suele ser "08900-BARCELONA" pero puede llevar texto detrás
        if nombre == objetivo or nombre.split(" buildings")[0] == objetivo or nombre.startswith(objetivo + " "):
            candidatos.append((titulo, e))
    if not candidatos:
        raise SystemExit(f"No encuentro '{municipio}' en el feed ATOM. Usa --zip-file con el zip descargado a mano.")
    titulo, entrada = candidatos[0]
    url = _zip_en_entrada(entrada)
    if url is None:
        # Algunos feeds enlazan a un sub-feed del municipio en vez de al zip directamente
        sub = next((l.get("href") for l in entrada.findall("a:link", ATOM_NS) if (l.get("href") or "").endswith(".xml")), None)
        if not sub:
            raise SystemExit(f"La entrada '{titulo}' no tiene enlace al zip. Usa --zip-file.")
        sub_xml = requests.get(sub, headers=HEADERS, timeout=60).content
        sub_raiz = ET.fromstring(sub_xml)
        url = next((_zip_en_entrada(e) for e in sub_raiz.findall("a:entry", ATOM_NS) if _zip_en_entrada(e)), None)
        if not url:
            raise SystemExit(f"No encuentro el zip en el sub-feed {sub}. Usa --zip-file.")
    return titulo, url


def obtener_zip_catastro(municipio: str, zip_file: str | None, forzar: bool) -> Path:
    if zip_file:
        return Path(zip_file)
    log("consultando el feed ATOM de edificios del Catastro (provincia 08)")
    xml = requests.get(ATOM_PROVINCIA, headers=HEADERS, timeout=60).content
    titulo, url = buscar_zip_catastro(xml, municipio)
    log(f"municipio encontrado: {titulo}")
    return descargar(url, BRONZE / "catastro" / Path(url).name, forzar=forzar)


def leer_gml(zip_path: Path):
    import geopandas as gpd

    destino = BRONZE / "catastro" / zip_path.stem
    if not destino.exists():
        log(f"descomprimiendo {zip_path.name}")
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(destino)
    gmls = list(destino.rglob("*.gml"))
    f_partes = next((p for p in gmls if p.name.lower().endswith("buildingpart.gml")), None)
    f_edif = next((p for p in gmls if p.name.lower().endswith(".building.gml")), None)
    if not f_partes or not f_edif:
        raise SystemExit(f"No encuentro building.gml y buildingpart.gml en {destino}: {[p.name for p in gmls]}")
    log(f"leyendo {f_partes.name} (puede tardar un par de minutos en Barcelona)")
    partes = gpd.read_file(f_partes, engine="pyogrio")
    log(f"leyendo {f_edif.name}")
    edificios = gpd.read_file(f_edif, engine="pyogrio")
    for gdf in (partes, edificios):
        if gdf.crs is None:
            gdf.set_crs(CRS, inplace=True)
    return partes.to_crs(CRS), edificios.to_crs(CRS)


# --------------------------------------------------------------------------- Barrios
def tabla_barrios(forzar: bool):
    import pandas as pd

    destino = BRONZE / "barris" / "BarcelonaCiutat_Barris.csv"
    if not destino.exists() or forzar:
        log("buscando el CSV de barrios en Open Data BCN")
        meta = requests.get(CKAN_BARRIS, headers=HEADERS, timeout=60).json()
        recursos = meta["result"]["resources"]
        rec = next((r for r in recursos if "barris" in (r.get("name") or "").lower()
                    and (r.get("format") or "").lower() == "csv"
                    and "aees" not in (r.get("name") or "").lower()), None)
        rec = next((r for r in recursos if (r.get("name") or "").startswith("BarcelonaCiutat_Barris")), rec)
        if not rec:
            raise SystemExit("No encuentro BarcelonaCiutat_Barris.csv en el dataset de Open Data BCN.")
        descargar(rec["url"], destino, forzar=forzar)
    return pd.read_csv(destino)


def poligono_barrio(df, nombre: str):
    import geopandas as gpd
    from shapely import wkt

    c_nom = columna(df, "nom_barri")
    c_geo = columna(df, "geometria", "etrs89", obligatoria=False)
    crs_geo = CRS
    if c_geo is None:
        c_geo = columna(df, "geometria", "wgs84")
        crs_geo = "EPSG:4326"
    objetivo = norm(nombre)
    exactos = df[df[c_nom].map(norm) == objetivo]
    fila = exactos if len(exactos) else df[df[c_nom].map(norm).str.contains(objetivo, regex=False)]
    if len(fila) != 1:
        opciones = ", ".join(sorted(df[c_nom].astype(str))) if len(fila) == 0 else ", ".join(fila[c_nom].astype(str))
        raise SystemExit(f"Barrio '{nombre}' no encontrado o ambiguo. Opciones: {opciones}")
    fila = fila.iloc[0]
    geom = gpd.GeoSeries([wkt.loads(fila[c_geo])], crs=crs_geo).to_crs(CRS).iloc[0]
    return str(fila[c_nom]), geom


# --------------------------------------------------------------------------- Silver
def a_silver(partes, edificios, municipio_slug: str):
    import pandas as pd

    log("limpiando partes de edificio")
    c_id = columna(partes, "localid", obligatoria=False) or columna(partes, "gml_id")
    c_sobre = columna(partes, "floorsaboveground")
    c_bajo = columna(partes, "floorsbelowground")
    p = partes[[c_id, c_sobre, c_bajo, "geometry"]].rename(
        columns={c_id: "part_id", c_sobre: "plantas_sobre", c_bajo: "plantas_bajo"})
    p["part_id"] = p["part_id"].astype(str).str.replace(r"^ES\.SDGC\.BU\.", "", regex=True)
    p["refcat"] = p["part_id"].str.split("_").str[0]
    for c in ("plantas_sobre", "plantas_bajo"):
        p[c] = pd.to_numeric(p[c], errors="coerce").fillna(0).clip(lower=0).astype(int)

    log("limpiando edificios (año de construcción, uso, viviendas)")
    e_id = columna(edificios, "localid", obligatoria=False) or columna(edificios, "gml_id")
    e_ano = (columna(edificios, "beginning", obligatoria=False)
             or columna(edificios, "dateofconstruction", obligatoria=False))
    e_uso = columna(edificios, "currentuse", obligatoria=False)
    e_viv = columna(edificios, "numberofdwellings", obligatoria=False)
    e = pd.DataFrame({"refcat": edificios[e_id].astype(str).str.replace(r"^ES\.SDGC\.BU\.", "", regex=True)})
    e["ano"] = (pd.to_numeric(edificios[e_ano].astype(str).str.extract(r"(\d{4})")[0], errors="coerce")
                if e_ano else pd.NA)
    e["uso"] = (edificios[e_uso].astype(str) if e_uso else "desconocido")
    e["viviendas"] = pd.to_numeric(edificios[e_viv], errors="coerce") if e_viv else pd.NA
    e = e.drop_duplicates("refcat")

    silver = p.merge(e, on="refcat", how="left")
    silver = silver.set_geometry("geometry")
    destino = SILVER / "catastro" / f"partes_edificio_{municipio_slug}.parquet"
    destino.parent.mkdir(parents=True, exist_ok=True)
    silver.to_parquet(destino)
    log(f"silver: {len(silver):,} partes de edificio -> {destino.name}")
    return silver


# --------------------------------------------------------------------------- Gold
def altura(plantas: int) -> float:
    return 0.0 if plantas <= 0 else ALTURA_PB + ALTURA_PLANTA * (plantas - 1)


def a_gold(silver, barrio_nombre: str, barrio_geom, tile: float):
    import pandas as pd
    from pyproj import Transformer
    from shapely.validation import make_valid

    log(f"recortando al barrio '{barrio_nombre}'")
    zona = silver[silver.intersects(barrio_geom)].copy()
    # Uso: el Catastro usa códigos como "1_residential" o "4_1_office" -> "residential", "office"
    zona["uso"] = zona["uso"].astype("string").str.replace(r"^(\d+_)+", "", regex=True)
    # Año: el Catastro pone 1000 cuando no conoce la fecha -> desconocido
    zona["ano"] = pd.to_numeric(zona["ano"], errors="coerce")
    zona.loc[zona["ano"] < 1100, "ano"] = pd.NA
    zona = zona[zona.representative_point().within(barrio_geom.buffer(1.0))]
    zona["geometry"] = zona.geometry.map(make_valid)
    zona = zona.explode(index_parts=False).reset_index(drop=True)
    zona = zona[zona.geom_type == "Polygon"]
    zona["geometry"] = zona.geometry.simplify(0.25, preserve_topology=True)
    zona = zona[zona.area >= 2.0]
    zona["h"] = zona["plantas_sobre"].map(altura)
    zona["d"] = zona["plantas_bajo"] * ALTURA_SOTANO
    zona = zona[(zona["h"] > 0) | (zona["d"] > 0)].reset_index(drop=True)
    if zona.empty:
        raise SystemExit("No han quedado edificios tras el recorte: revisa el nombre del barrio.")

    # Origen local: centro del barrio redondeado a 10 m. x = este, z = sur (convención de Three.js)
    cx, cy = barrio_geom.centroid.x, barrio_geom.centroid.y
    ox, oy = round(cx / 10) * 10, round(cy / 10) * 10
    lon, lat = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True).transform(ox, oy)

    def local(coords):
        out = [[round(x - ox, 1), round(-(y - oy), 1)] for x, y, *_ in coords]
        return out[:-1] if len(out) > 1 and out[0] == out[-1] else out

    minx, miny, _, _ = zona.total_bounds
    teselas: dict[tuple[int, int], list] = {}
    for fila in zona.itertuples():
        g = fila.geometry
        pt = g.representative_point()
        clave = (int((pt.x - minx) // tile), int((pt.y - miny) // tile))
        ano = None if pd.isna(fila.ano) else int(fila.ano)
        teselas.setdefault(clave, []).append({
            "id": fila.part_id,
            "h": round(float(fila.h), 1),
            "d": round(float(fila.d), 1),
            "f": int(fila.plantas_sobre),
            "fb": int(fila.plantas_bajo),
            "y": ano,
            "u": None if pd.isna(fila.uso) else str(fila.uso),
            "o": local(g.exterior.coords),
            "i": [local(r.coords) for r in g.interiors],
        })

    salida = GOLD / slug(barrio_nombre)
    (salida / "tiles").mkdir(parents=True, exist_ok=True)
    for viejo in (salida / "tiles").glob("*.json"):
        viejo.unlink()
    indice_teselas = []
    for (i, j), partes in sorted(teselas.items()):
        xs = [p[0] for parte in partes for p in parte["o"]]
        zs = [p[1] for parte in partes for p in parte["o"]]
        nombre = f"tiles/{i}_{j}.json"
        with open(salida / nombre, "w", encoding="utf-8") as f:
            json.dump({"tile": [i, j], "parts": partes}, f, ensure_ascii=False, separators=(",", ":"))
        indice_teselas.append({"file": nombre, "count": len(partes),
                               "bbox": [min(xs), min(zs), max(xs), max(zs)]})

    contorno = barrio_geom if barrio_geom.geom_type == "Polygon" else max(barrio_geom.geoms, key=lambda g: g.area)
    stats = estadisticas(zona)
    indice = {
        "barrio": barrio_nombre,
        "crs": CRS,
        "origin": [ox, oy],
        "origin_lonlat": [round(lon, 6), round(lat, 6)],
        "axes": "x = este (m), z = sur (m), y = altura (m)",
        "tile_size": tile,
        "heights": {"planta_baja": ALTURA_PB, "planta": ALTURA_PLANTA, "sotano": ALTURA_SOTANO},
        "outline": local(contorno.exterior.coords),
        "tiles": indice_teselas,
        "stats": stats,
        "source": "Dirección General del Catastro (INSPIRE Buildings) · Ajuntament de Barcelona (Open Data BCN)",
    }
    with open(salida / "index.json", "w", encoding="utf-8") as f:
        json.dump(indice, f, ensure_ascii=False, indent=1)
    log(f"gold: {len(zona):,} partes en {len(indice_teselas)} teselas -> {salida.relative_to(GOLD.parent.parent)}")
    return zona, salida, stats


def estadisticas(zona) -> dict:
    anos = zona["ano"].dropna()
    usos = Counter(zona["uso"].fillna("desconocido"))
    alta = zona.loc[zona["h"].idxmax()]
    return {
        "partes": int(len(zona)),
        "edificios": int(zona["refcat"].nunique()),
        "altura_mediana_m": round(float(zona.loc[zona["h"] > 0, "h"].median()), 1),
        "altura_max_m": round(float(alta["h"]), 1),
        "altura_max_refcat": str(alta["refcat"]),
        "plantas_max": int(zona["plantas_sobre"].max()),
        "partes_con_sotano": int((zona["plantas_bajo"] > 0).sum()),
        "sotano_max_plantas": int(zona["plantas_bajo"].max()),
        "ano_mediano": int(anos.median()) if len(anos) else None,
        "ano_mas_antiguo": int(anos.min()) if len(anos) else None,
        "superficie_planta_m2": int(zona.area.sum()),
        "usos": dict(usos.most_common(8)),
    }


# --------------------------------------------------------------------------- Informe
def informe(zona, barrio_geom, barrio_nombre: str, salida: Path, stats: dict) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    sepia = LinearSegmentedColormap.from_list("sepia", ["#f3e7cc", "#d9b98a", "#a8754a", "#4b2e1a"])
    fig = plt.figure(figsize=(14, 8), facecolor="#efe1c2")
    ax = fig.add_axes([0.02, 0.05, 0.58, 0.88])
    zona.plot(ax=ax, column="h", cmap=sepia, linewidth=0.15, edgecolor="#4b2e1a", legend=True,
              legend_kwds={"label": "altura estimada (m)", "shrink": 0.6})
    gpd_contorno = type(zona)(geometry=[barrio_geom], crs=zona.crs)
    gpd_contorno.boundary.plot(ax=ax, color="#4b2e1a", linewidth=1.2, linestyle="--")
    ax.set_title(f"{barrio_nombre} · alturas a partir del Catastro", color="#3a2616", fontsize=14)
    ax.set_axis_off()

    ax2 = fig.add_axes([0.66, 0.56, 0.31, 0.34], facecolor="#f6ecd6")
    anos = zona.drop_duplicates("refcat")["ano"].dropna()
    ax2.hist(anos, bins=range(1850, 2031, 10), color="#a8754a", edgecolor="#4b2e1a")
    ax2.set_title("Edificios por década de construcción", color="#3a2616")

    ax3 = fig.add_axes([0.66, 0.10, 0.31, 0.34], facecolor="#f6ecd6")
    ax3.hist(zona.loc[zona["h"] > 0, "plantas_sobre"], bins=range(0, stats["plantas_max"] + 2),
             color="#d9b98a", edgecolor="#4b2e1a")
    ax3.set_title("Partes de edificio por número de plantas", color="#3a2616")
    fig.savefig(salida / "preview.png", dpi=130)
    plt.close(fig)

    usos = "\n".join(f"| {u} | {n:,} |" for u, n in stats["usos"].items())
    md = f"""# {barrio_nombre} · edificios

Fuente: Catastro (INSPIRE Buildings) y límites de barrio de Open Data BCN.
Alturas estimadas: planta baja {ALTURA_PB} m + {ALTURA_PLANTA} m por planta; sótanos {ALTURA_SOTANO} m por planta.

| Indicador | Valor |
|---|---|
| Edificios (referencias catastrales) | {stats['edificios']:,} |
| Partes de edificio | {stats['partes']:,} |
| Altura mediana | {stats['altura_mediana_m']} m |
| Altura máxima | {stats['altura_max_m']} m ({stats['plantas_max']} plantas, ref. {stats['altura_max_refcat']}) |
| Partes con sótano | {stats['partes_con_sotano']:,} (máx. {stats['sotano_max_plantas']} plantas) |
| Año de construcción mediano | {stats['ano_mediano']} |
| Edificio más antiguo registrado | {stats['ano_mas_antiguo']} |
| Superficie en planta | {stats['superficie_planta_m2']:,} m² |

## Usos principales (partes de edificio)

| Uso | Partes |
|---|---|
{usos}

![preview](preview.png)
"""
    (salida / "informe.md").write_text(md, encoding="utf-8")
    log(f"informe: {(salida / 'informe.md').name} y {(salida / 'preview.png').name}")


# --------------------------------------------------------------------------- CLI
def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--barrio", default="la Dreta de l'Eixample")
    ap.add_argument("--municipio", default="BARCELONA")
    ap.add_argument("--zip-file", help="zip INSPIRE del Catastro ya descargado (si falla la descarga automática)")
    ap.add_argument("--tile", type=float, default=250.0, help="tamaño de tesela en metros")
    ap.add_argument("--listar-barrios", action="store_true")
    ap.add_argument("--forzar", action="store_true", help="volver a descargar y recalcular")
    a = ap.parse_args()

    df_barris = tabla_barrios(a.forzar)
    if a.listar_barrios:
        c = columna(df_barris, "nom_barri")
        print("\n".join(sorted(df_barris[c].astype(str))))
        return

    import geopandas as gpd

    barrio_nombre, barrio_geom = poligono_barrio(df_barris, a.barrio)
    silver_path = SILVER / "catastro" / f"partes_edificio_{slug(a.municipio)}.parquet"
    if silver_path.exists() and not a.forzar:
        log(f"usando silver existente: {silver_path.name}")
        silver = gpd.read_parquet(silver_path)
    else:
        zip_path = obtener_zip_catastro(a.municipio, a.zip_file, a.forzar)
        partes, edificios = leer_gml(zip_path)
        silver = a_silver(partes, edificios, slug(a.municipio))

    zona, salida, stats = a_gold(silver, barrio_nombre, barrio_geom, a.tile)
    informe(zona, barrio_geom, barrio_nombre, salida, stats)
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    log("listo")


if __name__ == "__main__":
    main()
