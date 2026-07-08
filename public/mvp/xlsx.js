// 浏览器版 xlsx 解析(JSZip + 正则,无需系统 unzip)
// 用法: const rows = await readXlsxFromArrayBuffer(arrayBuffer);
// 返回二维数组 rows[][],首行是表头
(function () {
  async function readXlsxFromArrayBuffer(buf) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip 未加载,请检查 <script> 标签');
    }
    const zip = await JSZip.loadAsync(buf);

    const ssFile = zip.file('xl/sharedStrings.xml');
    const sharedStrings = [];
    if (ssFile) {
      const ssXml = await ssFile.async('string');
      const ssRe = /<si[^>]*>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = ssRe.exec(ssXml)) !== null) {
        sharedStrings.push(extractText(m[1]));
      }
    }

    const sheetCandidates = ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'];
    let sheetXml = '';
    for (const p of sheetCandidates) {
      const f = zip.file(p);
      if (f) { sheetXml = await f.async('string'); break; }
    }
    if (!sheetXml) throw new Error('未找到任何 sheet');

    const rows = [];
    const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(sheetXml)) !== null) {
      const rowXml = rm[1];
      const cells = {};
      const cellRe = /<c\s+[^>]*?r="([A-Z]+)\d+"(?:\s+[^>]*?t="([^"]+)")?[^>]*?>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cellRe.exec(rowXml)) !== null) {
        const col = cm[1];
        const type = cm[2] || '';
        const inner = cm[3];
        let val = '';
        const vMatch = /<v>([^<]*)<\/v>/.exec(inner);
        const iMatch = /<is>([\s\S]*?)<\/is>/.exec(inner);
        if (iMatch) {
          val = extractText(iMatch[1]);
        } else if (vMatch) {
          if (type === 's') val = sharedStrings[parseInt(vMatch[1], 10)] ?? '';
          else if (type === 'b') val = vMatch[1] === '1' ? 'TRUE' : 'FALSE';
          else val = vMatch[1];
        }
        cells[col] = val;
      }
      const maxCol = Object.keys(cells).reduce((a, k) => Math.max(a, colToIdx(k)), -1);
      const row = [];
      for (let i = 0; i <= maxCol; i++) row.push(cells[idxToCol(i)] ?? '');
      rows.push(row);
    }
    return rows;
  }

  function extractText(xml) {
    const tRe = /<t[^>]*>([^<]*)<\/t>/g;
    let text = '';
    let tm;
    while ((tm = tRe.exec(xml)) !== null) text += tm[1];
    return decodeXmlEntities(text);
  }

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function colToIdx(col) {
    let n = 0;
    for (const c of col) n = n * 26 + (c.charCodeAt(0) - 64);
    return n - 1;
  }

  function idxToCol(n) {
    let s = '';
    n = n + 1;
    while (n > 0) {
      const r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  window.readXlsxFromArrayBuffer = readXlsxFromArrayBuffer;
})();