const { json, fetchJson, distanceKm } = require('./_utils');
const URL = 'https://tpnco.blob.core.windows.net/blobfs/Todaywork.json';

function recordsOf(v) {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== 'object') return [];
  for (const k of ['data','Data','records','Records','Todaywork','todaywork']) if (Array.isArray(v[k])) return v[k];
  for (const val of Object.values(v)) { const r = recordsOf(val); if (r.length) return r; }
  return [];
}
function twd97ToWgs84(x, y) {
  x=Number(x); y=Number(y); if(!Number.isFinite(x)||!Number.isFinite(y)) return null;
  const a=6378137.0,b=6356752.314245,lng0=121*Math.PI/180,k0=.9999,dx=250000,e=Math.sqrt(1-b*b/(a*a));
  x-=dx; const e2=e*e/(1-e*e), M=y/k0, mu=M/(a*(1-e*e/4-3*Math.pow(e,4)/64-5*Math.pow(e,6)/256));
  const e1=(1-Math.sqrt(1-e*e))/(1+Math.sqrt(1-e*e));
  const fp=mu+(3*e1/2-27*Math.pow(e1,3)/32)*Math.sin(2*mu)+(21*e1*e1/16-55*Math.pow(e1,4)/32)*Math.sin(4*mu)+(151*Math.pow(e1,3)/96)*Math.sin(6*mu)+(1097*Math.pow(e1,4)/512)*Math.sin(8*mu);
  const c1=e2*Math.cos(fp)**2,t1=Math.tan(fp)**2,r1=a*(1-e*e)/Math.pow(1-e*e*Math.sin(fp)**2,1.5),n1=a/Math.sqrt(1-e*e*Math.sin(fp)**2),d=x/(n1*k0);
  const lat=fp-(n1*Math.tan(fp)/r1)*(d*d/2-(5+3*t1+10*c1-4*c1*c1-9*e2)*d**4/24+(61+90*t1+298*c1+45*t1*t1-252*e2-3*c1*c1)*d**6/720);
  const lon=lng0+(d-(1+2*t1+c1)*d**3/6+(5-2*c1+28*t1-3*c1*c1+8*e2+24*t1*t1)*d**5/120)/Math.cos(fp);
  return {lat:lat*180/Math.PI,lon:lon*180/Math.PI};
}
function pos(x) {
  const X=Number(x.X),Y=Number(x.Y);
  if(Number.isFinite(X)&&Number.isFinite(Y)) {
    if(X>118&&X<123.5&&Y>20&&Y<27) return {lat:Y,lon:X};
    if(X>100000&&Y>2000000) return twd97ToWgs84(X,Y);
  }
  return null;
}
function blocked(x) { return /^(1|true|y|yes|是)$/i.test(String(x.IsBlock ?? x.isBlock ?? '')) || /影響|占用|封閉|縮減/.test(String(x.PlanB||'')); }

module.exports = async (req,res) => {
  if(req.method==='OPTIONS') return json(res,204,{},'no-store');
  const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Math.min(20,Math.max(1,Number(req.query.radius||6)));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return json(res,400,{error:'Invalid coordinates'});
  const likelyTaipei=lat>24.93&&lat<25.22&&lon>121.42&&lon<121.68;
  if(!likelyTaipei) return json(res,200,{zeroKey:true,source:'臺北市今日施工資訊',coverage:'Taipei City',items:[],message:'詳細施工 Zero-Key 來源目前先提供臺北市；其他地區仍會由警廣交通事件捕捉施工通報。'},'s-maxage=600');
  try {
    const d=await fetchJson(URL,{},12000);
    const items=recordsOf(d).map((x)=>{ const p=pos(x); if(!p)return null; return {
      id:String(x.sno||x.Ac_no||`${p.lat}-${p.lon}`), lat:p.lat,lon:p.lon,distance:distanceKm(lat,lon,p.lat,p.lon),
      district:x.C_Name||'',address:x.Addr||'',unit:x.App_Name||'',purpose:x.NPurp||x.WItem||'',
      start:x.Cb_Da||'',end:x.Ce_Da||'',hours:x.Co_Ti||'',impactTraffic:blocked(x),reportedAt:x.AppTime||'',alternate:x.PlanB||''
    };}).filter(Boolean).filter((x)=>x.distance<=radius).sort((a,b)=>a.distance-b.distance).slice(0,16);
    return json(res,200,{zeroKey:true,source:'臺北市今日施工資訊',coverage:'Taipei City',generatedAt:new Date().toISOString(),cadenceMinutes:10,items},'s-maxage=300, stale-while-revalidate=900');
  } catch(e){ return json(res,502,{error:`施工情報暫時無法取得：${e.message}`},'no-store'); }
};
