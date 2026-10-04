const express = require('express');
const { chromium } = require('rebrowser-playwright');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = process.env.CAPTCHA_PORT || 6768;
const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);  // keep low; contexts are pooled after use
const TIMEOUT = parseInt(process.env.CAPTCHA_TIMEOUT || '10', 10);

// ─────────────────────────────────────────────
// Helper: is this a benign CDP/rebrowser frame-context error?
// reCAPTCHA iframes frequently reload and destroy their JS contexts;
// these errors are safe to swallow and retry.
// ─────────────────────────────────────────────
function isContextError(err) {
    const msg = (err?.message || '') + (err?.type || '');
    return (
        msg.includes('Cannot find context') ||
        msg.includes('context') ||
        msg.includes('world') ||
        msg.includes('Protocol error') ||
        msg.includes('ProtocolError') ||
        msg.includes('Target page') ||
        msg.includes('detached') ||
        msg.includes('Execution context was destroyed')
    );
}

const HTML_UI = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Captcha Solver</title>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
    <style>
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

        :root {
            --cyan:    #00f5ff;
            --purple:  #8b5cf6;
            --green:   #10b981;
            --red:     #ff6b6b;
            --bg:      #05050d;
        }

        html, body { width: 100%; height: 100%; background: var(--bg); font-family: 'Space Grotesk', sans-serif; overflow: hidden; }

        /* ── Background ── */
        #bgc { position: fixed; inset: 0; z-index: 0; }

        .grid {
            position: fixed; inset: 0; z-index: 1; pointer-events: none;
            background-image:
                linear-gradient(rgba(0,245,255,0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(0,245,255,0.04) 1px, transparent 1px);
            background-size: 55px 55px;
        }
        .grid::after {
            content: '';
            position: absolute; inset: 0;
            background: radial-gradient(ellipse 70% 60% at 50% 50%, transparent 40%, var(--bg) 100%);
        }

        .orb {
            position: fixed; border-radius: 50%;
            filter: blur(90px); z-index: 0; pointer-events: none;
            animation: orb-pulse 5s ease-in-out infinite;
        }
        .o1 { width: 500px; height: 500px; top: -180px; left: -140px;
              background: radial-gradient(circle, rgba(139,92,246,0.25), transparent 70%); }
        .o2 { width: 450px; height: 450px; bottom: -160px; right: -120px;
              background: radial-gradient(circle, rgba(0,245,255,0.18), transparent 70%);
              animation-delay: -2.5s; }
        .o3 { width: 280px; height: 280px; top: 45%; left: 50%; margin: -140px 0 0 -140px;
              background: radial-gradient(circle, rgba(16,185,129,0.12), transparent 70%);
              animation-delay: -1.2s; }

        @keyframes orb-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

        /* ── Scene ── */
        .scene {
            position: relative; z-index: 10;
            width: 100%; height: 100vh;
            display: flex; align-items: center; justify-content: center;
            padding: 24px;
            overflow-y: auto;
        }

        /* ── 3-D Card wrapper ── */
        .card-3d {
            width: 100%; max-width: 460px;
            will-change: transform;
            transition: transform .12s ease-out;
        }

        /* ── Glass card ── */
        .card {
            background: linear-gradient(145deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.01) 100%);
            border: 1px solid rgba(0,245,255,0.12);
            border-radius: 22px;
            padding: 34px 32px 28px;
            backdrop-filter: blur(24px);
            -webkit-backdrop-filter: blur(24px);
            box-shadow:
                0 0 0 1px rgba(0,245,255,0.04),
                0 25px 70px rgba(0,0,0,0.8),
                0 0 60px rgba(0,245,255,0.04),
                inset 0 1px 0 rgba(255,255,255,0.06);
            position: relative;
            overflow: hidden;
        }

        /* top edge glow */
        .card::before {
            content: '';
            position: absolute; top: 0; left: 15%; right: 15%; height: 1px;
            background: linear-gradient(90deg, transparent, var(--cyan), transparent);
            opacity: .5;
        }
        /* scanlines */
        .card::after {
            content: '';
            position: absolute; inset: 0; pointer-events: none; border-radius: 22px;
            background: repeating-linear-gradient(0deg, transparent, transparent 3px, rgba(0,0,0,0.04) 3px, rgba(0,0,0,0.04) 4px);
        }

        /* ── Header ── */
        .hdr { margin-bottom: 26px; }

        .badge-live {
            display: inline-flex; align-items: center; gap: 7px;
            background: rgba(0,245,255,0.07); border: 1px solid rgba(0,245,255,0.18);
            border-radius: 20px; padding: 4px 13px 4px 10px;
            margin-bottom: 14px;
        }
        .badge-live .pulse {
            width: 7px; height: 7px; border-radius: 50%; background: var(--cyan);
            box-shadow: 0 0 10px var(--cyan);
            animation: blink 1.6s ease-in-out infinite;
        }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }
        .badge-live span {
            color: var(--cyan); font-size: 10px; letter-spacing: 2.5px;
            text-transform: uppercase; font-family: 'JetBrains Mono', monospace;
        }

        .hdr h1 {
            font-size: 27px; font-weight: 700; letter-spacing: -.5px; line-height: 1.15;
            background: linear-gradient(130deg, #ffffff 0%, rgba(0,245,255,.75) 100%);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        .hdr p {
            margin-top: 7px; color: rgba(255,255,255,.22);
            font-size: 11.5px; font-family: 'JetBrains Mono', monospace;
        }

        /* ── Fields ── */
        .field { margin-bottom: 15px; }
        .field label {
            display: block; font-size: 9.5px; letter-spacing: 2px; text-transform: uppercase;
            color: rgba(255,255,255,.3); margin-bottom: 7px;
            font-family: 'JetBrains Mono', monospace;
        }
        .iw { position: relative; }
        .iw .ico { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); font-size: 13px; opacity: .3; pointer-events: none; }

        .field input, .field select {
            width: 100%; padding: 12px 14px 12px 38px;
            background: rgba(255,255,255,.03);
            border: 1px solid rgba(255,255,255,.08);
            border-radius: 11px; color: rgba(255,255,255,.85);
            font-size: 12.5px; font-family: 'JetBrains Mono', monospace;
            outline: none; transition: border-color .2s, box-shadow .2s, background .2s;
            appearance: none;
        }
        .field input:focus, .field select:focus {
            border-color: rgba(0,245,255,.45);
            background: rgba(0,245,255,.04);
            box-shadow: 0 0 0 3px rgba(0,245,255,.09), 0 0 24px rgba(0,245,255,.06);
        }
        .field input::placeholder { color: rgba(255,255,255,.14); }
        .field select option { background: #0d0d1e; color: #fff; }

        /* ── Button ── */
        .btn-row { margin-top: 20px; }
        .go-btn {
            width: 100%; padding: 14px;
            background: linear-gradient(135deg, #00c8ff 0%, #00f5ff 55%, #00e0cc 100%);
            border: none; border-radius: 12px;
            color: #03030a; font-size: 12.5px; font-weight: 700;
            font-family: 'Space Grotesk', sans-serif; letter-spacing: 2px; text-transform: uppercase;
            cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 10px;
            box-shadow: 0 6px 24px rgba(0,245,255,.3), 0 2px 6px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.35);
            transition: transform .15s, box-shadow .15s;
            position: relative;
        }
        .go-btn:hover:not(:disabled) {
            transform: translateY(-2px);
            box-shadow: 0 12px 36px rgba(0,245,255,.4), 0 4px 10px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.35);
        }
        .go-btn:active:not(:disabled) {
            transform: translateY(1px);
            box-shadow: 0 3px 12px rgba(0,245,255,.2), 0 1px 3px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.2);
        }
        .go-btn:disabled { opacity: .45; cursor: not-allowed; }
        .go-btn .sp {
            width: 15px; height: 15px;
            border: 2.5px solid rgba(3,3,10,.25); border-top-color: #03030a;
            border-radius: 50%; animation: spin .7s linear infinite; display: none;
        }
        .go-btn.busy .sp { display: block; }
        .go-btn.busy .lbl { display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* ── Result panel ── */
        .result { display: none; margin-top: 20px; animation: pop-in .35s cubic-bezier(.34,1.56,.64,1); }
        .result.show { display: block; }
        @keyframes pop-in { from{opacity:0;transform:translateY(10px) scale(.96)} to{opacity:1;transform:none} }

        .rh {
            display: flex; align-items: center; justify-content: space-between;
            padding: 11px 15px; border-radius: 12px 12px 0 0;
        }
        .rh.ok  { background: rgba(16,185,129,.09); border: 1px solid rgba(16,185,129,.2); }
        .rh.err { background: rgba(255,107,107,.09); border: 1px solid rgba(255,107,107,.2); border-radius: 12px; }

        .status { display: flex; align-items: center; gap: 9px; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; }
        .status-dot.ok  { background: var(--green); box-shadow: 0 0 10px var(--green); }
        .status-dot.err { background: var(--red);   box-shadow: 0 0 10px var(--red); }
        .status-txt { font-size: 12px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; }
        .status-txt.ok  { color: var(--green); }
        .status-txt.err { color: var(--red); }
        .elapsed { color: rgba(255,255,255,.3); font-size: 11px; font-family: 'JetBrains Mono', monospace; }

        .tok-box {
            background: rgba(0,0,0,.45); border: 1px solid rgba(16,185,129,.13);
            border-top: none; border-radius: 0 0 12px 12px; padding: 14px; position: relative;
        }
        .tok-scroll {
            color: rgba(0,230,180,.65); font-size: 10px; font-family: 'JetBrains Mono', monospace;
            word-break: break-all; max-height: 60px; overflow-y: auto; line-height: 1.55;
        }
        .cp-btn {
            position: absolute; top: 8px; right: 8px; padding: 4px 11px;
            background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09);
            border-radius: 6px; color: rgba(255,255,255,.35);
            font-size: 10px; font-family: 'JetBrains Mono', monospace;
            cursor: pointer; transition: all .2s;
        }
        .cp-btn:hover { color: #fff; background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.2); }
        .cp-btn.done  { color: var(--green); border-color: rgba(16,185,129,.3); }
        .err-msg { color: var(--red); font-size: 12px; font-family: 'JetBrains Mono', monospace; }

        /* ── Stats ── */
        .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 16px; }
        .stat {
            background: rgba(255,255,255,.02); border: 1px solid rgba(255,255,255,.06);
            border-radius: 11px; padding: 13px 8px; text-align: center;
            transition: border-color .25s, box-shadow .25s;
        }
        .stat:hover { border-color: rgba(0,245,255,.14); box-shadow: 0 0 20px rgba(0,245,255,.05); }
        .sv {
            display: block; font-size: 21px; font-weight: 700;
            background: linear-gradient(130deg, #fff, rgba(0,245,255,.7));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .sl { color: rgba(255,255,255,.2); font-size: 8.5px; text-transform: uppercase; letter-spacing: 1.5px; margin-top: 3px; font-family: 'JetBrains Mono', monospace; }

        /* ── API hint ── */
        .api {
            margin-top: 14px; padding: 12px 14px;
            background: rgba(255,255,255,.018); border: 1px solid rgba(255,255,255,.05); border-radius: 11px;
        }
        .api span { display: block; color: rgba(255,255,255,.17); font-size: 9.5px; font-family: 'JetBrains Mono', monospace; line-height: 1.9; }
        .api span.head { color: rgba(0,245,255,.28); margin-bottom: 1px; }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(0,245,255,.2); border-radius: 2px; }
    </style>
</head>
<body>

<canvas id="bgc"></canvas>
<div class="grid"></div>
<div class="orb o1"></div>
<div class="orb o2"></div>
<div class="orb o3"></div>

<div class="scene" id="scene">
    <div class="card-3d" id="c3d">
        <div class="card">

            <div class="hdr">
                <div class="badge-live"><div class="pulse"></div><span>Neural Engine</span></div>
                <h1>Captcha Solver</h1>
                <p>reCAPTCHA v2 / invisible / v3 bypass</p>
            </div>

            <form id="f">
                <div class="field">
                    <label>Captcha Type</label>
                    <div class="iw">
                        <span class="ico">&#9889;</span>
                        <select id="type" onchange="onTypeChange()">
                            <option value="recaptcha">reCAPTCHA v2 (checkbox)</option>
                            <option value="recaptcha-invisible">reCAPTCHA v2 Invisible</option>
                            <option value="recaptcha-v3">reCAPTCHA v3 (score)</option>
                        </select>
                    </div>
                </div>

                <div class="field" id="actionField" style="display:none;">
                    <label>Action (v3 only)</label>
                    <div class="iw">
                        <span class="ico">&#9654;</span>
                        <input type="text" id="action" placeholder="submit" value="submit">
                    </div>
                </div>

                <div class="field">
                    <label>Target URL</label>
                    <div class="iw">
                        <span class="ico">&#128279;</span>
                        <input type="url" id="url" placeholder="https://target.com" required>
                    </div>
                </div>

                <div class="field">
                    <label>Site Key</label>
                    <div class="iw">
                        <span class="ico">&#128273;</span>
                        <input type="text" id="sk" placeholder="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI" required>
                    </div>
                </div>

                <div class="btn-row">
                    <button type="submit" class="go-btn" id="btn">
                        <span class="sp"></span>
                        <span class="lbl">&#9889;&nbsp; Solve Captcha</span>
                    </button>
                </div>
            </form>

            <div class="result" id="out">
                <div class="rh" id="rh">
                    <div class="status">
                        <div class="status-dot" id="sdot"></div>
                        <span class="status-txt" id="stxt"></span>
                    </div>
                    <span class="elapsed" id="el"></span>
                </div>
                <div class="tok-box" id="tokBox" style="display:none;">
                    <div class="tok-scroll" id="tok"></div>
                    <button class="cp-btn" id="cpb" onclick="doCopy()">copy</button>
                </div>
                <p class="err-msg" id="errTxt" style="display:none;"></p>
            </div>

            <div class="stats">
                <div class="stat"><span class="sv" id="cnt">0</span><div class="sl">Solved</div></div>
                <div class="stat"><span class="sv" id="avg">&#8212;</span><div class="sl">Avg</div></div>
                <div class="stat"><span class="sv" id="rate">&#8212;</span><div class="sl">Rate</div></div>
            </div>

            <div class="api">
                <span class="head">// REST API</span>
                <span>GET /solve?type=recaptcha&amp;url=&lt;url&gt;&amp;sitekey=&lt;key&gt;</span>
                <span>GET /solve?type=recaptcha-invisible&amp;url=&lt;url&gt;&amp;sitekey=&lt;key&gt;</span>
                <span>GET /solve?type=recaptcha-v3&amp;url=&lt;url&gt;&amp;sitekey=&lt;key&gt;&amp;action=submit</span>
            </div>

        </div>
    </div>
</div>

<script>
// ── Particle canvas ──────────────────────────────────────────────────────────
(function(){
    var cv = document.getElementById('bgc');
    var ct = cv.getContext('2d');
    var W, H, pts = [];

    function sz(){ W = cv.width = window.innerWidth; H = cv.height = window.innerHeight; }
    sz(); window.addEventListener('resize', sz);

    function mkPt(){
        return {
            x: Math.random()*W, y: Math.random()*H,
            r: Math.random()*1.4+0.3,
            dx:(Math.random()-.5)*.25, dy:-Math.random()*.45-.08,
            a: Math.random()*.5+.1,
            c: Math.random()>.5?'0,245,255':'139,92,246'
        };
    }
    for(var i=0;i<130;i++) pts.push(mkPt());

    function draw(){
        ct.clearRect(0,0,W,H);
        pts.forEach(function(p){
            ct.beginPath(); ct.arc(p.x,p.y,p.r,0,Math.PI*2);
            ct.fillStyle='rgba('+p.c+','+p.a+')'; ct.fill();
            p.x+=p.dx; p.y+=p.dy;
            if(p.y<-5||p.x<-5||p.x>W+5){
                var n=mkPt(); n.y=H+5; n.x=Math.random()*W;
                Object.assign(p,n);
            }
        });
        requestAnimationFrame(draw);
    }
    draw();
})();

// ── 3-D card tilt ────────────────────────────────────────────────────────────
(function(){
    var sc = document.getElementById('scene');
    var cd = document.getElementById('c3d');
    var mx = window.innerWidth/2, my = window.innerHeight/2;
    window.addEventListener('resize',function(){ mx=window.innerWidth/2; my=window.innerHeight/2; });
    sc.addEventListener('mousemove',function(e){
        var dx=(e.clientX-mx)/mx, dy=(e.clientY-my)/my;
        cd.style.transform='perspective(1100px) rotateY('+(dx*9)+'deg) rotateX('+(-dy*7)+'deg)';
    });
    sc.addEventListener('mouseleave',function(){
        cd.style.transition='transform .65s ease';
        cd.style.transform='perspective(1100px) rotateY(0deg) rotateX(0deg)';
        setTimeout(function(){ cd.style.transition='transform .12s ease-out'; },650);
    });
})();

// ── App logic ────────────────────────────────────────────────────────────────
var S = {ok:0,fail:0,t:0};

document.getElementById('f').addEventListener('submit', async function(e){
    e.preventDefault();
    var btn=document.getElementById('btn'), out=document.getElementById('out');
    btn.classList.add('busy'); btn.disabled=true;
    out.classList.remove('show');
    try {
        var type    = document.getElementById('type').value;
        var url     = encodeURIComponent(document.getElementById('url').value);
        var sitekey = encodeURIComponent(document.getElementById('sk').value);
        var action  = encodeURIComponent(document.getElementById('action').value||'submit');
        var ep = '/solve?type='+type+'&url='+url+'&sitekey='+sitekey;
        if(type==='recaptcha-v3') ep+='&action='+action;
        var r=await fetch(ep), d=await r.json();
        out.classList.add('show');
        var rh=document.getElementById('rh');
        if(d.success){
            rh.className='rh ok';
            document.getElementById('sdot').className='status-dot ok';
            document.getElementById('stxt').textContent='Solved';
            document.getElementById('stxt').className='status-txt ok';
            document.getElementById('el').textContent=d.time+'s';
            document.getElementById('tok').textContent=d.token;
            document.getElementById('tokBox').style.display='block';
            document.getElementById('errTxt').style.display='none';
            S.ok++; S.t+=d.time;
        } else {
            rh.className='rh err';
            document.getElementById('sdot').className='status-dot err';
            document.getElementById('stxt').textContent='Failed';
            document.getElementById('stxt').className='status-txt err';
            document.getElementById('el').textContent='';
            document.getElementById('tokBox').style.display='none';
            document.getElementById('errTxt').textContent=d.err;
            document.getElementById('errTxt').style.display='block';
            S.fail++;
        }
        upd();
    } catch(ex){
        out.classList.add('show');
        document.getElementById('rh').className='rh err';
        document.getElementById('sdot').className='status-dot err';
        document.getElementById('stxt').textContent='Error';
        document.getElementById('stxt').className='status-txt err';
        document.getElementById('tokBox').style.display='none';
        document.getElementById('errTxt').textContent=ex.message;
        document.getElementById('errTxt').style.display='block';
        S.fail++; upd();
    }
    btn.classList.remove('busy'); btn.disabled=false;
});

function upd(){
    var total=S.ok+S.fail;
    document.getElementById('cnt').textContent=S.ok;
    document.getElementById('avg').textContent=S.ok>0?(S.t/S.ok).toFixed(1)+'s':'—';
    document.getElementById('rate').textContent=total>0?Math.round(S.ok/total*100)+'%':'—';
}

function onTypeChange(){
    var t=document.getElementById('type').value;
    document.getElementById('actionField').style.display=t==='recaptcha-v3'?'block':'none';
}

function doCopy(){
    navigator.clipboard.writeText(document.getElementById('tok').textContent);
    var b=document.getElementById('cpb');
    b.textContent='done'; b.classList.add('done');
    setTimeout(function(){ b.textContent='copy'; b.classList.remove('done'); },1400);
}
</script>
</body>
</html>`;

// ─────────────────────────────────────────────
// Page builders
// ─────────────────────────────────────────────

function buildRecaptchaPage(siteKey) {
    return `<!DOCTYPE html>
<html><head>
<script>
  window.__token = null;
  window.__ready = false;
  function __onload() { window.__ready = true; }
  function __cb(token) { window.__token = token; }
<\/script>
<script src="https://www.google.com/recaptcha/api.js?onload=__onload&render=explicit" async defer><\/script>
</head>
<body>
<div id="rc"></div>
<script>
  (function wait() {
    if (typeof grecaptcha === 'undefined' || !window.__ready) return setTimeout(wait, 100);
    grecaptcha.render('rc', {
      sitekey: '${siteKey}',
      callback: __cb,
      'expired-callback': function() { window.__token = null; }
    });
  })();
<\/script>
</body></html>`;
}



// reCAPTCHA v2 Invisible — no visible widget, execute() triggers it
function buildRecaptchaInvisiblePage(siteKey) {
    return `<!DOCTYPE html>
<html><head>
<script>
  window.__token = null;
  window.__wid   = null;
  function __cb(token) { window.__token = token; }
<\/script>
<script src="https://www.google.com/recaptcha/api.js?render=explicit" async defer><\/script>
</head>
<body>
<div id="rc"></div>
<script>
(function wait(){
  if(typeof grecaptcha==='undefined' || typeof grecaptcha.render!=='function')
    return setTimeout(wait, 100);
  window.__wid = grecaptcha.render('rc', {
    sitekey:  '${siteKey}',
    size:     'invisible',
    callback: __cb,
    'expired-callback': function(){ window.__token = null; }
  });
  // execute immediately after render
  setTimeout(function(){ grecaptcha.execute(window.__wid); }, 600);
})();
<\/script>
</body></html>`;
}

// reCAPTCHA v3 — fully hidden, score-based, token via execute()
function buildRecaptchaV3Page(siteKey, action) {
    return `<!DOCTYPE html>
<html><head>
<script src="https://www.google.com/recaptcha/api.js?render=${siteKey}"><\/script>
</head>
<body>
<script>
  window.__token = null;
  grecaptcha.ready(function(){
    grecaptcha.execute('${siteKey}', {action:'${action}'}).then(function(token){
      window.__token = token;
    });
  });
<\/script>
</body></html>`;
}


// ─────────────────────────────────────────────
// Browser / pool management
// ─────────────────────────────────────────────

let browser;
const ctxPool = [];

async function initBrowserIfNeeded() {
    if (!browser || !browser.isConnected()) {
        const exePath = findPatchrightExe();
        const isHeadless = process.env.HEADLESS === 'true';
        browser = await chromium.launch({
            executablePath: exePath || undefined,
            headless: isHeadless,
            args: [
                '--no-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--no-first-run',
                '--disable-blink-features=AutomationControlled',
            ],
        });
    }
}

async function grabCtx() {
    await initBrowserIfNeeded();
    while (ctxPool.length > 0) {
        const ctx = ctxPool.shift();
        // Health-check: verify context is still alive
        try {
            await ctx.pages(); // throws if context is closed
            return ctx;
        } catch {
            // stale context — discard and try next
        }
    }
    return await browser.newContext({ viewport: { width: 1280, height: 800 } });
}

async function dropCtx(ctx, hasError = false) {
    if (hasError) {
        try { await ctx.close(); } catch {}
        return;
    }
    try {
        await ctx.pages(); // verify context is still healthy
        await ctx.unrouteAll({ behavior: 'ignoreErrors' });
        if (ctxPool.length < POOL_SIZE) {
            ctxPool.push(ctx);
            return;
        }
    } catch {}
    try { await ctx.close(); } catch {}
}

function findPatchrightExe() {
    for (const py of ['python3', 'python']) {
        try {
            const out = execSync(
                `${py} -c "from patchright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()"`,
                { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
            ).trim();
            if (out && fs.existsSync(out)) return out;
        } catch {}
    }
    const searchDirs = [
        path.join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
        path.join(process.env.HOME || '/root', '.cache', 'ms-playwright'),
    ];
    for (const base of searchDirs) {
        try {
            if (!fs.existsSync(base)) continue;
            for (const d of fs.readdirSync(base)) {
                if (d.toLowerCase().includes('patchright') || d.toLowerCase().includes('chromium')) {
                    const winExe   = path.join(base, d, 'chrome-win', 'chrome.exe');
                    const linuxExe = path.join(base, d, 'chrome-linux', 'chrome');
                    if (fs.existsSync(winExe))   return winExe;
                    if (fs.existsSync(linuxExe)) return linuxExe;
                }
            }
        } catch {}
    }
    return null;
}

// ─────────────────────────────────────────────
// Audio transcription (Google Speech API — no key needed)
// ─────────────────────────────────────────────

async function transcribeAudio(mp3Url) {
    const resp = await fetch(mp3Url);
    if (!resp.ok) throw new Error('audio download failed: ' + resp.status);
    const buf = await resp.arrayBuffer();
    const r2 = await fetch(
        'https://www.google.com/speech-api/v2/recognize?output=json&lang=en-US&key=AIzaSyBOti4mM-6x9WDnZIjIeyEU21OpBXqWBgw',
        { method: 'POST', headers: { 'Content-Type': 'audio/mpeg' }, body: buf }
    );
    const text = await r2.text();
    for (const line of text.trim().split('\n')) {
        try {
            const j = JSON.parse(line);
            const t = j?.result?.[0]?.alternative?.[0]?.transcript;
            if (t) return t.trim().toLowerCase();
        } catch {}
    }
    throw new Error('no transcript');
}

// ─────────────────────────────────────────────
// Solver: reCAPTCHA v2 (checkbox + audio challenge fallback)
// ─────────────────────────────────────────────

async function solveRecaptcha(siteUrl, siteKey, timeout = TIMEOUT) {
    if (!siteUrl.endsWith('/')) siteUrl += '/';
    const t0 = Date.now();
    const ctx = await grabCtx();
    const pg  = await ctx.newPage();
    let checkboxClicked = false;
    let lastAudioAt     = 0;
    let hasError        = false;

    const getBframe    = () => pg.frames().find(f => f.url().includes('google.com/recaptcha') && f.url().includes('bframe'));
    const getAnchorFr  = () => pg.frames().find(f => f.url().includes('google.com/recaptcha') && f.url().includes('anchor'));

    try {
        const html = buildRecaptchaPage(siteKey);
        await pg.route(siteUrl, r => r.fulfill({ body: html, status: 200, contentType: 'text/html' }));
        await pg.goto(siteUrl, { timeout: 15000, waitUntil: 'commit' });
        await new Promise(r => setTimeout(r, 2000));

        while (Date.now() - t0 < timeout * 1000) {
          try {

            // 1. Token check — check main page AND bframe hidden input
            let token = null;
            try {
                token = await pg.evaluate(`
                    window.__token ||
                    document.querySelector('[name="g-recaptcha-response"]')?.value ||
                    null
                `);
            } catch {}

            // The real token lives in bframe #recaptcha-token after checkbox solve
            if (!token || token.length < 20) {
                const bf = getBframe();
                if (bf) {
                    try {
                        const bft = await bf.evaluate(
                            `document.getElementById('recaptcha-token')?.value || null`
                        );
                        if (bft && bft.length > 20) token = bft;
                    } catch {}
                }
            }

            if (token && token.length > 20) {
                const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                return { success: true, token, time: elapsed, type: 'recaptcha' };
            }

            // 2. Click checkbox once
            if (!checkboxClicked) {
                const af = getAnchorFr();
                if (af) {
                    try {
                        await af.waitForSelector('#recaptcha-anchor', { timeout: 2000 });
                        await af.click('#recaptcha-anchor');
                        checkboxClicked = true;
                        await new Promise(r => setTimeout(r, 2500));
                    } catch {}
                }
            }

            // 3. Audio challenge fallback — retry every 15s
            const now = Date.now();
            if (checkboxClicked && now - lastAudioAt > 15000) {
                const bf = getBframe();
                if (bf) {
                    try {
                        const hasChallenge = await bf.evaluate(
                            `!!document.querySelector('.rc-imageselect, .rc-audiochallenge')`
                        ).catch(() => false);
                        if (hasChallenge) {
                            lastAudioAt = now;

                            // Switch from image to audio if needed
                            const isImage = await bf.evaluate(`!!document.querySelector('.rc-imageselect')`).catch(() => false);
                            if (isImage) {
                                try {
                                    await bf.click('#recaptcha-audio-button');
                                    await new Promise(r => setTimeout(r, 1500));
                                } catch {}
                            }

                            // Handle audio challenge
                            const isAudio = await bf.evaluate(`!!document.querySelector('.rc-audiochallenge')`).catch(() => false);
                            if (isAudio) {
                                const audioSrc = await bf.evaluate(
                                    `document.querySelector('.rc-audiochallenge-tdownload-link')?.href || null`
                                ).catch(() => null);
                                if (audioSrc) {
                                    try {
                                        const answer = await transcribeAudio(audioSrc);
                                        console.log('[recaptcha] transcribed:', answer);
                                        const inp = await bf.$('#audio-response');
                                        if (inp) {
                                            await inp.fill('');
                                            await inp.type(answer, { delay: 60 });
                                            await new Promise(r => setTimeout(r, 400));
                                            await bf.click('#recaptcha-verify-button');
                                            await new Promise(r => setTimeout(r, 2000));
                                        }
                                    } catch (e) {
                                        console.log('[recaptcha] audio error:', e.message);
                                        try { await bf.click('#recaptcha-reload-button'); } catch {}
                                    }
                                }
                            }
                        }
                    } catch {}
                }
            }

            await new Promise(r => setTimeout(r, 400));
          } catch (loopErr) {
              // Swallow CDP frame detached / execution context destroyed errors from reCAPTCHA iframe reloads
              if (isContextError(loopErr)) {
                  await new Promise(r => setTimeout(r, 500));
                  continue;
              }
              throw loopErr;
          }
        }

        return { success: false, err: 'timeout', type: 'recaptcha' };
    } catch (e) {
        hasError = true;
        return { success: false, err: e.message, type: 'recaptcha' };
    } finally {
        try { await pg.close(); } catch {}
        await dropCtx(ctx, hasError);
    }
}

// ─────────────────────────────────────────────
// Solver: reCAPTCHA v2 Invisible
// ─────────────────────────────────────────────

async function solveRecaptchaInvisible(siteUrl, siteKey, timeout = TIMEOUT) {
    if (!siteUrl.endsWith('/')) siteUrl += '/';
    const t0 = Date.now();
    const ctx = await grabCtx();
    const pg  = await ctx.newPage();
    let hasError = false;

    const getBframe   = () => pg.frames().find(f => f.url().includes('google.com/recaptcha') && f.url().includes('bframe'));

    try {
        const html = buildRecaptchaInvisiblePage(siteKey);
        await pg.route(siteUrl, r => r.fulfill({ body: html, status: 200, contentType: 'text/html' }));
        await pg.goto(siteUrl, { timeout: 15000, waitUntil: 'commit' });
        await new Promise(r => setTimeout(r, 2000));

        while (Date.now() - t0 < timeout * 1000) {
            try {
                // Check window.__token (v2-invisible callback) and bframe token
                let token = null;
                try {
                    token = await pg.evaluate(`window.__token || document.querySelector('[name="g-recaptcha-response"]')?.value || null`);
                } catch {}

                if (!token || token.length < 20) {
                    const bf = getBframe();
                    if (bf) {
                        try {
                            const bft = await bf.evaluate(`document.getElementById('recaptcha-token')?.value || null`).catch(() => null);
                            if (bft && bft.length > 20) token = bft;
                        } catch {}
                    }
                }

                if (token && token.length > 20) {
                    const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                    return { success: true, token, time: elapsed, type: 'recaptcha-invisible' };
                }

                // If a challenge popup appeared (rare for invisible), handle audio
                const bf = getBframe();
                if (bf) {
                    try {
                        const hasChallenge = await bf.evaluate(`!!document.querySelector('.rc-imageselect, .rc-audiochallenge')`).catch(() => false);
                        if (hasChallenge) {
                            const isImage = await bf.evaluate(`!!document.querySelector('.rc-imageselect')`).catch(() => false);
                            if (isImage) { try { await bf.click('#recaptcha-audio-button'); await new Promise(r => setTimeout(r, 1500)); } catch {} }
                            const isAudio = await bf.evaluate(`!!document.querySelector('.rc-audiochallenge')`).catch(() => false);
                            if (isAudio) {
                                const audioSrc = await bf.evaluate(`document.querySelector('.rc-audiochallenge-tdownload-link')?.href || null`).catch(() => null);
                                if (audioSrc) {
                                    try {
                                        const answer = await transcribeAudio(audioSrc);
                                        const inp = await bf.$('#audio-response');
                                        if (inp) {
                                            await inp.fill('');
                                            await inp.type(answer, { delay: 60 });
                                            await new Promise(r => setTimeout(r, 400));
                                            await bf.click('#recaptcha-verify-button');
                                            await new Promise(r => setTimeout(r, 2000));
                                        }
                                    } catch (e) { try { await bf.click('#recaptcha-reload-button'); } catch {} }
                                }
                            }
                        }
                    } catch {}
                }
            } catch (loopErr) {
                // Swallow CDP frame detached / execution context destroyed errors from reCAPTCHA iframe reloads
                if (isContextError(loopErr)) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                throw loopErr;
            }
            await new Promise(r => setTimeout(r, 400));
        }

        return { success: false, err: 'timeout', type: 'recaptcha-invisible' };
    } catch (e) {
        hasError = true;
        return { success: false, err: e.message, type: 'recaptcha-invisible' };
    } finally {
        try { await pg.close(); } catch {}
        await dropCtx(ctx, hasError);
    }
}

// ─────────────────────────────────────────────
// Solver: reCAPTCHA v3 (fully invisible, score-based)
// ─────────────────────────────────────────────

async function solveRecaptchaV3(siteUrl, siteKey, action = 'submit', timeout = TIMEOUT) {
    if (!siteUrl.endsWith('/')) siteUrl += '/';
    const t0 = Date.now();
    const ctx = await grabCtx();
    const pg  = await ctx.newPage();
    let hasError = false;

    try {
        const html = buildRecaptchaV3Page(siteKey, action);
        await pg.route(siteUrl, r => r.fulfill({ body: html, status: 200, contentType: 'text/html' }));
        await pg.goto(siteUrl, { timeout: 15000, waitUntil: 'commit' });
        // v3 just needs the script to load and execute() to resolve
        await new Promise(r => setTimeout(r, 1500));

        while (Date.now() - t0 < timeout * 1000) {
            try {
                const token = await pg.evaluate(`window.__token || null`).catch(() => null);
                if (token && token.length > 20) {
                    const elapsed = Math.round((Date.now() - t0) / 10) / 100;
                    return { success: true, token, time: elapsed, type: 'recaptcha-v3', action };
                }
            } catch {}
            await new Promise(r => setTimeout(r, 300));
        }

        return { success: false, err: 'timeout', type: 'recaptcha-v3' };
    } catch (e) {
        hasError = true;
        return { success: false, err: e.message, type: 'recaptcha-v3' };
    } finally {
        try { await pg.close(); } catch {}
        await dropCtx(ctx, hasError);
    }
}

// ─────────────────────────────────────────────
// Express routes
// ─────────────────────────────────────────────

const app = express();

app.get('/', (req, res) => res.send(HTML_UI));

app.get('/solve', async (req, res) => {
    const { url, sitekey, type = 'recaptcha', timeout, action = 'submit' } = req.query;
    if (!url)     return res.status(400).json({ success: false, err: 'missing url' });
    if (!sitekey) return res.status(400).json({ success: false, err: 'missing sitekey' });

    const validTypes = ['recaptcha', 'recaptcha-invisible', 'recaptcha-v3'];
    if (!validTypes.includes(type)) {
        return res.status(400).json({ success: false, err: `type must be one of: ${validTypes.join(', ')}` });
    }

    const t = timeout ? parseFloat(timeout) : TIMEOUT;
    try {
        let result;
        if (type === 'recaptcha-invisible') result = await solveRecaptchaInvisible(url, sitekey, t);
        else if (type === 'recaptcha-v3')   result = await solveRecaptchaV3(url, sitekey, action, t);
        else                                result = await solveRecaptcha(url, sitekey, t);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, err: e.message });
    }
});

app.get('/health', (req, res) => res.json({ ok: true, pool: ctxPool.length }));

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

async function main() {
    const exePath = findPatchrightExe();

    const isHeadless = process.env.HEADLESS === 'true';

    browser = await chromium.launch({
        executablePath: exePath || undefined,
        headless: isHeadless,
        args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run',
            '--disable-blink-features=AutomationControlled',
        ],
    });

    // Pre-warm a smaller set; grabCtx() creates new ones on demand up to POOL_SIZE
    const prewarm = Math.min(POOL_SIZE, 3);
    for (let i = 0; i < prewarm; i++) {
        ctxPool.push(await browser.newContext({ viewport: { width: 1280, height: 800 } }));
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`captcha solver running on http://localhost:${PORT}`);
        console.log(`  GET http://localhost:${PORT}/solve?type=recaptcha&url=<site>&sitekey=<key>`);
        console.log(`  GET http://localhost:${PORT}/solve?type=recaptcha-invisible&url=<site>&sitekey=<key>`);
        console.log(`  GET http://localhost:${PORT}/solve?type=recaptcha-v3&url=<site>&sitekey=<key>&action=submit`);

    });
}

main().catch(() => process.exit(1));
