/* 🗂️ Legacy — Ficha del carro (componente COMPARTIDO, estilo iOS).
   Una sola fuente para Pit Crew (warehouse.html) e Inventario (index.html) y donde se necesite.
   Uso:  LMG.openCarFicha(carId, ctx)
   ctx = {
     call: (op, data) => Promise<data>,   // llama el callable y DEVUELVE r.data (carJacket / mechDvi)
     lang: 'es' | 'en',
     who:  'Nombre del que trabaja' (opcional),
     toast: (msg, isErr) => {} (opcional),
     onChange: () => {} (opcional, al cambiar de etapa: recargar listas de la página)
   }
*/
(function(){
  window.LMG = window.LMG || {};
  var _ctx=null, _insp=null, _car=null, _tick=null;

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(m){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];}); }
  function L2(es,en){ return (_ctx && _ctx.lang==='en') ? en : es; }
  function toast(m,e){ try{ if(_ctx && _ctx.toast) _ctx.toast(m,e); }catch(_){} }
  function call(op,data){ return _ctx.call(op, data||{}); }
  function hms(s){ s=Math.max(0,Math.floor(s)); var h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; var z=function(n){return String(n).padStart(2,'0');}; return (h>0?(h+':'):'')+z(m)+':'+z(ss); }
  function hm(min){ min=Math.round(Number(min)||0); return min>=60?(Math.floor(min/60)+'h '+(min%60)+'m'):(min+'m'); }
  function fmtD(iso,long){ if(!iso) return '—'; try{ return new Date(iso).toLocaleDateString(_ctx.lang==='en'?'en-US':'es-MX', long?{day:'numeric',month:'long',year:'numeric'}:{day:'numeric',month:'short',year:'numeric'}); }catch(e){ return '—'; } }

  var LB={
    partsH:function(){return L2('🧩 Partes que necesita','🧩 Parts needed');},
    redH:function(){return L2('❌ Necesita reparación / pieza','❌ Needs repair / part');},
    fixedH:function(){return L2('🔧 Reparado en sitio','🔧 Fixed on site');},
    okH:function(){return L2('✅ En buen estado','✅ In good condition');},
    reportTitle:function(){return L2('Inspección Inicial · Pre-reparación','Initial · Pre-Repair Inspection');},
    byLbl:function(){return L2('Mecánico','Mechanic');},
    noFlags:function(){return L2('Todo salió bien. Sin pendientes.','All good. Nothing flagged.');}
  };
  function stageInfo(stage, waiting){
    if(waiting) return {t:L2('🔧 Esperando partes','🔧 Waiting on parts'), c:'#ff8a4c'};
    var m={ mecanico:[L2('🔧 Mecánico','🔧 Mechanic'),'#f0c040'], pintura:[L2('🎨 Pintura','🎨 Paint'),'#b58bff'], detalle:[L2('🧽 Detallado','🧽 Detailing'),'#4cc2ff'], listo:[L2('✅ Listo para fotos','✅ Ready for photos'),'#35c46a'] };
    var o=m[stage]||[stage||'—','#8b93a3']; return {t:o[0], c:o[1]};
  }

  LMG.openCarFicha=async function(carId, ctx){
    if(ctx) _ctx=ctx;
    if(!_ctx || typeof _ctx.call!=='function'){ return; }
    var ov=document.getElementById('wh-carficha');
    if(!ov){ ov=document.createElement('div'); ov.id='wh-carficha'; ov.style.cssText='position:fixed;inset:0;z-index:100075;background:rgba(0,0,0,.72);display:flex;align-items:flex-start;justify-content:center;padding:calc(16px + env(safe-area-inset-top)) 12px calc(16px + env(safe-area-inset-bottom));box-sizing:border-box;cursor:pointer;overflow:auto;';
      ov.onclick=function(e){ if(e.target===ov){ clearInterval(_tick); _tick=null; ov.remove(); } };
      var bx=document.createElement('div'); bx.id='wh-carficha-box'; bx.style.cssText='background:var(--surface,#12151c);color:var(--text,#fff);border:1px solid var(--border,#232a36);border-radius:18px;max-width:460px;width:100%;box-sizing:border-box;cursor:default;margin:auto;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6);';
      ov.appendChild(bx); document.body.appendChild(ov);
    } else ov.style.display='flex';
    var box=document.getElementById('wh-carficha-box');
    box.innerHTML='<div style="text-align:center;padding:30px;color:var(--muted,#8b93a3);">…</div>';
    try{ var d=await call('carJacket',{carId:carId}); render(d||{}); }
    catch(e){ box.innerHTML='<div style="padding:18px;"><div style="text-align:center;padding:14px;color:var(--muted,#8b93a3);">'+esc((e&&e.message)||'Error')+'</div><button onclick="LMG.cfClose()" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border,#232a36);background:var(--surface2,#1a1f29);color:var(--text,#fff);cursor:pointer;">✕</button></div>'; }
  };
  LMG.cfClose=function(){ clearInterval(_tick); _tick=null; var x=document.getElementById('wh-carficha'); if(x) x.remove(); };

  function render(d){
    var box=document.getElementById('wh-carficha-box'); if(!box) return;
    var c=d.car||{}, insp=d.inspection||{}; _insp=insp; _car=c;
    var inStage2=!!(insp.stage2At && !insp.stage2DoneAt);
    var waiting=!!(insp.reportAt && insp.waitingParts && !inStage2);
    var stg=inStage2 ? {t:L2('🏗️ En trabajo · Etapa 2','🏗️ In progress · Stage 2'),c:'#4c9bff'} : stageInfo(c.reconStage, waiting);
    var photo=c.photo?('<img src="'+esc(c.photo)+'" style="width:100%;height:170px;object-fit:cover;display:block;">'):'<div style="height:120px;background:var(--surface2,#1a1f29);display:flex;align-items:center;justify-content:center;font-size:44px;">🚗</div>';
    var rows=[];
    rows.push(['📍 '+L2('Etapa','Stage'), '<span style="color:'+stg.c+';font-weight:800;">'+esc(stg.t)+'</span>']);
    if(insp.reportAt){
      rows.push(['👤 '+L2('Inspeccionó','Inspected by'), esc(insp.reportBy||insp.by||'—')]);
      rows.push(['📅 '+L2('Inspección','Inspection'), fmtD(insp.reportAt)]);
      if(d.durMin) rows.push(['⏱️ '+L2('Inspección tardó','Inspection took'), hm(d.durMin)]);
      if(insp.stage2Mins) rows.push(['🏗️ '+L2('Etapa 2 (trabajo)','Stage 2 (work)'), hm(insp.stage2Mins)]);
    } else { rows.push(['🔧 '+L2('Inspección','Inspection'), insp.startedAt?L2('En proceso','In progress'):L2('Pendiente','Pending')]); }
    var rowHtml=rows.map(function(r){ return '<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:13.5px;"><span style="color:var(--muted,#8b93a3);">'+r[0]+'</span><span style="font-weight:700;text-align:right;">'+r[1]+'</span></div>'; }).join('');
    var parts=Array.isArray(insp.parts)?insp.parts:[];
    box.innerHTML=photo
      +'<div style="padding:16px;">'
      +'<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;"><div style="min-width:0;"><div style="font-weight:800;font-size:18px;line-height:1.2;">'+esc(c.label)+'</div>'
      +'<div style="font-size:12px;color:var(--muted,#8b93a3);margin-top:3px;">'+(c.inventoryNum?('#'+esc(c.inventoryNum)+' · '):'')+(c.vin?('VIN '+esc(c.vin)+' · '):'')+(c.miles?(esc(c.miles)+' mi'):'')+'</div></div>'
      +'<button onclick="LMG.cfClose()" style="font-size:26px;color:var(--muted,#8b93a3);line-height:1;flex:0 0 auto;background:none;border:none;cursor:pointer;">×</button></div>'
      +'<div style="margin-top:8px;">'+rowHtml+'</div>'
      +(insp.reportAt?('<button onclick="LMG.cfReport()" style="width:100%;margin-top:14px;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,#d9b85a,#c9a84c);color:#0b0e14;font-weight:800;cursor:pointer;">📄 '+L2('Ver reporte · Pre-reparación','View report · Pre-repair')+'</button>'):'')
      +partsBlock(c,insp,parts,waiting,inStage2)
      +'</div>';
    clearInterval(_tick); _tick=null;
    if(inStage2 && insp.stage2RunningSince){
      _tick=setInterval(function(){ var el=document.getElementById('carficha-timer'); var ip=_insp||{}; if(!el||!ip.stage2RunningSince){ clearInterval(_tick); _tick=null; return; } var secs=(Number(ip.stage2Secs)||0)+Math.max(0,(Date.now()-Date.parse(ip.stage2RunningSince))/1000); el.textContent=hms(secs); },1000);
    }
  }

  function partsBlock(c,insp,parts,waiting,inStage2){
    var recv=insp.partsRecv||{};
    var recvCount=parts.filter(function(p,i){return recv[String(i)]===true;}).length;
    var allIn=parts.length>0 && recvCount===parts.length;
    var html='';
    if(parts.length){
      var title=(waiting||inStage2)?(L2('🧩 Partes — recepción','🧩 Parts — receiving')+' ('+recvCount+'/'+parts.length+')'):(LB.partsH()+' ('+parts.length+')');
      html+='<div style="font-weight:800;font-size:13.5px;margin:16px 0 6px;">'+title+'</div>';
      html+=parts.map(function(p,i){
        var got=recv[String(i)]===true;
        var lbl='🧩 '+esc(p.label)+(p.area?(' <span style="font-size:11px;color:var(--muted,#8b93a3);">· '+esc(p.area)+'</span>'):'');
        if(waiting){
          return '<label style="display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid rgba(255,255,255,.06);cursor:pointer;">'
            +'<input type="checkbox" '+(got?'checked':'')+' onchange="LMG.cfReceivePart(\''+esc(c.id)+'\','+i+',this.checked)" style="width:20px;height:20px;flex:0 0 auto;accent-color:#35c46a;">'
            +'<span style="flex:1;min-width:0;font-size:13.5px;'+(got?'color:var(--muted,#8b93a3);text-decoration:line-through;':'')+'">'+lbl+'</span></label>';
        }
        return '<div style="font-size:13px;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);">'+(got?'✅ ':'🧩 ')+esc(p.label)+(p.area?(' <span style="font-size:11px;color:var(--muted,#8b93a3);">· '+esc(p.area)+'</span>'):'')+'</div>';
      }).join('');
    }
    if(waiting){
      html+='<button onclick="LMG.cfStartStage2(\''+esc(c.id)+'\')" style="width:100%;margin-top:14px;padding:12px;border-radius:12px;border:none;background:linear-gradient(135deg,#d9b85a,#c9a84c);color:#0b0e14;font-weight:800;cursor:pointer;'+(allIn?'':'opacity:.65;')+'">🏁 '+L2('Empezar etapa 2 (trabajo)','Start stage 2 (work)')+'</button>';
      if(parts.length && !allIn) html+='<div style="font-size:11.5px;text-align:center;margin-top:6px;line-height:1.45;color:var(--muted,#8b93a3);">'+L2('Marca las partes que llegaron. Puedes empezar de todos modos.','Check the parts that arrived. You can start anyway.')+'</div>';
    } else if(inStage2){
      var running=!!insp.stage2RunningSince;
      var baseSecs=(Number(insp.stage2Secs)||0)+(running?Math.max(0,(Date.now()-Date.parse(insp.stage2RunningSince))/1000):0);
      var btn='padding:12px;border-radius:12px;font-weight:800;cursor:pointer;';
      html+='<div style="text-align:center;margin:16px 0 4px;border-top:1px solid rgba(255,255,255,.06);padding-top:14px;">'
        +'<div style="font-size:11.5px;color:var(--muted,#8b93a3);">🏗️ '+L2('Etapa 2 · restauración','Stage 2 · restoration')+(insp.stage2By?(' · '+esc(insp.stage2By)):'')+'</div>'
        +'<div id="carficha-timer" style="font-size:32px;font-weight:800;font-variant-numeric:tabular-nums;color:'+(running?'#4c9bff':'var(--muted,#8b93a3)')+';margin-top:4px;letter-spacing:1px;">'+hms(baseSecs)+'</div>'
        +'<div style="font-size:11px;color:var(--muted,#8b93a3);">'+(running?('▶️ '+L2('trabajando','working')):('⏸️ '+L2('en pausa','paused')))+'</div></div>'
        +'<div style="display:flex;gap:8px;margin-top:10px;">'
        +(running
            ? '<button onclick="LMG.cfPause(\''+esc(c.id)+'\')" style="flex:1;'+btn+'border:1px solid var(--border,#232a36);background:var(--surface2,#1a1f29);color:var(--text,#fff);">⏸️ '+L2('Pausar','Pause')+'</button>'
            : '<button onclick="LMG.cfResume(\''+esc(c.id)+'\')" style="flex:1;'+btn+'border:1px solid var(--border,#232a36);background:var(--surface2,#1a1f29);color:var(--text,#fff);">▶️ '+L2('Reanudar','Resume')+'</button>')
        +'<button onclick="LMG.cfFinish(\''+esc(c.id)+'\')" style="flex:1.4;'+btn+'border:none;background:linear-gradient(135deg,#d9b85a,#c9a84c);color:#0b0e14;">✅ '+L2('Terminar','Finish')+'</button></div>'
        +'<div style="font-size:11px;text-align:center;margin-top:6px;color:var(--muted,#8b93a3);">'+L2('Al terminar pasa a detallado.','Finishing moves it to detailing.')+'</div>';
    }
    return html;
  }

  LMG.cfReport=function(){
    var insp=_insp||{}, box=document.getElementById('wh-carficha-box'); if(!box) return;
    clearInterval(_tick); _tick=null;
    var report=Array.isArray(insp.report)?insp.report:[];
    var all=[]; report.forEach(function(a){ (a.items||[]).forEach(function(it){ all.push(Object.assign({area:a.title},it)); }); });
    var red=all.filter(function(x){return x.state==='malo';}), yellow=all.filter(function(x){return x.state==='aten';}), ok=all.filter(function(x){return x.state==='bien';});
    function cardH(f,col){ return '<div style="background:var(--surface2,#1a1f29);border-left:3px solid '+col+';border-radius:10px;padding:10px 12px;margin-bottom:8px;"><div style="font-weight:700;font-size:14px;">'+(f.state==='malo'?'❌ ':(f.fix==='fixed'?'🔧 ':'⚠️ '))+esc(f.label)+'</div>'
      +'<div style="font-size:11.5px;margin-top:2px;color:var(--muted,#8b93a3);">'+esc(f.area||'')+(f.measure?(' · '+esc(f.measure)):'')+'</div>'
      +(f.note?'<div style="font-size:13px;margin-top:5px;">'+esc(f.note)+'</div>':'')
      +(f.fix==='fixed'?'<div style="font-size:12.5px;margin-top:4px;color:#35c46a;font-weight:700;">'+LB.fixedH()+(f.repair?(': '+esc(f.repair)):'')+'</div>':'')
      +(f.part?'<div style="font-size:12.5px;margin-top:4px;color:#d9b85a;font-weight:700;">🧩 '+esc(f.part)+'</div>':'')
      +(f.photo?'<img src="'+esc(f.photo)+'" style="margin-top:6px;width:72px;height:72px;object-fit:cover;border-radius:8px;">':'')+'</div>'; }
    function sec(title,col,arr){ return arr.length ? ('<div style="font-weight:800;font-size:13.5px;margin:16px 0 8px;color:'+col+';">'+title+' ('+arr.length+')</div>'+arr.map(function(x){return cardH(x,col);}).join('')) : ''; }
    var okHtml = ok.length ? ('<div style="font-weight:800;font-size:13.5px;margin:16px 0 8px;color:#35c46a;">'+LB.okH()+' ('+ok.length+')</div><div style="font-size:12.5px;line-height:1.7;color:var(--muted,#8b93a3);">'+ok.map(function(o){return '✓ '+esc(o.label);}).join(' · ')+'</div>') : '';
    box.innerHTML='<div style="padding:16px;">'
      +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><h2 style="font-size:18px;margin:0;">'+LB.reportTitle()+'</h2><button onclick="LMG.openCarFicha(\''+esc((_car||{}).id||'')+'\')" style="font-size:24px;color:var(--muted,#8b93a3);line-height:1;background:none;border:none;cursor:pointer;">‹</button></div>'
      +'<div style="font-size:12px;margin-bottom:12px;color:var(--muted,#8b93a3);">🚗 '+esc((_car||{}).label||'')+' · 📅 '+fmtD(insp.reportAt,true)+((insp.reportBy||insp.by)?(' · '+LB.byLbl()+': '+esc(insp.reportBy||insp.by)):'')+'</div>'
      +sec(LB.redH(),'#ff5a5a',red)+sec(LB.fixedH(),'#ffc94d',yellow)+okHtml
      +((!red.length&&!yellow.length&&!ok.length)?'<div style="text-align:center;padding:16px;color:var(--muted,#8b93a3);">'+LB.noFlags()+'</div>':'')
      +'<button onclick="LMG.cfClose()" style="width:100%;margin-top:14px;padding:11px;border-radius:12px;border:1px solid var(--border,#232a36);background:var(--surface2,#1a1f29);color:var(--text,#fff);cursor:pointer;">'+L2('Cerrar','Close')+'</button></div>';
  };

  async function _act(op, data, okMsg, close){
    try{ await call('mechDvi', Object.assign({op:op}, data||{})); if(okMsg) toast(okMsg); }
    catch(e){ toast((e&&e.message)||'Error', true); if(op!=='partcheck') return; }
    if(_ctx && _ctx.onChange){ try{ _ctx.onChange(); }catch(_){} }
    if(close){ LMG.cfClose(); } else { LMG.openCarFicha(data.carId); }
  }
  LMG.cfReceivePart=function(carId,idx,received){ _act('partcheck',{carId:carId,partIdx:idx,received:!!received}); };
  LMG.cfStartStage2=function(carId){ if(!confirm(L2('¿Empezar la etapa 2 (trabajo/restauración) de este carro?','Start stage 2 (work/restoration) for this car?'))) return; _act('startstage2',{carId:carId}, L2('🏁 Etapa 2 iniciada','🏁 Stage 2 started')); };
  LMG.cfPause=function(carId){ _act('stage2pause',{carId:carId}); };
  LMG.cfResume=function(carId){ _act('stage2resume',{carId:carId}); };
  LMG.cfFinish=function(carId){ if(!confirm(L2('¿Terminar la etapa 2? El carro pasa a detallado.','Finish stage 2? The car moves to detailing.'))) return; _act('finishstage2',{carId:carId,nextStage:'detalle'}, L2('✅ Etapa 2 terminada · a detallado','✅ Stage 2 done · to detailing'), true); };
})();
