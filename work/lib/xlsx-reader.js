// xlsx-reader.js — 直接读 .xlsx 文件(自动解压到临时目录),返回 {headers, rows}。
// 同时提供 detectType(): 按表头识别是司机表还是订单表。
// 零依赖:用系统 unzip 解压,纯 Node 解析 OOXML 的 sharedStrings + sheet1.xml。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
function colIndex(ref) {
  const m = ref.match(/^([A-Z]+)/); if (!m) return 0;
  let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xmlDir) {
  const f = path.join(xmlDir, 'sharedStrings.xml');
  if (!fs.existsSync(f)) return [];
  const xml = fs.readFileSync(f, 'utf8');
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const ts = [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]);
    out.push(decodeXmlEntities(ts.join('')));
  }
  return out;
}

function parseSheet(xmlDir, shared) {
  const f = path.join(xmlDir, 'worksheets', 'sheet1.xml');
  const xml = fs.readFileSync(f, 'utf8');
  const rows = [];
  const rre = /<row\b[^>]*>([\s\S]*?)<\/row>/g; let rm;
  while ((rm = rre.exec(xml)) !== null) {
    const row = {};
    const cre = /<c\b([^>]*)>([\s\S]*?)<\/c>/g; let cm;
    while ((cm = cre.exec(rm[1])) !== null) {
      const a = cm[1], b = cm[2];
      const r = a.match(/\br="([A-Z]+\d+)"/);
      if (!r) continue;
      const ci = colIndex(r[1]);
      const t = a.match(/\bt="([^"]+)"/); const type = t ? t[1] : '';
      const v = b.match(/<v>([\s\S]*?)<\/v>/);
      let val;
      if (type === 's' && v) val = shared[+v[1]] ?? '';
      else if (type === 'inlineStr') {
        const tt = b.match(/<t\b[^>]*>([\s\S]*?)<\/t>/);
        val = tt ? decodeXmlEntities(tt[1]) : '';
      } else if (v) val = decodeXmlEntities(v[1]);
      else val = '';
      row[ci] = val;
    }
    rows.push(row);
  }
  return rows;
}

// 解压 .xlsx 到临时目录,返回 { xlDir, tmpDir }。
// 若传入的已是目录(含 xl/ 子目录,即已解压),直接用,不解压也不需清理。
// 调用方用完应调 cleanup(tmpDir);目录直读时 tmpDir=null,cleanup 是空操作。
function unzipXlsx(xlsxPath) {
  // 已是目录(已解压):直接用
  if (fs.existsSync(path.join(xlsxPath, 'xl'))) {
    return { xlDir: path.join(xlsxPath, 'xl'), tmpDir: null };
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mtl-xlsx-'));
  try {
    execFileSync('unzip', ['-o', '-q', xlsxPath, '-d', tmp], { stdio: 'pipe' });
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw new Error('解压 xlsx 失败(需要系统 unzip): ' + xlsxPath + ' — ' + (e.stderr ? e.stderr.toString().trim() : e.message));
  }
  const xlDir = path.join(tmp, 'xl');
  if (!fs.existsSync(xlDir)) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    throw new Error('解压后未找到 xl/ 目录,可能不是合法 xlsx: ' + xlsxPath);
  }
  return { xlDir, tmpDir: tmp };
}

// 主入口:读 .xlsx,返回 { headers: string[], rows: object[](按列号索引), tmpDir }。
// 调用方用完应调 cleanup(tmpDir)。
function readXlsx(xlsxPath) {
  const { xlDir, tmpDir } = unzipXlsx(xlsxPath);
  const shared = parseSharedStrings(xlDir);
  const rows = parseSheet(xlDir, shared);
  const headerRow = rows[0] || {};
  const cols = Object.keys(headerRow).map(Number).sort((a, b) => a - b);
  const headers = cols.map(c => headerRow[c] || '');
  return { headers, rows, cols, tmpDir };
}

function cleanup(tmpDir) {
  if (!tmpDir) return; // 目录直读模式无需清理
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// 按表头自动识别文件类型。返回 'drivers' | 'orders' | 'unknown'。
function detectType(headers) {
  const set = new Set(headers.filter(Boolean));
  if (set.has('Driver Name') && set.has('Shift Start')) return 'drivers';
  if (set.has('Name') && set.has('Address') && set.has('lng') && set.has('lat')) return 'orders';
  return 'unknown';
}

// 便利:按列名取值。row 是 readXlsx 返回的行对象(按列号索引)。
function cell(row, headers, name) {
  const ci = headers.indexOf(name);
  return ci >= 0 ? (row[ci] ?? '') : '';
}

module.exports = { readXlsx, cleanup, detectType, cell, unzipXlsx };
