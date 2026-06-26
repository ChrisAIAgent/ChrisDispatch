#!/usr/bin/env node
// run.js — MTL远线分单 统一入口。
// 每天 10 点:把司机 xlsx + 订单 xlsx 丢进 work/inbox/,然后跑:
//   node run.js
// 一条命令完成:解压识别 → 解析司机 → 解析订单分区 → 调Routific → 导出CSV+地图。
//
// 选项:
//   node run.js              完整流程(若未设 ROUTIFIC_TOKEN 则停在分区,提示设token)
//   node run.js --routific   强制调 Routific(要求 ROUTIFIC_TOKEN 已设)
//   node run.js --map        只重建地图(用已有 output/route_plan.json)
//   node run.js --no-routific 只做解析+分区,不调 Routific
//
// token 设置(一次性):
//   PowerShell: [System.Environment]::SetEnvironmentVariable('ROUTIFIC_TOKEN','<token>','User')
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const WORK = path.join(ROOT, 'work');
const INBOX = path.join(WORK, 'inbox');
const OUT_DIR = path.join(WORK, 'output');

const { readXlsx, cleanup, detectType } = require(path.join(WORK, 'lib', 'xlsx-reader.js'));
const { parseDrivers } = require(path.join(WORK, 'scripts', 'parse-drivers.js'));
const { assignZones } = require(path.join(WORK, 'scripts', 'assign-zones.js'));
const { runPipeline } = require(path.join(WORK, 'scripts', 'pipeline.js'));
const { buildMap } = require(path.join(WORK, 'scripts', 'build-map.js'));

const args = new Set(process.argv.slice(2));
const FORCE_ROUTIFIC = args.has('--routific');
const NO_ROUTIFIC = args.has('--no-routific');
const ONLY_MAP = args.has('--map');
const HAS_TOKEN = !!(process.env.ROUTIFIC_TOKEN);

function log(emoji, msg) { console.log((emoji ? emoji + ' ' : '') + msg); }

// 扫描 inbox,按表头分类出司机表和订单表
function scanInbox() {
  if (!fs.existsSync(INBOX)) { fs.mkdirSync(INBOX, { recursive: true }); }
  const files = fs.readdirSync(INBOX).filter(f => /\.xlsx$/i.test(f)).map(f => path.join(INBOX, f));
  const drivers = [], orders = [];
  for (const f of files) {
    let info;
    try { info = readXlsx(f); } catch (e) { log('⚠', '读取失败 ' + path.basename(f) + ': ' + e.message); continue; }
    const type = detectType(info.headers);
    cleanup(info.tmpDir);
    if (type === 'drivers') drivers.push(f);
    else if (type === 'orders') orders.push(f);
    else log('?', '无法识别 ' + path.basename(f) + ' (表头不含 Driver Name 或 Name/Address/lng/lat),跳过');
  }
  return { drivers, orders };
}

async function main() {
  console.log('MTL远线分单 · ' + new Date().toLocaleString('zh-CN'));
  console.log('工作目录: ' + ROOT + '\n');

  // --map: 只重建地图
  if (ONLY_MAP) {
    log('🗺', '重建地图...');
    buildMap();
    return;
  }

  // 1. 扫描 inbox
  log('1', '扫描 work/inbox/ ...');
  const { drivers, orders } = scanInbox();
  if (!drivers.length && !orders.length) {
    console.log('\n' + '─'.repeat(50));
    log('ℹ', 'inbox 里没有可识别的 xlsx。');
    console.log('  把当天的 司机信息表.xlsx 和 订单.xlsx 放到:');
    console.log('  ' + INBOX);
    console.log('\n  然后重跑: node run.js');
    return;
  }
  if (drivers.length > 1) log('⚠', '检测到 ' + drivers.length + ' 个司机表,只用第一个: ' + path.basename(drivers[0]));
  if (orders.length > 1) log('⚠', '检测到 ' + orders.length + ' 个订单表,只用第一个: ' + path.basename(orders[0]));

  // 2. 解析司机表
  if (drivers.length) {
    log('2', '解析司机表: ' + path.basename(drivers[0]));
    const r = parseDrivers(drivers[0]);
    log('  ✓', r.drivers.length + ' 个司机');
    for (const d of r.drivers) console.log('     ' + d.id + ' (zones=' + JSON.stringify(d.zones) + ', cap=' + d.capacity + ')');
    for (const w of r.warnings) log('  ⚠', w);
  } else {
    log('2', '未找到司机表,沿用已有 driver_zones.json');
    if (!fs.existsSync(path.join(WORK, 'driver_zones.json'))) {
      log('  ✗', 'driver_zones.json 也不存在。请把司机表放进 inbox 后重跑。');
      return;
    }
  }

  // 3. 解析订单 + 分区
  if (orders.length) {
    log('3', '解析订单 + GeoJSON 分区: ' + path.basename(orders[0]));
    const r = assignZones(orders[0]);
    console.log(r.summary.trim());
  } else {
    log('3', '未找到订单表,沿用已有 orders_with_zones.json');
    if (!fs.existsSync(path.join(WORK, 'orders_with_zones.json'))) {
      log('  ✗', 'orders_with_zones.json 也不存在。请把订单表放进 inbox 后重跑。');
      return;
    }
  }

  // 4. 调 Routific
  const doRoutific = FORCE_ROUTIFIC || (!NO_ROUTIFIC && HAS_TOKEN);
  if (!doRoutific) {
    console.log('\n' + '─'.repeat(50));
    if (!HAS_TOKEN) {
      log('⏸', '未设 ROUTIFIC_TOKEN,停在分区阶段。');
      console.log('  设 token(一次性):');
      console.log("    [System.Environment]::SetEnvironmentVariable('ROUTIFIC_TOKEN','<your-token>','User')");
      console.log('  然后重开终端跑: node run.js --routific');
    } else {
      log('⏸', '已跳过 Routific(--no-routific)。');
    }
    log('✓', '解析+分区完成,可检查 work/orders_with_zones.json 和 work/driver_zones.json');
    return;
  }

  log('4', '调用 Routific VRP API ...');
  const summary = await runPipeline();
  if (summary.error) {
    log('✗', 'Routific 调用失败: ' + summary.error);
    console.log('  详情见 work/output/route_plan.json');
    return;
  }

  // 5. 重建地图
  log('5', '生成交互地图...');
  buildMap();

  // 6. 汇总
  console.log('\n' + '═'.repeat(50));
  log('✓', '完成!输出目录: ' + OUT_DIR);
  const resp = summary.response || {};
  console.log('  总行驶时间: ' + (resp.totalTravelTime ?? '-') + ' min');
  console.log('  未派单: ' + (resp.numUnserved ?? 0) + ' 单' + (resp.numUnserved ? ' (见 unserved.csv)' : ''));
  for (const d of summary.perDriver) {
    const n = d.stopCount != null ? d.stopCount : (d.stops ? d.stops.length : 0);
    console.log('  ' + d.id + ': ' + n + ' stops');
  }
  console.log('\n  打开地图: ' + path.join(OUT_DIR, 'route_map.html'));
}

main().catch(e => { console.error('FATAL: ' + e.message); process.exit(1); });
