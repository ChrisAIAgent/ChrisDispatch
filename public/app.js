// app.js — MTL远线分单控制台 前端逻辑
'use strict';

const API = '';
const WAREHOUSE = { lat: 45.396, lng: -73.515 };  // 仓库坐标(Candiac)
const EST_SPEED = 40;  // 预估车速 km/h(用于调用API前的时间估算)
let map = null, drawControl = null;
let drawnLayers = [];     // 画的多边形图层
let orderMarkers = [];    // 订单点标记
let zoneColors = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#EF9F27', '#D4537E'];
let state = { orders: [], drivers: [], geojson: null, driverZoneMap: {}, tokenVerified: false };

// ═══ 负载指标计算工具 ═══

// Haversine 距离(km)
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 计算一组订单的负载指标
// ordersInZone: 该区域的订单数组
// 返回: { stops, load, estDistance, estDuration }
function calcZoneMetrics(ordersInZone) {
  const stops = ordersInZone.length;
  const load = ordersInZone.reduce((a, o) => a + (o.load || 0), 0);
  if (stops === 0) return { stops: 0, load: 0, estDistance: 0, estDuration: 0 };

  // 区域质心
  const cLat = ordersInZone.reduce((a, o) => a + o.lat, 0) / stops;
  const cLng = ordersInZone.reduce((a, o) => a + o.lng, 0) / stops;

  // 预估距离: 仓库 → 质心 → 仓库 (往返)
  const distToCenter = haversine(WAREHOUSE.lat, WAREHOUSE.lng, cLat, cLng);
  const estDistance = distToCenter * 2;

  // 预估时间: 往返行驶时间 + 每单服务时长
  const driveTime = (estDistance / EST_SPEED) * 60;  // 分钟
  const serviceTime = ordersInZone.reduce((a, o) => a + (o.duration || 10), 0);
  const estDuration = Math.round(driveTime + serviceTime);

  return { stops, load, estDistance: Math.round(estDistance * 10) / 10, estDuration };
}

// 获取区域内的订单
function getOrdersInZone(zoneIdx) {
  if (!drawnLayers[zoneIdx]) return [];
  const latlngs = drawnLayers[zoneIdx].getLatLngs()[0];
  return state.orders.filter(o => pointInLayer([o.lat, o.lng], latlngs));
}

// 按司机分配计算负载(Step 4 用)
function calcDriverMetrics(driverId, zones) {
  let allOrders = [];
  if (zones && zones.length) {
    for (const zId of zones) {
      // zId 是 1-based
      const orders = getOrdersInZone(zId - 1);
      allOrders = allOrders.concat(orders);
    }
  }
  return calcZoneMetrics(allOrders);
}

// ═══ 步骤导航 ═══
function goToStep(n) {
  document.querySelectorAll('.step').forEach((s, i) => {
    s.classList.toggle('active', i + 1 === n);
    if (i + 1 < n) s.classList.add('done'); else s.classList.remove('done');
  });
  document.querySelectorAll('.panel').forEach((p, i) => {
    p.classList.toggle('active', i + 1 === n);
  });
  if (n === 2) setTimeout(initMap, 100);
  if (n === 4) renderDriverAssign();
  if (n === 6) renderRunChecklist();
  window.scrollTo(0, 0);
}

// ═══ Step 1: 上传订单 ═══
function setupOrdersUpload() {
  const drop = document.getElementById('orders-drop');
  const input = document.getElementById('orders-file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files[0]) uploadOrders(e.dataTransfer.files[0]); });
  input.addEventListener('change', e => { if (e.target.files[0]) uploadOrders(e.target.files[0]); });
}

async function uploadOrders(file) {
  const result = document.getElementById('orders-result');
  result.innerHTML = '<p class="warn">解析中...</p>';
  document.getElementById('btn-step1-next').disabled = true;
  try {
    const b64 = await fileToBase64(file);
    const resp = await fetch(API + '/api/upload-orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, data: b64 })
    });
    const data = await resp.json();
    if (data.error) { result.innerHTML = '<p class="err">' + data.error + '</p>'; return; }
    state.orders = data.orders;
    const totalLoad = data.orders.reduce((a, o) => a + (o.load || 0), 0);
    result.innerHTML = '<p class="ok">✓ 解析成功: ' + data.total + ' 单 | 总load ' + totalLoad + '</p>';
    document.getElementById('btn-step1-next').disabled = false;
  } catch (e) {
    result.innerHTML = '<p class="err">上传失败: ' + e.message + '</p>';
  }
}

