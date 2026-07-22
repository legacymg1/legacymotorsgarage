/* 🌐 Legacy Motors — bot de ventas de la página web (visitantes). Autónomo, sin login. */
(function(){
  var ENDPOINT='https://us-central1-legacy-motors-garage.cloudfunctions.net/siteChat';
  var lang=(navigator.language||'es').toLowerCase().indexOf('en')===0?'en':'es';
  var T={ es:{ open:'💬 ¿Buscas carro? Escríbenos', title:'Legacy Motors Garage', sub:'Te ayudamos a estrenar hoy 🚗', ph:'Escribe tu mensaje…', send:'Enviar', hi:'¡Hola! 👋 Bienvenido a Legacy Motors Garage. ¿Qué tipo de carro buscas?', err:'Perdón, tuve un detalle. Llámanos al (559) 540-5145.' },
           en:{ open:'💬 Looking for a car? Chat with us', title:'Legacy Motors Garage', sub:'Drive home today 🚗', ph:'Type your message…', send:'Send', hi:'Hi! 👋 Welcome to Legacy Motors Garage. What kind of car are you looking for?', err:'Sorry, I had a hiccup. Call us at (559) 540-5145.' } };
  function t(k){ return (T[lang]&&T[lang][k])||T.es[k]; }
  var msgs=[{role:'assistant',content:''}]; // el saludo se rellena abajo (según idioma)
  msgs[0].content=T[lang].hi;
  var openState=false, busy=false, unread=1;

  var css=document.createElement('style');
  css.textContent='#lmb-fab{position:fixed;right:18px;bottom:22px;z-index:2147482000;background:#0b0e14;color:#f0c040;border:2px solid #f0c040;border-radius:34px;padding:16px 24px;font:700 16px -apple-system,system-ui,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5);cursor:pointer;display:flex;align-items:center;gap:10px;}'
   +'#lmb-fab .dot{width:11px;height:11px;border-radius:50%;background:#3ecf8e;box-shadow:0 0 0 4px rgba(62,207,142,.25);}'
   +'#lmb-badge{background:#c0392b;color:#fff;border-radius:50%;min-width:22px;height:22px;font-size:12px;font-weight:800;display:none;align-items:center;justify-content:center;padding:0 5px;margin-left:2px;}'
   +'@keyframes lmbpulse{0%,100%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 0 rgba(240,192,64,.55)}50%{box-shadow:0 12px 34px rgba(0,0,0,.5),0 0 0 14px rgba(240,192,64,0)}}'
   +'#lmb-fab.pulse{animation:lmbpulse 2.2s infinite;}'
   +'#lmb-panel{position:fixed;right:18px;bottom:20px;z-index:2147482001;width:min(380px,calc(100vw - 24px));height:min(560px,calc(100vh - 40px));background:#0b0e14;border:1px solid #2a2f3a;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.6);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,system-ui,sans-serif;}'
   +'#lmb-panel.on{display:flex;}'
   +'#lmb-hd{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,#151a24,#0b0e14);border-bottom:1px solid #2a2f3a;}'
   +'#lmb-hd .av{width:40px;height:40px;border-radius:50%;background:#1e232d;display:flex;align-items:center;justify-content:center;font-size:20px;}'
   +'#lmb-hd .ti{flex:1;min-width:0;color:#e7e9ee;font-weight:800;font-size:15px;} #lmb-hd .su{font-size:11px;color:#98a0b0;font-weight:500;}'
   +'#lmb-x{background:none;border:none;color:#98a0b0;font-size:22px;font-weight:800;cursor:pointer;line-height:1;}'
   +'#lmb-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:9px;background:#0b0e14;}'
   +'.lmb-b{max-width:82%;padding:9px 13px;border-radius:15px;font-size:14px;line-height:1.45;word-break:break-word;}'
   +'.lmb-bot{align-self:flex-start;background:#151a24;color:#e7e9ee;border:1px solid #2a2f3a;}'
   +'.lmb-me{align-self:flex-end;background:#f0c040;color:#0b0e14;font-weight:500;}'
   +'.lmb-typing{align-self:flex-start;color:#98a0b0;font-size:13px;padding:4px 6px;}'
   +'#lmb-bar{flex:0 0 auto;display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));border-top:1px solid #2a2f3a;background:#151a24;}'
   +'#lmb-in{flex:1;min-width:0;background:#0b0e14;border:1px solid #2a2f3a;border-radius:12px;padding:11px 13px;color:#e7e9ee;font-size:15px;outline:none;}'
   +'#lmb-snd{flex:0 0 auto;background:#f0c040;color:#0b0e14;border:none;border-radius:12px;padding:0 16px;font-weight:800;cursor:pointer;}';
  document.head.appendChild(css);

  var fab=document.createElement('button'); fab.id='lmb-fab'; fab.innerHTML='<span class="dot"></span>'+t('open')+'<span id="lmb-badge"></span>'; fab.onclick=toggle; document.body.appendChild(fab);
  var panel=document.createElement('div'); panel.id='lmb-panel';
  panel.innerHTML='<div id="lmb-hd"><div class="av"><img src="client-lmg-192.png" alt="Legacy" style="width:100%;height:100%;object-fit:cover;border-radius:50%;"></div><div class="ti">'+t('title')+'<div class="su">'+t('sub')+'</div></div><button id="lmb-x">✕</button></div>'
   +'<div id="lmb-msgs"></div>'
   +'<div id="lmb-bar"><input id="lmb-in" type="text" autocomplete="off" placeholder="'+t('ph')+'"><button id="lmb-snd">'+t('send')+'</button></div>';
  document.body.appendChild(panel);
  document.getElementById('lmb-x').onclick=toggle;
  document.getElementById('lmb-snd').onclick=send;
  document.getElementById('lmb-in').addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function render(){
    var box=document.getElementById('lmb-msgs');
    box.innerHTML=msgs.map(function(m){ return '<div class="lmb-b '+(m.role==='assistant'?'lmb-bot':'lmb-me')+'">'+esc(m.content).replace(/\n/g,'<br>')+'</div>'; }).join('')
      +(busy?'<div class="lmb-typing">Legacy está escribiendo…</div>':'');
    box.scrollTop=box.scrollHeight;
  }
  function updateFab(){
    var b=document.getElementById('lmb-badge'); if(b){ b.style.display=unread>0?'flex':'none'; b.textContent=unread; }
    fab.classList.toggle('pulse', unread>0 && !openState);
  }
  function toggle(){
    openState=!openState; panel.classList.toggle('on',openState); fab.style.display=openState?'none':'flex';
    if(openState){ unread=0; render(); setTimeout(function(){ var i=document.getElementById('lmb-in'); if(i && window.innerWidth>600) i.focus(); },120); }
    updateFab();
  }
  function send(){
    var i=document.getElementById('lmb-in'); var txt=(i.value||'').trim(); if(!txt||busy) return;
    i.value=''; msgs.push({role:'user',content:txt}); busy=true; render();
    fetch(ENDPOINT,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ lang:lang, messages:msgs.slice(-12) }) })
      .then(function(r){ return r.json(); })
      .then(function(d){ busy=false; msgs.push({role:'assistant',content:(d&&d.reply)||t('err')}); if(!openState){ unread++; updateFab(); } render(); })
      .catch(function(){ busy=false; msgs.push({role:'assistant',content:t('err')}); render(); });
  }
  // Clic FUERA del chat → se minimiza (queda la burbuja con el no-leído)
  document.addEventListener('click', function(e){ if(openState && !panel.contains(e.target) && !fab.contains(e.target)) toggle(); });
  // Al entrar por primera vez (por sesión), a los 2s se abre solo para que la gente lo note
  var autoOpen=function(){ if(!openState) toggle(); };
  try{ if(!sessionStorage.getItem('lmb_seen')){ sessionStorage.setItem('lmb_seen','1'); setTimeout(autoOpen,2000); } }catch(e){ setTimeout(autoOpen,2000); }
  updateFab();
})();
