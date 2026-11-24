# MedTutor (`med-tutor`)

面向医学 / 药学课程的桌面端「揉书」AI 学习工作台。

> [!IMPORTANT]
> **学习辅助声明**：本项目仅用于医学、药学课程材料的整理、理解与复习，**不构成任何医疗或诊疗建议**；真实临床问题请遵循上级医师指导或院内正规流程。

## 项目缘起

本项目的核心学习方法源自我的另一份 Prompt / Skill 方法论仓库 —— [**med-ai-workflow-learning**](https://github.com/wangjirong670/med-ai-workflow-learning)（其中的 `med-study-knead` 揉书方法：**人交乱材料 → AI 揉出主干与证据锚点 → 人追问纠错并拍板沉淀**）。

在把这套方法真正用在日常医学课业里时，纯聊天窗口很快会遇到几个硬伤：整章教材硬塞上下文太贵、引文出处难回溯、纠正过的错话换一轮又死灰复燃、整理好的笔记散落在长聊天里不好导出。因此基于 **Pi SDK + Pi GUI** 做了这版桌面端成品 **MedTutor**，把方法论落成了可日常使用、可追溯、可续学的本地应用。

---

## 核心特性

- **对话为主 + 轻量侧边学习工作台**
  - 左侧医学编辑风主对话区（支持明/暗主题与全中文界面），自然完成“理主干 → 追问机制/鉴别 → 核对纠错”。
  - 右侧工作台同步呈现结构化多主张学习单、待核项与引用锚点，支持版本号防覆盖（乐观锁）与 Markdown 实时预览/导出。
- **多格式材料只读导入与精准定位**
  - 支持拖拽或选取 `.md` / `.txt` / `.pdf`（文本层提取）/ `.png` / `.jpg`（Windows 原生 OCR）导入。
  - 按稳定区间分段读取，避免每轮把整章塞进上下文；内置精确与忽略排版空白的引用定位诊断，**所有教材原件始终只读，绝不改动**。
  - 可通过 `MED_TUTOR_TEXTBOOK_ROOT` 指向自己的只读教材目录，方便一键选取。
- **19 个内置学习领域工具**
  - 大模型在对话中可按需自主调用材料读取、引用定位、学习单提交/修订/导出、纠错管理、个人画像与历史检索工具，并在合适节点自动同步学习单草稿。
- **纠错防复发与跨会话续学**
  - 将用户对 AI 错漏的纠正持久化绑定到会话分支，防止重启或上下文压缩后旧错复发。
  - 集成裁剪版 `pi-hermes-memory`，管理有界个人学习偏好（`USER.md`）并支持中文历史检索与原对话回跳。
- **原生多 Provider 接入与低成本控制**
  - 支持在应用设置页直接配置 OpenAI 兼容接口（DeepSeek、Moonshot、OpenAI 等），也支持通过 `.env` 自动桥接。
  - **默认关闭后台自动起标题、后台记忆复盘等隐式扣费请求**，只在你主动发送消息时消耗 Token。
  - 针对中文日常使用修复了 Windows IME 输入法组合态回车误发与跨会话草稿丢失问题。
- **独立 Windows 应用打包**
  - 内置 `electron-builder` 打包脚本，支持 ASAR 优化与无残留 NSIS 安装包构建。

---

## 架构概览

```text
┌─────────────────────────────────────────────────────────────────┐
│                    MedTutor 桌面应用（Electron）                 │
│  ┌──────────────────────────┬────────────────────────────────┐  │
│  │ 主对话区（Chat & Stream） │ 轻量侧边学习工作台（Workbench） │  │
│  │ • 揉书对话 / 追问 / 纠错  │ • 学习单预览 / 修订 / MD 导出  │  │
│  │ • 附件拖入 / 中文 IME     │ • 材料导入 / 分段阅读 / 定位   │  │
│  │ • 跨会话草稿自动保存      │ • 待核纠正 / 历史检索 / 画像   │  │
│  └──────────────┬───────────┴────────────────┬───────────────┘  │
│                 │ Electron IPC               │                  │
│  ┌──────────────▼────────────────────────────▼───────────────┐  │
│  │        Electron 主进程 + PiSdkDriver（进程内直驱）         │  │
│  │  • 原生 API-Key Provider / .env 自动桥接                   │  │
│  │  • 19 个医学学习领域工具 + med-study-knead 方法指令        │  │
│  │  • 默认零后台隐式扣费请求                                  │  │
│  └──────────────────────────────┬────────────────────────────┘  │
└─────────────────────────────────┼───────────────────────────────┘
                                  ▼
             本地持久化存储（会话分支 + 领域库 + USER.md）
```

---

## 快速开始

### 方式一：直接下载 Windows 安装包（推荐日常使用）

前往 [**GitHub Releases**](https://github.com/wangjirong670/med-tutor/releases/latest) 下载最新的 `MedTutor-*-x64-setup.exe` 安装包，安装后启动应用并在设置页填入你的 OpenAI 兼容 API Key（如 DeepSeek、Moonshot、OpenAI 等）即可开箱使用。

### 方式二：从源码运行与打包

#### 环境要求

- **操作系统**：Windows 10 / 11（x64，图片 OCR 依赖 Windows 原生 OCR，桌面打包脚本面向 Windows）
- **运行时**：Node.js 22+（核心逻辑）与 pnpm（桌面端 `pi-gui` 工作区依赖）

#### 1. 安装依赖

```bash
# 1) 安装根目录领域内核与测试依赖
npm install

# 2) 安装桌面端工作区依赖（pi-gui）
pnpm --dir scripts/pi-migration/s07/restore-r2/src/pi-gui install
```

#### 2. 配置模型接口（二选一）

- **方式 A（推荐）：应用内配置** — 启动桌面端后，直接在设置页或工作台配置面板填入你的 OpenAI 兼容 API Key、Base URL 与模型名称（如 DeepSeek、Moonshot、OpenAI 等）。
- **方式 B：`.env` 文件配置** — 复制 [`.env.example`](.env.example) 为 `.env`（`.env` 已被 `.gitignore` 忽略，不会进入 Git）：
  ```env
  MED_TUTOR_API_KEY=your_api_key
  MED_TUTOR_BASE_URL=https://api.deepseek.com/v1
  MED_TUTOR_STUDY_MODEL=deepseek-chat
  MED_TUTOR_QA_MODEL=deepseek-reasoner

  # 可选：个人只读教材库根目录（导入材料时默认打开该目录，绝不修改原件）
  # MED_TUTOR_TEXTBOOK_ROOT=D:/path/to/your-textbooks
  ```

#### 3. 构建、运行与打包

```bash
# 构建桌面端主进程 / 预加载 / 渲染层产物
npm run desktop:build

# 开发模式启动桌面端（需本地已准备 Electron 运行时）
npm run desktop:start

# 打包为独立 Windows NSIS 安装包 + 便携目录（输出至 dist-desktop/）
npm run desktop:package

# 仅打包免安装便携目录（dist-desktop/win-unpacked/MedTutor.exe）
npm run desktop:package:dir
```

> 根目录也提供 [`启动医学揉书桌面端.cmd`](启动医学揉书桌面端.cmd) 方便日常双击启动。

#### 4. 数据安全与备份

- 开发模式下的个人会话、学习单、材料副本与 `USER.md` 均保存在 `.study/personal/`（不纳入 Git）。
- 一键打包备份个人数据（自动保留最近 10 份至 `.study/backups/`）：
  ```bash
  npm run desktop:backup
  ```

#### 5. 运行测试

```bash
# 依次执行 Vitest 领域单测、TypeScript 类型检查、工作台与 IME 回归测试
npm run test:all
```

也可以分项运行：`npm test`、`npm run typecheck`、`npm run test:workbench`。

---

## 目录结构

```text
med-tutor/
├── method/med-study-knead/          # 医学揉书方法核心指令与参考规范
├── core/material/                   # 材料引用定位、学习单模型与校验核心
├── runtime/material/                # 材料导入、领域存储与 Markdown 导出
├── scripts/
│   ├── build-desktop.mjs            # 桌面端 electron-vite 构建脚本
│   ├── package-desktop.mjs          # Windows 独立应用 / NSIS 打包脚本
│   ├── start-desktop.ps1            # 桌面端开发启动脚本
│   ├── backup-personal-data.ps1     # 个人学习数据自动轮转备份脚本
│   ├── material_pdf.py              # PDF 文本层提取脚本
│   ├── windows-ocr.ps1              # Windows 本地图片 OCR 脚本
│   └── pi-migration/
│       ├── s07/restore-r2/src/pi-gui/        # 合一后的桌面端主工程（Electron + React）
│       ├── s08/learning-workbench-r4/        # 19 个领域工具核心与集成测试
│       └── s08/composer/r3/                  # 中文 IME 与草稿防丢回归测试
├── .env.example                     # 环境变量配置模板
├── AGENTS.md                        # 工程开发规范
├── ROOT_PLAN.md                     # 产品定位与架构设计说明
└── LICENSE                          # MIT License
```

---

## 致谢与开源协议

- **方法论与灵感来源**：[med-ai-workflow-learning](https://github.com/wangjirong670/med-ai-workflow-learning)
- **桌面端底座**：基于 [pi-gui](https://github.com/minghinmatthewlam/pi-gui)（MIT License, Copyright © 2026 Matthew Lam）与 Pi Coding Agent SDK 改造构建
- **偏好记忆扩展**：基于 [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)（MIT License, Copyright © 2025 Chandra Teja）裁剪集成

本项目遵循 [MIT License](LICENSE) 开源（各上游组件在其对应子目录中保留原有 MIT 版权声明）。
