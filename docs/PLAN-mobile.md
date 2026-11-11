# 璇玑智脑 · 移动端适配执行计划（v1，2026-11-10 碧霄）

契约（唯一口径）：`docs/mobile-adaptation.md`
静态巡检脚本：`node /data/dsh/璇玑/tools/mobile-audit.mjs`
工作副本（可编辑）：`/data/dsh/璇玑/work`

## 现状基线（改动前实测）

- 13 个导航标签页中仅 3 个（知识库 / 工作流 / 设置）有移动端分支，其余为纯桌面布局。
- `src/index.css` 全文件 **0 条 `@media`**。
- 静态巡检硬红线 **21 条**（100vh 硬编码 15 处、无响应式 grid-cols-4 1 处、固定宽、表格无滚动容器等）。
- `Login.tsx` 引用 `--bg-deep/--bg-base/--card-bg/--input-bg/--border-c` 五个 **未定义** CSS 变量 → 登录页样式失效（移动端首屏即它）。
- `AuthLayout.tsx` 为**死代码**（全项目无引用）。

## 阶段 F：基座（碧霄自做，已完成）

| id | 内容 | 文件 | 验证 |
| --- | --- | --- | --- |
| F1 | 适配契约文档 | `docs/mobile-adaptation.md` | 人工 |
| F2 | 全局移动层（dvh 高度、表格滚动、安全区、热区、iOS 输入框 16px、横向溢出兜底） | `src/index.css` | `grep -c "@media" src/index.css` ≥ 2 |
| F3 | `useMediaQuery` + `useIsMobile` | `src/hooks/use-mobile.ts` | tsc |
| F4 | 标准移动抽屉（遮罩/Esc/滚动锁/安全区） | `src/components/MobileDrawer.tsx` | tsc |
| F5 | 外壳：顶栏移动菜单（可滚动、路由切换自动收起、含搜索与设置入口、44px 行高、ARIA）+ AppLayout 全高 | `src/components/TopNavbar.tsx`、`AppLayout.tsx` | 巡检 + E2E |

## 阶段 P：页面适配（子代理执行，文件互不重叠）

| id | 范围 | 文件 | 验证 |
| --- | --- | --- | --- |
| P1 | 知识脑图 | `pages/KnowledgeGraph.tsx`、`components/GraphControlPanel.tsx`、`NodeDetailPanel.tsx`、`KnowledgeGraphCanvas.tsx`、`BottomInfoBar.tsx` | audit + tsc |
| P2 | 知识库 + 文档详情 | `pages/KnowledgeBase.tsx`、`pages/DocumentDetail/{index,components}.tsx` | audit + tsc |
| P3 | 工作流 | `pages/WorkflowBuilder.tsx` | audit + tsc |
| P4 | 备份/入库/上传/收件箱 | `pages/BackupPage.tsx`、`pages/backup/BackupTargetConfig.tsx`、`pages/IngestionPage.tsx`、`pages/UploadPage.tsx`、`pages/ReviewInbox.tsx` | audit + tsc |
| P5 | Agent 管理 + API 中心 | `pages/AgentManagement.tsx`、`pages/APICenter.tsx` | audit + tsc |
| P6 | 数据源 + 检索台 + 检索结果 | `pages/DataSources.tsx`、`pages/SearchTestbed.tsx`、`pages/SearchResults.tsx` | audit + tsc |
| P7 | 分析/审计/登录/404 | `pages/AnalysisDashboard.tsx`、`pages/AuditLog.tsx`、`pages/Login.tsx`、`pages/NotFound.tsx`、`components/AnalysisCards.tsx` | audit + tsc |
| P8 | 3D 图谱四页 | `pages/KnowledgeGraphJelly.tsx`、`GraphWorkbench3D.tsx`、`KnowledgeGraphSpike3D.tsx`、`GraphSphere3D.tsx`、`pages/spike3d/{widgets,panels}.tsx` | audit + tsc |
| P9 | 设置主页 + 设置子面板 | `pages/Settings.tsx`、`pages/settings/{McpServersPanel,ModelsPanel,ZVecManagementPanel,ConnectorBrowser}.tsx` | audit + tsc |
| P10 | 通用 UI 层 + 全局浮层 | `components/ui/*`（dialog/sheet/drawer/table/tabs/pagination/select/command/dropdown 等）、`CommandPalette.tsx`、`ToastContainer.tsx`、`BgImageUpload.tsx`、`PermissionSelector.tsx`、`PageLoader.tsx`、`AuthGuard.tsx`、`ErrorBoundary.tsx` | audit + tsc |

