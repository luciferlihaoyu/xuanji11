# 璇玑智脑 · 移动端适配契约（v1，2026-11-10 碧霄立）

> 本文件是「璇玑移动端适配」全部改动的**唯一口径**。任何页面改动都必须逐条满足本契约，
> 评审（天演）与 E2E 取证（390×844 视口逐路由）都按此判定。

## 0. 断点与目标

沿用 Tailwind 默认断点，**不新增自定义断点**：

| 名称 | 宽度 | 说明 |
| --- | --- | --- |
| mobile | `< 640px` | 主战场 360 / 390 / 430 |
| tablet | `640–1023px` | `sm:` / `md:` 区域 |
| desktop | `≥ 1024px` | `lg:`，**必须与改动前视觉一致** |

`useIsMobile()`（`src/hooks/use-mobile.ts`）判定阈值是 `< 768px`，用于需要 JS 分支（而非纯 CSS）的场合。
纯布局优先用 Tailwind 类，不要用 JS 分支。

## 1. 间距与容器

- 页面根容器：`p-6` 必须改为 `p-3 sm:p-5 lg:p-6`（横向留白 12px 起步，390px 屏不浪费）。
- 卡片内边距：`p-6` → `p-4 sm:p-6`；`p-4` 保持不变。
- 区块纵向间距：`space-y-6` / `gap-6` → `space-y-4 sm:space-y-6` / `gap-3 sm:gap-6`。
- 页面宽度限制 `max-w-*` 保留即可（居中容器天然安全）。

## 2. 高度与滚动（关键）

- **禁止 `100vh`**。移动浏览器地址栏会吞高度。用 `dvh`：
  - `h-[calc(100vh-48px)]` → `h-[calc(100dvh-48px)]`，或直接用基座工具类 `h-app` / `min-h-app`
    （= `calc(100dvh - 48px)`，48px 是顶栏高度）。
- 可滚动区域必须 `overflow-y-auto` **且** 父级链上有 `min-h-0`（flex 子项默认 `min-height:auto`，否则不滚）。
- 抽屉 / 模态内部滚动加 `overscroll-contain`，避免滚动穿透。
- 底部操作条：`pb-safe`（= `padding-bottom: max(0.75rem, env(safe-area-inset-bottom))`）。

## 3. 多列布局

- `grid-cols-3/4/5/6` **必须**加响应式前缀：`grid-cols-2 sm:grid-cols-3 lg:grid-cols-6`
  （390px 最多 2 列；统计卡这类短内容允许 `grid-cols-2`）。
- `flex` 横排工具栏：`flex flex-wrap gap-2`，或移动端 `flex-col`：`flex-col sm:flex-row`。
- 固定宽度 `w-[NNNpx]`（> 320）：改为 `w-full sm:w-[NNNpx]` / `max-w-[NNNpx] min-w-0`。

## 4. 侧栏 / 面板 / 抽屉

桌面常驻的左右侧栏，移动端必须是**抽屉**：

- 遮罩：`fixed inset-0 top-12 bg-black/50 z-40`（`top-12` = 顶栏 48px），点击关闭。
- 面板：`fixed top-12 bottom-0 z-50 w-[86vw] max-w-[340px]`，带标题栏与关闭按钮（≥40×40 热区）。
- 必须支持 `Esc` 关闭、`body` 滚动锁。
- 复用：优先用 `src/components/MobileDrawer.tsx`（新增基座组件），或沿用
  `Settings.tsx` / `KnowledgeBase.tsx` 已有写法，但行为必须同上。
- 移动端必须存在**可见的呼出入口**（工具栏上的图标按钮，≥40×40，`aria-label` 明确）。

## 5. 表格

- 一律包 `overflow-x-auto` 容器（可用基座类 `table-scroll`），并给表格 `min-w-[640px]`，
  使内容横向滚动而不是把整页撑破。
- 若列数 ≤ 4 且行结构简单，优先在移动端改为**卡片列表**（`<640` 用卡片，`≥640` 用表格）。
- 单元格内文字允许换行：`break-words`。

