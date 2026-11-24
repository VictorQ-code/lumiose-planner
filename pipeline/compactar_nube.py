"""Compactación nocturna del histórico en la nube (R2). La lanza GitHub Actions cada noche; no hay que tocar nada.

El Worker de Cloudflare guarda cada captura suelta en  bronze/<fuente>/fecha=AAAA-MM-DD/HHMMSSZ.json.gz  (unas 2.500 al día).
Cada noche este script las agrupa en archivos cada vez más grandes, sin perder datos, para que ocupen lo mínimo:

  día      historico/dia/<fuente>/2026-11-24.parquet       + .crudo.jsonl.xz   (las capturas sueltas del día)
  semana   historico/semana/<fuente>/2026-W48.parquet      + .crudo.jsonl.xz   (7 días, semana ISO de lunes a domingo)
  mes      historico/mes/<fuente>/2026-11.parquet          + .crudo.jsonl.xz   (las 4-5 semanas cuyo jueves cae en ese mes)
  año      historico/ano/<fuente>/2026.parquet                                  (12 meses)
  década   historico/decada/<fuente>/2020s.parquet                              (10 años)

- .parquet: los datos ya ordenados en tabla (por columnas y comprimido con zstd): es lo que usan los análisis y la IA.
- .crudo.jsonl.xz: las respuestas originales tal cual llegaron, por si algún día hay que volver a leerlas.
  Al cerrar un año se queda solo la tabla, y el Bicing de ese año pasa de cada minuto a cada 5 minutos:
  así 10 años caben de sobra en los 10 GB gratuitos de R2.
- Un grupo solo se cierra cuando su periodo ha terminado, y los archivos pequeños solo se borran cuando el grande
  ya está subido y comprobado. Si algo falla, no se borra nada y se reintenta la noche siguiente.
- historico/indice.json lleva el inventario (filas, tamaño y fechas de cada archivo) y data/gold/barcelona/historico.json
  un resumen para la web (y para que GitHub vea actividad y no pare la tarea programada).

Uso:
  python pipeline/compactar_nube.py                    contra R2 (claves en R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)
  python pipeline/compactar_nube.py --prueba           escribe en prueba/historico/ y no borra nada
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
        self.base = ("prueba/" if prueba else "") + "historico/"
        self.tmp = Path(tempfile.mkdtemp(prefix="compactar_"))
        self.errores: list[str] = []
        self.hecho: list[str] = []
        try:
            self.indice = json.loads(self.alm.leer(self.base + "indice.json")[0])
        except Exception:  # noqa: BLE001  (primera vez)
            self.indice = {"archivos": {}}

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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prueba", action="store_true", help="escribe en prueba/historico/ y no borra nada")
    ap.add_argument("--local", help="carpeta local en lugar de R2")
    ap.add_argument("--hoy", help="fecha de hoy AAAA-MM-DD (tests)")
    ap.add_argument("--resumen", default=str(RESUMEN), help="dónde dejar el resumen para la web ('' = no dejarlo)")
    a = ap.parse_args()
    hoy = date.fromisoformat(a.hoy) if a.hoy else datetime.now(MADRID).date()
    alm = Local(a.local) if a.local else R2()
    c = Compactador(alm, hoy, a.prueba)
    log(f"compactando (hoy = {hoy}{', modo prueba' if a.prueba else ''})")
    c.dias()
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
