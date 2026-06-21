# OpsV Chrome Extension — v0.5.4 重构计划

## 一、角色职责（谁干什么）

```
                     opsv CLI
                        │
                    IPC socket
                        │
                    ┌─────┴──────┐
                    │  daemon    │  ← 纯中继，不做文件存储
                    │ (native-   │
                    │  host.js)  │
                    └─────┬──────┘
                          │ WS
                    ┌─────┴──────┐
                    │ sidepanel  │  ← UI + 提示词编辑 + 附件管理
                    │ extension  │     ★ 唯一真相来源
                    │            │
                    │ content.js │  ← 自动操作 Gemini 页面
                    └────────────┘
```

| 组件 | 职责 | 不做什么 |
|------|------|---------|
| **opsv CLI** | 发任务（IPC），**收 INCREMENTAL_RESULT 自动 iterate + 更新 task JSON** | 不直接操作浏览器 |
| **daemon** (`native-host.js`) | IPC ↔ WS 双向中继，health check，文件 HTTP serve | 不做文件存储，不做任务调度 |
| **sidepanel** | 队列 UI，提示词编辑区，附件管理，手动 Run/Retry/Stop，拖放保存 | **不从 Gemini DOM 抓 prompt** |
| **content.js** | 粘贴图片、打字、点发送、检测出图 | 不存文件，不管理队列，不读用户修改后的 prompt |

## 二、核心交互设计（v5.4 新架构）

### 2.1 提示词编辑区（sidepanel）

每个任务卡展示原始 prompt（来自 task JSON）。用户可在 sidepanel **直接编辑**提示词、增删参考图附件。

```
┌─ Task: @hero ──────────────────────────────┐
│  Prompt:                                    │
│  ┌────────────────────────────────────────┐ │
│  │ a cat sitting on a chair, 16:9         │ │  ← 用户直接修改
│  └────────────────────────────────────────┘ │
│  Attachments:                               │
│  ┌─ refs/hero_ref_1.png ────────── [✕]──┐ │
│  ┌─ + Add attachment ────────────────────┐ │  ← 用户增删参考图
│                                             │
│  [Send to Gemini]  [Save as Draft]          │
└─────────────────────────────────────────────┘
```

**不从 Gemini DOM 抓 prompt**。sidepanel 本身就是唯一真相来源。

### 2.2 数据流

#### 自动模式（content.js 驱动）

```
opsv CLI 发任务
  → daemon → WS → sidepanel
  → sidepanel 展示任务卡（原始 prompt + refs）
  → 用户可选：编辑 prompt / 增删附件
  → 用户点 [Send to Gemini]
     → sidepanel 构造 EXECUTE_JOB 消息（含 modifiedPrompt + originalPrompt + refs）
     → chrome.tabs.sendMessage('EXECUTE_JOB') → content.js
       → 1. uploadReferenceImages
       → 2. typePrompt (使用 modifiedPrompt)
       → 3. clickSend
       → 4. waitForGeneration
       → 5. getBase64FromUrl
  → chrome.runtime.sendMessage('ASSET_SAVED', { shotId, base64, modifiedPrompt, originalPrompt })
     → sidepanel 收到 → sendWs('INCREMENTAL_RESULT')
     → daemon → IPC → opsv CLI
       → CLI: 对比 modifiedPrompt ≠ originalPrompt
              → opsv iterate → 更新 task_mN.json → 存产物
```

#### 手动拖图模式（用户操作）

```
用户：
  → 编辑 prompt / 增删附件
  → [Send to Gemini] → prompt + refs 注入到 Gemini
  → 手动点 Gemini 发送 → 出图
  → 从 Gemini 拖图到侧边栏任务卡
     → sidepanel 转 dataUrl
     → sendWs('INCREMENTAL_RESULT', { shotId, dataUrl, modifiedPrompt, originalPrompt })
     → daemon → IPC → opsv CLI (同自动模式)
```

### 2.3 消息格式

#### EXECUTE_JOB (sidepanel → content.js)

```json
{
  "type": "EXECUTE_JOB",
  "shotId": "@hero",
  "prompt": "a black cat on a chair",        // ← 用户改后的
  "referenceFiles": ["/path/ref.png"],
  "_original": {
    "prompt": "a cat sitting on a chair",    // ← task JSON 原始
    "referenceFiles": ["/path/orig.png"]
  }
}
```

#### INCREMENTAL_RESULT (extension → CLI)

