"""Red viaria para la simulación de vehículos: el grafo de calles por las que circulan coches y buses.

Lee la caché de OpenStreetMap que ya descargó mapa_base.py (data/bronze/osm/vias.json), parte cada
vía en los cruces y relaciona cada tramo de calle con el tramo de tráfico municipal más cercano
(Open Data BCN), para que la simulación use el estado real del tráfico.

Escribe en data/gold/barcelona/vivo/:
  red.json     nodos [[x,z],...] y tramos [[a, b, clase, carriles, sentido_unico, vmax_kmh, [x,z,...], tramo_trafico]]
  tramos.json  geometría de los tramos de tráfico municipales, para pintarlos según su estado

Uso:  python pipeline/red_viaria.py            (rápido: no descarga nada salvo la geometría de tramos la primera vez)
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, GOLD, descargar, log, norm  # noqa: E402
from geo import a_local  # noqa: E402

VIAS = BRONZE / "osm" / "vias.json"
SALIDA = GOLD / "barcelona" / "vivo"
URL_TRAMOS = ("https://opendata-ajuntament.barcelona.cat/data/dataset/1090983a-1c40-4609-8620-14ad49aae3ab/"
              "resource/c97072a3-3619-4547-84dd-f1999d2a3fec/download/transit_relacio_trams_format_long.csv")

# clase -> índice (0 = vía rápida ... 7 = calle de prioridad peatonal)
CLASES = {"motorway": 0, "motorway_link": 0, "trunk": 1, "trunk_link": 1, "primary": 2, "primary_link": 2,
          "secondary": 3, "secondary_link": 3, "tertiary": 4, "tertiary_link": 4, "unclassified": 5,
          "residential": 6, "living_street": 7}
VMAX = [80, 60, 50, 50, 40, 30, 30, 20]   # km/h por clase si OSM no lo dice


def _entero(v, defecto=0):
    try:
        return int(float(str(v).split(";")[0].split()[0]))
    except (ValueError, IndexError):
        return defecto


def es_tunel(t: dict) -> bool:
    return (t.get("tunnel") in ("yes", "building_passage", "culvert") or t.get("covered") == "yes"
            or _entero(t.get("layer", 0)) < 0)


def sentido(t: dict, clase: int) -> int:
    """1 = solo en el sentido de dibujo, -1 = solo al revés, 0 = doble sentido."""
    ow = str(t.get("oneway", "")).lower()
    if ow in ("yes", "1", "true"):
        return 1
    if ow == "-1":
        return -1
    if ow != "no" and (t.get("junction") in ("roundabout", "circular") or clase == 0):
        return 1
    return 0


def cargar_tramos(forzar: bool) -> dict[int, dict]:
    """Geometría de los tramos de tráfico de Open Data BCN (formato largo: un punto por fila)."""
    try:
        f = descargar(URL_TRAMOS, BRONZE / "trafico" / "transit_relacio_trams_format_long.csv", forzar)
    except Exception as e:  # noqa: BLE001
        log(f"AVISO: no he podido bajar la geometría de los tramos de tráfico ({e}); la simulación usará valores típicos")
        return {}
    crudo = f.read_bytes()
    for cod in ("utf-8-sig", "latin-1"):
        try:
            texto = crudo.decode(cod)
            break
        except UnicodeDecodeError:
            continue
    delim = ";" if texto.split("\n", 1)[0].count(";") > texto.split("\n", 1)[0].count(",") else ","
    filas = list(csv.DictReader(io.StringIO(texto), delimiter=delim))
    if not filas:
        return {}
    cols = {norm(c): c for c in filas[0]}
    buscar = lambda *ks: next((cols[c] for c in cols if all(k in c for k in ks)), None)  # noqa: E731
    k_tram = cols.get("tram") or buscar("tram")
    k_ord, k_desc = buscar("component"), buscar("descrip")
    k_lon, k_lat = buscar("longitud"), buscar("latitud")
    if not (k_tram and k_lon and k_lat):
        log(f"AVISO: columnas inesperadas en la geometría de tramos: {list(filas[0])}")
        return {}
    pts: dict[int, list] = defaultdict(list)
    desc: dict[int, str] = {}
    for r in filas:
        try:
            tid = int(float(r[k_tram]))
            lon, lat = float(str(r[k_lon]).replace(",", ".")), float(str(r[k_lat]).replace(",", "."))
        except (ValueError, TypeError):
            continue
        orden = _entero(r.get(k_ord, 0)) if k_ord else len(pts[tid])
        pts[tid].append((orden, a_local(lon, lat)))
        if k_desc:
            desc[tid] = r.get(k_desc, "")
    return {tid: {"desc": desc.get(tid, ""), "pts": [p for _, p in sorted(v)]} for tid, v in pts.items() if len(v) >= 2}


def emparejar(tramos_red: list, tramos_trafico: dict[int, dict], radio: float = 22.0) -> int:
    """Asigna a cada tramo de calle el tramo de tráfico más cercano con la misma orientación."""
    CEL = 60.0
    rejilla: dict[tuple, list] = defaultdict(list)
    for tid, t in tramos_trafico.items():
        p = t["pts"]
        for (x0, z0), (x1, z1) in zip(p, p[1:]):
            L = math.hypot(x1 - x0, z1 - z0)
            if L < 0.5:
                continue
            seg = (tid, x0, z0, x1, z1, (x1 - x0) / L, (z1 - z0) / L, L)
            for ix in range(int(min(x0, x1) // CEL) - 1, int(max(x0, x1) // CEL) + 2):
                for iz in range(int(min(z0, z1) // CEL) - 1, int(max(z0, z1) // CEL) + 2):
                    rejilla[(ix, iz)].append(seg)
    n = 0
    for tr in tramos_red:
        c = tr[6]
        k = len(c) // 2
        i = max(0, k // 2 - 1)
        mx, mz = (c[2 * i] + c[2 * i + 2]) / 2, (c[2 * i + 1] + c[2 * i + 3]) / 2
        dx, dz = c[-2] - c[0], c[-1] - c[1]
        L = math.hypot(dx, dz) or 1.0
        dx, dz = dx / L, dz / L
        mejor, dmin = -1, radio
        for seg in rejilla.get((int(mx // CEL), int(mz // CEL)), ()):
            tid, x0, z0, x1, z1, ux, uz, sl = seg
            if abs(ux * dx + uz * dz) < 0.8:
                continue
            u = max(0.0, min(sl, (mx - x0) * ux + (mz - z0) * uz))
            d = math.hypot(mx - (x0 + ux * u), mz - (z0 + uz * u))
            if d < dmin:
                mejor, dmin = tid, d
        tr[7] = mejor
        n += mejor >= 0
    return n


def senales(nodos_xy: list, radio: float = 18.0) -> list[int]:
    """Cruces con semáforo: cada nodo OSM highway=traffic_signals se asigna al cruce del grafo más cercano."""
    p = BRONZE / "osm" / "semaforos.json"
    if not p.exists():
        log("AVISO: no existe data/bronze/osm/semaforos.json (lo descarga suelo.py): los coches no pararán en semáforos")
        return []
    CEL = 25.0
    rejilla: dict[tuple, list] = defaultdict(list)
    for i, (x, z) in enumerate(nodos_xy):
        rejilla[(int(x // CEL), int(z // CEL))].append(i)
    marcados = set()
    for el in json.loads(p.read_text(encoding="utf-8")).get("elements", []):
        if el.get("type") != "node" or el.get("tags", {}).get("highway") != "traffic_signals":
            continue
        x, z = a_local(el["lon"], el["lat"])
        mejor, dmin = -1, radio
        for ix in range(int(x // CEL) - 1, int(x // CEL) + 2):
            for iz in range(int(z // CEL) - 1, int(z // CEL) + 2):
                for i in rejilla.get((ix, iz), ()):
                    d = math.hypot(nodos_xy[i][0] - x, nodos_xy[i][1] - z)
                    if d < dmin:
                        mejor, dmin = i, d
        if mejor >= 0:
            marcados.add(mejor)
    return sorted(marcados)


# ---------------- Red ciclista ----------------
# coste relativo por metro: el ciclista simulado prefiere carril bici y calles tranquilas
COSTE_BICI = {"cycleway": 0.6, "living_street": 0.9, "residential": 1.0, "unclassified": 1.1, "service": 1.2,
              "pedestrian": 1.4, "tertiary": 1.25, "tertiary_link": 1.25, "secondary": 1.5, "secondary_link": 1.5,
              "primary": 1.9, "primary_link": 1.9}
CON_CARRIL = ("lane", "track", "shared_lane", "share_busway", "opposite_lane", "opposite_track", "yes")


def red_bici() -> dict | None:
    """Grafo para bicis: carriles bici de OSM (vias_tren_bici.json, de suelo.py) + calles sin vías rápidas."""
    from comun import BRONZE as B
    vias = json.loads(VIAS.read_text(encoding="utf-8")).get("elements", [])
    p = B / "osm" / "vias_tren_bici.json"
    bici = json.loads(p.read_text(encoding="utf-8")).get("elements", []) if p.exists() else []
    if not bici:
        log("AVISO: sin vias_tren_bici.json (lo descarga suelo.py): la red ciclista solo usará calles")
    ways = []
    for el in vias + bici:
        if el.get("type") != "way":
            continue
        t = el.get("tags", {})
        hw = t.get("highway")
        if hw not in COSTE_BICI or es_tunel(t) or t.get("bicycle") == "no" or t.get("access") in ("no", "private"):
            continue
        if hw == "pedestrian" and t.get("bicycle") not in ("yes", "designated"):
            continue
        geom, nodos = el.get("geometry"), el.get("nodes")
        if not geom or not nodos or len(geom) != len(nodos) or any(q is None for q in geom):
            continue
        carril = any(str(t.get(k, "")).startswith(CON_CARRIL) for k in ("cycleway", "cycleway:both", "cycleway:right", "cycleway:left"))
        coste = COSTE_BICI[hw] if hw == "cycleway" else (min(COSTE_BICI[hw], 0.75) if carril else COSTE_BICI[hw])
        ow = str(t.get("oneway", "")).lower()
        s = 0 if (hw == "cycleway" and ow not in ("yes", "1")) or t.get("oneway:bicycle") == "no" else \
            (1 if ow in ("yes", "1", "true") or t.get("junction") == "roundabout" else -1 if ow == "-1" else 0)
        if hw == "cycleway":
            despl = 0.6                                   # carril bici separado: por su eje, algo a la derecha
        else:
            carr = max(1, min(_entero(t.get("lanes"), 0) or (1 if s else 2), 8))
            despl = (carr * 3.1 / 2 if s else carr / 2 * 3.1) - 0.9    # pegado al borde derecho de la calzada
        ways.append((nodos, geom, coste, s, round(despl, 1)))
    uso: dict[int, int] = defaultdict(int)
    for nodos, *_ in ways:
        for n in set(nodos):
            uso[n] += 1
    idx: dict[int, int] = {}
    nodos_xy: list = []
    tramos = []
    for nodos, geom, coste, s, despl in ways:
        pts = [a_local(q["lon"], q["lat"]) for q in geom]
        if s == -1:
            nodos, pts, s = nodos[::-1], pts[::-1], 1
        ini = 0
        for i in range(1, len(nodos)):
            if i < len(nodos) - 1 and uso[nodos[i]] < 2:
                continue
            trozo = pts[ini:i + 1]
            if sum(math.hypot(b[0] - a_[0], b[1] - a_[1]) for a_, b in zip(trozo, trozo[1:])) >= 1.0:
                ids = []
                for n, xy in ((nodos[ini], trozo[0]), (nodos[i], trozo[-1])):
                    if n not in idx:
                        idx[n] = len(nodos_xy)
                        nodos_xy.append(list(xy))
                    ids.append(idx[n])
                tramos.append([ids[0], ids[1], coste, s, despl, [round(q, 1) for p_ in trozo for q in p_]])
            ini = i
    km_carril = sum(math.hypot(t[5][k + 2] - t[5][k], t[5][k + 3] - t[5][k + 1]) for t in tramos if t[2] <= 0.75
                    for k in range(0, len(t[5]) - 2, 2)) / 1000
    log(f"red ciclista: {len(nodos_xy):,} nodos, {len(tramos):,} tramos · {km_carril:,.0f} km con carril bici")
    return {"version": 1, "campos": ["nodo_a", "nodo_b", "coste", "sentido_unico", "desplazamiento_m", "coords"],
            "nodos": nodos_xy, "tramos": tramos}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--forzar", action="store_true", help="volver a bajar la geometría de los tramos de tráfico")
    a = ap.parse_args()
    t0 = time.time()
    if not VIAS.exists():
        raise SystemExit("No existe data/bronze/osm/vias.json. Ejecuta antes pipeline/mapa_base.py.")
    datos = json.loads(VIAS.read_text(encoding="utf-8"))

    vias = []
    for el in datos.get("elements", []):
        if el.get("type") != "way":
            continue
        t = el.get("tags", {})
        c = CLASES.get(t.get("highway"))
        if c is None or es_tunel(t) or t.get("access") in ("no", "private") or t.get("motor_vehicle") == "no":
            continue
        geom, nodos = el.get("geometry"), el.get("nodes")
        if not geom or not nodos or len(geom) != len(nodos) or any(p is None for p in geom):
            continue
        vias.append((t, c, nodos, geom))
    log(f"{len(vias):,} vías circulables (sin túneles ni accesos privados)")

    uso: dict[int, int] = defaultdict(int)
    for _, _, nodos, _ in vias:
        for n in set(nodos):
            uso[n] += 1

    nodo_idx: dict[int, int] = {}
    nodos_xy: list = []

    def nid(n: int, xy) -> int:
        if n not in nodo_idx:
            nodo_idx[n] = len(nodos_xy)
            nodos_xy.append(list(xy))
        return nodo_idx[n]

    tramos = []
    km = [0.0] * 8
    for t, c, nodos, geom in vias:
        s = sentido(t, c)
        pts = [a_local(p["lon"], p["lat"]) for p in geom]
        if s == -1:
            nodos, pts, s = nodos[::-1], pts[::-1], 1
        carr = max(1, min(_entero(t.get("lanes"), 0) or (1 if s else 2), 8))
        v = _entero(t.get("maxspeed"), 0)
        v = v if 5 <= v <= 130 else VMAX[c]
        ini = 0
        for i in range(1, len(nodos)):
            if i < len(nodos) - 1 and uso[nodos[i]] < 2:
                continue
            trozo = pts[ini:i + 1]
            L = sum(math.hypot(b[0] - a_[0], b[1] - a_[1]) for a_, b in zip(trozo, trozo[1:]))
            if L >= 1.0:
                plano = [round(q, 1) for p in trozo for q in p]
                tramos.append([nid(nodos[ini], trozo[0]), nid(nodos[i], trozo[-1]), c, carr, s, v, plano, -1])
                km[c] += L / 1000
            ini = i
    log(f"grafo: {len(nodos_xy):,} cruces y {len(tramos):,} tramos de calle · {sum(km):,.0f} km")

    trafico = cargar_tramos(a.forzar)
    if trafico:
        n = emparejar(tramos, trafico)
        log(f"{n:,} tramos de calle ({n / max(1, len(tramos)):.0%}) enlazados con {len(trafico)} tramos de tráfico municipales")

    sen = senales(nodos_xy)
    log(f"{len(sen):,} cruces con semáforo")

    SALIDA.mkdir(parents=True, exist_ok=True)
    red = {"version": 1, "generado": time.strftime("%Y-%m-%dT%H:%M:%S"), "fuente": "OpenStreetMap · Open Data BCN (tramos de tráfico)",
           "campos": ["nodo_a", "nodo_b", "clase", "carriles", "sentido_unico", "vmax_kmh", "coords", "tramo_trafico"],
           "clases": ["vía rápida", "ronda", "principal", "secundaria", "terciaria", "sin clasificar", "residencial", "zona 20"],
           "nodos": nodos_xy, "tramos": tramos, "senales": sen}
    (SALIDA / "red.json").write_text(json.dumps(red, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    if trafico:
        geo = {"version": 1, "tramos": [[tid, t["desc"], [round(q, 1) for p in t["pts"] for q in p]] for tid, t in sorted(trafico.items())]}
        (SALIDA / "tramos.json").write_text(json.dumps(geo, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    rb = red_bici()
    if rb:
        (SALIDA / "bici.json").write_text(json.dumps(rb, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    mb = (SALIDA / "red.json").stat().st_size / 1e6
    log(f"escrito vivo/red.json ({mb:.1f} MB){' y vivo/tramos.json' if trafico else ''} en {time.time() - t0:.0f} s")
    for i, nombre in enumerate(red["clases"]):
        if km[i]:
            log(f"   {nombre:<14} {km[i]:7.1f} km")


if __name__ == "__main__":
    main()
