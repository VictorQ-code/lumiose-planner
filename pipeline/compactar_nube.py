"""Flujo nocturno de datos en la nube (R2): bronze -> silver -> gold + catálogo y calidad. Lo lanza GitHub Actions cada noche.

El Worker de Cloudflare guarda cada captura suelta en  bronze/<fuente>/fecha=AAAA-MM-DD/HHMMSSZ.json.gz  (unas 2.500 al día).
Cada noche este script las agrupa en archivos cada vez más grandes, sin perder datos, para que ocupen lo mínimo:

  día      silver/dia/<fuente>/2026-11-24.parquet       + .crudo.jsonl.xz   (las capturas sueltas del día)
  semana   silver/semana/<fuente>/2026-W48.parquet      + .crudo.jsonl.xz   (7 días, semana ISO de lunes a domingo)
  mes      silver/mes/<fuente>/2026-11.parquet          + .crudo.jsonl.xz   (las 4-5 semanas cuyo jueves cae en ese mes)
  año      silver/ano/<fuente>/2026.parquet                                  (12 meses)
  década   silver/decada/<fuente>/2020s.parquet                              (10 años)

- .parquet: los datos ya ordenados en tabla (por columnas y comprimido con zstd): es lo que usan los análisis y la IA.
- .crudo.jsonl.xz: las respuestas originales tal cual llegaron, por si algún día hay que volver a leerlas.
  Al cerrar un año se queda solo la tabla, y el Bicing de ese año pasa de cada minuto a cada 5 minutos:
  así 10 años caben de sobra en los 10 GB gratuitos de R2.
- Un grupo solo se cierra cuando su periodo ha terminado, y los archivos pequeños solo se borran cuando el grande
  ya está subido y comprobado. Si algo falla, no se borra nada y se reintenta la noche siguiente.
- silver/indice.json lleva el inventario (filas, tamaño y fechas de cada archivo) y data/gold/barcelona/historico.json
  un resumen para la web (y para que GitHub vea actividad y no pare la tarea programada).

Uso:
  python pipeline/compactar_nube.py                    contra R2 (claves en R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)
  python pipeline/compactar_nube.py --prueba           escribe en prueba/ (silver, gold, catálogo) y no borra nada
  python pipeline/compactar_nube.py --local CARPETA    contra una carpeta del PC con la misma estructura (para tests)
  python pipeline/compactar_nube.py --hoy 2026-12-01   como si hoy fuera esa fecha (para tests)
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import lzma
import os
import re
import sys
import tempfile
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

MADRID = ZoneInfo("Europe/Madrid")
ROOT = Path(__file__).resolve().parent.parent
RESUMEN = ROOT / "data" / "gold" / "barcelona" / "historico.json"
CUENTA = os.environ.get("R2_ACCOUNT_ID", "a58414a69e285bf10ea3dd06d066ddd5")
BUCKET = os.environ.get("R2_BUCKET", "lumiose-datos")


def log(*a) -> None:
    print(time.strftime("%H:%M:%S"), *a, flush=True)


# =====================================================================================================
# Almacén: R2 (API S3) o una carpeta local con la misma estructura
# =====================================================================================================
class R2:
    def __init__(self):
        import boto3
        from botocore.config import Config
        self.s3 = boto3.client("s3", endpoint_url=f"https://{CUENTA}.r2.cloudflarestorage.com",
                               aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
                               aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"], region_name="auto",
                               config=Config(retries={"max_attempts": 8, "mode": "standard"}, max_pool_connections=32))

    def listar(self, prefijo: str) -> dict[str, int]:
        out = {}
        for pag in self.s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefijo):
            for o in pag.get("Contents", []):
                out[o["Key"]] = o["Size"]
        return out

    def leer(self, clave: str) -> tuple[bytes, dict]:
        r = self.s3.get_object(Bucket=BUCKET, Key=clave)
        return r["Body"].read(), r.get("Metadata", {})

    def bajar(self, clave: str, ruta: Path) -> None:
        self.s3.download_file(BUCKET, clave, str(ruta))

    def subir(self, ruta: Path, clave: str, tipo: str) -> None:
        self.s3.upload_file(str(ruta), BUCKET, clave, ExtraArgs={"ContentType": tipo})

    def tamano(self, clave: str) -> int | None:
        try:
            return self.s3.head_object(Bucket=BUCKET, Key=clave)["ContentLength"]
        except self.s3.exceptions.ClientError:
            return None

    def copiar(self, origen: str, destino: str) -> None:                  # dentro de R2, sin bajar nada
        self.s3.copy_object(Bucket=BUCKET, Key=destino, CopySource={"Bucket": BUCKET, "Key": origen})

    def borrar(self, claves: list[str]) -> None:
        for i in range(0, len(claves), 1000):
            r = self.s3.delete_objects(Bucket=BUCKET, Delete={"Objects": [{"Key": k} for k in claves[i:i + 1000]], "Quiet": True})
            if r.get("Errors"):
                raise RuntimeError(f"no se pudieron borrar {len(r['Errors'])} objetos: {r['Errors'][0]}")


class Local:
    def __init__(self, raiz: str):
        self.raiz = Path(raiz)

    def _p(self, clave: str) -> Path:
        return self.raiz / clave

    def listar(self, prefijo: str) -> dict[str, int]:
        base = self.raiz / prefijo.rsplit("/", 1)[0] if "/" in prefijo else self.raiz
        if not base.exists():
            return {}
        return {p.relative_to(self.raiz).as_posix(): p.stat().st_size for p in base.rglob("*")
                if p.is_file() and p.relative_to(self.raiz).as_posix().startswith(prefijo)}

    def leer(self, clave: str) -> tuple[bytes, dict]:
        return self._p(clave).read_bytes(), {}

    def bajar(self, clave: str, ruta: Path) -> None:
        ruta.write_bytes(self._p(clave).read_bytes())

    def subir(self, ruta: Path, clave: str, tipo: str) -> None:
        self._p(clave).parent.mkdir(parents=True, exist_ok=True)
        self._p(clave).write_bytes(Path(ruta).read_bytes())

    def tamano(self, clave: str) -> int | None:
        return self._p(clave).stat().st_size if self._p(clave).exists() else None

    def copiar(self, origen: str, destino: str) -> None:
        self._p(destino).parent.mkdir(parents=True, exist_ok=True)
        self._p(destino).write_bytes(self._p(origen).read_bytes())

    def borrar(self, claves: list[str]) -> None:
        for k in claves:
            self._p(k).unlink(missing_ok=True)


# =====================================================================================================
# Fuentes: de la respuesta original a filas de tabla (mismo criterio que pipeline/vivo.py)
# =====================================================================================================
TS = pa.timestamp("s", tz="UTC")


def _utc(segundos) -> datetime | None:
    try:
        s = float(segundos)
    except (TypeError, ValueError):
        return None
    return datetime.fromtimestamp(s / 1000 if s > 1e11 else s, timezone.utc) if s > 0 else None


def _ent(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _txt(v):
    return None if v is None else str(v)


def bicing(ts, txt):
    for st in json.loads(txt)["data"]["stations"]:
        total = int(st.get("num_bikes_available") or 0)
        ele = sum(int(v.get("count") or 0) for v in st.get("vehicle_types_available") or []
                  if any(w in str(v.get("vehicle_type_id", "")).lower() for w in ("ebike", "electric")))
        tipos = st.get("num_bikes_available_types")
        if isinstance(tipos, dict):
            ele = int(tipos.get("ebike", tipos.get("electric", ele)) or 0)
        ele = min(total, ele)
        yield {"ts": ts, "id": str(st["station_id"]), "mecanicas": total - ele, "electricas": ele,
               "anclajes_libres": int(st.get("num_docks_available") or 0),
               "activa": bool(st.get("is_renting", 1)) and bool(st.get("is_installed", 1)),
               "ultimo_reporte": _utc(st.get("last_reported"))}


def bicing_info(ts, txt):
    for st in json.loads(txt)["data"]["stations"]:
        cap = st.get("capacity")
        yield {"ts": ts, "id": str(st["station_id"]), "nombre": (st.get("name") or "").strip(),
               "lat": st.get("lat"), "lon": st.get("lon"), "capacidad": int(cap) if cap is not None else None}


def trafico(ts, txt):
    for linea in txt.splitlines():
        p = linea.strip().split("#")
        if len(p) < 4 or not p[0].strip().isdigit():
            continue
        try:
            fd = datetime.strptime(p[1].strip(), "%Y%m%d%H%M%S").replace(tzinfo=MADRID).astimezone(timezone.utc)
        except ValueError:
            fd = None
        try:
            yield {"ts": ts, "id": int(p[0]), "fecha_dato": fd, "estado": int(p[2]), "previsto": int(p[3])}
        except ValueError:
            continue


def tiempo(ts, txt):
    d = json.loads(txt)["current"]
    yield {"ts": ts, "hora_dato": d.get("time"), "temperatura": d.get("temperature_2m"),
           "sensacion": d.get("apparent_temperature"), "humedad": d.get("relative_humidity_2m"),
           "precipitacion_mm": d.get("precipitation"), "lluvia_mm": d.get("rain"), "codigo": d.get("weather_code"),
           "nubes": d.get("cloud_cover"), "viento_kmh": d.get("wind_speed_10m"),
           "viento_dir": d.get("wind_direction_10m"), "es_dia": bool(d.get("is_day", 1))}


def bus(ts, txt):
    """Todas las llegadas previstas de iBus en las paradas consultadas (no solo la primera): más material para aprender."""
    for codi, t in json.loads(txt).items():
        try:
            j = json.loads(t)
        except (TypeError, ValueError):
            continue

        def walk(o):
            if isinstance(o, dict):
                if isinstance(o.get("propers_busos"), list):
                    for k, b in enumerate(o["propers_busos"]):
                        lleg = _utc(b.get("temps_arribada"))
                        if lleg:
                            yield {"ts": ts, "parada": str(codi), "linea": str(o.get("nom_linia") or ""),
                                   "codi_linia": _txt(o.get("codi_linia")), "sentido": _ent(o.get("id_sentit")),
                                   "trayecto": str(o.get("codi_trajecte") or ""), "destino": o.get("desti_trajecte"),
                                   "id_bus": _ent(b.get("id_bus")), "orden": min(k, 127), "llegada": lleg}
                for v in o.values():
                    yield from walk(v)
            elif isinstance(o, list):
                for v in o:
                    yield from walk(v)
        yield from walk(j)


# --- Incidencias del Ayuntamiento: una frase en catalán por incidencia («C. Muntaner a l´altura de … tallat al trànsit per
#     obres.»). Se clasifica por la causa y el efecto que dice el propio texto; el texto original se guarda siempre.
_CAUSAS = [("accidente", r"accident|xoc|col·lisi|col\.lisi|atropell"), ("averia", r"avaria|avariat"),
           ("obras", r"obres|obra\b|asfaltat|pavimentaci"), ("manifestacion", r"manifestaci|concentraci|protesta|vaga"),
           ("evento", r"esdeveniment|cursa|marat|festa|concert|partit|cavalcada|desfilada|acte\b|fira|rodatge|filmaci"),
           ("emergencia", r"incendi|emergència|inundaci|despreniment|fuita|bombers"),
           ("meteo", r"pluja|neu|vent|gel\b|temporal"), ("mudanza", r"mudança|grua|contenidor")]
_EFECTOS = [("cortado", r"tallat|tallada|tall\b|tancat|tancada"), ("retenciones", r"retenci|congesti"),
            ("restricciones", r"restricci|afectaci|desviament|desviat|carril")]


def _clase(txt: str, tabla, nada="otra") -> str:
    t = txt.lower()
    for nombre, patron in tabla:
        if re.search(patron, t):
            return nombre
    return nada


def incidencias_bcn(ts, txt):
    linea = next((l for l in txt.splitlines() if l.strip()), "")
    for frase in re.split(r"\s{3,}", linea):
        frase = frase.strip()
        if len(frase) < 4:
            continue
        tramo = re.match(r"^(.+)\s+de\s+((?:(?!\s+de\s).)+?)\s+fins\s+a\s+", frase)      # «Pg. de Gràcia de Av. Diagonal fins a …»
        via = tramo.group(1).strip() if tramo else re.split(
            r"\s+sentit\s+|\s+a\s+l[´'’]altura|,|\s+tallat|\s+tallada|\s+restricc", frase, maxsplit=1)[0].strip()
        m = re.search(r"sentit\s+(.+?)(?:\s+a\s+l[´'’]altura|,|$)", frase)
        yield {"ts": ts, "texto": frase, "causa": _clase(frase, _CAUSAS, "sin_indicar"), "efecto": _clase(frase, _EFECTOS),
               "via": via, "sentido": m.group(1).strip() if m else None}


# --- Incidencias del Servei Català de Trànsit (DATEX II 1.0): toda Cataluña; se marca si toca Barcelona y alrededores
def incidencias_sct(ts, txt):
    import xml.etree.ElementTree as ET
    xsi = "{http://www.w3.org/2001/XMLSchema-instance}type"
    loc = lambda e: e.tag.rsplit("}", 1)[-1]  # noqa: E731
    sub_campos = ("roadMaintenanceType", "accidentType", "vehicleObstructionType", "obstructionType", "networkManagementType",
                  "abnormalTrafficType", "poorEnvironmentType", "environmentalObstructionType", "publicEventType",
                  "nonWeatherRelatedRoadConditionType", "weatherRelatedRoadConditionType", "roadOrCarriagewayOrLaneManagementType",
                  "disturbanceActivityType", "constructionWorkType", "trafficTrendType")
    for rec in ET.fromstring(txt.encode("utf-8")).iter():
        if loc(rec) != "situationRecord":
            continue
        campos = {}
        for e in rec.iter():
            if e is not rec and e.text and e.text.strip():
                campos.setdefault(loc(e), e.text.strip())
        sub = next((f"{k}={campos[k]}" for k in sub_campos if k in campos), None)
        lats = [float(e.text) for e in rec.iter() if loc(e) == "latitude"]
        lons = [float(e.text) for e in rec.iter() if loc(e) == "longitude"]
        ciudad = [e.text.strip() for e in rec.iter() if loc(e) == "value" and e.text and e.text.strip()]
        yield {"ts": ts, "id": rec.get("id"), "version": _ent(campos.get("situationRecordVersion")),
               "tipo": (rec.get(xsi) or "?").split(":")[-1], "subtipo": sub, "carretera": campos.get("roadNumber"),
               "lugar": next((c for c in ciudad if c.isupper() and not re.match(r"^[A-Z]{1,3}-\d", c)), None),
               "sentido": campos.get("tpegDirection"), "estado": campos.get("validityStatus"),
               "desde": campos.get("overallStartTime"), "hasta": campos.get("overallEndTime"),
               "lat": lats[0] if lats else None, "lon": lons[0] if lons else None,
               "bcn": any(41.30 < la < 41.50 and 2.02 < lo < 2.28 for la, lo in zip(lats, lons))}


FUENTES = {
    "bicing": (bicing, ["id", "ts"], pa.schema([("ts", TS), ("id", pa.string()), ("mecanicas", pa.int16()),
               ("electricas", pa.int16()), ("anclajes_libres", pa.int16()), ("activa", pa.bool_()), ("ultimo_reporte", TS)])),
    "bicing_info": (bicing_info, ["id", "ts"], pa.schema([("ts", TS), ("id", pa.string()), ("nombre", pa.string()),
                    ("lat", pa.float64()), ("lon", pa.float64()), ("capacidad", pa.int16())])),
    "trafico": (trafico, ["id", "ts"], pa.schema([("ts", TS), ("id", pa.int16()), ("fecha_dato", TS),
                ("estado", pa.int8()), ("previsto", pa.int8())])),
    "tiempo": (tiempo, ["ts"], pa.schema([("ts", TS), ("hora_dato", pa.string()), ("temperatura", pa.float32()),
               ("sensacion", pa.float32()), ("humedad", pa.float32()), ("precipitacion_mm", pa.float32()),
               ("lluvia_mm", pa.float32()), ("codigo", pa.int16()), ("nubes", pa.float32()), ("viento_kmh", pa.float32()),
               ("viento_dir", pa.float32()), ("es_dia", pa.bool_())])),
    "bus": (bus, ["parada", "linea", "ts", "orden"], pa.schema([("ts", TS), ("parada", pa.string()), ("linea", pa.string()),
            ("codi_linia", pa.string()), ("sentido", pa.int16()), ("trayecto", pa.string()), ("destino", pa.string()),
            ("id_bus", pa.int32()), ("orden", pa.int8()), ("llegada", TS)])),
    "incidencias_bcn": (incidencias_bcn, ["ts", "texto"], pa.schema([("ts", TS), ("texto", pa.string()), ("causa", pa.string()),
                        ("efecto", pa.string()), ("via", pa.string()), ("sentido", pa.string())])),
    "incidencias_sct": (incidencias_sct, ["id", "ts"], pa.schema([("ts", TS), ("id", pa.string()), ("version", pa.int16()),
                        ("tipo", pa.string()), ("subtipo", pa.string()), ("carretera", pa.string()), ("lugar", pa.string()),
                        ("sentido", pa.string()), ("estado", pa.string()), ("desde", pa.string()), ("hasta", pa.string()),
                        ("lat", pa.float32()), ("lon", pa.float32()), ("bcn", pa.bool_())])),
}


# =====================================================================================================
# Calendario: a qué grupo va cada archivo y cuándo se cierra cada grupo
# =====================================================================================================
def semana_de(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def jueves(clave_semana: str) -> date:
    y, w = clave_semana.split("-W")
    return date.fromisocalendar(int(y), int(w), 4)


def fin_mes(clave: str) -> date:
    """Último domingo del mes «por jueves»: el de la última semana ISO cuyo jueves cae en ese mes."""
    y, m = map(int, clave.split("-"))
    ultimo = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))
    j = ultimo - timedelta(days=ultimo.isoweekday() - 4)
    if j > ultimo:
        j -= timedelta(days=7)
    return j + timedelta(days=3)


NIVELES = [  # (hijo, padre, clave del padre, fin del padre, ¿se queda el crudo?)
    ("dia", "semana", lambda k: semana_de(date.fromisoformat(k)), lambda p: jueves(p) + timedelta(days=3), True),
    ("semana", "mes", lambda k: f"{jueves(k):%Y-%m}", fin_mes, True),
    ("mes", "ano", lambda k: k[:4], lambda p: fin_mes(f"{p}-12"), False),
    ("ano", "decada", lambda k: f"{k[:3]}0s", lambda p: fin_mes(f"{int(p[:4]) + 9}-12"), False),
]


# =====================================================================================================
# Compactador
# =====================================================================================================
class Compactador:
    def __init__(self, alm, hoy: date, prueba: bool):
        self.alm, self.hoy, self.prueba = alm, hoy, prueba
        self.raiz = "prueba/" if prueba else ""
        self.base = self.raiz + "silver/"
        self.tmp = Path(tempfile.mkdtemp(prefix="compactar_"))
        self.errores: list[str] = []
        self.hecho: list[str] = []
        self.mudar()
        try:
            self.indice = json.loads(self.alm.leer(self.base + "indice.json")[0])
        except Exception:  # noqa: BLE001  (primera vez)
            self.indice = {"archivos": {}}

    # ---------- mudanza (una sola vez): la carpeta historico/ pasa a llamarse silver/ ----------
    def mudar(self) -> None:
        viejo = self.raiz + "historico/"
        antes = self.alm.listar(viejo)
        if not antes:
            return
        n = 0
        for k, tam in antes.items():
            nuevo = self.base + k[len(viejo):]
            if k.endswith("indice.json"):
                txt = self.alm.leer(k)[0].decode("utf-8").replace(f'"{viejo}', f'"{self.base}')   # las claves del inventario
                ri = self.tmp / "indice_mudado.json"
                ri.write_text(txt, encoding="utf-8")
                self.alm.subir(ri, nuevo, "application/json")
            else:
                self.alm.copiar(k, nuevo)
                if self.alm.tamano(nuevo) != tam:
                    raise RuntimeError(f"mudanza: {nuevo} no coincide con {k}; no se borra nada")
            n += 1
        self.alm.borrar(list(antes))
        log(f"mudanza: {n} archivos de {viejo} a {self.base}")

    # ---------- utilidades ----------
    def _ts_de(self, clave: str, meta: dict, dia: str) -> datetime:
        if meta.get("ts"):
            return datetime.fromisoformat(meta["ts"].replace("Z", "+00:00")).replace(microsecond=0)
        nombre = clave.rsplit("/", 1)[1].split(".")[0]
        hh, mm, ss = int(nombre[0:2]), int(nombre[2:4]), int(nombre[4:6])
        d = date.fromisoformat(dia)
        if nombre.endswith("Z"):                         # hora UTC; la carpeta es el día de Barcelona
            for delta in (0, -1, 1):
                t = datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=timezone.utc) + timedelta(days=delta)
                if t.astimezone(MADRID).date() == d:
                    return t
        return datetime(d.year, d.month, d.day, hh, mm, ss, tzinfo=MADRID).astimezone(timezone.utc)

    def _subir_comprobado(self, ruta: Path, clave: str, tipo: str) -> None:
        self.alm.subir(ruta, clave, tipo)
        t = self.alm.tamano(clave)
        if t != ruta.stat().st_size:
            raise RuntimeError(f"{clave}: subido {t} bytes, esperaba {ruta.stat().st_size}")

    def _anotar(self, clave: str, ruta: Path) -> None:
        pf = pq.ParquetFile(ruta)
        lo = hi = None
        for i in range(pf.metadata.num_row_groups):
            st = pf.metadata.row_group(i).column(0).statistics           # columna 0 = ts
            if st is not None and st.has_min_max:
                lo = st.min if lo is None else min(lo, st.min)
                hi = st.max if hi is None else max(hi, st.max)
        self.indice["archivos"][clave] = {"filas": pf.metadata.num_rows, "bytes": ruta.stat().st_size,
                                          "desde": lo.isoformat() if lo else None, "hasta": hi.isoformat() if hi else None}

    @staticmethod
    def _escribir(tabla: pa.Table, ruta: Path) -> None:
        pq.write_table(tabla, ruta, compression="zstd", compression_level=9, use_dictionary=True,
                       write_statistics=True, row_group_size=2_000_000)

    # ---------- capturas sueltas -> un archivo por día ----------
    def dias(self) -> None:
        for fuente, (parse, orden, esquema) in FUENTES.items():
            sueltas = self.alm.listar(f"bronze/{fuente}/")
            por_dia = defaultdict(list)
            for k in sueltas:
                m = re.search(r"/fecha=(\d{4}-\d{2}-\d{2})/", k)
                if m and date.fromisoformat(m.group(1)) < self.hoy:          # el día de hoy aún se está llenando
                    por_dia[m.group(1)].append(k)
            for dia, claves in sorted(por_dia.items()):
                try:
                    self._un_dia(fuente, parse, orden, esquema, dia, sorted(claves))
                except Exception as e:  # noqa: BLE001
                    self.errores.append(f"{fuente} {dia}: {e}")
                    log("ERROR", fuente, dia, e)

    def _un_dia(self, fuente, parse, orden, esquema, dia, claves) -> None:
        with ThreadPoolExecutor(16) as ex:
            datos = list(ex.map(lambda k: (k, *self.alm.leer(k)), claves))
        filas, crudo, malas = [], io.BytesIO(), 0
        lineas = []
        for k, cuerpo, meta in datos:
            ts = self._ts_de(k, meta, dia)
            txt = gzip.decompress(cuerpo).decode("utf-8") if cuerpo[:2] == b"\x1f\x8b" else cuerpo.decode("utf-8")
            lineas.append((ts, json.dumps({"ts": ts.isoformat(), "k": k.rsplit("/", 1)[1], "raw": txt}, ensure_ascii=False)))
            try:
                filas.extend(parse(ts, txt))
            except Exception:  # noqa: BLE001  (respuesta rara: queda en el crudo)
                malas += 1
        lineas.sort()
        crudo.write(lzma.compress(("\n".join(l for _, l in lineas) + "\n").encode("utf-8"), preset=9))
        tabla = pa.Table.from_pylist(filas, schema=esquema) if filas else esquema.empty_table()
        tabla = tabla.sort_by([(c, "ascending") for c in orden])
        destino = f"{self.base}dia/{fuente}/{dia}"
        # Si ya había archivo de ese día (capturas que llegaron tarde), se suma
        previo = None if self.prueba else self.alm.tamano(destino + ".parquet")   # en prueba se rehace
        ruta_pq, ruta_xz = self.tmp / f"{fuente}_{dia}.parquet", self.tmp / f"{fuente}_{dia}.crudo.jsonl.xz"
        if previo is not None:
            self.alm.bajar(destino + ".parquet", ruta_pq)
            tabla = pa.concat_tables([pq.read_table(ruta_pq).cast(esquema), tabla]).sort_by([(c, "ascending") for c in orden])
        self._escribir(tabla, ruta_pq)
        crudo_bytes = crudo.getvalue()
        if previo is not None and self.alm.tamano(destino + ".crudo.jsonl.xz") is not None:   # los xz se encadenan tal cual
            crudo_bytes = self.alm.leer(destino + ".crudo.jsonl.xz")[0] + crudo_bytes
        ruta_xz.write_bytes(crudo_bytes)
        self._subir_comprobado(ruta_pq, destino + ".parquet", "application/vnd.apache.parquet")
        self._subir_comprobado(ruta_xz, destino + ".crudo.jsonl.xz", "application/x-xz")
        self._anotar(destino + ".parquet", ruta_pq)
        if not self.prueba:
            self.alm.borrar(claves)
        self.hecho.append(f"día {dia} {fuente}: {len(claves)} capturas -> {tabla.num_rows:,} filas "
                          f"({ruta_pq.stat().st_size / 1e6:.2f} MB tabla + {len(crudo_bytes) / 1e6:.2f} MB crudo)"
                          + (f", {malas} respuestas raras guardadas solo en crudo" if malas else ""))
        log(self.hecho[-1])
        ruta_pq.unlink(); ruta_xz.unlink()

    # ---------- días -> semana -> mes -> año -> década ----------
    def agrupar(self) -> None:
        for hijo, padre, clave_padre, fin, con_crudo in NIVELES:
            for fuente, (_, _, esquema) in FUENTES.items():
                pref = f"{self.base}{hijo}/{fuente}/"
                tablas = sorted(k for k in self.alm.listar(pref) if k.endswith(".parquet"))
                grupos = defaultdict(list)
                for k in tablas:
                    grupos[clave_padre(k[len(pref):-len(".parquet")])].append(k)
                for p, hijos in sorted(grupos.items()):
                    if fin(p) >= self.hoy:
                        continue                                       # el periodo aún no ha terminado
                    try:
                        self._un_grupo(fuente, esquema, hijo, padre, p, hijos, con_crudo)
                    except Exception as e:  # noqa: BLE001
                        self.errores.append(f"{fuente} {padre} {p}: {e}")
                        log("ERROR", fuente, padre, p, e)

    def _un_grupo(self, fuente, esquema, hijo, padre, p, hijos, con_crudo) -> None:
        destino = f"{self.base}{padre}/{fuente}/{p}"
        ruta = self.tmp / f"{fuente}_{padre}_{p}.parquet"
        previo = not self.prueba and self.alm.tamano(destino + ".parquet") is not None
        entradas = ([destino + ".parquet"] if previo else []) + hijos
        filas = 0
        with pq.ParquetWriter(ruta, esquema, compression="zstd", compression_level=9, use_dictionary=True) as w:
            for k in entradas:                                          # de uno en uno: la memoria no crece con los años
                tmp = self.tmp / "entrada.parquet"
                self.alm.bajar(k, tmp)
                for lote in pq.ParquetFile(tmp).iter_batches(batch_size=1_000_000):
                    t = pa.Table.from_batches([lote]).cast(esquema)
                    if padre == "ano" and fuente == "bicing":           # al cerrar el año: Bicing cada 5 minutos
                        minuto = pc.divide(t["ts"].cast(pa.int64()), 60)
                        t = t.filter(pc.equal(pc.subtract(minuto, pc.multiply(pc.divide(minuto, 5), 5)), 0))
                    w.write_table(t)
                    filas += t.num_rows
                tmp.unlink()
        self._subir_comprobado(ruta, destino + ".parquet", "application/vnd.apache.parquet")
        self._anotar(destino + ".parquet", ruta)
        borrar = list(hijos)
        crudos = [h[:-len(".parquet")] + ".crudo.jsonl.xz" for h in hijos]
        crudos = [c for c in crudos if self.alm.tamano(c) is not None]
        if con_crudo and crudos:
            rx = self.tmp / f"{fuente}_{padre}_{p}.crudo.jsonl.xz"
            with open(rx, "wb") as f:
                if previo and self.alm.tamano(destino + ".crudo.jsonl.xz") is not None:
                    f.write(self.alm.leer(destino + ".crudo.jsonl.xz")[0])
                for c in crudos:
                    f.write(self.alm.leer(c)[0])
            self._subir_comprobado(rx, destino + ".crudo.jsonl.xz", "application/x-xz")
            rx.unlink()
        borrar += crudos                         # sin crudo (año y década): las respuestas originales ya no se guardan
        if not self.prueba:
            self.alm.borrar(borrar)
        for h in hijos:
            self.indice["archivos"].pop(h, None)
        self.hecho.append(f"{padre} {p} {fuente}: {len(hijos)} archivos de {hijo} -> {filas:,} filas "
                          f"({ruta.stat().st_size / 1e6:.2f} MB)")
        log(self.hecho[-1])
        ruta.unlink()

    # ---------- inventario ----------
    def cerrar(self) -> dict:
        todo = self.alm.listar(self.base)
        arch = self.indice["archivos"]
        for k in list(arch):
            if k not in todo:
                arch.pop(k)
        total = sum(todo.values())
        por_fuente = defaultdict(lambda: {"filas": 0, "bytes": 0, "desde": None, "hasta": None})
        for k, v in arch.items():
            f = por_fuente[k.split("/")[-2]]
            f["filas"] += v["filas"]; f["bytes"] += v["bytes"]
            if v["desde"] and (not f["desde"] or v["desde"] < f["desde"]): f["desde"] = v["desde"]
            if v["hasta"] and (not f["hasta"] or v["hasta"] > f["hasta"]): f["hasta"] = v["hasta"]
        sueltas = self.alm.listar("bronze/")
        resumen = {"actualizado": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "prueba": self.prueba,
                   "bytes_historico": total, "bytes_capturas_sueltas": sum(sueltas.values()),
                   "capturas_sueltas": len(sueltas), "fuentes": dict(por_fuente),
                   "ultima_ejecucion": {"hecho": self.hecho, "errores": self.errores}}
        self.indice["resumen"] = resumen
        ri = self.tmp / "indice.json"
        ri.write_text(json.dumps(self.indice, ensure_ascii=False, indent=1), encoding="utf-8")
        self.alm.subir(ri, self.base + "indice.json", "application/json")
        return resumen


# =====================================================================================================
# GOLD: tablas listas para la IA (todo en la misma rejilla de 15 minutos, UTC + hora de Barcelona)
#   gold/<tabla>/fecha=AAAA-MM-DD/parte.parquet      hechos por día de Barcelona (se leen con DuckDB, hive_partitioning)
#   gold/dim/<tabla>.parquet                          referencias: calendario, estaciones, tramos (se rehacen cada noche)
#   catalogo/tablas.json · catalogo/LEEME.md          qué es cada tabla y cada columna, y cómo leerlas
#   catalogo/calidad/fecha=AAAA-MM-DD.json · catalogo/calidad.parquet   parte diario: capturas, cobertura, huecos
# Todo se puede rehacer desde silver/: gold nunca es el único sitio donde está un dato.
# =====================================================================================================
import numpy as np  # noqa: E402  (viene con pyarrow)

Q = 900                                    # 15 minutos, en segundos
ESPERADAS = {"bicing": 1440, "bicing_info": 4, "trafico": 288, "tiempo": 96, "bus": 720, "incidencias_bcn": 288, "incidencias_sct": 288}
INDEX = ROOT / "data" / "gold" / "barcelona" / "index.json"
TRAMOS = ROOT / "data" / "gold" / "barcelona" / "vivo" / "tramos.json"
BUSES = ROOT / "data" / "gold" / "barcelona" / "vivo" / "buses.json"    # horario GTFS (TMB + NitBus) de pipeline/buses.py
T_LOCAL = pa.timestamp("s")                # hora de Barcelona sin zona (para leerla a simple vista)


def _dia_utc(d: date) -> tuple[int, int]:
    """Segundos UTC de inicio y fin del día d de Barcelona (23 o 25 h en los cambios de hora)."""
    a = datetime(d.year, d.month, d.day, tzinfo=MADRID)
    b = a + timedelta(days=1)
    return int(a.timestamp()), int(datetime(b.year, b.month, b.day, tzinfo=MADRID).timestamp())


def _local(seg: np.ndarray) -> pa.Array:
    """Segundos UTC -> hora de Barcelona sin zona (con zoneinfo: no depende de la base de zonas de pyarrow)."""
    cache: dict[int, int] = {}
    out = np.empty(len(seg), dtype="int64")
    for i, s in enumerate(seg.astype("int64")):
        h = int(s) // 3600
        if h not in cache:
            cache[h] = int(datetime.fromtimestamp(h * 3600, MADRID).utcoffset().total_seconds())
        out[i] = s + cache[h]
    return pa.array(out, type=T_LOCAL)


def _segundos(col) -> np.ndarray:
    return pc.cast(col, pa.timestamp("s", tz="UTC")).cast(pa.int64()).to_numpy(zero_copy_only=False)


def _cod_parada(sid: str) -> str:
    """Id de parada del GTFS -> código de TMB que usa iBus ("2.1314.683903" -> "1314")."""
    return sid.split(".")[1] if sid.count(".") >= 1 else sid


def _ultimos(clave: np.ndarray) -> np.ndarray:
    """Con 'clave' ordenada: índice de la última fila de cada grupo."""
    return np.flatnonzero(np.r_[clave[1:] != clave[:-1], True])


class Oro:
    def __init__(self, c: "Compactador"):
        self.c, self.alm, self.tmp = c, c.alm, c.tmp
        self.base = c.raiz + "gold/"
        self.cat = c.raiz + "catalogo/"
        self.hecho: list[str] = []
        self._buses = None

    # ---------- lectura de silver por fechas (del nivel que sea: día, semana, mes…) ----------
    def silver(self, fuente: str, s0: int, s1: int) -> pa.Table | None:
        esquema = FUENTES[fuente][2]
        partes = []
        for k, v in self.c.indice["archivos"].items():
            if f"/{fuente}/" not in k or not k.endswith(".parquet") or not v.get("desde"):
                continue
            a = datetime.fromisoformat(v["desde"]).timestamp(); b = datetime.fromisoformat(v["hasta"]).timestamp()
            if b < s0 or a >= s1:
                continue
            ruta = self.tmp / ("s_" + k.replace("/", "_"))
            if not ruta.exists():
                self.alm.bajar(k, ruta)
            t = pq.read_table(ruta).cast(esquema)
            s = _segundos(t["ts"])
            partes.append(t.filter(pa.array((s >= s0) & (s < s1))))
        return pa.concat_tables(partes) if partes else None

    def _subir(self, tabla: pa.Table, clave: str) -> None:
        ruta = self.tmp / ("g_" + clave.replace("/", "_").replace("=", "_"))
        pq.write_table(tabla, ruta, compression="zstd", compression_level=9, use_dictionary=True, write_statistics=True)
        self.c._subir_comprobado(ruta, clave, "application/vnd.apache.parquet")
        ruta.unlink()

    def _dia(self, tabla: str, d: date) -> str:
        return f"{self.base}{tabla}/fecha={d.isoformat()}/parte.parquet"

    # ---------- qué días toca (re)hacer ----------
    def dias_pendientes(self) -> list[date]:
        hechos = {re.search(r"fecha=(\d{4}-\d{2}-\d{2})", k).group(1) for k in self.alm.listar(self.base + "bicing_15min/")}
        con_datos = set()
        for k, v in self.c.indice["archivos"].items():
            if "/bicing/" in k and v.get("desde"):
                d0 = datetime.fromisoformat(v["desde"]).astimezone(MADRID).date()
                d1 = datetime.fromisoformat(v["hasta"]).astimezone(MADRID).date()
                while d0 <= d1:
                    con_datos.add(d0); d0 += timedelta(days=1)
        reciente = self.c.hoy - timedelta(days=3)                   # los últimos días se rehacen (capturas que llegan tarde)
        return sorted(d for d in con_datos if d < self.c.hoy and (d.isoformat() not in hechos or d >= reciente))

    # ---------- referencias ----------
    def dimensiones(self) -> dict:
        import requests
        dims = {}
        # barrios (contorno en coordenadas del visor) para situar estaciones y tramos
        idx = json.loads(INDEX.read_text(encoding="utf-8"))
        barrios = [(b["nom"], b.get("districte"), b["outline"]) for b in idx["barrios"]]

        def barrio(x, z):
            for nom, dis, r in barrios:
                dentro = False
                for (x0, z0), (x1, z1) in zip(r, r[1:] + r[:1]):
                    if (z0 > z) != (z1 > z) and x < x0 + (z - z0) * (x1 - x0) / (z1 - z0):
                        dentro = not dentro
                if dentro:
                    return nom, dis
            return None, None
        sys.path.insert(0, str(ROOT / "pipeline"))
        from geo import a_local                                    # noqa: E402
        # estaciones de Bicing: la última foto de su información
        info = self.silver("bicing_info", 0, 2**31)
        if info is not None and info.num_rows:
            ult = {}
            for r in info.sort_by([("ts", "ascending")]).to_pylist():
                ult[r["id"]] = r
            filas = []
            for r in ult.values():
                x, z = a_local(r["lon"], r["lat"]) if r["lat"] else (None, None)
                nom, dis = barrio(x, z) if x is not None else (None, None)
                filas.append({"estacion_id": r["id"], "nombre": r["nombre"], "lat": r["lat"], "lon": r["lon"], "capacidad": r["capacidad"],
                              "barrio": nom, "distrito": dis, "x": x, "z": z})
            dims["estaciones_bicing"] = pa.Table.from_pylist(filas)
        # tramos de tráfico municipales (geometría ya en el repositorio)
        if TRAMOS.exists():
            filas = []
            for tid, desc, c in json.loads(TRAMOS.read_text(encoding="utf-8"))["tramos"]:
                k = (len(c) // 4) * 2
                nom, dis = barrio(c[k], c[k + 1]) if len(c) >= 2 else (None, None)
                filas.append({"tramo_id": int(tid), "descripcion": desc, "barrio": nom, "distrito": dis, "x": c[k] if c else None, "z": c[k + 1] if c else None,
                              "longitud_m": float(sum(np.hypot(np.diff(c[0::2]), np.diff(c[1::2])))) if len(c) >= 4 else None})
            dims["tramos_trafico"] = pa.Table.from_pylist(filas)
        # paradas y líneas de bus (del horario GTFS que usa el visor); parada = código de TMB, el mismo que da iBus
        hb = self.horario_bus()
        if hb:
            filas = {}
            for sid, (x, z, nom) in hb["paradas"].items():
                cod = _cod_parada(sid)
                if cod not in filas:
                    b, dis = barrio(x, z)
                    filas[cod] = {"parada": cod, "nombre": nom, "x": x, "z": z, "barrio": b, "distrito": dis}
            dims["paradas_bus"] = pa.Table.from_pylist(sorted(filas.values(), key=lambda r: r["parada"]))
            dims["lineas_bus"] = pa.Table.from_pylist([{"linea": l[0], "color": l[1], "nombre": l[2], "nocturna": l[0].startswith("N")}
                                                       for l in hb["lineas"]])
        # calendario: festivos oficiales de Cataluña y locales de Barcelona (Generalitat, datos abiertos)
        fest = {}
        try:
            api = "https://analisi.transparenciacatalunya.cat/resource/"
            for r in requests.get(api + "yf2b-mjr6.json", params={"$limit": 5000}, timeout=60).json():
                fest[r["data"][:10]] = "festivo oficial"
            for r in requests.get(api + "b4eh-r8up.json", params={"$limit": 5000, "codi_municipal": "08019000", "pedania": "000"}, timeout=60).json():
                fest[r["data"][:10]] = "festivo local de Barcelona"
        except Exception as e:  # noqa: BLE001
            self.c.errores.append(f"calendario: no se pudieron leer los festivos ({e})")
        filas, d = [], date(2026, 1, 1)
        while d <= date(self.c.hoy.year + 1, 12, 31):
            a, b = _dia_utc(d)
            filas.append({"fecha": d, "dia_semana": d.isoweekday(), "fin_de_semana": d.isoweekday() >= 6,
                          "festivo": d.isoformat() in fest, "tipo_festivo": fest.get(d.isoformat()), "laborable": d.isoweekday() < 6 and d.isoformat() not in fest,
                          "horas_del_dia": (b - a) // 3600, "horario_verano": bool(datetime(d.year, d.month, d.day, 12, tzinfo=MADRID).dst())})
            d += timedelta(days=1)
        dims["calendario"] = pa.Table.from_pylist(filas)
        for nom, t in dims.items():
            self._subir(t, f"{self.base}dim/{nom}.parquet")
        self.hecho.append("referencias: " + ", ".join(f"{k} ({v.num_rows})" for k, v in dims.items()))
        log(self.hecho[-1])
        return dims

    # ---------- hechos de un día ----------
    def bicing_15min(self, d: date, dims: dict) -> pa.Table | None:
        s0, s1 = _dia_utc(d)
        t = self.silver("bicing", s0 - 300, s1)                    # 5 min antes: para medir la primera cogida del día
        if t is None or not t.num_rows:
            return None
        t = t.sort_by([("id", "ascending"), ("ts", "ascending")])
        ids = t["id"].to_numpy(zero_copy_only=False).astype(str); s = _segundos(t["ts"])
        mec = t["mecanicas"].to_numpy(zero_copy_only=False).astype(float); ele = t["electricas"].to_numpy(zero_copy_only=False).astype(float)
        anc = t["anclajes_libres"].to_numpy(zero_copy_only=False).astype(float); act = t["activa"].to_numpy(zero_copy_only=False)
        bic = mec + ele
        mismo = np.r_[False, (ids[1:] == ids[:-1]) & (np.diff(s) <= 300)]   # lectura anterior de la misma estación, ≤ 5 min
        dif = np.where(mismo, np.r_[0, np.diff(bic)], 0)
        dentro = s >= s0
        ids, s, mec, ele, anc, act, bic, dif = (a[dentro] for a in (ids, s, mec, ele, anc, act, bic, dif))
        cub = (s // Q) * Q
        clave = np.char.add(np.char.add(ids, "|"), cub.astype(str))
        orden = np.lexsort((s, clave)); ids, s, mec, ele, anc, act, bic, dif, cub, clave = (a[orden] for a in (ids, s, mec, ele, anc, act, bic, dif, cub, clave))
        fin = _ultimos(clave); ini = np.r_[0, fin[:-1] + 1]
        n = fin - ini + 1
        coge = np.add.reduceat(np.maximum(-dif, 0), ini); deja = np.add.reduceat(np.maximum(dif, 0), ini)
        media = np.add.reduceat(bic, ini) / n
        # capacidad: la publicada si la hay; si no (citybik.es no la da), anclajes en servicio = bicis + anclajes libres
        cap = {r["estacion_id"]: r["capacidad"] for r in dims.get("estaciones_bicing", pa.table({"estacion_id": [], "capacidad": []})).to_pylist()}
        capa = np.array([cap.get(i) or np.nan for i in ids[fin]], dtype=float)
        capa = np.where(np.isnan(capa), bic[fin] + anc[fin], capa)
        return pa.table({"estacion_id": ids[fin], "t": pa.array(cub[fin], type=pa.timestamp("s", tz="UTC")), "t_local": _local(cub[fin]),
                         "bicis": bic[fin].astype("int16"), "mecanicas": mec[fin].astype("int16"), "electricas": ele[fin].astype("int16"),
                         "anclajes_libres": anc[fin].astype("int16"), "bicis_media": media.astype("float32"),
                         "cogidas": coge.astype("int16"), "dejadas": deja.astype("int16"), "capacidad": capa.astype("float32"),
                         "ocupacion": np.where(capa > 0, bic[fin] / capa, np.nan).astype("float32"), "activa": act[fin].astype(bool), "lecturas": n.astype("int16")})

    def trafico_15min(self, d: date) -> pa.Table | None:
        s0, s1 = _dia_utc(d)
        t = self.silver("trafico", s0 - 3600, s1 + 3600)
        if t is None or not t.num_rows:
            return None
        fd = t["fecha_dato"]; s = np.where(pc.is_null(fd).to_numpy(zero_copy_only=False), _segundos(t["ts"]), _segundos(pc.fill_null(fd, t["ts"])))
        ids = t["id"].to_numpy(zero_copy_only=False).astype("int32"); est = t["estado"].to_numpy(zero_copy_only=False).astype("int16")
        pre = t["previsto"].to_numpy(zero_copy_only=False).astype("int16")
        ok = (s >= s0) & (s < s1); ids, s, est, pre = ids[ok], s[ok], est[ok], pre[ok]
        if not len(s):
            return None
        cub = (s // Q) * Q
        orden = np.lexsort((s, cub, ids)); ids, s, est, pre, cub = ids[orden], s[orden], est[orden], pre[orden], cub[orden]
        clave = ids.astype("int64") * 10**10 + cub
        fin = _ultimos(clave); ini = np.r_[0, fin[:-1] + 1]
        return pa.table({"tramo_id": ids[fin], "t": pa.array(cub[fin], type=pa.timestamp("s", tz="UTC")), "t_local": _local(cub[fin]),
                         "estado": est[fin], "estado_max": np.maximum.reduceat(est, ini), "previsto": pre[fin],
                         "lecturas": (fin - ini + 1).astype("int16")})

    def tiempo_15min(self, d: date) -> pa.Table | None:
        s0, s1 = _dia_utc(d)
        t = self.silver("tiempo", s0 - 6 * 3600, s1)               # unas horas antes: para rellenar el principio del día
        if t is None or not t.num_rows:
            return None
        t = t.sort_by([("ts", "ascending")]); s = _segundos(t["ts"])
        rejilla = np.arange(s0, s1, Q)
        i = np.searchsorted(s, rejilla + Q - 1, side="right") - 1     # la última lectura hasta el final de cada cuarto de hora
        ok = i >= 0; i = np.where(ok, i, 0)
        cols = {"t": pa.array(rejilla, type=pa.timestamp("s", tz="UTC")), "t_local": _local(rejilla)}
        okp = pa.array(ok)
        for c in ("temperatura", "sensacion", "humedad", "precipitacion_mm", "lluvia_mm", "codigo", "nubes", "viento_kmh", "viento_dir", "es_dia"):
            col = t[c].combine_chunks().take(pa.array(i))
            cols[c] = pc.if_else(okp, col, pa.scalar(None, type=col.type))           # sin lectura previa: vacío
        cols["llueve"] = pc.fill_null(pc.greater(cols["precipitacion_mm"], 0), False)
        cols["edad_dato_min"] = pa.array(np.where(ok, (rejilla + Q - s[i]) / 60, np.nan).astype("float32"))   # cuánto hace de la lectura usada
        return pa.table(cols)

    # ---------- situar incidencias (texto del Ayuntamiento o coordenadas del SCT) y el tramo de tráfico más cercano ----------
    def _geo(self):
        if not hasattr(self, "_seg"):
            sys.path.insert(0, str(ROOT / "pipeline"))
            try:
                from situar import Situador                        # noqa: E402
                self._sit = Situador()
            except Exception as e:  # noqa: BLE001
                self._sit = None; self.c.errores.append(f"situar incidencias: {e}")
            segs = []
            if TRAMOS.exists():
                for tid, _, c in json.loads(TRAMOS.read_text(encoding="utf-8"))["tramos"]:
                    segs += [(int(tid), c[i], c[i + 1], c[i + 2], c[i + 3]) for i in range(0, len(c) - 2, 2)]
            self._seg = np.array(segs, dtype=float).reshape(-1, 5)
        return self._sit

    def tramo_cercano(self, x: float, z: float, maximo: float) -> tuple[int | None, float | None]:
        self._geo()
        s = self._seg
        if not len(s) or x is None:
            return None, None
        ax, az, vx, vz = s[:, 1], s[:, 2], s[:, 3] - s[:, 1], s[:, 4] - s[:, 2]
        l2 = np.maximum(vx * vx + vz * vz, 1e-9)
        u = np.clip(((x - ax) * vx + (z - az) * vz) / l2, 0, 1)
        dd = np.hypot(ax + u * vx - x, az + u * vz - z)
        i = int(np.argmin(dd))
        return (int(s[i, 0]), float(dd[i])) if dd[i] <= maximo else (None, None)

    def incidencias(self, d: date) -> pa.Table | None:
        s0, s1 = _dia_utc(d)
        filas = []
        t = self.silver("incidencias_bcn", s0, s1)
        if t is not None and t.num_rows:
            g = defaultdict(list)
            for r in t.to_pylist():
                g[r["texto"]].append(r)
            for txt, rs in g.items():
                ts = sorted(r["ts"] for r in rs)
                filas.append({"fuente": "Ajuntament", "id": txt[:120], "inicio_visto": ts[0], "fin_visto": ts[-1], "capturas": len(ts),
                              "tipo": rs[0]["causa"], "efecto": rs[0]["efecto"], "via": rs[0]["via"], "sentido": rs[0]["sentido"], "texto": txt,
                              "lat": None, "lon": None, "en_barcelona": True, "corte": rs[0]["efecto"] == "cortado"})
        t = self.silver("incidencias_sct", s0, s1)
        if t is not None and t.num_rows:
            g = defaultdict(list)
            for r in t.to_pylist():
                g[r["id"]].append(r)
            for iid, rs in g.items():
                ts = sorted(r["ts"] for r in rs); r = rs[-1]
                try:
                    desde = datetime.fromisoformat(r["desde"]).astimezone(timezone.utc) if r["desde"] else None
                except ValueError:
                    desde = None
                filas.append({"fuente": "SCT", "id": iid, "inicio_visto": ts[0], "fin_visto": ts[-1], "capturas": len(ts), "tipo": r["tipo"],
                              "efecto": r["subtipo"], "via": r["carretera"], "sentido": r["sentido"], "texto": r["lugar"],
                              "lat": r["lat"], "lon": r["lon"], "en_barcelona": bool(r["bcn"]), "desde": desde,
                              "corte": bool(re.search(r"clos|block|barri", f"{r['tipo']} {r['subtipo']}", re.I))})
        if not filas:
            return None
        # dónde: el Ayuntamiento con el texto (calle + cruce, como el visor); el SCT con sus coordenadas
        sit = self._geo()
        from geo import a_local                                    # noqa: E402
        for f in filas:
            f["x"] = f["z"] = f["tramo_id"] = f["situada"] = None
            if f["fuente"] == "Ajuntament" and sit is not None:
                r = sit.situar(f["texto"])
                if r:
                    f["x"], f["z"], f["situada"] = r["x"], r["z"], r["como"]
                    f["tramo_id"] = r["tramo_trafico"] if r["tramo_trafico"] is not None and r["tramo_trafico"] >= 0 else self.tramo_cercano(r["x"], r["z"], 60)[0]
            elif f["fuente"] == "SCT" and f["lat"] is not None and f["en_barcelona"]:
                f["x"], f["z"] = a_local(f["lon"], f["lat"]); f["situada"] = "coordenadas"
                f["tramo_id"] = self.tramo_cercano(f["x"], f["z"], 100)[0]
        # desde cuándo existe: lo que diga el SCT o la primera vez que se vio (se arrastra del día anterior)
        antes = self._gold("incidencias", d - timedelta(days=1))
        prev = {}
        if antes is not None and "primera_vez" in antes.column_names:
            prev = {(a, b): c for a, b, c in zip(antes["fuente"].to_pylist(), antes["id"].to_pylist(), antes["primera_vez"].to_pylist())}
        for f in filas:
            f["primera_vez"] = min(x for x in (f["inicio_visto"], prev.get((f["fuente"], f["id"])), f.get("desde")) if x is not None)
        return pa.Table.from_pylist(filas, schema=pa.schema([("fuente", pa.string()), ("id", pa.string()), ("inicio_visto", TS), ("fin_visto", TS),
            ("capturas", pa.int32()), ("primera_vez", TS), ("tipo", pa.string()), ("efecto", pa.string()), ("corte", pa.bool_()), ("via", pa.string()),
            ("sentido", pa.string()), ("texto", pa.string()), ("lat", pa.float32()), ("lon", pa.float32()), ("en_barcelona", pa.bool_()),
            ("x", pa.float32()), ("z", pa.float32()), ("tramo_id", pa.int32()), ("situada", pa.string())]))

    def _inc_dia(self, d: date) -> dict | None:
        """Incidencias situadas del día d (Barcelona y alrededores), listas para medir distancias."""
        t = self._gold("incidencias", d)
        if t is None or "x" not in t.column_names:
            return None
        rs = [r for r in t.to_pylist() if r["x"] is not None and r["en_barcelona"]]
        if not rs:
            return None
        seg = lambda c: np.array([r[c].timestamp() for r in rs], dtype=float)   # noqa: E731
        return {"x": np.array([r["x"] for r in rs], dtype=float), "z": np.array([r["z"] for r in rs], dtype=float),
                "ini": seg("inicio_visto") - 300, "fin": seg("fin_visto") + 300, "prim": seg("primera_vez"),       # capturas cada 5 min: ±5 min
                "corte": np.array([bool(r["corte"]) for r in rs]), "tramo": np.array([r["tramo_id"] if r["tramo_id"] is not None else -1 for r in rs]),
                "tipo": [r["tipo"] for r in rs]}

    @staticmethod
    def rasgos_inc(inc: dict | None, xs: np.ndarray, zs: np.ndarray, s: np.ndarray, tramos: np.ndarray | None = None) -> dict:
        """Para cada fila (sitio xs,zs y cuarto de hora s): incidencias activas cerca y, si es un tramo, en el propio tramo."""
        n = len(s)
        cols = {"inc_dist_m": np.full(n, np.nan, dtype="float32"), "inc_300m": np.zeros(n, "int8"), "inc_1km": np.zeros(n, "int8"),
                "inc_cortes_1km": np.zeros(n, "int8"), "inc_tipo_cercana": [None] * n, "inc_horas_cercana": np.full(n, np.nan, dtype="float32")}
        if tramos is not None:
            cols["inc_en_tramo"] = np.zeros(n, bool); cols["inc_corte_en_tramo"] = np.zeros(n, bool)
        if inc is not None and n:
            act = (inc["ini"][None, :] <= s[:, None] + Q) & (inc["fin"][None, :] >= s[:, None])
            D = np.hypot(xs[:, None] - inc["x"][None, :], zs[:, None] - inc["z"][None, :])
            D = np.where(act & ~np.isnan(D), D, np.inf)
            j = np.argmin(D, axis=1); dmin = D[np.arange(n), j]
            cerca = dmin <= 1000
            cols["inc_dist_m"] = np.where(dmin <= 5000, dmin, np.nan).astype("float32")
            cols["inc_300m"] = np.minimum((D <= 300).sum(1), 127).astype("int8")
            cols["inc_1km"] = np.minimum((D <= 1000).sum(1), 127).astype("int8")
            cols["inc_cortes_1km"] = np.minimum(((D <= 1000) & inc["corte"][None, :]).sum(1), 127).astype("int8")
            cols["inc_tipo_cercana"] = [inc["tipo"][k] if c else None for k, c in zip(j, cerca)]
            cols["inc_horas_cercana"] = np.where(cerca, (s - inc["prim"][j]) / 3600, np.nan).astype("float32")
            if tramos is not None:
                en = act & (inc["tramo"][None, :] == tramos[:, None])
                cols["inc_en_tramo"] = en.any(1); cols["inc_corte_en_tramo"] = (en & inc["corte"][None, :]).any(1)
        return {k: pa.array(v, type=pa.string()) if k == "inc_tipo_cercana" else pa.array(v) for k, v in cols.items()}

    # ---------- autobuses: retraso real (previsión iBus) frente al horario GTFS ----------
    def horario_bus(self) -> dict | None:
        if self._buses is None:
            self._buses = json.loads(BUSES.read_text(encoding="utf-8")) if BUSES.exists() else {}
        return self._buses or None

    def programadas(self, d: date, paradas: set[str]) -> dict:
        """(línea, parada, sentido) -> horas programadas del día d en segundos desde su medianoche (hora de Barcelona).
        Incluye los viajes del día anterior que pasan de medianoche. Sentido como en iBus (1 ida, 2 vuelta)."""
        hb = self.horario_bus()
        hoy, ayer = d.strftime("%Y%m%d"), (d - timedelta(days=1)).strftime("%Y%m%d")
        act = [(hoy in s, ayer in s) for s in map(set, hb["servicios"])]
        pos = [[(k, _cod_parada(sid)) for k, sid in enumerate(p[6]) if _cod_parada(sid) in paradas] for p in hb["patrones"]]
        prog = defaultdict(list)
        for pi, salida, dur, sv in hb["viajes"]:
            a_hoy, a_ayer = act[sv]
            if not pos[pi] or not (a_hoy or a_ayer):
                continue
            pat = hb["patrones"][pi]
            linea = hb["lineas"][pat[0]][0]
            for k, cod in pos[pi]:
                h = salida + pat[5][k] * dur
                for activo, desfase in ((a_hoy, 0), (a_ayer, -86400)):
                    if activo:
                        prog[(linea, cod, pat[2] + 1)].append(h + desfase)
        return {k: np.sort(np.array(v, dtype=float)) for k, v in prog.items()}

    def bus_llegadas(self, d: date) -> pa.Table | None:
        """Una fila por paso de bus visto por iBus (todas sus previsiones juntas), con su hora programada y su retraso."""
        s0, s1 = _dia_utc(d)
        t = self.silver("bus", s0 - 3600, s1)
        if t is None or not t.num_rows or not self.horario_bus():
            return None
        filas = [r for r in t.to_pylist() if r["llegada"] and s0 <= r["llegada"].timestamp() < s1]
        if not filas:
            return None
        prog = self.programadas(d, {r["parada"] for r in filas})
        # en cada captura iBus da los 2-3 próximos buses: la distancia entre uno y el anterior es el intervalo real previsto
        previo = {(r["ts"], r["parada"], r["linea"], r["sentido"], r["orden"]): r["llegada"].timestamp() for r in filas}
        # previsiones del mismo bus en la misma parada -> un paso (sin id de bus: llegadas a menos de 8 min, nunca dos de la misma captura)
        grupos = defaultdict(list)
        for r in filas:
            grupos[(r["parada"], r["linea"], r["sentido"], r["id_bus"])].append(r)
        pasos = []
        for rs in grupos.values():
            rs.sort(key=lambda r: r["llegada"])
            actual = [rs[0]]
            for r in rs[1:]:
                if (r["llegada"] - actual[-1]["llegada"]).total_seconds() > 480 or any(x["ts"] == r["ts"] for x in actual):
                    pasos.append(actual); actual = [r]
                else:
                    actual.append(r)
            pasos.append(actual)
        m0 = datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()      # medianoche «de reloj» del día
        offs: dict[int, int] = {}

        def reloj(s: float) -> float:                                                # segundos UTC -> segundos desde la medianoche local
            h = int(s) // 3600
            if h not in offs:
                offs[h] = int(datetime.fromtimestamp(h * 3600, MADRID).utcoffset().total_seconds())
            return s + offs[h] - m0
        out = []
        for p in pasos:
            p.sort(key=lambda r: r["ts"])
            ult, pri = p[-1], p[0]
            lleg = ult["llegada"].timestamp()
            lst = next((prog[k] for k in ((c, ult["parada"], ult["sentido"]) for c in (ult["linea"], ult["codi_linia"])) if k in prog), None)
            retraso = intervalo = prog_s = None
            if lst is not None and len(lst):
                x = reloj(lleg)
                i = int(np.searchsorted(lst, x))
                j = min((k for k in (i - 1, i) if 0 <= k < len(lst)), key=lambda k: abs(lst[k] - x))
                if abs(x - lst[j]) <= 20 * 60:
                    retraso = int(round(x - lst[j])); prog_s = lleg - retraso
                    vecinos = [abs(lst[k] - lst[j]) for k in (j - 1, j + 1) if 0 <= k < len(lst)]
                    intervalo = int(round(min(vecinos))) if vecinos else None
            ant = previo.get((ult["ts"], ult["parada"], ult["linea"], ult["sentido"], ult["orden"] - 1)) if ult["orden"] else None
            out.append({"intervalo_previsto_s": None if ant is None else int(lleg - ant),
                        "retraso_claro": None if retraso is None else bool(intervalo is None or abs(retraso) <= intervalo / 4),"parada": ult["parada"], "linea": ult["linea"], "sentido": ult["sentido"], "destino": ult["destino"], "id_bus": ult["id_bus"],
                        "s": lleg, "llegada": ult["llegada"], "programada": prog_s, "retraso_s": retraso, "intervalo_prog_s": intervalo,
                        "previsiones": len(p), "anticipacion_s": int(lleg - ult["ts"].timestamp()),
                        "anticipacion_primera_s": int(pri["llegada"].timestamp() - pri["ts"].timestamp()),
                        "cambio_prevision_s": int(lleg - pri["llegada"].timestamp())})
        out.sort(key=lambda r: (r["s"], r["linea"], r["parada"]))
        s = np.array([r["s"] for r in out], dtype="int64")
        cub = (s // Q) * Q
        cols = {"t": pa.array(cub, type=TS), "t_local": _local(cub)}
        for c, tipo in (("parada", pa.string()), ("linea", pa.string()), ("sentido", pa.int8()), ("destino", pa.string()), ("id_bus", pa.int32())):
            cols[c] = pa.array([r[c] for r in out], type=tipo)
        cols["llegada"] = pa.array([r["llegada"] for r in out], type=TS); cols["llegada_local"] = _local(s)
        cols["programada"] = pa.array([None if r["programada"] is None else int(r["programada"]) for r in out], type=pa.int64()).cast(TS)
        for c, tipo in (("retraso_s", pa.int32()), ("retraso_claro", pa.bool_()), ("intervalo_prog_s", pa.int32()), ("intervalo_previsto_s", pa.int32()),
                        ("previsiones", pa.int16()), ("anticipacion_s", pa.int32()),
                        ("anticipacion_primera_s", pa.int32()), ("cambio_prevision_s", pa.int32())):
            cols[c] = pa.array([r[c] for r in out], type=tipo)
        return pa.table(cols)

    @staticmethod
    def bus_retrasos_15min(llegadas: pa.Table) -> pa.Table | None:
        """Retraso por línea, sentido y cuarto de hora (solo previsiones hechas a 15 min o menos de la llegada: las más fiables)."""
        g = defaultdict(list)
        for r in llegadas.select(["t", "t_local", "linea", "sentido", "parada", "retraso_s", "retraso_claro", "intervalo_prog_s",
                                  "intervalo_previsto_s", "anticipacion_s"]).to_pylist():
            if r["retraso_s"] is not None and r["anticipacion_s"] <= 900:
                g[(r["linea"], r["sentido"], r["t"])].append(r)
        if not g:
            return None
        filas = []
        for (linea, sentido, t), rs in sorted(g.items(), key=lambda kv: (kv[0][2], kv[0][0], kv[0][1] or 0)):
            v = np.array([r["retraso_s"] for r in rs], dtype=float)
            med = lambda c: (lambda x: int(np.median(x)) if x else None)([r[c] for r in rs if r[c] is not None])   # noqa: E731
            filas.append({"linea": linea, "sentido": sentido, "t": t, "t_local": rs[0]["t_local"], "pasos": len(v),
                          "paradas": len({r["parada"] for r in rs}), "retraso_mediana_s": int(np.median(v)), "retraso_medio_s": float(v.mean()),
                          "retraso_p90_s": int(np.percentile(v, 90)), "retraso_max_s": int(v.max()),
                          "retrasados": int((v > 180).sum()), "adelantados": int((v < -60).sum()),
                          "claros": sum(bool(r["retraso_claro"]) for r in rs), "intervalo_prog_s": med("intervalo_prog_s"),
                          "intervalo_previsto_s": med("intervalo_previsto_s")})
        return pa.Table.from_pylist(filas, schema=pa.schema([("linea", pa.string()), ("sentido", pa.int8()), ("t", TS), ("t_local", T_LOCAL),
            ("pasos", pa.int16()), ("paradas", pa.int16()), ("retraso_mediana_s", pa.int32()), ("retraso_medio_s", pa.float32()),
            ("retraso_p90_s", pa.int32()), ("retraso_max_s", pa.int32()), ("retrasados", pa.int16()), ("adelantados", pa.int16()),
            ("claros", pa.int16()), ("intervalo_prog_s", pa.int32()), ("intervalo_previsto_s", pa.int32())]))

    # ---------- tablas de entrenamiento (hace falta el día siguiente para el objetivo a +30 min) ----------
    def _gold(self, tabla: str, d: date) -> pa.Table | None:
        k = self._dia(tabla, d)
        if self.alm.tamano(k) is None:
            return None
        ruta = self.tmp / f"l_{tabla}_{d}.parquet"
        if not ruta.exists():
            self.alm.bajar(k, ruta)
        return pq.read_table(ruta)

    def entreno(self, d: date, tabla: str, clave: str, valor: str, extra: list[str], dims: dict) -> pa.Table | None:
        partes = [x for x in (self._gold(tabla, d - timedelta(days=1)), self._gold(tabla, d), self._gold(tabla, d + timedelta(days=1))) if x is not None]
        hoy = self._gold(tabla, d)
        if hoy is None or self._gold(tabla, d + timedelta(days=1)) is None:
            return None                                             # aún no se conoce el futuro de las últimas horas del día
        t = pa.concat_tables(partes)
        k = t[clave].to_numpy(zero_copy_only=False).astype(str); s = _segundos(t["t"]); v = t[valor].to_numpy(zero_copy_only=False).astype(float)
        mapa = dict(zip(np.char.add(np.char.add(k, "|"), s.astype(str)), v))
        k0 = hoy[clave].to_numpy(zero_copy_only=False).astype(str); s0_ = _segundos(hoy["t"])
        busca = lambda dt: np.array([mapa.get(f"{a}|{b + dt}", np.nan) for a, b in zip(k0, s0_)], dtype="float32")   # noqa: E731
        cols = {c: hoy[c] for c in [clave, "t", "t_local", valor] + extra}
        for m in (15, 30, 60):
            cols[f"{valor}_hace_{m}min"] = busca(-m * 60)
        cols[f"objetivo_{valor}_30min"] = busca(30 * 60)
        loc = hoy["t_local"].to_pylist()
        cols["hora"] = pa.array([x.hour + x.minute / 60 for x in loc], type=pa.float32())
        cal = {r["fecha"]: r for r in dims["calendario"].to_pylist()} if "calendario" in dims else {}
        cols["dia_semana"] = pa.array([x.isoweekday() for x in loc], type=pa.int8())
        cols["laborable"] = pa.array([bool(cal.get(x.date(), {}).get("laborable", x.isoweekday() < 6)) for x in loc])
        cols["festivo"] = pa.array([bool(cal.get(x.date(), {}).get("festivo", False)) for x in loc])
        tiempo = self._gold("tiempo_15min", d)
        if tiempo is not None:
            tm = {int(a): (b, c, e) for a, b, c, e in zip(_segundos(tiempo["t"]), tiempo["temperatura"].to_pylist(), tiempo["precipitacion_mm"].to_pylist(), tiempo["codigo"].to_pylist())}
            w = [tm.get(int(x), (None, None, None)) for x in s0_]
            cols["temperatura"] = pa.array([a for a, _, _ in w], type=pa.float32()); cols["precipitacion_mm"] = pa.array([b for _, b, _ in w], type=pa.float32())
            cols["codigo_tiempo"] = pa.array([c for _, _, c in w], type=pa.int16())
        # incidencias activas en ese cuarto de hora: en el propio tramo (tráfico) y cerca (distancia, número, cortes, tipo, antigüedad)
        ref = {"trafico_15min": ("tramos_trafico", "tramo_id"), "bicing_15min": ("estaciones_bicing", "estacion_id")}.get(tabla)
        if ref and ref[0] in dims:
            pos = {str(a): (x, z) for a, x, z in zip(dims[ref[0]][ref[1]].to_pylist(), dims[ref[0]]["x"].to_pylist(), dims[ref[0]]["z"].to_pylist())}
            xz = np.array([pos.get(a, (None, None)) for a in k0], dtype=float).reshape(-1, 2)
            tramos = k0.astype("int64") if tabla == "trafico_15min" else None
            cols.update(self.rasgos_inc(self._inc_dia(d), xz[:, 0], xz[:, 1], s0_.astype(float), tramos))
        conocido = ~np.isnan(cols[f"objetivo_{valor}_30min"])                    # filas cuyo futuro a +30 min se conoce
        return pa.table(cols).filter(pa.array(conocido))

    def entreno_bus(self, d: date, dims: dict) -> pa.Table | None:
        """Tabla de entrenamiento: retraso de un bus en una parada, con lo que se sabía en el momento de la previsión
        (cuando iBus lo anunció): retrasos recientes de su línea, tráfico de alrededor, incidencias, hora, calendario y tiempo."""
        hoy = self._gold("bus_llegadas", d)
        if hoy is None or not hoy.num_rows:
            return None
        partes = [x for x in (self._gold("bus_llegadas", d - timedelta(days=1)), hoy) if x is not None]
        cols_h = ["linea", "sentido", "llegada", "retraso_s", "anticipacion_s"]
        todo = pa.concat_tables([x.select(cols_h) for x in partes])
        # historial de cada línea y sentido (solo previsiones a 0–15 min de la llegada: las fiables)
        hist = defaultdict(lambda: ([], []))
        for l, se, ll, r, a in zip(*(todo[c].to_pylist() for c in cols_h)):
            if r is not None and a is not None and 0 <= a <= 900:
                hist[(l, se)][0].append(ll.timestamp()); hist[(l, se)][1].append(r)
        hist = {k: (np.array(v[0]), np.array(v[1], dtype=float)) for k, v in hist.items()}
        for k, (a, b) in hist.items():
            o = np.argsort(a); hist[k] = (a[o], b[o])
        rs = [r for r in hoy.to_pylist() if r["retraso_s"] is not None and 0 <= r["anticipacion_s"] <= 900]
        if not rs:
            return None
        n = len(rs)
        cap = np.array([r["llegada"].timestamp() - r["anticipacion_s"] for r in rs])          # cuándo se hizo la previsión
        med = np.full(n, np.nan, "float32"); cnt = np.zeros(n, "int16"); ult = np.full(n, np.nan, "float32"); hace = np.full(n, np.nan, "float32")
        for i, r in enumerate(rs):
            h = hist.get((r["linea"], r["sentido"]))
            if h is None:
                continue
            a, b = np.searchsorted(h[0], cap[i] - 3600), np.searchsorted(h[0], cap[i])        # pasos ya ocurridos en la última hora
            if b > a:
                med[i] = np.median(h[1][a:b]); cnt[i] = b - a; ult[i] = h[1][b - 1]; hace[i] = (cap[i] - h[0][b - 1]) / 60
        # tráfico alrededor de la parada en el último cuarto de hora ya cerrado
        q = (cap // Q) * Q - Q
        traf = self._gold("trafico_15min", d)
        est = {}
        if traf is not None:
            est = {(int(a), int(b)): int(c) for a, b, c in zip(traf["tramo_id"].to_numpy(), _segundos(traf["t"]), traf["estado"].to_numpy())}
        pos = {}
        if "paradas_bus" in dims:
            pos = {a: (x, z) for a, x, z in zip(*(dims["paradas_bus"][c].to_pylist() for c in ("parada", "x", "z")))}
        tt = dims.get("tramos_trafico")
        tx = np.array(tt["x"].to_pylist(), dtype=float) if tt is not None else np.zeros(0)
        tz = np.array(tt["z"].to_pylist(), dtype=float) if tt is not None else np.zeros(0)
        tid = np.array(tt["tramo_id"].to_pylist()) if tt is not None else np.zeros(0)
        cerca: dict[str, tuple] = {}
        for p in {r["parada"] for r in rs}:
            x, z = pos.get(p, (None, None))
            if x is None:
                cerca[p] = (None, []); continue
            cerca[p] = (self.tramo_cercano(x, z, 150)[0], list(tid[np.hypot(tx - x, tz - z) <= 500]) if len(tx) else [])
        e_cerca = np.full(n, np.nan, "float32"); e_500 = np.full(n, np.nan, "float32")
        for i, r in enumerate(rs):
            t1, zona = cerca[r["parada"]]
            v = est.get((t1, int(q[i]))) if t1 is not None else None
            if v:                                                   # 0 = sin datos
                e_cerca[i] = v
            vs = [est.get((int(t), int(q[i]))) for t in zona]
            vs = [x for x in vs if x]
            if vs:
                e_500[i] = float(np.mean(vs))
        cols = {c: hoy.schema.field(c).type for c in ("linea", "sentido", "parada", "id_bus", "t", "t_local", "llegada_local", "programada",
                                                      "anticipacion_s", "intervalo_prog_s", "retraso_claro")}
        cols = {c: pa.array([r[c] for r in rs], type=tp) for c, tp in cols.items()}
        cols.update({"retraso_linea_60min_s": pa.array(med), "pasos_linea_60min": pa.array(cnt), "retraso_ultimo_linea_s": pa.array(ult),
                     "min_desde_ultimo_linea": pa.array(hace), "trafico_estado_cerca": pa.array(e_cerca), "trafico_medio_500m": pa.array(e_500)})
        loc = [datetime.fromtimestamp(x, MADRID) for x in cap]
        cal = {r["fecha"]: r for r in dims["calendario"].to_pylist()} if "calendario" in dims else {}
        cols["hora"] = pa.array([x.hour + x.minute / 60 for x in loc], type=pa.float32())
        cols["dia_semana"] = pa.array([x.isoweekday() for x in loc], type=pa.int8())
        cols["laborable"] = pa.array([bool(cal.get(x.date(), {}).get("laborable", x.isoweekday() < 6)) for x in loc])
        cols["festivo"] = pa.array([bool(cal.get(x.date(), {}).get("festivo", False)) for x in loc])
        tiempo = self._gold("tiempo_15min", d)
        if tiempo is not None:
            tm = {int(a): (b, c, e) for a, b, c, e in zip(_segundos(tiempo["t"]), tiempo["temperatura"].to_pylist(), tiempo["precipitacion_mm"].to_pylist(), tiempo["codigo"].to_pylist())}
            w = [tm.get(int(x), (None, None, None)) for x in q]
            cols["temperatura"] = pa.array([a for a, _, _ in w], type=pa.float32()); cols["precipitacion_mm"] = pa.array([b for _, b, _ in w], type=pa.float32())
            cols["codigo_tiempo"] = pa.array([c for _, _, c in w], type=pa.int16())
        xz = np.array([pos.get(r["parada"], (None, None)) for r in rs], dtype=float).reshape(-1, 2)
        cols.update(self.rasgos_inc(self._inc_dia(d), xz[:, 0], xz[:, 1], q))
        cols["objetivo_retraso_s"] = pa.array([r["retraso_s"] for r in rs], type=pa.int32())
        return pa.table(cols)

    # ---------- parte de calidad de un día ----------
    def calidad(self, d: date) -> list[dict]:
        s0, s1 = _dia_utc(d)
        horas = (s1 - s0) / 86400
        filas = []
        for fuente in FUENTES:
            t = self.silver(fuente, s0, s1)
            caps = np.unique(_segundos(t["ts"])) if t is not None and t.num_rows else np.array([], dtype="int64")
            bordes = np.r_[s0, caps, s1]
            hueco = float(np.max(np.diff(bordes)) / 60) if len(bordes) > 1 else 1440.0
            esp = ESPERADAS.get(fuente, 0) * horas
            cob = min(1.0, len(caps) / esp) if esp else None
            filas.append({"fecha": d, "fuente": fuente, "capturas": int(len(caps)), "esperadas": int(round(esp)), "cobertura": cob,
                          "mayor_hueco_min": round(hueco, 1), "filas": int(t.num_rows) if t is not None else 0,
                          "alerta": bool(cob is not None and (cob < 0.9 or hueco > max(60, 3 * 1440 / ESPERADAS[fuente]))))})   # hueco: > 3 periodos de la fuente
        return filas

    # ---------- todo junto ----------
    def correr(self) -> None:
        dims = self.dimensiones()
        dias = self.dias_pendientes()
        if not dias:
            log("gold: nada nuevo"); return
        cal_nuevas = []
        for d in dias:
            for nom, f in (("bicing_15min", lambda: self.bicing_15min(d, dims)), ("trafico_15min", lambda: self.trafico_15min(d)),
                           ("tiempo_15min", lambda: self.tiempo_15min(d)), ("incidencias", lambda: self.incidencias(d))):
                try:
                    t = f()
                    if t is not None:
                        self._subir(t, self._dia(nom, d))
                        self.hecho.append(f"gold {nom} {d}: {t.num_rows:,} filas"); log(self.hecho[-1])
                except Exception as e:  # noqa: BLE001
                    self.c.errores.append(f"gold {nom} {d}: {e}"); log("ERROR gold", nom, d, e)
            try:                                                    # autobuses: pasos con su retraso y, de ahí, la tabla por línea
                lleg = self.bus_llegadas(d)
                if lleg is not None and lleg.num_rows:
                    for nom, t in (("bus_llegadas", lleg), ("bus_retrasos_15min", self.bus_retrasos_15min(lleg))):
                        if t is not None:
                            self._subir(t, self._dia(nom, d))
                            self.hecho.append(f"gold {nom} {d}: {t.num_rows:,} filas"); log(self.hecho[-1])
            except Exception as e:  # noqa: BLE001
                self.c.errores.append(f"gold bus {d}: {e}"); log("ERROR gold bus", d, e)
            try:
                cal_nuevas += self.calidad(d)
            except Exception as e:  # noqa: BLE001
                self.c.errores.append(f"calidad {d}: {e}")
        # entrenamiento: el día anterior a cada día rehecho (ya se conoce su futuro a +30 min)
        for d in sorted({x - timedelta(days=1) for x in dias} | set(dias)):
            for nom, args in (("entreno_bicing", ("bicing_15min", "estacion_id", "bicis", ["capacidad", "ocupacion", "cogidas", "dejadas"])),
                              ("entreno_trafico", ("trafico_15min", "tramo_id", "estado", ["previsto"]))):
                try:
                    t = self.entreno(d, *args, dims)
                    if t is not None and t.num_rows:
                        self._subir(t, self._dia(nom, d))
                        self.hecho.append(f"gold {nom} {d}: {t.num_rows:,} filas"); log(self.hecho[-1])
                except Exception as e:  # noqa: BLE001
                    self.c.errores.append(f"gold {nom} {d}: {e}"); log("ERROR gold", nom, d, e)
            try:                                                    # el de bus no necesita el día siguiente (el objetivo es el propio paso)
                t = self.entreno_bus(d, dims)
                if t is not None and t.num_rows:
                    self._subir(t, self._dia("entreno_bus", d))
                    self.hecho.append(f"gold entreno_bus {d}: {t.num_rows:,} filas"); log(self.hecho[-1])
            except Exception as e:  # noqa: BLE001
                self.c.errores.append(f"gold entreno_bus {d}: {e}"); log("ERROR gold entreno_bus", d, e)
        self.guardar_calidad(cal_nuevas)
        self.catalogo(dims)

    def guardar_calidad(self, nuevas: list[dict]) -> None:
        if not nuevas:
            return
        clave = self.cat + "calidad.parquet"
        viejas = []
        if self.alm.tamano(clave) is not None:
            r = self.tmp / "calidad_prev.parquet"; self.alm.bajar(clave, r); viejas = pq.read_table(r).to_pylist()
        hechos = {(x["fecha"], x["fuente"]) for x in nuevas}
        todo = [x for x in viejas if (x["fecha"], x["fuente"]) not in hechos] + nuevas
        todo.sort(key=lambda x: (x["fecha"], x["fuente"]))
        self._subir(pa.Table.from_pylist(todo), clave)
        for d in sorted({x["fecha"] for x in nuevas}):
            rj = self.tmp / "calidad.json"
            rj.write_text(json.dumps([{**x, "fecha": x["fecha"].isoformat()} for x in nuevas if x["fecha"] == d], ensure_ascii=False, indent=1), encoding="utf-8")
            self.alm.subir(rj, f"{self.cat}calidad/fecha={d.isoformat()}.json", "application/json")
        for x in nuevas:
            if x["alerta"]:
                aviso = f"AVISO calidad {x['fecha']} {x['fuente']}: {x['capturas']}/{x['esperadas']} capturas, mayor hueco {x['mayor_hueco_min']} min"
                self.hecho.append(aviso); log(aviso)

    # ---------- catálogo ----------
    def catalogo(self, dims: dict) -> None:
        disponibles = defaultdict(lambda: {"dias": 0, "bytes": 0, "desde": None, "hasta": None})
        for k, tam in self.alm.listar(self.base).items():
            m = re.match(re.escape(self.base) + r"([^/]+)/(?:fecha=(\d{4}-\d{2}-\d{2})/)?", k)
            if not m:
                continue
            x = disponibles[m.group(1) if m.group(2) else "dim/" + k.rsplit("/", 1)[1][:-8]]
            x["bytes"] += tam
            if m.group(2):
                x["dias"] += 1; x["desde"] = min(x["desde"] or m.group(2), m.group(2)); x["hasta"] = max(x["hasta"] or m.group(2), m.group(2))
        tablas = {}
        for nom, info in CATALOGO.items():
            tablas[nom] = {**info, "ruta": f"s3://{BUCKET}/{self.base}{nom}/" + ("" if nom.startswith("dim/") else "fecha=AAAA-MM-DD/parte.parquet"),
                           "disponible": disponibles.get(nom)}
        doc = {"actualizado": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "zona_horaria": "t en UTC; t_local en hora de Barcelona",
               "rejilla": "15 minutos (t = inicio del cuarto de hora)", "capas": CAPAS, "tablas": tablas}
        rj = self.tmp / "tablas.json"
        rj.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
        self.alm.subir(rj, self.cat + "tablas.json", "application/json")
        md = [f"# Datos de Lumiose Planner (bucket R2 `{BUCKET}`)", "", "Generado cada noche por `pipeline/compactar_nube.py`. No editar a mano.", ""]
        for capa, txt in CAPAS.items():
            md.append(f"- **{capa}**: {txt}")
        md += ["", "## Cómo leerlo (DuckDB)", "```sql", "INSTALL httpfs; LOAD httpfs;",
               "CREATE SECRET r2 (TYPE r2, KEY_ID '…', SECRET '…', ACCOUNT_ID '" + CUENTA + "');",
               f"SELECT * FROM read_parquet('r2://{BUCKET}/{self.base}entreno_bicing/*/*.parquet', hive_partitioning = true) LIMIT 10;", "```", ""]
        for nom, t in tablas.items():
            dsp = t.get("disponible") or {}
            md += [f"## {nom}", t["descripcion"], "", f"- Fuente: {t['fuente']}", f"- Clave: {t.get('clave', '—')}",
                   f"- Disponible: {dsp.get('dias', 0)} días ({dsp.get('desde')} → {dsp.get('hasta')})" if dsp.get("dias") else "- Se rehace cada noche",
                   "", "| columna | qué es |", "|---|---|"] + [f"| `{c}` | {d} |" for c, d in t["columnas"].items()] + [""]
        rm = self.tmp / "LEEME.md"
        rm.write_text("\n".join(md), encoding="utf-8")
        self.alm.subir(rm, self.cat + "LEEME.md", "text/markdown")
        self.hecho.append(f"catálogo: {len(tablas)} tablas"); log(self.hecho[-1])


CAPAS = {"bronze/": "cada captura tal cual llega del Worker (se vacía cada noche al pasar a silver)",
         "silver/": "una tabla por fuente y periodo (día → semana → mes → año → década) + las respuestas originales comprimidas",
         "gold/": "tablas listas para análisis e IA: rejilla de 15 min, referencias y tablas de entrenamiento (se pueden rehacer desde silver)",
         "catalogo/": "este catálogo y el parte de calidad diario"}
_T = {"t": "inicio del cuarto de hora (UTC)", "t_local": "inicio del cuarto de hora en hora de Barcelona"}
CATALOGO = {
    "bicing_15min": {"descripcion": "Estado de cada estación de Bicing cada 15 minutos (de lecturas cada minuto).", "fuente": "Bicing (GBFS vía citybik.es)",
                     "clave": "estacion_id + t", "columnas": {"estacion_id": "id de la estación", **_T, "bicis": "bicis disponibles al final del cuarto de hora",
                     "mecanicas": "de ellas, mecánicas", "electricas": "de ellas, eléctricas", "anclajes_libres": "anclajes libres al final",
                     "bicis_media": "media de bicis en el cuarto de hora", "cogidas": "bicis que salieron (bajadas del contador; incluye camiones de reparto)",
                     "dejadas": "bicis que llegaron (subidas del contador)", "capacidad": "anclajes en servicio (bicis + anclajes libres; el feed no publica la capacidad)", "ocupacion": "bicis / capacidad",
                     "activa": "la estación funcionaba", "lecturas": "lecturas usadas (15 = todas)"}},
    "trafico_15min": {"descripcion": "Estado del tráfico por tramo municipal cada 15 minutos.", "fuente": "Open Data BCN (estat del trànsit), CC BY 4.0",
                      "clave": "tramo_id + t", "columnas": {"tramo_id": "tramo municipal (ver dim/tramos_trafico)", **_T,
                      "estado": "0 sin datos · 1 muy fluido · 2 fluido · 3 denso · 4 muy denso · 5 congestión · 6 cortado", "estado_max": "peor estado en el cuarto de hora",
                      "previsto": "estado previsto por el Ayuntamiento a 15 min", "lecturas": "lecturas usadas"}},
    "tiempo_15min": {"descripcion": "Tiempo en Barcelona cada 15 minutos (siempre 96 filas al día; se usa la última lectura).", "fuente": "Open-Meteo",
                     "clave": "t", "columnas": {**_T, "temperatura": "°C", "sensacion": "°C", "humedad": "%", "precipitacion_mm": "mm", "lluvia_mm": "mm",
                     "codigo": "código WMO", "nubes": "%", "viento_kmh": "km/h", "viento_dir": "grados (de dónde viene)", "es_dia": "hay luz de día",
                     "llueve": "precipitación > 0", "edad_dato_min": "minutos desde la lectura usada"}},
    "incidencias": {"descripcion": "Incidencias de tráfico vistas cada día (una fila por incidencia y día).", "fuente": "Ajuntament (avisos, CC BY 4.0) y Servei Català de Trànsit (DATEX II)",
                    "clave": "fuente + id + día", "columnas": {"fuente": "Ajuntament o SCT", "id": "texto (Ajuntament) o id DATEX (SCT)", "inicio_visto": "primera captura (UTC)",
                    "fin_visto": "última captura (UTC)", "capturas": "veces vista", "tipo": "causa (obras, accidente, manifestación…) o tipo DATEX", "efecto": "cortado/restricciones o subtipo DATEX",
                    "via": "calle o carretera", "sentido": "sentido", "texto": "texto original o municipio", "lat": "latitud (SCT)", "lon": "longitud (SCT)", "en_barcelona": "dentro de Barcelona y alrededores",
                    "primera_vez": "desde cuándo existe (inicio del SCT o primera captura, arrastrada de días anteriores)", "corte": "corta la circulación",
                    "x": "metros este (coordenadas del visor)", "z": "metros sur", "tramo_id": "tramo de tráfico afectado (ver dim/tramos_trafico)",
                    "situada": "cómo se situó: cruce, entre dos cruces, solo la calle (texto del Ayuntamiento, como el visor) o coordenadas (SCT); vacío = no se sabe dónde"}},
    "bus_llegadas": {"descripcion": "Cada paso de autobús visto por iBus en las paradas de control (unas 470, cada una consultada cada ~40 min), "
                                    "con su hora programada y su retraso. El retraso es frente a la hora programada más cercana de esa línea en esa parada: "
                                    "en líneas muy frecuentes (TMB las regula por intervalo, no por horario) solo se puede medir hasta medio intervalo; mira `retraso_claro`.",
                     "fuente": "TMB iBus (previsión de llegada) + horario GTFS de TMB y AMB (data/gold/barcelona/vivo/buses.json del día de la compactación)",
                     "clave": "parada + linea + sentido + llegada",
                     "columnas": {**_T, "parada": "código de parada TMB (ver dim/paradas_bus)", "linea": "línea (V15, H6, 24…)", "sentido": "1 ida · 2 vuelta (iBus)",
                                  "destino": "destino del trayecto", "id_bus": "número del bus (vacío en ~20 %)", "llegada": "llegada prevista por iBus en su última previsión (UTC)",
                                  "llegada_local": "lo mismo en hora de Barcelona", "programada": "hora programada usada (UTC)",
                                  "retraso_s": "llegada − programada en segundos (+ tarde, − adelantado); vacío si no hay horario o pasa de 20 min",
                                  "retraso_claro": "el retraso es menor que un cuarto del intervalo programado: no se confunde con el bus de antes o el de después",
                                  "intervalo_prog_s": "segundos entre buses según horario alrededor de esa hora",
                                  "intervalo_previsto_s": "segundos con el bus anterior de la misma línea según iBus (pelotones si es mucho menor que el programado)",
                                  "previsiones": "previsiones juntadas en este paso", "anticipacion_s": "segundos entre la última previsión y la llegada",
                                  "anticipacion_primera_s": "lo mismo para la primera previsión", "cambio_prevision_s": "cuánto cambió la llegada prevista entre la primera y la última"}},
    "bus_retrasos_15min": {"descripcion": "Retraso de cada línea y sentido por cuarto de hora (de bus_llegadas, solo previsiones a 15 min o menos de la llegada).",
                           "fuente": "gold/bus_llegadas", "clave": "linea + sentido + t",
                           "columnas": {"linea": "línea", "sentido": "1 ida · 2 vuelta", **_T, "pasos": "pasos medidos", "paradas": "paradas distintas",
                                        "retraso_mediana_s": "mediana del retraso (s)", "retraso_medio_s": "media (s)", "retraso_p90_s": "percentil 90 (s)",
                                        "retraso_max_s": "máximo (s)", "retrasados": "pasos con más de 3 min de retraso", "adelantados": "pasos con más de 1 min de adelanto",
                                        "claros": "pasos con retraso_claro", "intervalo_prog_s": "mediana del intervalo programado (s)",
                                        "intervalo_previsto_s": "mediana del intervalo real previsto por iBus (s)"}},
    "dim/paradas_bus": {"descripcion": "Paradas de bus: nombre, posición y barrio.", "fuente": "GTFS de TMB y AMB + barrios de Open Data BCN", "clave": "parada",
                        "columnas": {"parada": "código TMB (el de iBus)", "nombre": "nombre", "x": "metros este (coordenadas del visor)", "z": "metros sur",
                                     "barrio": "barrio", "distrito": "distrito"}},
    "dim/lineas_bus": {"descripcion": "Líneas de bus con su color y nombre.", "fuente": "GTFS de TMB y AMB-NitBus", "clave": "linea",
                       "columnas": {"linea": "línea", "color": "color oficial", "nombre": "nombre (extremos)", "nocturna": "NitBus"}},
    "entreno_bicing": {"descripcion": "Tabla de entrenamiento: bicis en cada estación dentro de 30 minutos, con el pasado reciente, la hora, el calendario y el tiempo.",
                       "fuente": "gold/bicing_15min + tiempo_15min + dim/calendario", "clave": "estacion_id + t",
                       "columnas": {"estacion_id": "estación", **_T, "bicis": "bicis ahora", "capacidad": "anclajes", "ocupacion": "bicis / capacidad", "cogidas": "salidas en el cuarto de hora",
                       "dejadas": "llegadas en el cuarto de hora", "bicis_hace_15min": "bicis hace 15 min", "bicis_hace_30min": "hace 30 min", "bicis_hace_60min": "hace 60 min",
                       "objetivo_bicis_30min": "LO QUE HAY QUE PREDECIR: bicis dentro de 30 min", "hora": "hora local decimal", "dia_semana": "1 lunes … 7 domingo",
                       "laborable": "día laborable", "festivo": "festivo oficial o local", "temperatura": "°C", "precipitacion_mm": "mm", "codigo_tiempo": "código WMO", "inc_dist_m": "metros a la incidencia activa más cercana (vacío si no hay a menos de 5 km)",
                       "inc_300m": "incidencias activas a menos de 300 m", "inc_1km": "a menos de 1 km", "inc_cortes_1km": "cortes de circulación a menos de 1 km",
                       "inc_tipo_cercana": "tipo de la más cercana (a menos de 1 km)", "inc_horas_cercana": "horas que lleva la más cercana"}},
    "entreno_trafico": {"descripcion": "Tabla de entrenamiento: estado de cada tramo dentro de 30 minutos, con el pasado reciente, la hora, el calendario y el tiempo.",
                        "fuente": "gold/trafico_15min + tiempo_15min + dim/calendario", "clave": "tramo_id + t",
                        "columnas": {"tramo_id": "tramo", **_T, "estado": "estado ahora (0–6)", "previsto": "previsión municipal", "estado_hace_15min": "hace 15 min",
                        "estado_hace_30min": "hace 30 min", "estado_hace_60min": "hace 60 min", "objetivo_estado_30min": "LO QUE HAY QUE PREDECIR: estado dentro de 30 min",
                        "hora": "hora local decimal", "dia_semana": "1 lunes … 7 domingo", "laborable": "día laborable", "festivo": "festivo", "temperatura": "°C",
                        "precipitacion_mm": "mm", "codigo_tiempo": "código WMO", "inc_dist_m": "metros a la incidencia activa más cercana (vacío si no hay a menos de 5 km)",
                       "inc_300m": "incidencias activas a menos de 300 m", "inc_1km": "a menos de 1 km", "inc_cortes_1km": "cortes de circulación a menos de 1 km",
                       "inc_tipo_cercana": "tipo de la más cercana (a menos de 1 km)", "inc_horas_cercana": "horas que lleva la más cercana",
                        "inc_en_tramo": "hay una incidencia activa en este tramo", "inc_corte_en_tramo": "y corta la circulación"}},
    "entreno_bus": {"descripcion": "Tabla de entrenamiento: retraso de un bus al llegar a una parada, con lo que se sabía cuando iBus hizo la previsión "
                                   "(retrasos de la última hora en su línea, tráfico alrededor en el último cuarto de hora cerrado, incidencias, hora, calendario y tiempo). "
                                   "Solo pasos con previsión a 0–15 min de la llegada.",
                    "fuente": "gold/bus_llegadas + trafico_15min + incidencias + tiempo_15min + dim/calendario", "clave": "parada + linea + sentido + llegada_local",
                    "columnas": {"linea": "línea", "sentido": "1 ida · 2 vuelta", "parada": "parada (ver dim/paradas_bus)", "id_bus": "bus", **_T,
                                 "llegada_local": "llegada prevista (hora de Barcelona)", "programada": "hora programada (UTC)", "anticipacion_s": "segundos entre la previsión y la llegada",
                                 "intervalo_prog_s": "segundos entre buses según horario", "retraso_claro": "retraso menor que ¼ del intervalo (sin confusión de bus)",
                                 "retraso_linea_60min_s": "mediana del retraso de la línea y sentido en la última hora", "pasos_linea_60min": "pasos medidos en esa hora",
                                 "retraso_ultimo_linea_s": "último retraso medido de la línea", "min_desde_ultimo_linea": "minutos desde ese último paso",
                                 "trafico_estado_cerca": "estado del tramo de tráfico a menos de 150 m (1–6)", "trafico_medio_500m": "estado medio de los tramos a menos de 500 m",
                                 "hora": "hora local decimal", "dia_semana": "1 lunes … 7 domingo", "laborable": "día laborable", "festivo": "festivo",
                                 "temperatura": "°C", "precipitacion_mm": "mm", "codigo_tiempo": "código WMO", "inc_dist_m": "metros a la incidencia activa más cercana (vacío si no hay a menos de 5 km)",
                       "inc_300m": "incidencias activas a menos de 300 m", "inc_1km": "a menos de 1 km", "inc_cortes_1km": "cortes de circulación a menos de 1 km",
                       "inc_tipo_cercana": "tipo de la más cercana (a menos de 1 km)", "inc_horas_cercana": "horas que lleva la más cercana",
                                 "objetivo_retraso_s": "LO QUE HAY QUE PREDECIR: retraso del bus en esta parada (s)"}},
    "dim/calendario": {"descripcion": "Un día por fila: día de la semana, festivos oficiales de Cataluña y locales de Barcelona, horario de verano.",
                       "fuente": "Generalitat de Catalunya (datos abiertos: calendario laboral y festivos locales)", "clave": "fecha",
                       "columnas": {"fecha": "día", "dia_semana": "1 lunes … 7 domingo", "fin_de_semana": "sábado o domingo", "festivo": "festivo", "tipo_festivo": "oficial o local",
                                    "laborable": "ni fin de semana ni festivo", "horas_del_dia": "23/24/25 (cambios de hora)", "horario_verano": "horario de verano"}},
    "dim/estaciones_bicing": {"descripcion": "Estaciones de Bicing: nombre, posición, capacidad y barrio.", "fuente": "Bicing (station_information) + barrios de Open Data BCN",
                              "clave": "estacion_id", "columnas": {"estacion_id": "id", "nombre": "nombre", "lat": "latitud", "lon": "longitud", "capacidad": "anclajes",
                              "barrio": "barrio", "distrito": "distrito", "x": "metros este (coordenadas del visor)", "z": "metros sur (coordenadas del visor)"}},
    "dim/tramos_trafico": {"descripcion": "Tramos de tráfico municipales: descripción, barrio y longitud.", "fuente": "Open Data BCN (relació de trams)",
                           "clave": "tramo_id", "columnas": {"tramo_id": "id", "descripcion": "calle y extremos", "barrio": "barrio", "distrito": "distrito",
                           "x": "metros este (centro)", "z": "metros sur (centro)", "longitud_m": "longitud"}},
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prueba", action="store_true", help="escribe en prueba/ (silver, gold, catálogo) y no borra nada")
    ap.add_argument("--local", help="carpeta local en lugar de R2")
    ap.add_argument("--hoy", help="fecha de hoy AAAA-MM-DD (tests)")
    ap.add_argument("--resumen", default=str(RESUMEN), help="dónde dejar el resumen para la web ('' = no dejarlo)")
    a = ap.parse_args()
    hoy = date.fromisoformat(a.hoy) if a.hoy else datetime.now(MADRID).date()
    alm = Local(a.local) if a.local else R2()
    c = Compactador(alm, hoy, a.prueba)
    log(f"compactando (hoy = {hoy}{', modo prueba' if a.prueba else ''})")
    c.dias()
    oro = Oro(c)
    try:
        oro.correr()                     # antes de agrupar: así lee los días recién hechos sin bajar meses enteros
    except Exception as e:  # noqa: BLE001
        c.errores.append(f"gold: {e}"); log("ERROR gold", e)
    c.hecho += oro.hecho
    c.agrupar()
    resumen = c.cerrar()
    if a.resumen:
        Path(a.resumen).parent.mkdir(parents=True, exist_ok=True)
        Path(a.resumen).write_text(json.dumps(resumen, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"histórico: {resumen['bytes_historico'] / 1e6:.1f} MB · sueltas: {resumen['capturas_sueltas']} "
        f"({resumen['bytes_capturas_sueltas'] / 1e6:.1f} MB) · {len(c.errores)} errores")
    if c.errores:
        sys.exit(1)


if __name__ == "__main__":
    main()
