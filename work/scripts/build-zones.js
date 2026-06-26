// Build zone candidates via K-means on order lat/lng.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORDERS_DIR = process.argv[2]
  ? path.resolve(process.argv[2], 'xl')
  : path.join(ROOT, 'xlsx', '6.26蒙特第一车近线停点', 'xl');
const OUT_DIR = ROOT;

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function colIndex(ref) {
  const m = ref.match(/^([A-Z]+)/); if (!m) return 0;
  let n = 0; for (const ch of m[1]) n = n*26 + (ch.charCodeAt(0)-64);
  return n - 1;
}
function parseSharedStrings(xmlDir) {
  const file = path.join(xmlDir, 'sharedStrings.xml');
  if (!fs.existsSync(file)) return [];
  const xml = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m; while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const textParts = []; const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm; while ((tm = tRe.exec(block)) !== null) textParts.push(tm[1]);
    out.push(decodeXmlEntities(textParts.join('')));
  }
  return out;
}
function parseSheet(xmlDir, shared) {
  const file = path.join(xmlDir, 'worksheets', 'sheet1.xml');
  const xml = fs.readFileSync(file, 'utf8');
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm; while ((rm = rowRe.exec(xml)) !== null) {
    const row = {};
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm; while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1]; const body = cm[2];
      const refMatch = attrs.match(/\br="([A-Z]+\d+)"/);
      if (!refMatch) continue;
      const ci = colIndex(refMatch[1]);
      const tMatch = attrs.match(/\bt="([^"]+)"/);
      const type = tMatch ? tMatch[1] : '';
      const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
      let val;
      if (type === 's' && vMatch) val = shared[+vMatch[1]] ?? '';
      else if (type === 'inlineStr') {
        const t = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        val = t ? decodeXmlEntities(t[1]) : '';
      } else if (vMatch) val = decodeXmlEntities(vMatch[1]);
      else val = '';
      row[ci] = val;
    }
    rows.push(row);
  }
  return rows;
}

const ordersShared = parseSharedStrings(ORDERS_DIR);
const ordersRows = parseSheet(ORDERS_DIR, ordersShared);
const H = ordersRows[0];
function col(name) { for (let i=0;i<26;i++) if (H[i]===name) return i; throw new Error('not found: '+name); }
const cName=col('Name'), cAddress=col('Address'), cDuration=col('Duration'),
      cLoad=col('Load'), cFromG=col('FromG'), cToG=col('ToG'),
      cLng=col('lng'), cLat=col('lat'), cNotes=col('Notes');

const orders = [];
for (let i = 1; i < ordersRows.length; i++) {
  const r = ordersRows[i];
  const lat = parseFloat(r[cLat]), lng = parseFloat(r[cLng]);
  if (!isFinite(lat) || !isFinite(lng)) continue;
  orders.push({
    name: String(r[cName] ?? ''),
    address: String(r[cAddress] ?? ''),
    duration: Number(r[cDuration]) || 0,
    load: Number(r[cLoad]) || 0,
    from: String(r[cFromG] ?? ''),
    to: String(r[cToG] ?? ''),
    lat, lng,
    notes: String(r[cNotes] ?? '')
  });
}
console.log('orders parsed:', orders.length);

const meanLat = orders.reduce((a,o)=>a+o.lat,0)/orders.length;
const cosMean = Math.cos(meanLat * Math.PI / 180);
function project(o){ return [o.lng*cosMean, o.lat]; }
function dist(a,b){ const dx=a[0]-b[0],dy=a[1]-b[1]; return Math.sqrt(dx*dx+dy*dy); }

function kmeansPP(points, k) {
  const centroids = [];
  centroids.push(points[Math.floor(Math.random()*points.length)]);
  while (centroids.length < k) {
    const d2 = points.map(p => { let m=Infinity; for (const c of centroids) { const dd=dist(p,c); if (dd<m) m=dd; } return m*m; });
    const sum = d2.reduce((a,b)=>a+b,0);
    let r = Math.random()*sum, pick = 0;
    for (let i=0;i<d2.length;i++) { r -= d2[i]; if (r<=0) { pick=i; break; } }
    centroids.push(points[pick]);
  }
  return centroids;
}
function kmeans(points, k, maxIter=80) {
  let centroids = kmeansPP(points, k);
  let assign = new Array(points.length).fill(0);
  for (let it=0; it<maxIter; it++) {
    let changed = false;
    for (let i=0;i<points.length;i++) {
      let best=0, bestD=Infinity;
      for (let c=0;c<k;c++) { const d=dist(points[i], centroids[c]); if (d<bestD){bestD=d;best=c;} }
      if (assign[i]!==best){ assign[i]=best; changed=true; }
    }
    if (!changed && it>5) break;
    const sums = Array.from({length:k}, ()=>[0,0,0]);
    for (let i=0;i<points.length;i++) { const c=assign[i]; sums[c][0]+=points[i][0]; sums[c][1]+=points[i][1]; sums[c][2]++; }
    for (let c=0;c<k;c++) if (sums[c][2]>0) centroids[c]=[sums[c][0]/sums[c][2], sums[c][1]/sums[c][2]];
  }
  return { centroids, assign };
}

