"""Tranvía (TRAM: Trambaix T1–T3 y Trambesòs T4–T6) a partir de sus GTFS oficiales.

Descarga los dos GTFS abiertos de TRAM (opendata.tram.cat, sin claves) en data/bronze/tram/ y escribe
data/gold/barcelona/vivo/tranvia.json con el mismo formato que buses.json y metro_horario.json (ver pipeline/buses.py).
TRAM publica unas 4–5 semanas de horario por delante, así que la tarea nocturna de GitHub lo rehace cada noche.

Uso:  python pipeline/tranvia.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from buses import construir  # noqa: E402
from comun import BRONZE, GOLD, log  # noqa: E402

REDES = {"TBX": "https://opendata.tram.cat/GTFS/zip/TBX.zip",       # Trambaix: T1, T2, T3 (Diagonal oeste)
         "TBS": "https://opendata.tram.cat/GTFS/zip/TBS.zip"}       # Trambesòs: T4, T5, T6 (Glòries, Diagonal este)
CARPETA = BRONZE / "tram"
SALIDA = GOLD / "barcelona" / "vivo" / "tranvia.json"


def main() -> None:
    CARPETA.mkdir(parents=True, exist_ok=True)
    zips = []
    for red, url in REDES.items():
        r = requests.get(url, timeout=60, headers={"user-agent": "lumiose-planner (portfolio, victorquero.dev)"})
        r.raise_for_status()
        ruta = CARPETA / f"{red}.zip"
        ruta.write_bytes(r.content)
        log(f"{red}: {len(r.content) / 1e3:.0f} kB")
        zips.append((ruta, red + ":"))
    construir({"0"}, SALIDA, "tranvía", zips=zips, fuente="TRAM (GTFS)")


if __name__ == "__main__":
    main()
