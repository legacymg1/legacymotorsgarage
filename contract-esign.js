// contract-esign.js — Firma electronica compartida para los contratos (iPad, dedo/lapiz)
// No hace render: asume que la pagina ya lleno sus campos. Se auto-activa si hay lineas de firma del comprador.

(function setupSignature(){
  var buyerLines = Array.prototype.slice.call(document.querySelectorAll('.sign-line'))
    .filter(function(el){ return /(Buyer Signature|Firma del Comprador)/i.test(el.textContent); });
  if(!buyerLines.length) return;

  var wrap = document.createElement('div');
  wrap.className = 'esign-wrap no-print';
  wrap.style.cssText = 'margin:14px auto;max-width:700px;padding:12px;border:1px dashed #999;border-radius:8px;';
  wrap.innerHTML = '<div style="font-size:9pt;margin-bottom:8px;"><label style="cursor:pointer;"><input type="checkbox" id="esign-consent" style="vertical-align:middle;"> <strong>Buyer agrees to sign this contract electronically. / El Comprador acepta firmar este contrato de forma electronica.</strong></label></div><div style="font-size:8pt;color:#555;margin-bottom:4px;">Sign below with finger or stylus / Firme abajo con el dedo o lapiz:</div><canvas id="esign-pad" width="640" height="160" style="border:1px solid #999;border-radius:6px;background:#fff;touch-action:none;max-width:100%;display:block;"></canvas><div style="font-size:8pt;color:#555;margin:10px 0 4px;">Buyer initials / Iniciales del comprador:</div><canvas id="esign-initials" width="220" height="90" style="border:1px solid #999;border-radius:6px;background:#fff;touch-action:none;max-width:100%;display:block;"></canvas><button type="button" id="esign-clear" style="font-size:8pt;background:transparent;border:1px solid #999;border-radius:5px;padding:4px 12px;margin-top:6px;cursor:pointer;">Clear / Limpiar</button>';
  buyerLines[0].parentNode.insertBefore(wrap, buyerLines[0]);

  function makePad(cv){
    var ctx = cv.getContext('2d'); ctx.lineWidth=2.4; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle='#0a0a2a';
    var drawing=false, has=false, lx=0, ly=0;
    function pos(e){ var r=cv.getBoundingClientRect(); return {x:(e.clientX-r.left)*(cv.width/r.width), y:(e.clientY-r.top)*(cv.height/r.height)}; }
    cv.addEventListener('pointerdown',function(e){ drawing=true; var q=pos(e); lx=q.x; ly=q.y; e.preventDefault(); });
    cv.addEventListener('pointermove',function(e){ if(!drawing)return; var q=pos(e); ctx.beginPath(); ctx.moveTo(lx,ly); ctx.lineTo(q.x,q.y); ctx.stroke(); lx=q.x; ly=q.y; has=true; e.preventDefault(); });
    cv.addEventListener('pointerup',function(){drawing=false;});
    cv.addEventListener('pointerleave',function(){drawing=false;});
    return { canvas:cv, hasInk:function(){return has;}, clear:function(){ ctx.clearRect(0,0,cv.width,cv.height); has=false; } };
  }
  var sig = makePad(document.getElementById('esign-pad'));
  var ini = makePad(document.getElementById('esign-initials'));
  document.getElementById('esign-clear').onclick = function(){ sig.clear(); ini.clear(); };
  window.__esign = { canvas:sig.canvas, hasInk:sig.hasInk, initCanvas:ini.canvas, hasInitials:ini.hasInk, buyerLines:buyerLines };

  // Casillas de opcion (CCOA/GPS) por grupo, si existen
  document.querySelectorAll('.opt-box').forEach(function(box){
    box.style.cursor='pointer';
    box.onclick=function(){
      var grp=this.getAttribute('data-optgroup')||'';
      var selq=grp?'.opt-box[data-optgroup="'+grp+'"] .checkbox':'.opt-box .checkbox';
      document.querySelectorAll(selq).forEach(function(c){c.innerHTML='';c.style.background='';});
      var mine=this.querySelector('.checkbox');
      mine.innerHTML='<span style="color:#fff;font-size:10px;line-height:14px;display:block;text-align:center;">✓</span>';
      mine.style.background='#000';
    };
  });

  // Boton FIRMAR: inyectar en la barra existente o crear una
  var abar=document.querySelector('.action-bar');
  if(!abar){
    abar=document.createElement('div'); abar.className='no-print action-bar';
    abar.style.cssText='position:fixed;bottom:0;left:0;right:0;background:#000;border-top:2px solid #f0c040;padding:12px;display:flex;gap:10px;justify-content:center;z-index:9999;';
    document.body.appendChild(abar); document.body.style.paddingBottom='80px';
  }
  var fb=document.createElement('button'); fb.type='button'; fb.textContent='✍️ FIRMAR Y GUARDAR';
  fb.style.cssText='background:#22a06b;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;';
  fb.onclick=function(){ window.signAndSave(); };
  abar.insertBefore(fb, abar.firstChild);
})();

