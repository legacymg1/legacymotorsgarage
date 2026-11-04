/* ============================================================
   legacy-version.js — AVISO DE NUEVA VERSIÓN (one-ecosystem)
   Revisa version.json (que el deploy regenera en cada publish) y,
   si cambió respecto a la que cargó esta pestaña, muestra una barra
   discreta abajo: "Nueva versión — Actualizar". Así el equipo y los
   clientes siempre tienen lo último sin limpiar caché a mano.

   Uso: incluir <script src="legacy-version.js"></script> tras <body>.
   No requiere nada más: el deploy ya genera version.json.
   Si version.json no existe o falla la red, no hace nada (silencioso).
   ============================================================ */
(function () {
  if (window.__lmgVerInit) return;
  window.__lmgVerInit = true;

  var CHECK_MS = 3 * 60 * 1000;   // revisar cada 3 min (y al volver a la pestaña)
  var base = null;                // versión con la que cargó ESTA pestaña
  var shown = false;              // ya avisamos (no molestar de nuevo)

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

  function banner() {
    if (shown || document.getElementById('lmg-ver-bar')) return;
    shown = true;
    var en = isEn();
    var bar = document.createElement('div');
    bar.id = 'lmg-ver-bar';
    bar.style.cssText =
      'position:fixed;left:12px;right:12px;top:calc(12px + env(safe-area-inset-top));z-index:2147483100;' +
      'background:linear-gradient(135deg,#d9b85a,#c9a84c);color:#0b0e14;border-radius:13px;' +
      'padding:12px 14px;display:flex;align-items:center;gap:10px;font-weight:800;font-size:13.5px;' +
      'box-shadow:0 12px 34px rgba(0,0,0,.5);font-family:inherit;animation:lmgVerIn .35s ease;max-width:520px;margin:0 auto;';
    bar.innerHTML =
      '<span style="flex:1;line-height:1.3;">✨ ' +
      (en ? 'New version available' : 'Nueva versión disponible') + '</span>' +
      '<button id="lmg-ver-go" style="background:#0b0e14;color:#f0c040;border:none;border-radius:9px;' +
      'padding:8px 14px;font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;">' +
      (en ? 'Update' : 'Actualizar') + '</button>' +
      '<button id="lmg-ver-x" aria-label="cerrar" style="background:transparent;border:none;color:#0b0e14;' +
      'font-size:20px;line-height:1;cursor:pointer;padding:0 2px;">×</button>';
    (document.body || document.documentElement).appendChild(bar);

    var st = document.createElement('style');
    st.textContent = '@keyframes lmgVerIn{from{transform:translateY(-16px);opacity:0;}to{transform:translateY(0);opacity:1;}}';
    (document.head || document.documentElement).appendChild(st);

    document.getElementById('lmg-ver-go').onclick = function () {
      try { location.reload(); } catch (e) { location.href = location.pathname + '?v=' + Date.now(); }
    };
    document.getElementById('lmg-ver-x').onclick = function () {
      var b = document.getElementById('lmg-ver-bar'); if (b) b.remove();
    };
  }

  function check() {
    if (shown) return;
    fetchVer().then(function (v) {
      if (!v) return;
      if (base === null) { base = v; return; }   // primera lectura = versión de esta pestaña
      if (v !== base) banner();
    });
  }

  // Primera lectura (fija la base) y chequeos periódicos + al volver a la pestaña.
  check();
  setInterval(check, CHECK_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
})();
