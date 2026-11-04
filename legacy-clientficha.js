/* ============================================================
   legacy-clientficha.js — COMPONENTE COMPARTIDO: ficha del CLIENTE (Cliente 360).
   Un solo renderizador para la "tarjeta del cliente" que usan Pit Crew (Centro)
   y, a futuro, Clientes/admin. Recibe un objeto NORMALIZADO + opts (idioma +
   NOMBRES de funciones globales para las acciones, estilo svcOrderRow).
   Cambiar aquí = cambia en todas las páginas (regla: un solo ecosistema).
   Script clásico: define window.LMG.openClientFicha ANTES de los módulos.
   ============================================================ */
;(function () {
  var LMG = (window.LMG = window.LMG || {});
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function money(n){ try{ return '$'+Number(n||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }catch(e){ return '$'+(n||0); } }

  LMG.clientFichaClose = function(){ var x=document.getElementById('lmg-cf-ov'); if(x) x.remove(); };

  // data = { name, phone, lang, badges:[{icon,label}],
  //          vehicles:[{label,plate,vin,right}],
  //          serviceActive:[{id,orderNum,title,when,statusTxt,statusCol,total,saldo}],
  //          serviceDone:[{...}], quotes:[{id,car,when}],
  //          finance:{balance,cars} }
  // opts = { lang:'es'|'en', openOrderFn, openReceiptFn, openQuoteFn, newServiceFn, editFn, close }
  LMG.clientFichaHTML = function (data, opts) {
    data = data || {}; opts = opts || {};
    var en = (opts.lang === 'en');
    var L2 = function(es,eng){ return en?eng:es; };
    var close = opts.close || 'LMG.clientFichaClose()';
    var sec = function(title, inner, act){ return '<div style="padding:14px 16px;border-top:1px solid var(--border);"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;"><div style="font-weight:800;font-size:13px;color:var(--gold);letter-spacing:.3px;">'+title+'</div>'+(act||'')+'</div>'+inner+'</div>'; };
    var empty = function(txt){ return '<div style="color:var(--muted);font-size:13px;">'+txt+'</div>'; };
    var addBtn = function(label, fn){ return '<button onclick="'+fn+'" style="background:var(--surface2,#171e30);border:1px solid var(--gold);color:var(--gold);border-radius:8px;padding:4px 11px;font-size:11px;font-weight:800;cursor:pointer;white-space:nowrap;">'+label+'</button>'; };
    var phone = String(data.phone||'').replace(/[^0-9+]/g,'');
    var badges = (data.badges||[]).map(function(b){ return '<span style="display:inline-flex;align-items:center;gap:4px;background:var(--surface2,#171e30);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;margin:0 4px 4px 0;">'+(b.icon?b.icon+' ':'')+esc(b.label)+'</span>'; }).join('');

    // Header
    var h = '<div style="padding:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;"><div style="min-width:0;">'
      + '<div style="font-weight:800;font-size:22px;line-height:1.15;">'+esc(data.name||L2('(sin nombre)','(no name)'))+'</div>'
      + '<div style="color:var(--muted);font-size:13px;margin-top:5px;">'+esc(data.phone||L2('sin teléfono','no phone'))+(data.lang?(' · '+(data.lang==='en'?'English':'Español')):'')+'</div>'
      + (badges?'<div style="margin-top:8px;">'+badges+'</div>':'')
      + '</div><button onclick="'+close+'" style="background:transparent;border:none;color:var(--muted);font-size:26px;cursor:pointer;line-height:1;flex:0 0 auto;">×</button></div>';

    // Acciones rápidas
    var acts = '';
    if (phone) acts += '<a href="sms:'+phone+'" style="flex:1 1 auto;text-align:center;text-decoration:none;background:var(--surface2,#171e30);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px;font-size:13px;font-weight:700;">💬 SMS</a><a href="tel:'+phone+'" style="flex:0 0 auto;text-align:center;text-decoration:none;background:var(--surface2,#171e30);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px 13px;font-size:13px;">📞</a>';
    if (opts.editFn) acts += '<button onclick="'+close+';'+opts.editFn+'(\''+esc(data.id||'')+'\')" style="flex:1 1 auto;background:var(--surface2,#171e30);border:1px solid var(--border);color:var(--text);border-radius:9px;padding:9px;font-size:13px;font-weight:700;cursor:pointer;">✏️ '+L2('Editar','Edit')+'</button>';
    if (acts) h += '<div style="display:flex;gap:7px;flex-wrap:wrap;padding:0 16px 14px;">'+acts+'</div>';

    // 💵 Resumen de cuenta (si el host lo da)
    if (data.finance && (Number(data.finance.balance)||0) > 0) {
      h += sec('💵 '+L2('Resumen de cuenta','Account summary'), '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><span style="color:var(--muted);font-size:13px;">'+L2('Saldo total','Total balance')+(data.finance.cars?(' · '+data.finance.cars+' '+L2('carro(s)','car(s)')):'')+'</span><b style="color:var(--gold);font-size:18px;">'+money(data.finance.balance)+'</b></div>');
    }

    // 🚗 Vehículos
    var vehHtml = (data.vehicles&&data.vehicles.length) ? data.vehicles.map(function(v){
      var tap = (opts.openVehicleFn && v.ref!=null) ? (' onclick="'+close+';'+opts.openVehicleFn+'(\''+esc(v.ref)+'\')" style="cursor:pointer;') : (' style="');
      return '<div'+tap+'border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:7px;display:flex;justify-content:space-between;align-items:center;gap:10px;"><div style="min-width:0;"><div style="font-weight:700;">🚗 '+esc(v.label||'Auto')+'</div><div style="color:var(--muted);font-size:12px;">'+(v.plate?('🪪 '+esc(v.plate)+' · '):'')+(v.vin?('VIN …'+esc(String(v.vin).slice(-6))):'')+'</div></div>'+(v.right?('<div style="flex:0 0 auto;">'+v.right+'</div>'):'')+'</div>';
    }).join('') : empty(L2('Sin vehículos registrados.','No vehicles.'));
    h += sec('🚗 '+L2('Vehículos','Vehicles')+((data.vehicles&&data.vehicles.length>1)?(' ('+data.vehicles.length+')'):''), vehHtml);

    // 🔧 Servicio (en curso + completadas)
    var svcRow = function(o, done){
      var fn = done ? (opts.openReceiptFn||opts.openOrderFn) : opts.openOrderFn;
      var onc = fn ? (' onclick="'+close+';'+fn+'(\''+esc(o.id)+'\')" style="cursor:pointer;') : (' style="');
      var fol = o.orderNum ? ('<span style="color:var(--gold);font-weight:800;">#'+esc(o.orderNum)+'</span> · ') : '';
      var tot = (o.total!=null && o.total>0) ? money(o.total) : '';
      var saldo = (!done && o.saldo>0) ? (' · '+L2('saldo','balance')+' '+money(o.saldo)) : '';
      var col = o.statusCol || 'var(--muted)';
      return '<div'+onc+'border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-bottom:7px;"><div style="display:flex;justify-content:space-between;gap:8px;"><span style="font-weight:700;font-size:13px;min-width:0;">'+fol+esc(o.title||L2('Servicio','Service'))+'</span><span style="font-size:11px;color:var(--muted);white-space:nowrap;">'+esc(o.when||'')+'</span></div><div style="font-size:12px;color:'+col+';margin-top:3px;font-weight:700;">'+esc(o.statusTxt||'')+'</div>'+((tot||saldo)?('<div style="font-size:11px;color:var(--muted);margin-top:1px;">'+tot+saldo+(fn?(' · '+L2('ver','open')+' ›'):'')+'</div>'):'')+'</div>';
    };
    var act2 = opts.newServiceFn ? addBtn('➕ '+L2('Agendar servicio','Schedule service'), close+';'+opts.newServiceFn+'(\''+esc(data.id||'')+'\')') : '';
    h += sec('🔧 '+L2('Servicio','Service'), (data.serviceActive&&data.serviceActive.length)?data.serviceActive.map(function(o){return svcRow(o,false);}).join(''):empty(L2('Sin órdenes abiertas.','No open orders.')), act2);
    if (data.serviceDone && data.serviceDone.length) h += sec('✅ '+L2('Órdenes completadas','Completed orders')+' ('+data.serviceDone.length+')', data.serviceDone.map(function(o){return svcRow(o,true);}).join(''));

    // 🧮 Cotizaciones (si el host las da)
    if (data.quotes && data.quotes.length) {
      h += sec('🧮 '+L2('Cotizaciones','Quotes'), data.quotes.map(function(q){
        var onc = opts.openQuoteFn ? (' onclick="'+close+';'+opts.openQuoteFn+'(\''+esc(q.id)+'\')" style="cursor:pointer;') : (' style="');
        return '<div'+onc+'border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-bottom:7px;"><div style="display:flex;justify-content:space-between;gap:8px;"><span style="font-weight:700;font-size:13px;min-width:0;">'+esc(q.car||L2('Cotización','Quote'))+'</span><span style="font-size:11px;color:var(--muted);white-space:nowrap;">'+esc(q.when||'')+'</span></div></div>';
      }).join(''));
    }
    return h;
  };

  // Abre la ficha en un overlay centrado (backdrop cierra en iPhone: cursor:pointer).
  LMG.openClientFicha = function (data, opts) {
    LMG.clientFichaClose();
    var ov = document.createElement('div'); ov.id = 'lmg-cf-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483210;display:flex;align-items:flex-start;justify-content:center;padding:calc(16px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom));box-sizing:border-box;cursor:pointer;overflow:auto;';
    ov.onclick = function(e){ if(e.target===ov) ov.remove(); };
    var box = document.createElement('div');
    box.style.cssText = 'background:var(--surface,#12151c);color:var(--text,#fff);width:100%;max-width:560px;border-radius:18px;overflow:hidden;cursor:default;margin:auto;box-shadow:0 20px 60px rgba(0,0,0,.6);';
    box.innerHTML = LMG.clientFichaHTML(data, opts);
    ov.appendChild(box); document.body.appendChild(ov);
  };
})();