// ═══ Step 2: 地图画区域 ═══
function initMap() {
  if (map) { map.invalidateSize(); return; }
  map = L.map('map').setView([45.55, -73.65], 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'OpenStreetMap', maxZoom: 19
  }).addTo(map);

  // 显示订单点
  if (state.orders.length) {
    for (const o of state.orders) {
      const m = L.circleMarker([o.lat, o.lng], {
        radius: 4, fillColor: '#378ADD', color: '#378ADD', fillOpacity: 0.7, weight: 1
      }).addTo(map);
      m.bindPopup(o.name + (o.load ? ' (load:' + o.load + ')' : ''));
      orderMarkers.push(m);
    }
    const lats = state.orders.map(o => o.lat), lngs = state.orders.map(o => o.lng);
    map.fitBounds([[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]], { padding: [30, 30] });
  }

  // 画图工具
  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);
  drawControl = new L.Control.Draw({
    edit: { featureGroup: drawnItems, remove: true },
    draw: {
      polygon: { allowIntersection: false, showArea: false },
      rectangle: false, circle: false, circlemarker: false, polyline: false, marker: false
    }
  });
  map.addControl(drawControl);

  map.on('draw:created', e => {
    const layer = e.layer;
    drawnItems.addLayer(layer);
    drawnLayers.push(layer);
    updateZoneList();
  });
  map.on('draw:edited draw:deleted', () => updateZoneList());

  // 尝试加载上次的 GeoJSON
  fetch(API + '/api/state').then(r => r.json()).then(s => {
    if (s.hasGeojson && s.zoneCount > 0) {
      useLastGeojson();
    }
  });
}

function updateZoneList() {
  const list = document.getElementById('zone-list');
  list.innerHTML = '';
  const allMetrics = [];
  drawnLayers.forEach((layer, i) => {
    const latlngs = layer.getLatLngs()[0];
    const ordersInZone = state.orders.filter(o => pointInLayer([o.lat, o.lng], latlngs));
    const m = calcZoneMetrics(ordersInZone);
    allMetrics.push(m);
    const color = zoneColors[i % zoneColors.length];
    layer.setStyle({ color: color, fillColor: color, fillOpacity: 0.15 });

    const div = document.createElement('div');
    div.className = 'zone-metric-item';
    div.style.borderLeft = '3px solid ' + color;
    div.innerHTML =
      '<div class="zm-header"><span class="zname">Z' + (i + 1) + '</span><span class="zm-stops">' + m.stops + ' 单</span></div>' +
      '<div class="zm-grid">' +
        '<div class="zm-cell"><span class="zm-label">箱数</span><span class="zm-val">' + m.load + '</span></div>' +
        '<div class="zm-cell"><span class="zm-label">预估距离</span><span class="zm-val">' + m.estDistance + ' km</span></div>' +
        '<div class="zm-cell"><span class="zm-label">预估时间</span><span class="zm-val">' + m.estDuration + ' min</span></div>' +
      '</div>';
    list.appendChild(div);
  });

  // 显示区域间差异汇总
  if (allMetrics.length >= 2) {
    const stopVals = allMetrics.map(m => m.stops);
    const loadVals = allMetrics.map(m => m.load);
    const distVals = allMetrics.map(m => m.estDistance);
    const durVals = allMetrics.map(m => m.estDuration);
    const max = arr => Math.max(...arr);
    const min = arr => Math.min(...arr);

    const stopDiff = max(stopVals) - min(stopVals);
    const loadDiff = max(loadVals) - min(loadVals);

    const summary = document.createElement('div');
    summary.className = 'zone-diff-summary';
    let warning = '';
    if (stopDiff > 8) warning = '<span class="zm-warn">⚠ 停点数差异 ' + stopDiff + ' > 8,建议调整区域边界</span>';
    else if (loadDiff > 60) warning = '<span class="zm-warn">⚠ 箱数差异 ' + loadDiff + ' 较大,注意负载平衡</span>';
    else warning = '<span class="zm-ok">✓ 负载差异在合理范围</span>';

    summary.innerHTML =
      '<div class="zm-diff-title">区域间差异(max-min)</div>' +
      '<div class="zm-diff-row">' +
        '<span>停点: ' + stopDiff + '</span>' +
        '<span>箱数: ' + loadDiff + '</span>' +
        '<span>距离: ' + (max(distVals) - min(distVals)).toFixed(1) + ' km</span>' +
        '<span>时间: ' + (max(durVals) - min(durVals)) + ' min</span>' +
      '</div>' +
      warning;
    list.appendChild(summary);
  }
}