var __FBCFG = {apiKey:"AIzaSyDrCMJQclGosVp3EV49vmwKDnji-Oti5j0",authDomain:"legacy-motors-garage.firebaseapp.com",projectId:"legacy-motors-garage",storageBucket:"legacy-motors-garage.firebasestorage.app",messagingSenderId:"783567672493",appId:"1:783567672493:web:3a825f2f59ec1c25e9a224"};

window.signAndSave = async function(){
  var q=new URLSearchParams(window.location.search);
  var clientId=q.get('clientId');
  if(!clientId){ alert('No hay cliente ligado. Genera el contrato desde la tarjeta del cliente.'); return; }
  var es=window.__esign;
  var cons=document.getElementById('esign-consent');
  if(!cons || !cons.checked){ alert('El comprador debe aceptar firmar electronicamente.'); return; }
  if(!es || !es.hasInk()){ alert('Falta la firma del comprador.'); return; }
  var __slots=document.querySelectorAll('.initial-slot');
  if(__slots.length && (!es.hasInitials || !es.hasInitials())){ alert('Faltan las iniciales del comprador (recuadro de iniciales).'); return; }
  var __gps=document.querySelectorAll('.opt-box[data-optgroup="gps"]');
  if(__gps.length){ var __g=false; __gps.forEach(function(b){ var c=b.querySelector('.checkbox'); if(c && c.textContent.indexOf('✓')>=0) __g=true; }); if(!__g){ alert('Selecciona una opcion del GPS (I CONSENT o I DECLINE) antes de firmar.'); return; } }
  if(!confirm('Firmar y guardar el contrato? Se guarda una copia oficial firmada en el expediente del cliente.')) return;

  // asegurar sesion (misma cuenta del admin)
  var __user=null;
  try{
    var _A=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    var _AU=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    var _app=_A.getApps().length?_A.getApps()[0]:_A.initializeApp(__FBCFG);
    var _auth=_AU.getAuth(_app);
    if(_auth.authStateReady){ await _auth.authStateReady(); }
    __user=_auth.currentUser;
  }catch(e){}
  if(!__user){ alert('No hay sesion iniciada. Abre el contrato desde la tarjeta del cliente estando dentro del admin (con tu cuenta) y vuelve a intentar.'); return; }

  var sigData=es.canvas.toDataURL('image/png');
  var stampNice=new Date().toLocaleString('en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  es.buyerLines.forEach(function(line){
    var label=line.innerHTML;
    line.innerHTML='<img src="'+sigData+'" alt="signature" style="height:52px;display:block;margin:0 auto 2px;"><div style="border-top:1px solid #000;padding-top:2px;">'+label+'<br><span style="font-size:7pt;color:#888;">Firmado electr&oacute;nicamente / e-signed</span></div>';
    var row=line.parentNode;
    if(row && row.querySelectorAll){
      var sibs=row.querySelectorAll('.sign-line');
      for(var i=0;i<sibs.length;i++){
        var sl=sibs[i];
        var d=(sl.textContent||'').replace(/\s/g,'').toLowerCase();
        if(sl!==line && d && d.length<=12 && (d.indexOf('date')>=0 || d.indexOf('fecha')>=0)){
          sl.innerHTML=stampNice+'<br><span style="font-size:8pt;color:#555;">Date / Fecha</span>';
        }
      }
    }
  });
  if(es.initCanvas){
    var iniData=es.initCanvas.toDataURL('image/png');
    document.querySelectorAll('.initial-slot').forEach(function(sl){ sl.innerHTML='<img src="'+iniData+'" alt="initials" style="height:30px;display:block;margin:1px auto;">'; });
    document.querySelectorAll('.opt-box').forEach(function(box){
      var chk=box.querySelector('.checkbox'); var ib=box.querySelector('.initial-box');
      if(ib && chk && chk.textContent.indexOf('✓')>=0){ ib.innerHTML='<img src="'+iniData+'" alt="initials" style="height:24px;display:block;margin:1px auto;">'; }
    });
  }
  document.querySelectorAll('.esign-wrap, .action-bar, .lmg-banner').forEach(function(el){el.remove();});
  document.querySelectorAll('[contenteditable]').forEach(function(el){ el.removeAttribute('contenteditable'); el.style.cursor=''; });
  document.querySelectorAll('script').forEach(function(s){s.remove();});
  var snapshotHTML='<!doctype html>'+document.documentElement.outerHTML;
  try{
    var A2=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    var FS=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    var ST=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-storage.js');
    var app=A2.getApps().length?A2.getApps()[0]:A2.initializeApp(__FBCFG);
    var db=FS.getFirestore(app), st=ST.getStorage(app);
    var cnum=q.get('contractNum')||('LMG-'+new Date().getFullYear()+'-'+String(Date.now()).slice(-5));
    var snap=await FS.getDoc(FS.doc(db,'clients',clientId));
    var existing=snap.exists()?snap.data():{};
    var versions=Array.isArray(existing.signedContractVersions)?existing.signedContractVersions.slice():[];
    var reason=null; try{ reason=sessionStorage.getItem('correctionReason'); }catch(e){}
    var newVer=versions.length+1;
    var path='contracts/'+clientId+'/'+cnum+'-v'+newVer+'.html';
    var sref=ST.ref(st,path);
    await ST.uploadString(sref, snapshotHTML, 'raw', {contentType:'text/html; charset=utf-8'});
    var url=await ST.getDownloadURL(sref);
    var nowIso=new Date().toISOString();
    versions=versions.map(function(v){ if(v.status==='active'){ v.status='voided'; v.voidedAt=nowIso; v.voidReason=reason||'Correccion'; } return v; });
    var entry={version:newVer,url:url,contractNumber:cnum,signedAt:nowIso,method:'esign',status:'active'};
    if(reason) entry.correctionReason=reason;
    versions.push(entry);
    await FS.setDoc(FS.doc(db,'clients',clientId),{signedContractVersions:versions,signedContract:entry},{merge:true});
    try{ sessionStorage.removeItem('correctionReason'); }catch(e){}
    alert('Contrato firmado y guardado. Numero: '+cnum+' (version '+newVer+').');
    var u2=new URL(window.location.href); u2.searchParams.delete('__correct'); u2.searchParams.set('_cb', String(Date.now())); window.location.href=u2.toString();
  }catch(e){ alert('Error al guardar: '+e.message); }
};

