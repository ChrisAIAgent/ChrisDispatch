// analyze-solutions.js — 分析一周手动 Solution,统计 Zoe 的负载平衡习惯
// 输入: work/inbox/Solution For One Week/*.csv
// 输出: 控制台报告 + work/output/solution_analysis.json
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WEEK_DIR = path.join(__dirname, '..', 'inbox', 'Solution For One Week');
const OUT_DIR = path.join(__dirname, '..', 'output');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── CSV 解析(处理引号内逗号) ──
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── 从文件名提取日期 ──
function extractDate(filename) {
  const m = filename.match(/(\d+\.\d+)蒙特利尔/);
  if (m) return m[1];
  const m2 = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m2 ? m2[1] : filename;
}

// ── 统计单个 Solution 文件 ──
function analyzeSolution(filepath, isSummary) {
  const text = fs.readFileSync(filepath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCSV(text);
  if (rows.length < 2) return null;
  const headers = rows[0];
  const drivers = {};

  if (isSummary) {
    // summary 格式: Driver Name,Time(min),Distance(km),Number of Stops
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!r[0] || r[0] === 'MTL-挂单号1') continue;
      drivers[r[0]] = {
        stops: parseInt(r[3]) || 0,
        load: null, // summary 没有箱数
        distance: parseFloat(r[2]) || 0,
        duration: parseInt(r[1]) || 0,
        orders: []
      };
    }
    return drivers;
  }

  // 完整 Solution 格式
  const idx = {
    driver: headers.indexOf('Driver Name'),
    stopNum: headers.indexOf('Stop Number'),
    visitName: headers.indexOf('Visit Name'),
    load: headers.indexOf('Load'),
    distance: headers.indexOf('Distance(km)'),
    duration: headers.indexOf('Duration'),
    arrive: headers.indexOf('Arrive at'),
    finish: headers.indexOf('Finish by'),
    type: headers.indexOf('Types')
  };

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const driver = r[idx.driver];
    if (!driver || driver === 'MTL-挂单号1') continue;
    const stopNum = parseInt(r[idx.stopNum]);
    if (stopNum === 0 || stopNum === 999) continue; // 跳过 start/end

    if (!drivers[driver]) {
      drivers[driver] = { stops: 0, load: 0, distance: 0, duration: 0, orders: [] };
    }
    const d = drivers[driver];
    d.stops++;
    d.load += parseInt(r[idx.load]) || 0;
    d.distance += parseFloat(r[idx.distance]) || 0;
    d.duration += parseInt(r[idx.duration]) || 0;
    d.orders.push({
      name: r[idx.visitName],
      load: parseInt(r[idx.load]) || 0,
      type: r[idx.type] || '',
      lat: parseFloat(r[headers.indexOf('Latitude')]) || 0,
      lng: parseFloat(r[headers.indexOf('Longitude')]) || 0
    });
  }
  return drivers;
}

