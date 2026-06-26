// assign-zones.js — 读订单 Excel,按 GeoJSON 多边形做点在多边形内判定,给每单分配区域。
// 输出: work/orders_with_zones.json + work/zone_assignment_summary.txt
// 用法: node work/scripts/assign-zones.js <order_xlsx_path>
//   或被 require: const { assignZones } = require('./assign-zones');
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORK = path.resolve(__dirname, '..');
const GEOJSON = path.join(WORK, 'Mtl远线分单', '区域图MTLFarMap.geojson');
const SETTINGS = path.join(WORK, 'config', 'settings.json');
const OUT_JSON = path.join(WORK, 'orders_with_zones.json');
const OUT_SUM = path.join(WORK, 'zone_assignment_summary.txt');

const { readXlsx, cleanup, cell } = require(path.join(WORK, 'lib', 'xlsx-reader.js'));

function pointInPolygon(pt, vs) {
  const x = pt[0], y = pt[1]; let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function assignZones(orderXlsxPath, geojsonOverride) {
  if (!fs.existsSync(orderXlsxPath)) throw new Error('订单表不存在: ' + orderXlsxPath);
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const { headers, rows, tmpDir } = readXlsx(orderXlsxPath);

  const orders = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const lat = parseFloat(cell(r, headers, 'lat'));
    const lng = parseFloat(cell(r, headers, 'lng'));
    if (!isFinite(lat) || !isFinite(lng)) continue;
    orders.push({
      name: String(cell(r, headers, 'Name') || ''),
      ref: String(cell(r, headers, 'Ref') || ''),
      address: String(cell(r, headers, 'Address') || ''),
      duration: Number(cell(r, headers, 'Duration')) || 0,
      load: Number(cell(r, headers, 'Load')) || 0,
      from: String(cell(r, headers, 'FromG') || ''),
      to: String(cell(r, headers, 'ToG') || ''),
      lat, lng,
      notes: String(cell(r, headers, 'Notes') || ''),
      notes2: String(cell(r, headers, 'Notes2') || ''),
      driverHint: String(cell(r, headers, 'driver_nickname') || ''),
      areaHint: String(cell(r, headers, 'Area') || '')
    });
  }

  const geo = geojsonOverride || JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
  const zones = geo.features.map((f, i) => ({ zoneId: i + 1, coords: f.geometry.coordinates[0] }));

  let unassigned = 0;
  for (const o of orders) {
    let hit = null;
    for (const z of zones) { if (pointInPolygon([o.lng, o.lat], z.coords)) { hit = z.zoneId; break; } }
    o.zoneId = hit;
    if (hit === null) unassigned++;
  }

  // 落在所有区域外的单,就近归到最近区域的中心(避免无人认领)
  if (unassigned > 0) {
    const zc = zones.map(z => ({
      zId: z.zoneId,
      cx: z.coords.reduce((a, v) => a + v[0], 0) / z.coords.length,
      cy: z.coords.reduce((a, v) => a + v[1], 0) / z.coords.length
    }));
    for (const o of orders) {
      if (o.zoneId !== null) continue;
      let bd = Infinity, bz = 1;
      for (const c of zc) { const d = (c.cx - o.lng) ** 2 + (c.cy - o.lat) ** 2; if (d < bd) { bd = d; bz = c.zId; } }
      o.zoneId = bz; o.zoneFallback = 'nearest';
    }
  }

  const zoneIds = zones.map(z => z.zoneId);
  const counts = {}; const refCount = {}; const ft = {};
  for (const z of zoneIds) { counts[z] = 0; refCount[z] = 0; ft[z] = { from: [], to: [] }; }
  for (const o of orders) {
    counts[o.zoneId]++; if (o.ref === 'ref') refCount[o.zoneId]++;
    const fh = parseInt((o.from || '0').split(':')[0], 10);
    const th = parseInt((o.to || '0').split(':')[0], 10);
    if (isFinite(fh)) ft[o.zoneId].from.push(fh);
    if (isFinite(th)) ft[o.zoneId].to.push(th);
  }
  function avg(a) { return a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '-'; }

  const result = {
    totalOrders: orders.length, unassigned, generatedAt: new Date().toISOString(),
    source: path.basename(orderXlsxPath),
    warehouse: settings.warehouse,
    zones: zones.map(z => ({ zoneId: z.zoneId, vertexCount: z.coords.length })),
    orders
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));

  let sum = '=== ZONE ASSIGNMENT (GeoJSON ' + zones.length + ' polygons, ray-casting) ===\n';
  sum += 'source: ' + path.basename(orderXlsxPath) + '\n';
  sum += 'total orders: ' + orders.length + ' | unassigned(就近归组): ' + unassigned + '\n';
  for (const z of zoneIds) {
    const fc = ft[z];
    sum += '  Z' + z + ': ' + counts[z] + ' orders (' + refCount[z] + ' ref) | from avg=' + avg(fc.from) + 'h to avg=' + avg(fc.to) + 'h\n';
  }
  fs.writeFileSync(OUT_SUM, sum);
  cleanup(tmpDir);

  return { totalOrders: orders.length, unassigned, zoneCounts: counts, out: OUT_JSON, summary: sum };
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node work/scripts/assign-zones.js <order_xlsx_path>');
    process.exit(1);
  }
  try {
    const r = assignZones(arg);
    console.log(r.summary);
    console.log('Written: ' + r.out);
  } catch (e) {
    console.error('错误: ' + e.message); process.exit(2);
  }
}

module.exports = { assignZones };
