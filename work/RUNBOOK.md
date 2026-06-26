# MTL 远线分单自动化 - RUNBOOK

> 每天 10 点:把司机 xlsx + 订单 xlsx 丢进 `work/inbox/`,跑 `node run.js`,一条命令出 Solution。

## 一次性准备

1. **装 Node.js**(已装 v22.22)+ **系统 unzip**(已装)。验证:
   ```bash
   node -v          # >= 18
   unzip -v         # Info-ZIP
   ```

2. **设 Routific token**(环境变量,避免每次粘贴 + 防泄漏):
   ```powershell
   [System.Environment]::SetEnvironmentVariable('ROUTIFIC_TOKEN', '<your-token>', 'User')
   # 验证(重开终端后):node -e "console.log(process.env.ROUTIFIC_TOKEN ? 'ok' : 'missing')"
   ```
   > ⚠ 旧版 probe.js 里硬编码的 token 已删除并 rotate。**永远不要**把 token 写进代码或 JSON。

3. **确认区域映射**(仅排班变动时改一次):编辑 `work/config/driver_zone_map.json`
   ```json
   { "MTL-Tony": { "zones": [2] }, "MTL-Faouzi": { "zones": [3] }, "MTL-Luke": { "zones": [] } }
   ```
   - key = 司机 Excel 里 `Driver Name` 列的值
   - zones = 负责的区域 ID,对应 `work/Mtl远线分单/区域图MTLFarMap.geojson` 里 polygon 的顺序(1/2/3)
   - 空数组 `[]` = 机动/不限区域

4. **确认仓库/班次**(仅搬迁或排班变更时改):编辑 `work/config/settings.json`

## 每日 10 点流程

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 1. 把当天司机 xlsx + 订单 xlsx 放进 `work/inbox/` | 手动拖文件 | 10 sec |
| 2. 跑 `node run.js` | 一条命令 | 10 sec |
| 3. 检查 `work/output/` 下的 CSV + unserved.csv + route_map.html | 手动 | 5 min |

**就这三步。** 不用解压 xlsx、不用手改 JSON、不用记三个命令。

## 命令详解

### 完整流程(默认)

```bash
cd C:\Users\Chris\Desktop\Mtl远线分单
node run.js
```

run.js 会自动:
1. 扫描 `work/inbox/*.xlsx`,**按表头自动识别**哪个是司机表(含 `Driver Name`)、哪个是订单表(含 `Name`+`Address`+`lng`+`lat`)——不用管文件名
2. 解压 xlsx → 解析司机表 → 生成 `work/driver_zones.json`(合并 settings + 区域映射)
3. 解析订单 + GeoJSON 点在多边形内分区 → 生成 `work/orders_with_zones.json`
4. 调用 Routific VRP API → 导出 `work/output/route_plan.json` + 每司机 CSV + `unserved.csv`
5. 生成交互地图 `work/output/route_map.html`

如果没设 `ROUTIFIC_TOKEN`,会停在步骤 3(解析+分区完成),提示你设 token 后重跑。

### 常用选项

| 命令 | 用途 |
|------|------|
| `node run.js` | 完整流程(token 已设则自动调 Routific) |
| `node run.js --routific` | 强制调 Routific(即使之前停在了分区阶段) |
| `node run.js --no-routific` | 只做解析+分区,不调 API(想先核对数据时用) |
| `node run.js --map` | 只重建地图(用已有 `output/route_plan.json`) |

## 输出文件

打开 `work/output/`:

| 文件 | 看什么 |
|------|--------|
| `route_plan.json` | 总览:totalTravelTime / numUnserved / 每司机 stops 数 |
| `MTL-Tony_route.csv` | Tony 当天配送顺序(直接给司机) |
| `MTL-Faouzi_route.csv` | Faouzi 当天配送顺序 |
| `MTL-Luke_route.csv` | Luke 当天配送顺序 |
| `unserved.csv` | 没派出去的单 + 原因,需人工处理 |
| `route_map.html` | 交互地图(双击打开),含路线/停点/工时窗/未派单 |

**CSV 列**: `seq,order,arrival_time,finish_time,address,lat,lng,ref,duration,load,zoneId`(UTF-8 BOM,Excel 直接打开)。

## 配置文件说明

