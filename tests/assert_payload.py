#!/usr/bin/env python3
"""
Verifica que el payload producido por el espejo cumpla las reglas del runbook
en los escenarios que el fixture construyó a propósito.  Falla con código != 0.
"""
import json
import sys

P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "payload.json"))
prods = {p["p"]: p for p in P["products"]}
alerts = P["alerts"]  # [sev, tipo, det, m, p, u, per, base, cur, abs, pct]

fails, checks = [], 0


def ck(cond, msg):
    global checks
    checks += 1
    if not cond:
        fails.append(msg)


def al(producto, tipo=None, sev=None):
    return [a for a in alerts
            if a[4] == producto
            and (tipo is None or a[1] == tipo)
            and (sev is None or a[0] == sev)]


# --- estructura ---
ck(P.get("fmt") == "c1", "payload sin fmt=c1")
ck(P.get("date") == "2026-09-25", f"fecha esperada 2026-09-25, llegó {P.get('date')}")
ck(P.get("trace", {}).get("registros") == 5040, "trace.registros != 5040")
ck(P["kpis"]["productsToday"] == len(prods), "hay productos sin dato en la fecha")
ck("Lo Valledor" in {p["m"] for p in P["products"]}, "no hay serie de Lo Valledor")

# --- serie de referencia: debe elegir Primera (pondera doble), no Segunda ---
for name in ("Tomate", "Lechuga", "Zanahoria"):
    if name in prods:
        ck(prods[name]["c"] == "Primera",
           f"{name}: serie de referencia quedó en calidad {prods[name]['c']}, se esperaba Primera")

# --- Tomate: escasez construida (+30 % precio, −50 % volumen el último día) ---
t = prods.get("Tomate")
ck(t is not None, "Tomate ausente del payload")
if t:
    ck(t["risk"] == "alto", f"Tomate debía ser riesgo alto, quedó {t['risk']}")
    ck(t["dP"]["p"] > 25, f"Tomate ΔP diaria esperada >25 %, llegó {t['dP']['p']}")
    ck(t["dV"]["p"] < -40, f"Tomate ΔV diaria esperada <−40 %, llegó {t['dV']['p']}")
    ck("escasez" in (t.get("plan") or []), f"Tomate debía marcar plan escasez, plan={t.get('plan')}")
    ck(bool(al("Tomate", "Alza con caída de volumen", "crítica")),
       "falta la alerta crítica de escasez en Tomate")
    ck(bool(al("Tomate", "Precio diario", "crítica")),
       "ΔP de +30 % debía ser alerta crítica (umbral dCrit=25)")

# --- Lechuga: sobreoferta construida (−20 % precio, +40 % volumen) ---
l = prods.get("Lechuga")
ck(l is not None, "Lechuga ausente del payload")
if l:
    ck(l["dP"]["p"] < -15, f"Lechuga ΔP diaria esperada <−15 %, llegó {l['dP']['p']}")
    ck(l["dV"]["p"] > 30, f"Lechuga ΔV diaria esperada >30 %, llegó {l['dV']['p']}")
    ck("sobreoferta" in (l.get("plan") or []),
       f"Lechuga debía marcar plan sobreoferta, plan={l.get('plan')}")
    ck(bool(al("Lechuga", "Caída de precio con alza de volumen", "crítica")),
       "falta la alerta crítica de sobreoferta en Lechuga")
    # la sobreoferta NO debe sumar riesgo de abastecimiento (regla del runbook)
    ck(l["risk"] != "alto",
       f"la sobreoferta no debe empujar a riesgo alto, Lechuga quedó {l['risk']}")

# --- Zanahoria: estable ---
z = prods.get("Zanahoria")
if z:
    ck(abs(z["dP"]["p"]) < 10, f"Zanahoria debía estar estable, ΔP={z['dP']['p']}")
    ck(z["risk"] in ("bajo", "medio"), f"Zanahoria quedó en riesgo {z['risk']}")

# --- coherencia de KPIs con la lista de productos ---
ck(P["kpis"]["red"] == sum(1 for p in prods.values() if p["risk"] == "alto"),
   "kpis.red no coincide con los productos en riesgo alto")
ck(P["kpis"]["yellow"] == sum(1 for p in prods.values() if p["risk"] == "medio"),
   "kpis.yellow no coincide")
ck(P["kpis"]["green"] == sum(1 for p in prods.values() if p["risk"] == "bajo"),
   "kpis.green no coincide")
ck(P["kpis"]["alertsRM"] == P.get("alertsTotalRM"), "alertsRM != alertsTotalRM")

# --- todas las alertas del payload son de mercados RM ---
RM = {"Lo Valledor", "Vega Central Mapocho", "Mapocho Venta Directa"}
ck(all(a[3] in RM for a in alerts), "hay alertas de mercados fuera de la RM en payload.alerts")

# --- gráficos: fechas ordenadas y sin huecos de formato ---
for name, c in P["charts"].items():
    ck(len(c["d"]) == len(c["vol"]), f"charts[{name}]: d y vol de distinto largo")
    for m, serie in c["s"].items():
        ck(len(serie) == len(c["d"]), f"charts[{name}][{m}]: serie de distinto largo que d")

print(f"{checks} comprobaciones, {len(fails)} fallas")
for f in fails:
    print("  ✗", f)
if fails:
    sys.exit(1)
print("OK: el port reproduce las reglas del runbook en los escenarios construidos")