## 6. 触控与可点性

- 所有可点元素热区 **≥ 40×40**（图标按钮 `p-2` 起，列表行 `py-2.5` 起）。
  过小的用 `min-h-10 min-w-10` 补齐，或用基座类 `tap-target`。
- **禁止只靠 hover 暴露的功能**：凡 `onMouseEnter` 才显示的操作，移动端必须有常显或长按/菜单等价入口
  （常见修法：`opacity-100 sm:opacity-0 sm:group-hover:opacity-100`）。
- 拖拽类交互（画布、分栏）：移动端必须有非拖拽替代（按钮/抽屉/预设）。

## 7. 字号与可读性

- 正文 ≥ `text-xs`(12px)；`text-[10px]` 只允许用于角标/时间戳这类次要信息。
- 页面主标题：`text-xl sm:text-2xl`。
- 长文本容器 `break-words` / `min-w-0`，禁止被长 token 撑出横向滚动。

## 8. 横向溢出（硬红线）

390px 视口下**不允许**出现 `document.documentElement.scrollWidth > innerWidth`。
禁止用 `overflow-x: hidden` 掩盖问题——必须修根因（固定宽、绝对定位、`min-w`）。
基座只在 `html,body` 上做 `overflow-x: clip` 兜底，评审以「页面内无根因」为准。

## 9. 画布 / 3D 页面

- 画布容器 `touch-action: none`（只有画布本身，不含按钮/面板），其余区域正常滚动。
- 浮层面板：移动端默认折叠成小图标条，点击展开为抽屉或底部面板。
- `useIsMobile()` 时降低 draw 负担：`dpr` 上限 1.5、粒子/节点数减半或加提示，
  保证 390px 手机上可操作（不要求 60fps，要求可点、可看清、可关）。
- 提供移动端提示文案（例如「双指缩放 / 单指拖动」）。

## 10. 设置类页面（`/settings/*` 与各页内设置面板）

- 左侧分类导航 → 移动端抽屉（已有 `Settings.tsx` 实现，保持）。
- 每个分类下的表单：`grid-cols-2` → `grid-cols-1 sm:grid-cols-2`；
  行内 label+control 在移动端改上下堆叠（`flex-col sm:flex-row`）。
- 开关/输入框热区 ≥ 40px；保存按钮在移动端**全宽**（`w-full sm:w-auto`）并置于内容末尾或底部固定条。

## 11. 实现纪律

- **只改展示层**：`className` / 内联 `style` / JSX 结构 / 必要的新组件。不改 tRPC 接口、不改业务逻辑、
  不改数据库、不改测试断言里的业务语义。
- 不新增 npm 依赖；可复用现有 `src/components/ui/*`（`drawer`(vaul)、`sheet`(radix)、`dialog` 等）。
- 桌面（`≥1024px`）视觉必须与改动前一致：响应式前缀只加在 `sm:` / `lg:` 及以下的基准类上，
  不要改动 `lg:` 分支的既有值。
- 中文文案、拼音/英文占位保持一致，不顺手改文案。
- 每改一个文件，先读原文件再改；不要重排无关代码（避免 diff 噪声）。

## 12. 基座（已由碧霄落地，直接用）

| 资产 | 位置 | 用途 |
| --- | --- | --- |
| `useMediaQuery(q)` / `useIsMobile()` | `src/hooks/use-mobile.ts` | JS 分支判定 |
| `MobileDrawer` | `src/components/MobileDrawer.tsx` | 标准移动抽屉（遮罩 + Esc + 滚动锁） |
| `h-app` / `min-h-app` | `src/index.css` | `calc(100dvh - 48px)` 高度 |
| `table-scroll` | `src/index.css` | 表格横向滚动容器（隐藏滚动条 + 惯性滚动） |
| `no-scrollbar` | `src/index.css` | 隐藏滚动条（横向标签条） |
| `pb-safe` | `src/index.css` | 底部安全区（**在 components 层，优先级低于工具类**：与 `p-*` 同元素时会被覆盖，应写成 `px-* pt-* pb-safe`） |
| `tap-target` | `src/index.css` | ≥40×40 热区（同样在 components 层，`md:min-w-0` 可正常覆盖） |
| `touch-pan-canvas` | `src/index.css` | 画布专用 `touch-action` |

