// ChrisDispatch MVP - xlsx 解析: 动态加载 SheetJS(社区版)替代脆弱的自写正则
// 用法: const rows = await readXlsxFromArrayBuffer(arrayBuffer);
// 返回二维数组 rows[][], 首行是表头
(function () {
  'use strict';
  let loading = null;
  function loadSheetJS() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => reject(new Error('SheetJS 加载失败,请检查网络'));
      document.head.appendChild(s);
    });
    return loading;
  }

  window.readXlsxFromArrayBuffer = async function (buf) {
    const XLSX = await loadSheetJS();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('未找到任何 sheet');
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  };
})();