function pointInLayer(pt, latlngs) {
  const vs = latlngs.map(ll => [ll.lng, ll.lat]);
  const x = pt[1], y = pt[0]; let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function clearZones() {
  drawnLayers.forEach(l => l.remove());
  drawnLayers = [];
  updateZoneList();
}

function saveZones() {
  if (drawnLayers.length === 0) {
    document.getElementById('zones-result').innerHTML = '<p class="err">请先画至少一个区域</p>';
    return;
  }
  const features = drawnLayers.map((layer, i) => {
    const latlngs = layer.getLatLngs()[0];
    const coords = latlngs.map(ll => [ll.lng, ll.lat]);
    coords.push(coords[0]); // 闭合
    return { type: 'Feature', properties: { zoneId: i + 1 }, geometry: { type: 'Polygon', coordinates: [coords] } };
  });
  const geojson = { type: 'FeatureCollection', features };
  state.geojson = geojson;

  fetch(API + '/api/save-zones', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson })
  }).then(r => r.json()).then(data => {
    if (data.error) { document.getElementById('zones-result').innerHTML = '<p class="err">' + data.error + '</p>'; return; }
    document.getElementById('zones-result').innerHTML = '<p class="ok">✓ 已保存 ' + data.zoneCount + ' 个区域</p>';
    goToStep(3);
  });
}

function useLastGeojson() {
  fetch(API + '/api/result/route_plan.json').then(r => { if (!r.ok) throw new Error('no data'); return r.json(); })
    .then(plan => {
      // 从 orders_with_zones.json 获取 zone 信息 — 实际从 state 获取
    }).catch(() => {});
  // 直接从服务器获取已保存的 geojson
  fetch(API + '/api/state').then(r => r.json()).then(s => {
    if (!s.hasGeojson) return;
    // 读取 geojson 文件
    fetch(API + '/api/download/' + encodeURIComponent('区域图MTLFarMap.geojson'))
      .then(r => { if (!r.ok) throw new Error('no file'); return r.text(); })
      .then(txt => {
        const geo = JSON.parse(txt);
        if (!geo.features) return;
        clearZones();
        for (const f of geo.features) {
          const coords = f.geometry.coordinates[0];
          const latlngs = coords.map(c => [c[1], c[0]]); // [lng,lat] -> [lat,lng]
          if (latlngs.length > 1) latlngs.pop(); // 去掉闭合点
          const layer = L.polygon(latlngs, { fillOpacity: 0.15 }).addTo(map);
          drawnLayers.push(layer);
        }
        updateZoneList();
      }).catch(() => {});
  });
}

// ═══ Step 3: 上传司机 ═══
function setupDriversUpload() {
  const drop = document.getElementById('drivers-drop');
  const input = document.getElementById('drivers-file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); if (e.dataTransfer.files[0]) uploadDrivers(e.dataTransfer.files[0]); });
  input.addEventListener('change', e => { if (e.target.files[0]) uploadDrivers(e.target.files[0]); });
}

async function uploadDrivers(file) {
  const result = document.getElementById('drivers-result');
  result.innerHTML = '<p class="warn">解析中...</p>';
  document.getElementById('btn-step3-next').disabled = true;
  try {
    const b64 = await fileToBase64(file);
    const resp = await fetch(API + '/api/upload-drivers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, data: b64 })
    });
    const data = await resp.json();
    if (data.error) { result.innerHTML = '<p class="err">' + data.error + '</p>'; return; }
    state.drivers = data.drivers;
    result.innerHTML = '<p class="ok">✓ 解析成功: ' + data.drivers.length + ' 个司机</p>';
    for (const d of data.drivers) result.innerHTML += '<p style="margin-left:16px">' + d.id + ' (cap=' + d.capacity + ')</p>';
    document.getElementById('btn-step3-next').disabled = false;
  } catch (e) {
    result.innerHTML = '<p class="err">上传失败: ' + e.message + '</p>';
  }
}

