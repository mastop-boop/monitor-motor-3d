'use strict';
(() => {
/* ============================================================
   Monitor de Condición de Motor — corriente, temperatura, vibración
   Fuente "En vivo": MQTT (mismo canal y formato que Monitor_ADXL345.ino)
   Fuente "Demo": simulador local, marcado como SIMULADO en los datos
   ============================================================ */
const $ = id => document.getElementById(id);
const fin = Number.isFinite;
const TOPIC = 'uni-lab/e7b914ca52/adxl345';
const TOPIC_I = TOPIC + '/corriente';
const BROKER = 'wss://test.mosquitto.org:8081/mqtt';
const MAX_ROWS = 300000;               // ~8 h a 10 muestras/s
const ESTADOS_FW = ['Calibrando','En reposo','Sin referencia','Fase incierta','Motor normal (estimado)',
  'Posible desalineación','Tomando referencia','Revisar corriente','Sin ADXL345'];
const FASES = ['Indeterminada','Estrella (Y)','Delta (Δ)'];
const DEF = {vibMed:10, vibAlt:25, axial:'X', ratio:0.5, tWarn:60, tHigh:75, tCrit:90, iNom:2, sound:false};

const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch {} }
};
let cfg = {...DEF};
try { Object.assign(cfg, JSON.parse(store.get('mc-cfg') || '{}')); } catch {}

/* ---------- niveles ---------- */
const RANK = {off:0, ok:1, warn:2, alarm:3, crit:4};
const VIB = {baja:['Baja','ok'], media:['Media','warn'], alta:['Alta','alarm']};
const TMP = {normal:['Normal','ok'], precaucion:['Precaución','warn'], alta:['Alta','alarm'], critica:['Crítica','crit']};
const CUR = {detenido:['Detenido','off'], normal:['Normal','ok'], sobre:['Sobre nominal','warn']};
const vibLevel = m => !fin(m) ? null : m >= cfg.vibAlt ? 'alta' : m >= cfg.vibMed ? 'media' : 'baja';
const tempLevel = T => !fin(T) ? null : T >= cfg.tCrit ? 'critica' : T >= cfg.tHigh ? 'alta' : T >= cfg.tWarn ? 'precaucion' : 'normal';
// Histéresis del 3 % al salir de "sobre nominal" para evitar avisos intermitentes cerca de In
// Los primeros 3 s de un arranque detectado la corriente alta es normal (corriente de arranque): no se alarma
const enArranque = () => W.cap && W.cap.auto && W.lastT - W.cap.trig < 3000;
const curLevel = (I,u) => !fin(I) || u !== 'A' ? null : I < 0.1 ? 'detenido' :
  (cfg.iNom > 0 && !enArranque() && I > cfg.iNom * (st.lv.cur === 'sobre' ? 0.97 : 1)) ? 'sobre' : 'normal';

/* ---------- estado ---------- */
const rows = [], events = [];
const st = {
  mode:'live', paused:false, pauseAt:0, win:60000,
  vibEma:null, ax:[null,null,null], misCnt:0, mis:false,
  lv:{vib:null, temp:null, cur:null, mis:false},
  peak:null, tmax:null, lastAt:0, missing:0, lastSeq:-1, session:''
};
let dirty = true;
const hover = {};

