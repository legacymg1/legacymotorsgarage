/* ============================================================================
   legacy-photo.js — VISOR de fotos/documentos COMPARTIDO (un solo ecosistema)
   Fuente ÚNICA de window.showPhoto para admin / finanzas / index (y quien lo use).
   - Abre un overlay por ENCIMA de cualquier modal (z-index casi máximo) → nunca
     queda "detrás" (ese era el bug de la tarjeta del cliente).
   - Detecta tipo por firma: PDF / HTML (contratos) / JPG / PNG / GIF / HEIC.
   - HEIC de iPhone: lo convierte en el navegador con heic2any (se carga solo del
     CDN); si no se puede, muestra el aviso para usar el iPad / "Reparar fotos".
   - Autocontenido: NO depende de funciones de módulo de la página (que no ve).
   Cambiar aquí = cambia en TODAS las páginas que lo incluyen. [[one-ecosystem-rule]]
   ========================================================================== */
(function(){
  // Carga un <script> del CDN una sola vez (para heic2any).
  function _loadScriptOnce(src){
    return new Promise(function(resolve,reject){
      try{
        var ex=document.querySelector('script[data-lp="'+src+'"]');
        if(ex){ if(ex.getAttribute('data-ok')==='1') return resolve(); ex.addEventListener('load',function(){resolve();}); ex.addEventListener('error',reject); return; }
        var s=document.createElement('script'); s.src=src; s.async=true; s.setAttribute('data-lp',src);
        s.onload=function(){ s.setAttribute('data-ok','1'); resolve(); }; s.onerror=reject;
        document.head.appendChild(s);
      }catch(e){ reject(e); }
    });
  }

  // ¿Los primeros bytes son de un HEIC/HEIF de iPhone? (ftyp + marca hei/hev/mif/msf)
  function _isHeicSig(sig){
    try{
      if(sig[4]===0x66&&sig[5]===0x74&&sig[6]===0x79&&sig[7]===0x70){
        var brand=String.fromCharCode(sig[8],sig[9],sig[10],sig[11]).toLowerCase();
        if(/^(hei|hev|mif|msf)/.test(brand)) return true;
      }
    }catch(e){}
    return false;
  }

  // Convierte un blob HEIC a JPEG con heic2any (cargado del CDN). Lanza si no se puede.
  async function _heicToJpeg(blob){
    if(!window.heic2any){ await _loadScriptOnce('https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js'); }
    if(!window.heic2any) throw new Error('heic2any no disponible');
    var out=await window.heic2any({blob:blob, toType:'image/jpeg', quality:0.9});
    return (out instanceof Blob)? out : new Blob([out], {type:'image/jpeg'});
  }

  window.showPhoto = async function(url, title){
    if(!url) return;
    var ov=document.createElement('div');
    // z casi máximo: SIEMPRE encima de cualquier modal (la tarjeta del cliente usa ~2147483050)
    ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    ov.innerHTML='<div style="color:#fff;font-size:14px;margin-bottom:10px;font-weight:600;">'+(title||'Documento')+'</div>'
      +'<div data-body style="color:#fff;font-size:13px;">Cargando…</div>'
      +'<div style="margin-top:14px;display:flex;gap:10px;">'
      +'<a data-open href="'+url+'" target="_blank" style="background:transparent;color:#f0c040;border:1px solid #f0c040;border-radius:8px;padding:8px 16px;text-decoration:none;font-size:13px;">Abrir en pestaña ↗</a>'
      +'<button type="button" data-close style="background:#f0c040;color:#000;border:none;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:700;cursor:pointer;">Cerrar ✕</button>'
      +'</div>';
    var close=function(){ try{ov.remove();}catch(e){} document.removeEventListener('keydown',onKey); };
    var onKey=function(e){ if(e.key==='Escape') close(); };
    ov.addEventListener('click',function(e){ if(e.target===ov) close(); });
    ov.querySelector('[data-close]').onclick=close;
    document.addEventListener('keydown',onKey);
    document.body.appendChild(ov);
    var body=ov.querySelector('[data-body]'), openLink=ov.querySelector('[data-open]');
    try{
      var resp=await fetch(url); if(!resp.ok) throw new Error('HTTP '+resp.status);
      var blob=await resp.blob();
      var sig=new Uint8Array(await blob.slice(0,12).arrayBuffer());
      var isPdf=sig[0]===0x25&&sig[1]===0x50&&sig[2]===0x44&&sig[3]===0x46;
      var isJpg=sig[0]===0xFF&&sig[1]===0xD8;
      var isPng=sig[0]===0x89&&sig[1]===0x50;
      var isGif=sig[0]===0x47&&sig[1]===0x49;
      var isHtml=sig[0]===0x3C||((blob.type||'').indexOf('html')>=0);   // contratos HTML empiezan con '<'
      var isHeic=_isHeicSig(sig)||((blob.type||'').toLowerCase().indexOf('heic')>=0)||((blob.type||'').toLowerCase().indexOf('heif')>=0);

      // HEIC de iPhone → convertir a JPEG en el navegador
      if(isHeic){
        try{ blob=await _heicToJpeg(blob); isJpg=true; isHeic=false; }
        catch(e){
          body.innerHTML='<div data-heic style="color:#fff;max-width:440px;text-align:center;line-height:1.5;">Esta foto está en formato <strong>HEIC (iPhone)</strong> y no se pudo convertir aquí. Ábrela en el <strong>iPad</strong>, o corre <strong>🛠 Reparar fotos</strong> (en el iPad) para convertirla a imagen normal que se vea en todos lados.</div>';
          return;
        }
      }

      var type=blob.type;
      if(!type||type==='application/octet-stream'){
        type=isPdf?'application/pdf':isHtml?'text/html':isJpg?'image/jpeg':isPng?'image/png':isGif?'image/gif':'image/jpeg';
        blob=new Blob([blob],{type:type});
      }
      var burl=URL.createObjectURL(blob);
      if(openLink) openLink.href=burl;   // "abrir en pestaña" ya con tipo correcto (previsualiza, no descarga)
      if(type==='application/pdf'||(type.indexOf('html')>=0)||isHtml){
        body.innerHTML='<iframe src="'+burl+'" style="width:92vw;height:80vh;border:none;border-radius:8px;background:#fff;"></iframe>';
      } else {
        body.innerHTML='<img src="'+burl+'" style="max-width:96%;max-height:80vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);background:#fff;">';
      }
    }catch(err){
      body.innerHTML='<div style="color:#fff;text-align:center;max-width:420px;">No se pudo cargar la vista previa aquí. Usa <strong>Abrir en pestaña ↗</strong> abajo.</div>';
    }
  };

  try{ window.LMG=window.LMG||{}; window.LMG.showPhoto=window.showPhoto; }catch(e){}
})();