## 阶段 V：验证与交付

| id | 内容 | 命令 / 证据 |
| --- | --- | --- |
| V1 | 静态巡检硬红线归零 | `node /data/dsh/璇玑/tools/mobile-audit.mjs` → `判定: PASS` |
| V2 | 类型检查 + 构建 | 宿主 `tsc-gate` 容器：`npx tsc -b` + `npm run build` |
| V3 | 390×844 逐路由 E2E | `local/xuanji-e2e` 容器跑 `sweep.mjs` → 无横向溢出 + 截图 |
| V4 | 两阶段评审 | 天演：①规格符合度（契约 1–12 逐条）②代码质量 |
| V5 | 部署 | 宿主 `docker compose build service-6a60d9f64d439e41ee4db8e1 && up -d`，镜像 ID 变化 + healthy |
| V6 | 记忆固化 | `write_memory(project="dsh")` |

## 回滚

- 代码：`/data/stack/src/xuanji11` 是 git 仓库（`main@2f002e1`），改动前打 `git stash`/分支，回滚 `git checkout .`。
- 镜像：现役 `local/xuanji:latest` = `1eaa17b3926b`（2026-11-03 22:06），部署前 `docker tag` 留底为 `local/xuanji:rollback-20261110`。

---

## 验收结论（2026-11-10 收官）

| 阶段 | 结果 |
|---|---|
| V1 静态巡检 | 103 文件 **0 硬红线**（基线 21） |
| V2 类型/构建 | `tsc -b` 0 错；`vite build` 通过；既有 5 测试文件 19 断言全绿 |
| V3 移动 390×844 | 26/26 路由 `scrollWidth-innerWidth = 0`；越界仅 `/audit`（表格在 table-scroll 内横滚，页级不溢出） |
| V3b 桌面 1280×900 | 改前/改后两次取证一致：overflow 0 / offenders 0，结构截图一致 |
| V4 天演评审 | 有条件通过；5 项 P0 修 4 项 + 1 项经截图判等价在案 |
| V5 部署 | 镜像 `1eaa17b3926b` → `ef497a1abb31`，`/health` ok，首页 200；回滚镜像 `local/xuanji:rollback-20261110` |

### 回修记录（天演 P0）
1. `MobileDrawer` 按 `isMobile` 门控渲染与 body 滚动锁（桌面 `open=true` 曾锁死桌面滚动）+ `onClose` 用 ref 持有
2. `SearchTestbed` 评测集两张卡片补 `min-w-0`（E2E 实测 390px 溢出 41px）
3. `AgentManagement` 移动端不挂载桌面常驻详情面板（消除 `datalist` 同 id 双实例）
4. `index.css` 移动端 16px 输入框补 `line-height: 1.25`（防紧凑输入框行高跳变）
5. `TopNavbar` 移动菜单补 Esc 关闭
6. `AuditLog` `sm:min-w-0` → `sm:min-w-full` 统一；`GraphWorkbench3D` 自动旋转滑杆移动端不再空操作

### 遗留（已知、非阻塞）
- 知识库右栏滚动容器由面板级下沉到内层（tabs 固定 + 列表滚动）：改前改后桌面截图目视一致，记为等价行为差异
- `ui/calendar.tsx` 用 Tailwind v4 语法（`size-(--cell-size)`），本仓 v3 下不生成；全项目零引用，未动
- shadcn HSL 变量全未定义（`--card`/`--border`/`--input`…），将来接 `ui/*` 组件前需先做变量桥接
- `AuthLayout.tsx` / `AuthLayoutSkeleton.tsx` 为死代码（零引用），内部 32px 热区未改
- `CommandPalette` 结果行 hover-only 箭头未配移动端常显（纯装饰）

