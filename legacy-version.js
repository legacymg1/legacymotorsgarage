/* ============================================================
   legacy-version.js — AUTO-ACTUALIZACIÓN (one-ecosystem)
   Revisa version.json (que el deploy regenera en cada publish) y,
   si cambió respecto a la que cargó esta pestaña, actualiza SOLA —
   sin barra, estilo iOS — en un momento SEGURO:
     • Si la app está en segundo plano / la cierras → recarga invisible.
     • Si está abierta pero estás QUIETO (sin escribir) → HUD iOS
       "Actualizando…" ~1s y recarga.
     • NUNCA recarga mientras escribes en un campo (no pierdes lo tecleado).

   Uso: <script src="legacy-version.js"></script> tras <body>.
   No requiere nada más: el deploy ya genera version.json.
   ============================================================ */
(function () {
  if (window.__lmgVerInit) return;
  window.__lmgVerInit = true;

  var CHECK_MS = 3 * 60 * 1000;   // revisar cada 3 min (y al volver a la pestaña)
  var IDLE_MS  = 5000;            // "quieto" = 5s sin tocar/escribir
  var base = null;                // versión con la que cargó ESTA pestaña
  var pending = false;            // hay nueva versión esperando a aplicarse
  var lastInteract = Date.now();

  function isEn() {
    try {
      var l = (document.documentElement.getAttribute('lang') || '').toLowerCase();
      if (l) return l.indexOf('en') === 0;
    } catch (e) {}
    return (navigator.language || '').toLowerCase().indexOf('en') === 0;
  }

  function fetchVer() {
    return fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.v) ? String(j.v) : null; })
      .catch(function () { return null; });
  }

  // ¿El usuario está escribiendo? → NO recargar (perdería lo tecleado).
  function isTyping() {
    var a = document.activeElement;
    if (!a) return false;
    if (a.isContentEditable) return true;
    return /^(input|textarea|select)$/i.test(a.tagName || '');
  }

  // 🛑 ¿El usuario está en una TAREA (vista de trabajo/diagnóstico/etc.)? → NO recargar (no lo saca de donde está).
  //    La página lo marca con window.__lmgBusy=true mientras una vista crítica está abierta.
  function isBusy() { try { return !!window.__lmgBusy; } catch (e) { return false; } }

  function reloadNow(silent) {
    if (silent) { try { location.reload(); } catch (e) {} return; }
    // HUD estilo iOS: recuadro redondeado con blur + spinner, centrado.
    if (!document.getElementById('lmg-hud')) {
      var css = document.createElement('style');
      css.textContent =
        '#lmg-hud{position:fixed;inset:0;z-index:2147483200;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,.18);animation:lmgHudFade .2s ease;}' +
        '#lmg-hud .lmg-hud-box{background:rgba(28,28,32,.72);-webkit-backdrop-filter:blur(22px) saturate(180%);' +
        'backdrop-filter:blur(22px) saturate(180%);border:.5px solid rgba(255,255,255,.12);border-radius:22px;' +
        'padding:24px 28px;display:flex;flex-direction:column;align-items:center;gap:14px;min-width:160px;' +
        'box-shadow:0 24px 70px rgba(0,0,0,.45);color:#fff;font-family:inherit;animation:lmgHudPop .28s cubic-bezier(.2,.9,.3,1.2);}' +
        '#lmg-hud .lmg-hud-spin{width:30px;height:30px;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;' +
        'border-radius:50%;animation:lmgHudSpin .8s linear infinite;}' +
        '#lmg-hud .lmg-hud-txt{font-size:14px;font-weight:600;letter-spacing:.2px;opacity:.95;}' +
        '@keyframes lmgHudSpin{to{transform:rotate(360deg);}}' +
        '@keyframes lmgHudFade{from{opacity:0;}to{opacity:1;}}' +
        '@keyframes lmgHudPop{from{transform:scale(.86);opacity:0;}to{transform:scale(1);opacity:1;}}' +
        '@media (prefers-reduced-motion:reduce){#lmg-hud .lmg-hud-spin{animation:none;}}';
      (document.head || document.documentElement).appendChild(css);
      var hud = document.createElement('div');
      hud.id = 'lmg-hud';
      hud.innerHTML = '<div class="lmg-hud-box"><div class="lmg-hud-spin"></div>' +
        '<div class="lmg-hud-txt">' + (isEn() ? 'Updating…' : 'Actualizando…') + '</div></div>';
      (document.body || document.documentElement).appendChild(hud);
    }
    setTimeout(function () { try { location.reload(); } catch (e) {} }, 950);
  }

  // 🔄 Chip discreto "Nueva versión — tocar para actualizar": cuando hay update lista pero NO se puede
  //    aplicar sola (estás en una tarea o escribiendo), aparece para que la apliques TÚ en un momento seguro.
  function showChip() {
    if (document.getElementById('lmg-upd-chip')) return;
    var c = document.createElement('button');
    c.id = 'lmg-upd-chip';
    c.type = 'button';
    c.textContent = '🔄 ' + (isEn() ? 'New version — tap to update' : 'Nueva versión — tocar para actualizar');
    c.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:2147483210;' +
      'background:rgba(28,28,32,.82);-webkit-backdrop-filter:blur(18px) saturate(180%);backdrop-filter:blur(18px) saturate(180%);' +
      'color:#fff;border:.5px solid rgba(255,255,255,.16);border-radius:999px;padding:11px 18px;font:600 13.5px/1 inherit;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.42);cursor:pointer;max-width:92vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:lmgChipUp .3s cubic-bezier(.2,.9,.3,1.2);';
    if (!document.getElementById('lmg-chip-css')) {
      var st = document.createElement('style'); st.id = 'lmg-chip-css';
      st.textContent = '@keyframes lmgChipUp{from{transform:translate(-50%,16px);opacity:0;}to{transform:translate(-50%,0);opacity:1;}}';
      (document.head || document.documentElement).appendChild(st);
    }
    c.onclick = function () { reloadNow(false); };
    (document.body || document.documentElement).appendChild(c);
  }
  function hideChip() { var c = document.getElementById('lmg-upd-chip'); if (c) c.remove(); }

  // Aplica la actualización en cuanto sea seguro.
  function tryApply() {
    if (!pending) return;
    if (isBusy()) { showChip(); setTimeout(tryApply, 2000); return; }  // en una tarea → NO la saques; ofrece el chip
    if (document.hidden) { reloadNow(true); return; }                 // no lo ve → recarga invisible
    if (!isTyping() && (Date.now() - lastInteract) > IDLE_MS) {        // visible y quieto → HUD + recarga
      hideChip(); reloadNow(false); return;
    }
    showChip();                                                       // escribiendo/ocupado → ofrece el chip
    setTimeout(tryApply, 2000);                                        // y reintenta la recarga sola cuando esté quieto
  }

  function check() {
    if (pending) return;
    fetchVer().then(function (v) {
      if (!v) return;
      if (base === null) { base = v; return; }   // primera lectura = versión de esta pestaña
      if (v !== base) { pending = true; tryApply(); }
    });
  }

  // Marcar interacción (para saber cuándo está "quieto").
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastInteract = Date.now(); }, { passive: true });
  });

  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (pending && !isBusy()) reloadNow(true); }   // la cerró con update pendiente → recarga invisible (salvo si está en una tarea)
    else check();                                            // volvió → revisa
  });
  window.addEventListener('focus', check);
})();
