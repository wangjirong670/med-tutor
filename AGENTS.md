# med-tutor 工程开发规范

## 1. 产品定位与当前完成状态

面向医学/药学课程日常使用的桌面端「揉书」学习应用（详见 [ROOT_PLAN.md](ROOT_PLAN.md)）：
- **唯一主线**：以 **Pi SDK + Pi GUI** 为桌面端底座，采用**“对话为主 + 轻量侧边学习工作台”**交互形态。
- **核心能力**：
  - 19 个医学学习领域工具、Composer 中文 IME / 草稿防丢补丁与原生 React 学习工作台已合入 `pi-gui` 源码树，Electron 主进程直驱 `PiSdkDriver`。
  - 支持原生 API-Key Provider 界面配置与 `.env` 自动桥接（`med-tutor-env`）、PDF/图片 OCR 导入、多主张学习单自动同步与 Markdown 导出，默认关闭后台隐式扣费请求。
  - 提供独立 Windows 安装包打包脚本（`scripts/package-desktop.mjs`）、开发启动器（`scripts/start-desktop.ps1` / [启动医学揉书桌面端.cmd](启动医学揉书桌面端.cmd)）与个人数据备份脚本（`scripts/backup-personal-data.ps1`）。

## 2. 核心代码结构

- **揉书方法核心**：`method/med-study-knead/`（源自 [med-ai-workflow-learning](https://github.com/wangjirong670/med-ai-workflow-learning) 的揉书主干提炼与核对规范 skill）
- **领域核心与工具**：`core/material/`（引用定位、学习单模型与校验）、`runtime/material/`（材料导入、存储与导出）、`scripts/pi-migration/s08/learning-workbench-r4/`（19 个 Pi 领域工具核心与集成测试）
- **Pi GUI 桌面源码树**：`scripts/pi-migration/s07/restore-r2/src/pi-gui/`（已合入学习工作台、医学编辑风主题与 Composer R3 补丁的桌面端主工程）与 `scripts/pi-migration/s08/composer/r3/`（中文 IME 与草稿防丢回归测试）
- **构建与运维脚本**：`启动医学揉书桌面端.cmd`、`scripts/start-desktop.ps1`、`scripts/build-desktop.mjs`、`scripts/package-desktop.mjs`、`scripts/backup-personal-data.ps1`

## 3. 安全与成本底线

1. **原件只读**：用户通过 `MED_TUTOR_TEXTBOOK_ROOT` 配置的教材目录与导入文件保持只读，绝不篡改原件。
2. **凭据与费用可控**：严禁读取或输出 `.env` 密钥明文；默认关闭一切后台隐式大模型请求，未经用户明确授权不发起高成本批量真实模型调用。
3. **版本控制边界**：`.study/` 个人运行数据与 `dist-desktop/` 构建产物不提交进 Git。

## 4. 开发与验证工作流

- **单会话原地开发**：直接修改源码、原地修复 Bug、用标准 Git 管理版本。
- **直接运行测试**：修改后执行全量或对应验证：
  - `npm run test:all`（依次运行 `npm test`、`npm run typecheck`、`npm run test:workbench`）
  - 桌面端变更后在 `scripts/pi-migration/s07/restore-r2/src/pi-gui/apps/desktop` 检查 `npx tsc -p tsconfig.json --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit`，并用 `npm run desktop:build` 重新构建。
