"""Autobuses y metro de TMB a partir del GTFS: recorridos reales, paradas y horarios de cada expedición.

Lee data/bronze/tmb/gtfs.zip (lo descarga metro_barrio.py con las claves de .env) y escribe
data/gold/barcelona/vivo/buses.json y metro_horario.json (mismo formato), que el visor usa para mover cada autobús por su recorrido
a la hora que marca el horario (y, cuando haya datos de iBus, corregido con el retraso real).

  lineas    [[nombre, color, descripción], ...]
  recorridos[[x,z,x,z,...], ...]                 geometría simplificada en coordenadas del visor
  patrones  [[línea, recorrido, sentido, destino, [dist. de cada parada], [tiempo relativo 0..1 de cada parada], [id parada]], ...]
  servicios [[AAAAMMDD, ...], ...]                días en que circula cada servicio
  viajes    [[patrón, salida_s, duración_s, servicio], ...]
  paradas   {id: [x, z, nombre]}

Uso:  python pipeline/buses.py      (no necesita pandas; tarda ~1 min)
"""
from __future__ import annotations

import bisect
import csv
import io
import json
import math
import sys
import time
import zipfile
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import BRONZE, GOLD, log  # noqa: E402
from geo import a_local  # noqa: E402

GTFS = BRONZE / "tmb" / "gtfs.zip"
SALIDA = GOLD / "barcelona" / "vivo" / "buses.json"
METRO = GOLD / "barcelona" / "vivo" / "metro_horario.json"
AMB = BRONZE / "amb" / "gtfs.zip"
AMB_URL = "https://www.ambmobilitat.cat/OpenData/google_transit.zip"


def segundos(h: str) -> int | None:
    h = (h or "").strip()
    if not h:
        return None                       # parada sin hora (no es punto de control): se interpola
    a, b, c = (int(x) for x in h.split(":"))
    return a * 3600 + b * 60 + c          # el GTFS admite horas > 24 (viajes de madrugada)