// ═══ Step 4: 分配区域 ═══

function geojsonToSvgPath(coords, bbox, w, h, pad) {
  pad = pad || 4;
  const sx = (w - pad * 2) / Math.max(0.001, bbox.maxLng - bbox.minLng);
  const sy = (h - pad * 2) / Math.max(0.001, bbox.maxLat - bbox.minLat);
  const s = Math.min(sx, sy);
  const ox = pad + (w - pad * 2 - (bbox.maxLng - bbox.minLng) * s) / 2;
  const oy = pad + (h - pad * 2 - (bbox.maxLat - bbox.minLat) * s) / 2;
  return coords.map((c, i) => {
    const x = ox + (c[0] - bbox.minLng) * s;
    const y = h - (oy + (c[1] - bbox.minLat) * s);
    return (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }).join('') + 'Z';
}

function getZoneBBox(coords) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const c of coords) {
    if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
    if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
  }
  return { minLng, maxLng, minLat, maxLat };
}

function renderZoneThumbnail(driverId, selectedZones) {
  if (!state.geojson || !selectedZones.length) {
    return '<div class="zone-thumb"><div class="no-zone">机动</div></div>';
  }
  const W = 80, H = 60;
  let allCoords = [];
  const zoneColors = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#EF9F27'];
  const paths = [];
  for (const zId of selectedZones) {
    const f = state.geojson.features[zId - 1];
    if (!f) continue;
    const coords = f.geometry.coordinates[0];
    allCoords = allCoords.concat(coords);
  }
  if (!allCoords.length) return '<div class="zone-thumb"><div class="no-zone">机动</div></div>';
  const bbox = getZoneBBox(allCoords);
  const parts = [];
  for (const zId of selectedZones) {
    const f = state.geojson.features[zId - 1];
    if (!f) continue;
    const coords = f.geometry.coordinates[0].slice(0, -1);
    const p = geojsonToSvgPath(coords, bbox, W, H);
    parts.push('<path d="' + p + '" fill="' + zoneColors[(zId-1) % zoneColors.length] + '" fill-opacity="0.3" stroke="' + zoneColors[(zId-1) % zoneColors.length] + '" stroke-width="1"/>');
  }
  return '<div class="zone-thumb"><svg viewBox="0 0 ' + W + ' ' + H + '">' + parts.join('') + '</svg></div>';
}

function renderZoneOverview() {
  const div = document.getElementById('zone-overview');
  if (!state.geojson || !state.geojson.features.length) { div.innerHTML = ''; return; }
  const W = 560, H = 180;
  const zoneColors = ['#7F77DD', '#1D9E75', '#D85A30', '#378ADD', '#EF9F27', '#D4537E'];
  let allCoords = [];
  for (const f of state.geojson.features) allCoords = allCoords.concat(f.geometry.coordinates[0]);
  const bbox = getZoneBBox(allCoords);
  const parts = [];
  state.geojson.features.forEach((f, i) => {
    const zId = i + 1;
    const coords = f.geometry.coordinates[0].slice(0, -1);
    const p = geojsonToSvgPath(coords, bbox, W, H, 20);
    const color = zoneColors[i % zoneColors.length];
    parts.push('<path d="' + p + '" fill="' + color + '" fill-opacity="0.15" stroke="' + color + '" stroke-width="1.5"/>');
    const cx = coords.reduce((a, c) => a + c[0], 0) / coords.length;
    const cy = coords.reduce((a, c) => a + c[1], 0) / coords.length;
    const sx = 20 + (W - 40) * (cx - bbox.minLng) / Math.max(0.001, bbox.maxLng - bbox.minLng);
    const sy = H - (20 + (H - 40) * (cy - bbox.minLat) / Math.max(0.001, bbox.maxLat - bbox.minLat));
    let label = 'Z' + zId;
    for (const [dId, dm] of Object.entries(state.driverZoneMap || {})) {
      if (dm.zones && dm.zones.includes(zId)) label += ' → ' + dId.replace(/^MTL-/, '');
    }
    parts.push('<text x="' + sx.toFixed(0) + '" y="' + sy.toFixed(0) + '" text-anchor="middle" font-size="11" fill="' + color + '" font-weight="500">' + label + '</text>');
  });
  div.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="max-height:180px">' + parts.join('') + '</svg>';
}

