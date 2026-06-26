# ChrisDispatch — MTL远线配送分单系统

蒙特利尔（Montreal）远线配送路线自动规划系统。每天10点拿到次日司机名单+订单Excel，通过 Web 界面一键完成区域划分、司机分配、Routific VRP 自动分单，并导出标准 Solution CSV。

## 功能特性

- 📤 **订单上传** — 直接拖拽 Excel，自动解析订单数据
- 🗺️ **可视化区域划分** — 内置 Leaflet 地图，直接在页面上画配送区域多边形
- 👥 **司机区域分配** — 可视化 SVG 缩略图，直观分配司机负责区域
- 🔑 **Token 验证** — 每次输入 Routific API Token 并验证通过后才可一键分单（不落盘，更安全）
- 🚀 **一键分单** — 调用 Routific VRP API 自动规划最优路线
- 🗺️ **结果地图展示** — 按司机颜色显示路线，标注配送顺序编号+方向箭头
- 🔄 **手动调整顺序** — 拖拽停点调整配送顺序，本地重新估算到达时间
- 📥 **导出 Solution CSV** — 31列，与 Routific 官方导出格式完全一致

## 技术栈

- **后端**: Node.js + Express（纯 JS，核心逻辑零依赖）
- **前端**: 原生 JS + Leaflet 地图 + leaflet-draw
- **路由优化**: Routific VRP API
- **Excel 解析**: 自研 xlsx-reader（系统 unzip 解压 + 纯 JS 解析 OOXML，无需第三方库）

## 快速开始

### 安装运行

```bash
# 克隆仓库
git clone https://github.com/ChrisAIAgent/ChrisDispatch.git
cd ChrisDispatch

# 启动 Web 服务（Windows）
set NODE_PATH=C:\Users\Chris\.workbuddy\binaries\node\workspace\node_modules
C:\Users\Chris\.workbuddy\binaries\node\versions\22.22.2\node.exe server.js

# 启动 Web 服务（macOS / Linux）
node server.js
```

打开浏览器访问 `http://localhost:3000`

### 6步向导流程

1. **上传订单** — 拖拽订单 Excel 文件
2. **绘制区域** — 在 Leaflet 地图上画配送区域多边形，或导入已有 GeoJSON
3. **导入司机** — 上传司机名单 Excel
4. **分配区域** — 为每个司机分配负责的区域（带 SVG 缩略图预览）
5. **验证 Token** — 输入 Routific API Token 并验证
6. **一键分单** — 执行自动分单，查看结果地图，可手动调整顺序并导出 Solution

### 命令行模式

```bash
# 完整流程（需要先把文件放到 work/inbox/）
node run.js

# 单独运行各步骤
node work/scripts/parse-drivers.js   # 解析司机表
node work/scripts/assign-zones.js    # 订单分区
node work/scripts/pipeline.js        # 调用 Routific 分单
node work/scripts/build-map.js       # 生成结果地图 HTML
```

## 项目结构

```
ChrisDispatch/
├── server.js              # Express 后端，Web UI 服务
├── run.js                 # 命令行统一入口
├── public/                # 前端静态文件
│   ├── index.html         # 6步向导页面
│   ├── app.js             # 前端逻辑
│   └── style.css          # 样式
├── work/
│   ├── config/            # 配置文件（不提交敏感数据）
│   │   ├── settings.json         # 仓库/班次/选项
│   │   └── driver_zone_map.json  # 司机→区域映射
│   ├── scripts/           # 核心脚本
│   │   ├── pipeline.js           # Routific VRP 调用
│   │   ├── parse-drivers.js      # 解析司机 Excel
│   │   ├── assign-zones.js       # 订单分区
│   │   ├── build-map.js          # 生成结果地图
│   │   └── build-zones.js        # K-means 区域探索（可选）
│   └── lib/
│       └── xlsx-reader.js # Excel 解析库
├── .gitignore
└── README.md
```

