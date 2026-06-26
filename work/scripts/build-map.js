// Build interactive route map HTML from route_plan.json + orders_with_zones.json + GeoJSON.
// Output: work/output/route_map.html (single file, double-click to open).
// 用法: node work/scripts/build-map.js
//   或被 require: const { buildMap } = require('./build-map');
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORK = path.resolve(__dirname, '..');
const PLAN = path.join(WORK, 'output', 'route_plan.json');
const ORDERS = path.join(WORK, 'orders_with_zones.json');
const GEOJSON = path.join(WORK, 'Mtl远线分单', '区域图MTLFarMap.geojson');
const OUT = path.join(WORK, 'output', 'route_map.html');

function buildMap() {
const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
const orders = JSON.parse(fs.readFileSync(ORDERS, 'utf8')).orders;
const geo = JSON.parse(fs.readFileSync(GEOJSON, 'utf8'));
const orderMap = new Map(orders.map(o => [String(o.name), o]));

// Enrich each stop with lat/lng/address/window
const enrichedDrivers = plan.perDriver.map(d => {
  const stops = (d.stops || []).map(s => {
    const o = orderMap.get(String(s.location_id));
    return {
      id: s.location_id,
      arrival: s.arrival_time,
      finish: s.finish_time,
      lat: o ? o.lat : null,
      lng: o ? o.lng : null,
      address: o ? o.address : '',
      from: o ? o.from : '',
      to: o ? o.to : '',
      ref: o ? o.ref : '',
      duration: o ? o.duration : 0,
      zoneId: o ? o.zoneId : null
    };
  });
  return { id: d.id, nickname: d.nickname, stops };
});

const unservedIds = new Set();
let totalTravelTime = 0;
for (const d of plan.perDriver) {
  if (d.unserved) {
    if (Array.isArray(d.unserved)) for (const u of d.unserved) unservedIds.add(u.location_id || u.id || u);
    else for (const id of Object.keys(d.unserved)) unservedIds.add(id);
  }
  if (d.totalTravelTime) totalTravelTime += d.totalTravelTime;
}
const unservedOrders = [...unservedIds].map(id => {
  const o = orderMap.get(id);
  return o ? { id, lat: o.lat, lng: o.lng, address: o.address, from: o.from, to: o.to, ref: o.ref } : null;
}).filter(Boolean);

// Compute per-driver working window (start to end)
function toMin(t){ if(!t)return 0; const [h,m]=t.split(':').map(Number); return h*60+m; }
function windowFor(d){
  const real = d.stops.filter(s => s.id && !s.id.endsWith('_start') && !s.id.endsWith('_end'));
  const startStop = d.stops.find(s => s.id && s.id.endsWith('_start'));
  const endStop = [...d.stops].reverse().find(s => s.id && s.id.endsWith('_end'));
  const startT = startStop ? startStop.arrival : (real[0] ? real[0].arrival : '-');
  const endT = endStop ? endStop.arrival : (real.length ? real[real.length-1].arrival : '-');
  const dur = (startT !== '-' && endT !== '-') ? toMin(endT) - toMin(startT) : 0;
  return { startT, endT, durationMin: dur, stopsCount: real.length };
}

const driverWindows = enrichedDrivers.map(d => ({ id: d.id, ...windowFor(d) }));

const totals = {
  served: enrichedDrivers.reduce((a, d) => a + windowFor(d).stopsCount, 0),
  unserved: unservedOrders.length,
  totalTravelTime: totalTravelTime,
  generatedAt: plan.finishedAt || plan.startedAt || ''
};

const data = {
  totals,
  zones: geo,
  warehouse: { name: "25 Av. d'Inverness, Candiac", lat: 45.396, lng: -73.515 },
  drivers: enrichedDrivers,
  driverWindows,
  unservedOrders
};

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>MTL Route Map - ${totals.generatedAt}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .header { padding: 12px 16px; background: #fafafa; border-bottom: 1px solid #e0e0e0; }
    .stats { display: flex; gap: 28px; flex-wrap: wrap; align-items: baseline; }
    .stat { font-size: 13px; color: #555; }
    .stat b { font-size: 20px; color: #222; margin-right: 4px; }
    .stat .ok { color: #2e7d32; }
    .stat .warn { color: #c62828; }
    .drivers { display: flex; gap: 16px; margin-top: 8px; font-size: 12px; color: #666; }
    .driver-tag { padding: 3px 10px; border-radius: 10px; background: #f0f0f0; }
    .driver-tag b { color: #222; }
    #map { height: calc(100vh - 110px); width: 100%; }
    .legend { background: white; padding: 12px; border-radius: 6px; box-shadow: 0 1px 5px rgba(0,0,0,0.2); font-size: 13px; line-height: 1.6; }
    .legend b { font-size: 14px; }
    .legend .item { display: flex; align-items: center; gap: 8px; }
    .legend .swatch { width: 16px; height: 4px; border-radius: 2px; }
    .legend .dot { width: 10px; height: 10px; border-radius: 50%; }
    .legend hr { border: none; border-top: 1px solid #eee; margin: 6px 0; }
  </style>
</head>
<body>
  <div class="header">
    <div class="stats">
      <div class="stat"><b class="ok">${totals.served}</b>served</div>
      <div class="stat"><b class="${totals.unserved>0?'warn':'ok'}">${totals.unserved}</b>unserved</div>
      <div class="stat"><b>${totals.totalTravelTime}</b>min total travel</div>
      <div class="stat">generated: <b>${totals.generatedAt}</b></div>
    </div>
    <div class="drivers" id="driverTags"></div>
  </div>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
  <script>
    const DATA = ${JSON.stringify(data)};
    const COLORS = { 'MTL-Tony': '#e41a1c', 'MTL-Faouzi': '#377eb8', 'MTL-Luke': '#4daf4a', 'MTL-NewDriver': '#984ea3' };

    const map = L.map('map').setView([45.50, -73.55], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    // Zones (半透明边界)
    L.geoJSON(DATA.zones, {
      style: { color: '#666', weight: 2, fillOpacity: 0.05, dashArray: '4 4' }
    }).bindTooltip(f => 'Zone ' + (f.feature?.id || '')).addTo(map);

    // Warehouse (红星)
    L.marker([DATA.warehouse.lat, DATA.warehouse.lng], {
      icon: L.divIcon({
        html: '<div style="font-size:24px;color:#c00;text-shadow:0 0 2px white;">\u2605</div>',
        iconSize: [24, 24],
        className: 'wh-icon'
      })
    }).bindPopup('<b>' + DATA.warehouse.name + '</b><br>(warehouse)').addTo(map);

    // Drivers: polyline + numbered stops + arrows
    const allBounds = [[DATA.warehouse.lat, DATA.warehouse.lng]];
    for (const d of DATA.drivers) {
      const color = COLORS[d.id] || '#333';
      const allStops = (d.stops || []).filter(s => s.lat != null);
      const realStops = allStops.filter(s => !(s.id && (s.id.endsWith('_start') || s.id.endsWith('_end'))));
      const latlngs = allStops.map(s => [s.lat, s.lng]);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color, weight: 4, opacity: 0.6 }).addTo(map);
        // 方向箭头: 在每段中点放一个箭头marker
        for (let seg = 0; seg < latlngs.length - 1; seg++) {
          const a = latlngs[seg], b = latlngs[seg + 1];
          const midLat = (a[0] + b[0]) / 2, midLng = (a[1] + b[1]) / 2;
          const angle = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI;
          L.marker([midLat, midLng], {
            icon: L.divIcon({
              html: '<div style="color:' + color + ';font-size:14px;font-weight:bold;text-shadow:0 0 3px white,0 0 3px white;transform:rotate(' + (-angle + 90).toFixed(0) + 'deg)">&#10148;</div>',
              iconSize: [14, 14], className: 'arrow-icon'
            })
          }).addTo(map);
        }
      }
      // 编号 marker (真实订单从1开始)
      let realIdx = 0;
      for (const s of allStops) {
        allBounds.push([s.lat, s.lng]);
        const isStart = s.id && s.id.endsWith('_start');
        const isEnd = s.id && s.id.endsWith('_end');
        if (isStart) {
          L.marker([s.lat, s.lng], {
            icon: L.divIcon({ html: '<div style="width:18px;height:18px;border-radius:50%;background:' + color + ';border:2px solid white;color:white;font-size:10px;font-weight:bold;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4)">S</div>', iconSize: [18, 18], className: 'stop-icon' })
          }).bindPopup('<b>' + d.id + ' START</b><br>' + (s.arrival || '') + '<br>warehouse').addTo(map);
        } else if (isEnd) {
          L.marker([s.lat, s.lng], {
            icon: L.divIcon({ html: '<div style="width:18px;height:18px;border-radius:50%;background:' + color + ';border:2px solid white;color:white;font-size:10px;font-weight:bold;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4)">E</div>', iconSize: [18, 18], className: 'stop-icon' })
          }).bindPopup('<b>' + d.id + ' END</b><br>' + (s.arrival || '') + '<br>warehouse').addTo(map);
        } else {
          realIdx++;
          const num = realIdx;
          L.marker([s.lat, s.lng], {
            icon: L.divIcon({ html: '<div style="width:22px;height:22px;border-radius:50%;background:white;border:2px solid ' + color + ';color:' + color + ';font-size:11px;font-weight:bold;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.4)">' + num + '</div>', iconSize: [22, 22], className: 'stop-icon' })
          })
            .bindTooltip(d.id.replace('MTL-','') + ' #' + num + ': ' + (s.id || ''))
            .bindPopup(
              '<b>' + d.id + ' #' + num + '</b><br>' +
              'order: ' + s.id + '<br>' +
              (s.arrival ? s.arrival + ' - ' + s.finish + '<br>' : '') +
              (s.address ? s.address + '<br>' : '') +
              (s.from && s.to ? 'window: ' + s.from + ' - ' + s.to + '<br>' : '') +
              (s.ref ? 'type: ' + s.ref + '<br>' : '') +
              (s.zoneId ? 'zone: ' + s.zoneId : '')
            )
            .addTo(map);
        }
      }
    }

    // Unserved (灰)
    for (const u of DATA.unservedOrders) {
      if (u.lat == null) continue;
      allBounds.push([u.lat, u.lng]);
      L.circleMarker([u.lat, u.lng], {
        radius: 4, color: '#888', fillColor: '#bbb', fillOpacity: 0.6, weight: 1
      })
        .bindTooltip('unserved: ' + u.id)
        .bindPopup(
          '<b>unserved</b><br>order: ' + u.id + '<br>' +
          (u.address ? u.address + '<br>' : '') +
          (u.from && u.to ? 'window: ' + u.from + ' - ' + u.to + '<br>' : '') +
          (u.ref ? 'type: ' + u.ref : '')
        )
        .addTo(map);
    }

    if (allBounds.length > 1) map.fitBounds(allBounds, { padding: [30, 30] });

    // Legend (右下)
    const legend = L.control({ position: 'bottomright' });
    legend.onAdd = function() {
      const div = L.DomUtil.create('div', 'legend');
      let html = '<b>Driver</b>';
      for (const d of DATA.drivers) {
        const w = DATA.driverWindows.find(x => x.id === d.id);
        const color = COLORS[d.id] || '#333';
        const dur = w ? (w.durationMin/60).toFixed(1) + 'h' : '-';
        html += '<div class="item"><div class="swatch" style="background:' + color + '"></div>' + d.id + ': ' + w.stopsCount + ' stops, ' + dur + '</div>';
      }
      html += '<hr><div class="item"><div class="dot" style="background:#c00"></div>Warehouse</div>';
      html += '<div class="item"><div class="dot" style="background:#bbb"></div>Unserved: ' + DATA.unservedOrders.length + '</div>';
      div.innerHTML = html;
      return div;
    };
    legend.addTo(map);

    // Driver tags (header)
    const tags = document.getElementById('driverTags');
    for (const d of DATA.drivers) {
      const w = DATA.driverWindows.find(x => x.id === d.id);
      const dur = w && w.durationMin ? (w.durationMin/60).toFixed(1) + 'h' : '-';
      const tag = document.createElement('div');
      tag.className = 'driver-tag';
      tag.innerHTML = '<b>' + d.id + '</b>: ' + (w?w.stopsCount:0) + ' stops, ' + dur + ' (' + (w?w.startT:'-') + ' \u2192 ' + (w?w.endT:'-') + ')';
      tags.appendChild(tag);
    }
  </script>
</body>
</html>`;

fs.writeFileSync(OUT, html, 'utf8');
console.log('wrote ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
console.log('stats: ' + JSON.stringify(totals));
return { out: OUT, totals };
}

if (require.main === module) {
  try { buildMap(); }
  catch (e) { console.error('FATAL', e.message); process.exit(4); }
}

module.exports = { buildMap };
