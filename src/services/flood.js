const { json, fetchText, distanceKm, xmlBlocks, tag } = require('./_utils');
const URL='https://opendata.wra.gov.tw/cloud/5982FloodWarningOfDisasterPreventionInformation/286-%E9%98%B2%E7%81%BD%E8%B3%87%E8%A8%8A_%E6%B7%B9%E6%B0%B4%E8%AD%A6%E6%88%92.kml';
function strip(v=''){return String(v).replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();}
function coord(block){ const raw=tag(block,'coordinates'); const m=String(raw).match(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/); return m?{lon:Number(m[1]),lat:Number(m[2])}:null; }
module.exports=async(req,res)=>{
  if(req.method==='OPTIONS') return json(res,204,{},'no-store');
  const lat=Number(req.query.lat),lon=Number(req.query.lon),radius=Math.min(180,Math.max(10,Number(req.query.radius||60)));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)) return json(res,400,{error:'Invalid coordinates'});
  try{
    const xml=await fetchText(URL,{headers:{Accept:'application/vnd.google-earth.kml+xml, application/xml, text/xml, */*'}},12000);
    const items=xmlBlocks(xml,'Placemark').map((b)=>{ const p=coord(b); if(!p)return null; const name=strip(tag(b,'name'))||'淹水警戒'; const description=strip(tag(b,'description')); return {name,description,lat:p.lat,lon:p.lon,distance:distanceKm(lat,lon,p.lat,p.lon)}; }).filter(Boolean).filter((x)=>x.distance<=radius).sort((a,b)=>a.distance-b.distance).slice(0,24);
    return json(res,200,{zeroKey:true,source:'經濟部水利署 防災資訊淹水警戒',generatedAt:new Date().toISOString(),items},'s-maxage=300, stale-while-revalidate=900');
  }catch(e){ return json(res,502,{error:`淹水警戒暫時無法取得：${e.message}`},'no-store'); }
};
