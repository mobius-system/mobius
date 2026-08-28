import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = relative => fs.readFileSync(path.resolve(here, '..', relative), 'utf8')

const app = read('src/App.tsx')
const settings = read('src/components/settings-panel.tsx')
const modals = read('src/components/modals.tsx')
const distribution = read('src/services/client-distribution.ts')

const distributionModalStart = modals.indexOf('function DesktopDownloadRowItem')
const distributionModalEnd = modals.indexOf('// 修改密码', distributionModalStart)
assert.ok(distributionModalStart >= 0 && distributionModalEnd > distributionModalStart, '客户端下载 Modal 源码边界必须存在')
const distributionModals = modals.slice(distributionModalStart, distributionModalEnd)

assert.match(distribution, /mobiusDesktop\?\.isDesktop === true[\s\S]*typeof clientWindow\.mobiusDesktop === 'undefined'[\s\S]*return 'unknown'/, '环境判断必须以 preload bridge 明确信号区分 Desktop / Web / unknown')
assert.doesNotMatch(distribution, /userAgent|navigator\.platform|MacIntel|Win32|Linux/, '客户端分发不得用 UA 或 navigator.platform 猜测环境')
assert.match(distribution, /DESKTOP_MANIFEST_URL[\s\S]*hasDesktopDownloadBuilds[\s\S]*response\.ok/, '桌面下载能力必须以后端 manifest 响应与内容为准')

assert.match(settings, /useState<'devices' \| 'clients' \| null>\(null\)/, '连接入口首屏必须默认收起，不能平铺平台动作')
assert.match(settings, /label="设备连接"[\s\S]*label="客户端与命令行"/, 'Settings 必须按任务分组呈现连接与客户端')
assert.match(settings, /aria-expanded=\{expanded\}[\s\S]*\{expanded && \([\s\S]*\{children\}/, '分组动作只能在用户展开后出现')

assert.match(settings, /data-client-runtime="unknown"[\s\S]*只保留使用文档[\s\S]*<ClientDocsLink/, '无法判断环境时只能退化到文档入口')
assert.match(settings, /clientRuntime === 'desktop' && typeof getDesktopDistributionBridge\(\)\?\.openStatusPanel === 'function'/, 'Desktop 本机动作必须由 bridge 具体能力守卫')
assert.match(settings, /clientRuntime === 'web' && desktopDownloadStatus === 'available'[\s\S]*label="桌面客户端"/, 'Web 只有在 manifest 可用时才能显示桌面下载入口')
assert.match(settings, /desktopDownloadStatus === 'unavailable'[\s\S]*actionLabel="重试"[\s\S]*桌面客户端下载暂不可用/, '下载能力失败必须留在分发入口附近并可重试')
assert.match(settings, /clientRuntime === 'web' && \([\s\S]*label="移动端链接"/, '移动端分发链接只能出现在 Web 分发环境')
assert.match(settings, /不会自动下载、安装或执行命令/, '分发入口必须明确所有动作都需要用户自行确认')

assert.match(app, /const clientRuntime = detectClientRuntime\(\)[\s\S]*clientRuntime === 'desktop'[\s\S]*<DesktopTabBar/, 'App 桌面挂载必须复用统一可信环境判断')

assert.match(modals, /DesktopDownloadRowItem[\s\S]*复制链接[\s\S]*copyDownloadLink/, '桌面构建链接必须可复制')
assert.match(modals, /MobileDownloadModal[\s\S]*copyMobileLink[\s\S]*复制链接/, '移动端链接必须可复制')
assert.match(modals, /TerminalInstallModal[\s\S]*navigator\.clipboard\.writeText\(command\)[\s\S]*复制失败，请手动选择上方命令复制/, 'CLI 命令复制失败必须就近反馈')
assert.match(modals, /AimuxGuideModal[\s\S]*navigator\.clipboard\.writeText\(text\)[\s\S]*复制失败，请手动选择上方内容复制/, 'AIMUX 命令复制失败必须就近反馈')
assert.doesNotMatch(distributionModals, /btn-primary|background:\s*'#0a84ff'/, '平台下载与 CLI 入口不得使用主动作样式')

console.log('P2-5 client distribution contract test passed')