```json
{
  "type": "INCREMENTAL_RESULT",
  "shotId": "@hero",
  "dataUrl": "data:image/png;base64,...",
  "modifiedPrompt": "a black cat on a chair",
  "originalPrompt": "a cat sitting on a chair",
  "modifiedRefs": ["/path/ref.png"],
  "originalRefs": ["/path/orig.png"]
}
```

## 三、CLI 端行为 (gemini.ts)

### 3.1 任务下发时带上 queueDir

```json
{
  "type": "generate",
  "queueDir": "/path/to/opsv-queue/circle1/model_001",
  "shotId": "@hero",
  "prompt": "...",
  "referenceFiles": [...]
}
```

### 3.2 收到 INCREMENTAL_RESULT

```
method handleIncrementalResult(data):
    taskJson = findTaskJson(data.shotId)       // 找到对应的 task JSON
    originalPrompt = taskJson.payload.prompt
    originalRefs = taskJson._opsv.references

    if modifiedPrompt ≠ originalPrompt || modifiedRefs ≠ originalRefs:
        // 自动迭代
        newTask = opsv_iterate(taskJson)       // → task_mN.json
        newTask.payload.prompt = modifiedPrompt
        if modifiedRefs: newTask._opsv.references = modifiedRefs
        saveTaskJson(newTask)
        productPath = queueDir / shotId_mN_1.png
    else:
        // 正常保存
        productPath = queueDir / shotId_1.png

    saveProduct(dataUrl, productPath)
```

### 3.3 核心理念

- **每次手动修改 = 自动迭代**：不会覆盖原始任务
- **原始任务保留**：可对比 task.json vs task_m1.json 看到改了什么
- **迭代由 CLI 管理**：扩展侧只管发回数据，不操心迭代逻辑

## 四、问题清单

### P0 - 扩展侧

| # | 问题 | 方案 |
|---|------|------|
| B1 | Content script 注入失败 | 回退 v0.4 clipboard+execCommand 方案 |
| — | sync 后 CLI 收不到回写 | daemon `sync` 不关 socket |
| — | base64 解析无保护 | 逗号检测 |

### P1 - 扩展侧

| # | 问题 | 方案 |
|---|------|------|
| F1 | 无重试/手动运行入口 | sidepanel 加 Run/Retry 按钮 |
| F2 | Run All 不重跑 failed | 支持 reset → pending |
| — | findTaskDir 递归太慢 | CLI 下发 queueDir |

### P2 - 扩展侧

| # | 问题 | 方案 |
|---|------|------|
| F3 | 结果缩略图不显示 | 修复文件路径 |
| F4 | 增量保存后 UI 不刷新 | 监听 INCREMENTAL_SAVED 刷新卡片 |
| — | URL 双斜杠 | daemon /files 路由兼容 |

## 五、UI 功能清单

### 恢复旧版

| 功能 | 说明 |
|------|------|
| Refresh Queue 按钮 | 手动刷新队列 |
| Skip 按钮 | 每任务可跳过 |
| Run All 进度条 | 自动跑完序号递进 |

### 新增 (v5.4)

| 功能 | 说明 |
|------|------|
| **提示词编辑区** | 每个任务卡内嵌文本框，直接编辑 |
| **附件管理** | 增删参考图，拖放添加 |
| **Send to Gemini** | 编辑后一键发送到 Gemini（注入 + 发送） |
| **修改记录对比** | 显示 originalPrompt vs modifiedPrompt |
| **结果缩略图** | 拖图保存后即时显示 |
| **版本号显示** | 侧边栏显示 v0.5.x |

## 六、实施顺序

### Phase 1 — P0 修复（扩展侧）
1. 修复 IPC sync 回写
2. 修复 base64 解析
3. 修复图片上传 (clipboard+execCommand)

### Phase 2 — CLI 端适配（本仓库）
1. `gemini.ts` 下发 queueDir
2. `gemini.ts` 处理 INCREMENTAL_RESULT
3. 自动 iterate + 更新 task_mN.json

### Phase 3 — UI 改进（扩展侧）
1. 提示词编辑区 + 附件管理
2. Send to Gemini 按钮
3. Refresh / Skip / Run All 功能
4. 结果缩略图修复

### Phase 4 — 集成测试
1. 端到端：CLI → extension → Gemini → INCREMENTAL_RESULT → CLI
2. 修改 prompt 触发自动迭代
3. 多任务并发

---

*文档版本：v2 — 2026-06-22*
*已整合 CLI 端配合方案*