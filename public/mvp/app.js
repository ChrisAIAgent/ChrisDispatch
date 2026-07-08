// ChrisDispatch MVP - 纯前端: 上传 -> 画区 -> 看统计
(function () {
  'use strict';

  const WAREHOUSE = { lat: 45.396, lng: -73.515, name: "25 Av. d'Inverness, Candiac" };
  const LS_KEY = 'mtl-mvp-v1';
  const COL_ALIASES = {
    lat: ['lat', 'latitude', '纬度'],
    lng: ['lng', 'lon', 'long', 'longitude', '经度'],
    // 注意：不含 qty/quantity，避免误匹配 "Pork Qty" 等产品特定列
    boxes: ['boxes', 'box', 'parcels', 'parcel', 'cartons', 'carton', 'units', 'unit', 'load', '负载', '件数', '箱数', '数量'],
    duration: ['duration', 'time', 'mins', 'minutes', '时长', '时间', '配送时间'],
    address: ['address', 'street', 'addr', '地址', '收件地址'],
    city: ['city', 'town', '城市'],
  };
  const ZONE_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#16a085','#c0392b'];

  const state = { rows: [], headers: [], points: [], polygons: [], zonePoints: new Map(), colMap: { lat: -1, lng: -1, boxes: -1, duration: -1, address: -1, city: -1 } };
  let map, drawnItems, pointLayer, nextZoneId = 1;

  const $ = id => document.getElementById(id);
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
  }
  function findCol(headers, aliases) {
    const lower = headers.map(h => String(h || '').trim().toLowerCase());
    for (const a of aliases) { const i = lower.indexOf(a.toLowerCase()); if (i >= 0) return i; }
    for (const a of aliases) { const i = lower.findIndex(h => h.includes(a.toLowerCase())); if (i >= 0) return i; }
    return -1;
  }
  // 健壮的箱数解析: 处理千分位逗号、空格、空白值、负数
  function parseBoxCount(val) {
    if (val == null) return null;
    const s = String(val).trim().replace(/[,\s_]/g, '');
    if (!s) return null;
    const n = parseFloat(s);
    return isFinite(n) && n >= 0 ? n : null;
  }
  function pointInPolygon(pt, ring) {
    const x = pt.lng, y = pt.lat;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][1], yi = ring[i][0];
      const xj = ring[j][1], yj = ring[j][0];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function autoDetect(headers) {
    const raw = {
      lat: findCol(headers, COL_ALIASES.lat),
      lng: findCol(headers, COL_ALIASES.lng),
      boxes: findCol(headers, COL_ALIASES.boxes),
      duration: findCol(headers, COL_ALIASES.duration),
      address: findCol(headers, COL_ALIASES.address),
      city: findCol(headers, COL_ALIASES.city),
    };
    // 智能降级：若匹配到的 boxes 列有效率 <50%，自动放弃（如 "Pork Qty" 大部分为空）
    if (raw.boxes >= 0 && state.rows.length > 1) {
      let valid = 0, total = 0;
      for (let i = 1; i < state.rows.length; i++) {
        total++;
        if (parseBoxCount(state.rows[i][raw.boxes]) != null) valid++;
      }
      if (total > 0 && valid / total < 0.5) {
        console.warn(`[autoDetect] 箱数列 "${headers[raw.boxes]}" 有效率仅 ${(valid / total * 100).toFixed(0)}% (<50%)，自动放弃`);
        raw.boxes = -1;
      }
    }
    return raw;
  }

  function fillSelect(sel, headers, selected, allowNone) {
    sel.innerHTML = '';
    if (allowNone) sel.appendChild(new Option('(不使用)', '-1'));
    headers.forEach((h, i) => sel.appendChild(new Option(h || `(列${i + 1})`, String(i))));
    sel.value = String(selected);
  }

  function buildColMapUI() {
    const headers = state.headers;
    fillSelect($('map-lat'), headers, state.colMap.lat, false);
    fillSelect($('map-lng'), headers, state.colMap.lng, false);
    fillSelect($('map-boxes'), headers, state.colMap.boxes, true);
    fillSelect($('map-duration'), headers, state.colMap.duration, true);
    fillSelect($('map-addr'), headers, state.colMap.address, true);
    fillSelect($('map-city'), headers, state.colMap.city, true);
    $('col-map').style.display = 'block';
  }

  async function handleFile(file) {
    $('file-status').textContent = `解析中: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    try {
      const buf = await file.arrayBuffer();
      const rows = await readXlsxFromArrayBuffer(buf);
      if (rows.length < 2) throw new Error('文件为空或只有表头');
      const headers = rows[0].map(h => String(h || '').trim());
      state.rows = rows; state.headers = headers;
      state.colMap = autoDetect(headers);
      buildColMapUI();
      applyMapping();
    } catch (err) {
      $('file-status').textContent = '❌ ' + err.message;
      console.error(err);
    }
  }

  function applyMapping() {
    const headers = state.headers, rows = state.rows;
    const latIdx = state.colMap.lat, lngIdx = state.colMap.lng;
    const boxesIdx = state.colMap.boxes, durationIdx = state.colMap.duration;
    const addrIdx = state.colMap.address, cityIdx = state.colMap.city;
    if (latIdx < 0 || lngIdx < 0) {
      $('file-status').textContent = '⚠️ 请在下方手动选择 纬度/经度 列';
      return;
    }
    const points = []; let skipped = 0;
    const boxValues = []; let missingBoxes = 0;
    const durValues = []; let missingDur = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const lat = parseFloat(r[latIdx]), lng = parseFloat(r[lngIdx]);
      if (!isFinite(lat) || !isFinite(lng)) { skipped++; continue; }
      const boxRaw = boxesIdx >= 0 ? r[boxesIdx] : null;
      const boxVal = parseBoxCount(boxRaw);
      if (boxesIdx >= 0 && boxVal == null) missingBoxes++;
      else if (boxVal != null) boxValues.push(boxVal);
      const durRaw = durationIdx >= 0 ? r[durationIdx] : null;
      const durVal = parseBoxCount(durRaw);
      if (durationIdx >= 0 && durVal == null) missingDur++;
      else if (durVal != null) durValues.push(durVal);
      points.push({
        lat, lng,
        boxes: boxVal != null ? boxVal : 1,
        duration: durVal != null ? durVal : 0,
        address: addrIdx >= 0 ? String(r[addrIdx] || '') : '',
        city: cityIdx >= 0 ? String(r[cityIdx] || '') : '',
        rowIdx: i,
      });
    }
    state.points = points;

    const totalBoxes = points.reduce((s, p) => s + p.boxes, 0);
    const totalDur = points.reduce((s, p) => s + p.duration, 0);
    const stats = boxValues.length ? {
      min: Math.min(...boxValues), max: Math.max(...boxValues),
      avg: boxValues.reduce((a, b) => a + b, 0) / boxValues.length,
      unique: new Set(boxValues).size, sample: boxValues.slice(0, 8),
    } : null;
    const durStats = durValues.length ? {
      min: Math.min(...durValues), max: Math.max(...durValues),
      avg: durValues.reduce((a, b) => a + b, 0) / durValues.length,
    } : null;

    $('file-status').textContent = `✅ 已加载 ${points.length} 个停点(跳过 ${skipped} 行无效数据)`;

    let statsHtml = '';
    if (stats) {
      statsHtml =
        `<div><b>箱数分布:</b> 最小=${stats.min}, 最大=${stats.max}, ` +
        `平均=${stats.avg.toFixed(2)}, 唯一值数=${stats.unique}</div>` +
        `<div><b>样本前 8:</b> [${stats.sample.join(', ')}]</div>`;
    } else {
      statsHtml = `<div style="color:#6c757d; font-size:11px;">未指定箱数列，每单按 <b>1 箱</b> 计算（如需箱数列请手动选择）</div>`;
    }
    if (missingBoxes > 0) {
      statsHtml += `<div style="color:#e67e22"><b>⚠️ 缺失/无效 ${missingBoxes} 行(已按默认 1 计)</b></div>`;
    }
    if (durStats) {
      statsHtml += `<div><b>时长分布:</b> 最小=${durStats.min}, 最大=${durStats.max}, 平均=${durStats.avg.toFixed(1)} 分</div>`;
    } else {
      statsHtml += `<div style="color:#6c757d; font-size:11px;">未指定时长列，时长按 0 计</div>`;
    }
    if (missingDur > 0) {
      statsHtml += `<div style="color:#e67e22"><b>⚠️ 时长缺失/无效 ${missingDur} 行(已按 0 计)</b></div>`;
    }

    $('file-info').innerHTML =
      `<div><b>当前列映射:</b> 纬度=${esc(headers[latIdx])}, 经度=${esc(headers[lngIdx])}, ` +
      `箱数=${esc(boxesIdx >= 0 ? headers[boxesIdx] : '未选(默认1)')}, ` +
      `时长=${esc(durationIdx >= 0 ? headers[durationIdx] : '未选')}, ` +
      `地址=${esc(addrIdx >= 0 ? headers[addrIdx] : '未选')}</div>` +
      `<div><b>总箱数:</b> ${totalBoxes} &nbsp; <b>总时长:</b> ${totalDur.toFixed(1)} 分</div>` +
      statsHtml;
    renderPoints();
    recomputeZones();
  }
  function esc(s) { return String(s || '').replace(/[<>"]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([WAREHOUSE.lat, WAREHOUSE.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    drawnItems = new L.FeatureGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);

    L.marker([WAREHOUSE.lat, WAREHOUSE.lng], {
      icon: L.divIcon({ className: 'warehouse-icon', html: '<b>🏭</b>', iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).addTo(map).bindPopup(`<b>仓库</b><br>${WAREHOUSE.name}`);

    map.on('draw:created', e => {
      if (e.layerType !== 'polygon') return;
      const layer = e.layer;
      const id = nextZoneId++;
      const color = ZONE_COLORS[(id - 1) % ZONE_COLORS.length];
      layer.setStyle({ color, fillColor: color, fillOpacity: 0.4, weight: 3 });
      drawnItems.addLayer(layer);
      const latlngs = layer.getLatLngs()[0].map(p => [p.lat, p.lng]);
      state.polygons.push({ id, name: `Z${id}`, color, layer, geom: latlngs });
      recomputeZones();
      saveToStorage();
    });
    map.on('draw:edited', () => {
      state.polygons.forEach(p => {
        p.geom = p.layer.getLatLngs()[0].map(q => [q.lat, q.lng]);
      });
      recomputeZones();
      saveToStorage();
    });
    map.on('draw:deleted', e => {
      e.layers.eachLayer(layer => {
        const idx = state.polygons.findIndex(p => p.layer === layer);
        if (idx >= 0) state.polygons.splice(idx, 1);
      });
      recomputeZones();
      saveToStorage();
    });

    const drawControl = new L.Control.Draw({
      edit: { featureGroup: drawnItems, remove: true },
      draw: {
        polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#2980d9', weight: 3 } },
        polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false,
      },
    });
    map.addControl(drawControl);
  }

  function renderPoints() {
    pointLayer.clearLayers();
    state.points.forEach((p, i) => {
      const m = L.circleMarker([p.lat, p.lng], { radius: 6, color: '#1a2533', fillColor: '#2980d9', fillOpacity: 1.0, weight: 2 });
      m.bindPopup(
        `<b>#${i + 1}</b> 箱数: ${p.boxes}` +
        (p.duration ? ` &nbsp; 时长: ${p.duration} 分` : '') +
        (p.address ? `<br>${esc(p.address)}` : '') +
        (p.city ? `<br>${esc(p.city)}` : '')
      );
      pointLayer.addLayer(m);
    });
  }
  function recomputeZones() {
    state.zonePoints.clear();
    state.polygons.forEach(p => state.zonePoints.set(p.id, []));
    state.points.forEach((p, i) => {
      for (const poly of state.polygons) {
        if (pointInPolygon(p, poly.geom)) { state.zonePoints.get(poly.id).push(i); break; }
      }
    });
    paintPointColors();
    renderZonePanel();
  }
  function paintPointColors() {
    pointLayer.eachLayer(m => {
      let color = '#2980d9', radius = 6;
      const idx = state.points.findIndex(p => p.lat === m.getLatLng().lat && p.lng === m.getLatLng().lng);
      if (idx < 0) return;
      for (const poly of state.polygons) {
        if (state.zonePoints.get(poly.id).includes(idx)) { color = poly.color; radius = 8; break; }
      }
      m.setStyle({ fillColor: color, color: '#1a2533', radius, fillOpacity: 1.0, weight: 2 });
    });
  }

  function renderZonePanel() {
    const panel = $('zone-panel');
    panel.innerHTML = '';
    if (!state.polygons.length) {
      panel.appendChild(el('div', { class: 'hint' }, '在地图上点击多边形工具 🔺 画第一个区域'));
      return;
    }
    state.polygons.forEach(poly => {
      const ptIdxs = state.zonePoints.get(poly.id) || [];
      const stopCount = ptIdxs.length;
      const boxCount = ptIdxs.reduce((s, i) => s + state.points[i].boxes, 0);
      const durCount = ptIdxs.reduce((s, i) => s + state.points[i].duration, 0);
      const card = el('div', { class: 'zone-card', style: `border-left: 4px solid ${poly.color}` },
        el('div', { class: 'zone-title' },
          el('span', { class: 'zone-id' }, poly.name),
          el('button', { class: 'btn-mini', onclick: () => renameZone(poly.id) }, '✏️'),
          el('button', { class: 'btn-mini danger', onclick: () => deleteZone(poly.id) }, '🗑️'),
        ),
        el('div', { class: 'zone-stats' },
          el('div', null, '停点 ', el('b', null, String(stopCount))),
          el('div', null, '箱数 ', el('b', null, String(boxCount))),
          el('div', null, '时长 ', el('b', null, `${durCount.toFixed(0)} 分`)),
        ),
      );
      panel.appendChild(card);
    });
    const totals = computeTotals();
    panel.appendChild(el('div', { class: 'zone-summary' },
      el('div', null, '已覆盖 ', el('b', null, `${totals.coveredStops}/${totals.totalStops}`), ' 停点'),
      el('div', null, '已覆盖 ', el('b', null, `${totals.coveredBoxes}/${totals.totalBoxes}`), ' 箱'),
      el('div', null, '已覆盖 ', el('b', null, `${totals.coveredDur.toFixed(0)}/${totals.totalDur.toFixed(0)}`), ' 分'),
    ));
  }

  function computeTotals() {
    const covered = new Set(); let coveredBoxes = 0, coveredDur = 0;
    for (const idxs of state.zonePoints.values()) {
      idxs.forEach(i => covered.add(i));
      idxs.forEach(i => { coveredBoxes += state.points[i].boxes; coveredDur += state.points[i].duration; });
    }
    return {
      coveredStops: covered.size,
      totalStops: state.points.length,
      coveredBoxes,
      totalBoxes: state.points.reduce((s, p) => s + p.boxes, 0),
      coveredDur,
      totalDur: state.points.reduce((s, p) => s + p.duration, 0),
    };
  }

  function renameZone(id) {
    const poly = state.polygons.find(p => p.id === id);
    if (!poly) return;
    const name = prompt('区域名称', poly.name);
    if (name && name.trim()) { poly.name = name.trim(); renderZonePanel(); saveToStorage(); }
  }
  function deleteZone(id) {
    if (!confirm('删除该区域?')) return;
    const idx = state.polygons.findIndex(p => p.id === id);
    if (idx < 0) return;
    map.removeLayer(state.polygons[idx].layer);
    state.polygons.splice(idx, 1);
    recomputeZones();
    saveToStorage();
  }
  function clearAll() {
    if (!confirm('清空所有已画的区域?')) return;
    state.polygons.forEach(p => map.removeLayer(p.layer));
    state.polygons = [];
    recomputeZones();
    saveToStorage();
  }
  function exportGeoJSON() {
    if (!state.polygons.length) { alert('没有可导出的区域'); return; }
    const features = state.polygons.map(p => ({
      type: 'Feature',
      properties: {
        id: p.id, name: p.name, color: p.color,
        stops: (state.zonePoints.get(p.id) || []).length,
        boxes: (state.zonePoints.get(p.id) || []).reduce((s, i) => s + state.points[i].boxes, 0),
      },
      geometry: { type: 'Polygon', coordinates: [p.geom.map(([la, ln]) => [ln, la])] },
    }));
    const blob = new Blob([JSON.stringify({ type: 'FeatureCollection', features }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `mtl-zones-${Date.now()}.geojson`; a.click();
    URL.revokeObjectURL(url);
  }

  function saveToStorage() {
    const data = {
      polygons: state.polygons.map(p => ({ id: p.id, name: p.name, color: p.color, geom: p.geom })),
      nextZoneId,
    };
    try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
  }
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY); if (!raw) return;
      const data = JSON.parse(raw);
      nextZoneId = data.nextZoneId || 1;
      (data.polygons || []).forEach(p => {
        const layer = L.polygon(p.geom, { color: p.color, fillColor: p.color, fillOpacity: 0.4, weight: 3 });
        drawnItems.addLayer(layer);
        state.polygons.push({ id: p.id, name: p.name, color: p.color, layer, geom: p.geom });
      });
      recomputeZones();
    } catch (e) { console.warn('load storage failed', e); }
  }

  window.addEventListener('DOMContentLoaded', () => {
    initMap();
    loadFromStorage();
    $('file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); });
    $('btn-clear').addEventListener('click', clearAll);
    $('btn-export').addEventListener('click', exportGeoJSON);
    const MAP_KEYS = { 'map-lat': 'lat', 'map-lng': 'lng', 'map-boxes': 'boxes', 'map-duration': 'duration', 'map-addr': 'address', 'map-city': 'city' };
    Object.entries(MAP_KEYS).forEach(([selId, key]) => {
      $(selId).addEventListener('change', e => { state.colMap[key] = parseInt(e.target.value, 10); applyMapping(); });
    });
  });
})();