## 配置说明

### settings.json

```json
{
  "warehouse": {
    "name": "25 Av. d'Inverness, Candiac",
    "lat": 45.396,
    "lng": -73.515
  },
  "shift": {
    "start": "10:30",
    "end": "23:59"
  },
  "routingMode": "per_driver_zone",
  "options": {}
}
```

- `routingMode`: `per_driver_zone`（按区域隔离分单，推荐）或 `all_in_one`（Routific 自由优化）
- `per_driver_zone` 模式与手动分单高度吻合（97% 一致），设为默认

### driver_zone_map.json

司机与区域映射，示例：

```json
{
  "Tony": ["Z1"],
  "Faouzi": ["Z2"],
  "Luke": ["Z3"]
}
```

## 安全说明

- ✅ Routific Token 仅存内存，每次使用需重新输入，不写文件
- ✅ `.gitignore` 已屏蔽所有含客户数据的文件（`work/inbox/`、`.xlsx`、输出文件等）
- ✅ 代码中无硬编码 Token 或 API Key
- ⚠️ 推送前请确认 `.gitignore` 生效，避免误提交敏感数据

## 版本记录

### v2.1 — 2026-06-26

**新增**
- Step 2 画区域时实时显示 4 项负载指标（单量/箱数/预估距离/预估时间）
- Step 2 区域间差异汇总（停点/箱数/距离/时间的最大差异）
- Step 4 分配司机时显示负载预测（单量/箱数/距离/时间 + 与均值差异）
- 超容量时标红提醒（如 Z2 箱数 224 > 220）
- 停点数差异过大时标黄提醒（阈值 8，与 Zoe 手动习惯一致）
- 添加 `work/scripts/analyze-solutions.js` 分析脚本（统计一周手动 Solution 的负载分布）

**优化**
- 前置约束：画区域时即可看到负载指标，避免调用 API 后出现 unserved
- 预估算法：仓库→区域质心→仓库 Haversine 距离，服务时长按 duration 累加

### v2.0 — 2026-06-26

**新增**
- 内置 Leaflet 地图，不再依赖 geojson.io 外部工具
- Token 每次输入+验证，验证通过后才解锁分单按钮
- 司机分配区域时显示 SVG 缩略图（总览图 + 每司机区域图）
- 结果地图标注配送顺序编号 + 方向箭头
- 支持手动拖拽调整停点顺序，本地重新估算到达/离开时间
- 导出总 Solution CSV（31列，与 Routific 官方格式一致）
- 可调整顺序后重新导出 Solution（不重新调 API，保留手动顺序）

**修复**
- 修复 `pipeline.js` 残留的 `cfg.routificToken` 读取（改为只从环境变量/参数传入）
- 修复 `build-map.js` 编号从2开始的 bug（过滤了 start/end 行）
- 修复 `build-map.js` totalTravelTime 显示0的问题
- 修复 `pipeline.js` unserved 读取方式（逐司机读取）

**优化**
- 清理 `.gitignore`，屏蔽所有敏感文件和自动生成文件
- 项目推送到 GitHub（https://github.com/ChrisAIAgent/ChrisDispatch）

### v1.0 — 2026-06（早期版本）

- 命令行模式自动解析司机表/订单表
- 调用 Routific VRP API 自动分单
- 对比手动 Solution 与自动 Solution 差异
- 确定 `per_driver_zone` 模式为默认（与手动结果 97% 一致）
- 修复硬编码路径、Token 泄漏等安全问题

## 待办 / 路线图

- [ ] 智能体监控接口（`preCheck` / `postAnalyze` hook 填充逻辑）
- [ ] 支持近线/远线模式切换（不同区域映射）
- [ ] 司机容量/时间窗可视化配置
- [ ] 多日历史记录对比
- [ ] 部署到云服务器（目前为本地 Web 应用）

## License

私有项目，仅供内部使用。
