// ChrisDispatch MVP - 纯前端: 上传 -> 画区 -> 看统计
(function () {
  'use strict';

  const WAREHOUSE = { lat: 45.396, lng: -73.515, name: "25 Av. d'Inverness, Candiac" };
  const LS_KEY = 'mtl-mvp-v1';
  const COL_ALIASES = {
    lat: ['lat', 'latitude', '纬度'],
    lng: ['lng', 'lon', 'long', 'longitude', '经度'],
    boxes: ['boxes', 'box', 'parcels', 'parcel', 'qty', 'quantity', '件数', '箱数', '数量'],
    address: ['address', 'street', 'addr', '地址', '收货地址'],
    city: ['city', 'town', '城市'],
  };
  const ZONE_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#34495e','#16a085','#c0392b'];

  const state = { rows: [], headers: [], points: [], polygons: [], zonePoints: new Map() };
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

  async function handleFile(file) {
    $('file-status').textContent = `解析中: ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
    try {
      const buf = await file.arrayBuffer();
      const rows = await readXlsxFromArrayBuffer(buf);
      if (rows.length < 2) throw new Error('文件为空或只有表头');
      const headers = rows[0].map(h => String(h || '').trim());
      const latIdx = findCol(headers, COL_ALIASES.lat);
      const lngIdx = findCol(headers, COL_ALIASES.lng);
      const boxesIdx = findCol(headers, COL_ALIASES.boxes);
      const addrIdx = findCol(headers, COL_ALIASES.address);
      const cityIdx = findCol(headers, COL_ALIASES.city);
      if (latIdx < 0 || lngIdx < 0) throw new Error(`未找到 lat/lng 列。识别到的列: [${headers.join(', ')}]`);

      const points = []; let skipped = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const lat = parseFloat(r[latIdx]), lng = parseFloat(r[lngIdx]);
        if (!isFinite(lat) || !isFinite(lng)) { skipped++; continue; }
        points.push({
          lat, lng,
          boxes: boxesIdx >= 0 ? (parseFloat(r[boxesIdx]) || 1) : 1,
          address: addrIdx >= 0 ? String(r[addrIdx] || '') : '',
          city: cityIdx >= 0 ? String(r[cityIdx] || '') : '',
          rowIdx: i,
        });
      }
      state.rows = rows; state.headers = headers; state.points = points;

      const totalBoxes = points.reduce((s, p) => s + p.boxes, 0);
      $('file-status').textContent = `✅ 已加载 ${points.length} 个停点(跳过 ${skipped} 行无效数据)`;
      $('file-info').innerHTML =
        `<div><b>列识别:</b> lat=${esc(headers[latIdx])}, lng=${esc(headers[lngIdx])}, ` +
        `boxes=${esc(headers[boxesIdx] || '未识别(默认1)')}, address=${esc(headers[addrIdx] || '未识别')}</div>` +
        `<div><b>总箱数:</b> ${totalBoxes}</div>`;
      renderPoints();
      recomputeZones();
    } catch (err) {
      $('file-status').textContent = '❌ ' + err.message;
      console.error(err);
    }
  }
  function esc(s) { return String(s || '').replace(/[<>"]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function initMap() {
    map = L.map('map', { preferCanvas: true }).setView([WAREHOUSE.lat, WAREHOUSE.lng], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap', maxZoom: 19 }).addTo(map);
    drawnItems = new L.FeatureGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);

    L.marker([WAREHOUSE.lat, WAREHOUSE.lng], {
      icon: L.divIcon({ className: 'warehouse-icon', html: '<b>🏭</b>', iconSize: [24, 24] })
    }).addTo(map).bindPopup(`<b>仓库</b><br>${WAREHOUSE.name}`);

    map.addControl(new L.Control.Draw({
      edit: { featureGroup: drawnItems, remove: true },
      draw: {
        polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#e74c3c', weight: 2 } },
        polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false,
      }
    }));

    map.on(L.Draw.Event.CREATED, onPolygonCreated);
    map.on(L.Draw.Event.EDITED, onPolygonsEdited);
    map.on(L.Draw.Event.DELETED, onPolygonsDeleted);

    loadFromStorage();
  }

  function renderPoints() {
    pointLayer.clearLayers();
    if (!state.points.length) return;
    const markers = state.points.map((p, i) => {
      const m = L.circleMarker([p.lat, p.lng], { radius: 4, color: '#2c3e50', fillColor: '#3498db', fillOpacity: 0.7, weight: 1 });
      m.bindTooltip(`${i+1}. ${p.address || ''}<br>${p.city || ''}<br>📦 ${p.boxes} 箱`, { sticky: true });
      m._pointIdx = i;
      return m;
    });
    markers.forEach(m => m.addTo(pointLayer));
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.1));
  }

  function onPolygonCreated(e) {
    const layer = e.layer;
    const color = ZONE_COLORS[state.polygons.length % ZONE_COLORS.length];
    layer.setStyle({ color, fillColor: color, fillOpacity: 0.2, weight: 2 });
    const id = `Z${nextZoneId++}`;
    const latlngs = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
    drawnItems.addLayer(layer);
    state.polygons.push({ id, name: id, color, layer, geom: latlngs });
    recomputeZones();
    saveToStorage();
  }
  function onPolygonsEdited(e) {
    e.layers.eachLayer(layer => {
      const poly = state.polygons.find(p => p.layer === layer);
      if (poly) poly.geom = layer.getLatLngs()[0].map(ll => [ll.lat, ll.lng]);
    });
    recomputeZones();
    saveToStorage();
  }
  function onPolygonsDeleted(e) {
    e.layers.eachLayer(layer => {
      const idx = state.polygons.findIndex(p => p.layer === layer);
      if (idx >= 0) state.polygons.splice(idx, 1);
    });
    recomputeZones();
    saveToStorage();
  }

  function recomputeZones() {
    state.zonePoints.clear();
    state.polygons.forEach(p => state.zonePoints.set(p.id, []));
    state.points.forEach((pt, i) => {
      for (const poly of state.polygons) {
        if (pointInPolygon(pt, poly.geom)) { state.zonePoints.get(poly.id).push(i); break; }
      }
    });
    renderZonePanel();
    highlightPoints();
  }

  function highlightPoints() {
    pointLayer.eachLayer(m => {
      const i = m._pointIdx;
      let color = '#3498db', radius = 4;
      for (const poly of state.polygons) {
        if (state.zonePoints.get(poly.id).includes(i)) { color = poly.color; radius = 5; break; }
      }
      m.setStyle({ fillColor: color, color: '#2c3e50', radius, fillOpacity: 0.85, weight: 1 });
    });
  }

  function renderZonePanel() {
    const panel = $('zone-panel');
    panel.innerHTML = '';
    if (!state.polygons.length) {
      panel.appendChild(el('div', { class: 'hint' }, '在地图上点击多边形工具 📐 画第一个区域'));
      return;
    }
    const totals = computeTotals();
    state.polygons.forEach(poly => {
      const ptIdxs = state.zonePoints.get(poly.id) || [];
      const stopCount = ptIdxs.length;
      const boxCount = ptIdxs.reduce((s, i) => s + state.points[i].boxes, 0);
      const card = el('div', { class: 'zone-card', style: `border-left: 4px solid ${poly.color}` },
        el('div', { class: 'zone-title' },
          el('span', { class: 'zone-id' }, poly.name),
          el('button', { class: 'btn-mini', onclick: () => renameZone(poly.id) }, '✏️'),
          el('button', { class: 'btn-mini danger', onclick: () => deleteZone(poly.id) }, '🗑'),
        ),
        el('div', { class: 'zone-stats' },
          el('div', null, '停点 ', el('b', null, String(stopCount))),
          el('div', null, '箱数 ', el('b', null, String(boxCount))),
        ),
      );
      panel.appendChild(card);
    });
    panel.appendChild(el('div', { class: 'zone-summary' },
      el('div', null, '已覆盖 ', el('b', null, `${totals.coveredStops}/${totals.totalStops}`), ' 停点'),
      el('div', null, '已覆盖 ', el('b', null, `${totals.coveredBoxes}/${totals.totalBoxes}`), ' 箱'),
    ));
  }

  function computeTotals() {
    const covered = new Set(); let coveredBoxes = 0;
    for (const idxs of state.zonePoints.values()) {
      idxs.forEach(i => covered.add(i));
      idxs.forEach(i => coveredBoxes += state.points[i].boxes);
    }
    return {
      coveredStops: covered.size,
      totalStops: state.points.length,
      coveredBoxes,
      totalBoxes: state.points.reduce((s, p) => s + p.boxes, 0),
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
        const layer = L.polygon(p.geom, { color: p.color, fillColor: p.color, fillOpacity: 0.2, weight: 2 });
        drawnItems.addLayer(layer);
        state.polygons.push({ id: p.id, name: p.name, color: p.color, layer, geom: p.geom });
      });
      recomputeZones();
    } catch (e) { console.warn('load storage failed', e); }
  }

  window.addEventListener('DOMContentLoaded', () => {
    initMap();
    $('file-input').addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); });
    $('btn-clear').addEventListener('click', clearAll);
    $('btn-export').addEventListener('click', exportGeoJSON);
  });
})();