### 交互级 E2E 补测（真机式指针点击，390×844）

| 用例 | 呼出钮 | 结果 |
|---|---|---|
| 知识库 · 目录抽屉 | `[打开知识库目录]` 40×40 | 开 → 锁 body → Esc 关 → 解锁 ✅ |
| 知识库 · 文档大纲面板 | `[打开大纲面板]` 40×40 | ✅ 同上（role=文档大纲面板） |
| 设置 · 栏目导航抽屉 | `[切换设置栏目]` 90×40 | ✅（role=设置栏目导航） |
| 数据源 · 配置面板 | `[添加数据源]` 112×40 | ✅ |
| API 中心 · 接口目录 | `[打开接口目录]` 72×40 | ✅ |
| Agent 管理 · 详情面板 | Agent 卡片 366×179 | ✅ |
| 知识脑图 · 图谱控制面板 | `[展开控制面板]` 40×40 | ✅（role=图谱控制面板） |
| 工作流 · 组件库/属性/触发器/运行记录 | 4×40×40 | ✅ 开合+锁 body+Esc 均正常（**缺 role="dialog"/aria-label，a11y 待补**） |
| 知识脑图 / 3D 水母 · 图例 | `[展开图例]` 40×40 | ✅ 开合正常（非模态浮层，不锁 body，符合预期） |
| 审计 · 表格横滚 | — | ✅ 容器 scrollWidth 640 > clientWidth 364，页级溢出 0 |

**结论：12/12 交互行为通过**（其中 6 个走 `MobileDrawer` 基座，具备 role/aria/关闭钮；工作流 4 个自建抽屉功能等价但缺 ARIA 语义）。

> 测试方法论教训：Playwright `locator.click()` 会因 DOM 中**桌面隐藏副本（0×0）在文档序中靠前**而超时，须按可见性过滤或改用坐标级 `mouse.click()`；跨用例共用 page 会让上一个用例留下的展开态污染下一个用例（曾误判「脑图控制面板点不动」）。

### 隐患排除（2026-11-10 第二轮，提交 d6bfd1b + f8a2b81）

**隐患一：shadcn HSL 变量全站未定义 → ui/* 组件静默失效**
- 先写守卫 `tools/theme-bridge-audit.mjs` 取 RED：27 个变量、0 个有定义（量化了隐患）
- 铺 GREEN：暗/亮两主题各补 27 个变量，三元组由调色板 hex 精确换算（27/27 PASS，防漂移校验通过）
- 顺带补 shadcn 标准 base 规则 `* { border-color: hsl(var(--border)) }`，一举覆盖 ui/* 的 64 处裸 border
  （加之前先实测影响面：全站仅 5 个元素受影响，改后默认灰边框元素 0/9 页）
- 暗色 `--muted-foreground` 映射改到 `--text-secondary`（对比 6.6:1；原 `--text-muted` 仅 2.5:1）
- 登录页去掉补偿性行内样式：按钮「青底白字 1.5:1」→「青底深字」，卡片背景/边框交回组件

**隐患二：知识库右栏桌面容器语义漂移**
- 右栏容器 `hidden md:flex flex-col overflow-hidden` → `hidden md:block overflow-y-auto`（= 基线 display/滚动语义）
- 内容区回普通块流（滚动交回面板级）、tabs 去 shrink-0；移动抽屉去掉多余内层包裹
- 结构验证：页签最近的可滚动祖先 = 那个 `md:block … overflow-y-auto` 面板本身（面板级滚动已还原）
- 像素验证：右栏区域（x≥1000）**diff = 0**；`/kb` 全图 0.616% 差异全落在左侧「最近编辑」动态列表

终版验收：动 26/26 与桌面 26/26 全绿、默认灰边框 0、登录/404 双主题目视正常、镜像 `77a14a1ed6dd` 健康。