> 表格宽度写法：`min-w-[640px] sm:min-w-full`（窄屏保底横向滚动、≥640 还原原宽）为**允许写法**，
> 静态巡检脚本已按「class 串含 `sm:` 前缀即放行」处理，评审不得再判红。

## 13. 验收

1. `npx tsc -b` 通过（容器内 `npm run check`）。
2. `npm run build` 通过（vite + esbuild）。
3. 390×844 视口逐路由 E2E：无横向溢出；抽屉可开关；关键按钮可点（Playwright 取证）。
4. 天演评审：规格符合度（逐条对契约 1–12）+ 代码质量（无 hack、无 `!important` 滥用、无死代码）。

---

## 13. 主题变量契约（shadcn 桥接）— 2026-11-10 碧霄补

### 13.1 为什么需要
`tailwind.config.js` 把 `border / input / ring / background / foreground / card / popover / primary / secondary / muted / accent / destructive / sidebar-*`
全部映射成 `hsl(var(--x))`。这些 `--x` 在 `index.css` 里**原本一个都没定义** →
生成的 `background-color: hsl(var(--x))` 属 *invalid at computed-value time* → 回落到初始值（transparent）。
表现为 `ui/*` 组件（Card/Button/Input/Label/Dialog…）**静默失效**：卡片没底色、按钮没填充、边框是 Tailwind preflight 的 gray-200。
登录页曾因此白底白字。该隐患已于 2026-11-10 排除。

### 13.2 现状（27 个变量 × 双主题）
`index.css` 的 `:root[data-theme="dark"]` 与 `:root[data-theme="light"]` 各有一节「shadcn / radix UI 桥接」，
每个变量存 **HSL 三元组**（`H S% L%`，不带 `hsl()`），由既有调色板 token 的 hex 精确换算：

| shadcn 变量 | 来源 token（暗色） | 来源 token（亮色） |
|---|---|---|
| `--background` / `--foreground` | `--bg-primary` / `--text-primary` | 同 |
| `--card` / `--popover` | `--bg-panel` / `--bg-elevated` | 同 |
| `--primary` / `--ring` | `--accent-cyan` | 同 |
| `--primary-foreground` | `--bg-primary`（青底深字） | `#ffffff`（蓝底白字） |
| `--secondary` / `--accent` | `--bg-tertiary` | 同 |
| `--muted` / `--muted-foreground` | `--bg-secondary` / `--text-secondary` | 同 |
| `--destructive` | `--accent-red` | 同 |
| `--border` / `--input` | `--border-subtle` | 同 |

### 13.3 三条铁律
1. **改调色板必须同步改桥接**：`node tools/theme-bridge-audit.mjs` 会比对三元组与 hex 换算值（±1 容差），漂移即 FAIL。
2. **不要再用行内 `style={{background/color}}` 给 ui 组件兜底**。桥接已供值；行内覆盖典型后果就是登录页那版「青底白字」（对比 1.5:1）。
3. `@layer base` 里有一行 `*, ::before, ::after { border-color: hsl(var(--border)) }`（shadcn 官方写法），
   它让 64 处「只有宽度没有颜色」的裸 `border` 统一取主题边框色，而不是 preflight 的 gray-200。
   加这一行前实测影响面仅 5 个元素（脑图两组按钮、模型中心按钮组、404 卡片）。

### 13.4 门禁
`bash gate.sh` 现在串了三道：`mobile-audit`（移动端硬红线）→ `theme-bridge-audit`（变量覆盖+防漂移）→ `tsc -b` → `vite build`。
