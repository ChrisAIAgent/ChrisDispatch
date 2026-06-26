// server.js — MTL远线分单 本地Web应用后端
// 启动: node server.js  (浏览器打开 http://localhost:3000)
// 复用 work/ 下全部逻辑: xlsx-reader / parse-drivers / assign-zones / pipeline / build-map
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = __dirname;
const WORK = path.join(ROOT, 'work');
const OUT_DIR = path.join(WORK, 'output');
const INBOX = path.join(WORK, 'inbox');
const CONFIG_DIR = path.join(WORK, 'config');

const { readXlsx, cleanup, detectType, cell } = require(path.join(WORK, 'lib', 'xlsx-reader.js'));
const { parseDrivers } = require(path.join(WORK, 'scripts', 'parse-drivers.js'));
const { assignZones } = require(path.join(WORK, 'scripts', 'assign-zones.js'));
const { runPipeline, routificCall } = require(path.join(WORK, 'scripts', 'pipeline.js'));
const { buildMap } = require(path.join(WORK, 'scripts', 'build-map.js'));

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ── 会话状态 (本地单用户, 内存维护) ──
const state = {
  orders: null,       // [{name, lat, lng, address, ...}]
  geojson: null,      // { type:'FeatureCollection', features:[...] }
  drivers: null,      // [{id, nickname, capacity, ...}]
  driverZoneMap: null,// { 'MTL-Tony': {zones:[1]}, ... }
  token: null,        // Routific token (验证通过后存内存)
  tokenVerified: false
};

function ensureDirs() {
  for (const d of [INBOX, CONFIG_DIR, OUT_DIR]) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
}
ensureDirs();

// ── 工具: base64 写临时文件 ──
function b64toFile(b64, filename) {
  const buf = Buffer.from(b64, 'base64');
  const tmp = path.join(INBOX, filename);
  fs.writeFileSync(tmp, buf);
  return tmp;
}

// ═══ API ═══

