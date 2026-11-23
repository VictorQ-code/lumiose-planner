"""Flujo de datos en vivo: cada fuente se consulta a su ritmo y cada captura recorre bronze -> silver -> gold.

  bronze  data/stream/bronze/<fuente>/fecha=AAAA-MM-DD/HHMMSS.json.gz    respuesta original, tal cual llegó
  silver  data/stream/silver/<fuente>/fecha=AAAA-MM-DD/HHMMSS.parquet    registros limpios con un esquema común
          data/stream/silver/<fuente>_eventos/fecha=.../HHMMSS.parquet   cambios detectados entre dos capturas
  gold    data/gold/barcelona/vivo/<fuente>.json                         último estado, compacto, para el visor
          data/gold/barcelona/vivo/manifest.json                          qué capas hay, de cuándo son y si van bien

Esquema común de silver: fuente, ts_captura (UTC), id, x, z (coordenadas del visor) y los campos propios de cada fuente.
Las fechas de las particiones van en UTC. El histórico acumulado es la materia prima de los informes y modelos.

Uso:
  python pipeline/vivo.py                 en marcha continua (Ctrl+C para parar)
  python pipeline/vivo.py --una-vez       una captura de cada fuente y termina (para programarlo)
  python pipeline/vivo.py --solo bicing,tiempo
  python pipeline/vivo.py --estado        resumen del histórico acumulado

Añadir una fuente nueva = una clase con capturar / normalizar / eventos / gold y añadirla a FUENTES.
"""
from __future__ import annotations

import argparse
import bisect
import gzip
import json
import os
import statistics
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from comun import DATA, GOLD, HEADERS, ROOT, log  # noqa: E402
from geo import a_local  # noqa: E402

STREAM = DATA / "stream"
VIVO = GOLD / "barcelona" / "vivo"
ESTADO = STREAM / "estado"
SES = requests.Session()
SES.headers.update(HEADERS)


def pedir(url: str, timeout: int = 25) -> str:
    r = SES.get(url, timeout=timeout)
    r.raise_for_status()
    return r.text