/* ---------- utilidades ---------- */
const fmt = (v,d=1) => fin(v) ? v.toFixed(d) : '—';
const pad = (n,l=2) => String(n).padStart(l,'0');
const hms = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const stamp = ts => { const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${hms(ts)}.${pad(d.getMilliseconds(),3)}`; };
const fileStamp = () => { const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let C = {};
function readColors(){
  for (const k of ['ink','muted','grid','line','panel','cx','cy','cz','ct','ci','ok','warn','alarm','crit','plot','onda','envol']) C[k] = cssVar('--'+k);
}
function setBadge(el, txt, lv){ el.textContent = txt; el.className = 'badge lv-' + lv; }

/* ---------- ingesta común ---------- */
function ingest(s){
  const now = Date.now();
  const xyz = [s.x, s.y, s.z];
  const mag = xyz.every(fin) ? Math.hypot(...xyz) : null;
  if (fin(mag)) {
    st.vibEma = st.vibEma == null ? mag : st.vibEma + 0.3 * (mag - st.vibEma);
    xyz.forEach((v,i) => st.ax[i] = st.ax[i] == null ? v : st.ax[i] + 0.2 * (v - st.ax[i]));
  }
  // Desalineación: vibración axial predominante sobre la radial (criterio clásico de diagnóstico)
  // o aviso del firmware (estado 5). Histéresis para evitar parpadeo.
  const ai = 'XYZ'.indexOf(cfg.axial);
  let ratio = null;
  if (fin(mag) && st.ax.every(fin)) {
    const radial = Math.max(...st.ax.filter((_,i) => i !== ai));
    ratio = st.ax[ai] / Math.max(radial, 0.5);
  }
  const cond = (fin(ratio) && st.vibEma >= cfg.vibMed && ratio >= cfg.ratio) || s.estado === 5;
  st.misCnt = cond ? Math.min(st.misCnt + 1, 15) : Math.max(st.misCnt - 1, 0);
  if (!st.mis && st.misCnt >= 10) st.mis = true;
  else if (st.mis && st.misCnt === 0) st.mis = false;

  if (fin(s.I)) st.peak = Math.max(st.peak ?? 0, s.I);
  if (fin(s.T)) st.tmax = Math.max(st.tmax ?? -Infinity, s.T);

  const row = {
    ts:now, origen:s.origen, sesion:s.sess, seq:s.seq, tms:s.t,
    x:s.x, y:s.y, z:s.z, mag, vf: fin(mag) ? st.vibEma : null, ratio,
    I:s.I, Ipk:s.Ipk, unit:s.unit, T:s.T, V:s.V, ang:s.ang, fase:s.fase, estado:s.estado,
    vibLv: fin(mag) ? vibLevel(st.vibEma) : null, tLv: tempLevel(s.T), cLv: curLevel(s.I, s.unit), mis: st.mis
  };
  rows.push(row);
  // respaldo: si el ESP32 no envía lotes de 2 ms (firmware anterior), la onda usa la corriente de 10 Hz
  if (fin(s.I) && fin(s.t) && performance.now() - W.ultLote > 2500) onLote(s.t, 100, [s.I]);
  if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  st.lastAt = now;
  transitions(row);
  updateUI(row);
  dirty = true;
}

/* ---------- eventos / alarmas ---------- */
const sevVoz = {};
function logEvent(variable, lv, sev, msg){
  events.push({ts:Date.now(), variable, lv, sev, msg, ack: sev === 'ok' || sev === 'off'});
  if (events.length > 2000) events.shift();
  if (cfg.sound && RANK[sev] >= RANK.alarm && !window.Voz?.activa) beep(sev === 'crit' ? 880 : 660);
  // la voz habla solo si el problema empeora (o si el eje vuelve a alinearse), nunca al bajar de nivel
  const previo = sevVoz[variable] ?? 'ok'; sevVoz[variable] = sev;
  if (lv !== 'Arranque' && lv !== 'Captura' && (RANK[sev] > RANK[previo] || lv === 'Alineado')) window.Voz?.evento(variable, lv, sev, rows.at(-1));
  renderLog();
}
function transitions(r){
  const L = st.lv;
  if (r.vibLv && r.vibLv !== L.vib) {
    const [txt, sev] = VIB[r.vibLv];
    const msg = {baja:'Vibración baja — operación estable',
      media:`Vibración media (≥ ${cfg.vibMed} mg) — vigilar tendencia`,
      alta:`Vibración alta (≥ ${cfg.vibAlt} mg) — inspeccionar anclaje, rodamientos y balanceo`}[r.vibLv];
    if (L.vib !== null || sev !== 'ok') logEvent('Vibración', txt, sev, msg);
    L.vib = r.vibLv;
  }
  if (r.tLv && r.tLv !== L.temp) {
    const [txt, sev] = TMP[r.tLv];
    const msg = {normal:'Temperatura dentro del rango normal',
      precaucion:`Temperatura en precaución (≥ ${cfg.tWarn} °C) — vigilar carga y ventilación`,
      alta:`Temperatura alta (≥ ${cfg.tHigh} °C) — reducir carga / verificar ventilación`,
      critica:`Temperatura crítica (≥ ${cfg.tCrit} °C) — detener el motor`}[r.tLv];
    if (L.temp !== null || sev !== 'ok') logEvent('Temperatura', txt, sev, msg + ` · ${fmt(r.T)} °C`);
    L.temp = r.tLv;
  }
  if (r.cLv && r.cLv !== L.cur) {
    const [txt, sev] = CUR[r.cLv];
    if (L.cur !== null || r.cLv === 'sobre') {
      const msg = {detenido:'Motor detenido (corriente < 0.1 A)', normal:'Corriente en rango normal',
        sobre:`Corriente sobre la nominal (> ${cfg.iNom} A)`}[r.cLv];
      logEvent('Corriente', txt, sev, msg + ` · ${fmt(r.I,2)} A`);
    }
    L.cur = r.cLv;
  }
  if (r.mis !== L.mis) {
    if (r.mis) logEvent('Eje', 'Desalineado', 'alarm',
      `Eje desalineado — vibración axial (${cfg.axial}) predominante` + (fin(r.ratio) ? `, relación ${r.ratio.toFixed(2)}` : '') +
      (r.estado === 5 ? ' · confirmado por firmware' : ''));
    else logEvent('Eje', 'Alineado', 'ok', 'Alineación normalizada');
    L.mis = r.mis;
  }
}
let actx = null;
function beep(f){
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = f; o.type = 'square'; g.gain.value = 0.05;
    o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.25);
  } catch {}
}
function renderLog(){
  const body = $('logBody');
  const list = events.slice(-200).reverse();
  if (!list.length) { body.innerHTML = '<tr class="empty"><td colspan="4">Sin eventos registrados.</td></tr>'; }
  else body.innerHTML = list.map(e =>
    `<tr class="${e.ack ? '' : 'unack'}" style="--c:var(--${e.sev})"><td>${hms(e.ts)}</td><td>${e.variable}</td>` +
    `<td><span class="badge lv-${e.sev}">${e.lv}</span></td><td>${e.msg}</td></tr>`).join('');
  const n = events.filter(e => !e.ack).length;
  $('unack').hidden = !n; $('unack').textContent = n;
  $('dlEv').disabled = !events.length;
}

/* ---------- color térmico del motor ---------- */
function tempStops(){
  return [[20,[47,127,216]], [(20+cfg.tWarn)/2,[46,190,120]], [cfg.tWarn,[236,196,40]], [cfg.tHigh,[245,128,32]], [cfg.tCrit,[222,40,40]]];
}
function tempColor(T){
  if (!fin(T)) return '#6b7a88';
  const s = tempStops();
  if (T <= s[0][0]) return `rgb(${s[0][1]})`;
  for (let i = 1; i < s.length; i++) if (T <= s[i][0]) {
    const [a, ca] = s[i-1], [b, cb] = s[i], k = (T - a) / Math.max(1e-6, b - a);
    return `rgb(${ca.map((c,j) => Math.round(c + (cb[j] - c) * k))})`;
  }
  return `rgb(${s.at(-1)[1]})`;
}
const tRange = () => [20, cfg.tCrit + 15];
function buildThermo(){
  const [lo, hi] = tRange(), p = t => ((t - lo) / (hi - lo) * 100).toFixed(1) + '%';
  $('tbar').style.background = 'linear-gradient(90deg,' + tempStops().map(([t,c]) => `rgb(${c}) ${p(t)}`).join(',') + `,rgb(150,20,20) 100%)`;
  $('tticks').innerHTML = [lo, cfg.tWarn, cfg.tHigh, cfg.tCrit, hi].map((t,i) =>
    `<span style="left:${p(t)};${i===0?'transform:none':i===4?'transform:translateX(-100%)':''}">${t} °C</span>`).join('');
}
function buildScale(){
  const max = cfg.vibAlt * 1.6, z = document.querySelectorAll('#vscale .z');
  z[0].style.flex = `0 0 ${cfg.vibMed / max * 100}%`;
  z[1].style.flex = `0 0 ${(cfg.vibAlt - cfg.vibMed) / max * 100}%`;
  z[2].style.flex = '1 1 auto';
  const p = v => (v / max * 100) + '%';
  $('vscalelbl').innerHTML = [0, cfg.vibMed, cfg.vibAlt, Math.round(max)].map((v,i) =>
    `<span style="left:${p(v)};${i===0?'transform:none':i===3?'transform:translateX(-100%)':''}">${v} mg</span>`).join('');
  ['X','Y','Z'].forEach(a => $('ax'+a).textContent = a === cfg.axial ? 'AXIAL' : 'RADIAL');
  $('vInom').textContent = cfg.iNom > 0 ? cfg.iNom + ' A' : '—';
  $('vTcrit').textContent = cfg.tCrit + ' °C';
}

/* ---------- actualización de la interfaz ---------- */
function updateUI(r){
  // Corriente
  const unit = r.unit || 'A';
  $('vI').textContent = fmt(r.I, 2); $('uI').textContent = unit === '%' ? '%' : 'A'; $('svI').textContent = `${fmt(r.I,2)} ${unit === '%' ? '%' : 'A'}`;
  $('vIpk').textContent = fin(st.peak) ? st.peak.toFixed(2) + ' ' + (unit === '%' ? '%' : 'A') : '—';
  const cl = r.cLv ? CUR[r.cLv] : ['Sin dato','off'];
  setBadge($('bI'), cl[0], cl[1]); $('kpiI').dataset.lv = cl[1];
  const iScale = unit === '%' ? 100 : Math.max(cfg.iNom * 1.5, 0.1);
  $('mI').style.width = fin(r.I) ? Math.min(100, r.I / iScale * 100) + '%' : '0';

  // Temperatura
  const tl = r.tLv ? TMP[r.tLv] : ['Sin dato','off'];
  $('vT').textContent = fmt(r.T); $('svT').textContent = fmt(r.T) + ' °C'; $('svPlate').textContent = fmt(r.T) + ' °C';
  $('vTmax').textContent = fin(st.tmax) ? st.tmax.toFixed(1) + ' °C' : '—';
  setBadge($('bT'), tl[0], tl[1]); setBadge($('bT2'), 'Térmico: ' + tl[0], tl[1]); $('kpiT').dataset.lv = tl[1];
  const [lo, hi] = tRange(), tp = fin(r.T) ? Math.min(100, Math.max(0, (r.T - lo) / (hi - lo) * 100)) : 0;
  $('mT').style.width = tp + '%'; $('tmark').style.left = tp + '%';

  // Motor
  const m = $('motor');
  m.style.setProperty('--motor', tempColor(r.T));
  m.style.setProperty('--glow', {normal:.14, precaucion:.32, alta:.5, critica:.75}[r.tLv] ?? .08);
  m.classList.toggle('hot-crit', r.tLv === 'critica');
  m.classList.toggle('running', unit === 'A' ? fin(r.I) && r.I >= 0.1 : fin(r.vf) && r.vf > 1);
  m.classList.toggle('vib-media', r.vibLv === 'media');
  m.classList.toggle('vib-alta', r.vibLv === 'alta');
  m.classList.toggle('mis', r.mis);
  // Motor 3D
  const lvT = r.tLv ? TMP[r.tLv][1] : 'off';
  window.M3D?.actualizar({T:r.T, color:tempColor(r.T), nivelT:lvT, vib:r.vibLv || 'baja', mis:!!r.mis,
    girando: unit === 'A' ? fin(r.I) && r.I >= 0.1 : fin(r.vf) && r.vf > 1});
  $('o3T').textContent = fmt(r.T) + ' °C'; $('o3I').textContent = `${fmt(r.I, 2)} ${unit === '%' ? '%' : 'A'}`; $('o3V').textContent = fmt(r.vf) + ' mg';
  $('o3T').parentElement.dataset.lv = lvT; $('o3V').parentElement.dataset.lv = r.vibLv ? VIB[r.vibLv][1] : 'off';
  $('o3Mis').hidden = !r.mis;

  // Vibración
  const vl = r.vibLv ? VIB[r.vibLv] : ['Sin dato','off'];
  $('vV').textContent = fmt(r.vf); $('svV').textContent = fmt(r.vf) + ' mg';
  setBadge($('bV'), vl[0], vl[1]); setBadge($('bV2'), 'Severidad ' + vl[0], vl[1]);
  $('kpiV').dataset.lv = r.mis && RANK[vl[1]] < RANK.alarm ? 'alarm' : vl[1];
  $('chipMis').hidden = !r.mis;
  const vmax = cfg.vibAlt * 1.6;
  $('mV').style.width = fin(r.vf) ? Math.min(100, r.vf / vmax * 100) + '%' : '0';
  $('vneedle').style.left = fin(r.vf) ? Math.min(100, r.vf / vmax * 100) + '%' : '0';
  ['X','Y','Z'].forEach((a,i) => {
    const v = st.ax[i];
    $('f'+a).style.width = fin(v) ? Math.min(100, v / vmax * 100) + '%' : '0';
    $('t'+a).textContent = fin(v) ? v.toFixed(1) + ' mg' : '—';
  });
  $('vRatio').textContent = fin(r.ratio) ? `${r.ratio.toFixed(2)}  (umbral ${cfg.ratio})` : '—';
  $('vAlign').textContent = r.mis ? '⚠ Eje desalineado' : fin(r.ratio) ? (r.vibLv === 'baja' ? 'Correcto (vibración baja)' : 'Alineación correcta') : 'Sin datos';
  $('diag').dataset.lv = r.mis ? 'alarm' : fin(r.ratio) ? 'ok' : 'off';
  $('vAng').textContent = r.ang && r.ang.some(fin) ? r.ang.map(a => fin(a) ? a.toFixed(1) + '°' : '—').join(' · ') : '—';


  updateBanner(r);
  $('nRows').textContent = rows.length.toLocaleString('es') + ' muestras';
  $('nLoss').textContent = st.missing ? `Muestras perdidas en transmisión: ${st.missing}` : '';
  ['dlCsv','dlJson'].forEach(id => $(id).disabled = !rows.length);
}

function updateBanner(r){
  const issues = [];
  if (r.tLv && r.tLv !== 'normal') issues.push([TMP[r.tLv][1], `Temperatura ${TMP[r.tLv][0].toLowerCase()} (${fmt(r.T)} °C)`]);
  if (r.mis) issues.push(['alarm', 'Eje desalineado']);
  if (r.vibLv && r.vibLv !== 'baja') issues.push([VIB[r.vibLv][1], `Vibración ${VIB[r.vibLv][0].toLowerCase()} (${fmt(r.vf)} mg)`]);
  if (r.cLv === 'sobre') issues.push(['warn', `Corriente sobre la nominal (${fmt(r.I,2)} A)`]);
  const b = $('banner');
  if (!issues.length) {
    b.className = 'banner ok';
    $('bannerTitle').textContent = 'Operación normal';
    $('bannerText').textContent = 'Corriente, temperatura y vibración dentro de los umbrales configurados.';
    return;
  }
  issues.sort((a,b) => RANK[b[0]] - RANK[a[0]]);
  const sev = issues[0][0];
  b.className = 'banner ' + sev;
  $('bannerTitle').textContent = {warn:'Precaución', alarm:'Alarma', crit:'ALARMA CRÍTICA'}[sev] + ' — ' + issues[0][1];
  $('bannerText').textContent = issues.length > 1 ? 'También: ' + issues.slice(1).map(i => i[1]).join(' · ') : 'Revise el registro de eventos.';
}

/* ---------- gráficas (canvas, sin librerías) ---------- */
function lowerBound(arr, t){ let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; arr[m].ts < t ? a = m + 1 : b = m; } return a; }
function windowRange(){
  const t1 = st.paused ? st.pauseAt : Date.now();
  const t0 = st.win === 'all' ? (rows[0]?.ts ?? t1 - 60000) : t1 - st.win;
  return [t0, Math.max(t1, t0 + 1000)];
}
function niceTick(v){ return Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toFixed(1)).toString(); }

function drawChart(cv, o){
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr,0,0,dpr,0,0); g.clearRect(0,0,w,h);
  const {t0, t1, lo, hi, data} = o;
  // tipografía y márgenes escalados al ancho de la gráfica
  const big = w >= 560, fs = big ? 14 : 12, ft = big ? 15 : 13, NY = 5;
  g.font = `${fs}px system-ui, sans-serif`;
  let wl = 0;
  for (let i = 0; i <= NY; i++) wl = Math.max(wl, g.measureText(niceTick(lo + (hi - lo) * i / NY) + (o.unit ? ' ' + o.unit : '')).width);
  const L = Math.max(50, Math.ceil(wl) + 14), R = w - 14, T = 12, B = h - (ft + 20);
  const X = t => L + (t - t0) * (R - L) / (t1 - t0);
  const Y = v => B - (Math.min(hi, Math.max(lo, v)) - lo) * (B - T) / (hi - lo);
  // zonas de severidad
  for (const z of o.zones || []) {
    const a = Math.max(z.from, lo), b = Math.min(z.to, hi); if (b <= a) continue;
    g.fillStyle = z.color; g.globalAlpha = 0.1; g.fillRect(L, Y(b), R - L, Y(a) - Y(b));
  }
  g.globalAlpha = 1;
  // rejilla
  g.font = `${fs}px system-ui, sans-serif`; g.lineWidth = 1; g.textAlign = 'right';
  for (let i = 0; i <= NY; i++) {
    const v = lo + (hi - lo) * i / NY, y = Math.round(Y(v)) + .5;
    g.strokeStyle = C.grid; g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
    g.fillStyle = C.muted; g.fillText(niceTick(v) + (o.unit ? ' ' + o.unit : ''), L - 8, y + fs * 0.35);
  }
  // líneas umbral
  for (const ln of o.lines || []) {
    if (ln.v < lo || ln.v > hi) continue;
    const y = Math.round(Y(ln.v)) + .5;
    g.strokeStyle = ln.color; g.setLineDash([5,4]); g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = ln.color; g.textAlign = 'left'; g.font = `600 ${fs}px system-ui, sans-serif`; g.fillText(ln.label, L + 6, y - 6);
    g.font = `${fs}px system-ui, sans-serif`; g.textAlign = 'right';
  }
  // eje de tiempo: hora grande con marcas verticales
  const NT = w >= 900 ? 6 : big ? 4 : 2;
  g.font = `600 ${ft}px system-ui, sans-serif`;
  for (let i = 0; i <= NT; i++) {
    const t = t0 + (t1 - t0) * i / NT, x = Math.round(X(t)) + .5;
    if (i > 0 && i < NT) { g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); }
    g.strokeStyle = C.line; g.beginPath(); g.moveTo(x, B); g.lineTo(x, B + 5); g.stroke();
    g.textAlign = i === 0 ? 'left' : i === NT ? 'right' : 'center';
    g.fillStyle = i === NT ? C.ink : C.muted;
    g.fillText(i === NT && st.paused ? hms(t) + ' (pausa)' : hms(t), x, h - 8);
  }
  g.font = `${fs}px system-ui, sans-serif`;
  // series
  const step = Math.max(1, Math.floor(data.length / ((R - L) * 1.5)));
  g.save(); g.beginPath(); g.rect(L, T - 2, R - L, B - T + 4); g.clip();
  for (const s of o.series) {
    g.strokeStyle = s.color; g.lineWidth = big ? 2.6 : 2.1; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
    let pen = false, prev = 0;
    for (let i = 0; i < data.length; i += step) {
      const r = data[i], v = s.get(r);
      if (!fin(v)) { pen = false; continue; }
      if (pen && r.ts - prev > 1500 * step) pen = false;          // hueco de transmisión
      const x = X(r.ts), y = Y(v);
      pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; prev = r.ts;
    }
    g.stroke();
  }
  g.restore();
  // marco
  g.strokeStyle = C.line; g.beginPath(); g.moveTo(L + .5, T); g.lineTo(L + .5, B + .5); g.lineTo(R, B + .5); g.stroke();
  // cursor e información
  const hx = hover[cv.id];
  if (hx != null && hx >= L && hx <= R && data.length) {
    const t = t0 + (hx - L) * (t1 - t0) / (R - L);
    let k = lowerBound(data, t); if (k >= data.length) k = data.length - 1;
    if (k > 0 && Math.abs(data[k-1].ts - t) < Math.abs(data[k].ts - t)) k--;
    const r = data[k], x = X(r.ts);
    g.strokeStyle = C.muted; g.setLineDash([3,3]); g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke(); g.setLineDash([]);
    const lines = [stamp(r.ts).slice(11, 23)];
    for (const s of o.series) {
      const v = s.get(r);
      lines.push(`${s.label}: ${fin(v) ? v.toFixed(s.dec ?? 2) : '—'} ${o.unit || ''}`);
      if (fin(v)) { g.fillStyle = s.color; g.beginPath(); g.arc(x, Y(v), 4.5, 0, 7); g.fill(); }
    }
    g.font = `600 ${fs}px system-ui, sans-serif`;
    const lh = fs + 6, bw = Math.max(...lines.map(l => g.measureText(l).width)) + 20, bh = lines.length * lh + 10;
    let bx = x + 10; if (bx + bw > R) bx = x - bw - 10;
    g.fillStyle = C.panel; g.strokeStyle = C.line; g.globalAlpha = .95;
    g.beginPath(); g.roundRect ? g.roundRect(bx, T + 4, bw, bh, 6) : g.rect(bx, T + 4, bw, bh); g.fill(); g.stroke(); g.globalAlpha = 1;
    g.textAlign = 'left';
    lines.forEach((l,i) => { g.fillStyle = i === 0 ? C.muted : (o.series[i-1].color); g.fillText(l, bx + 10, T + 4 + lh + i * lh); });
  }
}

/* ============================================================
   Corriente: lotes del JXK-10 cada 2 ms y onda sinusoidal equivalente
   El JXK-10 entrega el valor RMS (lazo 4-20 mA en DC). La onda que se dibuja
   es i(t) = √2 · I_RMS(t) · sen(2π·f·t): amplitud medida, forma sinusoidal ideal.
   ============================================================ */
// pts: muestras de 2 ms (últimos 5 min) · dec: bloques de 100 ms con máximo y media (hasta 12 h)
const RAW_MS = 310000, DEC_MAX = 432000, MAX_CAPS = 60;
let durGuardada = 3000; try { durGuardada = Number(localStorage.getItem('mc-capdur')) || 3000; } catch {}
const W = {pts:[], dec:[], blk:null, cap:null, caps:[], quiet:0, lastT:-1, llegada:0, vista:'arranque', ven:1000, f:60, dur:durGuardada, avisoCap:0,
  det:{base:NaN, ruido:0, sobre:0, tIni:0, ultimoFin:-Infinity}, ultLote:-Infinity, res:'—', ema:NaN};
function cerrarBloque(){ const b = W.blk; if (b && b.n) { W.dec.push({t:b.t, max:b.max, mean:b.sum / b.n}); if (W.dec.length > DEC_MAX) W.dec.splice(0, W.dec.length - DEC_MAX); } W.blk = null; }
function onLote(t0, dt, vals){
  if (W.lastT >= 0 && t0 < W.lastT - 1000) {                        // reinicio del ESP32 / cambio de fuente
    W.pts.length = 0; W.dec.length = 0; W.blk = null; W.quiet = 0; W.lastT = -1; W.cap = null;
    W.det = {base:NaN, ruido:0, sobre:0, tIni:0, ultimoFin:-Infinity};
  }
  W.res = dt <= 10 ? `${dt} ms` : `${dt} ms (respaldo)`;
  vals.forEach((v, k) => {
    const t = t0 + k * dt; if (t <= W.lastT) return;
    // s: valor suavizado solo para dibujar (filtro de primer orden, τ ≈ 25 ms); v se conserva sin filtrar
    const s = !fin(v) ? NaN : dt > 10 ? v : fin(W.ema) ? W.ema + (v - W.ema) * Math.min(1, dt / 25) : v;
    if (fin(s)) W.ema = s;
    W.pts.push({t, v, s}); W.lastT = t;
    if (fin(v)) {                                   // agregado de 100 ms para ventanas largas
      const bt = Math.floor(t / 100) * 100;
      if (!W.blk || W.blk.t !== bt) { cerrarBloque(); W.blk = {t:bt, max:v, sum:0, n:0}; }
      W.blk.max = Math.max(W.blk.max, v); W.blk.sum += v; W.blk.n++;
    }
    if (fin(v) && !W.cap) detectarArranque(t, v, dt);
    if (W.cap) { if (t <= W.cap.fin) W.cap.pts.push({t, v}); else cerrarCaptura(); }
  });
  if (W.pts.length && W.pts[0].t < W.lastT - RAW_MS) W.pts.splice(0, idxDesde(W.pts, W.lastT - RAW_MS));
  if (W.cap && performance.now() - W.avisoCap > 250) {
    W.avisoCap = performance.now();
    setConn(`● Capturando ${W.cap.auto ? 'arranque' : 'corriente'} ${((W.lastT - W.cap.trig) / 1000).toFixed(1)} / ${(W.dur / 1000).toFixed(0)} s`, 'live');
  }
  W.llegada = performance.now(); dirty = true;
}
/* Detector de arranque adaptativo.
   El transmisor marca ~0,5 A en reposo (desplazamiento del lazo 4-20 mA), por eso no se usa un umbral fijo:
   se sigue la línea base y su ruido, y se dispara ante un escalón sostenido por encima de ella. */
function detectarArranque(t, v, dt){
  const D = W.det;
  if (!fin(D.base)) { D.base = v; D.ruido = 0; return; }
  const umbral = D.base + Math.max(0.4, 5 * D.ruido, 0.3 * D.base);
  if (v > umbral) {
    if (!D.sobre) D.tIni = t;
    D.sobre += dt;
    const minimo = dt <= 10 ? 20 : 150;                   // 20 ms con lotes de 2 ms · 2 muestras con datos de 10 Hz
    if (D.sobre >= minimo && t - D.ultimoFin > 3000) { iniciarCaptura(D.tIni, true); D.sobre = 0; }
    else if (D.sobre > 3000) { D.base = v; D.sobre = 0; }  // nuevo nivel estable sin captura: se adopta como base
  } else {
    D.sobre = 0;
    const k = Math.min(1, dt / 1000);                     // línea base con constante de tiempo ≈ 1 s
    D.base += (v - D.base) * k;
    D.ruido += (Math.abs(v - D.base) - D.ruido) * Math.min(1, dt / 2000);
  }
}
/* capturas guardadas en este navegador (sobreviven a recargas) */
function guardarCapturas(){
  const datos = W.caps.map(c => ({ts:c.ts, trig:c.trig, fin:c.fin, dur:c.dur, auto:c.auto, imax:c.imax, ireg:c.ireg, tmax:c.tmax, res:c.res,
    t:c.pts.map(p => Math.round(p.t - c.trig)), v:c.pts.map(p => fin(p.v) ? +p.v.toFixed(3) : null)}));
  for (let n = datos.length; n > 0; n--) {
    try {
      localStorage.setItem('mc-capturas', JSON.stringify(datos.slice(0, n)));
      if (n < datos.length) logEvent('Corriente', 'Memoria llena', 'warn', `Memoria del navegador llena: se guardaron ${n} de ${datos.length} capturas. Descargue y borre las antiguas.`);
      return;
    } catch {}
  }
}
function cargarCapturas(){
  try {
    const d = JSON.parse(localStorage.getItem('mc-capturas') || '[]');
    W.caps = d.map(c => {
      let e = NaN;
      const pts = c.t.map((x, i) => { const v = c.v[i] ?? NaN, dt = i ? x - c.t[i - 1] : 2;
        if (fin(v)) e = dt > 10 || !fin(e) ? v : e + (v - e) * Math.min(1, dt / 25);
        return {t:c.trig + x, v, s:fin(v) ? e : NaN}; });
      return {...c, ireg:c.ireg ?? NaN, pts};
    });
  } catch { W.caps = []; }
}
function idxDesde(arr, t){ let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; arr[m].t < t ? a = m + 1 : b = m; } return a; }
function iniciarCaptura(t, auto){
  const pre = 60;                                     // incluye el inicio de la subida
  W.cap = {trig:t, ini:t - pre, fin:t + W.dur, dur:W.dur, auto, res:W.res, ts:Date.now(), pts:W.pts.slice(idxDesde(W.pts, t - pre)).filter(p => p.t <= W.lastT)};
  setConn(auto ? '● Arranque detectado · capturando corriente' : '● Capturando corriente', 'live');
}
function cerrarCaptura(){
  const c = W.cap; W.cap = null;
  setConn(st.mode === 'demo' ? '● Simulación' : '● Recibiendo en vivo', st.mode === 'demo' ? 'demo' : 'live');
  const v = c.pts.map(p => p.v).filter(fin);
  if (!v.length) return;
  const reg = c.pts.filter(p => p.t >= c.fin - 500).map(p => p.v).filter(fin);
  c.imax = v.reduce((m, x) => x > m ? x : m, -Infinity); c.ireg = reg.length ? reg.reduce((a, b) => a + b, 0) / reg.length : NaN;
  c.tmax = c.pts.find(p => p.v === c.imax).t - c.trig;
  // el nivel de régimen pasa a ser la nueva línea base del detector (evita capturas repetidas con el motor en marcha)
  W.det.base = fin(c.ireg) ? c.ireg : v.at(-1); W.det.ruido = 0; W.det.sobre = 0; W.det.ultimoFin = c.fin;
  W.caps.unshift(c); if (W.caps.length > MAX_CAPS) W.caps.pop();   // se conservan hasta 60; solo se borran a mano
  guardarCapturas();
  pintarCapturas(0);
  ultimoArranque = c;
  if (c.auto) window.Voz?.evento('Corriente', 'Arranque', 'ok', c);
  logEvent('Corriente', c.auto ? 'Arranque' : 'Captura', 'ok',
    `${c.auto ? 'Arranque registrado' : 'Captura manual'}: I RMS máx ${c.imax.toFixed(2)} A a ${c.tmax.toFixed(0)} ms` + (fin(c.ireg) ? ` · régimen ${c.ireg.toFixed(2)} A` : ''));
}
function pintarCapturas(sel){
  const fecha = ts => { const d = new Date(ts); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hms(ts)}`; };
  $('ondaCap').innerHTML = W.caps.length ? W.caps.map((c, i) => `<option value="${i}">${fecha(c.ts)} · ${c.auto ? 'arranque' : 'manual'} · ${c.imax.toFixed(2)} A · ${c.res || ''}</option>`).join('') : '<option>Sin capturas</option>';
  $('ondaCap').value = String(sel); $('dlOnda').disabled = $('borrarCap').disabled = !W.caps.length; mostrarStats(); dirty = true;
}
function mostrarStats(){
  const c = W.caps[Number($('ondaCap').value) || 0];
  $('wPico').textContent = c ? (Math.SQRT2 * c.imax).toFixed(2) + ' A' : '—';
  $('wMax').textContent = c ? `${c.imax.toFixed(2)} A · ${c.tmax.toFixed(0)} ms` : '—';
  $('wReg').textContent = c && fin(c.ireg) ? c.ireg.toFixed(2) + ' A' : '—';
  $('wRel').textContent = c && fin(c.ireg) && c.ireg > 0.05 ? (c.imax / c.ireg).toFixed(1) + ' ×' : '—';
}
function irmsEn(pts, t){                       // interpolación lineal del RMS medido
  let a = 0, b = pts.length - 1;
  if (b < 0 || t < pts[0].t || t > pts[b].t) return NaN;
  while (b - a > 1) { const m = (a + b) >> 1; pts[m].t <= t ? a = m : b = m; }
  const p = pts[a], q = pts[b];
  const pv = p.s ?? p.v, qv = q.s ?? q.v;              // se dibuja el valor suavizado si existe
  if (!fin(pv) || !fin(qv)) return NaN;
  return q.t === p.t ? pv : pv + (qv - pv) * (t - p.t) / (q.t - p.t);
}
function pasoBonito(r){ const e = Math.pow(10, Math.floor(Math.log10(r))), m = r / e; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e; }
function etiquetaT(ms, unidad){
  if (unidad === 'ms') return String(Math.round(ms));
  if (unidad === 's') return (Math.abs(ms) >= 10000 ? Math.round(ms / 1000) : Number((ms / 1000).toFixed(1))).toString();
  const s = Math.round(Math.abs(ms) / 1000), m = Math.floor(s / 60);
  return (ms < 0 ? '−' : '') + (m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:` : `${m}:`) + String(s % 60).padStart(2, '0');
}
function pasoTiempo(span, n, unidad){
  if (unidad === 'ms') return pasoBonito(span / n);
  if (unidad === 's') return pasoBonito(span / 1000 / n) * 1000;
  const op = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map(s => s * 1000);
  return op.find(p => p >= span / n) || op.at(-1);
}
function dibujarOnda(cv){
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const big = w >= 560, fs = big ? 14 : 12, ft = big ? 15 : 13;
  // ---- ventana de tiempo y fuente de datos
  let pts, a, b, ref, rel, usarDec = false;
  if (W.vista === 'vivo') {
    if (!W.pts.length) return vacio(g, w, h, fs, 'Esperando lotes de corriente del ESP32…');
    b = Math.min(W.lastT, W.lastT - 120 + (performance.now() - W.llegada));      // desplazamiento suave
    const ini = W.dec.length ? Math.min(W.dec[0].t, W.pts[0].t) : W.pts[0].t;
    a = W.ven === Infinity ? ini : b - W.ven;
    if (b - a < 50) a = b - 50;
    pts = W.pts; ref = 0; rel = b;
    usarDec = a < W.pts[0].t - 200;                // fuera del historial de 2 ms: bloques de 100 ms
  } else {
    const c = W.caps[Number($('ondaCap').value) || 0] || W.cap;
    if (!c) return vacio(g, w, h, fs, 'Esperando un arranque del motor… (o pulse «Capturar ahora»)');
    pts = c.pts; a = Math.max(c.pts[0]?.t ?? c.trig - 10, c.trig - 60); b = W.ven === Infinity ? c.fin : Math.min(c.fin, c.trig + W.ven); ref = c.trig; rel = c.trig;
  }
  const span = b - a;
  g.font = `${fs}px system-ui, sans-serif`;
  const L0 = 64, R = w - 16, T = 14, B = h - (ft + 22), cols = Math.max(100, Math.round(R - L0));
  const ciclo = 1000 / W.f, comprimida = span / cols > ciclo / 3;   // más de 1/3 de ciclo por píxel
  // ---- cálculo de la curva
  let amp = 0, xs = [], ys = [], env = [];
  if (!comprimida) {
    const N = Math.min(24000, Math.max(800, Math.ceil(span / (ciclo / 24))));
    for (let k = 0; k <= N; k++) {
      const t = a + span * k / N, r = irmsEn(pts, t), e = fin(r) ? Math.SQRT2 * r : NaN;
      xs.push(t); env.push(e); ys.push(fin(e) ? e * Math.sin(2 * Math.PI * W.f * (t - ref) / 1000) : NaN);
      if (fin(e)) amp = Math.max(amp, e);
    }
  } else {
    // envolvente por columna: √2 · I_RMS máxima dentro de cada intervalo de píxel
    const src = usarDec ? W.dec : pts, val = usarDec ? (p => p.max) : (p => p.s ?? p.v);
    let i = idxDesde(src, a);
    for (let k = 0; k < cols; k++) {
      const tb = a + span * (k + 1) / cols; let m = -1;
      while (i < src.length && src[i].t < tb) { const v = val(src[i]); if (fin(v) && v > m) m = v; i++; }
      const e = m >= 0 ? Math.SQRT2 * m : NaN;
      xs.push(a + span * (k + .5) / cols); env.push(e); if (fin(e)) amp = Math.max(amp, e);
    }
  }
  const pY = pasoBonito(Math.max(amp, 1) * 1.12 / 3), hi = Math.max(1, Math.ceil(Math.max(amp, .5) * 1.12 / pY) * pY), lo = -hi;
  const L = Math.max(L0 - 10, g.measureText(`-${hi}`).width + 16);
  const X = t => L + (t - a) * (R - L) / span, Y = v => B - (v - lo) * (B - T) / (hi - lo);
  // ---- ejes
  g.fillStyle = C.plot; g.fillRect(L, T, R - L, B - T);
  const pasoY = pasoBonito((hi - lo) / 6);
  g.textAlign = 'right';
  for (let v = Math.ceil(lo / pasoY) * pasoY; v <= hi + 1e-9; v += pasoY) {
    const y = Math.round(Y(v)) + .5, cero = Math.abs(v) < 1e-9;
    g.strokeStyle = cero ? C.muted : C.grid; g.lineWidth = cero ? 1.5 : 1;
    g.beginPath(); g.moveTo(L, y); g.lineTo(R, y); g.stroke();
    g.fillStyle = C.muted; g.fillText(niceTick(v), L - 8, y + fs * .35);
  }
  g.fillStyle = C.ink; g.font = `700 ${ft}px system-ui, sans-serif`; g.textAlign = 'left'; g.fillText('A', 8, T + ft);
  const unidad = span <= 3000 ? 'ms' : span <= 180000 ? 's' : 'min', paso = pasoTiempo(span, big ? 10 : 5, unidad);
  g.font = `600 ${ft}px system-ui, sans-serif`;
  for (let t = Math.ceil((a - rel) / paso) * paso; t <= b - rel + 1e-9; t += paso) {
    const x = Math.round(X(t + rel)) + .5; if (x < L - 1 || x > R + 1) continue;
    g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x, T); g.lineTo(x, B); g.stroke();
    g.fillStyle = C.muted; g.textAlign = x < L + 30 ? 'left' : x > R - 30 ? 'right' : 'center'; g.fillText(etiquetaT(t, unidad), x, h - 10);
  }
  g.fillStyle = C.ink; g.textAlign = 'right';
  g.fillText(unidad === 'min' ? 'min:s' : unidad, R, T + ft + 4);
  g.strokeStyle = C.line; g.lineWidth = 1; g.strokeRect(L + .5, T + .5, R - L - 1, B - T - 1);
  // ---- trazado
  g.save(); g.beginPath(); g.rect(L, T, R - L, B - T); g.clip();
  if (!comprimida) {
    g.setLineDash([6, 5]); g.strokeStyle = C.envol; g.lineWidth = 1.4;
    for (const s of [1, -1]) { g.beginPath(); let pen = false;
      env.forEach((e, k) => { if (!fin(e)) { pen = false; return; } const x = X(xs[k]), y = Y(s * e); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; }); g.stroke(); }
    g.setLineDash([]);
    g.strokeStyle = C.onda; g.lineWidth = big ? 2.8 : 2.2; g.lineJoin = 'round'; g.beginPath(); let pen = false;
    ys.forEach((v, k) => { if (!fin(v)) { pen = false; return; } const x = X(xs[k]), y = Y(v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; });
    g.stroke();
  } else {
    // banda rellena ±envolvente (a esta escala los ciclos de 60 Hz se funden en una banda)
    let seg = [];
    const pintar = () => { if (seg.length < 1) return;
      g.beginPath(); seg.forEach(([x, e], k) => k ? g.lineTo(x, Y(e)) : g.moveTo(x, Y(e)));
      for (let k = seg.length - 1; k >= 0; k--) g.lineTo(seg[k][0], Y(-seg[k][1]));
      g.closePath(); g.globalAlpha = .45; g.fillStyle = C.onda; g.fill(); g.globalAlpha = 1;
      g.strokeStyle = C.onda; g.lineWidth = 1.6;
      for (const s of [1, -1]) { g.beginPath(); seg.forEach(([x, e], k) => k ? g.lineTo(x, Y(s * e)) : g.moveTo(x, Y(s * e))); g.stroke(); }
      seg = []; };
    env.forEach((e, k) => { if (fin(e)) seg.push([X(xs[k]), e]); else pintar(); }); pintar();
    g.fillStyle = C.muted; g.font = `${fs - 1}px system-ui, sans-serif`; g.textAlign = 'left';
    g.fillText(`Vista comprimida: banda = ±√2·I RMS máx por intervalo${usarDec ? ' (bloques de 100 ms)' : ''}`, L + 8, B - 8);
  }
  g.restore();
  // ---- cursor
  const hx = hover[cv.id];
  if (hx != null && hx >= L && hx <= R) {
    const t = a + (hx - L) * span / (R - L);
    let txt, yMark = NaN;
    if (!comprimida) {
      const r = irmsEn(pts, t), i = fin(r) ? Math.SQRT2 * r * Math.sin(2 * Math.PI * W.f * (t - ref) / 1000) : NaN; yMark = i;
      txt = [`${etiquetaT(t - rel, unidad)} ${unidad === 'min' ? 'min:s' : unidad}`, `i equivalente: ${fmt(i, 2)} A`, `I RMS medida: ${fmt(r, 2)} A`];
    } else {
      const k = Math.max(0, Math.min(env.length - 1, Math.floor((t - a) / span * env.length))), e = env[k]; yMark = e;
      txt = [`${etiquetaT(t - rel, unidad)} ${unidad === 'min' ? 'min:s' : unidad}`, `pico equivalente: ${fmt(e, 2)} A`, `I RMS máx: ${fmt(e / Math.SQRT2, 2)} A`];
    }
    g.strokeStyle = C.muted; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(hx, T); g.lineTo(hx, B); g.stroke(); g.setLineDash([]);
    if (fin(yMark)) { g.fillStyle = C.onda; g.beginPath(); g.arc(hx, Y(yMark), 4.5, 0, 7); g.fill(); }
    g.font = `600 ${fs}px system-ui, sans-serif`;
    const lh = fs + 6, bw = Math.max(...txt.map(l => g.measureText(l).width)) + 20, bh = txt.length * lh + 10;
    let bx = hx + 12; if (bx + bw > R) bx = hx - bw - 12;
    g.globalAlpha = .95; g.fillStyle = C.panel; g.strokeStyle = C.line; g.beginPath(); g.roundRect ? g.roundRect(bx, T + 6, bw, bh, 6) : g.rect(bx, T + 6, bw, bh); g.fill(); g.stroke(); g.globalAlpha = 1;
    g.textAlign = 'left'; txt.forEach((l, k) => { g.fillStyle = k === 0 ? C.muted : k === 1 ? C.onda : C.ink; g.fillText(l, bx + 10, T + 6 + lh + k * lh); });
  }
}
function vacio(g, w, h, fs, txt){ g.fillStyle = C.muted; g.font = `${fs + 2}px system-ui, sans-serif`; g.textAlign = 'center'; g.fillText(txt, w / 2, h / 2); }

function drawAll(){
  const [t0, t1] = windowRange();
  const data = rows.slice(lowerBound(rows, t0 - 1000), lowerBound(rows, t1 + 1));
  const ext = (get) => { let mn = Infinity, mx = -Infinity; for (const r of data) { const v = get(r); if (fin(v)) { if (v < mn) mn = v; if (v > mx) mx = v; } } return [mn, mx]; };

  const [, vMax] = ext(r => Math.max(r.x ?? -1, r.y ?? -1, r.z ?? -1, r.vf ?? -1));
  drawChart($('cV'), {t0, t1, data, lo:0, hi:Math.max(cfg.vibAlt * 1.4, fin(vMax) ? vMax * 1.1 : 0), unit:'mg',
    zones:[{from:0,to:cfg.vibMed,color:C.ok},{from:cfg.vibMed,to:cfg.vibAlt,color:C.warn},{from:cfg.vibAlt,to:1e9,color:C.alarm}],
    series:[{label:'X',color:C.cx,get:r=>r.x,dec:1},{label:'Y',color:C.cy,get:r=>r.y,dec:1},{label:'Z',color:C.cz,get:r=>r.z,dec:1}]});

  const [tMin, tMax] = ext(r => r.T);
  const tlo = Math.min(20, fin(tMin) ? Math.floor(tMin / 5) * 5 : 20);
  const thi = Math.max(cfg.tCrit + 10, fin(tMax) ? Math.ceil(tMax / 5) * 5 + 5 : 0);
  drawChart($('cT'), {t0, t1, data, lo:tlo, hi:thi, unit:'°C',
    zones:[{from:-1e9,to:cfg.tWarn,color:C.ok},{from:cfg.tWarn,to:cfg.tHigh,color:C.warn},{from:cfg.tHigh,to:cfg.tCrit,color:C.alarm},{from:cfg.tCrit,to:1e9,color:C.crit}],
    lines:[{v:cfg.tCrit,color:C.crit,label:`Crítica ${cfg.tCrit} °C`}],
    series:[{label:'T',color:C.ct,get:r=>r.T,dec:1}]});
  $('tStats').textContent = fin(tMin) ? `mín ${tMin.toFixed(1)} · máx ${tMax.toFixed(1)} °C` : '';

  const [iMin, iMax] = ext(r => r.I);
  const pct = data.some(r => r.unit === '%');
  if (W.vista !== 'rms') dibujarOnda($('cW'));
  else drawChart($('cI'), {t0, t1, data, lo:0, hi: pct ? 100 : Math.max(cfg.iNom * 1.5, fin(iMax) ? iMax * 1.15 : 1), unit: pct ? '%' : 'A',
    lines: pct || !(cfg.iNom > 0) ? [] : [{v:cfg.iNom,color:C.warn,label:`Nominal ${cfg.iNom} A`}],
    series:[{label:'I',color:C.ci,get:r=>r.I,dec:2}]});
  $('iStats').textContent = fin(iMin) ? `mín ${iMin.toFixed(2)} · máx ${iMax.toFixed(2)} ${pct ? '%' : 'A'}` : '';
  // minigráficas del último minuto en las tarjetas
  const ult = rows.slice(lowerBound(rows, Date.now() - 60000));
  // suavizado (media móvil ≈ 2 s) y rango vertical mínimo para que el ruido no parezca una variación real
  minigrafica($('spI'), ult, r => r.I, C.ci, {k:20, rango:1.0});
  minigrafica($('spT'), ult, r => r.T, C.ct, {k:30, rango:4});
  minigrafica($('spV'), ult, r => r.vf, C.cx, {k:3, rango:5});
}
function mediaMovil(v, k){
  if (k <= 1) return v;
  const out = new Array(v.length); let s = 0, n = 0;
  for (let i = 0; i < v.length; i++) {                 // media móvil centrada que ignora huecos
    if (i === 0) {
      for (let j = 0; j <= Math.min(v.length - 1, k >> 1); j++) if (fin(v[j])) { s += v[j]; n++; }
    } else {
      const ent = i + (k >> 1), sal = i - (k >> 1) - 1;
      if (ent < v.length && fin(v[ent])) { s += v[ent]; n++; }
      if (sal >= 0 && fin(v[sal])) { s -= v[sal]; n--; }
    }
    out[i] = fin(v[i]) && n ? s / n : NaN;
  }
  return out;
}
function minigrafica(cv, data, get, color, op = {}){
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const v = mediaMovil(data.map(get), op.k || 1), ok = v.filter(fin);
  if (ok.length < 2) return;
  let lo = Math.min(...ok), hi = Math.max(...ok);
  const falta = (op.rango || 1e-6) - (hi - lo); if (falta > 0) { lo -= falta / 2; hi += falta / 2; }
  const t0 = Date.now() - 60000, X = t => (t - t0) / 60000 * w, Y = x => h - 3 - (x - lo) / (hi - lo) * (h - 6);
  const step = Math.max(1, Math.floor(data.length / w));
  g.beginPath(); let pen = false, x0 = 0, xl = 0;
  for (let i = 0; i < data.length; i += step) { if (!fin(v[i])) { pen = false; continue; } const x = X(data[i].ts), y = Y(v[i]); if (!pen) x0 = x; pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; xl = x; }
  g.strokeStyle = color; g.lineWidth = 1.6; g.stroke();
  g.lineTo(xl, h); g.lineTo(x0, h); g.closePath(); g.globalAlpha = .12; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
  const last = data.length - 1;
  if (fin(v[last])) { g.fillStyle = color; g.beginPath(); g.arc(X(data[last].ts), Y(v[last]), 2.6, 0, 7); g.fill(); }
}
let lastDraw = 0;
function frame(ts){
  // tiempo real: ~30 cuadros por segundo con desplazamiento continuo del eje de tiempo
  if ((dirty || (!st.paused && (rows.length || W.pts.length))) && ts - lastDraw > 30) { dirty = false; lastDraw = ts; drawAll(); }
  requestAnimationFrame(frame);
}
for (const id of ['cV','cT','cI','cW']) {
  const cv = $(id);
  cv.addEventListener('pointermove', e => { hover[id] = e.offsetX; dirty = true; });
  cv.addEventListener('pointerleave', () => { delete hover[id]; dirty = true; });
}

/* ---------- MQTT mínimo sobre WebSocket (igual al firmware) ---------- */
let ws = null, wsWanted = false, subscribed = false;
const enc = new TextEncoder(), dec = new TextDecoder();
const field = s => { const b = enc.encode(s); return [b.length >> 8, b.length & 255, ...b]; };
function packet(type, body){ let n = body.length; const head = [type];
  do { let k = n % 128; n = Math.floor(n / 128); head.push(k | (n ? 128 : 0)); } while (n);
  return Uint8Array.from([...head, ...body]); }
function setConn(txt, cls){ const p = $('conn'); p.textContent = txt; p.className = 'pill ' + (cls || ''); }
function mqttConnect(){
  wsWanted = true; subscribed = false; setConn('Conectando al broker MQTT…');
  const sock = new WebSocket(BROKER, 'mqtt'); ws = sock; sock.binaryType = 'arraybuffer';
  let pending = new Uint8Array(0);
  sock.onopen = () => sock.send(packet(16, [...field('MQTT'), 4, 2, 0, 30, ...field('mon-' + Math.random().toString(16).slice(2, 14))]));
  sock.onmessage = e => {
    const b = new Uint8Array(e.data), a = new Uint8Array(pending.length + b.length); a.set(pending); a.set(b, pending.length);
    let p = 0;
    while (p < a.length) {
      const start = p, hd = a[p++]; let size = 0, mul = 1, v;
      do { if (p >= a.length) { pending = a.slice(start); return; } v = a[p++]; size += (v & 127) * mul; mul *= 128; } while (v & 128);
      if (p + size > a.length) { pending = a.slice(start); return; }
      const d = a.subarray(p, p + size); p += size;
      const type = hd >> 4;
      if (type === 2) { if (d[1] !== 0) { sock.close(); return; } sock.send(packet(130, [0, 1, ...field(TOPIC), 0, ...field(TOPIC_I), 0])); }
      if (type === 9) { if (d[2] === 128) { sock.close(); return; } subscribed = true; setConn('Esperando al ESP32…', 'warn'); }
      if (type === 3 && !(hd & 1)) {
        const n = (d[0] << 8) + d[1], tp = dec.decode(d.subarray(2, 2 + n)), txt = dec.decode(d.subarray(2 + n));
        if (tp === TOPIC) parseMsg(txt); else if (tp === TOPIC_I) parseLote(txt);
      }
    }
    pending = new Uint8Array(0);
  };
  sock.onerror = () => sock.close();
  sock.onclose = () => { if (ws !== sock) return; subscribed = false; ws = null;
    if (wsWanted) { setConn('Broker desconectado · reintentando…', 'warn'); setTimeout(() => wsWanted && !ws && mqttConnect(), 3000); } };
}
function mqttStop(){ wsWanted = false; const s = ws; ws = null; if (s) try { s.close(); } catch {} }
setInterval(() => { if (ws?.readyState === 1) ws.send(packet(192, [])); }, 12000);

function parseMsg(s){
  const f = s.trim().split(',');
  if (![6, 11, 17].includes(f.length) || !/^[a-f0-9]{8}$/.test(f[0])) return;
  const n = v => (v === '' || /nan|inf/i.test(v)) ? null : (fin(Number(v)) ? Number(v) : null);
  const seq = n(f[1]), t = n(f[2]);
  if (!Number.isSafeInteger(seq) || !fin(t) || seq < 0) return;
  const multi = f.length >= 11, full = f.length === 17;
  if (multi && !['A','P'].includes(f[10])) return;
  if (f[0] !== st.session) { st.session = f[0]; st.lastSeq = -1; }
  if (seq <= st.lastSeq) return;
  if (st.lastSeq >= 0) st.missing += seq - st.lastSeq - 1;
  st.lastSeq = seq;
  if (st.mode !== 'live') return;
  ingest({origen:'ESP32', sess:f[0], seq, t, x:n(f[3]), y:n(f[4]), z:n(f[5]),
    I: multi ? n(f[6]) : null, Ipk: multi ? n(f[8]) : null, unit: multi ? (f[10] === 'A' ? 'A' : '%') : '',
    T: multi ? n(f[9]) : null, V: full ? n(f[11]) : null,
    ang: full ? [n(f[12]), n(f[13]), n(f[14])] : [null, null, null],
    fase: full ? n(f[15]) : null, estado: full ? n(f[16]) : null});
}

// lote de corriente: sesion,seq,t0_ms,dt_ms,i1,i2,...
function parseLote(s){
  if (st.mode !== 'live') return;
  const f = s.trim().split(',');
  if (f.length < 5 || !/^[a-f0-9]{8}$/.test(f[0])) return;
  const t0 = Number(f[2]), dt = Number(f[3]);
  if (!fin(t0) || !(dt > 0)) return;
  W.ultLote = performance.now(); onLote(t0, dt, f.slice(4).map(v => /nan|inf/i.test(v) || v === '' ? NaN : Number(v)));
}

/* ---------- simulador (modo Demo) ---------- */
const SCEN = {
  normal:        {I:1.6, T:48,  v:[3.0, 5.0, 2.4],  est:4, txt:'Operación normal'},
  desalineacion: {I:1.8, T:55,  v:[15,  9.0, 5.0],  est:5, txt:'Eje desalineado'},
  vibracion:     {I:1.9, T:58,  v:[7.5, 26,  12],   est:3, txt:'Vibración alta'},
  calentamiento: {I:2.3, T:108, v:[4.0, 6.0, 3.0],  est:4, txt:'Sobrecalentamiento'},
  parada:        {I:0,   T:26,  v:[0,   0,   0],    est:1, txt:'Motor detenido'}
};
const AUTO = ['normal','desalineacion','vibracion','calentamiento','parada'];
const sim = {timer:null, t:0, seq:0, T:30, I:0, v:[0,0,0], peak:0, scen:'auto'};
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
function simStep(){
  sim.t += 100; sim.seq++;
  const key = sim.scen === 'auto' ? AUTO[Math.floor(sim.t / 20000) % AUTO.length] : sim.scen;
  const P = SCEN[key];
  $('scenNow').textContent = sim.scen === 'auto' ? `Fase actual: ${P.txt}` : '';
  sim.T += (P.T - sim.T) * (key === 'calentamiento' ? 0.012 : 0.006) + gauss() * 0.04;
  // corriente cada 2 ms con arranque directo: pico ≈ 6 × régimen que decae (τ ≈ 160 ms)
  const parado = P.I === 0 || sim.t < (sim.forzarParo || 0), lote = [];
  for (let k = 0; k < 50; k++) {
    const tt = sim.t - 100 + k * 2;
    if (parado) { sim.on = false; sim.Ic = (sim.Ic || 0) * Math.exp(-2 / 40); }
    else {
      if (!sim.on) { sim.on = true; sim.tOn = tt; }
      const e = tt - sim.tOn;
      sim.Ic = P.I * (1 + 0.02 * Math.sin(tt / 700)) + 5 * P.I * Math.exp(-e / 160) * (1 - Math.exp(-e / 10)) + gauss() * 0.02;
    }
    lote.push(Math.max(0, sim.Ic) + 0.55 + gauss() * 0.03);   // desplazamiento en reposo como el JXK-10 real (~0,55 A)
  }
  W.ultLote = performance.now(); onLote(sim.t - 100, 2, lote);
  const I = lote.reduce((a, b) => a + b, 0) / lote.length;
  sim.v = sim.v.map((v,i) => v + (P.v[i] - v) * 0.1);
  const xyz = sim.v.map(v => v > 0.05 ? Math.max(0, v * (1 + 0.12 * gauss())) : 0);
  sim.peak = Math.max(sim.peak, I);
  ingest({origen:'SIMULADO', sess:'demo', seq:sim.seq, t:sim.t, x:xyz[0], y:xyz[1], z:xyz[2],
    I, Ipk:sim.peak, unit:'A', T:sim.T, V:(4 + 16 * I / 25) * 119 / 1000,
    ang:[gauss()*0.2, gauss()*0.2, gauss()*0.2], fase: I > 0.1 ? 1 : 0, estado: I > 0.1 ? P.est : 1});
}

/* ---------- modo ---------- */
function resetFilters(){
  st.vibEma = null; st.ax = [null,null,null]; st.misCnt = 0; st.mis = false;
  st.lv = {vib:null, temp:null, cur:null, mis:false}; st.peak = null; st.tmax = null;
}
function setMode(mode){
  st.mode = mode; resetFilters();
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  $('demoBar').hidden = mode !== 'demo';
  clearInterval(sim.timer); sim.timer = null;
  W.pts.length = 0; W.dec.length = 0; W.blk = null; W.lastT = -1; W.quiet = 0; W.cap = null;
  W.det = {base:NaN, ruido:0, sobre:0, tIni:0, ultimoFin:-Infinity}; W.ultLote = -Infinity;
  if (mode === 'demo') { mqttStop(); setConn('● Simulación', 'demo'); sim.forzarParo = sim.t + 800; sim.timer = setInterval(simStep, 100); }
  else { st.lastAt = 0; mqttConnect(); }
}
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => st.mode !== b.dataset.mode && setMode(b.dataset.mode));
$('scenario').onchange = e => { sim.scen = e.target.value; if (sim.scen !== 'auto') { sim.t = 0; sim.forzarParo = 800; } };

$('simArranque').onclick = () => { sim.forzarParo = sim.t + 1200; };   // parada de 1,2 s y nuevo arranque

/* ---------- controles de la onda de corriente ---------- */
document.querySelectorAll('[data-iv]').forEach(b => b.onclick = () => {
  W.vista = b.dataset.iv;
  document.querySelectorAll('[data-iv]').forEach(x => x.classList.toggle('on', x === b));
  $('cW').hidden = W.vista === 'rms'; $('cI').hidden = W.vista !== 'rms';
  $('ondaOpc').hidden = W.vista === 'rms'; $('ondaCapBox').hidden = W.vista !== 'arranque';
  dirty = true;
});
$('ondaVen').onchange = e => { W.ven = e.target.value === 'all' ? Infinity : Number(e.target.value); dirty = true; };
$('capDur').value = String(W.dur);
$('capDur').onchange = e => { W.dur = Number(e.target.value); try { localStorage.setItem('mc-capdur', W.dur); } catch {} };
$('ondaF').onchange = e => { W.f = Number(e.target.value); dirty = true; };
$('ondaCap').onchange = () => { mostrarStats(); dirty = true; };
$('capturar').onclick = () => { if (W.lastT >= 0 && !W.cap) iniciarCaptura(W.lastT, false); };
$('borrarCap').onclick = () => {
  const i = Number($('ondaCap').value) || 0, c = W.caps[i]; if (!c) return;
  if (!confirm(`¿Borrar definitivamente la captura del ${new Date(c.ts).toLocaleString('es')} (${c.imax.toFixed(2)} A)? Descárguela antes si la necesita.`)) return;
  W.caps.splice(i, 1); guardarCapturas(); pintarCapturas(0);
};
$('dlOnda').onclick = () => {
  const c = W.caps[Number($('ondaCap').value) || 0]; if (!c) return;
  const out = ['﻿t_ms;I_RMS_medida_A;i_equivalente_A;nota'];
  c.pts.forEach((p, k) => out.push([ (p.t - c.trig).toFixed(0), fin(p.v) ? p.v.toFixed(3) : '',
    fin(p.v) ? (Math.SQRT2 * p.v * Math.sin(2 * Math.PI * W.f * (p.t - c.trig) / 1000)).toFixed(3) : '',
    k === 0 ? `"i_equivalente = raiz(2)*I_RMS*sen(2*pi*${W.f}*t): onda calculada, el JXK-10 mide valor RMS"` : ''].join(';')));
  download(`motor_arranque_${fileStamp()}.csv`, out.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
};

/* ---------- controles ---------- */
document.querySelectorAll('[data-win]').forEach(b => b.onclick = () => {
  st.win = b.dataset.win === 'all' ? 'all' : Number(b.dataset.win);
  document.querySelectorAll('[data-win]').forEach(x => x.classList.toggle('on', x === b)); dirty = true;
});
$('pauseBtn').onclick = () => {
  st.paused = !st.paused; st.pauseAt = Date.now();
  $('pauseBtn').textContent = st.paused ? '▶ Reanudar gráficas' : '❚❚ Pausar gráficas';
  $('pauseBtn').classList.toggle('active', st.paused); dirty = true;
};
$('ackBtn').onclick = () => { events.forEach(e => e.ack = true); renderLog(); };
$('printBtn').onclick = () => print();
$('clearBtn').onclick = () => {
  if (!rows.length && !events.length) return;
  if (!confirm('¿Borrar todas las muestras y eventos de esta sesión? Descargue los datos antes si los necesita.')) return;
  rows.length = 0; events.length = 0; st.missing = 0; resetFilters(); renderLog();
  W.pts.length = 0; W.dec.length = 0; W.blk = null; W.cap = null; W.lastT = -1;   // las capturas de arranque se conservan
  $('nRows').textContent = '0 muestras'; $('nLoss').textContent = ''; ['dlCsv','dlJson'].forEach(id => $(id).disabled = true); dirty = true;
};
function applyTheme(t){ document.documentElement.dataset.theme = t; store.set('mc-theme', t); readColors(); dirty = true; }
$('themeBtn').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* configuración */
const form = $('cfg');
function fillCfg(){ form.querySelectorAll('[data-k]').forEach(i => i.type === 'checkbox' ? i.checked = !!cfg[i.dataset.k] : i.value = cfg[i.dataset.k]); }
form.addEventListener('change', () => {
  const next = {...cfg};
  form.querySelectorAll('[data-k]').forEach(i => {
    const k = i.dataset.k;
    next[k] = i.type === 'checkbox' ? i.checked : i.tagName === 'SELECT' ? i.value : Number(i.value);
  });
  const msg = $('cfgMsg');
  const nums = ['vibMed','vibAlt','ratio','tWarn','tHigh','tCrit','iNom'];
  let err = nums.some(k => !fin(next[k])) ? 'Complete todos los campos numéricos.' :
    !(next.vibMed > 0 && next.vibMed < next.vibAlt) ? 'La vibración media debe ser mayor que 0 y menor que la alta.' :
    !(next.tWarn < next.tHigh && next.tHigh < next.tCrit) ? 'Las temperaturas deben cumplir: precaución < alta < crítica.' :
    !(next.ratio > 0) ? 'La relación axial/radial debe ser mayor que 0.' : '';
  if (err) { msg.textContent = err; msg.className = 'note err'; return; }
  cfg = next; store.set('mc-cfg', JSON.stringify(cfg));
  msg.textContent = 'Umbrales aplicados y guardados en este navegador.'; msg.className = 'note';
  st.lv = {vib:null, temp:null, cur:null, mis:st.mis};
  buildThermo(); buildScale(); if (rows.length) updateUI(rows.at(-1)); dirty = true;
});
$('cfgReset').onclick = () => { cfg = {...DEF}; store.set('mc-cfg', JSON.stringify(cfg)); fillCfg(); buildThermo(); buildScale(); dirty = true;
  $('cfgMsg').textContent = 'Umbrales restablecidos a los valores de referencia.'; $('cfgMsg').className = 'note'; };

/* ---------- descargas ---------- */
function download(name, content, type){
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const c = (v,d=3) => fin(v) ? String(+v.toFixed(d)) : '';
$('dlCsv').onclick = () => {
  const head = ['fecha_hora_local','timestamp_ms','origen','sesion','secuencia','t_dispositivo_ms',
    'vib_X_mg','vib_Y_mg','vib_Z_mg','vib_global_mg','vib_global_filtrada_mg','nivel_vibracion','relacion_axial_radial','eje_desalineado',
    'corriente','unidad_corriente','corriente_pico','estado_corriente','temperatura_C','nivel_temperatura',
    'GPIO4_V','inclin_X_deg','inclin_Y_deg','inclin_Z_deg','fase_estimada','estado_firmware'];
  const out = ['﻿' + head.join(';')];
  for (const r of rows) out.push([stamp(r.ts), r.ts, r.origen, r.sesion, r.seq ?? '', r.tms ?? '',
    c(r.x), c(r.y), c(r.z), c(r.mag), c(r.vf), r.vibLv ? VIB[r.vibLv][0] : '', c(r.ratio), r.mis ? 'SI' : 'NO',
    c(r.I), r.unit, c(r.Ipk), r.cLv ? CUR[r.cLv][0] : '', c(r.T,2), r.tLv ? TMP[r.tLv][0] : '',
    c(r.V), c(r.ang?.[0],2), c(r.ang?.[1],2), c(r.ang?.[2],2),
    fin(r.fase) ? FASES[r.fase] ?? '' : '', fin(r.estado) ? ESTADOS_FW[r.estado] ?? '' : ''].join(';'));
  download(`motor_datos_${fileStamp()}.csv`, out.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
};
$('dlEv').onclick = () => {
  const out = ['﻿fecha_hora_local;variable;nivel;severidad;mensaje;reconocido'];
  for (const e of events) out.push([stamp(e.ts), e.variable, e.lv, e.sev, '"' + e.msg.replace(/"/g, '""') + '"', e.ack ? 'SI' : 'NO'].join(';'));
  download(`motor_alarmas_${fileStamp()}.csv`, out.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
};
$('dlJson').onclick = () => {
  download(`motor_sesion_${fileStamp()}.json`, JSON.stringify({
    generado: new Date().toISOString(), umbrales: cfg, muestras_perdidas: st.missing,
    eventos: events.map(e => ({...e, fecha: stamp(e.ts)})),
    muestras: rows.map(r => ({...r, fecha: stamp(r.ts)}))
  }, null, 1), 'application/json');
};

/* ---------- reloj y vigilancia de conexión ---------- */
setInterval(() => {
  $('clock').textContent = new Date().toLocaleString('es', {dateStyle:'medium', timeStyle:'medium'});
  if (st.mode !== 'live') return;
  const stale = !st.lastAt || Date.now() - st.lastAt > 3000;
  document.querySelectorAll('.kpi').forEach(k => k.classList.toggle('stale', stale && rows.length > 0));
  if (!subscribed) return;
  if (!st.lastAt) setConn('Esperando al ESP32… (pruebe el modo Demo)', 'warn');
  else if (stale) setConn('Sin muestras recientes', 'warn');
  else setConn('● Recibiendo en vivo', 'live');
}, 1000);

/* ---------- motor 3D, asistente de voz y resumen de sesión ---------- */
let ultimoArranque = null;
const inicioSesion = Date.now();
function fijarVista(v){
  const tres = v === '3d' && window.M3D?.activo;
  $('vista3d').hidden = !tres; $('motor').hidden = tres;
  document.querySelectorAll('[data-vista]').forEach(b => b.classList.toggle('on', b.dataset.vista === (tres ? '3d' : '2d')));
  store.set('mc-vista', tres ? '3d' : '2d');
}
document.querySelectorAll('[data-vista]').forEach(b => b.onclick = () => fijarVista(b.dataset.vista));
const hay3d = window.M3D?.iniciar($('vista3d'));
if (!hay3d) { document.querySelector('[data-vista="3d"]').disabled = true; document.querySelector('[data-vista="3d"]').title = 'WebGL o Three.js no disponible'; }
fijarVista(store.get('mc-vista') || '3d');
$('b3Reset').onclick = () => window.M3D?.vistaInicial();
let giroAuto = false;
$('b3Auto').onclick = () => { giroAuto = !giroAuto; window.M3D?.auto(giroAuto); $('b3Auto').classList.toggle('active', giroAuto); };
function pintarVoz(){
  const V = window.Voz, b = $('vozBtn');
  if (!V?.disponible) { b.textContent = '🔇 Sin voz'; b.disabled = true; $('rsVoz').textContent = 'No disponible'; return; }
  b.textContent = V.activa ? '🔊 Voz' : '🔇 Voz'; b.classList.toggle('active', V.activa);
  $('rsVoz').textContent = !V.activa ? 'Silenciado' : V.lista ? 'Activo' : 'Toque la página';
}
if (window.Voz) Voz.onCambio = pintarVoz;
$('vozBtn').onclick = () => { if (Voz.alternar()) Voz.probar(); pintarVoz(); };
pintarVoz();
const dur = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
setInterval(() => {
  $('rsSesion').textContent = dur(Date.now() - inicioSesion);
  $('rsMuestras').textContent = rows.length.toLocaleString('es');
  $('rsArranque').textContent = ultimoArranque ? `${hms(ultimoArranque.ts)} · ${ultimoArranque.imax.toFixed(1)} A` : '—';
  const n = events.filter(e => !e.ack).length; $('rsAlarmas').textContent = n;
  $('rsAlarmas').parentElement.dataset.lv = n ? 'crit' : 'ok';
}, 1000);

/* ---------- inicio ---------- */
applyTheme(store.get('mc-theme') || 'dark');
cargarCapturas(); pintarCapturas(0); if (W.caps[0]) ultimoArranque = W.caps[0];
fillCfg(); buildThermo(); buildScale(); renderLog();
addEventListener('resize', () => dirty = true);
requestAnimationFrame(frame);
setMode('live');
})();
