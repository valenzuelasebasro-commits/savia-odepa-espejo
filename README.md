# Espejo ODEPA — Pulso Mayorista (Compras Savia)

Espeja el boletín diario de frutas y hortalizas de ODEPA, corre el motor de análisis
y commitea `payload.json`, para que la corrida programada de Claude pueda trabajar
**sin depender del computador de Sebastián**.

## Por qué existe

La corrida programada de Claude vive en la nube y **no alcanza `odepa.gob.cl`**: el
proxy deniega todo `*.gob.cl` con `CONNECT 403` (verificado el 28-sep-2026 para
`www.odepa.gob.cl`, `datos.odepa.gob.cl`, `reportes.odepa.gob.cl`, `datos.gob.cl` y
`minagri.gob.cl`). Sí alcanza GitHub. Los runners de GitHub no pasan por ese proxy,
así que el runner baja el XLSX y la corrida en la nube lee el resultado por
`raw.githubusercontent.com`.

```
ODEPA ──(GitHub Actions, L–V ×3 al día)──> este repo ──(raw)──> corrida Claude
        descubre · valida · parsea · analiza    payload.json      build + publish
```

## La regla que ordena todo el diseño

ODEPA **renombra sus archivos sin avisar**. Ya pasó y costó una semana de ceguera:

| | |
|---|---|
| hasta ~16-sep-2026 | `Boletin_Diario_de_Frutas_y_Hortalizas_AAAAMMDD.xlsx` |
| ~17-sep-2026 | `BoletinDiarioFrutasHortalizas-DDMMAAAA.xlsx` (guion medio) |
| ~25-sep-2026 | `BoletinDiarioFrutasHortalizas_DDMMAAAA.xlsx` (guion bajo, sin confirmar) |

Por eso este espejo **descubre, no construye**: lee la página del boletín y toma
*cualquier* enlace `.xlsx`, sin importar cómo se llame; fecha por un bloque de 8
dígitos (`fecha_desde_nombre`, tolera AAAAMMDD y DDMMAAAA); valida que el archivo
sea un ZIP real (`PK`, porque ODEPA sirve su página de error con status 200 y el
content-type miente); y **si la página no entrega enlaces, el job termina en rojo**.
Nunca se degrada en silencio.

Los patrones fijos existen solo en `backfill`, que es último recurso para días que la
página ya no enlaza.

## Qué hay acá

| Archivo | Qué hace |
|---|---|
| `odepa/mirror.py` | Descubrimiento, descarga, parseo XLSX y store histórico. Reemplaza la capa de ingesta de `ingest.js` (que dependía de `DOMParser`, `DecompressionStream` e IndexedDB). |
| `odepa/analyze.js` | **El motor de análisis, sin modificar.** Ya era puro y exportaba con `module.exports`, así que corre en Node tal cual: las reglas de serie de referencia, alertas y puntaje de riesgo quedan idénticas a las del navegador. |
| `odepa/run_analysis.js` | Driver que reemplaza a `OdepaMonitor.run()`: lee el store, llama a `analyze`, reconstruye `trace` y escribe `payload.json` (ya compactado, lo que consume `build.py`). |
| `odepa/rezago.py` | Regla número dos: calcula el rezago en **días hábiles** y redacta la línea de declaración. Contrastado contra la función del runbook en 13.820 pares de fechas, 0 diferencias. |
| `season.json` | Índice estacional. **Copiar el del proyecto Savia** (ver más abajo). |
| `store/` | Base histórica versionada en git (reemplaza IndexedDB). `obs.ndjson` ordenado por llave para que los diffs se lean. |
| `data/` | Los XLSX originales, bytes intactos. |
| `tests/` | Suite sin red: 43 comprobaciones de reglas + 53 sobre el payload. |

El store conserva la misma llave que IndexedDB
(`fecha|mercado|producto|variedad|calidad|unidad|origen`) y los mismos campos
`rev`/`prev`/`src`/`ts`, así que el historial sigue siendo comparable.

## Puesta en marcha

