// pipeline.js — 读 orders_with_zones.json + driver_zones.json,调 Routific VRP API,
// 导出 route_plan.json + 每司机 CSV + unserved.csv。
// 模式:
//   all_in_one       = 一次调用所有司机+所有 visit(Routific 自动按容量/时间窗分,推荐)
//   per_driver_zone  = 每个司机按 zones 过滤 visit 单独调用(zones 必须不重叠)
// 用法: node work/scripts/pipeline.js
//   或被 require: const { runPipeline } = require('./pipeline');
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const WORK = path.resolve(__dirname, '..');
const ORDERS_ZONES = path.join(WORK, 'orders_with_zones.json');
const DRIVER_ZONES = path.join(WORK, 'driver_zones.json');
const OUT_DIR = path.join(WORK, 'output');

function routificCall(payload, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.routific.com', port: 443, path: '/v1/vrp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'bearer ' + token
      },
      timeout: 60000
    }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', e => reject(new Error('HTTPS error: ' + e.code + ' ' + e.message)));
    req.on('timeout', () => { req.destroy(new Error('Routific call timeout (60s)')); });
    req.write(body); req.end();
  });
}

// visit 货物类型: ref(冷链/混合) -> 'ref',否则(常温) -> 'no'
function visitType(o) { return (o.ref && o.ref.length) ? 'ref' : 'no'; }

function buildVisits(ordersSubset, shift) {
  const v = {};
  for (const o of ordersSubset) {
    v[o.name] = {
      location: { name: o.name, lat: o.lat, lng: o.lng },
      duration: o.duration || 10,
      start:    o.from || shift.start,
      end:      o.to   || shift.end,
      load:     o.load || 0,
      types:    [visitType(o)],
      notes:    o.notes2 || o.notes || ''
    };
  }
  return v;
}

function buildFleet(drivers, wh, shift) {
  const f = {};
  for (const d of drivers) {
    // 司机车兼容 ref + no(冷链车也能送常温单);如未来需严格隔离,在 driver 配 typesOverride
    const types = d.typesOverride || ['ref', 'no'];
    f[d.id] = {
      start_location: { name: wh.name, lat: wh.lat, lng: wh.lng },
      end_location:   { name: wh.name, lat: wh.lat, lng: wh.lng },
      shift_start: shift.start,
      shift_end:   shift.end,
      capacity:    d.capacity || 220,
      types:       types
    };
  }
  return f;
}

async function callOne(label, payload, token) {
  console.log('\n=== ' + label + ' ===');
  console.log('  visits=' + Object.keys(payload.visits).length + ' fleet=' + Object.keys(payload.fleet).length);
  let resp;
  try { resp = await routificCall(payload, token); }
  catch (e) {
    console.log('  CALL FAILED: ' + e.message);
    return { error: e.message };
  }
  if (resp.status !== 200 || !resp.body || resp.body.status !== 'success') {
    console.log('  ROUTIFIC ERROR status=' + resp.status, JSON.stringify(resp.body).slice(0, 400));
    return { error: 'routific ' + resp.status, body: resp.body };
  }
  return { ok: resp.body };
}

// ═══ 智能体分析接口 (预留 hook, 半自动化跑通后实现) ═══
// preCheck: 调 Routific 之前的轻量规则检查(产能预算/时间窗/地理异常)
// postAnalyze: Routific 返回后的智能体分析(unserved诊断/负载均衡/调整建议)
// 当前只返回空结果, 不影响流程。后续填充逻辑时 pipeline 调用方式不变。

async function preCheck(orders, drivers, cfg) {
  const warnings = [], blockers = [];
  const totalLoad = orders.reduce((a, o) => a + (o.load || 0), 0);
  const totalCap  = drivers.reduce((a, d) => a + (d.capacity || 220), 0);
  if (totalLoad > totalCap) {
    blockers.push({ type: 'capacity', msg: '总load ' + totalLoad + ' > 总capacity ' + totalCap + ', 肯定装不下' });
  } else if (totalLoad > totalCap * 0.9) {
    warnings.push({ type: 'capacity', msg: '总load ' + totalLoad + ' 接近总capacity ' + totalCap + ' (90%+), 预计有单排不下' });
  }
  // TODO: 时间窗异常检查 / 地理离群点检查
  return { passed: blockers.length === 0, warnings, blockers };
}

async function postAnalyze(summary, orders, drivers) {
  const issues = [], suggestions = [];
  // TODO: unserved 逐单诊断 / 司机间负载均衡评估 / 路线质量分析 / 调整建议
  return { issues, suggestions };
}