// 1. 上传订单 xlsx → 解析返回订单点
app.post('/api/upload-orders', (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!data) return res.status(400).json({ error: '缺少文件数据' });
    const fpath = b64toFile(data, filename || 'orders.xlsx');
    const { headers, rows, tmpDir } = readXlsx(fpath);
    const type = detectType(headers);
    if (type !== 'orders') {
      cleanup(tmpDir);
      return res.status(400).json({ error: '不是订单表(缺少 Name/Address/lng/lat 列)' });
    }
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
        internalNotes: String(cell(r, headers, 'Internal Notes') || ''),
        paymentType: String(cell(r, headers, 'Payment Type') || ''),
        gift: String(cell(r, headers, '赠品') || ''),
        sizeCount: String(cell(r, headers, '大小件数量') || ''),
        ordersField: String(cell(r, headers, 'Orders') || '')
      });
    }
    cleanup(tmpDir);
    state.orders = orders;
    res.json({ total: orders.length, orders: orders.map(o => ({ name: o.name, lat: o.lat, lng: o.lng, load: o.load, ref: o.ref })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. 保存区域 GeoJSON (前端地图画的)
app.post('/api/save-zones', (req, res) => {
  try {
    const { geojson } = req.body;
    if (!geojson || !geojson.features) return res.status(400).json({ error: 'GeoJSON 格式错误' });
    state.geojson = geojson;
    // 同时写文件(供 assign-zones 和 build-map 复用)
    const geoPath = path.join(WORK, 'Mtl远线分单', '区域图MTLFarMap.geojson');
    fs.writeFileSync(geoPath, JSON.stringify(geojson, null, 2));
    const zoneCount = geojson.features.length;
    res.json({ ok: true, zoneCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3. 上传司机 xlsx → 解析返回司机列表
app.post('/api/upload-drivers', (req, res) => {
  try {
    const { filename, data } = req.body;
    if (!data) return res.status(400).json({ error: '缺少文件数据' });
    const fpath = b64toFile(data, filename || 'drivers.xlsx');
    const { headers, rows, tmpDir } = readXlsx(fpath);
    const type = detectType(headers);
    if (type !== 'drivers') {
      cleanup(tmpDir);
      return res.status(400).json({ error: '不是司机表(缺少 Driver Name/Shift Start 列)' });
    }
    const drivers = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const name = String(cell(r, headers, 'Driver Name') || '').trim();
      if (!name) continue;
      drivers.push({
        id: name,
        nickname: name.replace(/^[A-Z]+-/, '') || name,
        capacity: Number(cell(r, headers, 'Capacity')) || 220,
        shiftStart: String(cell(r, headers, 'Shift Start') || ''),
        shiftEnd: String(cell(r, headers, 'Shift End') || '')
      });
    }
    cleanup(tmpDir);
    state.drivers = drivers;
    // 默认司机→区域映射: 先全空(机动), 前端会改
    state.driverZoneMap = {};
    for (const d of drivers) state.driverZoneMap[d.id] = { zones: [] };
    res.json({ drivers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 4. 保存司机→区域映射
app.post('/api/assign-drivers', (req, res) => {
  try {
    const { driverZoneMap } = req.body;
    if (!driverZoneMap) return res.status(400).json({ error: '缺少 driverZoneMap' });
    state.driverZoneMap = driverZoneMap;
    // 同时写入 config 文件
    const mapPath = path.join(CONFIG_DIR, 'driver_zone_map.json');
    const mapData = { _comment: '由Web UI生成', ...driverZoneMap };
    fs.writeFileSync(mapPath, JSON.stringify(mapData, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 5. 验证 Routific token (探活: 发最小 VRP 请求)
app.post('/api/verify-token', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: '缺少 token' });
    // 最小探活 payload: 1 个虚构 visit + 1 个虚构 vehicle
    const probe = {
      visits: { probe_visit: { location: { name: 'probe', lat: 45.396, lng: -73.515 }, duration: 1, start: '10:30', end: '23:59', load: 1, types: ['ref'] } },
      fleet: { probe_vehicle: { start_location: { name: 'wh', lat: 45.396, lng: -73.515 }, end_location: { name: 'wh', lat: 45.396, lng: -73.515 }, shift_start: '10:30', shift_end: '23:59', capacity: 100, types: ['ref', 'no'] } },
      options: { traffic: 'fast' }
    };
    const resp = await routificCall(probe, token);
    if (resp.status === 200 && resp.body && resp.body.status === 'success') {
      state.token = token;
      state.tokenVerified = true;
      res.json({ valid: true });
    } else if (resp.status === 401) {
      state.token = null;
      state.tokenVerified = false;
      res.json({ valid: false, message: 'token 无效或已过期 (401)' });
    } else {
      res.json({ valid: false, message: 'Routific 返回 ' + resp.status + ': ' + JSON.stringify(resp.body).slice(0, 200) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 6. 一键分单 (执行完整 pipeline)
app.post('/api/run', async (req, res) => {
  try {
    if (!state.orders) return res.status(400).json({ error: '请先上传订单' });
    if (!state.geojson) return res.status(400).json({ error: '请先画区域' });
    if (!state.drivers) return res.status(400).json({ error: '请先上传司机表' });
    if (!state.tokenVerified) return res.status(400).json({ error: '请先验证 Routific token' });

    // 1. 分区: 用前端传来的 GeoJSON
    const settings = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'settings.json'), 'utf8'));
    const zones = state.geojson.features.map((f, i) => ({ zoneId: i + 1, coords: f.geometry.coordinates[0] }));
    function pointInPolygon(pt, vs) {
      const x = pt[0], y = pt[1]; let inside = false;
      for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        const xi = vs[i][0], yi = vs[i][1], xj = vs[j][0], yj = vs[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
      }
      return inside;
    }
    let unassigned = 0;
    for (const o of state.orders) {
      let hit = null;
      for (const z of zones) { if (pointInPolygon([o.lng, o.lat], z.coords)) { hit = z.zoneId; break; } }
      o.zoneId = hit;
      if (hit === null) { unassigned++; o.zoneId = 1; o.zoneFallback = 'nearest'; }
    }
    // 写 orders_with_zones.json (pipeline 和 build-map 要读)
    const owz = { totalOrders: state.orders.length, unassigned, generatedAt: new Date().toISOString(), warehouse: settings.warehouse, zones: zones.map(z => ({ zoneId: z.zoneId, vertexCount: z.coords.length })), orders: state.orders };
    fs.writeFileSync(path.join(WORK, 'orders_with_zones.json'), JSON.stringify(owz, null, 2));

    // 2. 生成 driver_zones.json (合并 settings + driverZoneMap)
    const drivers = state.drivers.map(d => ({
      id: d.id, nickname: d.nickname, capacity: d.capacity,
      types: ['ref'], start: '', zones: (state.driverZoneMap[d.id] || {}).zones || []
    }));
    const cfg = {
      generatedAt: new Date().toISOString(),
      routingMode: settings.routingMode,
      warehouse: settings.warehouse, shift: settings.shift, options: settings.options,
      drivers
    };
    fs.writeFileSync(path.join(WORK, 'driver_zones.json'), JSON.stringify(cfg, null, 2));

    // 3. 调 pipeline (传 token + orders + config, 复用 hook)
    const summary = await runPipeline({ token: state.token, orders: state.orders, config: cfg });

    // 4. 生成地图
    try { buildMap(); } catch (e) { console.log('buildMap warning:', e.message); }

    // 5. 收集结果文件
    const resultFiles = [];
    if (fs.existsSync(OUT_DIR)) {
      for (const f of fs.readdirSync(OUT_DIR)) {
        if (f.endsWith('.csv') || f === 'route_map.html' || f === 'route_plan.json') {
          resultFiles.push(f);
        }
      }
    }

    res.json({
      ok: !summary.error,
      error: summary.error || null,
      preCheck: summary.preCheck || null,
      analysis: summary.analysis || null,
      totalTravelTime: summary.response ? summary.response.totalTravelTime : null,
      numUnserved: summary.response ? summary.response.numUnserved : 0,
      perDriver: summary.perDriver.map(d => ({
        id: d.id, nickname: d.nickname, stopCount: d.stopCount != null ? d.stopCount : (d.stops ? d.stops.length : 0),
        error: d.error || null
      })),
      resultFiles
    });
  } catch (e) {
    console.error('RUN ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// 7. 下载结果文件
app.get('/api/download/:filename', (req, res) => {
  const fpath = path.join(OUT_DIR, req.params.filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: '文件不存在' });
  res.sendFile(fpath);
});

// 8. 获取结果文件内容 (地图 HTML 直接返回)
app.get('/api/result/:filename', (req, res) => {
  const fpath = path.join(OUT_DIR, req.params.filename);
  if (!fs.existsSync(fpath)) return res.status(404).json({ error: '文件不存在' });
  if (req.params.filename.endsWith('.html')) {
    res.type('text/html').send(fs.readFileSync(fpath, 'utf8'));
  } else if (req.params.filename.endsWith('.json')) {
    res.json(JSON.parse(fs.readFileSync(fpath, 'utf8')));
  } else {
    res.type('text/csv').send(fs.readFileSync(fpath, 'utf8'));
  }
});

// 9. 状态查询
app.get('/api/state', (req, res) => {
  res.json({
    hasOrders: !!state.orders,
    orderCount: state.orders ? state.orders.length : 0,
    hasGeojson: !!state.geojson,
    zoneCount: state.geojson ? state.geojson.features.length : 0,
    hasDrivers: !!state.drivers,
    driverCount: state.drivers ? state.drivers.length : 0,
    driverZoneMap: state.driverZoneMap,
    tokenVerified: state.tokenVerified
  });
});

// 9b. 获取路线详情 (供前端渲染可编辑 stop 列表)
app.get('/api/route-detail', (req, res) => {
  try {
    const planPath = path.join(OUT_DIR, 'route_plan.json');
    const owzPath = path.join(WORK, 'orders_with_zones.json');
    if (!fs.existsSync(planPath)) return res.status(400).json({ error: '请先执行分单' });
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const owz = fs.existsSync(owzPath) ? JSON.parse(fs.readFileSync(owzPath, 'utf8')) : { orders: [] };
    const orderMap = new Map(owz.orders.map(o => [String(o.name), o]));
    const drivers = plan.perDriver.filter(d => !d.error).map(d => {
      const realStops = (d.stops || []).filter(s => !String(s.location_id).endsWith('_start') && !String(s.location_id).endsWith('_end'));
      return {
        id: d.id,
        nickname: d.nickname,
        stops: realStops.map(s => {
          const o = orderMap.get(String(s.location_id)) || {};
          return {
            location_id: s.location_id,
            arrival_time: s.arrival_time || '',
            finish_time: s.finish_time || '',
            address: o.address || '',
            lat: o.lat, lng: o.lng,
            duration: o.duration || 0,
            load: o.load || 0,
            ref: o.ref || '',
            from: o.from || '', to: o.to || ''
          };
        })
      };
    });
    res.json({ drivers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 9c. 更新路线 (手动调整停点顺序后, 本地估算时间, 写回 route_plan.json)
app.post('/api/update-plan', (req, res) => {
  try {
    const { drivers: adjustedDrivers } = req.body;
    if (!adjustedDrivers) return res.status(400).json({ error: '缺少 drivers 数据' });

    const planPath = path.join(OUT_DIR, 'route_plan.json');
    const owzPath = path.join(WORK, 'orders_with_zones.json');
    const cfgPath = path.join(WORK, 'driver_zones.json');
    if (!fs.existsSync(planPath)) return res.status(400).json({ error: '请先执行分单' });

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const owz = JSON.parse(fs.readFileSync(owzPath, 'utf8'));
    const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const wh = cfg.warehouse || owz.warehouse || { lat: 45.396, lng: -73.515 };
    const shift = cfg.shift || { start: '10:30', end: '23:59' };
    const orderMap = new Map(owz.orders.map(o => [String(o.name), o]));

    function haversine(lat1, lng1, lat2, lng2) {
      const R = 6371, toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    function toMin(t) { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; }
    function toHHMM(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); }

    // 更新每个司机的 stops (保持 start/end, 重排真实订单, 估算时间)
    for (const adj of adjustedDrivers) {
      const drv = plan.perDriver.find(d => d.id === adj.id);
      if (!drv) continue;
      const newOrderIds = adj.stops; // array of location_id strings (新顺序)

      // 找到 start/end stop
      const startStop = (drv.stops || []).find(s => String(s.location_id).endsWith('_start'));
      const endStop = (drv.stops || []).find(s => String(s.location_id).endsWith('_end'));

      // 按新顺序构建 stops, 估算时间
      const SPEED = 40; // km/h
      let prevLat = wh.lat, prevLng = wh.lng;
      let prevFinishMin = toMin(shift.start);
      const newStops = [];

      if (startStop) {
        newStops.push({ ...startStop, arrival_time: shift.start, finish_time: shift.start });
      }

      for (const locId of newOrderIds) {
        const o = orderMap.get(String(locId)) || {};
        const lat = o.lat || 0, lng = o.lng || 0;
        const dist = haversine(prevLat, prevLng, lat, lng);
        const travelMin = Math.ceil(dist / SPEED * 60);
        const arrivalMin = prevFinishMin + travelMin;
        const finishMin = arrivalMin + (o.duration || 10);
        newStops.push({
          location_id: locId,
          location_name: locId,
          arrival_time: toHHMM(arrivalMin),
          finish_time: toHHMM(finishMin)
        });
        prevLat = lat; prevLng = lng;
        prevFinishMin = finishMin;
      }

      if (endStop) {
        const dist = haversine(prevLat, prevLng, wh.lat, wh.lng);
        const travelMin = Math.ceil(dist / SPEED * 60);
        const arrivalMin = prevFinishMin + travelMin;
        newStops.push({ ...endStop, arrival_time: toHHMM(arrivalMin), finish_time: toHHMM(arrivalMin) });
      }

      drv.stops = newStops;
    }

    // 写回 route_plan.json
    plan.adjustedAt = new Date().toISOString();
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

    // 重建地图
    try { buildMap(); } catch (e) { console.log('buildMap warning:', e.message); }

    res.json({ ok: true, message: '路线已更新, 时间已重新估算' });
  } catch (e) {
    console.error('UPDATE-PLAN ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

// 10. 导出总Solution CSV (合并所有司机, 31列, 格式与Routific官方导出一致)
app.post('/api/export-solution', (req, res) => {
  try {
    const planPath = path.join(OUT_DIR, 'route_plan.json');
    const owzPath = path.join(WORK, 'orders_with_zones.json');
    const cfgPath = path.join(WORK, 'driver_zones.json');
    if (!fs.existsSync(planPath)) return res.status(400).json({ error: '请先执行分单' });
    if (!fs.existsSync(owzPath)) return res.status(400).json({ error: '缺少 orders_with_zones.json' });

    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const owz  = JSON.parse(fs.readFileSync(owzPath, 'utf8'));
    const cfg  = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const wh = (cfg.warehouse || owz.warehouse || { name: 'warehouse', lat: 45.396, lng: -73.515 });
    const shift = cfg.shift || { start: '10:30', end: '23:59' };
    const orderMap = new Map(owz.orders.map(o => [String(o.name), o]));

    // CSV 表头 (31列, 与Routific官方导出一致)
    const HEADERS = [
      'Driver Name','Driver Phone','Stop Number','Visit Name','Address','Street','City','State','Zip code',
      'Latitude','Longitude','Time window start','Time window end','Arrive at','Start at','Finish by',
      'Duration','Idle time','Distance(km)','Load','Phone','Email','Types','Notes','Notes 2','Photo Url',
      '赠品','大小件数量','联系ID','合并订单号','支付方式'
    ];

    function haversine(lat1, lng1, lat2, lng2) {
      const R = 6371, toRad = d => d * Math.PI / 180;
      const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
      const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    function splitAddress(addr) {
      const parts = String(addr || '').split(',').map(s => s.trim());
      return { street: parts[0] || '', city: parts[1] || '', state: parts[2] || '', zip: parts[3] || '' };
    }

    function csvEscape(v) {
      v = String(v == null ? '' : v);
      if (v.includes(',') || v.includes('"') || v.includes('\n')) return '"' + v.replace(/"/g, '""') + '"';
      return v;
    }

    const rows = [HEADERS.join(',')];
    const today = new Date().toISOString().slice(0, 10);

    for (const d of plan.perDriver) {
      if (d.error) continue;
      const stops = (d.stops || []).filter(s => !String(s.location_id).endsWith('_start') && !String(s.location_id).endsWith('_end'));
      if (!stops.length) continue;

      let totalDist = 0;
      let prevLat = wh.lat, prevLng = wh.lng;

      // start 行 (Stop Number=0)
      rows.push([
        d.id, '', 0, '', csvEscape(wh.name), csvEscape(wh.name), '', '', '',
        wh.lat, wh.lng, '', '', '', shift.start, shift.start,
        '', '', '', 0, '', '', '', '', '', '', '', '', '', '', ''
      ].join(','));

      // 各停点行
      stops.forEach((s, i) => {
        const o = orderMap.get(String(s.location_id)) || {};
        const dist = haversine(prevLat, prevLng, o.lat || s.location_lat || 0, o.lng || s.location_lng || 0);
        totalDist += dist;
        const a = splitAddress(o.address);
        rows.push([
          d.id, '', i + 1, s.location_id, csvEscape(o.address || ''), csvEscape(a.street), csvEscape(a.city), csvEscape(a.state), csvEscape(a.zip),
          o.lat || '', o.lng || '', o.from || '', o.to || '', s.arrival_time || '', s.arrival_time || '', s.finish_time || '',
          o.duration || '', 0, dist.toFixed(4), o.load || '', '', '', o.ref || '', csvEscape(o.notes || ''), csvEscape(o.notes2 || ''), '',
          csvEscape(o.gift || ''), csvEscape(o.sizeCount || ''), csvEscape(o.internalNotes || ''), csvEscape(o.ordersField || ''), csvEscape(o.paymentType || '')
        ].join(','));
        prevLat = o.lat || 0; prevLng = o.lng || 0;
      });

      // end 行 (Stop Number=999)
      const lastStop = stops[stops.length - 1];
      const endDist = haversine(prevLat, prevLng, wh.lat, wh.lng);
      totalDist += endDist;
      rows.push([
        d.id, '', 999, '', csvEscape(wh.name), csvEscape(wh.name), '', '', '',
        wh.lat, wh.lng, '', '', lastStop ? lastStop.finish_time : '', lastStop ? lastStop.finish_time : '', '',
        '', '', totalDist.toFixed(4), 0, '', '', '', '', '', '', '', '', '', '', ''
      ].join(','));
    }

    const csvContent = '\uFEFF' + rows.join('\n');
    const outPath = path.join(OUT_DIR, 'solution_all.csv');
    fs.writeFileSync(outPath, csvContent, 'utf8');
    console.log('export-solution: ' + outPath + ' (' + (rows.length - 1) + ' rows)');
    res.json({ ok: true, filename: 'Routific solution - ' + today + '.csv', rows: rows.length - 1 });
  } catch (e) {
    console.error('EXPORT ERROR:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log('MTL远线分单 Web控制台已启动: http://localhost:' + PORT);
  console.log('按 Ctrl+C 停止');
});
