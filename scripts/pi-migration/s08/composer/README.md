# S08C Composer 源码补丁与回归测试

此目录保存 S08C 阶段已验证的输入框中文 IME（`isComposing` 守卫）与主进程排队草稿持久化修复（R3）及其自包含离线回归测试。

- `QUEUED_DRAFT_SOURCE.patch`：R3 排队发送（`followUp` / `steer`）草稿保护补丁。
- `host-draft-regression.test.cjs`：24 个主进程草稿/排队回归测试（使用 `./fixtures/` 与 `s07/restore-r2` 的 TypeScript 编译器自包含运行）。
- `stage-runtime.mjs`：R3 运行时组装参考脚本。

注：历史测试夹具目录（`hydration-delay`、`queued-rejection-delay`、`send-receipt`、`send-rejection-delay`、`slow-reply`）及已被取代的 `r1/`、`r2/` 目录已于 2026-11-23 代码瘦身时清理。
