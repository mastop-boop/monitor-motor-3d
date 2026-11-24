'use strict';
/* Asistente de voz para alarmas (Web Speech API + tono sintetizado).
   Voz sintética del navegador con tono grave y fraseo de asistente; no reproduce la voz de ningún actor.
   Los navegadores solo permiten audio tras una interacción: la voz se habilita con el primer clic. */
window.Voz = (() => {
  const ss = window.speechSynthesis;
  let activa = true, lista = false, voz = null, actx = null;
  const ultimo = new Map();
  try { activa = localStorage.getItem('mc-voz') !== '0'; } catch {}
  const num = (v, d = 1) => Number.isFinite(v) ? v.toFixed(d).replace('.', ',') : 'sin dato';

  function elegirVoz(){
    if (!ss) return;
    const vs = ss.getVoices().filter(v => /^es/i.test(v.lang));
    const pref = [/pablo|alvaro|álvaro|jorge|raul|raúl|diego|enrique|carlos|male|hombre/i, /google/i, /es-(es|mx|us)/i];
    for (const re of pref) { const v = vs.find(x => re.test(x.name) || re.test(x.lang)); if (v) { voz = v; return; } }
    voz = vs[0] || null;
  }
  if (ss) { elegirVoz(); ss.onvoiceschanged = elegirVoz; }

  function desbloquear(){
    if (lista) return;
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch {}
    lista = true; onCambio();
  }
  ['pointerdown', 'keydown'].forEach(e => addEventListener(e, desbloquear, {once:true, capture:true}));

  // tono de aviso: dos o tres notas suaves (más agudas y repetidas si es crítico)
  function tono(sev){
    if (!actx) return 0;
    const notas = sev === 'crit' ? [880, 660, 880, 660] : sev === 'alarm' ? [740, 988] : sev === 'ok' ? [660, 880] : [587, 784];
    const t0 = actx.currentTime + 0.02;
    notas.forEach((f, i) => {
      const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.16;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.16);
    });
    return notas.length * 160 + 120;
  }
  function hablar(texto, sev = 'warn'){
    if (!activa || !lista) return false;
    const clave = texto.replace(/[\d,]+/g, '#');
    if (Date.now() - (ultimo.get(clave) || 0) < 20000) return false;        // no repetir el mismo aviso en 20 s
    ultimo.set(clave, Date.now());
    const espera = tono(sev);
    if (!ss) return true;
    if (sev === 'crit') ss.cancel();
    setTimeout(() => {
      const u = new SpeechSynthesisUtterance(texto);
      if (voz) u.voice = voz;
      u.lang = voz?.lang || 'es-ES'; u.pitch = 0.78; u.rate = 1.02; u.volume = 1;
      ss.speak(u);
    }, espera);
    return true;
  }
  /* composición del mensaje a partir del evento y de la última medición */
  function evento(variable, nivel, sev, r){
    if (!['warn', 'alarm', 'crit'].includes(sev) && !(variable === 'Corriente' && nivel === 'Arranque') && !(variable === 'Eje' && nivel === 'Alineado')) return;
    r = r || {};
    let t = '';
    if (variable === 'Vibración') t = nivel === 'Alta'
      ? `Alerta. Vibración alta en el motor: ${num(r.vf)} miligramos. Sugiero inspeccionar el anclaje, los rodamientos y el balanceo.`
      : `Atención, señor. La vibración subió a nivel medio: ${num(r.vf)} miligramos. Vigilaré la tendencia.`;
    else if (variable === 'Eje') t = nivel === 'Desalineado'
      ? 'Alerta. He detectado desalineación del eje: la vibración axial predomina sobre la radial. Recomiendo revisar el acople.'
      : 'La alineación del eje se ha normalizado.';
    else if (variable === 'Temperatura') t = nivel === 'Crítica'
      ? `Alerta crítica. El bobinado alcanzó ${num(r.T)} grados. Recomiendo detener el motor de inmediato.`
      : nivel === 'Alta' ? `Alerta. Temperatura alta en el bobinado: ${num(r.T)} grados. Reduzca la carga y verifique la ventilación.`
      : `Atención, señor. La temperatura del bobinado llegó a ${num(r.T)} grados.`;
    else if (variable === 'Corriente' && nivel === 'Arranque') t = `Arranque registrado. Corriente máxima de ${num(r.imax, 1)} amperios${Number.isFinite(r.ireg) ? `, régimen de ${num(r.ireg, 1)} amperios` : ''}.`;
    else if (variable === 'Corriente') t = `Atención. La corriente supera la nominal: ${num(r.I, 2)} amperios.`;
    else return;
    hablar(t, nivel === 'Alineado' || nivel === 'Arranque' ? 'ok' : sev);
  }
  let onCambio = () => {};
  return {
    evento, hablar,
    probar(){ desbloquear(); const a = activa; activa = true; ultimo.clear(); hablar('Sistema de monitoreo en línea. Supervisando corriente, temperatura y vibración del motor.', 'ok'); activa = a; },
    alternar(){ activa = !activa; try { localStorage.setItem('mc-voz', activa ? '1' : '0'); } catch {} if (!activa) ss?.cancel(); desbloquear(); onCambio(); return activa; },
    get activa(){ return activa; }, get lista(){ return lista; }, get disponible(){ return !!ss; },
    set onCambio(f){ onCambio = f; }
  };
})();
