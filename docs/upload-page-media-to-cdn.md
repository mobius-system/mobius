# 上传页面图片 / 视频到 CDN（nginx 静态托管 · 伪 CDN）

> 场景：网页 / 笔记里有本地图片、视频资源文件，需要得到**可直接访问的公网 CDN URL**，供分享的 Markdown/HTML 使用。
> 适用环境：agent-matrix 内网静态托管主机 `gptac-zs`（serve.nutshellai.cn）。2026-09-06 实测通过。

## 1. 目标产物

每个媒体文件对应一个公网 URL：

```
https://serve.nutshellai.cn/publish/auto/{folder}/{filename}
```

## 2. 关键环境变量（本机 tianyi / fuqingxu 视角）

| 变量 | 值 | 说明 |
|---|---|---|
| 发布主机别名 | `gptac-zs` | = `fuqingxu@111.36.208.22:12229`（ssh/aimux 已配好免密） |
| 远端静态根目录 | `/home/fuqingxu/publish/auto` | nginx 已托管，`/publish/auto/{folder}` ↔ 该目录 `{folder}` |
| 公网 URL 前缀 | `https://serve.nutshellai.cn/publish/auto` | 下载用 |
| 上传命令 | `aimux send_files gptac-zs <远端目录> <本地文件>…` | 等效 scp |
| 权限要求 | **644** | 否则 nginx 返回 403 |

> ⚠️ 历史文档里的别名 `GPTX-zs` + 路径 `/home/Arnold/publish/auto` 是**别的用户环境**（Arnold 的 ~/.ssh/config），本机不适用，直接用上表的 `gptac-zs` + `/home/fuqingxu/...`。

## 3. 完整流程

### 3.1 从数据源取出媒体文件（示例：思源笔记）
- 在思源 SQL 中按 `content LIKE '%assets/%'` 找到目标文档的媒体块，得到 `assets/xxx.png|mp4` 文件名。
- 下载：`GET {siyuan}/assets/{filename}`，请求头带 `Authorization: Token <token>`（文件名含中文时对路径段做 urlencode）。
- 或直接从任意本地路径取文件。

### 3.2 上传到静态目录
```bash
FOLDER="mobius-article"                      # 建议短、语义化
REMOTE="/home/fuqingxu/publish/auto/$FOLDER"

# 建目录
ssh gptac-zs "mkdir -p '$REMOTE' && chmod 755 '$REMOTE'"
# 上传（可一次多个文件）
aimux send_files gptac-zs "$REMOTE" file1.jpg file2.mp4 ...
# 修权限（否则 403）
ssh gptac-zs "chmod 644 '$REMOTE'/*"
```

### 3.3 校验（必须）
```bash
# 远端与本地 md5 一致
ssh gptac-zs "cd '$REMOTE' && md5sum *"          # 对比本地 md5sum
# 公网 URL HEAD 200 + Content-Type + Content-Length 与本地一致
curl -sI --max-time 20 "https://serve.nutshellai.cn/publish/auto/$FOLDER/$filename"
```

### 3.4（可选）替换正文引用
把源文档里的 `assets/xxx` 引用批量替换为上面公网 URL（图片/视频，注意保留原有布局样式）。

## 4. 文件名规则（重要教训，务必遵守）

- **文件名必须短、纯 ASCII、无中文、无空格、无 `% # &` 等特殊字符**。
- 原因：含中文的长文件名在部分工具/上下文里会被二次百分号转义（`%E5...` → `%25E5...`），导致 URL **打不开**。
- 推荐：小写字母 + 数字 + `-` + 扩展名，例如 `mobius-group.jpg`、`mobius-research.mp4`。

## 5. 本次实例（6 个媒体，已发布）

文件夹 `publish/auto/mobius-article`，公网前缀 `https://serve.nutshellai.cn/publish/auto/mobius-article/`

| 资源 | CDN 文件名 | URL |
|---|---|---|
| 智能体群示意图(jpg) | `mobius-group.jpg` | …/mobius-article/mobius-group.jpg |
| 多 Harness 协作图(png) | `mobius-harness.png` | …/mobius-article/mobius-harness.png |
| 系统总览/双通道图(png) | `mobius-channel.png` | …/mobius-article/mobius-channel.png |
| 只读协作演示(mp4) | `mobius-readonly.mp4` | …/mobius-article/mobius-readonly.mp4 |
| 双向交流演示(mp4) | `mobius-twoway.mp4` | …/mobius-article/mobius-twoway.mp4 |
| 研究系统演示(mp4) | `mobius-research.mp4` | …/mobius-article/mobius-research.mp4 |
