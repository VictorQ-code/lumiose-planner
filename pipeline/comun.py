"""Utilidades compartidas del pipeline: rutas, descargas, normalización de textos."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import requests

CRS = "EPSG:25831"  # ETRS89 / UTM 31N: el sistema oficial en Catalunya, en metros

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BRONZE = DATA / "bronze"   # datos tal cual se descargan
SILVER = DATA / "silver"   # datos limpios en GeoParquet
GOLD = DATA / "gold"       # productos listos para el visor y los informes

HEADERS = {"User-Agent": "ciudad-bcn/0.1 (proyecto personal con datos abiertos)"}


def log(msg: str) -> None:
    print(f"· {msg}", flush=True)


def norm(texto: str) -> str:
    """Minúsculas, sin acentos ni signos: 'la Dreta de l'Eixample' -> 'la dreta de l eixample'."""
    t = unicodedata.normalize("NFKD", str(texto)).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", t).strip()


def slug(texto: str) -> str:
    return norm(texto).replace(" ", "-")


def descargar(url: str, destino: Path, forzar: bool = False, timeout: int = 180) -> Path:
    """Descarga con caché: si el fichero ya existe no se vuelve a bajar (salvo forzar)."""
    if destino.exists() and destino.stat().st_size > 0 and not forzar:
        log(f"ya estaba descargado: {destino.relative_to(ROOT)}")
        return destino
    destino.parent.mkdir(parents=True, exist_ok=True)
    log(f"descargando {url.split('?')[0]}")  # sin parámetros: no mostrar claves en pantalla
    tmp = destino.with_suffix(destino.suffix + ".part")
    with requests.get(url, headers=HEADERS, stream=True, timeout=timeout) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for trozo in r.iter_content(1 << 20):
                f.write(trozo)
    tmp.replace(destino)
    log(f"guardado en {destino.relative_to(ROOT)} ({destino.stat().st_size / 1e6:.1f} MB)")
    return destino


def columna(df, *trozos: str, obligatoria: bool = True):
    """Busca una columna cuyo nombre contenga todos los trozos (sin distinguir mayúsculas).

    Los GML del Catastro y los CSV municipales cambian a veces de nombre de campo;
    así no dependemos del nombre exacto.
    """
    trozos = [t.lower() for t in trozos]
    for c in df.columns:
        if all(t in c.lower() for t in trozos):
            return c
    if obligatoria:
        raise KeyError(f"No encuentro una columna con {trozos}. Columnas disponibles: {list(df.columns)}")
    return None
