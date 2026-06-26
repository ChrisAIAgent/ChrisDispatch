// parse-drivers.js — 读司机 Excel,合并 settings.json + driver_zone_map.json,
// 生成 work/driver_zones.json(供 pipeline.js 使用)。
// 用法: node work/scripts/parse-drivers.js <driver_xlsx_path>
//   或被 require: const { parseDrivers } = require('./parse-drivers');
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const WORK = path.resolve(__dirname, '..');
const CONFIG_DIR = path.join(WORK, 'config');
const SETTINGS = path.join(CONFIG_DIR, 'settings.json');
const ZONE_MAP = path.join(CONFIG_DIR, 'driver_zone_map.json');
const OUT = path.join(WORK, 'driver_zones.json');

const { readXlsx, cleanup, cell } = require(path.join(WORK, 'lib', 'xlsx-reader.js'));

// 从完整地址里抽邮编(如 "25 Av. d'Inverness, Candiac, QC J5R 0W3, Canada" -> "J5R 0W3")
function extractPostcode(addr) {
  if (!addr) return '';
  const m = String(addr).match(/\b([A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/);
  return m ? m[1].replace(/\s+/, ' ') : '';
}

function parseDrivers(driverXlsxPath) {
  if (!fs.existsSync(driverXlsxPath)) throw new Error('司机表不存在: ' + driverXlsxPath);
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const zoneMap = JSON.parse(fs.readFileSync(ZONE_MAP, 'utf8'));

  const { headers, rows, tmpDir } = readXlsx(driverXlsxPath);
  const drivers = [];
  const warnings = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const driverName = String(cell(r, headers, 'Driver Name') || '').trim();
    if (!driverName) continue;

    const capacity = Number(cell(r, headers, 'Capacity')) || 220;
    const shiftStart = String(cell(r, headers, 'Shift Start') || '').trim();
    const shiftEnd = String(cell(r, headers, 'Shift End') || '').trim();
    const startAddr = String(cell(r, headers, 'Start Address') || '').trim();
    const startPostcode = extractPostcode(startAddr);

    // 班次以 settings 为准;若司机表班次与 settings 不一致,告警
    if (shiftStart && shiftStart !== settings.shift.start) {
      warnings.push(driverName + ' Shift Start=' + shiftStart + ' 与 settings ' + settings.shift.start + ' 不一致,以 settings 为准');
    }
    if (shiftEnd && shiftEnd !== settings.shift.end) {
      warnings.push(driverName + ' Shift End=' + shiftEnd + ' 与 settings ' + settings.shift.end + ' 不一致,以 settings 为准');
    }

    // 区域映射:从 driver_zone_map 取;没有则默认空(机动)并告警
    const mapped = zoneMap[driverName];
    let zones = [];
    if (mapped && Array.isArray(mapped.zones)) {
      zones = mapped.zones;
    } else {
      warnings.push(driverName + ' 未在 driver_zone_map.json 中配置,默认 zones=[] (机动)');
    }

    // nickname:去掉 MTL- 前缀
    const nickname = driverName.replace(/^[A-Z]+-/, '') || driverName;

    drivers.push({
      id: driverName,
      nickname,
      capacity,
      types: ['ref'],          // 冷链车;如需区分干货车在 driver_zone_map 里加 typesOverride
      start: startPostcode,
      zones
    });
  }

  const result = {
    _comment: '本文件由 parse-drivers.js 自动生成,请勿手改。改司机->区域映射请编辑 work/config/driver_zone_map.json,改仓库/班次请编辑 work/config/settings.json。',
    generatedAt: new Date().toISOString(),
    source: path.basename(driverXlsxPath),
    routingMode: settings.routingMode,
    warehouse: settings.warehouse,
    shift: settings.shift,
    options: settings.options,
    drivers
  };

  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  cleanup(tmpDir);

  return { drivers, warnings, out: OUT };
}

if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('用法: node work/scripts/parse-drivers.js <driver_xlsx_path>');
    process.exit(1);
  }
  try {
    const r = parseDrivers(arg);
    console.log('已生成 ' + r.out);
    console.log('司机数: ' + r.drivers.length);
    for (const d of r.drivers) console.log('  ' + d.id + ' (zones=' + JSON.stringify(d.zones) + ', cap=' + d.capacity + ')');
    if (r.warnings.length) { console.log('\n⚠ 告警:'); for (const w of r.warnings) console.log('  - ' + w); }
  } catch (e) {
    console.error('错误: ' + e.message); process.exit(2);
  }
}

module.exports = { parseDrivers };
