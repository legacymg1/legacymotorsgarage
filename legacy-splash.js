/* ============================================================
   legacy-splash.js — PANTALLA DE CARGA COMPARTIDA (one-ecosystem)
   Un overlay OPACO con el logo + spinner que se muestra al abrir
   CUALQUIER app de Legacy, para que no se vea el parpadeo del login
   mientras Firebase restaura la sesión (o mientras el portal carga).

   Uso en cada página:
     1) Incluir ESTE script lo más arriba posible, justo después de <body>:
          <script src="legacy-splash.js"></script>
     2) Cuando la sesión ya resolvió (dentro de onAuthStateChanged, o al
        terminar de cargar el portal), llamar:
          LMG.hideSplash();
     Si por lo que sea nadie lo llama, un fallback lo quita solo a los 8s
     para no dejarlo pegado. Cambiar una vez aquí = aplica a todas.
   ============================================================ */
(function () {
  if (window.__lmgSplashInit) return;
  window.__lmgSplashInit = true;
  var LMG = (window.LMG = window.LMG || {});

  function inject() {
    if (document.getElementById('lmg-splash')) return;

    var css = document.createElement('style');
    css.id = 'lmg-splash-css';
    css.textContent =
      '#lmg-splash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:22px;background:radial-gradient(ellipse at center,#1a2035 0%,#0f1320 100%);' +
      'transition:opacity .35s ease;}' +
      '#lmg-splash.lmg-hide{opacity:0;pointer-events:none;}' +
      '#lmg-splash .lmg-splash-logo{width:150px;max-width:46%;opacity:.95;animation:lmgSplashPulse 1.6s ease-in-out infinite;}' +
      '#lmg-splash .lmg-splash-spin{width:30px;height:30px;border:3px solid rgba(201,168,76,.25);' +
      'border-top-color:var(--gold,#c9a84c);border-radius:50%;animation:lmgSplashSpin .8s linear infinite;}' +
      '@keyframes lmgSplashSpin{to{transform:rotate(360deg);}}' +
      '@keyframes lmgSplashPulse{0%,100%{opacity:.55;}50%{opacity:1;}}' +
      '@media (prefers-reduced-motion:reduce){#lmg-splash .lmg-splash-logo,#lmg-splash .lmg-splash-spin{animation:none;}}';
    (document.head || document.documentElement).appendChild(css);

    var ov = document.createElement('div');
    ov.id = 'lmg-splash';
    ov.setAttribute('aria-hidden', 'true');
    ov.innerHTML =
      '<img src="logo.png" alt="" class="lmg-splash-logo" onerror="this.style.display=\'none\'">' +
      '<div class="lmg-splash-spin"></div>';
    (document.body || document.documentElement).appendChild(ov);
  }

  // Inyectar lo antes posible (el <script> va justo tras <body>, así body ya existe).
  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);

  LMG.hideSplash = function () {
    var ov = document.getElementById('lmg-splash');
    if (!ov) return;
    ov.classList.add('lmg-hide');
    setTimeout(function () { if (ov && ov.parentNode) ov.parentNode.removeChild(ov); }, 450);
  };

  // 🛟 Salvavidas: pase lo que pase (nadie lo llamó, el módulo falló, red lenta), nunca se queda pegado.
  setTimeout(function () { if (window.LMG && LMG.hideSplash) LMG.hideSplash(); }, 8000);
})();
