#!/usr/bin/env python3
"""
Pruebas de las reglas que fallaron en septiembre de 2026.
No requieren red: el descubrimiento se prueba con HTML de muestra.
"""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "odepa"))
import mirror  # noqa: E402

fails, checks = [], 0


def ck(cond, msg):
    global checks
    checks += 1
    if not cond:
        fails.append(msg)


# ═══ REGLA 2: fechar por 8 dígitos, no por plantilla ═══
# Las tres variantes de nombre observadas, más renombres hipotéticos.
casos = {
    "Boletin_Diario_de_Frutas_y_Hortalizas_20260916.xlsx": "20260916",  # histórico
    "BoletinDiarioFrutasHortalizas-23092026.xlsx": "20260923",          # guion medio
    "BoletinDiarioFrutasHortalizas_25092026.xlsx": "20260925",          # guion bajo
    "BoletinDiarioFrutasHortalizas_20260925.xlsx": "20260925",          # AAAAMMDD
    "bd23092026_v2.xlsx": "20260923",                                   # renombre cualquiera
    "boletin%2028092026.xlsx": "20260928",                              # url-encoded
    "Boletin-Frutas-Hortalizas-01102026-final.xlsx": "20261001",        # sufijo extra
}
for nombre, esperado in casos.items():
    got = mirror.fecha_desde_nombre(nombre)
    ck(got == esperado, f"fecha_desde_nombre({nombre!r}) = {got!r}, se esperaba {esperado!r}")

# Nombres que NO deben dar fecha (no hay bloque de 8 dígitos válido)
for nombre in ["boletin.xlsx", "informe_2026.xlsx", "x_99999999.xlsx", "serie_123456789.xlsx"]:
    ck(mirror.fecha_desde_nombre(nombre) is None,
       f"fecha_desde_nombre({nombre!r}) debía ser None, dio {mirror.fecha_desde_nombre(nombre)!r}")

# Ambigüedad DDMMAAAA vs AAAAMMDD: 01102026 -> 2026-10-01 (el segundo bloque es el año)
ck(mirror.fecha_desde_nombre("a01102026.xlsx") == "20261001", "desambiguación DDMMAAAA falló")

# ═══ REGLA 1: descubrir, no construir ═══
HTML_OK = """
<html><body>
  <a href="/wp-content/uploads/2026/09/BoletinDiarioFrutasHortalizas_25092026.xlsx">Descargar</a>
  <a href='https://www.odepa.gob.cl/wp-content/uploads/2026/09/otro-24092026.xlsx'>Ayer</a>
  <a href="/algo.pdf">PDF</a>
</body></html>
"""
HTML_RENOMBRADO = """
<a href="/wp-content/uploads/2026/10/FormatoNuevoQueNadieAnticipo~02102026.xlsx">Boletín</a>
"""
HTML_SIN_ENLACES = "<html><body><p>Sitio en mantención</p></body></html>"


def fake_page(html):
    orig = mirror._get
    mirror._get = lambda url, timeout=60: html.encode("utf-8")
    try:
        return mirror.indexar_pagina()
    finally:
        mirror._get = orig


idx = fake_page(HTML_OK)
ck(idx.get("20260925", "").endswith("BoletinDiarioFrutasHortalizas_25092026.xlsx"),
   f"no descubrió el enlace del 25-09: {idx}")
ck("20260924" in idx, "no descubrió el enlace absoluto (href con https://)")
ck(len(idx) == 2, f"debía descubrir 2 enlaces .xlsx, descubrió {len(idx)}: {idx}")

# Un renombre TOTAL debe seguir funcionando: es el punto de la regla 1.
idx2 = fake_page(HTML_RENOMBRADO)
ck(idx2.get("20261002", "").endswith("~02102026.xlsx"),
   f"un nombre nunca visto debía descubrirse igual: {idx2}")

# ═══ REGLA 4: fallar fuerte cuando la página no entrega enlaces ═══
idx3 = fake_page(HTML_SIN_ENLACES)
ck(idx3 == {}, "página sin enlaces debía dar índice vacío")

import subprocess  # noqa: E402

r = subprocess.run(
    [sys.executable, "-c",
     "import sys,os;sys.path.insert(0,'odepa');import mirror;"
     "mirror._get=lambda u,timeout=60:b'<html>sin enlaces</html>';"
     "mirror.cmd_discover(None)"],
    capture_output=True, text=True,
    cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
)
ck(r.returncode != 0, f"discover sin enlaces debía salir con código != 0, salió {r.returncode}")
ck("FALLA FUERTE" in r.stderr, "discover sin enlaces debía anunciar la falla en stderr")
ck("::error::" in r.stderr, "debía emitir ::error:: para que GitHub Actions lo marque en rojo")

