# macOS 桌面客户端签名与分发修复方案

## 1. 目的

解决 Mobius Desktop 的两个 macOS 包在下载后出现以下问题：

- 提示“无法验证开发者”“可能包含恶意软件”；
- Apple Silicon 机器提示应用已损坏，无法打开；
- ZIP 下载成功，但解压或启动失败；
- 下载页版本号与服务器实际文件不一致；
- 构建任务显示成功，产物却没有有效签名或公证。

修复完成后，arm64 和 x64 版本都应使用 Developer ID Application 证书签名，通过 Apple 公证，并能从网页正常下载、安装和首次启动。构建流程必须在发布前自动拦截未签名、未公证、架构错误或下载文件错误的产物。

本文只描述方案，不包含本次代码修改。

## 2. 当前实现及问题定位

### 2.1 有两套 electron-builder 配置

正式配置在：

- `mobius/desktop/electron-builder.yml`

这里已经声明：

- `hardenedRuntime: true`
- `notarize.teamId: 6FMVHL6RLY`
- `entitlements` 和 `entitlementsInherit`
- macOS 目标为 `dmg` 和 `zip`

但网站 `/desktop-builds/` 下的包由根目录 `build.py --build-electron` 生成。`build.py` 会创建一份临时 JSON，并通过 `electron-builder --config <临时文件>` 使用它。临时配置中的 macOS 部分是：

```python
"mac": {"target": ["zip"], "identity": None}
```

这会产生两个后果：

1. `identity: None` 显式关闭 macOS 签名；
2. 临时配置没有继承 `electron-builder.yml`，所以 hardened runtime、entitlements、公证和 DMG 配置都没有进入网站下载包。

因此，修改 `electron-builder.yml` 并不能修复 `build.py` 产出的 macOS 包。

### 2.2 Apple Silicon 包没有最低限度的代码签名

Apple Silicon 要求可执行文件至少带有 ad-hoc 签名。当前 `build.py` 产物是零签名包。浏览器下载又会给文件添加 `com.apple.quarantine` 属性，Gatekeeper 可能将其判定为“应用已损坏”，且无法通过普通方式放行。

Intel 包通常还能进入“无法验证开发者”的警告流程，所以两个 macOS 包会表现出不同症状。

ad-hoc 签名只能作为本地开发包的临时措施。正式分发必须使用 Developer ID Application 证书并完成 Apple 公证。

### 2.3 构建说明与实际配置矛盾

`.github/workflows/desktop-release.yml` 的注释称：

```text
mac.identity:null 已在 electron-builder.yml 配好
```

实际的 `electron-builder.yml` 没有 `identity: null`，而是希望 electron-builder 自动选择钥匙串里的 Developer ID Application 证书。Release Notes 又明确写着“macOS 包未签名”。

这说明当前流程对“正式包应该签名”还是“正式包允许免签”没有统一定义。

### 2.4 CI 没有验证签名和公证结果

当前工作流只检查目标 ZIP 是否存在，没有执行以下检查：

```bash
codesign --verify --deep --strict --verbose=2 "Mobius Desktop.app"
spctl --assess --type execute --verbose=4 "Mobius Desktop.app"
xcrun stapler validate "Mobius Desktop.app"
```

即使 electron-builder 因证书或 Apple 凭据缺失而跳过签名、公证，任务也可能继续发布。

### 2.5 构建资源不完整

`electron-builder.yml` 和 `build.py` 都引用：

```text
mobius/desktop/build/icon.png
```

该文件当前不存在，而且仓库根目录的 `.gitignore` 忽略所有 `build/` 目录。干净的 CI checkout 无法获得这个文件。`entitlements.mac.plist` 因为已被单独加入 Git，所以还在仓库中。

必须选择一种处理方式：

- 把图标作为正式构建资源纳入 Git；
- 或删除不存在的图标引用，并改用真实存在的图标文件。

不能让发布构建依赖某台机器上的未跟踪文件。

### 2.6 下载路由会把缺失文件伪装成 ZIP

`mobius/server.js` 先使用 `express.static` 提供 `/desktop-builds/`，随后有 SPA 的 `app.get('*')` 回退。

