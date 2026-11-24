'use strict';
/* Motor de inducción en 3D (Three.js r128 + OrbitControls).
   API: M3D.iniciar(contenedor) → bool · M3D.actualizar({T, color, nivelT, girando, vib, mis}) · M3D.vistaInicial() · M3D.auto(bool) */
window.M3D = (() => {
  let ok = false, renderer, scene, cam, ctl, cont, reloj;
  let motor, carcasa = [], eje, acopleM, carga, acopleC, placaTex, placaCtx, anilloMis, sensorV;
  const est = {T:NaN, color:'#6b7a88', nivelT:'off', girando:false, vib:'baja', mis:false, txtT:''};
  const GLOW = {ok:0.05, warn:0.18, alarm:0.32, crit:0.5, off:0};
  const VIB = {baja:0, media:0.012, alta:0.035};

  function mat(color, opt = {}){ return new THREE.MeshStandardMaterial({color, metalness:.35, roughness:.5, ...opt}); }
  function cil(r, l, m, seg = 48){ const g = new THREE.CylinderGeometry(r, r, l, seg); g.rotateZ(Math.PI / 2); return new THREE.Mesh(g, m); }

  function construir(){
    const acero = mat(0x9aa6b2, {metalness:.8, roughness:.3}), aceroOsc = mat(0x4b5662, {metalness:.7, roughness:.45});
    const pintura = mat(est.color), pinturaOsc = mat(est.color);
    carcasa = [pintura, pinturaOsc];
    motor = new THREE.Group();
    // carcasa con aletas axiales
    const cuerpo = cil(1, 2.6, pintura, 64); motor.add(cuerpo);
    for (let i = 0; i < 30; i++) {
      const a = i / 30 * Math.PI * 2;
      if (Math.abs(Math.sin(a) + 1) < 0.25) continue;                 // sin aletas en la zona de las patas
      const f = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.17, 0.035), pintura);
      f.position.set(0, Math.sin(a) * 1.06, Math.cos(a) * 1.06); f.rotation.x = Math.PI / 2 - a; motor.add(f);
    }
    // escudos y tapa del ventilador
    for (const x of [-1.36, 1.36]) { const e = cil(1.03, 0.14, pinturaOsc, 64); e.position.x = x; motor.add(e); }
    const tapa = cil(0.98, 0.6, pinturaOsc, 64); tapa.position.x = -1.75; motor.add(tapa);
    const rejilla = new THREE.Mesh(new THREE.CircleGeometry(0.96, 48), mat(0x1c2430, {roughness:.8}));
    rejilla.rotation.y = -Math.PI / 2; rejilla.position.x = -2.06; motor.add(rejilla);
    for (const r of [0.25, 0.45, 0.65, 0.85]) {
      const t = new THREE.Mesh(new THREE.TorusGeometry(r, 0.025, 8, 48), aceroOsc); t.rotation.y = Math.PI / 2; t.position.x = -2.065; motor.add(t);
    }
    // caja de bornes y placa con temperatura
    const caja = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.42, 0.62), pintura); caja.position.set(0.15, 1.18, 0); motor.add(caja);
    const tapaCaja = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.05, 0.67), pinturaOsc); tapaCaja.position.set(0.15, 1.41, 0); motor.add(tapaCaja);
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128; placaCtx = cv.getContext('2d');
    placaTex = new THREE.CanvasTexture(cv);
    const placa = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), new THREE.MeshBasicMaterial({map:placaTex}));
    placa.position.set(0.1, 0.05, 1.105); motor.add(placa); pintarPlaca();
    // patas
    for (const x of [-0.8, 0.8]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 1.9), pintura); p.position.set(x, -0.95, 0); motor.add(p);
    }
    // rodamiento, sensor ADXL345 y sonda NTC
    const rod = cil(0.36, 0.22, acero); rod.position.x = 1.54; motor.add(rod);
    sensorV = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.2), mat(0xc0352b, {emissive:0x400000})); sensorV.position.set(1.54, 0.4, 0); motor.add(sensorV);
    const ntc = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16), mat(0x3dd6c6, {emissive:0x0a4a44})); ntc.position.set(-0.6, 0.72, 0.75); motor.add(ntc);
    // eje y acople (giran)
    eje = new THREE.Group();
    eje.add(cil(0.12, 1.0, acero)); eje.children[0].position.x = 2.1;
    const chav = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.06), aceroOsc); chav.position.set(2.15, 0.12, 0); eje.add(chav);
    acopleM = cil(0.32, 0.2, mat(0x55616d, {metalness:.7})); acopleM.position.x = 2.55; eje.add(acopleM);
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2, b = cil(0.035, 0.26, acero, 12); b.position.set(2.62, Math.sin(a) * 0.23, Math.cos(a) * 0.23); eje.add(b); }
    motor.add(eje);
    // lado de la carga (se inclina si hay desalineación)
    carga = new THREE.Group(); carga.position.x = 2.66;
    acopleC = cil(0.32, 0.2, mat(0x55616d, {metalness:.7})); acopleC.position.x = 0.11; carga.add(acopleC);
    const ejeC = cil(0.12, 0.9, acero); ejeC.position.x = 0.62; carga.add(ejeC);
    const chumacera = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.55, 0.6), aceroOsc); chumacera.position.set(0.85, -0.45, 0); carga.add(chumacera);
    anilloMis = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.03, 8, 48), new THREE.MeshBasicMaterial({color:0xff3b3b, transparent:true, opacity:0}));
    anilloMis.rotation.y = Math.PI / 2; anilloMis.position.x = 0.05; carga.add(anilloMis);
    // base
    const base = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.14, 2.5), aceroOsc); base.position.set(0.6, -1.3, 0);
    base.receiveShadow = true;
    motor.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(motor, carga, base);
    carga.userData.y0 = 0;
  }
  function pintarPlaca(){
    const g = placaCtx; g.fillStyle = '#e9eef2'; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = '#7d8a97'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 122);
    g.fillStyle = '#53616d'; g.font = 'bold 22px system-ui'; g.textAlign = 'center'; g.fillText('TEMP. BOBINADO', 128, 38);
    g.fillStyle = '#14202b'; g.font = 'bold 54px system-ui'; g.fillText(est.txtT || '— °C', 128, 102);
    placaTex.needsUpdate = true;
  }

  function iniciar(el){
    if (typeof THREE === 'undefined' || !THREE.OrbitControls) return false;
    cont = el;
    try {
      renderer = new THREE.WebGLRenderer({antialias:true, alpha:true});
    } catch { return false; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    cont.prepend(renderer.domElement);
    scene = new THREE.Scene();
    cam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x1a2230, 0.85));
    const sol = new THREE.DirectionalLight(0xffffff, 0.95); sol.position.set(4, 7, 6); sol.castShadow = true;
    sol.shadow.mapSize.set(1024, 1024); Object.assign(sol.shadow.camera, {left:-5, right:5, top:5, bottom:-5}); scene.add(sol);
    const borde = new THREE.DirectionalLight(0x3dd6c6, 0.45); borde.position.set(-6, 3, -5); scene.add(borde);
    const grid = new THREE.GridHelper(14, 28, 0x2c4556, 0x1a2938); grid.position.y = -1.38; grid.material.transparent = true; grid.material.opacity = .5; scene.add(grid);
    construir();
    ctl = new THREE.OrbitControls(cam, renderer.domElement);
    ctl.enableDamping = true; ctl.dampingFactor = .08; ctl.minDistance = 3.5; ctl.maxDistance = 14;
    ctl.maxPolarAngle = Math.PI * 0.62; ctl.autoRotateSpeed = 1.2;
    vistaInicial();
    new ResizeObserver(ajustar).observe(cont); ajustar();
    reloj = new THREE.Clock(); ok = true;
    renderer.setAnimationLoop(cuadro);
    return true;
  }
  function ajustar(){ const w = cont.clientWidth, h = cont.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
  function vistaInicial(){ cam.position.set(4.2, 2.6, 6.2); ctl.target.set(0.5, -0.1, 0); ctl.update(); }
  function auto(on){ ctl.autoRotate = on; }

  let ang = 0, vel = 0;
  function cuadro(){
    const dt = Math.min(reloj.getDelta(), 0.05), t = reloj.elapsedTime;
    if (document.hidden || !cont.offsetParent) return;
    // giro con aceleración suave
    vel += ((est.girando ? 14 : 0) - vel) * Math.min(1, dt * 1.5);
    ang += vel * dt; eje.rotation.x = ang;
    acopleC.rotation.x = ang;
    // vibración
    const a = VIB[est.vib] || 0;
    motor.position.set((Math.random() - .5) * a, (Math.random() - .5) * a, (Math.random() - .5) * a);
    // desalineación
    const objZ = est.mis ? -0.07 : 0, objY = est.mis ? 0.05 : 0;
    carga.rotation.z += (objZ - carga.rotation.z) * Math.min(1, dt * 3);
    carga.position.y += (objY - carga.position.y) * Math.min(1, dt * 3);
    anilloMis.material.opacity = est.mis ? 0.55 + 0.45 * Math.sin(t * 8) : 0;
    acopleC.material.emissive.setHex(est.mis ? 0x550000 : 0x000000);
    // brillo térmico
    const k = GLOW[est.nivelT] ?? 0, pulso = est.nivelT === 'crit' ? 0.6 + 0.4 * Math.sin(t * 6) : 1;
    for (const m of carcasa) m.emissiveIntensity = k * pulso;
    sensorV.material.emissiveIntensity = est.vib === 'baja' ? .3 : 0.6 + 0.4 * Math.sin(t * 10);
    ctl.update(); renderer.render(scene, cam);
  }
  function actualizar(s){
    if (!ok) return;
    const c = new THREE.Color(s.color);
    carcasa[0].color.copy(c); carcasa[1].color.copy(c).multiplyScalar(0.78);
    for (const m of carcasa) m.emissive.copy(c);
    Object.assign(est, s);
    const txt = Number.isFinite(s.T) ? s.T.toFixed(1) + ' °C' : '— °C';
    if (txt !== est.txtT) { est.txtT = txt; pintarPlaca(); }
  }
  return {iniciar, actualizar, vistaInicial, auto, get activo(){ return ok; }};
})();