# ═══ REGLA 3: validar por contenido, no por metadatos ═══
# ODEPA sirve su página de error con status 200 y content-type de Excel.
paginas_falsas = [b"<!DOCTYPE html><html>error 404</html>", b"", b"PK", b"\x00\x01\x02\x03"]
for body in paginas_falsas:
    orig = mirror._get
    mirror._get = lambda url, timeout=60, _b=body: _b
    try:
        got = mirror.bajar_si_xlsx("/cualquiera.xlsx")
    finally:
        mirror._get = orig
    ck(got is None, f"bajar_si_xlsx debía rechazar {body[:16]!r}")

# Un ZIP real sí pasa
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, "w") as z:
    z.writestr("hola.txt", "contenido")
orig = mirror._get
mirror._get = lambda url, timeout=60: zbuf.getvalue()
try:
    ck(mirror.bajar_si_xlsx("/real.xlsx") is not None, "un ZIP real debía pasar la validación")
finally:
    mirror._get = orig

# ═══ Normalización: port literal de ingest.js ═══
ck(mirror.norm_p("arándano (blue)") == "Arándano", "alias de producto no aplicado")
ck(mirror.norm_p("  tomate   larga  vida ") == "Tomate larga vida", "clean/cap de producto")
ck(mirror.norm_v("Escarola (a)") == "Escarola", "sufijo (a) no removido de variedad")
ck(mirror.norm_v("Hass(os)") == "Hass", "sufijo (os) no removido")
ck(mirror.norm_u("$ / Caja 15 Kilos") == "$/caja 15 kilos", f"norm_u dio {mirror.norm_u('$ / Caja 15 Kilos')!r}")
ck(mirror.num("1.234,56") == 1234.56, "num no interpreta miles '.' y decimal ','")
ck(mirror.num("8.000") == 8000.0, "num no interpreta separador de miles")
ck(mirror.num(None) is None and mirror.num("") is None, "num con vacío debía dar None")
ck(mirror.num(1500) == 1500.0, "num con número debía pasar tal cual")
ck(mirror.cap("primera") == "Primera", "cap")
ck(mirror.cap("DE EXPORTACIÓN") == "DE EXPORTACIÓN", "cap solo debe tocar el 1.er carácter")

# ═══ Store: revisión cuando ODEPA corrige un dato ═══
obs = {}
fila = {"k": "2026-09-25|Lo Valledor|Tomate|Larga vida|Primera|$/caja 15 kilos|Azapa",
        "f": "2026-09-25", "m": "Lo Valledor", "sub": "Hortalizas y tubérculos", "p": "Tomate",
        "v": "Larga vida", "c": "Primera", "u": "$/caja 15 kilos", "o": "Azapa",
        "vol": 100.0, "pmin": 900.0, "pmax": 1100.0, "pavg": 1000.0, "src": "a.xlsx"}
ins, upd, same = mirror.upsert(obs, [dict(fila)], "t1")
ck((ins, upd, same) == (1, 0, 0), f"primera carga debía ser 1 nueva, dio {(ins, upd, same)}")
ck(obs[fila["k"]]["rev"] == 1, "rev inicial debía ser 1")
ins, upd, same = mirror.upsert(obs, [dict(fila)], "t2")
ck((ins, upd, same) == (0, 0, 1), f"recarga idéntica debía ser 'sin cambio', dio {(ins, upd, same)}")
corregida = dict(fila, pavg=1050.0, src="b.xlsx")
ins, upd, same = mirror.upsert(obs, [corregida], "t3")
ck((ins, upd, same) == (0, 1, 0), f"dato corregido debía ser actualización, dio {(ins, upd, same)}")
ck(obs[fila["k"]]["rev"] == 2, "rev debía subir a 2")
ck(obs[fila["k"]]["prev"]["pavg"] == 1000.0, "prev debía guardar el valor anterior")
ck(obs[fila["k"]]["prev"]["src"] == "a.xlsx", "prev debía guardar el archivo anterior")

print(f"{checks} comprobaciones, {len(fails)} fallas")
for f in fails:
    print("  ✗", f)
sys.exit(1 if fails else 0)