const K = 7;
const projected = orders.map(project);
let best=null;
for (let trial=0; trial<12; trial++) {
  const r = kmeans(projected, K);
  let sse=0; for (let i=0;i<projected.length;i++) sse += Math.pow(dist(projected[i], r.centroids[r.assign[i]]), 2);
  if (!best || sse<best.sse) best = { ...r, sse };
}
const { centroids, assign } = best;

function round6(x){return Math.round(x*1e6)/1e6;} function round2(x){return Math.round(x*100)/100;}

const clusters = Array.from({length:K}, (_,c)=>({ id:c, points:[] }));
for (let i=0;i<orders.length;i++) clusters[assign[i]].points.push(orders[i]);
for (const c of clusters) {
  const lngs = c.points.map(p=>p.lng), lats = c.points.map(p=>p.lat);
  const [ccLng, ccLat] = [centroids[c.id][0]/cosMean, centroids[c.id][1]];
  c.centerLng=ccLng; c.centerLat=ccLat; c.count=c.points.length;
  c.minLng=Math.min(...lngs); c.maxLng=Math.max(...lngs);
  c.minLat=Math.min(...lats); c.maxLat=Math.max(...lats);
  c.avgDuration=c.points.reduce((a,p)=>a+p.duration,0)/Math.max(1,c.count);
  c.totalLoad=c.points.reduce((a,p)=>a+p.load,0);
  let bestD=Infinity, rep=null;
  for (const p of c.points) { const d=dist(project(p), centroids[c.id]); if (d<bestD){bestD=d;rep=p;} }
  c.rep = rep ? rep.name : '';
}
clusters.sort((a,b)=>b.count-a.count);
clusters.forEach((c,i)=>c.zoneNo=i+1);

const result = {
  k: K, totalOrders: orders.length, sse: best.sse,
  generatedAt: new Date().toISOString(),
  warehouse: { name: '25 Av. d\'Inverness, Candiac', lat: 45.396, lng: -73.515 },
  clusters: clusters.map(c => ({
    zoneNo: c.zoneNo, count: c.count,
    center: { lat: round6(c.centerLat), lng: round6(c.centerLng) },
    bbox: { minLat: round6(c.minLat), maxLat: round6(c.maxLat), minLng: round6(c.minLng), maxLng: round6(c.maxLng) },
    avgDurationMin: round2(c.avgDuration),
    totalLoad: round2(c.totalLoad),
    representative: c.rep,
    points: c.points.map(p=>({ id:p.name, lat:round6(p.lat), lng:round6(p.lng), address:p.address, duration:p.duration, load:p.load, from:p.from, to:p.to }))
  }))
};

fs.writeFileSync(path.join(OUT_DIR,'zone_candidates.json'), JSON.stringify(result,null,2));

console.log('\n=== ZONE CANDIDATES (K-means, k=' + K + ') ===');
console.log('| Z | Count | Center (lat,lng)        | BBox (lng/lat)                       | AvgDur | Load | Rep |');
console.log('|---|-------|-------------------------|--------------------------------------|--------|------|-----|');
for (const c of result.clusters) {
  const ct = c.center.lat.toFixed(4)+','+c.center.lng.toFixed(4);
  const bb = c.bbox.minLng.toFixed(2)+'~'+c.bbox.maxLng.toFixed(2)+' / '+c.bbox.minLat.toFixed(2)+'~'+c.bbox.maxLat.toFixed(2);
  console.log('| '+c.zoneNo+' | '+c.count+' | '+ct.padEnd(23)+' | '+bb.padEnd(36)+' | '+String(c.avgDurationMin).padEnd(6)+' | '+String(c.totalLoad).padEnd(4)+' | '+c.rep+' |');
}
console.log('\nWritten to work/zone_candidates.json');