当桌面包不存在时，`express.static` 会继续执行后续中间件，SPA 回退可能返回 `index.html`，HTTP 状态仍是 200。浏览器会把 HTML 保存成 `.zip`。用户看到的是“ZIP 无法解压”或“应用无法安装”，而不是清楚的 404。

`/desktop-builds/` 和 `/mobile-builds/` 必须在静态文件未命中时直接返回 404，不得进入 SPA 回退。

### 2.7 版本来源不统一

当前至少有三处版本来源：

- `mobius/desktop/package.json`；
- `mobius/frontend/src/components/modals.tsx` 中的 `DESKTOP_VERSION`；
- Git tag 或 workflow_dispatch 输入值。

检查时，代码中的桌面版本是 `0.0.19`，下载弹窗仍是 `0.0.18`。截图中的生产环境显示 `0.0.22`，但该版本号不在当前 Git 树中。

版本漂移会让下载页请求一个服务器上不存在的文件，再触发上一节的 HTML 伪装问题。

### 2.8 macOS 15 之后的操作说明已过期

当前文案建议用户“右键 → 打开”。macOS 15 Sequoia 已取消对签名不正确或未公证软件的右键绕过。用户需要尝试打开一次，然后进入：

```text
系统设置 → 隐私与安全性 → 仍要打开
```

正式包完成签名和公证后，不应再要求普通用户执行这套绕过操作。

## 3. 目标方案

### 3.1 发布链路

发布链路统一为：

```text
Git tag / 手动触发
  → macOS 原生 runner 分别构建 arm64、x64
  → Developer ID Application 签名
  → Apple notarytool 公证
  → staple 公证票据
  → 自动验证签名、公证、架构和文件完整性
  → 生成 DMG、ZIP 和 manifest.json
  → 发布 GitHub Release
  → 将同一批已验证产物同步到服务器 /desktop-builds/
  → 下载弹窗读取 manifest.json
```

GitHub Release 与网站下载目录不能再分别构建。两处必须分发同一批二进制文件。

如果当前没有 CI 到产品服务器的部署凭据，可以先保留人工同步，但同步脚本必须校验 SHA-256，且禁止在服务器重新构建 macOS 包。

### 3.2 构建平台

- `mac-arm64`：在 Apple Silicon macOS runner 上构建；
- `mac-x64`：在 Intel macOS runner 上构建；如果 GitHub 不再提供 Intel runner，可在 Apple Silicon runner 上交叉构建 x64，但必须在 Intel Mac 或 Rosetta 环境补做启动测试；
- `win-x64`：继续在 Windows runner 上构建。

禁止在 Linux 或 Windows 主机上生成正式 macOS 发布包。macOS 的 codesign、notarytool、stapler 和标准 DMG 工具只在 macOS 上可用。

### 3.3 配置单一来源

`mobius/desktop/electron-builder.yml` 作为唯一完整配置。

`build.py` 不再维护 `EB_BASE_CONFIG` 的复制品。若仍需按架构设置独立输出目录和 Python 资源路径，可采用以下任一方式：

1. 生成只包含 `extends` 和少量覆盖项的临时配置；
2. 将目标 Python 复制到统一的 `resources/python` 后直接使用 yml；
3. 把构建逻辑移动到 Node 脚本，通过 electron-builder API 加载同一份配置。

无论采用哪一种，macOS 的签名、公证、entitlements、target 配置只能定义一次。

并行构建不得共享可变的 `resources/python` 目录。如果 arm64 和 x64 同时构建，必须使用独立工作目录或独立 CI job。

## 4. 实施步骤

### 阶段 A：收敛配置并修复下载错误

#### A1. 删除重复的 electron-builder 完整配置

修改 `build.py`：

- 删除 `EB_BASE_CONFIG`；
- 让每个目标继承 `mobius/desktop/electron-builder.yml`；
- 只覆盖输出目录和该目标的 Python 资源目录；
- macOS 目标不是在 Darwin 主机运行时，立即报错，不允许继续生成“看似成功”的包；
- 发布包构建不允许设置 `identity: null`；
- 不再由本地一次性命令并行构建三个平台。

本地开发如需免证书构建，可以提供显式的 `--dev-unsigned` 或 `--dev-adhoc` 选项。该选项生成的文件必须带 `-dev-unsigned` 后缀，且不能复制到 `/desktop-builds/` 或上传 Release。

