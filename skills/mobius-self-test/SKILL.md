---
name: mobius-self-test
description: Mobius 自我测试能力。部署后自动跑、也可手动跑一组 HTTP 冒烟(健康/鉴权/核心读 API/语音配置, 可选写往返), 快速确认重新部署后系统是否真的可用。当你怀疑系统异常、或刚部署完需要验收时使用。
---

## 何时使用

- 刚部署/重启完 Mobius 后端，需要确认服务正常
- 用户反馈"系统好像坏了"、"打不开"、"接口报错"
- 用户要求"跑个自检"、"检查下服务"
- 自我迭代修改后端代码后，验证没有破坏基本功能

## 触发方式

### 1. CLI（服务器上直接跑）

```bash
cd /app/mobius
npm run test:self-test
```

带写往返（建 memory → 列 memory → 删 memory）：
```bash
MOBIUS_SELF_TEST_WRITE=1 npm run test:self-test
```

### 2. HTTP 端点（agent/网页可触发）

```bash
curl -sS http://localhost:33316/api/admin/self-test \
  -H "Authorization: Bearer <admin-token>"
```

## 怎么看结果

- `✅` = 通过，`❌` = 失败，`⏭` = 跳过
- 末行 `SELF_TEST_JSON` 包含完整 JSON 报告
- 部署后自检日志：`/data/logs/self-test.log`
- 全 `✅` 且 `exit 0` = 系统正常
- 有 `❌` → 逐个检查失败项的错误信息

## 检查项目

| # | 类别 | 端点 | 说明 |
|---|---|---|---|
| 1 | 健康 | `GET /api/health` | `{"status":"ok"}` |
| 2 | 健康 | `GET /api/v2/health` | 版本信息 |
| 3 | 鉴权 | `GET /api/auth/config` | 认证配置 |
| 4 | 鉴权 | `GET /api/auth/me` | system token |
| 5 | 核心读 | `GET /api/projects` | 项目列表 |
| 6 | 核心读 | `GET /api/sessions/model-options` | 模型列表 |
| 7 | 核心读 | `GET /api/tasks/recent` | 最近任务 |
| 8 | 核心读 | `GET /api/extensions` | 扩展列表 |
| 9 | 搜索 | `GET /api/search?q=test` | 全局搜索 |
| 10 | 群聊 | `GET /api/conversations` | 群聊列表 |
| 11 | 会话 | `GET /api/sessions?limit=5` | 会话列表 |
| 12 | 语音 | `GET /api/assistant/tts/voices` | TTS 配置 |
| 13 | 上传 | `POST /api/upload` | 文件上传 (仅 write) |
| 14 | SSE | `GET /api/sessions/:id/events` | 流式连接 + 首事件 |
| 15 | 写 | POST→DELETE `/api/memories` | 往返 (仅 write) |

## 部署后自动自检

server.js 启动后自动跑（`MOBIUS_SELF_TEST_ON_BOOT=0` 可关闭）：
- 延迟 5s（等 server 完全就绪）
- 结果 append 到 `/data/logs/self-test.log`
- 失败绝不阻塞/崩 server