function renderDriverAssign() {
  renderZoneOverview();
  const list = document.getElementById('driver-assign-list');
  list.innerHTML = '';
  const zoneCount = state.geojson ? state.geojson.features.length : 0;
  for (const d of state.drivers) {
    const row = document.createElement('div');
    row.className = 'driver-row';
    let opts = '<option value="">机动(不限区域)</option>';
    for (let z = 1; z <= zoneCount; z++) opts += '<option value="' + z + '">Z' + z + '</option>';
    const currentZones = (state.driverZoneMap[d.id] || {}).zones || [];
    const thumb = renderZoneThumbnail(d.id, currentZones);
    const m = calcDriverMetrics(d.id, currentZones);

    // 负载预测
    const overCap = m.load > d.capacity;
    const loadClass = overCap ? 'zm-load-over' : 'zm-load-ok';
    const loadWarn = overCap ? '<span class="zm-warn">⚠ 超容量 +' + (m.load - d.capacity) + '</span>' : '';

    row.innerHTML =
      thumb +
      '<div class="driver-info">' +
        '<div class="dname">' + d.id + '</div>' +
        '<div class="dcap">cap=' + d.capacity + '</div>' +
      '</div>' +
      '<select id="zone-select-' + d.id + '" multiple style="min-width:160px;height:60px" onchange="onZoneSelectChange(\'' + d.id + '\')">' + opts + '</select>' +
      '<div class="driver-metrics" id="dm-' + d.id + '">' +
        '<div class="dm-row"><span class="dm-label">单量</span><span class="dm-val">' + m.stops + '</span></div>' +
        '<div class="dm-row"><span class="dm-label">箱数</span><span class="dm-val ' + loadClass + '">' + m.load + ' / ' + d.capacity + '</span></div>' +
        '<div class="dm-row"><span class="dm-label">距离</span><span class="dm-val">' + m.estDistance + ' km</span></div>' +
        '<div class="dm-row"><span class="dm-label">时间</span><span class="dm-val">' + m.estDuration + ' min</span></div>' +
        loadWarn +
      '</div>';
    list.appendChild(row);
    const sel = document.getElementById('zone-select-' + d.id);
    for (const z of currentZones) {
      for (const opt of sel.options) if (parseInt(opt.value) === z) opt.selected = true;
    }
  }
  updateDriverDiffSummary();
}

// 更新司机间差异汇总
function updateDriverDiffSummary() {
  let existing = document.getElementById('driver-diff-summary');
  if (existing) existing.remove();

  const metrics = state.drivers.map(d => {
    const zones = (state.driverZoneMap[d.id] || {}).zones || [];
    return calcDriverMetrics(d.id, zones);
  });

  if (metrics.length < 2) return;
  const max = arr => Math.max(...arr);
  const min = arr => Math.min(...arr);
  const stopDiff = max(metrics.map(m => m.stops)) - min(metrics.map(m => m.stops));
  const loadDiff = max(metrics.map(m => m.load)) - min(metrics.map(m => m.load));
  const distDiff = max(metrics.map(m => m.estDistance)) - min(metrics.map(m => m.estDistance));
  const durDiff = max(metrics.map(m => m.estDuration)) - min(metrics.map(m => m.estDuration));

  const summary = document.createElement('div');
  summary.id = 'driver-diff-summary';
  summary.className = 'driver-diff-summary';
  let warn = '';
  if (stopDiff > 8) warn = '<span class="zm-warn">⚠ 停点数差异 ' + stopDiff + ' > 8</span>';
  else warn = '<span class="zm-ok">✓ 停点数差异 ' + stopDiff + ' (≤8)</span>';

  summary.innerHTML =
    '<div class="zm-diff-title">司机间负载差异(max-min)</div>' +
    '<div class="zm-diff-row">' +
      '<span>停点: ' + stopDiff + '</span>' +
      '<span>箱数: ' + loadDiff + '</span>' +
      '<span>距离: ' + distDiff.toFixed(1) + ' km</span>' +
      '<span>时间: ' + durDiff + ' min</span>' +
    '</div>' + warn;

  document.getElementById('driver-assign-list').appendChild(summary);
}