// ===== BLOQUEO DE CONTRATO FIRMADO + CORRECCION (versionado) =====
(async function checkLock(){
  var q=new URLSearchParams(window.location.search);
  var clientId=q.get('clientId');
  if(!clientId) return;
  var correcting = q.get('__correct')==='1';
  try{
    var A2=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    var FS=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    var AU=await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
    var app=A2.getApps().length?A2.getApps()[0]:A2.initializeApp(__FBCFG);
    var auth=AU.getAuth(app);
    if(auth.authStateReady){ await auth.authStateReady(); }
    if(!auth.currentUser) return;
    var db=FS.getFirestore(app);
    var snap=await FS.getDoc(FS.doc(db,'clients',clientId));
    var data=snap.exists()?snap.data():{};
    if(correcting){
      var reason=''; try{ reason=sessionStorage.getItem('correctionReason')||''; }catch(e){}
      var nextV=((data.signedContractVersions||[]).length)+1;
      var b=document.createElement('div'); b.className='lmg-banner no-print';
      b.style.cssText='position:sticky;top:0;z-index:9998;background:#b45309;color:#fff;padding:10px 14px;font-size:13px;font-weight:600;text-align:center;';
      b.innerHTML='✏️ CORRIGIENDO — al firmar se creara la version '+nextV+' y la anterior quedara ANULADA.'+(reason?(' Motivo: '+reason):'');
      document.body.insertBefore(b, document.body.firstChild);
      return;
    }
    var sc=data.signedContract;
    if(sc && sc.status==='active'){ lockContract(sc, (data.signedContractVersions||[])); }
  }catch(e){ /* si falla la lectura, no bloquea */ }
})();

