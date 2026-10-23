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

  // ====== 🔧 SERVICIO: estatus RICO, cubeta y FILA compartidos (admin CRM + Centro) ======
  // Estatus RICO (el que usa Clientes/admin: aprobación, pagado, etc.). {txt,col}. Bilingüe.
  LMG.svcStatusRich = function (o, en) {
    o = o || {};
    if (o.paid) return { txt: en ? '✅ Paid' : '✅ Pagado', col: '#28b463' };
    var s = o.status;
    if (s === 'arrancado') return { txt: en ? '🚀 Service started!' : '🚀 ¡Servicio arrancó!', col: '#7c5cff' };
    if (s === 'entregado') return { txt: en ? '🏁 Delivered' : '🏁 Entregado', col: '#28b463' };
    if (s === 'listo') return { txt: en ? '✅ Ready for pickup' : '✅ Listo p/ entrega', col: '#28b463' };
    if (s === 'en_proceso') return { txt: en ? '🔧 In progress' : '🔧 En proceso', col: '#e8b64a' };
    if (s === 'pausado_partes') return { txt: en ? '⏸️ Waiting on parts' : '⏸️ Esperando partes', col: '#ff9800' };
    if (s === 'recibido') return { txt: en ? '📥 Received' : '📥 Recibido', col: '#e8b64a' };
    if (o.estimateStatus === 'accepted') return (s === 'agendado') ? { txt: en ? '📅 Scheduled' : '📅 Agendado', col: '#0a84ff' } : { txt: en ? '✅ Estimate authorized' : '✅ Estimado autorizado', col: '#28b463' };
    if (o.estimateStatus === 'sent') return { txt: en ? '⏳ Waiting approval' : '⏳ Esperando aprobación', col: '#e8b64a' };
    if (s === 'agendado') return { txt: en ? '📅 Scheduled' : '📅 Agendado', col: '#0a84ff' };
    return { txt: en ? '🧾 Draft estimate' : '🧾 Borrador de estimado', col: '#8a8fa8' };
  };
  // Cubeta del CRM: completadas / activas / estimados.
  LMG.svcBucketOf = function (o) {
    o = o || {};
    if (o.paid === true || o.status === 'entregado') return 'completadas';
    if (o.estimateStatus === 'accepted' || ['arrancado', 'recibido', 'en_proceso', 'pausado_partes', 'listo'].indexOf(o.status) >= 0) return 'activas';
    return 'estimados';
  };
  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function _money(n) { try { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch (e) { return '$' + (n || 0); } }
  // UNA fila de orden (folio · cliente/carro · estado · total). Misma que Clientes/admin.
  // opts: {esc, money, openFn, receiptFn, lang} — openFn/receiptFn = nombre de función global que recibe el id.
  LMG.svcOrderRow = function (o, opts) {
    opts = opts || {}; o = o || {};
    var esc = opts.esc || _esc, money = opts.money || _money, en = (opts.lang === 'en');
    var sl = LMG.svcStatusRich(o, en), badge = sl.txt, col = sl.col;
    var car = esc(o.vehicleLabel || o.plate || (o.vin ? ('VIN …' + String(o.vin || '').slice(-6)) : (en ? 'Vehicle' : 'Auto')));
    var tot = (Number(o.grandTotalCents) || 0) > 0 ? money(o.grandTotalCents / 100) : '—';
    var when = (o.scheduledAt || o.createdAt) ? new Date(o.scheduledAt || o.createdAt).toLocaleDateString(en ? 'en-US' : 'es-MX', { day: '2-digit', month: 'short' }) : '';
    var openFn = opts.openFn || 'svcOpenOrder', receiptFn = opts.receiptFn || openFn;
    var fn = (LMG.svcBucketOf(o) === 'completadas' && o.paid) ? (receiptFn + '(\'' + o.id + '\')') : (openFn + '(\'' + o.id + '\')');
    return '<div onclick="' + fn + '" style="display:flex;gap:10px;align-items:center;padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer;">'
      + '<div style="width:48px;font-weight:800;color:var(--gold);font-size:13px;font-variant-numeric:tabular-nums;">' + (o.orderNum ? ('#' + o.orderNum) : '—') + '</div>'
      + '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(o.clientName || (en ? 'Customer' : 'Cliente')) + '</div><div style="font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🚗 ' + car + (when ? (' · ' + when) : '') + '</div></div>'
      + '<div style="width:94px;text-align:center;"><span style="font-size:10px;font-weight:800;color:' + col + ';background:' + col + '1f;border:1px solid ' + col + ';padding:3px 6px;border-radius:999px;white-space:nowrap;display:inline-block;">' + badge + '</span></div>'
      + '<div style="width:72px;text-align:right;font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;">' + tot + '</div></div>';
  };
  // Lista tipo TABLA (encabezado opcional). opts igual que svcOrderRow.
  LMG.svcTable = function (list, opts, noHead) {
    opts = opts || {}; var en = (opts.lang === 'en');
    var head = noHead ? '' : '<div style="display:flex;gap:10px;padding:9px 12px;font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;border-bottom:1px solid var(--border);background:var(--surface2);"><div style="width:48px;">#</div><div style="flex:1;">' + (en ? 'Customer / Car' : 'Cliente / Carro') + '</div><div style="width:94px;text-align:center;">' + (en ? 'Status' : 'Estado') + '</div><div style="width:72px;text-align:right;">Total</div></div>';
    return '<div style="border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--surface);">' + head + (list || []).map(function (o) { return LMG.svcOrderRow(o, opts); }).join('') + '</div>';
  };

  LMG.version = '2';
})();
