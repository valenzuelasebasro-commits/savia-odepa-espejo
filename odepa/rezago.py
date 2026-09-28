#!/usr/bin/env python3
"""
REGLA NÚMERO DOS del runbook: la fecha del dato no es la fecha del reporte.

Baja payload.json del espejo (o lo lee de disco), y calcula el rezago en DÍAS
HÁBILES entre el boletín analizado y la fecha de la corrida. Emite la línea de
declaración ya redactada, para que nunca se calcule a ojo ni se presente el dato
de un día como si fuera de hoy.

Uso:
  python3 odepa/rezago.py --repo <owner>/<repo>            # baja del espejo
  python3 odepa/rezago.py --payload payload.json          # desde disco
  python3 odepa/rezago.py --payload payload.json --hoy 2026-09-28
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request

DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]
MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
         "agosto", "septiembre", "octubre", "noviembre", "diciembre"]


def dias_habiles(desde: str, hasta: str) -> int:
    """Días hábiles (L–V) estrictamente después de `desde` y hasta `hasta`."""
    a, b = dt.date.fromisoformat(desde), dt.date.fromisoformat(hasta)
    if b < a:
        raise ValueError(f"la fecha del dato ({desde}) es posterior a la corrida ({hasta})")
    return sum(
        1 for i in range((b - a).days)
        if (a + dt.timedelta(days=i + 1)).weekday() < 5
    )


def largo(iso: str) -> str:
    d = dt.date.fromisoformat(iso)
    return f"{DIAS[d.weekday()]} {d.day} de {MESES[d.month - 1]}"


def declaracion(fecha_dato: str, hoy: str) -> dict:
    r = dias_habiles(fecha_dato, hoy)
    if r == 0:
        linea = f"Datos ODEPA del {largo(fecha_dato)} · datos del día (rezago: 0 días hábiles)"
        implica = None
    else:
        plural = "día hábil" if r == 1 else "días hábiles"
        linea = (f"Datos ODEPA del {largo(fecha_dato)} · corrida del {largo(hoy)} "
                 f"· rezago: {r} {plural}")
        implica = None
        if r >= 2:
            implica = (
                f"Con {r} días hábiles de rezago, las variaciones diarias que se informan "
                "pueden haberse revertido desde entonces: conviene tratarlas como dirección, "
                "no como el precio vigente al momento de comprar."
            )
    return {
        "fecha_dato": fecha_dato,
        "fecha_corrida": hoy,
        "rezago_dias_habiles": r,
        "linea": linea,
        "implicancia_compra": implica,
        "celda_historial": f"{fecha_dato} (rezago {r} d.h.)",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload")
    ap.add_argument("--repo", help="owner/repo del espejo")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--hoy", default=dt.date.today().isoformat())
    ap.add_argument("--out", help="guardar el payload bajado en esta ruta")
    a = ap.parse_args()

    if a.repo:
        url = f"https://raw.githubusercontent.com/{a.repo}/{a.branch}/payload.json"
        try:
            raw = urllib.request.urlopen(url, timeout=60).read()
        except Exception as e:
            print(f"ERROR: no se pudo bajar {url}: {e!r}", file=sys.stderr)
            sys.exit(2)
        p = json.loads(raw)
        if a.out:
            with open(a.out, "wb") as fh:
                fh.write(raw)
    elif a.payload:
        with open(a.payload, encoding="utf-8") as fh:
            p = json.load(fh)
    else:
        ap.error("se requiere --payload o --repo")

    fecha = p.get("date")
    if not fecha:
        print("ERROR: el payload no trae `date`", file=sys.stderr)
        sys.exit(2)
    d = declaracion(fecha, a.hoy)
    d["kpis"] = {k: p["kpis"].get(k) for k in ("red", "yellow", "green", "crit", "high", "med")}
    d["generado_por_el_espejo"] = p.get("generated")
    d["trace"] = p.get("trace", {})
    print(json.dumps(d, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
