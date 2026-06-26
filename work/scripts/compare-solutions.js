// compare-solutions.js — 对比手动 Routific Solution CSV vs 自动化 all_in_one Solution
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORK = path.resolve(__dirname, '..');
const MANUAL_CSV = path.join(WORK, 'inbox', 'manual_solution.csv');
const AUTO_PLAN = path.join(WORK, 'output', 'route_plan_all_in_one.json');
const ORDERS = path.join(WORK, 'orders_with_zones.json');

// 简易 CSV 解析(支持引号内逗号)
function parseCSV(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function main() {
  const orders = JSON.parse(fs.readFileSync(ORDERS, 'utf8')).orders;
  const orderMap = new Map(orders.map(o => [String(o.name), o]));

  // 解析手动 CSV
  const csvText = fs.readFileSync(MANUAL_CSV, 'utf8').replace(/^\uFEFF/, '');
  const csvRows = parseCSV(csvText);
  const H = csvRows[0];
  const hi = name => H.indexOf(name);

  const manual = {}; // driver -> [{seq, visit, arrive, finish, duration, distance, load}]
  for (let i = 1; i < csvRows.length; i++) {
    const r = csvRows[i];
    const driver = r[hi('Driver Name')] || '';
    const seq = parseInt(r[hi('Stop Number')], 10);
    const visit = r[hi('Visit Name')] || '';
    if (!driver) continue;
    if (!manual[driver]) manual[driver] = [];
    manual[driver].push({
      seq, visit,
      arrive: r[hi('Arrive at')] || '',
      finish: r[hi('Finish by')] || '',
      duration: Number(r[hi('Duration')]) || 0,
      distance: Number(r[hi('Distance(km)')]) || 0,
      load: Number(r[hi('Load')]) || 0
    });
  }
  // 按序号排序,过滤掉 start(0)/end(999)
  for (const d of Object.keys(manual)) {
    manual[d] = manual[d].filter(s => s.seq !== 0 && s.seq !== 999 && s.visit)
                          .sort((a, b) => a.seq - b.seq);
  }

  // 解析自动 Solution
  const auto = JSON.parse(fs.readFileSync(AUTO_PLAN, 'utf8'));
  const autoMap = {};
  for (const d of auto.perDriver) {
    const stops = (d.stops || []).filter(s => !s.location_id.endsWith('_start') && !s.location_id.endsWith('_end'));
    autoMap[d.id] = stops.map((s, idx) => ({
      seq: idx + 1,
      visit: s.location_id,
      arrive: s.arrival_time || '',
      finish: s.finish_time || ''
    }));
  }

  // ===== 1. 司机级汇总对比 =====
  console.log('═══════════════════════════════════════════════');
  console.log('  手动 vs 自动(all_in_one) 解决方案对比');
  console.log('═══════════════════════════════════════════════\n');

  console.log('【1. 司机级汇总】');
  console.log('┌─────────────┬──────────────────┬──────────────────┐');
  console.log('│ 司机        │ 手动(单/距离/载)  │ 自动(单/距离)    │');
  console.log('├─────────────┼──────────────────┼──────────────────┤');
  const allDrivers = new Set([...Object.keys(manual), ...Object.keys(autoMap)]);
  const manualOrderSet = new Set();
  const autoOrderSet = new Set();
  for (const d of [...allDrivers].sort()) {
    const m = manual[d] || [];
    const a = autoMap[d] || [];
    const mDist = m.reduce((s, x) => s + x.distance, 0).toFixed(1);
    const mLoad = m.reduce((s, x) => s + x.load, 0);
    const mDur = m.reduce((s, x) => s + x.duration, 0);
    m.forEach(x => x.visit && manualOrderSet.add(x.visit));
    a.forEach(x => x.visit && autoOrderSet.add(x.visit));
    console.log('│ ' + d.padEnd(11) + '│ ' + String(m.length).padStart(2) + '单/' + String(mDist).padStart(7) + 'km/' + String(mLoad).padStart(3) + '  │ ' + String(a.length).padStart(2) + '单              │');
  }
  console.log('└─────────────┴──────────────────┴──────────────────┘');

  // ===== 2. 订单级派单对比 =====
  console.log('\n【2. 订单级派单差异(同一单派给不同司机)】');
  const manualAssign = {}; // order -> driver
  const autoAssign = {};
  for (const [drv, stops] of Object.entries(manual)) for (const s of stops) if (s.visit) manualAssign[s.visit] = drv;
  for (const [drv, stops] of Object.entries(autoMap)) for (const s of stops) if (s.visit) autoAssign[s.visit] = drv;

  const allOrders = new Set([...Object.keys(manualAssign), ...Object.keys(autoAssign)]);
  const diffOrders = [];
  const onlyManual = [];
  const onlyAuto = [];
  for (const o of allOrders) {
    const m = manualAssign[o];
    const a = autoAssign[o];
    if (m && a && m !== a) diffOrders.push({ order: o, manual: m, auto: a });
    else if (m && !a) onlyManual.push({ order: o, manual: m });
    else if (!m && a) onlyAuto.push({ order: o, auto: a });
  }

  if (diffOrders.length) {
    console.log('  派给不同司机的单(' + diffOrders.length + '个):');
    for (const x of diffOrders) {
      const o = orderMap.get(x.order);
      const z = o ? 'Z' + o.zoneId : '?';
      console.log('    ' + x.order + ' [手动]' + x.manual + ' → [自动]' + x.auto + ' (' + z + ', load=' + (o ? o.load : '?') + ')');
    }
  } else {
    console.log('  ✓ 所有单派给的司机完全一致');
  }
  if (onlyManual.length) console.log('  仅手动有: ' + onlyManual.map(x => x.order + '(' + x.manual + ')').join(', '));
  if (onlyAuto.length) console.log('  仅自动有: ' + onlyAuto.map(x => x.order + '(' + x.auto + ')').join(', '));

  // ===== 3. 每司机顺序对比 =====
  console.log('\n【3. 每司机配送顺序对比】');
  for (const d of [...allDrivers].sort()) {
    const m = (manual[d] || []).map(s => s.visit);
    const a = (autoMap[d] || []).map(s => s.visit);
    console.log('\n  ' + d + ' (手动' + m.length + '单 / 自动' + a.length + '单):');

    // 共同订单的顺序差异
    const mSet = new Set(m), aSet = new Set(a);
    const common = m.filter(x => aSet.has(x));
    if (!common.length) { console.log('    无共同订单'); continue; }

    // 对比共同订单的相对顺序
    let orderDiff = 0;
    const mIdx = new Map(m.map((v, i) => [v, i]));
    const aIdx = new Map(a.map((v, i) => [v, i]));
    for (let i = 0; i < common.length; i++) {
      for (let j = i + 1; j < common.length; j++) {
        const mi = mIdx.get(common[i]) - mIdx.get(common[j]);
        const ai = aIdx.get(common[i]) - aIdx.get(common[j]);
        if ((mi > 0) !== (ai > 0)) orderDiff++;
      }
    }
    const consistency = common.length > 1 ? ((1 - orderDiff / (common.length * (common.length - 1) / 2)) * 100).toFixed(0) : '100';
    console.log('    共同订单: ' + common.length + ' | 顺序一致率: ' + consistency + '% (逆序对=' + orderDiff + ')');

    // 列出前5站对比
    console.log('    手动前5: ' + m.slice(0, 5).join(' → '));
    console.log('    自动前5: ' + a.slice(0, 5).join(' → '));
    if (m.length > 5) console.log('    手动后5: ... ' + m.slice(-5).join(' → '));
    if (a.length > 5) console.log('    自动后5: ... ' + a.slice(-5).join(' → '));
  }

  // ===== 4. 距离/时长对比 =====
  console.log('\n\n【4. 距离与时长对比】');
  let mTotalDist = 0, mTotalDur = 0;
  for (const [d, stops] of Object.entries(manual)) {
    const dist = stops.reduce((s, x) => s + x.distance, 0);
    const dur = stops.reduce((s, x) => s + x.duration, 0);
    mTotalDist += dist; mTotalDur += dur;
    console.log('  ' + d + ': 手动 ' + dist.toFixed(1) + 'km / ' + dur + 'min服务');
  }
  console.log('  手动总计: ' + mTotalDist.toFixed(1) + 'km / ' + mTotalDur + 'min服务');
  console.log('  自动总计: ' + (auto.response ? auto.response.totalTravelTime + 'min行驶' : '?') + ' / 0 unserved');

  // ===== 5. 时间窗违反/unserved =====
  console.log('\n【5. 时间窗 & 未派单】');
  console.log('  手动 unserved: ' + (allOrders.size - Object.keys(manualAssign).length) + ' 单(在订单表里但不在手动Solution)');
  console.log('  自动 unserved: ' + (auto.response ? auto.response.numUnserved : '?') + ' 单');
}

main();
