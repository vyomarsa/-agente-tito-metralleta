// ============================================================================
// Repetición del TRAILING del 0DTE sobre el camino real de SPY (2026-09-17).
//
// Reconstruye el precio de cada opción minuto a minuto: IV implícita en la
// entrada + Black-Scholes (r=q=0, IV constante) sobre las velas de 1 minuto del
// subyacente, con el mismo muestreo de 1 minuto que el cron. Aplica las reglas de
// `managePosition` en su orden (objetivo, stop, fin de sesión, trailing, reloj) y
// descuenta comisiones ($0,65 por contrato y orden; vencer no paga cierre).
//
// Uso:
//   node scripts/replay-trailing-0dte.cjs data/0dte/paper-closed.jsonl velas.json validar
//   node scripts/replay-trailing-0dte.cjs data/0dte/paper-closed.jsonl velas.json rejilla 0.1,0.2,0.3 0.2,0.25,0.5
//   node scripts/replay-trailing-0dte.cjs data/0dte/paper-closed.jsonl velas.json limite   (límite diario, 2026-09-17)
//
// `velas.json` = array [{time(ms), open, high, low, close}] de SPY a 1 minuto. Se
// obtiene del streamer con `dxlinkCandles({ symbol: "SPY{=1m}", fromTime, ... })`
// (lib/tastytradeStream.ts); dxFeed entrega ~8.000 velas, unas 9 sesiones.
// Filtra a la versión 3 del modelo: cambiar el filtro `modelVersion` para medir v4.
// "validar" compara con lo que pasó de verdad: si no reproduce la mayoría de los
// motivos de salida, la rejilla no significa nada.
// ============================================================================
const fs=require('fs');
const [,,ledger,velasF,modo]=process.argv;
const V=JSON.parse(fs.readFileSync(velasF,'utf8')).sort((a,b)=>a.time-b.time);
const first=V[0].time;
const rows=fs.readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse)
  .filter(r=>r.ticker==='SPY' && +new Date(r.openedAt)>first+86400000);
// --- Black-Scholes (r=q=0), T en años naturales como el resto de la app
const N=x=>{const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);const p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p};
const bs=(S,K,T,iv,call)=>{if(T<=0)return Math.max(0,call?S-K:K-S);const sd=iv*Math.sqrt(T);const d1=(Math.log(S/K)+0.5*iv*iv*T)/sd,d2=d1-sd;return call?S*N(d1)-K*N(d2):K*N(-d2)-S*N(-d1)};
const ivDe=(px,S,K,T,call)=>{let lo=0.01,hi=5;for(let i=0;i<80;i++){const m=(lo+hi)/2;bs(S,K,T,m,call)>px?hi=m:lo=m}return (lo+hi)/2};
const ET=ms=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));const g=k=>p.find(x=>x.type===k).value;return {d:`${g('year')}-${g('month')}-${g('day')}`,m:(+g('hour')%24)*60+ +g('minute')}};
const YR=365*1440;
function simularT(r,arma,devol){
  const call=r.type==='call', up=r.side==='LONG';
  const o=+new Date(r.openedAt); const e0=ET(o);
  const T0=(960-e0.m)/YR;
  const iv=ivDe(r.entryPrice,r.entrySpot,r.strike,T0,call);
  let peak=r.entryPrice, px=r.entryPrice, c_ms=null;
  for(const c of V){
    if(c.time<=o) continue; c_ms=c.time; const e=ET(c.time); if(e.d!==e0.d) break; if(e.m<570) continue;
    const left=960-e.m-1;               // el cron mira al cierre del minuto
    const S=c.close; px=bs(S,r.strike,Math.max(left,0)/YR,iv,call); peak=Math.max(peak,px);
    if(up? S>=r.target : S<=r.target) return {ms:c_ms,why:'objetivo',px};
    if(up? S<=r.stop : S>=r.stop) return {ms:c_ms,why:'stop',px};
    if(left<=0) return {ms:c_ms,why:'cierre_de_sesion',px};
    if(arma!=null && peak>=r.entryPrice*(1+arma)){const g=r.entryPrice+(peak-r.entryPrice)*(1-devol); if(px<=g) return {ms:c_ms,why:'trailing',px};}
    if(left<=30) return {ms:c_ms,why:'cierre_reloj',px};
  }
  return {ms:c_ms,why:'sin_velas',px};
}
const fee=(r,why)=>0.65*r.contracts*(why==='cierre_de_sesion'?1:2);
const net=(r,s)=>(s.px-r.entryPrice)*100*r.contracts-fee(r,s.why);
const v3=rows.filter(r=>(r.modelVersion??1)===3);
if(modo==='validar'){
  let igual=0,real=0,sim=0; const t=[];
  for(const r of v3){const s=simularT(r,0.30,0.50); const rn=r.realizedPnl-fee(r,r.closeReason); const sn=net(r,s); real+=rn; sim+=sn; if(s.why===r.closeReason)igual++;
    t.push({dia:r.openedAt.slice(5,10),lado:r.side,real:r.closeReason,sim:s.why,pnlReal:rn.toFixed(0),pnlSim:sn.toFixed(0),salidaReal:r.currentPrice,salidaSim:s.px.toFixed(3)});}
  console.table(t); console.log('v3',v3.length,'motivo igual',igual,'| neto real',real.toFixed(0),'neto simulado',sim.toFixed(0));
} else if (modo === 'rejilla') {
  const res=[];
  const armas=(process.argv[5]||'').split(',').map(Number), devs=(process.argv[6]||'').split(',').map(Number);
  for(const a of armas) for(const d of (a==null?[0]:devs)){
    let tot=0,w=0,tr=0,ob=0; for(const r of v3){const s=simularT(r,a,d);const n=net(r,s);tot+=n;if(n>0)w++;if(s.why==='trailing')tr++;if(s.why==='objetivo')ob++;}
    // robustez: mitad 1 vs mitad 2 del periodo
    const h1=v3.slice(0,14).reduce((x,r)=>x+net(r,simularT(r,a,d)),0), h2=v3.slice(14).reduce((x,r)=>x+net(r,simularT(r,a,d)),0);
    res.push({arma:a==null?'sin trailing':a,devuelve:a==null?'-':d,neto:+tot.toFixed(0),wr:Math.round(100*w/v3.length)+'%',trailing:tr,objetivos:ob,mitad1:+h1.toFixed(0),mitad2:+h2.toFixed(0)});
  }
  console.table(res);
}

