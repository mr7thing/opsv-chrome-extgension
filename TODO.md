# Chrome Extension TODO

> 2026-06-10 — 基于侧面板调试发现的所有问题

---

## 🐛 Bug

### B1. Content Script 注入失败
- **现象**: `Could not establish connection. Receiving end does not exist.`
- **根因**: `chrome.tabs.sendMessage` 到 Gemini 标签页时 content.js 未注入
- **假设**: Gemini SPA 可能重定向（如登录页）、后台标签页未完全加载、CSP 阻止
- **影响**: 所有任务都无法执行

---

## 🧩 功能缺失

### F1. 无任务重试/手动运行入口
- **现象**: 任务失败后无法重试，页面上无任何操作按钮
- **期望**: 每个任务有 ▶ 运行 / 🔄 重试 按钮
- **现状**: 只有全局 "Run All"，且只运行 pending 状态的任务

### F2. "Run All" 不能重跑已失败任务
- **现象**: 失败后状态 = `failed`，Run All(N) 中 N = 0
- **期望**: 能 reset 失败任务到 pending 状态，或 Run All 包含 failed 任务

### F3. 结果图缩略图缺失
- **现象**: 任务完成/失败后，没有展示任何结果图预览
- **期望**: 任务卡片中有「Reference Image」和「Result Image」两个缩略图栏
  - Reference: 展示参考图（已实现 ✅）
  - Result: 展示生成结果图（未实现 ❌）
  - 都支持留空状态

### F4. 增量保存后 UI 不刷新
- **现象**: 拖放结果图增量保存后，daemon 广播 `INCREMENTAL_SAVED`，但侧面板只打日志
- **期望**: 收到广播后刷新对应任务卡片，显示新的结果缩略图

---

## ⚙️ 改进

### I1. AUTO 模式标签页后台打开不可见
- **现状**: `chrome.tabs.create({ active: false })` — 用户看不到
- **建议**: 改为 `active: true` 或增加视觉反馈（Toast 提示）

### I2. Content script 超时重试间隔过长
- **现状**: 5s / 10s / 15s 三档退避，最长等 30s
- **建议**: 缩短间隔，或改为主动检测 content script ready 状态

### I3. 错误信息不够详细
- **现状**: 只显示 "Receiving end does not exist"，没有上下文
- **建议**: 加上 "content script not ready on tab X, URL: Y, attempt Z/3"

---

## 📊 优先级

| 优先级 | 编号 | 说明 |
|--------|------|------|
| P0     | B1   | 根本问题，所有任务无法执行 |
| P1     | F1   | 失败后无法继续，体验极差 |
| P1     | F2   | Run All 形同虚设 |
| P2     | F3   | 完成的任务看不到结果 |
| P3     | F4   | 增量保存后无反馈 |
| P3     | I1   | 视觉反馈优化 |
| P3     | I2   | 性能优化 |
| P3     | I3   | 调试体验优化 |