function onZoneSelectChange(driverId) {
  const sel = document.getElementById('zone-select-' + driverId);
  const zones = Array.from(sel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
  if (!state.driverZoneMap) state.driverZoneMap = {};
  state.driverZoneMap[driverId] = { zones };
  // 更新缩略图
  const row = sel.closest('.driver-row');
  const oldThumb = row.querySelector('.zone-thumb');
  const newThumb = document.createElement('div');
  newThumb.innerHTML = renderZoneThumbnail(driverId, zones);
  oldThumb.replaceWith(newThumb.firstChild);

  // 更新负载指标
  const d = state.drivers.find(x => x.id === driverId);
  const m = calcDriverMetrics(driverId, zones);
  const dmDiv = document.getElementById('dm-' + driverId);
  if (dmDiv && d) {
    const overCap = m.load > d.capacity;
    const loadClass = overCap ? 'zm-load-over' : 'zm-load-ok';
    const loadWarn = overCap ? '<span class="zm-warn">⚠ 超容量 +' + (m.load - d.capacity) + '</span>' : '';
    dmDiv.innerHTML =
      '<div class="dm-row"><span class="dm-label">单量</span><span class="dm-val">' + m.stops + '</span></div>' +
      '<div class="dm-row"><span class="dm-label">箱数</span><span class="dm-val ' + loadClass + '">' + m.load + ' / ' + d.capacity + '</span></div>' +
      '<div class="dm-row"><span class="dm-label">距离</span><span class="dm-val">' + m.estDistance + ' km</span></div>' +
      '<div class="dm-row"><span class="dm-label">时间</span><span class="dm-val">' + m.estDuration + ' min</span></div>' +
      loadWarn;
  }

  // 更新总览图
  renderZoneOverview();
  // 更新差异汇总
  updateDriverDiffSummary();
}

function saveDriverZones() {
  const map = {};
  for (const d of state.drivers) {
    const sel = document.getElementById('zone-select-' + d.id);
    const zones = Array.from(sel.selectedOptions).map(o => parseInt(o.value)).filter(v => !isNaN(v));
    map[d.id] = { zones };
  }
  state.driverZoneMap = map;
  fetch(API + '/api/assign-drivers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverZoneMap: map })
  }).then(r => r.json()).then(data => {
    if (data.error) { alert(data.error); return; }
    goToStep(5);
  });
}