function lockContract(sc, versions){
  document.querySelectorAll('[contenteditable]').forEach(function(el){ el.removeAttribute('contenteditable'); el.style.borderBottom=''; el.style.cursor=''; });
  document.querySelectorAll('.esign-wrap, .action-bar, .lmg-banner').forEach(function(el){ el.remove(); });
  document.querySelectorAll('.opt-box').forEach(function(b){ b.onclick=null; b.style.cursor='default'; });
  var d=new Date(sc.signedAt); var ds=isNaN(d.getTime())?sc.signedAt:d.toLocaleString('en-US');
  var voided=(versions||[]).filter(function(v){return v.status==='voided';}).length;
  var banner=document.createElement('div'); banner.className='lmg-banner no-print';
  banner.style.cssText='position:sticky;top:0;z-index:9998;background:#065f46;color:#fff;padding:12px 14px;font-size:13px;font-weight:600;text-align:center;';
  banner.innerHTML='✅ CONTRATO FIRMADO — '+(sc.contractNumber||'')+' &middot; '+ds+' &middot; version '+(sc.version||1)+(voided?(' &middot; ('+voided+' anterior(es) anulada(s))'):'')+'<br><span style="font-weight:400;font-size:11px;">Documento oficial bloqueado. Para corregir un error usa el boton Corregir.</span>';
  document.body.insertBefore(banner, document.body.firstChild);
  var bar=document.createElement('div'); bar.className='no-print';
  bar.style.cssText='position:fixed;bottom:0;left:0;right:0;background:#000;border-top:2px solid #f0c040;padding:12px;display:flex;gap:10px;justify-content:center;z-index:9999;flex-wrap:wrap;';
  bar.innerHTML='<button onclick="window.open(\''+sc.url+'\',\'_blank\')" style="background:#f0c040;color:#000;border:none;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:700;cursor:pointer;">📄 Ver firmado oficial</button>'
    +'<button onclick="window.print()" style="background:transparent;color:#f0c040;border:2px solid #f0c040;border-radius:8px;padding:12px 20px;font-size:14px;font-weight:700;cursor:pointer;">🖨️ Imprimir</button>'
    +'<button onclick="startCorrection()" style="background:transparent;color:#f0c040;border:1px solid #b45309;border-radius:8px;padding:12px 20px;font-size:13px;cursor:pointer;">✏️ Corregir (nueva version)</button>'
    +'<button onclick="window.close()" style="background:transparent;color:#aaa;border:1px solid #444;border-radius:8px;padding:12px 16px;font-size:14px;cursor:pointer;">✕ Cerrar</button>';
  document.body.appendChild(bar);
  document.body.style.paddingBottom='90px';
}

window.startCorrection=function(){
  var reason=prompt('Motivo de la correccion (queda guardado en el registro). Ejemplo: se corrigio el numero de pagos.');
  if(reason===null) return;
  if(!reason.trim()){ alert('Escribe el motivo para continuar.'); return; }
  try{ sessionStorage.setItem('correctionReason', reason.trim()); }catch(e){}
  var u=new URL(window.location.href); u.searchParams.set('__correct','1'); u.searchParams.set('_cb', String(Date.now())); window.location.href=u.toString();
};
