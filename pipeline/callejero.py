"""Callejero: nombre de cada calle -> tramos de la red viaria del visor (data/gold/barcelona/vivo/red.json).

Recorre la misma caché de OpenStreetMap (data/bronze/osm/vias.json) con exactamente los mismos filtros y el mismo orden
que pipeline/red_viaria.py, así que el tramo n de aquí es el tramo n de red.json (se comprueba al final). Lo usa el
visor para situar los avisos de incidencias del Ayuntamiento, que dan el lugar como texto («C. Muntaner a l'altura de
C. la Forja»).

  calles   [[nombre, [tramo, tramo, ...]], ...]      nombre tal cual en OSM (el visor lo normaliza)

Uso:  python pipeline/callejero.py      (después de red_viaria.py, si se rehace la red)
"""
from __future__ import annotations

import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import GOLD, log  # noqa: E402
from geo import a_local  # noqa: E402
from red_viaria import CLASES, VIAS, es_tunel, sentido  # noqa: E402

SALIDA = GOLD / "barcelona" / "vivo" / "callejero.json"
RED = GOLD / "barcelona" / "vivo" / "red.json"


def main() -> None:
    t0 = time.time()
    datos = json.loads(VIAS.read_text(encoding="utf-8"))
    vias = []
    for el in datos.get("elements", []):                      # mismos filtros que red_viaria.main()
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
    uso: dict[int, int] = defaultdict(int)
    for _, _, nodos, _ in vias:
        for n in set(nodos):
            uso[n] += 1
    calles: dict[str, list] = defaultdict(list)
    n_tramos, primeros = 0, []
    for t, c, nodos, geom in vias:                            # mismo troceo en tramos
        s = sentido(t, c)
        pts = [a_local(p["lon"], p["lat"]) for p in geom]
        if s == -1:
            nodos, pts = nodos[::-1], pts[::-1]
        nombre = (t.get("name") or t.get("official_name") or t.get("alt_name") or "").strip()
        ini = 0
        for i in range(1, len(nodos)):
            if i < len(nodos) - 1 and uso[nodos[i]] < 2:
                continue
            trozo = pts[ini:i + 1]
            L = sum(math.hypot(b[0] - a_[0], b[1] - a_[1]) for a_, b in zip(trozo, trozo[1:]))
            if L >= 1.0:
                if nombre:
                    calles[nombre].append(n_tramos)
                if len(primeros) < 50:
                    primeros.append([round(q, 1) for p in trozo[:2] for q in p])
                n_tramos += 1
            ini = i
    # comprobación: mismo número de tramos y mismas coordenadas que red.json
    red = json.loads(RED.read_text(encoding="utf-8"))
    if len(red["tramos"]) != n_tramos or any(red["tramos"][k][6][:4] != primeros[k][:4] for k in range(len(primeros))):
        raise SystemExit(f"El callejero no coincide con red.json ({n_tramos} tramos frente a {len(red['tramos'])}): "
                         "rehaz antes la red con pipeline/red_viaria.py")
    # solo calles del término municipal de Barcelona (la red incluye trozos de L'Hospitalet, Badalona…, con nombres
    # repetidos como «Carrer d'Espanya» o «Carrer de Marina»): la mayoría de sus tramos dentro del contorno de la ciudad
    idx = json.loads((GOLD / "barcelona" / "index.json").read_text(encoding="utf-8"))
    anillos = idx.get("outlines") or [idx["outline"]]
    anillos = [a for a in anillos if a and isinstance(a[0], (list, tuple))] or [idx["outline"]]

    def dentro(x, z):
        n = 0
        for r in anillos:
            for (x0, z0), (x1, z1) in zip(r, r[1:] + r[:1]):
                if (z0 > z) != (z1 > z) and x < x0 + (z - z0) * (x1 - x0) / (z1 - z0):
                    n += 1
        return n % 2 == 1

    def medio(i):
        p = red["tramos"][i][6]
        k = (len(p) // 4) * 2
        return p[k], p[k + 1]

    fuera = [k for k, v in calles.items() if sum(dentro(*medio(i)) for i in v) * 2 < len(v)]
    for k in fuera:
        del calles[k]
    log(f"{len(fuera):,} calles fuera de Barcelona descartadas")
    out = {"version": 1, "generado": time.strftime("%Y-%m-%dT%H:%M:%S"), "fuente": "OpenStreetMap (nombres de calle)",
           "tramos": n_tramos, "calles": sorted([k, v] for k, v in calles.items())}
    SALIDA.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    con = sum(len(v) for v in calles.values())
    log(f"{len(calles):,} calles con nombre · {con:,} de {n_tramos:,} tramos ({con / n_tramos:.0%}) · "
        f"vivo/callejero.json ({SALIDA.stat().st_size / 1e3:.0f} kB) en {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
