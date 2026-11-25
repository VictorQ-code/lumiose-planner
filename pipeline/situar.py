"""Sitúa en el mapa un aviso de incidencia del Ayuntamiento a partir de su texto (lo mismo que hace el visor en vivo.js).

«C. Muntaner a l'altura de C. la Forja tallat al trànsit per obres.»  ->  calle Muntaner, cruce con la Forja
«Pg. de Gràcia de Av. Diagonal fins a Provença, tallat al trànsit.»   ->  tramo entre los dos cruces

Usa la red viaria del visor (vivo/red.json) y el callejero de OSM (vivo/callejero.json). Devuelve la posición en
coordenadas del visor (x metros al este, z metros al sur), el tramo de la red y su tramo de tráfico municipal (si tiene).
Si el texto no dice dónde (p. ej. «Centre Ciutat»), devuelve None.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from pathlib import Path

VIVO = Path(__file__).resolve().parent.parent / "data" / "gold" / "barcelona" / "vivo"
VACIAS = {"carrer", "c", "cl", "avinguda", "av", "avda", "passeig", "pg", "pl", "placa", "rda", "travessera", "trav", "rambla", "rbla", "via",
          "carretera", "ctra", "passatge", "ptge", "baixada", "pujada", "de", "del", "dels", "la", "les", "el", "els", "l", "d", "i", "al", "a"}
TIPO_VIA = {"c": "carrer", "cl": "carrer", "carrer": "carrer", "av": "avinguda", "avda": "avinguda", "avinguda": "avinguda", "pg": "passeig",
            "passeig": "passeig", "pl": "placa", "placa": "placa", "rda": "ronda", "ronda": "ronda", "trav": "travessera", "travessera": "travessera",
            "rbla": "rambla", "rambla": "rambla", "gran": "gran", "ptge": "passatge", "passatge": "passatge"}
SENTIT = {"muntanya": (-0.71, -0.71), "mar": (0.71, 0.71), "besos": (0.71, -0.71), "llobregat": (-0.71, 0.71)}
_FIN = r"(?:,|\s+tallat|\s+tallada|\s+restricc|\.?\s*$)"


def _plano(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower()) if not unicodedata.combining(c))


def tokens(s: str) -> list[str]:
    t = re.sub(r"[´'’`·]", " ", _plano(s))
    return [w for w in re.sub(r"[^a-z0-9 ]", " ", t).split() if w not in VACIAS]


def tipo_via(s: str) -> str:
    m = re.match(r"[a-z]+", _plano(s).strip())
    return TIPO_VIA.get(m.group(0), "") if m else ""


class Situador:
    def __init__(self, vivo: Path = VIVO):
        red = json.loads((vivo / "red.json").read_text(encoding="utf-8"))
        self.nx = [n[0] for n in red["nodos"]]
        self.nz = [n[1] for n in red["nodos"]]
        self.E = []
        for r in red["tramos"]:
            c = r[6]
            n = len(c) // 2
            largo = sum(math.hypot(c[2 * i] - c[2 * i - 2], c[2 * i + 1] - c[2 * i - 1]) for i in range(1, n))
            k = n >> 1
            self.E.append({"a": r[0], "b": r[1], "one": bool(r[4]), "len": largo, "mx": c[2 * k], "mz": c[2 * k + 1], "t": r[7]})
        cal = json.loads((vivo / "callejero.json").read_text(encoding="utf-8"))
        self.calles = [{"nom": nom, "tok": set(tokens(nom)), "tv": tipo_via(nom), "ed": ed} for nom, ed in cal["calles"]]

    # calles cuyo nombre contiene todas las palabras del aviso (primero nombre exacto, mismo tipo de vía, calle larga)
    def buscar(self, nombre: str) -> list[dict]:
        t = tokens(nombre)
        if not t:
            return []
        tv = tipo_via(nombre)
        r = [c for c in self.calles if all(w in c["tok"] for w in t)]
        r.sort(key=lambda c: (len(c["tok"]) - len(t)) * 10 + (5 if tv and c["tv"] != tv else 0) - min(4, len(c["ed"]) / 15))
        return r[:6]

    def _nodos(self, c: dict) -> set[int]:
        s = set()
        for i in c["ed"]:
            s.add(self.E[i]["a"]); s.add(self.E[i]["b"])
        return s

    def cruce(self, A: list[dict], B: list[dict]) -> dict | None:
        for a in A:
            na = self._nodos(a)
            for b in B:
                comun = na & self._nodos(b)
                if comun:
                    return {"calle": a, "nodo": min(comun)}
        best = None
        for a in A:
            na = self._nodos(a)
            for b in B:
                for n in na:
                    for m in self._nodos(b):
                        d = math.hypot(self.nx[n] - self.nx[m], self.nz[n] - self.nz[m])
                        if d < 90 and (best is None or d < best["d"]):
                            best = {"calle": a, "nodo": n, "d": d}
        return best

    def junto(self, calle: dict, nodo: int, sent) -> int | None:
        """Tramo de la calle que llega al cruce (en el sentido del aviso si lo dice)."""
        best = None
        for i in calle["ed"]:
            e = self.E[i]
            if nodo not in (e["a"], e["b"]):
                continue
            for d in ((0,) if e["one"] else (0, 1)):
                hacia, desde = (e["a"], e["b"]) if d else (e["b"], e["a"])
                vx, vz = self.nx[hacia] - self.nx[desde], self.nz[hacia] - self.nz[desde]
                L = math.hypot(vx, vz) or 1
                p = (2 if hacia == nodo else 0) + min(1, e["len"] / 60)
                if sent:
                    p += 3 * (vx * sent[0] + vz * sent[1]) / L
                if best is None or p > best[0]:
                    best = (p, i)
        return best[1] if best else None

    def situar(self, frase: str) -> dict | None:
        """{x, z, tramo_red, tramo_trafico, como} o None."""
        tramo = re.match(r"^(.+?)\s+de\s+((?:(?!\s+de\s).)+?)\s+fins\s+a\s+(.+?)" + _FIN, frase, re.I)
        via = tramo.group(1) if tramo else re.split(r"\s+sentit\s+|\s+a\s+l[´'’]altura|,|\s+tallat|\s+tallada|\s+restricc", frase, maxsplit=1, flags=re.I)[0]
        alt = re.search(r"a\s+l[´'’]altura\s+(?:de\s+la\s+|del\s+|de\s+|d[´'’])?(.+?)(?:,|\s+tallat|\s+tallada|\s+restricc|\s+per\s+|\.?\s*$)", frase, re.I)
        sm = re.search(r"sentit\s+(muntanya|mar|bes[oò]s|llobregat)", frase, re.I)
        sent = SENTIT.get(tokens(sm.group(1))[0]) if sm else None
        A = self.buscar(via)
        if not A:
            return None

        def en_nodo(c, como):
            i = self.junto(c["calle"], c["nodo"], sent)
            if i is None:
                return None
            return {"x": self.nx[c["nodo"]], "z": self.nz[c["nodo"]], "tramo_red": i, "tramo_trafico": self.E[i]["t"], "como": como, "calle": c["calle"]["nom"]}
        if tramo:
            c1, c2 = self.cruce(A, self.buscar(tramo.group(2))), self.cruce(A, self.buscar(tramo.group(3)))
            if c1 and c2:
                mx = (self.nx[c1["nodo"]] + self.nx[c2["nodo"]]) / 2; mz = (self.nz[c1["nodo"]] + self.nz[c2["nodo"]]) / 2
                i = min(c1["calle"]["ed"], key=lambda k: math.hypot(self.E[k]["mx"] - mx, self.E[k]["mz"] - mz))
                return {"x": mx, "z": mz, "tramo_red": i, "tramo_trafico": self.E[i]["t"], "como": "entre dos cruces", "calle": c1["calle"]["nom"],
                        "largo_m": math.hypot(self.nx[c1["nodo"]] - self.nx[c2["nodo"]], self.nz[c1["nodo"]] - self.nz[c2["nodo"]])}
            c = c1 or c2
            if c:
                return en_nodo(c, "cruce")
        if alt:
            B = self.buscar(alt.group(1))
            c = self.cruce(A, B) if B else None
            if c:
                return en_nodo(c, "cruce")
        # solo la calle (plaza, calle corta): su tramo más largo, si la calle no es muy grande
        a = A[0]
        if not a["ed"]:
            return None
        xs = [self.E[i]["mx"] for i in a["ed"]]; zs = [self.E[i]["mz"] for i in a["ed"]]
        if math.hypot(max(xs) - min(xs), max(zs) - min(zs)) > 500:
            return None                                              # calle larga sin cruce: no se sabe dónde
        i = max(a["ed"], key=lambda k: self.E[k]["len"])
        return {"x": sum(xs) / len(xs), "z": sum(zs) / len(zs), "tramo_red": i, "tramo_trafico": self.E[i]["t"], "como": "solo la calle", "calle": a["nom"]}


if __name__ == "__main__":
    import sys
    s = Situador()
    for f in sys.argv[1:]:
        print(f, "->", s.situar(f))