// ---- LÍMITE DIARIO ----
if (modo === 'limite') {
  const dia = ms => ET(ms).d;
  // A) libro real completo, con horas reales de cierre
  const todas = fs.readFileSync(ledger,'utf8').trim().split('\n').map(JSON.parse).sort((a,b)=>a.openedAt.localeCompare(b.openedAt));
  const realNet = r => r.realizedPnl - fee(r, r.closeReason);
  // B) replay v3 con trailing v4, con hora de salida simulada
  const simV4 = v3.map(r => { const s = simularT(r, 0.20, 0.25); return { ...r, _net: net(r, s), _closeMs: s.ms }; })
                  .sort((a,b)=>a.openedAt.localeCompare(b.openedAt));
  const aplicar = (lista, netOf, closeOf, regla) => {
    let tot = 0, n = 0, bloq = 0; const dias = {};
    for (const r of lista) {
      const o = +new Date(r.openedAt), d = dia(o);
      const previas = lista.filter(x => x !== r && dia(+new Date(x.openedAt)) === d && closeOf(x) != null && closeOf(x) <= o && (x._tomada ?? true));
      const perdidas = previas.filter(x => netOf(x) < 0).length;
      const pnlDia = previas.reduce((s, x) => s + netOf(x), 0);
      const bloquea = regla && regla(perdidas, pnlDia);
      r._tomada = !bloquea;
      if (bloquea) { bloq++; continue; }
      tot += netOf(r); n++;
    }
    for (const r of lista) delete r._tomada;
    return { neto: Math.round(tot), ops: n, bloqueadas: bloq };
  };
  const reglas = [
    ['sin límite', null],
    ['1 pérdida', (p) => p >= 1], ['2 pérdidas', (p) => p >= 2], ['3 pérdidas', (p) => p >= 3],
    ['−$50 día', (p, d) => d <= -50], ['−$100 día', (p, d) => d <= -100], ['−$150 día', (p, d) => d <= -150], ['−$200 día', (p, d) => d <= -200],
    ['2 pérd. o −$150', (p, d) => p >= 2 || d <= -150],
  ];
  const t = reglas.map(([nombre, regla]) => {
    const a = aplicar(todas, realNet, x => x.closedAt ? +new Date(x.closedAt) : null, regla);
    const a2 = aplicar(todas.filter(r => (r.modelVersion ?? 1) >= 2), realNet, x => x.closedAt ? +new Date(x.closedAt) : null, regla);
    const b = aplicar(simV4, x => x._net, x => x._closeMs, regla);
    return { regla: nombre, 'libro 73': a.neto, 'bloq73': a.bloqueadas, 'v2+v3 60': a2.neto, 'bloq60': a2.bloqueadas, 'replay v4 27': b.neto, 'bloq27': b.bloqueadas };
  });
  console.table(t);
}