def simplificar(pts: list, tol: float = 1.5) -> list:
    """Douglas-Peucker iterativo."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    pila = [(0, len(pts) - 1)]
    while pila:
        i, j = pila.pop()
        (x0, z0), (x1, z1) = pts[i], pts[j]
        dx, dz = x1 - x0, z1 - z0
        L = math.hypot(dx, dz) or 1e-9
        dmax, k = 0.0, -1
        for m in range(i + 1, j):
            d = abs((pts[m][0] - x0) * dz - (pts[m][1] - z0) * dx) / L
            if d > dmax:
                dmax, k = d, m
        if dmax > tol and k > 0:
            keep[k] = True
            pila += [(i, k), (k, j)]
    return [p for p, s in zip(pts, keep) if s]


def proyectar(pts: list, acum: list, x: float, z: float, desde: float) -> float:
    """Distancia a lo largo del recorrido del punto más cercano a (x, z), sin retroceder respecto a 'desde'."""
    mejor, dmin = desde, 1e18
    i0 = max(0, bisect.bisect_right(acum, desde) - 1)
    for i in range(i0, len(pts) - 1):
        (ax, az), (bx, bz) = pts[i], pts[i + 1]
        dx, dz = bx - ax, bz - az
        L2 = dx * dx + dz * dz or 1e-9
        u = max(0.0, min(1.0, ((x - ax) * dx + (z - az) * dz) / L2))
        px, pz = ax + u * dx, az + u * dz
        d = (px - x) ** 2 + (pz - z) ** 2
        s = acum[i] + u * math.sqrt(L2)
        if d < dmin - 1e-6 and s >= desde - 1:
            mejor, dmin = s, d
        if dmin < 4 and acum[i] > mejor + 400:   # ya encontrado y nos alejamos: basta
            break
    return mejor


IDS = ("route_id", "trip_id", "shape_id", "service_id", "stop_id")


def construir(tipos: set, salida: Path, que: str, zips: list | None = None, fuente: str = "TMB (GTFS)", filtro=None) -> None:
    """zips: [(ruta del GTFS, prefijo)]; con varios (p. ej. las dos redes de tranvía) los identificadores llevan el
    prefijo de su red, porque se repiten entre ellas. filtro(fila de routes.txt) -> bool elige qué líneas entran."""
    t0 = time.time()
    zips = zips or [(GTFS, "")]
    for zp, _ in zips:
        if not Path(zp).exists():
            raise SystemExit(f"No existe {zp}." + (" Ejecuta antes pipeline/metro_barrio.py (descarga el GTFS de TMB)." if zp == GTFS else ""))
    abiertos = [(zipfile.ZipFile(zp), pre) for zp, pre in zips]

    def leer(n):
        for z, pre in abiertos:
            if n not in z.namelist():
                continue                        # p. ej. el tranvía no tiene calendar.txt (solo calendar_dates.txt)
            for r in csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig")):
                if pre:
                    for k in IDS:
                        if r.get(k):
                            r[k] = pre + r[k]
                yield r

    rutas = {r["route_id"]: r for r in leer("routes.txt") if r["route_type"] in tipos and (filtro is None or filtro(r))}
    viajes = {t["trip_id"]: t for t in leer("trips.txt") if t["route_id"] in rutas}
    log(f"{que}: {len(rutas)} líneas y {len(viajes):,} expediciones en el GTFS")

    # paradas de cada viaje (stop_times es grande: se lee en streaming y solo lo de bus)
    paradas_viaje: dict[str, list] = defaultdict(list)
    for r in leer("stop_times.txt"):
        if r["trip_id"] in viajes:
            paradas_viaje[r["trip_id"]].append((int(r["stop_sequence"]), r["stop_id"], segundos(r["arrival_time"])))
    usadas = {s for lst in paradas_viaje.values() for _, s, _ in lst}
    paradas = {}
    for s in leer("stops.txt"):
        if s["stop_id"] in usadas:
            x, zz = a_local(float(s["stop_lon"]), float(s["stop_lat"]))
            paradas[s["stop_id"]] = (x, zz, s.get("stop_name", ""))
    log(f"{que}: {len(paradas):,} paradas")

    # recorridos
    formas_usadas = {t["shape_id"] for t in viajes.values()}
    crudo: dict[str, list] = defaultdict(list)
    for r in leer("shapes.txt"):
        if r["shape_id"] in formas_usadas:
            crudo[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lon"]), float(r["shape_pt_lat"])))
    formas, idx_forma, acums = [], {}, []
    for sid, lst in crudo.items():
        pts = simplificar([a_local(lon, lat) for _, lon, lat in sorted(lst)])
        acum = [0.0]
        for (ax, az), (bx, bz) in zip(pts, pts[1:]):
            acum.append(acum[-1] + math.hypot(bx - ax, bz - az))
        idx_forma[sid] = len(formas)
        formas.append(pts)
        acums.append(acum)
    log(f"{len(formas)} recorridos ({sum(a[-1] for a in acums) / 1000:,.0f} km)")

    # servicios (días)
    dias: dict[str, set] = defaultdict(set)
    servicios_bus = {t["service_id"] for t in viajes.values()}
    for c in leer("calendar.txt"):
        if c["service_id"] not in servicios_bus:
            continue
        from datetime import date, timedelta
        d0 = date(int(c["start_date"][:4]), int(c["start_date"][4:6]), int(c["start_date"][6:]))
        d1 = date(int(c["end_date"][:4]), int(c["end_date"][4:6]), int(c["end_date"][6:]))
        nombres = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        d = d0
        while d <= d1:
            if c[nombres[d.weekday()]] == "1":
                dias[c["service_id"]].add(d.strftime("%Y%m%d"))
            d += timedelta(days=1)
    for c in leer("calendar_dates.txt"):
        if c["service_id"] in servicios_bus:
            (dias[c["service_id"]].add if c["exception_type"] == "1" else dias[c["service_id"]].discard)(c["date"])
    idx_serv, servicios = {}, []
    for sid in sorted(servicios_bus):
        idx_serv[sid] = len(servicios)
        servicios.append(sorted(dias.get(sid, ())))

    # patrones: misma línea, recorrido y secuencia de paradas
    lineas, idx_linea = [], {}
    for rid, r in sorted(rutas.items(), key=lambda kv: kv[1]["route_short_name"]):
        idx_linea[rid] = len(lineas)
        lineas.append([r["route_short_name"], "#" + (r.get("route_color") or "c8402a"), r.get("route_long_name", "")])
    grupos: dict[tuple, list] = defaultdict(list)
    for tid, lst in paradas_viaje.items():
        lst.sort()
        if len(lst) < 2 or lst[0][2] is None or lst[-1][2] is None:
            continue
        t = viajes[tid]
        clave = (t["route_id"], t["shape_id"], t.get("direction_id", "0"), tuple(s for _, s, _ in lst))
        grupos[clave].append((tid, [h for _, _, h in lst]))

    patrones, salida_viajes, descartes = [], [], 0
    for (rid, shp, sentido, seq), lista in grupos.items():
        fi = idx_forma.get(shp)
        if fi is None:
            descartes += len(lista)
            continue
        pts, acum = formas[fi], acums[fi]
        dist, d = [], 0.0
        for s in seq:
            p = paradas.get(s)
            d = proyectar(pts, acum, p[0], p[1], d) if p else d
            dist.append(round(d, 1))
        # tiempos relativos: mediana de las expediciones del patrón (cada viaje conserva su duración real)
        rel = []
        for k in range(len(seq)):
            vals = sorted((h[k] - h[0]) / max(1, h[-1] - h[0]) for _, h in lista if h[k] is not None)
            rel.append(round(vals[len(vals) // 2], 4) if vals else None)
        rel[0], rel[-1] = 0.0, 1.0
        k = 0                              # paradas sin hora: proporcional a la distancia entre las conocidas
        while k < len(rel) - 1:
            j = k + 1
            while rel[j] is None:
                j += 1
            for m in range(k + 1, j):
                span = (dist[j] - dist[k]) or 1.0
                rel[m] = round(rel[k] + (rel[j] - rel[k]) * (dist[m] - dist[k]) / span, 4)
            k = j
        pi = len(patrones)
        patrones.append([idx_linea[rid], fi, int(sentido or 0), viajes[lista[0][0]].get("trip_headsign", ""), dist, rel, list(seq)])
        for tid, h in lista:
            salida_viajes.append([pi, h[0], max(60, h[-1] - h[0]), idx_serv[viajes[tid]["service_id"]]])

    salida_viajes.sort(key=lambda v: v[1])
    usadas_p = {s for p in patrones for s in p[6]}
    out = {"version": 1, "generado": time.strftime("%Y-%m-%dT%H:%M:%S"), "fuente": f"{fuente} · horario programado ({que})",
           "lineas": lineas, "recorridos": [[round(q, 1) for p in f for q in p] for f in formas],
           "patrones": patrones, "servicios": servicios, "viajes": salida_viajes,
           "paradas": {s: [paradas[s][0], paradas[s][1], paradas[s][2]] for s in usadas_p if s in paradas}}
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    hoy = time.strftime("%Y%m%d")
    hoy_n = sum(1 for v in salida_viajes if hoy in set(servicios[v[3]]))
    todas = sorted({d for s in servicios for d in s})
    log(f"{len(patrones):,} patrones · {len(salida_viajes):,} expediciones ({descartes} sin recorrido) · hoy {hoy_n:,} expediciones")
    log(f"horarios válidos del {todas[0] if todas else '?'} al {todas[-1] if todas else '?'}")
    log(f"escrito vivo/{salida.name} ({salida.stat().st_size / 1e6:.1f} MB) en {time.time() - t0:.0f} s")


def bajar_amb() -> Path:
    """GTFS abierto del AMB (sin claves). De él solo se usan las líneas NitBus (N0–N28): el bus nocturno no es de TMB."""
    import requests
    if not AMB.exists() or time.time() - AMB.stat().st_mtime > 7 * 86400:
        r = requests.get(AMB_URL, timeout=120, headers={"user-agent": "lumiose-planner (portfolio, victorquero.dev)"})
        r.raise_for_status()
        AMB.parent.mkdir(parents=True, exist_ok=True)
        AMB.write_bytes(r.content)
        log(f"AMB: GTFS descargado ({len(r.content) / 1e6:.1f} MB)")
    return AMB


def main() -> None:
    # buses de TMB + NitBus del AMB (de noche, cuando los de TMB se retiran)
    construir({"3"}, SALIDA, "bus", zips=[(GTFS, ""), (bajar_amb(), "AMB:")], fuente="TMB y AMB-NitBus (GTFS)",
              filtro=lambda r: not r["route_id"].startswith("AMB:") or (r.get("route_short_name") or "").startswith("N"))
    construir({"1"}, METRO, "metro")


if __name__ == "__main__":
    main()