1. **Crear el repo** (privado sirve) y subir estos archivos.
2. **Copiar dos archivos del proyecto Savia**, que son la fuente canónica:
   - `claude/odepa-monitor/analyze.js` → `odepa/analyze.js`
   - `claude/odepa-monitor/season.json` → `season.json`

   El `analyze.js` que viene acá es una transcripción y el `season.json` es de
   prueba: **reemplazar ambos** por los del proyecto antes de confiar en las cifras.
   Después de reemplazarlos, correr la suite (paso 4): si la transcripción difería en
   algo que importe, las 53 comprobaciones del payload lo cavan.
3. **Settings → Actions → General → Workflow permissions:** `Read and write permissions`.
   Sin eso el workflow no puede commitear el store.
4. **Probar en local** (opcional pero recomendado, no toca la red):
   ```bash
   pip install openpyxl
   python3 tests/test_reglas.py                      # 43 comprobaciones
   python3 tests/make_fixture.py data 2026-09-25 120 # boletines sintéticos
   python3 odepa/mirror.py parse
   node odepa/run_analysis.js
   python3 tests/assert_payload.py                   # 53 comprobaciones
   git checkout data store && rm -f payload.json payload.meta.json  # limpiar
   ```
5. **Primera corrida y backfill.** En Actions → *Espejo ODEPA* → *Run workflow*:
   - déjalo sin backfill para tomar lo que la página enlaza hoy, **o**
   - `backfill_from = 2026-09-17`, `backfill_to = <hoy>` para intentar los días
     pendientes por sondeo de patrones.

   El backfill desde `2026-03-01` solo funcionará en la medida en que los archivos
   viejos sigan en `/wp-content/uploads/`: la página no tiene archivo histórico y el
   sondeo es la parte frágil. Lo que no se recupere ahí se recupera con la vía de
   respaldo (conversación nueva desde la app de escritorio, que sí ve la página).
6. **Verificar que quedó verde** y que `payload.json` está commiteado con la fecha
   esperada.

## Horario

`0 16,20,23 * * 1-5` UTC ≈ 13:00, 17:00 y 20:00 de Chile en horario de verano
(12:00, 16:00 y 19:00 en invierno). Son tres pasadas a propósito: ODEPA publica a
una hora variable y el cron de GitHub tampoco sigue el DST, así que en vez de
apuntar a una hora exacta se muestrea el día. Con esto el rezago del dashboard
debería bajar a 0–1 día hábil.

⚠️ GitHub **deshabilita los workflows programados** en repos sin actividad por 60
días. Si el espejo deja de correr sin explicación, revisar eso primero.

## Cómo lo consume la corrida de Claude

```bash
python3 odepa/rezago.py --repo <owner>/<repo> --out payload.json
# imprime fecha del dato, fecha de corrida, rezago en días hábiles y la línea ya redactada
python3 build.py payload.json commentary.json pulso-mayorista.html
```

`rezago.py` existe para que la regla número dos no dependa de que alguien cuente
días a ojo: entrega `linea`, `celda_historial` e `implicancia_compra` listas para el
titular, el historial y el resumen.

## Qué está probado y qué no

Probado sin red, con boletines sintéticos que replican el layout (hojas
`Frutas_<mercado>` / `Hortalizas_<mercado>`, fila `Día:`, cabecera `Producto`):

- las tres variantes de nombre de archivo y renombres nunca vistos;
- rechazo de páginas de error servidas con status 200 y de archivos que no son ZIP;
- salida en rojo cuando la página no entrega enlaces;
- elección de la serie de referencia en calidad Primera (pondera doble);
- escasez, sobreoferta, y que la sobreoferta **no** suba el riesgo de abastecimiento;
- revisiones (`rev`/`prev`) cuando ODEPA corrige un dato ya cargado;
- idempotencia del parseo, y que un archivo ilegible deje la corrida en rojo **una
  vez** sin contaminar el store ni repetir el rojo todos los días;
- rezago en días hábiles, contrastado contra la función del runbook.

**No** está probado contra un XLSX real de ODEPA: desde el contenedor donde se
escribió esto el sitio está bloqueado. La primera corrida del workflow es la prueba
de fuego; si el layout real difiere, el paso de parseo falla en rojo con el detalle
de qué esperaba, en vez de guardar datos mudos.