#### A2. 修复构建资源

- 确认产品图标的唯一源文件；
- 使用 `.gitignore` 反向规则纳入所需文件，例如：

```gitignore
build/
!mobius/desktop/build/
!mobius/desktop/build/icon.png
!mobius/desktop/build/entitlements.mac.plist
```

- 在干净 checkout 中验证两个文件存在；
- 如果不准备使用 `icon.png`，删除 yml、`build.py` 和运行时代码对它的引用，不能保留悬空路径。

#### A3. 修复静态路由

修改 `mobius/server.js`：

- `/desktop-builds/` 静态文件未命中时直接返回 404；
- `/mobile-builds/` 同样处理；
- SPA 回退明确排除这两个前缀；
- ZIP 返回正确的 `Content-Type`；
- DMG 返回 `application/x-apple-diskimage`；
- 添加 `X-Content-Type-Options: nosniff`；
- `manifest.json` 使用 `Cache-Control: no-cache`；
- 带版本号的二进制文件可使用长期缓存。

自动测试至少覆盖：

```text
存在的 ZIP/DMG → 200，响应体是对应二进制
不存在的 ZIP/DMG → 404，不能返回 index.html
manifest.json → 200，no-cache
```

#### A4. 用 manifest 替代手写版本号

构建完成后生成：

```json
{
  "version": "0.0.22",
  "generatedAt": "2026-07-25T00:00:00Z",
  "builds": [
    {
      "platform": "mac",
      "arch": "arm64",
      "format": "dmg",
      "file": "mobius-desktop-0.0.22-mac-arm64.dmg",
      "size": 123456789,
      "sha256": "..."
    }
  ]
}
```

要求：

- 版本只从 `mobius/desktop/package.json` 或已校验的 tag 得出；
- tag 版本与 `package.json` 不一致时，发布任务失败；
- 下载弹窗打开时读取 `/desktop-builds/manifest.json`；
- 前端不再硬编码 `DESKTOP_VERSION`；
- 文件不存在、manifest 格式错误或版本不完整时，按钮显示“暂不可用”，不能仍然发起下载；
- macOS 默认提供 DMG，ZIP 可保留为备用下载。

### 阶段 B：签名和公证

#### B1. 准备 CI Secrets

在 GitHub Actions 中配置：

- `CSC_LINK`：Developer ID Application 证书的 `.p12`，可使用 Base64 或安全 URL；
- `CSC_KEY_PASSWORD`：`.p12` 密码；
- `APPLE_ID`：用于公证的 Apple ID；
- `APPLE_APP_SPECIFIC_PASSWORD`：Apple ID 专用密码；
- `APPLE_TEAM_ID`：`6FMVHL6RLY`。

更推荐使用 App Store Connect API Key 公证，避免 Apple ID 专用密码的维护问题。若采用 API Key，应按当前 electron-builder 版本支持的变量配置：

- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

两套公证凭据只能选一套，不要混用。工程师必须先核对 electron-builder `24.13.3` 与 `@electron/notarize 2.2.1` 的实际参数，再修改 workflow。

Secrets 不得写入仓库、日志、构建产物或 manifest。

#### B2. 正式签名配置

`electron-builder.yml` 应满足：

- 不设置 `identity: null`；
- `hardenedRuntime: true`；
- 使用 `build/entitlements.mac.plist`；
- 使用 `entitlementsInherit`；
- 配置 notarytool 公证；
- 输出 arm64 与 x64 的 DMG、ZIP；
- 最终产物命名稳定，不依赖脚本猜测 electron-builder 的默认文件名。

不要在正式签名流程中使用 `codesign --deep` 代替正确的嵌套签名。`--deep` 适合诊断或 ad-hoc 止血，不适合掩盖内部二进制签名错误。

内置的 python-build-standalone 包含 Python 可执行文件、动态库和扩展模块。必须确认 electron-builder/osx-sign 是否对 `extraResources` 中的所有 Mach-O 文件正确签名。如果公证报告指出某个嵌套文件没有安全时间戳、没有 hardened runtime 或签名无效，应增加 `afterSign` 脚本：

