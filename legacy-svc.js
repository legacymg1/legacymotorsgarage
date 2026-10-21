/* ============================================================
   legacy-svc.js — COMPONENTE COMPARTIDO del ecosistema Legacy.
   Una sola fuente para badges/estatus (y luego filas/pestañas) que
   usan admin.html (Clientes/CRM) Y warehouse.html (Pit Crew/Centro).
   Cambiar aquí = cambia en TODAS las páginas (regla: un solo ecosistema).
   Es un <script> clásico que define window.LMG ANTES de los módulos.
   Cada app mantiene un fallback local por si este archivo no cargó.
   ============================================================ */
;(function () {
  var LMG = (window.LMG = window.LMG || {});

  // 🏷️ ESTATUS UNIFICADO de tareas/etapas en TODO el sistema:
  //    En cola → En proceso → En pausa → Terminado.
  LMG.svcStatusLabel = function (s, en) {
    if (s === 'en_proceso') return en ? 'In progress' : 'En proceso';
    if (s === 'pausada' || s === 'pausado' || s === 'pausado_partes') return en ? 'Paused' : 'En pausa';
    if (s === 'listo' || s === 'hecho' || s === 'terminado' || s === 'entregado') return en ? 'Done' : 'Terminado';
    return en ? 'Queued' : 'En cola';
  };

  // 🎨 COLOR único por estatus: cola gris · en proceso dorado · en pausa naranja · terminado verde.
  LMG.svcStatusColor = function (s) {
    if (s === 'en_proceso') return '#e8b64a';
    if (s === 'pausada' || s === 'pausado' || s === 'pausado_partes') return '#ff9800';
    if (s === 'listo' || s === 'hecho' || s === 'terminado' || s === 'entregado') return '#35c46a';
    return '#8a8fa8';
  };

  // 🔖 BADGE (pill) de estatus, mismo look en todas las páginas.
  LMG.svcBadge = function (s, en) {
    var c = LMG.svcStatusColor(s);
    return '<span style="font-size:10px;font-weight:800;color:' + c + ';background:' + c +
      '1f;border:1px solid ' + c + ';padding:2px 7px;border-radius:999px;white-space:nowrap;">' +
      LMG.svcStatusLabel(s, en) + '</span>';
  };

  // 〰️ Divisor suave por grupo (panorama tipo "Todas").
  LMG.softDivider = function (label, count) {
    return '<div style="display:flex;align-items:center;gap:10px;margin:16px 2px 8px;">' +
      '<span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);white-space:nowrap;">' + label + '</span>' +
      '<span style="flex:1;height:1px;background:linear-gradient(90deg,var(--border),transparent);"></span>' +
      (count == null ? '' : '<span style="font-size:11px;color:var(--faint);">' + count + '</span>') +
      '</div>';
  };

  LMG.version = '1';
})();
