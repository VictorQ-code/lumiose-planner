"""Coordenadas: WGS84 (lon/lat) -> UTM 31N (EPSG:25831) -> sistema local del visor.

Sin dependencias externas (fórmulas de Krüger, error de milímetros en Barcelona), para que el
flujo en vivo funcione aunque no esté instalado pyproj. El sistema local es el mismo que usan
ciudad.py, mapa_base.py y suelo.py: x = este - origen, z = -(norte - origen), en metros.
"""
from __future__ import annotations

import json
import math

from comun import GOLD

_A = 6378137.0
_F = 1 / 298.257222101          # GRS80 (ETRS89)
_K0 = 0.9996
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_LON0 = math.radians(3.0)       # meridiano central del huso 31


def utm31(lon: float, lat: float) -> tuple[float, float]:
    phi, lam = math.radians(lat), math.radians(lon)
    s, c = math.sin(phi), math.cos(phi)
    n = _A / math.sqrt(1 - _E2 * s * s)
    t = math.tan(phi) ** 2
    cc = _EP2 * c * c
    a = c * (lam - _LON0)
    e2, e4, e6 = _E2, _E2 ** 2, _E2 ** 3
    m = _A * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
              - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
              + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
              - (35 * e6 / 3072) * math.sin(6 * phi))
    x = _K0 * n * (a + (1 - t + cc) * a ** 3 / 6 + (5 - 18 * t + t * t + 72 * cc - 58 * _EP2) * a ** 5 / 120) + 500000
    y = _K0 * (m + n * math.tan(phi) * (a * a / 2 + (5 - t + 9 * cc + 4 * cc * cc) * a ** 4 / 24
                                       + (61 - 58 * t + t * t + 600 * cc - 330 * _EP2) * a ** 6 / 720))
    return x, y


_origen: tuple[float, float] | None = None


def origen() -> tuple[float, float]:
    global _origen
    if _origen is None:
        p = GOLD / "barcelona" / "index.json"
        if not p.exists():
            raise SystemExit("No existe data/gold/barcelona/index.json. Ejecuta antes pipeline/ciudad.py.")
        _origen = tuple(json.loads(p.read_text(encoding="utf-8"))["origin"])
    return _origen


def a_local(lon: float, lat: float) -> tuple[float, float]:
    ox, oy = origen()
    x, y = utm31(lon, lat)
    return round(x - ox, 1), round(-(y - oy), 1)