| 文件 | 作用 | 何时改 |
|------|------|--------|
| `work/config/settings.json` | 仓库位置、班次时间、Routific 选项、routingMode | 仓库搬迁 / 排班变更 / 切换路由模式 |
| `work/config/driver_zone_map.json` | 司机 → 区域 映射 | **排班或区域划分变动时**(低频) |
| `work/Mtl远线分单/区域图MTLFarMap.geojson` | 区域边界多边形 | 区域重新划分时(在 geojson.io 画) |
| `work/driver_zones.json` | 当日司机配置 | **自动生成,勿手改** |
| `work/orders_with_zones.json` | 当日订单+分区 | **自动生成,勿手改** |

### routingMode 切换

`settings.json` 里:
- `all_in_one`(推荐):一次调用所有司机+所有 visit,Routific 自动按容量/时间窗分
- `per_driver_zone`:每个司机按 zones 过滤 visit 单独调用(zones 必须不重叠,适合业务上严格按区域派单)

## 常见情况

### 有 unserved 单

最常见原因:`cannot be visited within the constraints`(时间窗冲突)。

**判断产能瓶颈** — 看 `route_plan.json` 里每司机的 working window:

| working window | 含义 |
|----------------|------|
| < 10h | 司机有余力,可能是地理分布问题 |
| 10–12h | 正常 |
| 12–13h | 接近极限 |
| > 13h | 超出实际可工作时长,需要加人 |

**处理**:
1. 加司机 — 在 `driver_zone_map.json` 加映射,司机表里加行,重跑
2. 改 capacity — 货车装得下更多单,改司机表 `Capacity` 列
3. 放宽时间窗 — 改 `settings.json` 的 `options.max_visit_lateness`(默认 15min)/ `max_vehicle_overtime`(默认 30min)
4. 顺延到第二天 — unserved 单导出,第二天再送

### 网络/Token 失败

| 报错 | 原因 | 处理 |
|------|------|------|
| `Missing routific token` | env 没设或被清 | 重设 `ROUTIFIC_TOKEN` |
| `routific 401` | token 过期/错误 | 去 Routific 后台拿新 token |
| `routific 400` | payload 格式错 | 检查 `driver_zones.json` schema |
| `Routific call timeout` | 网络慢/防火墙 | 重跑;持续失败检查代理 |
| `解压 xlsx 失败` | 系统无 unzip | 装 Info-ZIP unzip |

### 文件识别不出来

run.js 靠表头识别文件类型。若提示"无法识别":
- 司机表必须含列:`Driver Name` + `Shift Start`
- 订单表必须含列:`Name` + `Address` + `lng` + `lat`
- 若上游改了表头,在 `work/lib/xlsx-reader.js` 的 `detectType()` 里加新表头

## 进阶:无人值守(L3)

在 L2 基础上,用 Windows 任务计划程序每天 10:05 自动触发(需文件已自动到位):

```powershell
# 创建定时任务(示例)
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "run.js" -WorkingDirectory "C:\Users\Chris\Desktop\Mtl远线分单"
$trigger = New-ScheduledTaskTrigger -Daily -At 10:05am
Register-ScheduledTask -TaskName "MTL远线分单" -Action $action -Trigger $trigger
```

前提:上游系统能在 10:00 前把 xlsx 自动下载到 `work/inbox/`(如从邮件/网盘拉取)。

## 目录结构

```
Mtl远线分单\
├── run.js                              <- 统一入口:node run.js
├── work\
│   ├── inbox\                          <- 每天投放 xlsx 的地方(司机表+订单表)
│   ├── config\
│   │   ├── settings.json               <- 仓库/班次/选项(低频改)
│   │   └── driver_zone_map.json        <- 司机->区域映射(低频改)
│   ├── lib\
│   │   └── xlsx-reader.js              <- xlsx 解析+类型识别(核心库)
│   ├── scripts\
│   │   ├── parse-drivers.js            <- 司机表->driver_zones.json
│   │   ├── assign-zones.js             <- 订单表+GeoJSON->orders_with_zones.json
│   │   ├── pipeline.js                 <- Routific 调用+导出
│   │   ├── build-map.js                <- 生成交互地图
│   │   └── build-zones.js              <- K-means 区域探索(可选,非日常)
│   ├── Mtl远线分单\
│   │   ├── 区域图MTLFarMap.geojson     <- 区域边界
│   │   └── 司机图表.jpg                <- 司机-区域映射参考图
│   ├── driver_zones.json               <- 自动生成(勿手改)
│   ├── orders_with_zones.json          <- 自动生成(勿手改)
│   └── output\
│       ├── route_plan.json             <- 总览 JSON
│       ├── MTL-*_route.csv             <- 司机路线 CSV
│       ├── unserved.csv                <- 未派单
│       └── route_map.html              <- 交互地图
```