async function runPipeline(options) {
  options = options || {};
  const overrideToken = options.token || null;
  const overrideOrders = options.orders || null;   // Web 模式可直接传 orders 数组
  const overrideCfg = options.config || null;      // Web 模式可直接传 config 对象

  if (!overrideCfg && !fs.existsSync(DRIVER_ZONES)) {
    throw new Error('Missing driver_zones.json. 先跑 parse-drivers.js 或 run.js 生成。');
  }
  if (!overrideOrders && !fs.existsSync(ORDERS_ZONES)) {
    throw new Error('Missing orders_with_zones.json. 先跑 assign-zones.js 或 run.js 生成。');
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const data = overrideOrders ? { orders: overrideOrders } : JSON.parse(fs.readFileSync(ORDERS_ZONES, 'utf8'));
  const cfg  = overrideCfg  || JSON.parse(fs.readFileSync(DRIVER_ZONES, 'utf8'));
  const orders = data.orders;
  const wh = cfg.warehouse;
  const shift = cfg.shift;
  const mode = cfg.routingMode || 'all_in_one';
  const routificOptions = cfg.options || {};
  const TOKEN = overrideToken || process.env.ROUTIFIC_TOKEN || '';
  if (!TOKEN) {
    throw new Error('Missing routific token. Web模式请通过 /api/verify-token 传入, 命令行设 ROUTIFIC_TOKEN 环境变量。');
  }

  // ── preCheck hook (智能体预留) ──
  const pre = await preCheck(orders, cfg.drivers, cfg);
  if (!pre.passed) {
    return { error: 'preCheck blocked', preCheck: pre };
  }

  const startedAt = new Date().toISOString();
  const summary = { startedAt, mode, drivers: cfg.drivers, perDriver: [], preCheck: pre };

  if (mode === 'per_driver_zone') {
    for (const driver of cfg.drivers) {
      const subset = orders.filter(o => driver.zones.includes(o.zoneId));
      const payload = { visits: buildVisits(subset, shift), fleet: buildFleet([driver], wh, shift), options: routificOptions };
      const r = await callOne(driver.id + ' zones=' + JSON.stringify(driver.zones) + ' visits=' + subset.length, payload, TOKEN);
      if (r.error) { summary.perDriver.push({ id: driver.id, error: r.error, body: r.body }); continue; }
      const body = r.ok;
      const stops = body.solution[driver.id] || [];
      summary.perDriver.push({
        id: driver.id, zones: driver.zones, sentToRoutific: subset.length,
        stops, unserved: body.unserved || [], totalTravelTime: body.total_travel_time
      });
      console.log('  -> stops=' + stops.length + ' unserved=' + (body.unserved || []).length + ' travel=' + body.total_travel_time + ' min');
    }
  } else {
    const payload = { visits: buildVisits(orders, shift), fleet: buildFleet(cfg.drivers, wh, shift), options: routificOptions };
    const r = await callOne('all_in_one', payload, TOKEN);
    if (r.error) {
      summary.error = r.error;
      summary.body = r.body;
    } else {
      const body = r.ok;
      summary.response = {
        totalTravelTime: body.total_travel_time,
        totalDriveTime: body.total_drive_time,
        numUnserved: body.num_unserved,
        unserved: body.unserved || []
      };
      for (const driver of cfg.drivers) {
        const stops = body.solution[driver.id] || [];
        summary.perDriver.push({
          id: driver.id, nickname: driver.nickname, zones: driver.zones,
          stopCount: stops.length, stops
        });
        console.log('  -> ' + driver.id + ': ' + stops.length + ' stops');
      }
    }
  }

  summary.finishedAt = new Date().toISOString();

  // ── postAnalyze hook (智能体预留) ──
  const post = await postAnalyze(summary, orders, cfg.drivers);
  summary.analysis = post;

  fs.writeFileSync(path.join(OUT_DIR, 'route_plan.json'), JSON.stringify(summary, null, 2));

  // 导出每司机 CSV
  const nameMap = new Map(orders.map(o => [o.name, o]));
  for (const d of summary.perDriver) {
    if (!d.stops || !d.stops.length) continue;
    const lines = ['seq,order,arrival_time,finish_time,address,lat,lng,ref,duration,load,zoneId'];
    d.stops.forEach((s, i) => {
      const o = nameMap.get(s.location_id) || {};
      lines.push([
        i + 1, s.location_id, s.arrival_time, s.finish_time,
        JSON.stringify(o.address || ''), o.lat, o.lng, o.ref, o.duration, o.load, o.zoneId
      ].join(','));
    });
    const fname = path.join(OUT_DIR, d.id + '_route.csv');
    fs.writeFileSync(fname, '\uFEFF' + lines.join('\n'));
    console.log('  CSV: ' + fname);
  }

  // 导出 unserved CSV
  const unserved = summary.response ? summary.response.unserved : [];
  if (unserved && (Array.isArray(unserved) ? unserved.length : Object.keys(unserved).length)) {
    const lines = ['order,reason'];
    if (Array.isArray(unserved)) {
      for (const u of unserved) {
        const id = u.location_id || u.id || u;
        lines.push([id, JSON.stringify(u.reason || '')].join(','));
      }
    } else {
      for (const [id, reason] of Object.entries(unserved)) {
        lines.push([id, JSON.stringify(reason || '')].join(','));
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'unserved.csv'), '\uFEFF' + lines.join('\n'));
    console.log('  CSV: unserved.csv (' + (lines.length - 1) + ' rows)');
  } else if (fs.existsSync(path.join(OUT_DIR, 'unserved.csv'))) {
    fs.unlinkSync(path.join(OUT_DIR, 'unserved.csv'));
  }

  console.log('\nDone. Output: ' + OUT_DIR);
  return summary;
}

if (require.main === module) {
  runPipeline().catch(e => { console.error('FATAL', e.message); process.exit(3); });
}

module.exports = { runPipeline, preCheck, postAnalyze, routificCall };
