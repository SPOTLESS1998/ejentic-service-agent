/**
 * Embeddable widget — the SIMPLEST client integration.
 *
 * A client drops ONE line on their site:
 *   <script src="https://YOUR-AGENT-HOST/widget.js"></script>
 * ...and a floating chat bubble appears, wired to this service's /chat and
 * /feedback endpoints (including the 👍/👎 buttons that drive learning).
 *
 * It's plain vanilla JS (no framework, no build step) generated as a string so
 * the single Node service can serve it directly. The demo page uses it too.
 */
import type { TenantConfig } from "./types.js";

/** The browser-side widget, returned from GET /widget.js */
export function widgetScript(tenant: TenantConfig): string {
  const cfg = {
    agentName: tenant.agentName,
    businessName: tenant.businessName,
    greeting: `Hi! I'm ${tenant.agentName}, the ${tenant.businessName} assistant. How can I help?`,
  };

  return `/* Ejentic Service Agent widget for ${tenant.businessName} */
(function () {
  var CFG = ${JSON.stringify(cfg)};
  var API = (document.currentScript && document.currentScript.src
      ? new URL('.', document.currentScript.src).origin
      : window.location.origin);
  var history = [];

  var css = ''
    + '.esa-btn{position:fixed;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;background:#0A0A0A;color:#00E5FF;border:2px solid #00E5FF;font-size:26px;cursor:pointer;z-index:99999}'
    + '.esa-panel{position:fixed;right:20px;bottom:90px;width:360px;max-width:92vw;height:520px;max-height:75vh;background:#0A0A0A;border:1px solid #00E5FF;border-radius:14px;display:none;flex-direction:column;overflow:hidden;z-index:99999;font-family:system-ui,Arial,sans-serif}'
    + '.esa-open .esa-panel{display:flex}'
    + '.esa-head{padding:14px 16px;background:#111;color:#fff;font-weight:700;border-bottom:1px solid #00E5FF33}'
    + '.esa-head span{color:#00E5FF}'
    + '.esa-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}'
    + '.esa-m{padding:10px 12px;border-radius:12px;max-width:85%;line-height:1.4;font-size:14px;white-space:pre-wrap}'
    + '.esa-user{align-self:flex-end;background:#00E5FF;color:#001014}'
    + '.esa-bot{align-self:flex-start;background:#1b1b1b;color:#eaeaea}'
    + '.esa-src{font-size:11px;color:#7fd7e6;margin-top:4px}'
    + '.esa-fb{margin-top:6px;display:flex;gap:8px}'
    + '.esa-fb button{background:transparent;border:1px solid #444;color:#aaa;border-radius:8px;cursor:pointer;padding:2px 8px;font-size:13px}'
    + '.esa-fb button:hover{border-color:#00E5FF;color:#00E5FF}'
    + '.esa-in{display:flex;border-top:1px solid #00E5FF33}'
    + '.esa-in input{flex:1;padding:12px;background:#0A0A0A;color:#fff;border:0;outline:none;font-size:14px}'
    + '.esa-in button{background:#00E5FF;color:#001014;border:0;padding:0 16px;font-weight:700;cursor:pointer}';

  var style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  var root = document.createElement('div'); root.className = 'esa-root';
  root.innerHTML = ''
    + '<button class="esa-btn" aria-label="Chat">💬</button>'
    + '<div class="esa-panel">'
    +   '<div class="esa-head">' + CFG.agentName + ' <span>• ' + CFG.businessName + '</span></div>'
    +   '<div class="esa-msgs"></div>'
    +   '<div class="esa-in"><input type="text" placeholder="Type a message..."/><button>Send</button></div>'
    + '</div>';
  document.body.appendChild(root);

  var msgs = root.querySelector('.esa-msgs');
  var input = root.querySelector('.esa-in input');
  var sendBtn = root.querySelector('.esa-in button');

  root.querySelector('.esa-btn').addEventListener('click', function(){
    root.classList.toggle('esa-open');
    if (root.classList.contains('esa-open') && !msgs.dataset.greeted){
      addBot(CFG.greeting); msgs.dataset.greeted = '1';
    }
  });

  function el(cls, text){ var d=document.createElement('div'); d.className=cls; if(text!=null)d.textContent=text; return d; }
  function scroll(){ msgs.scrollTop = msgs.scrollHeight; }
  function addUser(t){ msgs.appendChild(el('esa-m esa-user', t)); scroll(); }

  function addBot(t, sources, messageId){
    var wrap = el('esa-m esa-bot', t);
    if (sources && sources.length){
      var s = el('esa-src', 'Sources: ' + sources.join(', ')); wrap.appendChild(s);
    }
    if (messageId){
      var fb = el('esa-fb');
      var up = el('', '👍'); up.title='Helpful';
      var down = el('', '👎'); down.title='Not helpful';
      up.addEventListener('click', function(){ vote(messageId,'up',fb); });
      down.addEventListener('click', function(){ vote(messageId,'down',fb); });
      fb.appendChild(up); fb.appendChild(down);
      wrap.appendChild(fb);
    }
    msgs.appendChild(wrap); scroll();
  }

  function vote(id, v, fb){
    fb.innerHTML = '<span style="color:#7fd7e6;font-size:12px">Thanks for the feedback!</span>';
    fetch(API + '/feedback', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({messageId:id, vote:v})}).catch(function(){});
  }

  function send(){
    var text = (input.value||'').trim(); if(!text) return;
    addUser(text); input.value='';
    fetch(API + '/chat', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({message:text, history:history})})
      .then(function(r){return r.json();})
      .then(function(d){
        if(d && d.reply){
          addBot(d.reply, d.sources, d.messageId);
          history.push({role:'user',content:text});
          history.push({role:'assistant',content:d.reply});
          if (history.length > 12) history = history.slice(-12);
        } else { addBot('Sorry, something went wrong. Please try again.'); }
      })
      .catch(function(){ addBot('Network error. Please try again.'); });
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', function(e){ if(e.key==='Enter') send(); });
})();`;
}

/** A minimal HTML page that loads the widget — served at GET /demo */
export function demoPage(tenant: TenantConfig): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${tenant.businessName} — ${tenant.agentName} demo</title>
  <style>
    body{font-family:system-ui,Arial,sans-serif;background:#f6f7f9;color:#111;margin:0;padding:60px 20px;text-align:center}
    h1{font-size:28px} .pill{display:inline-block;background:#0A0A0A;color:#00E5FF;padding:6px 14px;border-radius:999px;font-weight:700;letter-spacing:1px}
    p{color:#555;max-width:560px;margin:16px auto}
    code{background:#eee;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="pill">${tenant.businessName.toUpperCase()}</div>
  <h1>Meet ${tenant.agentName} 🤖</h1>
  <p>This page loads the standalone customer-service agent widget from this same service.
     Click the 💬 bubble (bottom-right) to chat. Try English, Pidgin, Yoruba, Igbo or Hausa,
     and use 👍 / 👎 to teach it.</p>
  <p>Embed anywhere with:<br/><code id="esa-embed"></code></p>
  <script>
    // Build the snippet text without a literal closing tag (parser-safe).
    document.getElementById('esa-embed').textContent =
      '<' + 'script src="/widget.js">' + '<' + '/script>';
  </script>
  <script src="/widget.js"></script>

</body>
</html>`;
}
