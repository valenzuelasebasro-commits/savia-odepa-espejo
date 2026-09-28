#!/usr/bin/env python3
"""
Genera boletines XLSX sintéticos con el MISMO layout que ODEPA, para probar el
port sin acceso a odepa.gob.cl.

Escenarios construidos a propósito (para verificar las reglas del runbook):
  Tomate     -> escasez: último día +30 % de precio y −50 % de volumen  => 🔴
  Lechuga    -> sobreoferta: último día −20 % de precio y +40 % de volumen
  Zanahoria  -> estable                                                 => 🟢
  Palta      -> alza sostenida 7d > 15 % sin caída de volumen
"""
import datetime as dt
import os
import random
import sys

import openpyxl

OUT = sys.argv[1] if len(sys.argv) > 1 else "data"
LAST = dt.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else dt.date(2026, 9, 25)
NDAYS = int(sys.argv[3]) if len(sys.argv) > 3 else 120

MERCADOS_FRUTA = ["Lo Valledor", "Vega Central Mapocho", "Macroferia Talca"]
MERCADOS_HORT = ["Lo Valledor", "Vega Central Mapocho", "Mapocho Vta.Dir"]

HDR = ["Producto", "Variedad", "Calidad", "Volumen", "Precio mínimo",
       "Precio máximo", "Precio promedio", "Unidad", "Origen"]

# producto -> (variedad, calidad, unidad, origen, precio_base, volumen_base)
FRUTAS = {
    "Palta": ("Hass", "Primera", "$/caja 10 kilos", "Quillota", 12000, 800),
    "Manzana": ("Fuji", "Primera", "$/caja 18 kilos", "Curicó", 9000, 1200),
    "Naranja": ("Valencia", "Primera", "$/malla 20 kilos", "Ovalle", 7000, 900),
}
HORTALIZAS = {
    "Tomate": ("Larga vida", "Primera", "$/caja 15 kilos", "Azapa", 8000, 1500),
    "Lechuga": ("Escarola", "Primera", "$/docena", "Quillota", 3000, 1100),
    "Zanahoria": ("Chantenay", "Primera", "$/malla 25 kilos", "Buin", 6500, 1000),
    "Cebolla": ("Valenciana", "Primera", "$/malla 25 kilos", "Melipilla", 5500, 1300),
}

rnd = random.Random(20260928)


def serie(base_p, base_v, dias, producto):
    """Devuelve [(fecha, precio, volumen)] con el escenario del producto."""
    out = []
    for i, d in enumerate(dias):
        # deriva suave + ruido, determinista
        drift = 1 + 0.0004 * i
        p = base_p * drift * (1 + rnd.uniform(-0.02, 0.02))
        v = base_v * (1 + rnd.uniform(-0.08, 0.08))
        ult = i == len(dias) - 1
        prev7 = i >= len(dias) - 8
        if producto == "Tomate" and ult:
            p = out[-1][1] * 1.30          # +30 % diario
            v = out[-1][2] * 0.50          # −50 % diario
        elif producto == "Lechuga" and ult:
            p = out[-1][1] * 0.80          # −20 % diario
            v = out[-1][2] * 1.40          # +40 % diario
        elif producto == "Palta" and prev7:
            p = p * (1 + 0.03 * (i - (len(dias) - 9)))  # alza sostenida
        out.append((d, round(p), round(v)))
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    dias = []
    d = LAST
    while len(dias) < NDAYS:
        if d.weekday() < 5:  # solo días hábiles
            dias.append(d)
        d -= dt.timedelta(days=1)
    dias.reverse()

    series = {}
    for prod, (v, c, u, o, bp, bv) in {**FRUTAS, **HORTALIZAS}.items():
        series[prod] = serie(bp, bv, dias, prod)

    for di, day in enumerate(dias):
        wb = openpyxl.Workbook()
        wb.remove(wb.active)
        for grupo, prods, mercados in (
            ("Frutas", FRUTAS, MERCADOS_FRUTA),
            ("Hortalizas", HORTALIZAS, MERCADOS_HORT),
        ):
            for mi, mercado in enumerate(mercados):
                ws = wb.create_sheet(f"{grupo}_{mercado}"[:31])
                ws.append(["Boletín diario de precios y volúmenes"])
                ws.append(["Día:", day])          # fecha como date real
                ws.append([])
                ws.append(HDR)
                for prod, (var, cal, uni, ori, _bp, _bv) in prods.items():
                    _, p, v = series[prod][di]
                    # cada mercado con un pequeño spread estable
                    f = 1 + 0.03 * mi
                    ws.append([prod, var, cal, round(v * (1 - 0.1 * mi)),
                               round(p * f * 0.92), round(p * f * 1.08), round(p * f),
                               uni, ori])
                    # una segunda calidad, para probar la elección de serie de referencia
                    ws.append([prod, var, "Segunda", round(v * 0.3),
                               round(p * f * 0.75), round(p * f * 0.9), round(p * f * 0.82),
                               uni, ori])
        name = f"BoletinDiarioFrutasHortalizas_{day.strftime('%d%m%Y')}.xlsx"
        wb.save(os.path.join(OUT, name))
    print(f"generados {len(dias)} boletines en {OUT}/  (último: {dias[-1]})")


if __name__ == "__main__":
    main()
