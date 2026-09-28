#!/usr/bin/env node
/**
 * Espejo ODEPA — driver de análisis.  v2.0 (28-sep-2026)
 *
 * Reemplaza a `OdepaMonitor.run()` de ingest.js, que leía de IndexedDB.
 * `analyze.js` se usa TAL CUAL (es puro y ya exporta con module.exports), así que
 * las reglas de serie de referencia, alertas y puntaje de riesgo quedan idénticas
 * a las del navegador. Esto es deliberado: si se reescribieran, el historial
 * dejaría de ser comparable.
 *
 * Salida: payload.json = OdepaAnalyze.compact(analyze(...)) — exactamente lo que
 * consume build.py. No hace falta trocear ni verificar hashes: el JSON no pasa
 * por la conversación.
 *
 * Uso: node odepa/run_analysis.js [--date AAAA-MM-DD] [--out payload.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const OBS = path.join(ROOT, 'store', 'obs.ndjson');
const LOADS = path.join(ROOT, 'store', 'loads.json');
const SEASON = path.join(ROOT, 'season.json');
const SEASON_SOURCE =
  process.env.ODEPA_SEASON_SOURCE ||
  'ODEPA datos abiertos 2023–2025, Lo Valledor (índice mensual, base 100)';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const outPath = path.resolve(ROOT, arg('--out', 'payload.json'));
const forceDate = arg('--date', null);

function die(msg) {
  console.error(`::error::${msg}`);
  console.error(`FALLA FUERTE: ${msg}`);
  process.exit(2);
}

// --- motor de análisis, sin modificar ---
const OdepaAnalyze = require(path.join(ROOT, 'odepa', 'analyze.js'));
if (!OdepaAnalyze || typeof OdepaAnalyze.analyze !== 'function') {
  die('analyze.js no exportó analyze(): ¿se copió el archivo correcto?');
}

// --- store ---
if (!fs.existsSync(OBS)) die(`no existe ${OBS}: corre primero "python3 odepa/mirror.py parse"`);
const all = fs
  .readFileSync(OBS, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));
if (!all.length) die('el store de observaciones está vacío');

const loadsAll = fs.existsSync(LOADS) ? JSON.parse(fs.readFileSync(LOADS, 'utf8')) : {};
const loads = Object.values(loadsAll)
  .filter((l) => l.status === 'ok' && l.dataDate)
  .sort((a, b) => (a.dataDate < b.dataDate ? -1 : a.dataDate > b.dataDate ? 1 : 0));
if (!loads.length) die('no hay archivos cargados con status ok');

let season = {};
if (fs.existsSync(SEASON)) {
  try {
    season = JSON.parse(fs.readFileSync(SEASON, 'utf8'));
  } catch (e) {
    die(`season.json no es JSON válido: ${e.message}`);
  }
} else {
  console.warn('::warning::season.json no encontrado: el análisis corre sin índice estacional');
}

// --- análisis ---
const out = OdepaAnalyze.analyze(all, { season, date: forceDate || undefined });

// --- trace: port literal del bloque de run() en ingest.js ---
const days = loads.map((l) => l.dataDate);
const last = loads[loads.length - 1];
const DAY = 86400000;
out.trace = {
  registros: all.length,
  archivos: loads.length,
  desde: days[0],
  hasta: days[days.length - 1],
  ultimoArchivo: {
    file: last.file,
    url: last.url ? 'https://www.odepa.gob.cl' + last.url : null,
    pub: last.pub,
    rows: last.rows,
    ins: last.ins,
    upd: last.upd,
    same: last.same,
  },
  diasSinBoletin90: (() => {
    const T = Date.parse(out.date + 'T00:00:00Z');
    const set = new Set(days);
    let miss = 0;
    for (let t = T - 90 * DAY; t <= T; t += DAY) {
      const d = new Date(t);
      const w = d.getUTCDay();
      if (w && w !== 6 && !set.has(d.toISOString().slice(0, 10))) miss++;
    }
    return miss;
  })(),
  estacionalidad: Object.keys(season).length ? SEASON_SOURCE : 'no cargada',
  fuente: 'espejo GitHub (runner), motor analyze.js sin modificar',
};

const payload = OdepaAnalyze.compact(out);
fs.writeFileSync(outPath, JSON.stringify(payload));

// --- resumen legible para el log del runner y para la corrida en la nube ---
const k = payload.kpis;
const meta = {
  date: payload.date,
  registros: out.trace.registros,
  archivos: out.trace.archivos,
  desde: out.trace.desde,
  hasta: out.trace.hasta,
  diasSinBoletin90: out.trace.diasSinBoletin90,
  rojos: k.red,
  amarillos: k.yellow,
  verdes: k.green,
  alertasRM: k.alertsRM,
  crit: k.crit,
  alta: k.high,
  media: k.med,
  bytes: fs.statSync(outPath).size,
};
fs.writeFileSync(path.join(ROOT, 'payload.meta.json'), JSON.stringify(meta, null, 1) + '\n');
console.log(JSON.stringify(meta, null, 1));
if (!k.productsToday) {
  console.warn(
    `::warning::ningún producto tiene dato en la fecha analizada (${payload.date}): ` +
      'el boletín más reciente puede estar incompleto'
  );
}
