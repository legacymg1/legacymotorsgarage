/* 🌐 Legacy Motors — bot de ventas de la página web (visitantes). Autónomo, sin login. */
(function(){
  var ENDPOINT='https://us-central1-legacy-motors-garage.cloudfunctions.net/siteChat';
  var lang=(navigator.language||'es').toLowerCase().indexOf('en')===0?'en':'es';
  var T={ es:{ open:'¿Buscas carro? Escríbenos', preview:'¡Hola! 😊 ¿En qué te ayudamos?', writing:'escribiendo', title:'Legacy Motors Garage', sub:'Te ayudamos a estrenar hoy 🚗', ph:'Escribe tu mensaje…', send:'Enviar', hi:'¡Hola! 😊 ¿Cómo estás? Con gusto te ayudamos — ¿qué andas buscando?', err:'Perdón, tuve un detalle. Llámanos al (559) 540-5145.' },
           en:{ open:'Looking for a car? Chat with us', preview:'Hi! 😊 How can we help?', writing:'typing', title:'Legacy Motors Garage', sub:'Drive home today 🚗', ph:'Type your message…', send:'Send', hi:'Hi there! 😊 How are you? We’re happy to help — what are you looking for?', err:'Sorry, I had a hiccup. Call us at (559) 540-5145.' } };
  function t(k){ return (T[lang]&&T[lang][k])||T.es[k]; }
  var msgs=[{role:'assistant',content:''}]; // el saludo se rellena abajo (según idioma)
  msgs[0].content=T[lang].hi;
  var openState=false, busy=false, unread=1;
  // 🆔 Id de conversación (uno por visitante POR DÍA → para contar personas al día y poder repasar las pláticas).
  function bDay(){ try{ return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles'}).format(new Date()).replace(/-/g,''); }catch(e){ return '00000000'; } }
  var convoId='';
  try{ convoId=localStorage.getItem('lmg_bot_convo')||''; }catch(e){}
  var _td=bDay();
  if(!convoId || convoId.indexOf('c'+_td+'_')!==0){ convoId='c'+_td+'_'+Math.random().toString(36).slice(2,9); try{ localStorage.setItem('lmg_bot_convo', convoId); }catch(e){} }
  // 💾 Persistencia: si el cliente refresca la página, NO se pierde la plática (se guarda en su navegador, misma conversación del día).
  function saveMsgs(){ try{ localStorage.setItem('lmg_bot_msgs', JSON.stringify({ c:convoId, m:msgs.slice(-40) })); }catch(e){} }
  try{ var _sv=JSON.parse(localStorage.getItem('lmg_bot_msgs')||'null'); if(_sv && _sv.c===convoId && Array.isArray(_sv.m) && _sv.m.length){ msgs=_sv.m; unread=0; } }catch(e){}

  var css=document.createElement('style');
  css.textContent='#lmb-fab{position:fixed;right:18px;bottom:22px;z-index:2147482000;background:#0b0e14;color:#f0c040;border:2px solid #f0c040;border-radius:34px;height:62px;max-width:62px;padding:0;overflow:hidden;white-space:nowrap;font:700 15.5px -apple-system,system-ui,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:max-width .5s cubic-bezier(.2,.85,.25,1),padding .5s;}'
   +'#lmb-fab .ic{font-size:26px;flex:0 0 auto;width:58px;text-align:center;line-height:1;transition:width .5s;}'
   +'#lmb-fab .txt{display:inline-flex;align-items:center;gap:8px;opacity:0;transition:opacity .35s;}'
   +'#lmb-fab.wide{max-width:340px;padding:0 20px 0 2px;justify-content:flex-start;}'
   +'#lmb-fab.wide .ic{width:44px;}'
   +'#lmb-fab.wide .txt{opacity:1;}'
   +'#lmb-badge{display:none;align-items:center;justify-content:center;background:#c0392b;color:#fff;border-radius:50%;width:21px;height:21px;font-size:11px;font-weight:800;flex:0 0 auto;}'
   +'.lmb-dots i{font-style:normal;opacity:.3;animation:lmbblink 1.2s infinite;}.lmb-dots i:nth-child(2){animation-delay:.2s}.lmb-dots i:nth-child(3){animation-delay:.4s}'
   +'@keyframes lmbblink{0%,100%{opacity:.3}50%{opacity:1}}'
   +'@keyframes lmbpulse{0%,100%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 0 rgba(240,192,64,.55)}50%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 14px rgba(240,192,64,0)}}'
   +'#lmb-fab.pulse{animation:lmbpulse 2.2s infinite;}'
   +'#lmb-panel{position:fixed;inset:0;z-index:2147482001;background:rgba(0,0,0,.45);display:none;font-family:-apple-system,system-ui,sans-serif;}'
   +'#lmb-panel.on{display:block;}'
   +'#lmb-sheet{position:fixed;right:14px;bottom:calc(20px + env(safe-area-inset-bottom));width:min(400px,calc(100vw - 28px));height:min(72vh,620px);background:#0b0e14;border:2px solid #f0c040;border-radius:20px;box-shadow:0 22px 60px rgba(0,0,0,.7);display:flex;flex-direction:column;overflow:hidden;}'
   +'#lmb-hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#151a24,#0b0e14);border-bottom:1px solid #2a2f3a;}'
   +'#lmb-hd .av{width:40px;height:40px;flex:0 0 auto;border-radius:50%;background:#1e232d;display:flex;align-items:center;justify-content:center;font-size:20px;overflow:hidden;}'
   +'#lmb-hd .ti{flex:1;min-width:0;color:#e7e9ee;font-weight:800;font-size:15px;} #lmb-hd .su{font-size:11px;color:#98a0b0;font-weight:500;}'
   +'#lmb-x{background:#1e232d;border:none;color:#e7e9ee;font-size:20px;font-weight:800;cursor:pointer;line-height:1;width:38px;height:38px;border-radius:50%;flex:0 0 auto;}'
   +'#lmb-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;background:#0b0e14;-webkit-overflow-scrolling:touch;}'
   +'.lmb-b{max-width:80%;padding:10px 14px;border-radius:16px;font-size:15px;line-height:1.45;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.25);}'
   +'.lmb-bot{align-self:flex-start;background:#1a1f2b;color:#e7e9ee;border-bottom-left-radius:5px;}'
   +'.lmb-me{align-self:flex-end;background:#f0c040;color:#0b0e14;font-weight:500;border-bottom-right-radius:5px;}'
   +'.lmb-typing{align-self:flex-start;color:#98a0b0;font-size:13px;padding:4px 6px;}'
   +'#lmb-bar{flex:0 0 auto;display:flex;gap:8px;align-items:flex-end;padding:10px 12px 12px;border-top:1px solid #2a2f3a;background:#151a24;}'
   +'#lmb-in{flex:1;min-width:0;background:#0b0e14;border:1px solid #2a2f3a;border-radius:22px;padding:12px 16px;color:#e7e9ee;font-size:16px;outline:none;}'
   +'#lmb-snd{flex:0 0 auto;background:#f0c040;color:#0b0e14;border:none;border-radius:50%;width:44px;height:44px;font-weight:800;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;}';
  document.head.appendChild(css);

  var fab=document.createElement('button'); fab.id='lmb-fab'; fab.innerHTML='<span class="ic">💬</span><span class="txt">'+t('open')+'<span id="lmb-badge"></span></span>'; fab.onclick=toggle; document.body.appendChild(fab);
  var panel=document.createElement('div'); panel.id='lmb-panel';
  panel.innerHTML='<div id="lmb-sheet"><div id="lmb-hd"><div class="av"><img src="client-lmg-192.png" alt="Legacy" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div><div class="ti">'+t('title')+'<div class="su">'+t('sub')+'</div></div><button id="lmb-x">✕</button></div>'
   +'<div id="lmb-msgs"></div>'
   +'<div id="lmb-bar"><input id="lmb-in" type="text" autocomplete="off" autocorrect="on" autocapitalize="sentences" enterkeyhint="send" placeholder="'+t('ph')+'"><button id="lmb-snd" aria-label="'+t('send')+'">➤</button></div></div>';
  document.body.appendChild(panel);
  panel.addEventListener('click',function(e){ if(e.target===panel) toggle(); });   // clic afuera (fondo oscuro) → cierra
  document.getElementById('lmb-x').onclick=toggle;
  document.getElementById('lmb-snd').onclick=send;
  var sheet=document.getElementById('lmb-sheet');
  var inp=document.getElementById('lmb-in');
  inp.addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });
  inp.addEventListener('focus',function(){ setTimeout(fit,150); setTimeout(fit,350); });
  // 📱 Burbuja flotante fija: el TÍTULO siempre visible arriba y la barra siempre arriba del teclado.
  // En móvil anclamos con top+bottom (altura auto) → el header nunca se esconde y queda hueco arriba (look de burbuja).
  function fit(){
    var vv=window.visualViewport;
    if(window.innerWidth>700 || !vv){ sheet.style.top=''; sheet.style.bottom=''; sheet.style.height=''; return; }  // escritorio → CSS
    var vTop=vv.offsetTop||0;
    var kb=Math.max(0, window.innerHeight - vv.height - vTop);
    if(kb>60){ sheet.style.top=(vTop+10)+'px'; sheet.style.bottom=(kb+8)+'px'; }        // con teclado: llena el área visible sobre el teclado
    else { sheet.style.top=(vTop+Math.round(vv.height*0.11))+'px'; sheet.style.bottom='16px'; }  // sin teclado: hueco arriba → burbuja
    sheet.style.height='auto';
    var m=document.getElementById('lmb-msgs'); if(m) m.scrollTop=m.scrollHeight;
  }
  function vpOn(){ var vv=window.visualViewport; if(vv){ vv.addEventListener('resize',fit); vv.addEventListener('scroll',fit); } fit(); }
  function vpOff(){ var vv=window.visualViewport; if(vv){ vv.removeEventListener('resize',fit); vv.removeEventListener('scroll',fit); } sheet.style.top=''; sheet.style.bottom=''; sheet.style.height=''; }

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function render(){
    var box=document.getElementById('lmb-msgs');
    box.innerHTML=msgs.map(function(m){ return '<div class="lmb-b '+(m.role==='assistant'?'lmb-bot':'lmb-me')+'">'+esc(m.content).replace(/\n/g,'<br>')+'</div>'; }).join('')
      +(busy?'<div class="lmb-typing">Legacy está escribiendo…</div>':'');
    box.scrollTop=box.scrollHeight;
  }
  function updateFab(){
    var b=document.getElementById('lmb-badge'); if(b){ b.style.display=unread>0?'inline-flex':'none'; b.textContent=unread; }
    fab.classList.toggle('pulse', unread>0 && !openState && fab.classList.contains('wide'));
  }
  function toggle(){
    openState=!openState; panel.classList.toggle('on',openState); fab.style.display=openState?'none':'flex';
    if(openState){ unread=0; render(); vpOn(); setTimeout(function(){ var i=document.getElementById('lmb-in'); if(i && window.innerWidth>600) i.focus(); },120); }
    else vpOff();
    updateFab();
  }
  function send(){
    var i=document.getElementById('lmb-in'); var txt=(i.value||'').trim(); if(!txt||busy) return;
    i.value=''; msgs.push({role:'user',content:txt}); busy=true; render(); saveMsgs();
    fetch(ENDPOINT,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ lang:lang, convoId:convoId, messages:msgs.slice(-12) }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ busy=false; msgs.push({role:'assistant',content:(d&&d.reply)||t('err')}); if(!openState){ unread++; updateFab(); } render(); saveMsgs(); })
      .catch(function(){ busy=false; msgs.push({role:'assistant',content:t('err')}); render(); saveMsgs(); });
  }
  // 🎣 Enganche: entra como círculo; a los ~2.5s se abre la barra mostrando "escribiendo…" (como un asesor real),
  // y a los ~5s suelta el saludo casual con el globito rojo "1" (mensaje no leído) para invitar a abrir.
  function setFabText(html){ var tx=fab.querySelector('.txt'); if(tx) tx.innerHTML=html+'<span id="lmb-badge"></span>'; }
  setTimeout(function(){ if(openState) return; fab.classList.add('wide'); setFabText('<span style="opacity:.9;">'+t('writing')+'</span><span class="lmb-dots"><i>.</i><i>.</i><i>.</i></span>'); unread=0; updateFab(); }, 2500);
  setTimeout(function(){ if(openState) return; setFabText(t('preview')); unread=1; updateFab(); }, 5200);
  updateFab();
})();