1. 使用 `file` 或 Mach-O magic 判断真正的 Mach-O 文件；
2. 按最内层到最外层的顺序签名；
3. 最后签名 `.app`；
4. 不要跟随符号链接重复签名；
5. 对 Electron 主程序、helpers 与 Python 二进制使用合适的 entitlements；
6. 每次签名后运行 `codesign --verify`。

不能简单地给所有 Python `.so` 套用 Electron 的 JIT entitlements。应根据 notarytool 报告和实际运行需要缩小权限。

当前 entitlements 中有：

```text
com.apple.security.cs.allow-jit
com.apple.security.cs.allow-unsigned-executable-memory
com.apple.security.cs.disable-library-validation
com.apple.security.cs.allow-dyld-environment-variables
```

实现时要确认每项是否仍有必要。Electron 通常需要 JIT；内置 Python 动态库可能需要关闭 library validation。`allow-dyld-environment-variables` 权限较宽，若运行时没有依赖，应删除。

#### B3. 公证与 staple

构建顺序必须是：

```text
打包 .app
→ Developer ID 签名
→ 验证签名
→ 提交 Apple 公证
→ 等待公证成功
→ staple 票据
→ 验证 staple
→ 生成或完成 DMG/ZIP
```

electron-builder 可以完成其中的大部分步骤，但 CI 仍需独立验证，不能只相信构建日志。

如果公证失败：

- workflow 必须失败；
- 不上传 GitHub Release；
- 不同步到 `/desktop-builds/`；
- 保存 notarytool 返回的 submission ID 和可公开诊断日志；
- 日志不得包含证书或账户凭据。

#### B4. 开发包的 ad-hoc 签名

没有 Apple 证书的本地开发构建可以在 `afterPack` 中执行：

```bash
codesign --force --deep --sign - --timestamp=none "Mobius Desktop.app"
```

用途仅限本地测试。该包仍未获得 Apple 信任，不能作为正式下载包。

发布任务必须检查签名 Authority 和 TeamIdentifier，拒绝 ad-hoc 包。仅检查 `codesign --verify` 不够，因为 ad-hoc 签名也能通过该命令。

### 阶段 C：CI 校验和分发

#### C1. 解包后验证

每个 macOS job 在上传产物前执行：

```bash
codesign --verify --deep --strict --verbose=2 "path/to/Mobius Desktop.app"
codesign -d --verbose=4 "path/to/Mobius Desktop.app"
spctl --assess --type execute --verbose=4 "path/to/Mobius Desktop.app"
xcrun stapler validate "path/to/Mobius Desktop.app"
```

并解析输出，确认：

- Authority 是预期的 Developer ID Application；
- TeamIdentifier 是 `6FMVHL6RLY`；
- Signature 不是 `adhoc`；
- Gatekeeper assessment 为 accepted；
- 公证票据存在；
- arm64 包主程序是 arm64，x64 包主程序是 x86_64；
- 包内 Python 与目标架构一致。

架构检查示例：

```bash
file "Mobius Desktop.app/Contents/MacOS/Mobius Desktop"
file "Mobius Desktop.app/Contents/Resources/python/bin/python3"
```

还要实际运行内置 Python：

```bash
"Mobius Desktop.app/Contents/Resources/python/bin/python3" --version
```

具体路径以最终包结构为准，脚本需兼容当前代码支持的单层和双层 Python 目录。

#### C2. 验证打包格式

- macOS 构建必须使用 macOS 原生工具，确保符号链接和可执行权限不丢失；
- 解压 ZIP 后检查 `bin/python3` 的符号链接和执行权限；
- 挂载 DMG，确认 `.app` 可复制到 `/Applications`；
- DMG 中应提供清楚的 Applications 目录入口；
- 产物生成后计算 SHA-256 和文件大小，写入 manifest。

#### C3. 端到端下载验证

同步到服务器后，发布任务或独立 smoke test 应执行：

```bash
curl -fL -o /tmp/mobius.dmg \
  "https://实际域名/desktop-builds/mobius-desktop-<version>-mac-arm64.dmg"

shasum -a 256 /tmp/mobius.dmg
file /tmp/mobius.dmg
```

校验下载文件的：

- HTTP 状态；
- Content-Type；
- Content-Length；
- SHA-256；
- 实际文件类型。

再请求一个不存在的版本，必须得到 404：