def escribir_json(path: Path, obj) -> None:
    """Escritura atómica: el visor nunca lee un fichero a medias."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    for _ in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:      # Windows: el servidor lo está leyendo justo ahora
            time.sleep(0.15)
    os.replace(tmp, path)


def particion(capa: str, nombre: str, ts: datetime, ext: str) -> Path:
    d = STREAM / capa / nombre / f"fecha={ts:%Y-%m-%d}"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{ts:%H%M%S}.{ext}"


def guardar_bronze(nombre: str, crudo: dict, ts: datetime) -> None:
    with gzip.open(particion("bronze", nombre, ts, "json.gz"), "wt", encoding="utf-8") as f:
        json.dump(crudo, f, ensure_ascii=False)


def guardar_silver(nombre: str, registros: list[dict], ts: datetime) -> None:
    if not registros:
        return
    try:
        import pandas as pd
        df = pd.DataFrame(registros)
        df["ts_captura"] = pd.Timestamp(ts)
        df.to_parquet(particion("silver", nombre, ts, "parquet"), index=False)
    except ImportError:              # sin pandas/pyarrow: JSON por líneas comprimido, mismo esquema
        with gzip.open(particion("silver", nombre, ts, "jsonl.gz"), "wt", encoding="utf-8") as f:
            for r in registros:
                f.write(json.dumps({**r, "ts_captura": ts.isoformat()}, ensure_ascii=False) + "\n")


# =====================================================================================================
# Fuentes
# =====================================================================================================
class Fuente:
    nombre = ""
    cada = 60                 # segundos entre capturas
    descripcion = ""
    origen = ""

    def capturar(self) -> tuple[dict, object]:
        """Devuelve (crudo para bronze {url: texto}, datos ya parseados)."""
        raise NotImplementedError

    def normalizar(self, datos, ts: datetime) -> list[dict]:
        raise NotImplementedError

    def eventos(self, previo: list[dict] | None, actual: list[dict], ts: datetime) -> list[dict]:
        return []

    def gold(self, actual: list[dict], eventos: list[dict], ts: datetime) -> dict:
        raise NotImplementedError


class Bicing(Fuente):
    """Estaciones de Bicing (GBFS): bicis mecánicas y eléctricas y anclajes libres en cada estación."""
    nombre, cada = "bicing", 60
    descripcion = "Bicis mecánicas y eléctricas y anclajes libres por estación"
    origen = "Bicing (GBFS)"
    GBFS = os.environ.get("BICING_GBFS", "https://api.citybik.es/gbfs/2/bicing/gbfs.json")

    def __init__(self):
        self.feeds: dict[str, str] = {}
        self.info: dict[str, dict] = {}
        self.info_ts = 0.0
        self.tipos_ele: set[str] = set()

    def _descubrir(self, crudo: dict) -> None:
        if self.feeds:
            return
        txt = pedir(self.GBFS)
        crudo[self.GBFS] = txt
        d = json.loads(txt)["data"]
        lang = next(iter(d.values()))
        self.feeds = {f["name"]: f["url"] for f in lang["feeds"]}

    def capturar(self):
        crudo: dict = {}
        self._descubrir(crudo)
        if time.time() - self.info_ts > 6 * 3600:          # la información fija se refresca cada 6 h
            txt = pedir(self.feeds["station_information"])
            crudo["station_information"] = txt
            self.info = {str(s["station_id"]): s for s in json.loads(txt)["data"]["stations"]}
            if "vehicle_types" in self.feeds:
                try:
                    vt = json.loads(pedir(self.feeds["vehicle_types"]))["data"]["vehicle_types"]
                    self.tipos_ele = {str(v["vehicle_type_id"]) for v in vt if v.get("propulsion_type", "human") != "human"}
                except Exception:  # noqa: BLE001
                    pass
            self.info_ts = time.time()
        txt = pedir(self.feeds["station_status"])
        crudo["station_status"] = txt
        return crudo, json.loads(txt)["data"]["stations"]

    def _electricas(self, st: dict) -> int:
        tipos = st.get("num_bikes_available_types")
        if isinstance(tipos, dict):
            return int(tipos.get("ebike", tipos.get("electric", 0)) or 0)
        if isinstance(tipos, list):              # [{"mechanical": n}, {"ebike": m}]
            return sum(int(v) for d in tipos for k, v in d.items() if "e" in k.lower() and "bike" in k.lower() and k.lower() != "mechanical")
        n = 0
        for v in st.get("vehicle_types_available") or []:
            tid = str(v.get("vehicle_type_id", ""))
            if tid in self.tipos_ele or "ebike" in tid.lower() or "electric" in tid.lower():
                n += int(v.get("count", 0))
        return n

    def normalizar(self, datos, ts):
        out = []
        for st in datos:
            sid = str(st["station_id"])
            inf = self.info.get(sid)
            if not inf:
                continue
            x, z = a_local(float(inf["lon"]), float(inf["lat"]))
            total = int(st.get("num_bikes_available", 0) or 0)
            ele = min(total, self._electricas(st))
            out.append({"fuente": self.nombre, "id": sid, "x": x, "z": z, "nombre": inf.get("name", ""),
                        "capacidad": int(inf.get("capacity", 0) or 0), "mecanicas": total - ele, "electricas": ele,
                        "anclajes_libres": int(st.get("num_docks_available", 0) or 0),
                        "activa": bool(st.get("is_renting", 1)) and bool(st.get("is_installed", 1)),
                        "ultimo_reporte": int(st.get("last_reported", 0) or 0)})
        return out

    def eventos(self, previo, actual, ts):
        """Bicis que se han cogido o dejado en cada estación entre dos capturas."""
        if not previo:
            return []
        antes = {r["id"]: r for r in previo}
        out = []
        for r in actual:
            p = antes.get(r["id"])
            if not p:
                continue
            for tipo in ("mecanicas", "electricas"):
                d = r[tipo] - p[tipo]
                if d:
                    out.append({"fuente": self.nombre, "id": r["id"], "x": r["x"], "z": r["z"],
                                "tipo": "dejar" if d > 0 else "coger", "bici": tipo[:-1], "n": abs(d)})
        return out

    def gold(self, actual, eventos, ts):
        return {"estaciones": [[r["id"], r["x"], r["z"], r["capacidad"], r["mecanicas"], r["electricas"],
                                r["anclajes_libres"], int(r["activa"])] for r in actual],
                "campos": ["id", "x", "z", "capacidad", "mecanicas", "electricas", "anclajes_libres", "activa"],
                "eventos": [[e["id"], e["n"] if e["tipo"] == "dejar" else -e["n"], e["bici"]] for e in eventos],
                "totales": {"estaciones": len(actual), "mecanicas": sum(r["mecanicas"] for r in actual),
                            "electricas": sum(r["electricas"] for r in actual),
                            "cogidas": sum(e["n"] for e in eventos if e["tipo"] == "coger"),
                            "dejadas": sum(e["n"] for e in eventos if e["tipo"] == "dejar")}}


class Trafico(Fuente):
    """Estado del tráfico por tramos (Ajuntament de Barcelona), actualizado cada 5 minutos."""
    nombre, cada = "trafico", 300
    descripcion = "Estado actual y previsto a 15 min de cada tramo viario"
    origen = "Open Data BCN · estat del trànsit"
    URL = ("https://opendata-ajuntament.barcelona.cat/data/dataset/8319c2b1-4c21-4962-9acd-6db4c5ff1148/"
           "resource/2d456eb5-4ea6-4f68-9794-2f3f1a58a933/download")
    ESTADOS = ["sin datos", "muy fluido", "fluido", "denso", "muy denso", "congestión", "cortado"]

    def capturar(self):
        txt = pedir(self.URL)
        return {self.URL: txt}, txt

    def normalizar(self, datos, ts):
        out = []
        for linea in datos.splitlines():
            p = linea.strip().split("#")
            if len(p) < 4 or not p[0].strip().isdigit():
                continue
            try:
                actual, previsto = int(p[2]), int(p[3])
            except ValueError:
                continue
            out.append({"fuente": self.nombre, "id": int(p[0]), "fecha_dato": p[1].strip(),
                        "estado": actual, "previsto": previsto})
        if datos.strip() and not out:
            raise ValueError(f"formato inesperado del fichero de tráfico: {datos[:120]!r}")
        return out

    def eventos(self, previo, actual, ts):
        if not previo:
            return []
        antes = {r["id"]: r["estado"] for r in previo}
        return [{"fuente": self.nombre, "id": r["id"], "de": antes[r["id"]], "a": r["estado"]}
                for r in actual if r["id"] in antes and antes[r["id"]] != r["estado"]]

    def gold(self, actual, eventos, ts):
        resumen = {e: 0 for e in self.ESTADOS}
        for r in actual:
            if 0 <= r["estado"] < len(self.ESTADOS):
                resumen[self.ESTADOS[r["estado"]]] += 1
        return {"tramos": [[r["id"], r["estado"], r["previsto"]] for r in actual],
                "campos": ["id", "estado", "previsto"], "estados": self.ESTADOS, "resumen": resumen,
                "cambios": len(eventos)}


class Tiempo(Fuente):
    """Tiempo actual en Barcelona (Open-Meteo, sin clave)."""
    nombre, cada = "tiempo", 900
    descripcion = "Temperatura, lluvia, viento y nubosidad"
    origen = "Open-Meteo"
    URL = ("https://api.open-meteo.com/v1/forecast?latitude=41.3874&longitude=2.1686"
           "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,rain,weather_code,"
           "cloud_cover,wind_speed_10m,wind_direction_10m,is_day&timezone=Europe%2FMadrid")
    WMO = {0: "despejado", 1: "casi despejado", 2: "parcialmente nublado", 3: "cubierto", 45: "niebla", 48: "niebla",
           51: "llovizna", 53: "llovizna", 55: "llovizna intensa", 61: "lluvia débil", 63: "lluvia", 65: "lluvia fuerte",
           80: "chubascos", 81: "chubascos", 82: "chubascos fuertes", 95: "tormenta", 96: "tormenta con granizo", 99: "tormenta con granizo",
           71: "nieve", 73: "nieve", 75: "nieve fuerte"}

    def capturar(self):
        txt = pedir(self.URL)
        return {self.URL: txt}, json.loads(txt)["current"]

    def normalizar(self, d, ts):
        x, z = a_local(2.1686, 41.3874)
        return [{"fuente": self.nombre, "id": "bcn", "x": x, "z": z, "hora_dato": d.get("time"),
                 "temperatura": d.get("temperature_2m"), "sensacion": d.get("apparent_temperature"),
                 "humedad": d.get("relative_humidity_2m"), "precipitacion_mm": d.get("precipitation"),
                 "lluvia_mm": d.get("rain"), "codigo": d.get("weather_code"), "nubes": d.get("cloud_cover"),
                 "viento_kmh": d.get("wind_speed_10m"), "viento_dir": d.get("wind_direction_10m"),
                 "es_dia": bool(d.get("is_day", 1))}]

    def gold(self, actual, eventos, ts):
        r = dict(actual[0])
        r["descripcion"] = self.WMO.get(r.get("codigo"), "")
        for k in ("fuente", "id", "x", "z"):
            r.pop(k, None)
        return r


def claves_tmb() -> tuple[str | None, str | None]:
    """Claves de TMB desde city3d/.env (nunca se muestran ni se guardan en bronze)."""
    env = ROOT / ".env"
    if env.exists():
        for linea in env.read_text(encoding="utf-8").splitlines():
            if "=" in linea and not linea.strip().startswith("#"):
                k, v = linea.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return os.environ.get("TMB_APP_ID"), os.environ.get("TMB_APP_KEY")


class BusTMB(Fuente):
    """Retraso real de los autobuses: previsión de llegada de iBus en paradas de control frente al horario GTFS.

    iBus solo da llegadas por parada, así que en cada ciclo se consultan unas pocas paradas de control
    (dos por recorrido, a un tercio y a tres cuartos del trayecto), por turnos. El retraso de una llegada es su
    diferencia con la hora programada más cercana de esa línea en esa parada; en líneas muy frecuentes solo
    se puede medir hasta media frecuencia. El retraso de cada línea es la mediana de los últimos 20 minutos.
    """
    nombre, cada = "bus", 120
    descripcion = "Retraso real por línea: previsiones iBus de TMB frente al horario"
    origen = "TMB iBus + GTFS"
    URL = "https://api.tmb.cat/v1/itransit/bus/parades/{codi}?app_id={id}&app_key={key}"
    POR_CICLO = int(os.environ.get("TMB_IBUS_POR_CICLO", "25"))      # paradas por consulta (cuidado con el cupo de la API)
    VENTANA = 20 * 60

    def __init__(self):
        self.version = None
        self.control: list[str] = []
        self.prog: dict = {}
        self.xy: dict = {}
        self.turno = 0
        self.obs: list = []

    def _horario(self) -> None:
        p = VIVO / "buses.json"
        if not p.exists():
            raise RuntimeError("falta vivo/buses.json: ejecuta python pipeline/buses.py")
        hoy = datetime.now()
        clave = (p.stat().st_mtime, hoy.strftime("%Y%m%d"))
        if self.version == clave:
            return
        d = json.loads(p.read_text(encoding="utf-8"))
        s_hoy = [hoy.strftime("%Y%m%d") in set(s) for s in d["servicios"]]
        s_ayer = [(hoy - timedelta(days=1)).strftime("%Y%m%d") in set(s) for s in d["servicios"]]
        control = set()
        for pat in d["patrones"]:
            n = len(pat[6])
            for f in (0.33, 0.75):
                control.add(pat[6][min(n - 2, max(1, int(n * f)))])
        codigo = lambda sid: sid.split(".")[1] if sid.count(".") >= 1 else sid  # noqa: E731  "2.1314.683903" -> "1314"
        prog = defaultdict(list)
        for pi, salida, dur, sv in d["viajes"]:
            pat = d["patrones"][pi]
            linea = d["lineas"][pat[0]][0]
            for activo, desfase in ((s_hoy, 0), (s_ayer, -86400)):
                if activo[sv]:
                    for k, sid in enumerate(pat[6]):
                        if sid in control:
                            prog[(linea, codigo(sid))].append(salida + desfase + pat[5][k] * dur)
        for v in prog.values():
            v.sort()
        cods = sorted({codigo(s) for s in control}, key=lambda c: (hash(c) % 997, c))   # mezcladas: cada lote toca zonas distintas
        self.control, self.prog, self.version = cods, prog, clave
        self.xy = {codigo(sid): v[:2] for sid, v in d["paradas"].items()}

    def capturar(self):
        app_id, app_key = claves_tmb()
        if not app_id or not app_key:
            raise RuntimeError("faltan TMB_APP_ID y TMB_APP_KEY en .env")
        self._horario()
        n = min(self.POR_CICLO, len(self.control))
        lote = [self.control[(self.turno + i) % len(self.control)] for i in range(n)]
        self.turno = (self.turno + n) % max(1, len(self.control))
        crudo, datos, fallos = {}, {}, 0
        for codi in lote:
            try:
                r = SES.get(self.URL.format(codi=codi, id=app_id, key=app_key), timeout=15)
                if r.status_code in (401, 403, 429):
                    raise PermissionError(f"TMB respondió {r.status_code} (claves no válidas o cupo de consultas agotado)")
                r.raise_for_status()
                crudo[codi] = r.text          # se guarda por código de parada: la URL lleva las claves
                datos[codi] = r.json()
            except PermissionError:
                raise
            except Exception:  # noqa: BLE001
                fallos += 1
            time.sleep(0.15)
        if not datos:
            raise RuntimeError(f"ninguna parada respondió ({fallos} fallos)")
        return crudo, datos

    @staticmethod
    def _llegadas(j) -> list:
        """(nombre de línea, código de línea, sentido, destino, id_bus, llegada) estén donde estén en la respuesta."""
        out = []

        def walk(o):
            if isinstance(o, dict):
                if "propers_busos" in o:
                    for b in o.get("propers_busos") or []:
                        out.append((o.get("nom_linia"), o.get("codi_linia"), o.get("id_sentit"), o.get("desti_trajecte", ""),
                                    b.get("id_bus"), b.get("temps_arribada")))
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk(j)
        return out

    def normalizar(self, datos, ts):
        ahora = ts.timestamp()
        medianoche = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        out = []
        for codi, j in datos.items():
            x, z = self.xy.get(codi, (None, None))
            vistos = set()
            for nom, cod, sentido, destino, bus, llegada in self._llegadas(j):
                if not llegada:
                    continue
                llegada = float(llegada) / (1000 if float(llegada) > 1e11 else 1)
                if not (ahora - 60 <= llegada <= ahora + 30 * 60):
                    continue
                linea = next((str(c) for c in (nom, cod) if c is not None and (str(c), codi) in self.prog), None)
                if linea is None or (linea, sentido) in vistos:
                    continue                                   # solo el próximo bus de cada línea y sentido
                vistos.add((linea, sentido))
                t = llegada - medianoche
                lst = self.prog[(linea, codi)]
                i = bisect.bisect_left(lst, t)
                cerca = min((lst[k] for k in (i - 1, i) if 0 <= k < len(lst)), key=lambda p: abs(p - t))
                retraso = t - cerca
                if abs(retraso) > 20 * 60:
                    continue
                out.append({"fuente": self.nombre, "id": codi, "x": x, "z": z, "linea": linea, "sentido": sentido,
                            "destino": destino, "id_bus": bus, "retraso_s": round(retraso),
                            "llegada_prevista": datetime.fromtimestamp(llegada, timezone.utc).isoformat(),
                            "programada": datetime.fromtimestamp(medianoche + cerca, timezone.utc).isoformat()})
        return out

    def gold(self, actual, eventos, ts):
        ahora = ts.timestamp()
        self.obs = [o for o in self.obs if ahora - o[0] < self.VENTANA] + [(ahora, r["linea"], r["retraso_s"]) for r in actual]
        por = defaultdict(list)
        for _, linea, r in self.obs:
            por[linea].append(r)
        todos = [r for _, _, r in self.obs]
        return {"lineas": {l: {"retraso_s": int(statistics.median(v)), "n": len(v)} for l, v in por.items()},
                "retraso_medio_s": int(statistics.median(todos)) if todos else None,
                "observaciones": len(self.obs), "paradas_control": len(self.control), "por_ciclo": self.POR_CICLO}


FUENTES: list[Fuente] = [Bicing(), Trafico(), Tiempo(), BusTMB()]

# Capas que el visor ya enseña o enseñará; aparecen en el manifiesto para que el panel muestre el plan completo
PLANIFICADAS = {
    "vehiculos": {"estado": "simulado", "simulado": True,
                  "descripcion": "Coches y buses simulados sobre la red viaria con la densidad del tráfico real"},
    "metro": {"estado": "simulado", "simulado": True, "descripcion": "Trenes según el horario GTFS de TMB"},
    "personas": {"estado": "pendiente", "descripcion": "Flujos de peatones estimados"},
}


# =====================================================================================================
# Motor
# =====================================================================================================
class Motor:
    def __init__(self, fuentes: list[Fuente]):
        self.fuentes = fuentes
        self.prox = {f.nombre: 0.0 for f in fuentes}
        self.fallos = {f.nombre: 0 for f in fuentes}
        self.previo: dict[str, list] = {}
        mf = VIVO / "manifest.json"
        self.capas: dict[str, dict] = {}
        if mf.exists():
            try:
                self.capas = json.loads(mf.read_text(encoding="utf-8")).get("capas", {})
            except Exception:  # noqa: BLE001
                pass
        for f in fuentes:
            p = ESTADO / f"{f.nombre}.json"
            if p.exists():
                try:
                    self.previo[f.nombre] = json.loads(p.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    pass

    def una(self, f: Fuente) -> None:
        ts = datetime.now(timezone.utc).replace(microsecond=0)
        t0 = time.perf_counter()
        try:
            crudo, datos = f.capturar()
            guardar_bronze(f.nombre, crudo, ts)
            regs = f.normalizar(datos, ts)
            evs = f.eventos(self.previo.get(f.nombre), regs, ts)
            guardar_silver(f.nombre, regs, ts)
            guardar_silver(f.nombre + "_eventos", evs, ts)
            g = f.gold(regs, evs, ts)
            g["ts"] = ts.isoformat()
            escribir_json(VIVO / f"{f.nombre}.json", g)
            escribir_json(ESTADO / f"{f.nombre}.json", regs)
            self.previo[f.nombre] = regs
            ms = (time.perf_counter() - t0) * 1000
            self.capas[f.nombre] = {"estado": "ok", "ts": ts.isoformat(), "cada": f.cada, "archivo": f"{f.nombre}.json",
                                    "n": len(regs), "eventos": len(evs), "ms": round(ms), "origen": f.origen,
                                    "descripcion": f.descripcion}
            self.fallos[f.nombre] = 0
            self.prox[f.nombre] = time.time() + f.cada
            log(f"{ts.astimezone():%H:%M:%S} {f.nombre:<8} {len(regs):5d} registros · {len(evs):4d} eventos · {ms:5.0f} ms")
        except Exception as e:  # noqa: BLE001  una fuente caída no para las demás
            self.fallos[f.nombre] += 1
            espera = min(f.cada * 2 ** min(self.fallos[f.nombre], 5), 1800)
            self.prox[f.nombre] = time.time() + espera
            prev = self.capas.get(f.nombre, {})
            self.capas[f.nombre] = {**prev, "estado": "error", "error": str(e)[:200], "cada": f.cada,
                                    "origen": f.origen, "descripcion": f.descripcion}
            log(f"{datetime.now():%H:%M:%S} {f.nombre:<8} ERROR: {e} (reintento en {espera:.0f} s)")

    def manifiesto(self) -> None:
        capas = {**{k: dict(v) for k, v in PLANIFICADAS.items()}, **self.capas}
        escribir_json(VIVO / "manifest.json", {"version": 1, "generado": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
                                              "capas": capas})

    def correr(self, una_vez: bool) -> None:
        while True:
            for f in self.fuentes:
                if time.time() >= self.prox[f.nombre]:
                    self.una(f)
            self.manifiesto()
            if una_vez:
                return
            time.sleep(max(1.0, min(self.prox.values()) - time.time()))


def estado() -> None:
    """Resumen del histórico: ficheros, filas, tamaño y fechas por fuente y capa."""
    print(f"{'capa':<8} {'fuente':<18} {'días':>5} {'ficheros':>9} {'filas':>11} {'MB':>8}  desde → hasta")
    for capa in ("bronze", "silver"):
        base = STREAM / capa
        if not base.exists():
            continue
        for d in sorted(p for p in base.iterdir() if p.is_dir()):
            fechas = sorted(p.name.split("=")[1] for p in d.iterdir() if p.is_dir())
            fich = [f for f in d.rglob("*") if f.is_file()]
            mb = sum(f.stat().st_size for f in fich) / 1e6
            filas = ""
            if capa == "silver":
                try:
                    import pyarrow.parquet as pq
                    filas = f"{sum(pq.ParquetFile(f).metadata.num_rows for f in fich if f.suffix == '.parquet'):,}"
                except ImportError:
                    filas = "?"
            print(f"{capa:<8} {d.name:<18} {len(fechas):5d} {len(fich):9,} {filas:>11} {mb:8.1f}  "
                  f"{fechas[0] if fechas else '-'} → {fechas[-1] if fechas else '-'}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--una-vez", action="store_true", help="una captura de cada fuente y salir")
    ap.add_argument("--solo", help="fuentes separadas por comas: " + ",".join(f.nombre for f in FUENTES))
    ap.add_argument("--estado", action="store_true", help="resumen del histórico acumulado")
    a = ap.parse_args()
    if a.estado:
        estado()
        return
    fuentes = FUENTES
    if a.solo:
        pedidas = {s.strip() for s in a.solo.split(",")}
        fuentes = [f for f in FUENTES if f.nombre in pedidas]
        if not fuentes:
            raise SystemExit(f"Fuentes disponibles: {', '.join(f.nombre for f in FUENTES)}")
    log(f"flujo en vivo: {', '.join(f'{f.nombre} (cada {f.cada} s)' for f in fuentes)}")
    log(f"histórico en {STREAM.relative_to(ROOT)} · estado para el visor en {VIVO.relative_to(ROOT)}")
    try:
        Motor(fuentes).correr(a.una_vez)
    except KeyboardInterrupt:
        log("parado")


if __name__ == "__main__":
    main()