// ── 计算差异指标 ──
function calcMetrics(drivers) {
  const list = Object.entries(drivers).map(([name, d]) => ({ name, ...d }));
  if (list.length === 0) return null;

  const metrics = {};
  for (const key of ['stops', 'load', 'distance', 'duration']) {
    const values = list.map(d => d[key]).filter(v => v !== null && v !== undefined);
    if (values.length === 0) continue;

    const max = Math.max(...values);
    const min = Math.min(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    const cv = avg > 0 ? std / avg : 0; // 变异系数

    metrics[key] = { max, min, diff: max - min, avg, std, cv, values };
  }
  return { drivers: list, metrics };
}

// ── 分位数计算 ──
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── 主流程 ──
const files = fs.readdirSync(WEEK_DIR).filter(f => f.endsWith('.csv'));
const allDays = [];
const allDiffs = { stops: [], load: [], distance: [], duration: [] };
const allCVs = { stops: [], load: [], distance: [], duration: [] };

console.log('═══════════════════════════════════════════════');
console.log('  Zoe 手动 Solution 一周负载分析报告');
console.log('═══════════════════════════════════════════════\n');

for (const file of files) {
  const filepath = path.join(WEEK_DIR, file);
  const isSummary = file.includes('summary');
  const date = extractDate(file);
  const drivers = analyzeSolution(filepath, isSummary);
  if (!drivers) continue;

  const result = calcMetrics(drivers);
  allDays.push({ date, file, ...result });

  console.log('── ' + date + (isSummary ? ' (仅summary)' : '') + ' ──────────────────');
  console.log('司机数: ' + result.drivers.length);
  console.log('司机明细:');
  console.log('  ' + '司机'.padEnd(14) + '停点数  箱数(load)  距离(km)  时长(min)');
  for (const d of result.drivers) {
    const loadStr = d.load !== null ? String(d.load).padEnd(10) : 'N/A'.padEnd(10);
    console.log('  ' + d.name.padEnd(14) + String(d.stops).padEnd(8) + loadStr + String(d.distance.toFixed(1)).padEnd(10) + d.duration);
  }

  console.log('差异指标:');
  for (const [key, m] of Object.entries(result.metrics)) {
    const label = { stops: '停点数', load: '箱数', distance: '距离', duration: '时长' }[key] || key;
    console.log('  ' + label + ': max-min=' + m.diff.toFixed(1) + '  CV=' + (m.cv * 100).toFixed(1) + '%  (avg=' + m.avg.toFixed(1) + ')');
    allDiffs[key].push(m.diff);
    allCVs[key].push(m.cv);
  }
  console.log('');
}

// ── 汇总统计 ──
console.log('═══════════════════════════════════════════════');
console.log('  汇总:Zoe 的平衡习惯阈值');
console.log('═══════════════════════════════════════════════\n');

const summary = {};
for (const key of ['stops', 'load', 'distance', 'duration']) {
  const diffs = allDiffs[key];
  const cvs = allCVs[key];
  if (diffs.length === 0) continue;

  const label = { stops: '停点数差异', load: '箱数差异', distance: '距离差异', duration: '时长差异' }[key] || key;
  console.log(label + ' (max-min):');
  console.log('  P50: ' + percentile(diffs, 50).toFixed(1));
  console.log('  P75: ' + percentile(diffs, 75).toFixed(1));
  console.log('  P90: ' + percentile(diffs, 90).toFixed(1));
  console.log('  最大值: ' + Math.max(...diffs).toFixed(1));
  console.log('  最小值: ' + Math.min(...diffs).toFixed(1));
  console.log('  变异系数CV 平均: ' + (cvs.reduce((a, b) => a + b, 0) / cvs.length * 100).toFixed(1) + '%');
  console.log('');

  summary[key] = {
    diffP50: percentile(diffs, 50),
    diffP75: percentile(diffs, 75),
    diffP90: percentile(diffs, 90),
    diffMax: Math.max(...diffs),
    diffMin: Math.min(...diffs),
    cvAvg: cvs.reduce((a, b) => a + b, 0) / cvs.length
  };
}

// ── 4 维度相关性分析 ──
console.log('═══════════════════════════════════════════════');
console.log('  4 维度相关性分析(哪个维度差异最大?)');
console.log('═══════════════════════════════════════════════\n');

const dimensionRanking = [];
for (const key of ['stops', 'load', 'distance', 'duration']) {
  if (!summary[key]) continue;
  const label = { stops: '停点数', load: '箱数', distance: '距离', duration: '时长' }[key] || key;
  const avgCV = summary[key].cvAvg;
  dimensionRanking.push({ key, label, avgCV, diffP90: summary[key].diffP90 });
  console.log(label + ': CV平均=' + (avgCV * 100).toFixed(1) + '%, P90差异=' + summary[key].diffP90.toFixed(1));
}

dimensionRanking.sort((a, b) => b.avgCV - a.avgCV);
console.log('\n差异从大到小排序(Zoe 最在意 → 最不在意):');
dimensionRanking.forEach((d, i) => {
  console.log('  ' + (i + 1) + '. ' + d.label + ' (CV=' + (d.avgCV * 100).toFixed(1) + '%)');
});

// ── 保存完整结果 ──
const report = {
  generatedAt: new Date().toISOString(),
  days: allDays.map(d => ({
    date: d.date,
    driverCount: d.drivers.length,
    drivers: d.drivers.map(dr => ({
      name: dr.name, stops: dr.stops, load: dr.load,
      distance: parseFloat(dr.distance.toFixed(2)), duration: dr.duration
    })),
    metrics: Object.fromEntries(
      Object.entries(d.metrics).map(([k, v]) => [k, {
        max: parseFloat(v.max.toFixed(2)), min: parseFloat(v.min.toFixed(2)),
        diff: parseFloat(v.diff.toFixed(2)), avg: parseFloat(v.avg.toFixed(2)),
        std: parseFloat(v.std.toFixed(2)), cv: parseFloat(v.cv.toFixed(4))
      }])
    )
  })),
  summary,
  dimensionRanking: dimensionRanking.map(d => ({
    dimension: d.label, cvAvg: parseFloat(d.avgCV.toFixed(4)),
    diffP90: parseFloat(d.diffP90.toFixed(2))
  }))
};

const outPath = path.join(OUT_DIR, 'solution_analysis.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log('\n完整结果已保存: ' + outPath);