```bash
curl -i "https://实际域名/desktop-builds/mobius-desktop-does-not-exist-mac-arm64.dmg"
```

响应不能是 200，也不能包含产品页面的 `index.html`。

#### C4. 原子发布

服务器同步时先放到临时目录，全部文件和校验通过后再切换：

```text
desktop-builds/.staging-<version>/
→ 校验完整性
→ 原子移动到正式目录
→ 最后更新 manifest.json
```

manifest 必须最后更新，避免下载页先展示新版本，而二进制还没有上传完成。

旧版本至少保留一个发布周期，便于回滚。

## 5. 下载界面调整

下载弹窗建议改为：

- Apple Silicon：`macOS（M1 及更新芯片）`，默认下载 DMG；
- Intel：`macOS（Intel）`，默认下载 DMG；
- 展示版本、文件大小和 SHA-256 的短前缀；
- 提供“如何查看 Mac 芯片”帮助；
- 不自动隐藏另一个架构，避免浏览器识别错误；
- manifest 加载失败时显示明确错误；
- 不再展示“macOS 包未签名”；
- 若临时仍分发未公证开发包，单独标记为“开发测试包”，不得与正式包混在一起。

正式签名和公证完成前，macOS 15 的临时说明应写成：

```text
如果系统阻止打开，请先尝试启动一次，然后前往“系统设置 → 隐私与安全性”，在安全性区域选择“仍要打开”。
```

正式发布完成后，这段绕过说明应删除。正常用户不应该为了使用正式产品而降低系统安全设置。

## 6. 验收标准

以下项目全部通过后才能关闭问题。

### 构建

- [ ] `electron-builder.yml` 是唯一完整配置；
- [ ] `build.py` 不再包含重复的 macOS 签名配置；
- [ ] Linux/Windows 主机不能生成正式 macOS 包；
- [ ] 干净 checkout 可以找到全部构建资源；
- [ ] tag、`package.json` 和 manifest 版本一致；
- [ ] arm64、x64 使用独立 macOS job 构建。

### 签名和公证

- [ ] 两个 `.app` 都通过 `codesign --verify --deep --strict`；
- [ ] Authority 是公司的 Developer ID Application；
- [ ] TeamIdentifier 为 `6FMVHL6RLY`；
- [ ] 签名不是 ad-hoc；
- [ ] `spctl` 返回 accepted；
- [ ] `stapler validate` 通过；
- [ ] 断网环境下首次启动仍能通过 Gatekeeper 检查；
- [ ] 内置 Python 可以启动并创建虚拟环境；
- [ ] 首次安装 aimux 成功。

### 下载和安装

- [ ] Apple Silicon 真机下载 arm64 DMG、拖入 Applications、双击启动成功；
- [ ] Intel 真机或等价测试环境下载 x64 DMG并启动成功；
- [ ] 不出现“应用已损坏”；
- [ ] 不要求用户执行右键打开或关闭 Gatekeeper；
- [ ] 下载文件的大小和 SHA-256 与 manifest 一致；
- [ ] 不存在的文件返回 404；
- [ ] 下载按钮不会指向服务器上不存在的版本；
- [ ] DMG、ZIP 解包后符号链接与执行权限完整。

### 发布安全

- [ ] Secrets 未进入 Git、日志或产物；
- [ ] 公证失败时不会创建或更新 Release；
- [ ] 签名验证失败时不会同步到产品服务器；
- [ ] 支持回滚到上一版 manifest 和二进制；
- [ ] CI 日志能看出每个包的版本、架构、签名身份、公证状态和 SHA-256。

## 7. 建议实施顺序

1. 先完成阶段 A，消除配置漂移、错误 200 响应和版本错配；
2. 在单独分支完成阶段 B，用一个测试版本跑通证书签名和 Apple 公证；
3. 公证通过后补齐阶段 C 的验证和服务器同步；
4. 使用未公开的预发布版本在 Apple Silicon 和 Intel 环境验收；
5. 通过后再发布新版本，不要覆盖已有的错误产物。

如果证书或 Apple 公证凭据暂时拿不到，仍可完成阶段 A、CI 验证脚本和 ad-hoc 开发包支持。但不得把 ad-hoc 包标记为正式版本。
