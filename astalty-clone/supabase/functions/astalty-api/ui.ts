// Astalty clone · tiny browser console served at the function root. Sign in with an API token.
export function consolePage(base: string) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astalty clone · NDIS Wizard test replica</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f4f6fb;--card:#fff;--ink:#14213d;--mute:#5b6478;--line:#e2e6ef;--accent:#1f3b73;--ok:#0f7b4f;--warn:#b7791f;--bad:#b91c1c;color-scheme:light}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{background:var(--accent);color:#fff;padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header h1{font-size:17px;margin:0;font-weight:600}header small{opacity:.8}
nav{display:flex;gap:4px;flex-wrap:wrap;padding:10px 20px;background:var(--card);border-bottom:1px solid var(--line)}
nav button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;color:var(--ink)}
nav button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
main{padding:20px;max-width:1200px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
.sub{color:var(--mute);font-size:13px}.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:var(--accent)}
.pill.ok{background:#e6f6ee;color:var(--ok)}.pill.warn{background:#fff4df;color:var(--warn)}.pill.bad{background:#fde8e8;color:var(--bad)}
input[type=password],input[type=text]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;min-width:280px}
button.primary{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 14px;font:inherit;cursor:pointer}
pre{white-space:pre-wrap;font-size:12px;background:#f7f8fb;padding:10px;border-radius:8px;max-height:260px;overflow:auto}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.right{margin-left:auto}
details summary{cursor:pointer;color:var(--accent)}
@media (max-width:640px){main{padding:12px}input[type=password],input[type=text]{min-width:0;width:100%}}
</style></head><body>
<header><h1>Astalty clone</h1><small>NDIS Wizard test replica · synthetic data only · base <code>${base}</code></small><span class="right" id="who"></span></header>
<nav id="nav"></nav>
<main>
 <div class="card" id="login">
  <div class="row"><strong>Sign in with an API token</strong><span class="sub">Bearer tokens are created in the database with <code>ast_mint_api_key(label, permission)</code>.</span></div>
  <div class="row" style="margin-top:10px"><input type="password" id="tok" placeholder="ast_…"><button class="primary" id="go">Sign in</button><span class="sub"><a href="${base}/docs">API reference</a> · <a href="${base}/docs.json">OpenAPI JSON</a></span></div>
  <div class="sub" id="err" style="color:var(--bad);margin-top:8px"></div>
 </div>
 <div id="view"></div>
</main>
<script>
const BASE=${JSON.stringify(base)};
const $=s=>document.querySelector(s);
let tok=localStorage.getItem('ast_tok')||'';
const tabs=[['participants','Participants'],['shifts','Shifts this week'],['supports','Supports'],['invoices','Invoices'],['services','Agreements'],['incidents','Incidents'],['compliance','Worker records'],['changes','Recent changes'],['planted','Planted errors']];
let cur='participants';
const money=c=>'$'+(Number(c||0)/100).toLocaleString('en-AU',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
const when=s=>s?new Date(s).toLocaleString('en-AU',{timeZone:'Australia/Adelaide',dateStyle:'medium',timeStyle:'short'}):'—';
const day=s=>s?new Date(s+'T00:00:00').toLocaleDateString('en-AU',{dateStyle:'medium'}):'—';
async function api(path){const r=await fetch(BASE+path,{headers:{Authorization:'Bearer '+tok,Accept:'application/json'}});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.message||('HTTP '+r.status));return j;}
function nav(){$('#nav').innerHTML=tabs.map(([k,l])=>'<button data-k="'+k+'" class="'+(k===cur?'on':'')+'">'+l+'</button>').join('')+'<button data-k="out" class="right">Sign out</button>';
 $('#nav').querySelectorAll('button').forEach(b=>b.onclick=()=>{if(b.dataset.k==='out'){tok='';localStorage.removeItem('ast_tok');boot();return;}cur=b.dataset.k;nav();show();});}
function table(cols,rows){return '<table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.map(r=>'<tr>'+r.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+cols.length+'" class="sub">Nothing to show.</td></tr>')+'</tbody></table>';}
function pill(t,k){return '<span class="pill '+(k||'')+'">'+esc(t)+'</span>';}
async function show(){const v=$('#view');v.innerHTML='<div class="card sub">Loading…</div>';try{
 if(cur==='participants'){const j=await api('/public/v1/participants?page[size]=100&filter[status]=active,archived');v.innerHTML='<div class="card"><div class="row"><strong>'+j.meta.total+' participants</strong><span class="sub">GET /public/v1/participants</span></div>'+table(['Name','NDIS number','Status','Tags','Last check-in','Mobile'],j.data.map(p=>[esc(p.full_name)+(p.preferred_name&&p.preferred_name!==p.first_name?' <span class="sub">('+esc(p.preferred_name)+')</span>':''),esc(p.ndis_number),pill(p.status,p.status==='active'?'ok':''),(p.tags||[]).map(t=>pill(t.name)).join(' '),p.latest_checkin?esc(p.latest_checkin.type)+' · '+when(p.latest_checkin.date):'—',esc(p.mobile)]))+'</div>';}
 else if(cur==='shifts'){const now=new Date();const mon=new Date(now);mon.setDate(now.getDate()-((now.getDay()+6)%7));const sun=new Date(mon);sun.setDate(mon.getDate()+6);const f=d=>d.toISOString().slice(0,10);const j=await api('/public/v1/shifts?page[size]=100&filter[start_after]='+f(mon)+'&filter[start_before]='+f(sun)+'&sort=start_time');
  v.innerHTML='<div class="card"><div class="row"><strong>'+j.meta.total+' shifts, '+day(f(mon))+' – '+day(f(sun))+'</strong><span class="sub">GET /public/v1/shifts?filter[start_after]&filter[start_before]</span></div>'+table(['Start','End','Worker','Participant','Status','Clock in','Clock out'],j.data.map(s=>[when(s.start_time),when(s.end_time).split(', ').pop(),esc(s.user&&s.user.name),esc(s.support&&s.support.participant&&s.support.participant.name),pill(s.status,s.status==='completed'?'ok':s.status==='cancelled'?'bad':''),s.clock_in_at?when(s.clock_in_at).split(', ').pop():'—',s.clock_out_at?when(s.clock_out_at).split(', ').pop():(s.status==='completed'?pill('missing','bad'):'—')]))+'</div>';}
 else if(cur==='supports'){const j=await api('/public/v1/supports?page[size]=100&sort=-start_time');v.innerHTML='<div class="card"><div class="row"><strong>Latest '+j.data.length+' of '+j.meta.total+' supports</strong><span class="sub">GET /public/v1/supports</span></div>'+table(['Start','Participant','Details','Status','Workers','Travel km'],j.data.map(s=>[when(s.start_time),esc(s.participant&&s.participant.name),esc(s.details),(s.shifts||[]).map(x=>pill(x.status,x.status==='completed'?'ok':x.status==='cancelled'?'bad':'')).join(' ')||'—',(s.shifts||[]).map(x=>esc(x.user&&x.user.name)).join(', '),(s.travels||[]).map(t=>(t.actual_distance??t.distance)+(t.approved_distance!=null&&t.actual_distance>t.approved_distance?' '+pill('> approved '+t.approved_distance,'warn'):'')).join(', ')]))+'</div>';}
 else if(cur==='invoices'){const j=await api('/public/v1/invoices?page[size]=100');const ps=await api('/public/v1/participants?page[size]=100&filter[status]=active,archived');const nm=Object.fromEntries(ps.data.map(p=>[p.id,p.full_name]));
  v.innerHTML='<div class="card"><div class="row"><strong>'+j.meta.total+' invoices</strong><span class="sub">GET /public/v1/invoices · click a number for the charges</span></div>'+table(['Number','Date','Participant','Managed','Total','Charges'],j.data.map(i=>['<a href="#" data-inv="'+i.id+'">'+esc(i.number)+'</a>',day(i.date),esc(nm[i.participant.id]||i.participant.id),esc(i.management_type)+(i.management_type==='plan'&&!i.plan_manager?' '+pill('no plan manager','bad'):''),money(i.total),i.charges.length+' lines']))+'<div id="inv"></div></div>';
  v.querySelectorAll('[data-inv]').forEach(a=>a.onclick=async e=>{e.preventDefault();const d=(await api('/public/v1/invoices/'+a.dataset.inv)).data;const sum=d.charges.reduce((s,c)=>s+c.total_cost,0);$('#inv').innerHTML='<h3 style="margin:14px 0 6px">'+esc(d.number)+' · '+money(d.total)+(sum!==d.total?' '+pill('charges sum to '+money(sum),'bad'):'')+'</h3>'+table(['Date','Item','Qty','Unit','Total','Claim'],d.charges.map(c=>[day(c.date),esc(c.charge_item&&c.charge_item.reference)+' <span class="sub">'+esc(c.charge_item&&c.charge_item.name)+'</span>',c.quantity,money(c.unit_cost),money(c.total_cost),esc(c.claim_type||'')]));});}
 else if(cur==='services'){const j=await api('/public/v1/services?page[size]=100&sort=name');v.innerHTML='<div class="card"><div class="row"><strong>'+j.meta.total+' service agreements</strong><span class="sub">GET /public/v1/services</span></div>'+table(['Participant','Service','Managed','Amount','Dates','Status'],j.data.map(s=>[esc(s.participant&&s.participant.full_name),esc(s.name),esc(s.management_type),money(s.amount),day(s.start)+' – '+day(s.end),pill(s.status,s.status==='current'?'ok':s.status==='expired'?'bad':'warn')]))+'</div>';}
 else if(cur==='incidents'){const [i,f]=await Promise.all([api('/public/v1/incidents?page[size]=50'),api('/public/v1/feedback?page[size]=50')]);v.innerHTML='<div class="card"><strong>Incidents</strong>'+table(['Ref','When','Type','Severity','Reportable','Status','Follow-up'],i.data.map(x=>[esc(x.reference),when(x.time),esc(x.type),esc(x.severity),esc(x.reportable)+(x.reportable==='yes'&&!x.reportable_type?' '+pill('type missing','bad'):''),pill(x.status,x.status==='reported'?'warn':'ok'),x.follow_up_details?esc(x.follow_up_details):pill('none','bad')]))+'</div><div class="card"><strong>Feedback and complaints</strong>'+table(['Ref','Type','From','Details','Status','Follow-up'],f.data.map(x=>[esc(x.reference),esc(x.feedback_type),esc(x.complainant_name),esc(x.details),pill(x.status,x.status==='new'?'warn':'ok'),x.follow_up_details?esc(x.follow_up_details):pill('none','bad')]))+'</div>';}
 else if(cur==='compliance'){const j=await api('/public/v1/user-records?page[size]=100');v.innerHTML='<div class="card"><div class="row"><strong>Worker records</strong><span class="sub">GET /public/v1/user-records</span></div>'+table(['Worker','Record','Reference','Expires','Status'],j.data.map(r=>[esc(r.user&&r.user.name),esc(r.name),esc(r.reference),day(r.expiry_date),pill(r.status,r.status==='expired'?'bad':r.status==='expiring'?'warn':'ok')]))+'</div>';}
 else if(cur==='changes'){const j=await api('/_replica/changes?page[size]=100');v.innerHTML='<div class="card"><div class="row"><strong>Recent changes</strong><span class="sub">Every write through the API lands here, with who made it. The seed data is not listed.</span></div>'+table(['When','What','Who'],j.data.map(c=>[when(c.at),esc(c.summary),esc(c.actor||'—')+(c.via?' <span class="sub">via '+esc(c.via)+'</span>':'')]))+'</div>';}
 else if(cur==='planted'){const j=await api('/_replica/planted');v.innerHTML='<div class="card"><div class="row"><strong>Planted errors</strong><span class="sub">What the NDIS Wizard agents should find in this data set.</span></div>'+table(['Code','Area','What is wrong'],j.data.map(p=>[esc(p.code),pill(p.area),esc(p.summary)]))+'</div>';}
}catch(e){v.innerHTML='<div class="card" style="color:var(--bad)">'+esc(e.message)+'</div>';if(/Unauthenticated/.test(e.message)){tok='';localStorage.removeItem('ast_tok');boot();}}}
async function boot(){$('#login').style.display=tok?'none':'';$('#nav').style.display=tok?'':'none';$('#view').innerHTML='';$('#who').textContent='';if(!tok)return;try{await api('/public/v1/app/status');$('#who').textContent='signed in';nav();show();}catch(e){$('#err').textContent=e.message;tok='';localStorage.removeItem('ast_tok');boot();}}
$('#go').onclick=()=>{tok=$('#tok').value.trim();if(!tok)return;localStorage.setItem('ast_tok',tok);$('#err').textContent='';boot();};
$('#tok').addEventListener('keydown',e=>{if(e.key==='Enter')$('#go').click();});
boot();
</script></body></html>`;
}

export function docsPage(base: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Astalty clone · API reference</title></head>
<body><script id="api-reference" data-url="${base}/docs.json"></script>
<script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.60/dist/browser/standalone.min.js"></script></body></html>`;
}