// ═══ Step 5: 验证Token ═══
async function verifyToken() {
  const token = document.getElementById('token-input').value.trim();
  if (!token) return;
  const result = document.getElementById('token-result');
  result.innerHTML = '<p class="warn">验证中...</p>';
  document.getElementById('btn-verify').disabled = true;
  try {
    const resp = await fetch(API + '/api/verify-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await resp.json();
    if (data.valid) {
      result.innerHTML = '<p class="ok">✓ Token 有效，可以分单</p>';
      state.tokenVerified = true;
      document.getElementById('btn-step5-next').disabled = false;
    } else {
      result.innerHTML = '<p class="err">✗ ' + (data.message || 'Token 无效') + '</p>';
    }
  } catch (e) {
    result.innerHTML = '<p class="err">验证失败: ' + e.message + '</p>';
  } finally {
    document.getElementById('btn-verify').disabled = false;
  }
}

// ═══ Step 6: 一键分单 ═══
function renderRunChecklist() {
  const div = document.getElementById('run-checklist');
  const zoneCount = state.geojson ? state.geojson.features.length : 0;
  const items = [
    { label: '订单', value: state.orders.length + ' 单', ok: state.orders.length > 0 },
    { label: '区域', value: zoneCount + ' 个', ok: zoneCount > 0 },
    { label: '司机', value: state.drivers.length + ' 人', ok: state.drivers.length > 0 },
    { label: 'Token', value: state.tokenVerified ? '已验证' : '未验证', ok: state.tokenVerified }
  ];
  div.innerHTML = items.map(i => '<p style="color:' + (i.ok ? 'var(--accent)' : 'var(--danger)') + '">' + (i.ok ? '✓' : '✗') + ' ' + i.label + ': ' + i.value + '</p>').join('');
  document.getElementById('btn-run').disabled = !items.every(i => i.ok);
}

async function runPipeline() {
  const progress = document.getElementById('run-progress');
  const result = document.getElementById('run-result');
  progress.style.display = 'block';
  progress.innerHTML = '<div class="progress-msg">正在调用 Routific 分单，请稍候(约10-30秒)...</div>';
  result.innerHTML = '';
  document.getElementById('btn-run').disabled = true;
  try {
    const resp = await fetch(API + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await resp.json();
    if (data.error) {
      progress.innerHTML = '<div class="progress-msg err">分单失败: ' + data.error + '</div>';
      return;
    }
    // preCheck 警告
    let preHtml = '';
    if (data.preCheck && data.preCheck.warnings.length) {
      preHtml = data.preCheck.warnings.map(w => '<div class="progress-msg" style="color:var(--warning)">⚠ ' + w.msg + '</div>').join('');
    }

    let driverHtml = '<table class="result-table"><tr><th>司机</th><th>停点数</th><th>状态</th></tr>';
    for (const d of data.perDriver) {
      driverHtml += '<tr><td>' + d.id + '</td><td>' + (d.stopCount || 0) + '</td><td>' + (d.error ? '<span style="color:var(--danger)">' + d.error + '</span>' : '✓') + '</td></tr>';
    }
    driverHtml += '</table>';

    let unservedHtml = '';
    if (data.numUnserved > 0) unservedHtml = '<div class="progress-msg" style="color:var(--warning)">⚠ ' + data.numUnserved + ' 单未派出，见 unserved.csv</div>';

    let dlHtml = '<div class="download-links">';
    for (const f of (data.resultFiles || [])) {
      dlHtml += '<a href="/api/download/' + encodeURIComponent(f) + '" target="_blank">' + f + '</a>';
    }
    dlHtml += '</div>';

    // 下载总Solution按钮 (醒目)
    dlHtml += '<button class="btn-run" style="margin-top:16px" onclick="exportSolution()">下载总Solution CSV</button>';
    dlHtml += '<div id="export-result"></div>';

    progress.innerHTML = '<div class="progress-msg ok">✓ 分单完成! 总行驶 ' + (data.totalTravelTime || '?') + ' min | 未派 ' + data.numUnserved + ' 单</div>' + preHtml + unservedHtml;
    result.innerHTML = '<h3>分单结果</h3>' + driverHtml + dlHtml;

    // 如果有地图，嵌入 iframe
    if ((data.resultFiles || []).includes('route_map.html')) {
      result.innerHTML += '<h3 style="margin-top:16px">路线地图</h3><iframe id="map-iframe" src="/api/result/route_map.html" style="width:100%;height:500px;border:0.5px solid var(--border);border-radius:8px"></iframe>';
    }

    // 加载可编辑停点列表
    if (data.ok) loadStopList();
  } catch (e) {
    progress.innerHTML = '<div class="progress-msg err">分单失败: ' + e.message + '</div>';
  } finally {
    document.getElementById('btn-run').disabled = false;
  }
}

// ═══ 可编辑停点列表 ═══
let routeDetailData = null;
let dragSrcEl = null;

async function loadStopList() {
  try {
    const resp = await fetch(API + '/api/route-detail');
    const data = await resp.json();
    if (data.error) return;
    routeDetailData = data.drivers;
    renderStopList();
    document.getElementById('adjust-area').style.display = 'block';
  } catch (e) { console.error('loadStopList:', e); }
}

function renderStopList() {
  const container = document.getElementById('stop-list-container');
  if (!routeDetailData || !routeDetailData.length) { container.innerHTML = '<p class="hint">无路线数据</p>'; return; }
  const colors = { 'MTL-Tony': '#e41a1c', 'MTL-Faouzi': '#377eb8', 'MTL-Luke': '#4daf4a' };
  let html = '';
  for (const d of routeDetailData) {
    const color = colors[d.id] || '#333';
    html += '<div class="driver-stop-group" data-driver="' + d.id + '">';
    html += '<div class="driver-stop-header" style="border-left:4px solid ' + color + '"><b>' + d.id + '</b> (' + d.stops.length + ' 单)</div>';
    html += '<div class="stop-list" data-driver="' + d.id + '">';
    d.stops.forEach((s, i) => {
      html += '<div class="stop-row" draggable="true" data-driver="' + d.id + '" data-idx="' + i + '">';
      html += '<span class="stop-num" style="background:' + color + '">' + (i + 1) + '</span>';
      html += '<span class="stop-id">' + s.location_id + '</span>';
      html += '<span class="stop-addr">' + (s.address || '').slice(0, 40) + '</span>';
      html += '<span class="stop-time">' + (s.arrival_time || '?') + '-' + (s.finish_time || '?') + '</span>';
      html += '<span class="stop-dur">' + (s.duration || 0) + 'min</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }
  container.innerHTML = html;
  // 绑定拖拽事件
  container.querySelectorAll('.stop-row').forEach(row => {
    row.addEventListener('dragstart', onDragStart);
    row.addEventListener('dragover', onDragOver);
    row.addEventListener('drop', onDrop);
    row.addEventListener('dragend', onDragEnd);
  });
}

function onDragStart(e) {
  dragSrcEl = this;
  this.style.opacity = '0.4';
  e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (this !== dragSrcEl) this.style.borderTop = '2px solid #0f6e56';
}
function onDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  if (dragSrcEl && dragSrcEl !== this) {
    const srcDriver = dragSrcEl.dataset.driver;
    const tgtDriver = this.dataset.driver;
    if (srcDriver !== tgtDriver) return; // 不允许跨司机拖拽
    const list = this.parentNode;
    const srcIdx = Array.from(list.children).indexOf(dragSrcEl);
    const tgtIdx = Array.from(list.children).indexOf(this);
    if (srcIdx < tgtIdx) list.insertBefore(dragSrcEl, this.nextSibling);
    else list.insertBefore(dragSrcEl, this);
    renumberStops(list);
  }
  this.style.borderTop = '';
}
function onDragEnd() {
  document.querySelectorAll('.stop-row').forEach(r => { r.style.opacity = ''; r.style.borderTop = ''; });
  dragSrcEl = null;
}
function renumberStops(list) {
  list.querySelectorAll('.stop-row').forEach((row, i) => {
    row.querySelector('.stop-num').textContent = i + 1;
    row.dataset.idx = i;
  });
}

async function saveAdjustedPlan() {
  const result = document.getElementById('adjust-result');
  if (result) result.innerHTML = '<p class="warn">保存中...</p>';
  try {
    const adjustedDrivers = routeDetailData.map(d => {
      const list = document.querySelector('.stop-list[data-driver="' + d.id + '"]');
      const ids = list ? Array.from(list.querySelectorAll('.stop-row')).map(r => r.querySelector('.stop-id').textContent) : d.stops.map(s => s.location_id);
      return { id: d.id, stops: ids };
    });
    const resp = await fetch(API + '/api/update-plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drivers: adjustedDrivers })
    });
    const data = await resp.json();
    if (data.error) { if (result) result.innerHTML = '<p class="err">' + data.error + '</p>'; return; }
    if (result) result.innerHTML = '<p class="ok">✓ ' + data.message + '</p>';
    // 刷新地图 iframe
    const iframe = document.getElementById('map-iframe');
    if (iframe) iframe.src = '/api/result/route_map.html?t=' + Date.now();
    // 重新加载停点列表(更新时间)
    await loadStopList();
  } catch (e) {
    if (result) result.innerHTML = '<p class="err">保存失败: ' + e.message + '</p>';
  }
}

// ═══ 导出总Solution ═══
async function exportSolution() {
  const result = document.getElementById('export-result') || document.getElementById('adjust-result');
  if (result) result.innerHTML = '<p class="warn">生成中...</p>';
  try {
    const resp = await fetch(API + '/api/export-solution', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await resp.json();
    if (data.error) {
      if (result) result.innerHTML = '<p class="err">' + data.error + '</p>';
      return;
    }
    if (result) result.innerHTML = '<p class="ok">✓ 已生成 (' + data.rows + ' 行)</p>';
    // 触发下载
    window.open(API + '/api/download/solution_all.csv', '_blank');
  } catch (e) {
    if (result) result.innerHTML = '<p class="err">导出失败: ' + e.message + '</p>';
  }
}

// ═══ 工具函数 ═══
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const b64 = r.result.split(',')[1]; resolve(b64); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ═══ 初始化 ═══
setupOrdersUpload();
setupDriversUpload();
