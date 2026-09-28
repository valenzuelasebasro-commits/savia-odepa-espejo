// ODEPA Monitor — motor de análisis (puro, sin DOM). v1.0
// Entrada: filas diarias normalizadas {f,m,sub,p,v,c,u,o,vol,pmin,pmax,pavg}
// Salida: payload compacto para el dashboard.
(function (root) {
  const RM = ['Lo Valledor', 'Vega Central Mapocho', 'Mapocho Venta Directa'];
  const TH = { dP: 10, wP: 15, mP: 20, vol: 20, z: 2.5, zCrit: 3, dCrit: 25 };
  const DAY = 86400000;
  const toT = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const toS = t => new Date(t).toISOString().slice(0, 10);
  const r1 = x => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
  const r0 = x => (x == null || !isFinite(x) ? null : Math.round(x));
  const pct = (a, b) => (a == null || b == null || !b ? null : (a / b - 1) * 100);
  const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const sd = a => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
  const quant = (a, q) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };

  function kgFactor(u) {
    u = (u || '').toLowerCase();
    let m = u.match(/(\d+)\s*canastillos?\s*(\d+(?:[.,]\d+)?)\s*g(?:r|ramos?)?\b/);
    if (m) return (+m[1] * +m[2].replace(',', '.')) / 1000;
    m = u.match(/(\d+(?:[.,]\d+)?)\s*(?:a\s*\d+(?:[.,]\d+)?\s*)?(kilos?|kg)\b/);
    if (m) return +m[1].replace(',', '.');
    return null;
  }

  // OLS de ln(P) sobre días → variación implícita en la ventana W (%)
  function trend(obs, T, W, minN) {
    const pts = obs.filter(o => o.t > T - W * DAY && o.t <= T && o.y > 0);
    if (pts.length < minN) return null;
    const xs = pts.map(o => (o.t - T) / DAY), ys = pts.map(o => Math.log(o.y));
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if (!den) return null;
    return (Math.exp((num / den) * W) - 1) * 100;
  }
  const lastOnOrBefore = (obs, t, maxBack) => { for (let i = obs.length - 1; i >= 0; i--) if (obs[i].t <= t) return obs[i].t >= t - maxBack * DAY ? obs[i] : null; return null; };
  const windowMean = (obs, T, W, key) => mean(obs.filter(o => o.t > T - W * DAY && o.t <= T).map(o => o[key]));
  const trendLabel = (x, th) => (x == null ? 's/d' : x > th ? 'alcista' : x < -th ? 'bajista' : 'estable');

  function analyze(rows, opts = {}) {
    const fold = x => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const season = {}; for (const [k, v] of Object.entries(opts.season || {})) season[fold(k)] = v;
    const markets = [...new Set(rows.map(r => r.m))];
    const D = opts.date || rows.reduce((mx, r) => (r.f > mx ? r.f : mx), '');
    const T = toT(D);
    const recent = rows.filter(r => toT(r.f) > T - 200 * DAY && r.f <= D);

    // 1) Agregación diaria por serie (mercado|producto|variedad|calidad|unidad), sumando orígenes
    const ser = new Map();
    for (const r of recent) {
      const k = [r.m, r.p, r.v, r.c, r.u].join('|');
      let s = ser.get(k); if (!s) { s = { m: r.m, p: r.p, v: r.v, c: r.c, u: r.u, sub: r.sub, d: new Map() }; ser.set(k, s); }
      let o = s.d.get(r.f); if (!o) { o = { f: r.f, t: toT(r.f), vol: 0, pv: 0, pmin: Infinity, pmax: -Infinity, n: 0 }; s.d.set(r.f, o); }
      const w = r.vol > 0 ? r.vol : 1;
      o.vol += r.vol || 0; o.pv += r.pavg * w; o.n += w;
      o.pmin = Math.min(o.pmin, r.pmin); o.pmax = Math.max(o.pmax, r.pmax);
    }
    for (const s of ser.values()) {
      s.obs = [...s.d.values()].sort((a, b) => a.t - b.t).map(o => ({ f: o.f, t: o.t, y: o.pv / o.n, vol: o.vol, pmin: o.pmin, pmax: o.pmax }));
      delete s.d;
    }

    // 2) Serie de referencia por producto × mercado
    const byPM = new Map();
    for (const s of ser.values()) {
      const k = s.m + '|' + s.p; if (!byPM.has(k)) byPM.set(k, []); byPM.get(k).push(s);
    }
    const refs = [];
    for (const [k, list] of byPM) {
      const score = s => { const n90 = s.obs.filter(o => o.t > T - 90 * DAY).length; return n90 * (s.c === 'Primera' ? 2 : 1) * 1e6 + s.obs.reduce((a, o) => a + o.vol, 0) / 1e3; };
      const ref = list.reduce((a, b) => (score(b) > score(a) ? b : a));
      // volumen: todas las variedades/calidades transadas en la misma unidad de referencia
      const vmap = new Map();
      for (const s of list) if (s.u === ref.u) for (const o of s.obs) vmap.set(o.t, (vmap.get(o.t) || 0) + o.vol);
      const obs = ref.obs.map(o => ({ ...o, vt: vmap.get(o.t) || o.vol }));
      refs.push({ ...ref, obs, nSeries: list.length });
    }

    // 3) Indicadores por serie de referencia
    const evals = [];
    for (const s of refs) {
      const obs = s.obs; const last = obs[obs.length - 1];
      if (!last || last.t < T - 7 * DAY) continue;
      const n90 = obs.filter(o => o.t > T - 90 * DAY).length;
      if (n90 < 8) continue;
      const today = last.t === T;
      const P = last.y, V = last.vt;
      const idx = obs.length - 1;
      const prev = idx > 0 && obs[idx - 1].t >= last.t - 10 * DAY ? obs[idx - 1] : null;
      const wk = lastOnOrBefore(obs, last.t - 7 * DAY, 7);
      const mo = lastOnOrBefore(obs, last.t - 30 * DAY, 15);
      const qt = lastOnOrBefore(obs, last.t - 90 * DAY, 20);
      const prev5 = obs.slice(Math.max(0, idx - 5), idx).map(o => o.vt);
      const vBase = prev5.length >= 3 ? mean(prev5) : null;
      const vw = windowMean(obs, last.t, 7, 'vt'), vwPrev = windowMean(obs.filter(o => o.t <= last.t - 7 * DAY), last.t - 7 * DAY, 7, 'vt');
      const ma7 = windowMean(obs, last.t, 7, 'y'), ma30 = windowMean(obs, last.t, 30, 'y');
      const ma7p = prev ? windowMean(obs, prev.t, 7, 'y') : null, ma30p = prev ? windowMean(obs, prev.t, 30, 'y') : null;
      const t7 = trend(obs, last.t, 7, 3), t30 = trend(obs, last.t, 30, 8), t90 = trend(obs, last.t, 90, 20);
      const vt = obs.map(o => ({ t: o.t, y: o.vt }));
      const vt7 = trend(vt, last.t, 7, 3), vt30 = trend(vt, last.t, 30, 8);
      const rets = []; const o30 = obs.filter(o => o.t > last.t - 30 * DAY);
      for (let i = 1; i < o30.length; i++) rets.push(Math.log(o30[i].y / o30[i - 1].y));
      const vol30 = rets.length >= 6 ? sd(rets) * 100 : null;
      const hist = obs.filter(o => o.t < last.t && o.t > last.t - 90 * DAY);
      const hm = mean(hist.map(o => o.y)), hs = sd(hist.map(o => o.y));
      const z = hist.length >= 15 && hs > 0 ? (P - hm) / hs : null;
      const hv = hist.map(o => o.vt), vz = hist.length >= 15 && sd(hv) > 0 ? (V - mean(hv)) / sd(hv) : null;
      const month = +D.slice(5, 7);
      const se = season[fold(s.p)];
      const e = {
        m: s.m, p: s.p, v: s.v, c: s.c, u: s.u, sub: s.sub, kg: kgFactor(s.u), today, f: last.f,
        P: r0(P), Pmin: r0(last.pmin), Pmax: r0(last.pmax), V: r0(V), n90,
        dP: prev ? { b: r0(prev.y), f: prev.f, a: r0(P - prev.y), p: r1(pct(P, prev.y)) } : null,
        wP: wk ? { b: r0(wk.y), f: wk.f, a: r0(P - wk.y), p: r1(pct(P, wk.y)) } : null,
        mP: mo ? { b: r0(mo.y), f: mo.f, a: r0(P - mo.y), p: r1(pct(P, mo.y)) } : null,
        qP: qt ? { b: r0(qt.y), f: qt.f, a: r0(P - qt.y), p: r1(pct(P, qt.y)) } : null,
        dV: vBase ? { b: r0(vBase), a: r0(V - vBase), p: r1(pct(V, vBase)) } : null,
        wV: vw != null && vwPrev != null ? { b: r0(vwPrev), c: r0(vw), a: r0(vw - vwPrev), p: r1(pct(vw, vwPrev)) } : null,
        ma7: r0(ma7), ma30: r0(ma30), t7: r1(t7), t30: r1(t30), t90: r1(t90), vt7: r1(vt7), vt30: r1(vt30),
        tl7: trendLabel(t7, 5), tl30: trendLabel(t30, 7), tl90: trendLabel(t90, 10),
        vol30: r1(vol30), cv30: r1(o30.length > 2 ? (sd(o30.map(o => o.y)) / mean(o30.map(o => o.y))) * 100 : null),
        z: r1(z), vz: r1(vz),
        cross: ma7p != null && ma30p != null && ma7 != null && ma30 != null ? (ma7p <= ma30p && ma7 > ma30 ? 'alcista' : ma7p >= ma30p && ma7 < ma30 ? 'bajista' : null) : null,
        vbreak: vt7 != null && vt30 != null && Math.abs(vt7) > 15 && Math.abs(vt30) > 10 && Math.sign(vt7) !== Math.sign(vt30) ? (vt7 > 0 ? 'repunte' : 'caída') : null,
        sP: se ? se.p[month - 1] : null, sPn: se ? se.p[month % 12] : null, sV: se ? se.v[month - 1] : null, sVn: se ? se.v[month % 12] : null,
        rm: RM.includes(s.m),
      };
      evals.push(e);
    }

    // 4) Umbral de volatilidad alta (P75 de las series RM, mínimo 6 %/día)
    const vols = evals.filter(e => e.rm && e.vol30 != null).map(e => e.vol30);
    const volHigh = Math.max(6, quant(vols, 0.75) || 6);

    // 5) Alertas
    const alerts = [];
    const A = (e, sev, tipo, det, per, base, cur, abs, p, formula) => alerts.push({ sev, tipo, det, m: e.m, p: e.p, u: e.u, per, base, cur, abs, pct: p, formula, rm: e.rm });
    for (const e of evals) {
      if (!e.today) continue;
      if (e.dP && Math.abs(e.dP.p) > TH.dP) A(e, Math.abs(e.dP.p) >= TH.dCrit ? 'crítica' : Math.abs(e.dP.p) >= 1.5 * TH.dP ? 'alta' : 'media', 'Precio diario', e.dP.p > 0 ? 'Alza' : 'Baja', `${e.dP.f} → ${e.f}`, e.dP.b, e.P, e.dP.a, e.dP.p, '(P_t / P_t-1 − 1) × 100');
      if (e.wP && Math.abs(e.wP.p) > TH.wP) A(e, Math.abs(e.wP.p) >= 1.5 * TH.wP ? 'alta' : 'media', 'Precio semanal', e.wP.p > 0 ? 'Alza' : 'Baja', `${e.wP.f} → ${e.f}`, e.wP.b, e.P, e.wP.a, e.wP.p, '(P_t / P_t−7d − 1) × 100');
      if (e.mP && Math.abs(e.mP.p) > TH.mP) A(e, Math.abs(e.mP.p) >= 1.5 * TH.mP ? 'alta' : 'media', 'Precio mensual', e.mP.p > 0 ? 'Alza' : 'Baja', `${e.mP.f} → ${e.f}`, e.mP.b, e.P, e.mP.a, e.mP.p, '(P_t / P_t−30d − 1) × 100');
      if (e.dV && Math.abs(e.dV.p) > TH.vol) A(e, Math.abs(e.dV.p) >= 50 ? 'alta' : 'media', 'Volumen diario', e.dV.p > 0 ? 'Aumento' : 'Disminución', 'hoy vs. media 5 obs. previas', e.dV.b, e.V, e.dV.a, e.dV.p, '(V_t / media(V_t−5…t−1) − 1) × 100');
      if (e.wV && Math.abs(e.wV.p) > TH.vol) A(e, Math.abs(e.wV.p) >= 50 ? 'alta' : 'media', 'Volumen semanal', e.wV.p > 0 ? 'Aumento' : 'Disminución', 'media 7d vs. 7d previos', e.wV.b, e.wV.c, e.wV.a, e.wV.p, '(media V[t−6d,t] / media V[t−13d,t−7d] − 1) × 100');
      if (e.cross) A(e, 'media', 'Quiebre de tendencia (precio)', `Cruce ${e.cross} MM7/MM30`, 'MM7 vs MM30', e.ma30, e.ma7, r0(e.ma7 - e.ma30), r1(pct(e.ma7, e.ma30)), 'MM7 cruza MM30 entre t−1 y t');
      if (e.vbreak) A(e, 'media', 'Quiebre de tendencia (volumen)', `Volumen en ${e.vbreak} contra tendencia 30d`, '7d vs 30d', e.vt30, e.vt7, null, e.vt7, 'signo(tend. 7d) ≠ signo(tend. 30d), |7d|>15 %');
      if (e.z != null && Math.abs(e.z) >= TH.z) A(e, Math.abs(e.z) >= TH.zCrit ? 'crítica' : 'alta', 'Anomalía de precio', `z = ${e.z} (fuera de rango 90d)`, '90 días previos', null, e.P, null, null, 'z = (P_t − media90) / desv90');
      const esc = (e.dP && e.dV && e.dP.p >= TH.dP && e.dV.p <= -TH.vol) || (e.wP && e.wV && e.wP.p >= TH.wP && e.wV.p <= -TH.vol);
      const sob = (e.dP && e.dV && e.dP.p <= -TH.dP && e.dV.p >= TH.vol) || (e.wP && e.wV && e.wP.p <= -TH.wP && e.wV.p >= TH.vol);
      e.esc = !!esc; e.sob = !!sob;
      if (esc) A(e, 'crítica', 'Alza con caída de volumen', 'Posible escasez', 'diario / semanal', null, e.P, null, (e.dP && e.dP.p >= TH.dP ? e.dP.p : e.wP.p), 'ΔP > +10 % y ΔV < −20 % (o semanal +15 % / −20 %)');
      if (sob) A(e, 'crítica', 'Caída de precio con alza de volumen', 'Posible sobreoferta', 'diario / semanal', null, e.P, null, (e.dP && e.dP.p <= -TH.dP ? e.dP.p : e.wP.p), 'ΔP < −10 % y ΔV > +20 % (o semanal −15 % / +20 %)');
    }
    const sevRank = { 'crítica': 0, alta: 1, media: 2 };
    alerts.sort((a, b) => (b.rm - a.rm) || (sevRank[a.sev] - sevRank[b.sev]) || (Math.abs(b.pct || 0) - Math.abs(a.pct || 0)));

    // 6) Índice de Riesgo Comercial (sobre mercado RM principal de cada producto)
    const prodRM = new Map();
    for (const e of evals.filter(x => x.rm)) {
      const cur = prodRM.get(e.p);
      const w = x => (x.today ? 1e9 : 0) + (x.V || 0) * (x.kg || 1);
      if (!cur || w(e) > w(cur)) prodRM.set(e.p, e);
    }
    const products = [];
    for (const e of prodRM.values()) {
      const why = []; let score = 0;
      const p7 = e.wP ? e.wP.p : null, v7 = e.wV ? e.wV.p : null;
      const A1 = p7 != null && p7 > 15, A2 = v7 != null && v7 < -20, A3 = e.vol30 != null && e.vol30 >= volHigh;
      if (A1) { score += 3; why.push(`alza de precio ${p7}% en 7 días (>15%)`); }
      if (A2) { score += 2; why.push(`volumen semanal ${v7}% (< −20%)`); }
      if (A3) { score += 2; why.push(`volatilidad alta ${e.vol30}%/día (umbral ${r1(volHigh)})`); }
      const mod = (p7 != null && Math.abs(p7) > 7 && !A1) || (e.dP && Math.abs(e.dP.p) > 10) || (e.mP && Math.abs(e.mP.p) > 20);
      if (mod) { score += 1; why.push('variaciones de precio moderadas (' + [p7 != null ? `7d ${p7}%` : null, e.dP ? `diaria ${e.dP.p}%` : null, e.mP ? `30d ${e.mP.p}%` : null].filter(Boolean).join(', ') + ')'); }
      const upT = e.tl30 === 'alcista' && e.tl7 !== 'bajista';
      if (upT) { score += 1; why.push(`tendencia alcista sostenida (30d ${e.t30}%, 7d ${e.t7}%)`); }
      const zHi = e.z != null && e.z >= TH.z, zLo = e.z != null && e.z <= -TH.z;
      const anom = zHi || zLo || e.esc || e.sob;
      if (e.esc) { score += 2; why.push('señal de escasez (alza de precio con menos volumen)'); }
      if (zHi) { score += 2; why.push(`precio sobre su rango histórico de 90 días (z=${e.z})`); }
      else if (zLo) { score += 1; why.push(`precio bajo su rango histórico de 90 días (z=${e.z})`); }
      const obsSob = e.sob ? 'señal de sobreoferta (precio cae con más volumen; no suma riesgo de abastecimiento)' : null;
      if (v7 != null && v7 < -10 && !A2) { score += 1; why.push(`volumen semanal a la baja (${v7}%)`); }
      let risk = 'bajo';
      if ((A1 && (A2 || A3)) || score >= 5) risk = 'alto';
      else if (score >= 2) risk = 'medio';
      if (risk === 'bajo') {
        const g = [];
        g.push(p7 == null ? 'sin base semanal comparable' : p7 < -7 ? `precio a la baja en 7 días, sin presión de abastecimiento (${p7}%)` : p7 > 7 ? `alza moderada de precio en 7 días (+${p7}%)` : `precio estable en 7 días (${p7 > 0 ? '+' : ''}${p7}%)`);
        g.push(v7 != null ? `volumen disponible (${v7 > 0 ? '+' : ''}${v7}% semanal)` : 'volumen sin variación relevante');
        g.push(anom ? 'sin anomalías que afecten el abastecimiento' : 'sin anomalías recientes');
        if (why.length) g.push('observación: ' + why.join('; '));
        if (obsSob) g.push(obsSob);
        e.why = g.join('; ');
      } else e.why = why.concat(obsSob ? [obsSob] : []).join('; ');
      e.risk = risk; e.score = score;
      // planificación comercial
      const plan = [];
      if (e.esc || (risk === 'alto' && (A1 || (e.tl7 === 'alcista')) && (A2 || (e.vt7 != null && e.vt7 < -15)))) plan.push('escasez');
      if (e.sob || (p7 != null && p7 < -10 && v7 != null && v7 > 20)) plan.push('sobreoferta');
      const cheap = e.ma30 && e.P < e.ma30 * 0.9 && (e.z == null || e.z < -0.5) && e.tl7 !== 'bajista';
      const seasonUp = e.sP && e.sPn && e.sPn > e.sP * 1.05;
      if ((cheap && e.tl30 !== 'bajista') || (cheap && seasonUp) || (e.sob && seasonUp)) plan.push('oportunidad');
      if (risk === 'medio' && (anom || e.cross || e.vbreak || upT)) plan.push('seguimiento');
      if (risk === 'alto' && !plan.includes('escasez')) plan.push('seguimiento');
      e.plan = plan;
      products.push(e);
    }
    const riskRank = { alto: 0, medio: 1, bajo: 2 };
    products.sort((a, b) => riskRank[a.risk] - riskRank[b.risk] || b.score - a.score || (b.V * (b.kg || 1)) - (a.V * (a.kg || 1)));

    // 7) KPIs
    const act = products.filter(e => e.today);
    const dps = act.filter(e => e.dP).map(e => e.dP.p);
    const kpis = {
      date: D, markets: markets.length, seriesTotal: ser.size, productsRM: products.length, productsToday: act.length,
      alerts: alerts.length, alertsRM: alerts.filter(a => a.rm).length,
      crit: alerts.filter(a => a.rm && a.sev === 'crítica').length, high: alerts.filter(a => a.rm && a.sev === 'alta').length, med: alerts.filter(a => a.rm && a.sev === 'media').length,
      red: products.filter(e => e.risk === 'alto').length, yellow: products.filter(e => e.risk === 'medio').length, green: products.filter(e => e.risk === 'bajo').length,
      medDP: r1(median(dps)), up: dps.filter(x => x > 0).length, down: dps.filter(x => x < 0).length, flat: dps.filter(x => x === 0).length,
      medWP: r1(median(act.filter(e => e.wP).map(e => e.wP.p))), medMP: r1(median(act.filter(e => e.mP).map(e => e.mP.p))),
      medDV: r1(median(act.filter(e => e.dV).map(e => e.dV.p))), volHigh: r1(volHigh),
    };

    // 8) Series para gráficos: productos priorizados
    const pick = [];
    for (const e of products) if (e.risk !== 'bajo' && pick.length < 18) pick.push(e.p);
    for (const e of [...products].sort((a, b) => (b.V * (b.kg || 1)) - (a.V * (a.kg || 1)))) if (!pick.includes(e.p) && pick.length < 30) pick.push(e.p);
    const charts = {};
    const start = T - 120 * DAY;
    for (const p of pick) {
      const base = prodRM.get(p);
      const out = { u: base.u, v: base.v, c: base.c, m: base.m, s: {} };
      for (const s of refs) {
        if (s.p !== p || !RM.includes(s.m)) continue;
        if (s.m !== base.m && (s.u !== base.u || s.c !== base.c)) continue;
        out.s[s.m] = s.obs.filter(o => o.t >= start).map(o => [o.f.slice(5), r0(o.y), r0(o.vt)]);
      }
      charts[p] = out;
    }
    // Comparación entre mercados (misma variedad/calidad/unidad que la referencia RM)
    const mcomp = {};
    for (const p of pick.slice(0, 20)) {
      const base = prodRM.get(p); const row = {};
      for (const s of ser.values()) {
        if (s.p !== p || s.u !== base.u || s.c !== base.c || s.v !== base.v) continue;
        const o = lastOnOrBefore(s.obs, T, 7); if (o) row[s.m] = [r0(o.y), o.f.slice(5)];
      }
      mcomp[p] = row;
    }
    const strip = e => { const o = { ...e }; delete o.obs; return o; };
    return {
      v: '1.1', generated: new Date().toISOString(), date: D, thresholds: TH, kpis,
      alerts: alerts.filter(a => a.rm), alertsOther: alerts.filter(a => !a.rm).slice(0, 25), alertsOtherCount: alerts.filter(a => !a.rm).length,
      products: products.map(strip), charts, mcomp,
    };
  }

  // Payload compacto para transporte al dashboard
  function compact(o, { chartDays = 90, maxCharts = 22, maxAlerts = 150 } = {}) {
    const keep = ['m','p','v','c','u','kg','today','f','P','Pmin','Pmax','V','ma7','ma30','t7','t30','t90','tl7','tl30','tl90','vol30','cv30','z','sP','sPn','risk','score','why','plan'];
    const products = o.products.map(e => {
      const x = {}; for (const k of keep) if (e[k] != null && !(Array.isArray(e[k]) && !e[k].length)) x[k] = e[k];
      if (e.dP) x.dP = { b: e.dP.b, a: e.dP.a, p: e.dP.p };
      if (e.wP) x.wP = { a: e.wP.a, p: e.wP.p };
      if (e.mP) x.mP = { a: e.mP.a, p: e.mP.p };
      if (e.qP) x.qP = { p: e.qP.p };
      if (e.dV) x.dV = { b: e.dV.b, p: e.dV.p };
      if (e.wV) x.wV = { b: e.wV.b, c: e.wV.c, p: e.wV.p };
      if (x.plan && !x.plan.length) delete x.plan;
      return x;
    });
    const alerts = o.alerts.slice(0, maxAlerts).map(a => [a.sev, a.tipo, a.det, a.m, a.p, a.u, a.per, a.base, a.cur, a.abs, a.pct]);
    const DAYMS = 86400000, T = toT(o.date);
    const charts = {};
    for (const p of Object.keys(o.charts).slice(0, maxCharts)) {
      const c = o.charts[p]; const cut = toS(T - chartDays * DAYMS).slice(5);
      const inWin = d => (d.slice(0, 2) > o.date.slice(5, 7) ? '0' : '1') + d >= (cut.slice(0, 2) > o.date.slice(5, 7) ? '0' : '1') + cut;
      const dates = [...new Set(Object.values(c.s).flatMap(a => a.map(r => r[0])))].filter(inWin).sort((a, b) => ((a.slice(0, 2) > o.date.slice(5, 7) ? '0' : '1') + a < (b.slice(0, 2) > o.date.slice(5, 7) ? '0' : '1') + b ? -1 : 1));
      const s = {}; for (const [m, arr] of Object.entries(c.s)) { const mp = new Map(arr.map(r => [r[0], r])); s[m] = dates.map(d => (mp.has(d) ? mp.get(d)[1] : null)); }
      const ref = new Map((c.s[c.m] || []).map(r => [r[0], r[2]]));
      charts[p] = { u: c.u, v: c.v, c: c.c, m: c.m, d: dates, s, vol: dates.map(d => (ref.has(d) ? ref.get(d) : null)) };
    }
    return { v: o.v, fmt: 'c1', generated: o.generated, date: o.date, thresholds: o.thresholds, kpis: o.kpis, trace: o.trace, otherAlerts: o.alertsOtherCount != null ? o.alertsOtherCount : (o.alertsOther || []).length, alertsTotalRM: o.alerts.length, products, alerts, charts, mcomp: o.mcomp };
  }
  // FNV-1a 32 bits sobre UTF-8 (para verificar la transcripción por partes)
  function fnv(str) { const b = new TextEncoder().encode(str); let h = 0x811c9dc5; for (const x of b) { h ^= x; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
  function chunks(obj, size = 18000) { const s = JSON.stringify(obj); const out = []; for (let i = 0; i < s.length; i += size) { const part = s.slice(i, i + size); out.push({ i: out.length, h: fnv(part), part }); } return { n: out.length, total: s.length, h: fnv(s), parts: out }; }

  const api = { analyze, compact, chunks, fnv, kgFactor, trend, RM };
  if (typeof module !== 'undefined') module.exports = api; else root.OdepaAnalyze = api;
})(typeof window !== 'undefined' ? window : globalThis);
