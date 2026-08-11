import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { extCall } from '/extension/_sdk/ext.js';
import { createToyVisualSystem } from './visual-system.js?v=0.15.0';
import { createToyAudioSystem } from './audio-system.js?v=0.15.0';
import { createMusicEngine } from './music-engine.js?v=0.15.0';

const WORLD = Object.freeze({
  width: 20,
  depth: 30,
  spawnZ: -13.5,
  baseZ: 10.3,
  lanes: [-6, 0, 6],
  maxEnemies: 700,
  maxProjectiles: 260,
});
const MAX_CANNONS = 8;
// 修复基础科技与多炮台分摊后，正确的 L10 构筑约有 L1 的 60 倍输出；1.48 曲线让终局 Boss 约为 L1 的 57 倍，而非旧版 221 倍数学绝境。
const BOSS_HP_GROWTH = 1.48;

const THEMES = Object.freeze({
  zombie: {
    id: 'zombie',
    order: '01',
    title: '尸潮防线',
    english: 'HORDE OVERDRIVE',
    eyebrow: '把广告里玩不到的游戏真的做出来',
    description: '左右移动主炮阵列，在尸群中识别高频三路算术门。每次乘除、交换与武器特效选择都会决定指数生命 Boss 能不能被打穿。',
    features: ['10 关尸城战役', '随队算术门', '指数生命 Boss', '精英角色混编'],
    roster: ['腐烂行尸', '狂奔者', '屠夫肉盾', '变异精英', '巨型尸王'],
    speech: {
      normal: ['脑——子——在哪边？', '开门！社区送温暖！', '我只是路过吃个夜宵。', '这路怎么还有炮？'],
      runner: ['等等我，鞋跑掉了！', '冲错路了！先别开炮！', '我为什么跑这么快？', '前面的僵尸让一让！'],
      tank: ['轻点，我刚吃饱。', '大块头申请优先通行！', '这炮是在给我挠痒吗？', '谁把门修得这么结实？'],
      elite: ['谁把我从午睡里叫醒的？', '今天这座基地必须拆！', '我闻到了人类加班的味道。', '普通僵尸都靠边站！'],
      boss: ['都别挤，我才是尸王！', '广告里我可是最终主角！', '这城墙看起来很有嚼劲。', '三路都让开，我走中间！'],
    },
    startButton: '开始守城',
    startButtonHint: '点击后尸潮立即来袭',
    startHint: 'A / D 左右移动 · S 回到中路 · P 暂停 · 空格触发超载',
    brandKicker: 'AD FANTASY LAB / 01',
    leaderboardKicker: 'TOP SURVIVORS',
    leaderboardTitle: '尸潮最高战绩',
    baseLabel: '基地完整度',
    laneControlLabel: '主炮台横移',
    lanes: ['左路', '中路', '右路'],
    laneHint: '一次只能攻击当前一路；A / D 左右横移，点击战场可直接换路',
    weaponLabels: ['火力', '射速', '尸爆', '连锁', '冰冻'],
    upgradeEyebrow: '火力模块已就绪',
    upgradeTitle: '选择一项夸张升级',
    resumeLabel: '继续屠杀',
    roundDuration: 75,
    bossAt: 55,
    firstUpgradeAt: 10,
    upgradeInterval: 12,
    spawnMultiplier: 1,
    hpMultiplier: 1,
    speedMultiplier: 1,
    bossHpMultiplier: 1,
    bossSpeed: 0.42,
    palette: {
      bg: 0x07111f, fog: 0x07111f, ground: 0x102638,
      wall: 0x274e61, wallEmissive: 0x0d2d34, core: 0x4fffd2,
      accent: '#4fffd2', secondary: '#8fff65', yellow: '#ffd84f', projectile: 0xffe36d,
      enemies: { normal: 0x83f26e, runner: 0xffa943, tank: 0xb47cff, elite: 0xff668a, boss: 0xff4f5d },
    },
    bonus: {
      damage: ['▰', '高爆弹匣', '永久火力 +18%'],
      rate: ['⚡', '电磁供弹', '永久射速 +14%'],
      crit: ['◎', '猎杀标记', '永久暴击率 +5%'],
      mystery: ['?', '诅咒宝箱', '击破后揭晓隐藏大奖'],
      barrier: ['◇', '尸潮结界', '击碎可获得强化与炮台碎片'],
    },
    director: {
      frenzyIcon: '☣', frenzyLabel: '十倍尸潮', frenzyDescription: '8 秒敌潮 ×10，敌人变脆',
      overdriveIcon: '⚡', overdriveLabel: '火力超载', overdriveDescription: '10 秒伤害 ×2.45、射速 ×2.4',
      bossIcon: '♛', bossLabel: '尸王立即登场', bossDescription: '提前挑战本关指数生命 Boss',
      frenzyToast: '十倍尸潮已启动：密度拉满，但敌人会稍微变脆',
      frenzyBanner: 'TENFOLD HORDE',
      overdriveToast: '火力超载：伤害与射速暴涨 10 秒',
      overdriveBanner: 'FIREPOWER OVERDRIVE',
      bailoutToast: '防线濒危：隐藏救场协议自动触发',
      bailoutBanner: 'LAST STAND PROTOCOL',
      bossToast: '警告：巨型尸王突破封锁线',
      manualBossToast: '直播导演指令：尸王提前入场',
      bossBanner: 'OMEGA BOSS INBOUND',
    },
    bossName: '巨型尸王 · OMEGA',
    openingToast: '主炮台只打一条路：A / D 横移；算术门会混在尸群里，选对构筑才能击杀 Boss',
    victoryTitle: '防线守住了',
    victoryDescription: '广告里的那一局，这次真的打完了。你可以直接重开，或者继续用导演台折腾下一局。',
    defeatTitle: '城墙被吃光了',
    defeatDescription: '这局不是骗氪点，按一下就能原地再来。下一局会重新洗升级选项。',
    victoryBanner: 'OMEGA ELIMINATED',
    victoryToast: '巨型尸王已击杀：正在统计这场离谱战绩',
    upgrades: {
      damage: ['口径膨胀', '所有子弹伤害继续暴涨，普通尸群更快蒸发'],
      rate: ['射速失控', '当前战线的全部炮台射击间隔继续缩短'],
      blast: ['尸爆协议', '子弹命中产生范围爆炸，等级越高波及范围越大'],
      chain: ['连锁闪电', '命中有概率跳向附近敌人，形成可见的闪电链'],
      frost: ['绝对零度', '命中有概率冻结敌人两秒，减慢整片尸潮'],
      multi: ['分裂弹头', '当前战线同时锁定更多目标，子弹数量肉眼可见地增加'],
      cannon: ['炮台复制', '增加一座炮台；所有炮台仍然只攻击你当前选择的一路'],
      crit: ['暴击算法', '提高暴击概率与倍率，让伤害数字更不讲道理'],
      repair: ['防线焊死', '立即修复基地，并获得一段短暂火力加成'],
    },
  },
  deadline: {
    id: 'deadline',
    order: '02',
    title: '程序员保卫 DDL',
    english: 'SHIP IT OR DIE',
    eyebrow: '今晚不修完这些 Bug，谁都别想下班',
    description: '调度会敲键盘的救火工位，在需求队伍中识别高频评审算术门。每次扩编、裁员、冻结或调用链选择都会决定最终上线能否成功。',
    features: ['10 关上线战役', '随队评审门', '指数需求 Boss', '办公室角色混编'],
    roster: ['开发同事', '狂奔实习生', '产品经理', '暴躁 Leader', '甲方老板'],
    speech: {
      normal: ['开发：这 Bug 不是我引入的！', '开发：我本地明明是好的。', '开发：谁动了我的分支？', '开发：先让我看一下日志。'],
      runner: ['实习生：我直接改生产了！', '实习生：测试环境在哪儿？', '实习生：我只删了一个分号。', '实习生：Leader，我先提交啦！'],
      tank: ['产品经理：这个需求很简单。', '产品经理：就改亿点点。', '产品经理：用户说今天必须上。', '产品经理：按钮要五彩斑斓的黑。'],
      elite: ['Leader：今晚必须上线！', 'Leader：大家再坚持五分钟。', 'Leader：先解决问题，锅以后分。', 'Leader：进度为什么还是 99%？'],
      boss: ['甲方：上线前我再改一下。', '甲方：我不懂技术，但这很简单。', '甲方：明早给我看完整版本。', '甲方：原型不是已经能点了吗？'],
    },
    startButton: '开始上线',
    startButtonHint: '点击后立即进入救火模式',
    startHint: 'A / D 左右调度 · S 回到后端 · P 暂停 · 空格咖啡续命',
    brandKicker: 'AD FANTASY LAB / 02',
    leaderboardKicker: 'TOP ENGINEERS',
    leaderboardTitle: '上线最高战绩',
    baseLabel: '服务器稳定度',
    laneControlLabel: '救火小组调度',
    lanes: ['前端', '后端', '生产'],
    laneHint: '一次只修当前服务；A / D 左右调度，点击战场可直接切换',
    weaponLabels: ['修复', '编译', '异常', '调用链', '冻结'],
    upgradeEyebrow: '新的补丁已经通过 Review',
    upgradeTitle: '选择一项上线前热修',
    resumeLabel: '继续救火',
    roundDuration: 70,
    bossAt: 50,
    firstUpgradeAt: 9,
    upgradeInterval: 11,
    spawnMultiplier: 1.08,
    hpMultiplier: 0.82,
    speedMultiplier: 1.04,
    bossHpMultiplier: 0.92,
    bossSpeed: 0.47,
    palette: {
      bg: 0x071022, fog: 0x071022, ground: 0x101d39,
      wall: 0x263d73, wallEmissive: 0x0b2861, core: 0x62a8ff,
      accent: '#62a8ff', secondary: '#45f0d0', yellow: '#ffca5c', projectile: 0x88d9ff,
      enemies: { normal: 0xff5c6c, runner: 0xffc857, tank: 0x7c83ff, elite: 0xd66bff, boss: 0xff3d81 },
    },
    bonus: {
      damage: ['⌘', '热修补丁', '永久修复力 +18%'],
      rate: ['☕', '咖啡补给', '永久处理速度 +14%'],
      crit: ['✓', '一次通过', '永久无警告率 +5%'],
      mystery: ['?', '隐藏需求', '击破后揭晓离谱加成'],
      barrier: ['▦', '流程结界', '击穿可获得算力与团队碎片'],
    },
    director: {
      frenzyIcon: '⚠', frenzyLabel: '需求井喷', frenzyDescription: '8 秒需求量 ×10，需求变脆',
      overdriveIcon: '☕', overdriveLabel: '咖啡续命', overdriveDescription: '10 秒修复 ×2.45、处理速度 ×2.4',
      bossIcon: '☎', bossLabel: '甲方立即来电', bossDescription: '提前触发本关指数需求 Boss',
      frenzyToast: '群聊里突然多了 99+ 条新需求：需求井喷已启动',
      frenzyBanner: 'SCOPE CREEP ×10',
      overdriveToast: '咖啡因超频：编译与热修速度暴涨 10 秒',
      overdriveBanner: 'CAFFEINE OVERCLOCK',
      bailoutToast: '生产环境濒危：自动执行紧急回滚与咖啡续命',
      bailoutBanner: 'EMERGENCY ROLLBACK',
      bossToast: '警告：上线前临时改需求正在冲击生产环境',
      manualBossToast: '直播导演指令：甲方提前来电',
      bossBanner: 'CLIENT CALL INBOUND',
    },
    bossName: '上线前临时改需求 · FINAL',
    openingToast: '救火小组一次只修一个服务：A / D 调度；评审门混在需求里，选对构筑才能拒绝甲方',
    victoryTitle: '居然准时上线了',
    victoryDescription: '所有 Bug 被压进了发布包，临时需求也被当场打回。现在可以再模拟一次更离谱的上线夜。',
    defeatTitle: '生产环境炸了',
    defeatDescription: '服务器没有永久损坏。点击重来，下一次可以更早使用紧急回滚和咖啡续命。',
    victoryBanner: 'SHIPMENT SUCCESS',
    victoryToast: '临时改需求已被拒绝：正在生成上线战报',
    upgrades: {
      damage: ['代码热修', '每次修复能够消灭更多 Bug，严重异常也会快速掉血'],
      rate: ['咖啡因超频', '真实缩短当前服务的编译与部署间隔'],
      blast: ['异常连锁', '修掉一个异常时顺便清理附近同类堆栈'],
      chain: ['调用链追踪', '沿调用关系跳转并修复附近 Bug'],
      frost: ['冻结需求', '临时冻结需求流入，为生产环境争取时间'],
      multi: ['多线程处理', '当前服务同时锁定更多问题并行修复'],
      cannon: ['召集支援小组', '增加一个会敲键盘的救火工位；所有小组仍只处理当前服务'],
      crit: ['一次过编译', '提高无警告通过概率，出现夸张的绿色通过数字'],
      repair: ['紧急回滚', '恢复服务器稳定度，并获得短暂咖啡因加成'],
    },
  },
});

// 两个题材各自拥有 10 关。角色复用五套高质量剪影，但通过体型、颜色、速度、生命和身份台词形成更多可辨认角色。
const ENEMY_ROLES = Object.freeze({
  zombie: {
    shambler: { name: '腐烂行尸', visual: 'normal', hp: 1, speed: 0.94, scale: 1, score: 11, damage: 5, tint: 0xffffff, weight: 34, lines: ['行尸：我就散个步。', '行尸：这条路以前没炮。'] },
    crawler: { name: '贴地爬尸', visual: 'normal', hp: 0.58, speed: 1.48, scale: 0.72, score: 13, damage: 4, tint: 0xb6ff9b, weight: 19, lines: ['爬尸：低姿态也要挨炮？', '爬尸：我从地板下面来的。'] },
    sprinter: { name: '红眼狂奔者', visual: 'runner', hp: 0.66, speed: 1.72, scale: 0.76, score: 16, damage: 5, tint: 0xffd28a, weight: 18, lines: ['狂奔者：刹车坏了！', '狂奔者：前面的让一让！'] },
    spitter: { name: '酸液喷吐者', visual: 'runner', hp: 1.45, speed: 0.88, scale: 1.08, score: 26, damage: 8, tint: 0x9cff75, weight: 10, lines: ['喷吐者：请保持酸性距离。', '喷吐者：今天胃不太舒服。'] },
    bloater: { name: '腐肉胖尸', visual: 'tank', hp: 3.3, speed: 0.55, scale: 1.44, score: 38, damage: 13, tint: 0xd8bdff, weight: 12, lines: ['胖尸：我只是骨架比较大。', '胖尸：炮弹能不能少放辣？'] },
    armored: { name: '装甲防暴尸', visual: 'tank', hp: 5.1, speed: 0.45, scale: 1.6, score: 58, damage: 16, tint: 0xa7c6d8, weight: 8, lines: ['装甲尸：盾牌是单位发的。', '装甲尸：今天谁都别想通关。'] },
    mutant: { name: '双臂变异体', visual: 'elite', hp: 6.1, speed: 0.74, scale: 1.72, score: 105, damage: 20, tint: 0xff8ea1, weight: 7, lines: ['变异体：普通僵尸靠边！', '变异体：我有两倍的拥抱。'] },
    screamer: { name: '尖啸女尸', visual: 'elite', hp: 4.8, speed: 0.96, scale: 1.48, score: 96, damage: 18, tint: 0xff82e7, weight: 7, lines: ['尖啸者：啊——麦克风开了吗？', '尖啸者：这只是我的高音。'] },
    nestGuard: { name: '尸巢守卫', visual: 'elite', hp: 8.8, speed: 0.54, scale: 2.05, score: 155, damage: 24, tint: 0xe776ff, weight: 5, lines: ['守卫：母巢禁止参观！', '守卫：先过我这一吨。'] },
    alpha: { name: '阿尔法尸将', visual: 'elite', hp: 12.5, speed: 0.43, scale: 2.35, score: 240, damage: 30, tint: 0xff536d, weight: 4, lines: ['尸将：这一波由我带队。', '尸将：炮台数量报一下。'] },
  },
  deadline: {
    bug: { name: '普通线上 Bug', visual: 'normal', hp: 1, speed: 0.96, scale: 1, score: 11, damage: 5, tint: 0xffffff, weight: 32, lines: ['Bug：我本地无法复现。', 'Bug：我已经存在三年了。'] },
    intern: { name: '直推生产实习生', visual: 'runner', hp: 0.63, speed: 1.76, scale: 0.76, score: 17, damage: 5, tint: 0xffd073, weight: 18, lines: ['实习生：我直接推生产啦！', '实习生：回滚按钮在哪儿？'] },
    qa: { name: '穷举测试同事', visual: 'normal', hp: 1.32, speed: 0.9, scale: 1.08, score: 22, damage: 7, tint: 0x85e9ff, weight: 16, lines: ['测试：我又发现了 37 个。', '测试：这不是偶现，是必现。'] },
    product: { name: '五彩斑斓产品经理', visual: 'tank', hp: 3.4, speed: 0.56, scale: 1.44, score: 40, damage: 13, tint: 0x9b92ff, weight: 12, lines: ['产品：这个需求很简单。', '产品：只改亿点点。'] },
    ops: { name: '报警轰炸运维', visual: 'runner', hp: 1.75, speed: 1.08, scale: 1.05, score: 34, damage: 9, tint: 0xffa66b, weight: 10, lines: ['运维：报警群已经 99+！', '运维：磁盘又满了！'] },
    architect: { name: '重构架构师', visual: 'tank', hp: 5.3, speed: 0.46, scale: 1.6, score: 64, damage: 17, tint: 0x8ac7ff, weight: 8, lines: ['架构师：我们先重写一遍。', '架构师：这个抽象还不够纯。'] },
    security: { name: '安全审计专家', visual: 'elite', hp: 6.4, speed: 0.72, scale: 1.7, score: 112, damage: 21, tint: 0xd389ff, weight: 7, lines: ['安全：这里有高危漏洞。', '安全：先全部下线再说。'] },
    leader: { name: '暴躁技术 Leader', visual: 'elite', hp: 5, speed: 0.94, scale: 1.5, score: 102, damage: 19, tint: 0xff7bb7, weight: 7, lines: ['Leader：今晚必须上线！', 'Leader：为什么还是 99%？'] },
    clientRep: { name: '驻场甲方代表', visual: 'elite', hp: 9.2, speed: 0.53, scale: 2.02, score: 165, damage: 25, tint: 0xff7292, weight: 5, lines: ['甲方代表：我再加一个小需求。', '甲方代表：原型不是能点了吗？'] },
    executive: { name: '拍脑袋业务总监', visual: 'elite', hp: 13, speed: 0.42, scale: 2.34, score: 250, damage: 31, tint: 0xff4f7e, weight: 4, lines: ['总监：明早我要全球上线。', '总监：技术问题你们解决。'] },
  },
});

const CAMPAIGNS = Object.freeze({
  zombie: [
    { title: '封锁线外缘', description: '基础尸群，熟悉三路火力和随队推进的算术门。', duration: 64, bossAt: 45, spawn: 0.82, hp: 0.72, speed: 0.9, bossHp: 1, roles: ['shambler', 'crawler', 'sprinter'], boss: '门卫尸长 · 大门牙', bossTint: 0xff6f65, bossScale: 3.05 },
    { title: '废弃便利店', description: '腐肉胖尸开始顶在队伍前面，错误选择会明显漏怪。', duration: 68, bossAt: 48, spawn: 0.86, hp: 0.78, speed: 0.93, bossHp: 1.05, roles: ['shambler', 'crawler', 'sprinter', 'bloater'], boss: '冰柜屠夫 · FROZEN', bossTint: 0x9ddfff, bossScale: 3.15 },
    { title: '地铁末班车', description: '狂奔者和喷吐者混编，要求更快切换攻击路线。', duration: 72, bossAt: 51, spawn: 0.91, hp: 0.84, speed: 0.97, bossHp: 1.1, roles: ['shambler', 'sprinter', 'spitter', 'bloater'], boss: '站台尖啸者 · LINE 13', bossTint: 0xff78dc, bossScale: 3.25 },
    { title: '医院夜班', description: '装甲尸出现，算术选择开始决定能否穿透前排。', duration: 76, bossAt: 54, spawn: 0.97, hp: 0.9, speed: 1, bossHp: 1.16, roles: ['crawler', 'spitter', 'bloater', 'armored'], boss: '缝合护士长 · NIGHT SHIFT', bossTint: 0xd8c2ff, bossScale: 3.35 },
    { title: '高速收费站', description: '变异精英加入冲线，炮台数量和单发火力需要取舍。', duration: 80, bossAt: 57, spawn: 1.03, hp: 0.96, speed: 1.03, bossHp: 1.22, roles: ['shambler', 'sprinter', 'armored', 'mutant'], boss: '收费站暴君 · NO EXIT', bossTint: 0xff685f, bossScale: 3.45 },
    { title: '地下实验室', description: '尖啸者和变异体混进杂兵潮，错误构筑会被精英压垮。', duration: 84, bossAt: 60, spawn: 1.09, hp: 1.02, speed: 1.06, bossHp: 1.3, roles: ['shambler', 'sprinter', 'spitter', 'armored', 'mutant', 'screamer'], boss: '失控实验体 · SUBJECT 06', bossTint: 0xd35bff, bossScale: 3.55 },
    { title: '工业尸巢', description: '尸巢守卫混在大量杂兵中，需要成型的爆炸、连锁或分裂构筑。', duration: 88, bossAt: 63, spawn: 1.15, hp: 1.08, speed: 1.08, bossHp: 1.38, roles: ['shambler', 'crawler', 'bloater', 'mutant', 'screamer', 'nestGuard'], boss: '孵化母体 · HIVE MOTHER', bossTint: 0xff55c8, bossScale: 3.65 },
    { title: '军事封锁区', description: '杂兵掩护装甲精英推进，Boss 生命正式进入指数区间。', duration: 92, bossAt: 66, spawn: 1.21, hp: 1.14, speed: 1.1, bossHp: 1.46, roles: ['shambler', 'sprinter', 'armored', 'mutant', 'nestGuard', 'alpha'], boss: '装甲尸将 · WARLORD', bossTint: 0xff514f, bossScale: 3.78 },
    { title: '核心尸城', description: '小怪与高阶角色全量混编，必须围绕前几次选择规划终局。', duration: 97, bossAt: 70, spawn: 1.27, hp: 1.21, speed: 1.12, bossHp: 1.56, roles: ['crawler', 'spitter', 'armored', 'screamer', 'nestGuard', 'alpha'], boss: '双头尸皇 · TWIN CROWN', bossTint: 0xff3d72, bossScale: 3.92 },
    { title: '终焉防线', description: '最终试炼：清理杂兵、击穿精英并连续做对算术选择，才有机会击杀尸王。', duration: 104, bossAt: 76, spawn: 1.34, hp: 1.28, speed: 1.15, bossHp: 1.68, roles: ['shambler', 'sprinter', 'mutant', 'screamer', 'nestGuard', 'alpha'], boss: '巨型尸王 · OMEGA', bossTint: 0xff2e4f, bossScale: 4.15 },
  ],
  deadline: [
    { title: '本地开发', description: '普通 Bug 与直推实习生，先熟悉工单算术门。', duration: 62, bossAt: 44, spawn: 0.86, hp: 0.68, speed: 0.93, bossHp: 0.96, roles: ['bug', 'intern', 'qa'], boss: '合并冲突 · FIRST BLOOD', bossTint: 0xff7182, bossScale: 3.05 },
    { title: '测试环境', description: '测试同事不断补单，产品经理开始作为肉盾推进。', duration: 66, bossAt: 47, spawn: 0.89, hp: 0.75, speed: 0.97, bossHp: 1.02, roles: ['bug', 'intern', 'qa', 'product'], boss: '回归测试清单 · 999+', bossTint: 0x8b9cff, bossScale: 3.14 },
    { title: '三方联调', description: '报警运维加入战场，反馈流速明显加快。', duration: 70, bossAt: 50, spawn: 0.94, hp: 0.82, speed: 1, bossHp: 1.08, roles: ['bug', 'qa', 'product', 'ops'], boss: '接口字段改名 · V2 FINAL', bossTint: 0xffa25f, bossScale: 3.24 },
    { title: '需求评审', description: '产品与架构师组成厚血前排，需要重新评估团队编制。', duration: 74, bossAt: 53, spawn: 1, hp: 0.89, speed: 1.03, bossHp: 1.14, roles: ['intern', 'product', 'ops', 'architect'], boss: '五彩斑斓 PRD · 88 页', bossTint: 0xac8cff, bossScale: 3.34 },
    { title: '灰度发布', description: '安全审计首次出现，单纯堆射速已经不够。', duration: 78, bossAt: 56, spawn: 1.06, hp: 0.96, speed: 1.06, bossHp: 1.2, roles: ['qa', 'ops', 'architect', 'security'], boss: '灰度异常 · 1% 用户全炸', bossTint: 0xd474ff, bossScale: 3.44 },
    { title: '大促前夜', description: '普通 Bug 掩护 Leader 和报警一起到场，选择错误会拖垮生产稳定度。', duration: 82, bossAt: 59, spawn: 1.12, hp: 1.03, speed: 1.08, bossHp: 1.28, roles: ['bug', 'intern', 'product', 'ops', 'security', 'leader'], boss: '零点大促 · TRAFFIC ×100', bossTint: 0xff6da8, bossScale: 3.54 },
    { title: '生产事故', description: '普通工单与驻场甲方组成精英波次，工单构筑必须开始成型。', duration: 86, bossAt: 62, spawn: 1.18, hp: 1.1, speed: 1.1, bossHp: 1.36, roles: ['bug', 'qa', 'architect', 'security', 'leader', 'clientRep'], boss: '生产全红 · SEV-0', bossTint: 0xff4f68, bossScale: 3.64 },
    { title: '安全审计', description: '普通 Bug 混入高血量审计与甲方代表，Boss 生命进入指数区。', duration: 90, bossAt: 65, spawn: 1.24, hp: 1.17, speed: 1.12, bossHp: 1.44, roles: ['bug', 'intern', 'ops', 'security', 'leader', 'clientRep'], boss: '合规整改 · DEADLINE TODAY', bossTint: 0xe154ff, bossScale: 3.76 },
    { title: '董事会 Demo', description: '杂项反馈掩护业务总监加入战线，每一次算术选择都在决定演示生死。', duration: 96, bossAt: 69, spawn: 1.3, hp: 1.24, speed: 1.14, bossHp: 1.54, roles: ['bug', 'qa', 'security', 'leader', 'clientRep', 'executive'], boss: '董事会临时演示 · LIVE', bossTint: 0xff3f88, bossScale: 3.9 },
    { title: '全球上线', description: '最终试炼：清理普通工单、压住精英需求并形成指数级输出，才能拒绝最终需求。', duration: 102, bossAt: 75, spawn: 1.38, hp: 1.32, speed: 1.17, bossHp: 1.66, roles: ['bug', 'intern', 'architect', 'leader', 'clientRep', 'executive'], boss: '全球上线前临时改需求 · FINAL', bossTint: 0xff285f, bossScale: 4.12 },
  ],
});

const els = {
  shell: document.getElementById('gameShell'),
  stage: document.getElementById('stage'),
  fxCanvas: document.getElementById('fxCanvas'),
  brandKicker: document.getElementById('brandKicker'),
  brandTitle: document.getElementById('brandTitle'),
  level: document.getElementById('levelValue'),
  score: document.getElementById('scoreValue'),
  kills: document.getElementById('killsValue'),
  combo: document.getElementById('comboValue'),
  time: document.getElementById('timeValue'),
  baseHpText: document.getElementById('baseHpText'),
  baseHpFill: document.getElementById('baseHpFill'),
  baseStatusLabel: document.getElementById('baseStatusLabel'),
  bossHud: document.getElementById('bossHud'),
  bossName: document.getElementById('bossName'),
  bossHpText: document.getElementById('bossHpText'),
  bossHpFill: document.getElementById('bossHpFill'),
  bonusDamageValue: document.getElementById('bonusDamageValue'),
  bonusRateValue: document.getElementById('bonusRateValue'),
  cannonMetricLabel: document.getElementById('cannonMetricLabel'),
  shardMetricLabel: document.getElementById('shardMetricLabel'),
  cannonCountValue: document.getElementById('cannonCountValue'),
  cannonShardValue: document.getElementById('cannonShardValue'),
  bonusCountValue: document.getElementById('bonusCountValue'),
  soundBtn: document.getElementById('soundBtn'),
  pauseBtn: document.getElementById('pauseBtn'),
  directorPanel: document.querySelector('.director-panel'),
  directorToggle: document.getElementById('directorToggle'),
  frenzyBtn: document.getElementById('frenzyBtn'),
  frenzyIcon: document.getElementById('frenzyIcon'),
  frenzyLabel: document.getElementById('frenzyLabel'),
  frenzyDescription: document.getElementById('frenzyDescription'),
  overdriveBtn: document.getElementById('overdriveBtn'),
  overdriveIcon: document.getElementById('overdriveIcon'),
  overdriveLabel: document.getElementById('overdriveLabel'),
  overdriveDescription: document.getElementById('overdriveDescription'),
  bossBtn: document.getElementById('bossBtn'),
  bossIcon: document.getElementById('bossIcon'),
  bossButtonLabel: document.getElementById('bossButtonLabel'),
  bossButtonDescription: document.getElementById('bossButtonDescription'),
  speedRange: document.getElementById('speedRange'),
  speedLabel: document.getElementById('speedLabel'),
  autoPickInput: document.getElementById('autoPickInput'),
  laneButtons: [...document.querySelectorAll('.lane-button')],
  laneControlLabel: document.getElementById('laneControlLabel'),
  laneLabels: [0, 1, 2].map((index) => document.getElementById(`laneLabel${index}`)),
  laneHint: document.getElementById('laneHint'),
  damageChipLabel: document.getElementById('damageChipLabel'),
  rateChipLabel: document.getElementById('rateChipLabel'),
  blastChipLabel: document.getElementById('blastChipLabel'),
  chainChipLabel: document.getElementById('chainChipLabel'),
  frostChipLabel: document.getElementById('frostChipLabel'),
  damageLevel: document.getElementById('damageLevel'),
  rateLevel: document.getElementById('rateLevel'),
  blastLevel: document.getElementById('blastLevel'),
  chainLevel: document.getElementById('chainLevel'),
  frostLevel: document.getElementById('frostLevel'),
  toast: document.getElementById('toast'),
  overdriveBanner: document.getElementById('overdriveBanner'),
  startOverlay: document.getElementById('startOverlay'),
  startEyebrow: document.getElementById('startEyebrow'),
  startTitle: document.getElementById('startTitle'),
  startEnglish: document.getElementById('startEnglish'),
  startDescription: document.getElementById('startDescription'),
  enemyRoster: document.getElementById('enemyRoster'),
  featureRow: document.getElementById('featureRow'),
  themeButtons: [...document.querySelectorAll('.theme-card')],
  levelPicker: document.getElementById('levelPicker'),
  levelTitle: document.getElementById('levelTitle'),
  levelDescription: document.getElementById('levelDescription'),
  levelEnemyHint: document.getElementById('levelEnemyHint'),
  levelBossHint: document.getElementById('levelBossHint'),
  startBtn: document.getElementById('startBtn'),
  startButtonLabel: document.getElementById('startButtonLabel'),
  startButtonHint: document.getElementById('startButtonHint'),
  startHint: document.getElementById('startHint'),
  leaderboardList: document.getElementById('leaderboardList'),
  leaderboardKicker: document.getElementById('leaderboardKicker'),
  leaderboardTitle: document.getElementById('leaderboardTitle'),
  identity: document.getElementById('identityValue'),
  upgradeOverlay: document.getElementById('upgradeOverlay'),
  upgradeEyebrow: document.getElementById('upgradeEyebrow'),
  upgradeTitle: document.getElementById('upgradeTitle'),
  upgradeCountdown: document.getElementById('upgradeCountdown'),
  upgradeOptions: document.getElementById('upgradeOptions'),
  pauseOverlay: document.getElementById('pauseOverlay'),
  pauseRunLabel: document.getElementById('pauseRunLabel'),
  pauseScoreValue: document.getElementById('pauseScoreValue'),
  pauseKillsValue: document.getElementById('pauseKillsValue'),
  pauseBaseValue: document.getElementById('pauseBaseValue'),
  pauseLevelBtn: document.getElementById('pauseLevelBtn'),
  pauseThemeBtn: document.getElementById('pauseThemeBtn'),
  pauseThemeHint: document.getElementById('pauseThemeHint'),
  pauseExitBtn: document.getElementById('pauseExitBtn'),
  resumeBtn: document.getElementById('resumeBtn'),
  resumeButtonLabel: document.getElementById('resumeButtonLabel'),
  restartBtn: document.getElementById('restartBtn'),
  resultOverlay: document.getElementById('resultOverlay'),
  resultEyebrow: document.getElementById('resultEyebrow'),
  resultTitle: document.getElementById('resultTitle'),
  resultDescription: document.getElementById('resultDescription'),
  finalScore: document.getElementById('finalScore'),
  finalKills: document.getElementById('finalKills'),
  finalCombo: document.getElementById('finalCombo'),
  finalRank: document.getElementById('finalRank'),
  newBestBadge: document.getElementById('newBestBadge'),
  againBtn: document.getElementById('againBtn'),
  againButtonLabel: document.getElementById('againButtonLabel'),
  menuBtn: document.getElementById('menuBtn'),
};

const fxCtx = els.fxCanvas.getContext('2d');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;
const formatScore = (value) => Math.max(0, Math.round(value)).toLocaleString('zh-CN');
const cssHex = (value) => `#${Number(value).toString(16).padStart(6, '0')}`;
const roundedBox = (width, height, depth, radius = 0.06, segments = 4) => new RoundedBoxGeometry(width, height, depth, segments, radius);

function mulberry32(seed) {
  let value = seed >>> 0;
  return function random() {
    value += 0x6D2B79F5;
    let n = value;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

let muted = localStorage.getItem('toy-toy-toy-muted') === '1';
const audioSystem = createToyAudioSystem({
  getTheme: () => state.themeId,
  getElapsed: () => state.elapsed,
  muted,
});
const sfx = audioSystem.sfx;

function ensureAudio() {
  return audioSystem.unlock();
}

// Procedural BGM: layered synthwave/industrial loop scheduled on the audio
// clock, riding the dedicated music bus inside the audio system.
const music = createMusicEngine({
  getContext: () => audioSystem.musicOutput()?.context || null,
  getOutput: () => audioSystem.musicOutput(),
  masterVolume: 0.4,
});
let musicMode = 'off'; // off | menu | battle | boss

function musicThemeName() {
  return state.themeId === 'deadline' ? 'chiptune' : 'industrial';
}

function musicIntensity() {
  const threat = Math.min(1, enemies.length / 260);
  const timeRamp = Math.min(1, state.elapsed / 70) * 0.3;
  const overdrive = state.elapsed < state.overdriveUntil ? 0.14 : 0;
  return clamp(0.34 + threat * 0.45 + timeRamp + overdrive, 0, 1);
}

function syncMusic() {
  if (muted) return;
  if (state.mode === 'playing') {
    const boss = state.bossAlive;
    const target = boss ? 'boss' : 'battle';
    if (musicMode !== target) {
      musicMode = target;
      music.start({ theme: musicThemeName(), intensity: musicIntensity(), boss });
    }
    music.setBossMode(boss);
    music.setIntensity(musicIntensity());
  } else if (state.mode === 'menu' || state.mode === 'result') {
    if (musicMode !== 'menu') {
      musicMode = 'menu';
      music.start({ theme: musicThemeName(), intensity: 0.16, boss: false });
    }
    music.setBossMode(false);
    music.setIntensity(0.16);
  } else {
    music.setIntensity(0.12);
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
els.stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07111f);
scene.fog = new THREE.FogExp2(0x07111f, 0.011);

const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 100);
const cameraHome = new THREE.Vector3(0, 23, 25);
camera.position.copy(cameraHome);
camera.lookAt(0, 0, 1.5);

scene.add(new THREE.AmbientLight(0xd8f4ff, 1.35));
scene.add(new THREE.HemisphereLight(0xaeefff, 0x102238, 2.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(-7, 17, 6);
scene.add(keyLight);
const baseLight = new THREE.PointLight(0x4fffd2, 11, 22, 2);
baseLight.position.set(0, 3, 10);
scene.add(baseLight);

const worldGroup = new THREE.Group();
scene.add(worldGroup);

const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x102638, roughness: 0.82, metalness: 0.16, emissive: 0x0c3a34, emissiveIntensity: 0.12 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(WORLD.width + 1, WORLD.depth + 2), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -0.11, 0);
worldGroup.add(ground);

const grid = new THREE.GridHelper(31, 31, 0x3a8096, 0x1a4052);
grid.position.y = -0.075;
grid.material.transparent = true;
grid.material.opacity = 0.46;
worldGroup.add(grid);

for (const x of [-3, 3]) {
  const divider = new THREE.Mesh(
    new THREE.PlaneGeometry(0.08, WORLD.depth),
    new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.12 }),
  );
  divider.rotation.x = -Math.PI / 2;
  divider.position.set(x, -0.055, 0);
  worldGroup.add(divider);
}

const focusLaneMaterial = new THREE.MeshBasicMaterial({
  color: 0x4fffd2,
  transparent: true,
  opacity: 0.075,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const focusLaneGlow = new THREE.Mesh(new THREE.PlaneGeometry(5.25, WORLD.depth), focusLaneMaterial);
focusLaneGlow.rotation.x = -Math.PI / 2;
focusLaneGlow.position.set(0, -0.045, 0);
worldGroup.add(focusLaneGlow);

const focusRailMaterial = new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.75 });
const focusRail = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.08, 0.16), focusRailMaterial);
focusRail.position.set(0, 0.06, 9.55);
worldGroup.add(focusRail);

for (let side = -1; side <= 1; side += 2) {
  for (let i = 0; i < 11; i += 1) {
    const height = 0.6 + ((i * 17) % 9) * 0.22;
    const ruin = new THREE.Mesh(
      new THREE.BoxGeometry(0.75 + (i % 3) * 0.22, height, 1.1 + (i % 4) * 0.25),
      new THREE.MeshStandardMaterial({
        color: i % 2 ? 0x19354a : 0x142d40,
        roughness: 0.88,
        emissive: i % 3 === 0 ? 0x102d36 : 0x000000,
        emissiveIntensity: 0.45,
      }),
    );
    ruin.position.set(side * (10.8 + (i % 2) * 0.8), height / 2 - 0.08, -12.5 + i * 2.55);
    ruin.rotation.y = side * (0.08 + (i % 4) * 0.05);
    worldGroup.add(ruin);
  }
}

const baseGroup = new THREE.Group();
worldGroup.add(baseGroup);

const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0x274e61,
  roughness: 0.52,
  metalness: 0.62,
  emissive: 0x0d2d34,
  emissiveIntensity: 0.8,
});
const wall = new THREE.Mesh(new THREE.BoxGeometry(20.5, 1.5, 1.35), wallMaterial);
wall.position.set(0, 0.75, 11.25);
baseGroup.add(wall);

for (let i = -9; i <= 9; i += 2) {
  const light = new THREE.Mesh(
    new THREE.BoxGeometry(0.85, 0.12, 0.08),
    new THREE.MeshBasicMaterial({ color: i % 4 ? 0x4fffd2 : 0xffd84f }),
  );
  light.position.set(i, 1.18, 10.54);
  baseGroup.add(light);
}

const coreMaterial = new THREE.MeshStandardMaterial({
  color: 0x193e55,
  metalness: 0.7,
  roughness: 0.25,
  emissive: 0x4fffd2,
  emissiveIntensity: 0.55,
});
const core = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.8, 2.3, 8), coreMaterial);
core.position.set(0, 1.2, 13.1);
baseGroup.add(core);

// 程序员题材的工位需要一眼能认出“正在救火”，给每个工位挂一块会呼吸的 BUG 牌。
const workbenchBadgeCanvas = document.createElement('canvas');
workbenchBadgeCanvas.width = 320;
workbenchBadgeCanvas.height = 112;
const workbenchBadgeCtx = workbenchBadgeCanvas.getContext('2d');
workbenchBadgeCtx.fillStyle = '#101c35';
workbenchBadgeCtx.fillRect(4, 4, 312, 104);
workbenchBadgeCtx.fillStyle = '#ff4d68';
workbenchBadgeCtx.fillRect(4, 4, 88, 104);
workbenchBadgeCtx.fillStyle = '#ffffff';
workbenchBadgeCtx.font = '1000 36px system-ui, sans-serif';
workbenchBadgeCtx.textAlign = 'center';
workbenchBadgeCtx.textBaseline = 'middle';
workbenchBadgeCtx.fillText('BUG', 48, 54);
workbenchBadgeCtx.textAlign = 'left';
workbenchBadgeCtx.font = '1000 24px system-ui, sans-serif';
workbenchBadgeCtx.fillText('在线救火', 108, 42);
workbenchBadgeCtx.fillStyle = '#9bd7ff';
workbenchBadgeCtx.font = '700 17px system-ui, sans-serif';
workbenchBadgeCtx.fillText('别让它进生产', 108, 76);
const workbenchBadgeTexture = new THREE.CanvasTexture(workbenchBadgeCanvas);
workbenchBadgeTexture.colorSpace = THREE.SRGBColorSpace;
const workbenchBadgeMaterial = new THREE.SpriteMaterial({
  map: workbenchBadgeTexture,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  fog: true,
  toneMapped: false,
});

const turretGroups = [];
for (let index = 0; index < MAX_CANNONS; index += 1) {
  const turret = new THREE.Group();
  turret.position.set(0, 0, 10.2);
  turret.visible = index === 0;
  const heroHaloMaterial = new THREE.MeshBasicMaterial({
    color: 0x4fffd2,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const heroHalo = new THREE.Mesh(new THREE.RingGeometry(0.72, 1.28, 64), heroHaloMaterial);
  heroHalo.rotation.x = -Math.PI / 2;
  heroHalo.position.y = 0.08;
  turret.add(heroHalo);

  // 僵尸题材：重型电磁歼灭炮。底盘、能量核心、供弹环和功能挂件都会随升级真实变化。
  const cannonModel = new THREE.Group();
  cannonModel.position.y = 1.28;
  const baseMaterial = new THREE.MeshStandardMaterial({ color: 0x173447, metalness: 0.82, roughness: 0.25 });
  const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x6b8fa0, metalness: 0.9, roughness: 0.14 });
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.66, 0.96, 0.66, 32, 2),
    baseMaterial,
  );
  pedestal.position.y = 0.34;
  cannonModel.add(pedestal);
  const basePlate = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.06, 0.16, 40, 2), trimMaterial);
  basePlate.position.y = 0.08;
  cannonModel.add(basePlate);
  const rateRings = [0, 1].map((ringIndex) => {
    const material = new THREE.MeshBasicMaterial({ color: ringIndex ? 0xffd84f : 0x4fffd2, transparent: true, opacity: 0.56, toneMapped: false });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.74 + ringIndex * 0.13, 0.035, 12, 64), material);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.7 + ringIndex * 0.08;
    cannonModel.add(ring);
    return ring;
  });
  for (let legIndex = 0; legIndex < 4; legIndex += 1) {
    const leg = new THREE.Mesh(roundedBox(0.25, 0.18, 0.68, 0.055, 3), baseMaterial);
    leg.position.set(Math.sin(legIndex * Math.PI / 2) * 0.64, 0.14, Math.cos(legIndex * Math.PI / 2) * 0.64);
    leg.rotation.y = legIndex * Math.PI / 2;
    cannonModel.add(leg);
  }

  const pivot = new THREE.Group();
  pivot.position.y = 1.02;
  const housingMaterial = new THREE.MeshStandardMaterial({
    color: 0x4fffd2,
    metalness: 0.62,
    roughness: 0.2,
    emissive: 0x164f4a,
    emissiveIntensity: 0.48,
  });
  const housing = new THREE.Mesh(roundedBox(1.08, 0.66, 0.98, 0.12, 5), housingMaterial);
  housing.position.z = -0.08;
  pivot.add(housing);
  const rearArmor = new THREE.Mesh(roundedBox(1.28, 0.42, 0.22, 0.07, 4), baseMaterial);
  rearArmor.position.set(0, 0.02, 0.52);
  pivot.add(rearArmor);
  const armorWings = [-1, 1].map((side) => {
    const wing = new THREE.Mesh(roundedBox(0.18, 0.54, 0.72, 0.055, 4), trimMaterial);
    wing.position.set(side * 0.63, -0.02, -0.08);
    wing.rotation.z = side * -0.16;
    pivot.add(wing);
    return wing;
  });
  const coreMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x4fffd2,
    emissiveIntensity: 1.15,
    metalness: 0.08,
    roughness: 0.12,
  });
  const energyCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.25, 2), coreMaterial);
  energyCore.position.set(0, 0.03, 0.56);
  pivot.add(energyCore);
  const barrelMaterial = new THREE.MeshStandardMaterial({
    color: 0xd7f8f2,
    metalness: 0.84,
    roughness: 0.16,
    emissive: 0x4fffd2,
    emissiveIntensity: 0.2,
  });
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 2.2, 32, 3), barrelMaterial);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -1.38;
  pivot.add(barrel);
  const barrelJacket = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.29, 0.72, 32, 2, true), baseMaterial);
  barrelJacket.rotation.x = Math.PI / 2;
  barrelJacket.position.z = -0.72;
  pivot.add(barrelJacket);
  const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.05, 12, 48), trimMaterial);
  muzzleRing.position.z = -2.49;
  pivot.add(muzzleRing);
  // 近景也能辨认的炮身分段、散热鳍和铆钉，避免整门炮只剩几块低模几何。
  [-0.98, -1.42, -1.88].forEach((z, sleeveIndex) => {
    const sleeve = new THREE.Mesh(
      new THREE.TorusGeometry(0.17 + sleeveIndex * 0.008, 0.026, 10, 40),
      sleeveIndex === 1 ? housingMaterial : trimMaterial,
    );
    sleeve.position.z = z;
    pivot.add(sleeve);
  });
  [-1, 1].forEach((side) => {
    for (let ventIndex = 0; ventIndex < 3; ventIndex += 1) {
      const vent = new THREE.Mesh(roundedBox(0.045, 0.12, 0.34, 0.014, 2), baseMaterial);
      vent.position.set(side * 0.553, 0.14 - ventIndex * 0.14, -0.12);
      vent.rotation.z = side * 0.05;
      pivot.add(vent);
    }
  });
  const rivetGeometry = new THREE.SphereGeometry(0.042, 12, 8);
  for (let rivetIndex = 0; rivetIndex < 8; rivetIndex += 1) {
    const angle = rivetIndex / 8 * Math.PI * 2;
    const rivet = new THREE.Mesh(rivetGeometry, trimMaterial);
    rivet.position.set(Math.cos(angle) * 0.78, 0.63, Math.sin(angle) * 0.78);
    cannonModel.add(rivet);
  }
  const sideBarrels = [-1, 1].map((side) => {
    const sideBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.085, 1.72, 20, 2), barrelMaterial);
    sideBarrel.rotation.x = Math.PI / 2;
    sideBarrel.position.set(side * 0.27, -0.09, -1.25);
    sideBarrel.visible = false;
    pivot.add(sideBarrel);
    return sideBarrel;
  });
  const ammoDrums = [-1, 1].map((side) => {
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.3, 28, 2), baseMaterial);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(side * 0.69, -0.08, 0.2);
    pivot.add(drum);
    return drum;
  });
  const blastPods = [-1, 1].map((side) => {
    const podMaterial = new THREE.MeshStandardMaterial({ color: 0xff9f43, emissive: 0x9b3510, emissiveIntensity: 1.1, metalness: 0.5, roughness: 0.24 });
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 0.52, 20, 2), podMaterial);
    pod.position.set(side * 0.72, 0.3, -0.16);
    pod.rotation.z = side * 0.18;
    pod.visible = false;
    pivot.add(pod);
    return pod;
  });
  const chainCoils = [-1, 1].map((side) => {
    const coil = new THREE.Mesh(
      new THREE.TorusGeometry(0.19, 0.035, 10, 40),
      new THREE.MeshBasicMaterial({ color: 0xb37cff, transparent: true, opacity: 0.9, toneMapped: false }),
    );
    coil.rotation.y = Math.PI / 2;
    coil.position.set(side * 0.62, 0.14, 0.34);
    coil.visible = false;
    pivot.add(coil);
    return coil;
  });
  const frostFins = [-1, 1].map((side) => {
    const fin = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.52, 5),
      new THREE.MeshStandardMaterial({ color: 0xc9f6ff, emissive: 0x43cfff, emissiveIntensity: 1.4, roughness: 0.18 }),
    );
    fin.position.set(side * 0.43, 0.54, 0.2);
    fin.rotation.z = side * -0.38;
    fin.visible = false;
    pivot.add(fin);
    return fin;
  });
  const critSight = new THREE.Mesh(
    new THREE.TorusGeometry(0.18, 0.025, 10, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd84f, transparent: true, opacity: 0.92, toneMapped: false }),
  );
  critSight.position.set(0, 0.48, -0.72);
  critSight.visible = false;
  pivot.add(critSight);
  const zombieMuzzle = new THREE.Group();
  zombieMuzzle.position.set(0, 0, -2.58);
  const muzzleCoreMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const muzzleGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xffd84f, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  zombieMuzzle.add(new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 12), muzzleCoreMaterial));
  for (let rayIndex = 0; rayIndex < 4; rayIndex += 1) {
    const ray = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.72, 12), muzzleGlowMaterial);
    ray.rotation.x = Math.PI / 2;
    ray.rotation.z = rayIndex * Math.PI / 2;
    ray.position.z = -0.26;
    zombieMuzzle.add(ray);
  }
  zombieMuzzle.visible = false;
  pivot.add(zombieMuzzle);
  cannonModel.add(pivot);
  const cannonEvolutionStages = [1, 2, 3].map((stage) => {
    const group = new THREE.Group();
    if (stage === 1) {
      [-1, 1].forEach((side) => {
        const capacitor = new THREE.Mesh(
          new THREE.CylinderGeometry(0.16, 0.2, 0.72, 20, 2),
          new THREE.MeshStandardMaterial({ color: 0x244f67, emissive: 0x4fffd2, emissiveIntensity: 0.45, metalness: 0.68, roughness: 0.25 }),
        );
        capacitor.position.set(side * 0.72, 1.3, 0.3);
        group.add(capacitor);
      });
    } else if (stage === 2) {
      [-1, 1].forEach((side) => {
        const shoulderRail = new THREE.Mesh(
          roundedBox(0.22, 0.2, 1.48, 0.045, 3),
          new THREE.MeshStandardMaterial({ color: 0x8dacb7, emissive: 0xff9f43, emissiveIntensity: 0.28, metalness: 0.86, roughness: 0.16 }),
        );
        shoulderRail.position.set(side * 0.48, 1.72, -0.4);
        shoulderRail.rotation.z = side * -0.08;
        group.add(shoulderRail);
      });
    } else {
      const crown = new THREE.Mesh(
        new THREE.TorusGeometry(0.72, 0.07, 12, 56),
        new THREE.MeshBasicMaterial({ color: 0xffd84f, transparent: true, opacity: 0.52, blending: THREE.AdditiveBlending, toneMapped: false }),
      );
      crown.rotation.x = Math.PI / 2;
      crown.position.y = 1.82;
      group.add(crown);
      for (let spikeIndex = 0; spikeIndex < 4; spikeIndex += 1) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.58, 12), new THREE.MeshBasicMaterial({ color: 0x4fffd2, toneMapped: false }));
        const angle = spikeIndex * Math.PI / 2;
        spike.position.set(Math.cos(angle) * 0.84, 1.76, Math.sin(angle) * 0.84);
        spike.rotation.z = Math.cos(angle) * 0.34;
        group.add(spike);
      }
    }
    group.visible = false;
    cannonModel.add(group);
    return group;
  });
  turret.add(cannonModel);

  // 程序员题材：会移动的 P0 救火车，显示器、咖啡、打印机和功能附件都受升级驱动。
  const workbenchModel = new THREE.Group();
  const chassisMaterial = new THREE.MeshStandardMaterial({ color: 0x172f5d, metalness: 0.68, roughness: 0.28, emissive: 0x071a42, emissiveIntensity: 0.48 });
  const deskMaterial = new THREE.MeshStandardMaterial({ color: 0x2b68a3, metalness: 0.44, roughness: 0.3, emissive: 0x0b356c, emissiveIntensity: 0.62 });
  const chassis = new THREE.Mesh(roundedBox(1.45, 0.18, 1.05, 0.09, 5), chassisMaterial);
  chassis.position.y = 0.32;
  workbenchModel.add(chassis);
  [-1, 1].forEach((side) => [-0.32, 0.36].forEach((z) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.13, 24, 2), new THREE.MeshStandardMaterial({ color: 0x09101c, metalness: 0.5, roughness: 0.5 }));
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 0.68, 0.22, z);
    workbenchModel.add(wheel);
  }));
  const desk = new THREE.Mesh(
    roundedBox(1.38, 0.16, 0.88, 0.07, 4),
    deskMaterial,
  );
  desk.position.y = 0.94;
  workbenchModel.add(desk);
  const screenPivot = new THREE.Group();
  screenPivot.position.set(0, 1.15, -0.16);
  const screenMaterial = new THREE.MeshStandardMaterial({ color: 0x79d8ff, emissive: 0x2388d4, emissiveIntensity: 0.85, metalness: 0.18, roughness: 0.22 });
  const screen = new THREE.Mesh(
    roundedBox(0.78, 0.52, 0.09, 0.055, 4),
    screenMaterial,
  );
  screenPivot.add(screen);
  const errorBar = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.012), new THREE.MeshBasicMaterial({ color: 0xff526a, toneMapped: false }));
  errorBar.position.set(0, 0.12, -0.052);
  screenPivot.add(errorBar);
  const codeBars = [0.02, -0.1].map((y, barIndex) => {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(barIndex ? 0.36 : 0.52, 0.045, 0.012), new THREE.MeshBasicMaterial({ color: 0x45f0d0, toneMapped: false }));
    bar.position.set(barIndex ? -0.1 : 0, y, -0.052);
    screenPivot.add(bar);
    return bar;
  });
  const screenStand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.25, 0.1), new THREE.MeshStandardMaterial({ color: 0x9cb5c7, metalness: 0.62, roughness: 0.26 }));
  screenStand.position.y = -0.36;
  screenPivot.add(screenStand);
  workbenchModel.add(screenPivot);
  const sideScreens = [-1, 1].map((side) => {
    const sidePivot = new THREE.Group();
    sidePivot.position.set(side * 0.58, 1.22, -0.1);
    sidePivot.rotation.y = side * -0.32;
    const sideScreen = new THREE.Mesh(roundedBox(0.48, 0.35, 0.07, 0.04, 4), screenMaterial.clone());
    sidePivot.add(sideScreen);
    sidePivot.visible = false;
    workbenchModel.add(sidePivot);
    return sidePivot;
  });
  const keyboard = new THREE.Mesh(
    roundedBox(0.58, 0.055, 0.22, 0.022, 3),
    new THREE.MeshStandardMaterial({ color: 0xe9f4ff, emissive: 0x4ca9ff, emissiveIntensity: 0.28, metalness: 0.2, roughness: 0.34 }),
  );
  keyboard.position.set(0.08, 1.04, 0.26);
  workbenchModel.add(keyboard);
  const chair = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.15, 28, 2), new THREE.MeshStandardMaterial({ color: 0xd66bff, metalness: 0.28, roughness: 0.42 }));
  chair.position.set(0, 0.45, 0.42);
  workbenchModel.add(chair);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 24, 18), new THREE.MeshStandardMaterial({ color: 0xffc59e, roughness: 0.66 }));
  head.position.set(0, 1.45, 0.34);
  workbenchModel.add(head);
  const torso = new THREE.Mesh(roundedBox(0.34, 0.42, 0.24, 0.06, 4), new THREE.MeshStandardMaterial({ color: 0x45f0d0, emissive: 0x116e71, emissiveIntensity: 0.4, roughness: 0.56 }));
  torso.position.set(0, 1.12, 0.34);
  workbenchModel.add(torso);
  const armMaterial = new THREE.MeshStandardMaterial({ color: 0xffc59e, roughness: 0.66 });
  const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.42, 0.12), armMaterial);
  leftArm.position.set(-0.23, 1.04, 0.2);
  leftArm.rotation.z = -0.65;
  workbenchModel.add(leftArm);
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.23;
  rightArm.rotation.z = 0.65;
  workbenchModel.add(rightArm);
  const coffee = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.18, 24, 2), new THREE.MeshStandardMaterial({ color: 0xffca5c, emissive: 0x7e4c14, emissiveIntensity: 0.45 }));
  coffee.position.set(0.47, 1.12, 0.2);
  workbenchModel.add(coffee);
  const coffeeTank = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.18, 0.52, 24, 2),
    new THREE.MeshStandardMaterial({ color: 0xffca5c, emissive: 0xff8a2b, emissiveIntensity: 1.1, metalness: 0.35, roughness: 0.3 }),
  );
  coffeeTank.position.set(0.61, 0.72, 0.15);
  coffeeTank.visible = false;
  workbenchModel.add(coffeeTank);
  const printer = new THREE.Mesh(roundedBox(0.72, 0.32, 0.46, 0.065, 4), new THREE.MeshStandardMaterial({ color: 0xf1f6ff, emissive: 0x4679a8, emissiveIntensity: 0.32, metalness: 0.24, roughness: 0.28 }));
  printer.position.set(0, 0.72, -0.58);
  workbenchModel.add(printer);
  const printerSlot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.055, 0.08), new THREE.MeshBasicMaterial({ color: 0xff526a, toneMapped: false }));
  printerSlot.position.set(0, 0.8, -0.83);
  workbenchModel.add(printerSlot);
  const deadlineMuzzle = new THREE.Group();
  deadlineMuzzle.position.set(0, 0.8, -0.9);
  const paperFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.36), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }));
  paperFlash.rotation.x = -0.48;
  deadlineMuzzle.add(paperFlash);
  const stampFlash = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.2, 16), new THREE.MeshBasicMaterial({ color: 0xff526a, transparent: true, opacity: 0.92, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  stampFlash.position.z = -0.08;
  deadlineMuzzle.add(stampFlash);
  deadlineMuzzle.visible = false;
  workbenchModel.add(deadlineMuzzle);
  const sirenMaterial = new THREE.MeshStandardMaterial({ color: 0xff526a, emissive: 0xff1744, emissiveIntensity: 1.1, transparent: true, opacity: 0.9 });
  const siren = new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), sirenMaterial);
  siren.position.set(-0.52, 1.2, 0.2);
  workbenchModel.add(siren);
  const networkAntenna = new THREE.Group();
  const antennaPole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.58, 16), new THREE.MeshStandardMaterial({ color: 0xb37cff, emissive: 0x6e3bd1, emissiveIntensity: 1.1 }));
  antennaPole.position.y = 0.26;
  networkAntenna.add(antennaPole);
  [0.12, 0.22].forEach((radius, ringIndex) => {
    const antennaRing = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.018, 8, 32), new THREE.MeshBasicMaterial({ color: 0xb37cff, toneMapped: false }));
    antennaRing.position.y = 0.54 + ringIndex * 0.08;
    networkAntenna.add(antennaRing);
  });
  networkAntenna.position.set(0.55, 1.02, -0.12);
  networkAntenna.visible = false;
  workbenchModel.add(networkAntenna);
  const frostFan = new THREE.Group();
  const fanRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 10, 40), new THREE.MeshBasicMaterial({ color: 0x69d8ff, toneMapped: false }));
  frostFan.add(fanRing);
  for (let bladeIndex = 0; bladeIndex < 4; bladeIndex += 1) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.025), new THREE.MeshBasicMaterial({ color: 0xc9f6ff, toneMapped: false }));
    blade.position.y = 0.08;
    blade.rotation.z = bladeIndex * Math.PI / 2;
    frostFan.add(blade);
  }
  frostFan.position.set(-0.61, 0.72, -0.18);
  frostFan.rotation.y = Math.PI / 2;
  frostFan.visible = false;
  workbenchModel.add(frostFan);
  const approvalLamp = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.13, 0),
    new THREE.MeshStandardMaterial({ color: 0x8fff65, emissive: 0x39d85d, emissiveIntensity: 1.7, roughness: 0.18 }),
  );
  approvalLamp.position.set(0.5, 1.45, 0.1);
  approvalLamp.visible = false;
  workbenchModel.add(approvalLamp);
  const wheelBar = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.07, 0.1), new THREE.MeshStandardMaterial({ color: 0x7e9db9, metalness: 0.62, roughness: 0.3 }));
  wheelBar.position.y = 0.12;
  workbenchModel.add(wheelBar);
  const badge = new THREE.Sprite(workbenchBadgeMaterial);
  badge.position.set(0, 2.08, 0.02);
  badge.scale.set(1.42, 0.5, 1);
  badge.renderOrder = 18;
  workbenchModel.add(badge);
  const workbenchEvolutionStages = [1, 2, 3].map((stage) => {
    const group = new THREE.Group();
    if (stage === 1) {
      [-1, 1].forEach((side) => {
        const rack = new THREE.Mesh(
          roundedBox(0.32, 0.78, 0.46, 0.055, 4),
          new THREE.MeshStandardMaterial({ color: 0x18294e, emissive: side > 0 ? 0x45f0d0 : 0xff526a, emissiveIntensity: 0.42, metalness: 0.48, roughness: 0.3 }),
        );
        rack.position.set(side * 0.88, 0.72, 0.1);
        group.add(rack);
      });
    } else if (stage === 2) {
      const deployBar = new THREE.Mesh(
        roundedBox(1.65, 0.12, 0.12, 0.035, 3),
        new THREE.MeshStandardMaterial({ color: 0x568db5, emissive: 0x2388d4, emissiveIntensity: 0.7, metalness: 0.55, roughness: 0.2 }),
      );
      deployBar.position.set(0, 1.92, -0.05);
      group.add(deployBar);
      [-1, 1].forEach((side) => {
        const support = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.72, 0.08), deployBar.material);
        support.position.set(side * 0.72, 1.56, -0.05);
        group.add(support);
      });
    } else {
      const deployHalo = new THREE.Mesh(
        new THREE.TorusGeometry(0.66, 0.055, 12, 56),
        new THREE.MeshBasicMaterial({ color: 0x45f0d0, transparent: true, opacity: 0.54, blending: THREE.AdditiveBlending, toneMapped: false }),
      );
      deployHalo.rotation.x = Math.PI / 2;
      deployHalo.position.y = 2.12;
      group.add(deployHalo);
      const p0Core = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), new THREE.MeshBasicMaterial({ color: 0xffca5c, toneMapped: false }));
      p0Core.position.y = 2.12;
      group.add(p0Core);
    }
    group.visible = false;
    workbenchModel.add(group);
    return group;
  });
  workbenchModel.scale.setScalar(1.5);
  workbenchModel.position.y = 0.38;
  workbenchModel.visible = false;
  turret.add(workbenchModel);
  turretGroups.push({
    group: turret,
    cannonModel,
    workbenchModel,
    pivot,
    screenPivot,
    keyboard,
    coffee,
    leftArm,
    rightArm,
    printer,
    siren,
    sirenMaterial,
    badge,
    housingMaterial,
    barrelMaterial,
    coreMaterial,
    energyCore,
    rateRings,
    armorWings,
    sideBarrels,
    ammoDrums,
    blastPods,
    chainCoils,
    frostFins,
    critSight,
    zombieMuzzle,
    deadlineMuzzle,
    sideScreens,
    coffeeTank,
    networkAntenna,
    frostFan,
    approvalLamp,
    screenMaterial,
    heroHalo,
    heroHaloMaterial,
    cannonEvolutionStages,
    workbenchEvolutionStages,
    targetRotation: 0,
    recoil: 0,
    muzzleLife: 0,
    upgradePulse: 0,
    movementLean: 0,
    lastX: 0,
    evolutionStage: 0,
    phase: index * 0.7,
  });
  baseGroup.add(turret);
}

const ENEMY_TYPES = ['normal', 'runner', 'tank', 'elite', 'boss'];
const ENEMY_ATLAS_FRAMES = Object.freeze({ normal: 0, runner: 1, tank: 2, elite: 3, boss: 4 });
const textureLoader = new THREE.TextureLoader();
const enemyPlaneGeometry = new THREE.PlaneGeometry(1.95, 2.55);
enemyPlaneGeometry.translate(0, 1.275, 0);
// MeshBasicMaterial multiplies the per-instance tint with the geometry colour.
// PlaneGeometry has no colour attribute by default; provide a white baseline
// so the atlas remains fully saturated while hit/frost tints can still use
// InstancedMesh.instanceColor.
enemyPlaneGeometry.setAttribute(
  'color',
  new THREE.Float32BufferAttribute(
    new Float32Array(enemyPlaneGeometry.attributes.position.count * 3).fill(1),
    3,
  ),
);

function createEnemyMaterial(themeId, type, outline = false) {
  const texture = textureLoader.load(`./assets/characters/${themeId}-atlas.svg?v=0.14.0`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  // The atlas has no padded mip borders. A non-mip linear sample prevents the
  // adjacent character from bleeding into a frame at the tiny crowd scale.
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.repeat.set(0.2, 1);
  texture.offset.set(ENEMY_ATLAS_FRAMES[type] * 0.2, 0);
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: outline ? 0x061018 : 0xffffff,
    transparent: true,
    alphaTest: outline ? 0.035 : 0.08,
    depthWrite: !outline,
    vertexColors: !outline,
    fog: true,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
}

const enemyVisuals = {
  normal: { shadow: 0.72 },
  runner: { shadow: 0.58 },
  tank: { shadow: 0.9 },
  elite: { shadow: 0.92 },
  boss: { shadow: 1.08 },
};
for (const [type, visual] of Object.entries(enemyVisuals)) {
  visual.materials = {
    zombie: createEnemyMaterial('zombie', type),
    deadline: createEnemyMaterial('deadline', type),
  };
  visual.outlineMaterials = {
    zombie: createEnemyMaterial('zombie', type, true),
    deadline: createEnemyMaterial('deadline', type, true),
  };
  visual.mesh = new THREE.InstancedMesh(
    enemyPlaneGeometry,
    visual.materials.zombie,
    WORLD.maxEnemies,
  );
  visual.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // MeshBasicMaterial vertex colors are enabled for hit/slow tinting. Fill
  // every slot with white first; an InstancedMesh color buffer otherwise
  // defaults untouched instances to black and swallows the atlas texture.
  visual.mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(WORLD.maxEnemies * 3).fill(1),
    3,
  );
  visual.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  visual.mesh.frustumCulled = false;
  visual.mesh.count = 0;
  worldGroup.add(visual.mesh);
  visual.outlineMesh = new THREE.InstancedMesh(
    enemyPlaneGeometry,
    visual.outlineMaterials.zombie,
    WORLD.maxEnemies,
  );
  visual.outlineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  visual.outlineMesh.frustumCulled = false;
  visual.outlineMesh.count = 0;
  visual.outlineMesh.renderOrder = -1;
  worldGroup.add(visual.outlineMesh);
}

const enemyShadowGeometry = new THREE.CircleGeometry(0.72, 20);
enemyShadowGeometry.rotateX(-Math.PI / 2);
const enemyShadowMesh = new THREE.InstancedMesh(
  enemyShadowGeometry,
  new THREE.MeshBasicMaterial({ color: 0x010407, transparent: true, opacity: 0.46, depthWrite: false, fog: true }),
  WORLD.maxEnemies,
);
enemyShadowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
enemyShadowMesh.frustumCulled = false;
enemyShadowMesh.count = 0;
worldGroup.add(enemyShadowMesh);

const projectileGeometry = new THREE.IcosahedronGeometry(0.14, 1);
const projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xffe36d, toneMapped: false });
const projectileAuraMaterial = new THREE.MeshBasicMaterial({ color: 0x4fffd2, transparent: true, opacity: 0.34, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
const projectileTrailMaterial = new THREE.MeshBasicMaterial({ color: 0xff9f43, transparent: true, opacity: 0.58, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
function createTicketMaterial(header, title, accent) {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5fbff';
  ctx.fillRect(4, 4, 312, 192);
  ctx.fillStyle = accent;
  ctx.fillRect(4, 4, 312, 48);
  ctx.fillStyle = '#ffffff';
  ctx.font = '1000 30px system-ui, sans-serif';
  ctx.fillText(header, 18, 38);
  ctx.fillStyle = '#19324a';
  ctx.font = '900 28px system-ui, sans-serif';
  ctx.fillText(title, 18, 92);
  ctx.fillStyle = '#7a94a8';
  ctx.fillRect(18, 115, 260, 10);
  ctx.fillRect(18, 140, 210, 10);
  ctx.fillRect(18, 165, 245, 10);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
}

const ticketMaterials = Object.freeze({
  normal: createTicketMaterial('BUG 工单', '用户反馈', '#ff526a'),
  blast: createTicketMaterial('P0 事故', '批量关闭', '#ff8a3d'),
  chain: createTicketMaterial('@所有人', '调用链追踪', '#9a70ff'),
  frost: createTicketMaterial('需求冻结', '本周不再改', '#3cbde8'),
  critical: createTicketMaterial('HOTFIX', '一次通过', '#45c96b'),
});
const ticketStampMaterial = new THREE.MeshBasicMaterial({ color: 0xff526a, transparent: true, opacity: 0.92, side: THREE.DoubleSide, toneMapped: false });
const ticketEchoMaterials = [
  new THREE.MeshBasicMaterial({ color: 0xff526a, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
  new THREE.MeshBasicMaterial({ color: 0x62a8ff, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }),
];
const shellVariantMaterials = Object.freeze({
  blast: new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  chain: new THREE.MeshBasicMaterial({ color: 0xb37cff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  frost: new THREE.MeshBasicMaterial({ color: 0x8de9ff, transparent: true, opacity: 0.92, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
});
const projectilePool = [];
for (let i = 0; i < WORLD.maxProjectiles; i += 1) {
  const mesh = new THREE.Group();
  const energy = new THREE.Mesh(projectileGeometry, projectileMaterial);
  const aura = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), projectileAuraMaterial);
  const trail = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.9, 6), projectileTrailMaterial);
  trail.rotation.x = Math.PI / 2;
  trail.position.z = 0.42;
  const shellFins = new THREE.Group();
  for (let finIndex = 0; finIndex < 4; finIndex += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.18, 0.25), projectileAuraMaterial);
    fin.rotation.z = finIndex * Math.PI / 2;
    shellFins.add(fin);
  }
  shellFins.visible = false;
  const blastBand = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.045, 6, 16), shellVariantMaterials.blast);
  blastBand.rotation.x = Math.PI / 2;
  blastBand.visible = false;
  const chainOrbit = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 18), shellVariantMaterials.chain);
  chainOrbit.rotation.y = Math.PI / 2;
  chainOrbit.visible = false;
  const frostSpikes = new THREE.Group();
  for (let spikeIndex = 0; spikeIndex < 4; spikeIndex += 1) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.34, 4), shellVariantMaterials.frost);
    spike.rotation.z = spikeIndex * Math.PI / 2;
    spike.position.x = Math.cos(spikeIndex * Math.PI / 2) * 0.18;
    spike.position.y = Math.sin(spikeIndex * Math.PI / 2) * 0.18;
    frostSpikes.add(spike);
  }
  frostSpikes.visible = false;
  const ticket = new THREE.Group();
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.52), ticketMaterials.normal);
  ticket.add(paper);
  const ticketStamp = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.15, 14), ticketStampMaterial);
  ticketStamp.position.set(0.22, 0.08, 0.012);
  ticket.add(ticketStamp);
  const ticketEchoes = [0.18, 0.34].map((offset, echoIndex) => {
    const echo = new THREE.Mesh(
      new THREE.PlaneGeometry(0.64 - echoIndex * 0.08, 0.4 - echoIndex * 0.05),
      ticketEchoMaterials[echoIndex],
    );
    echo.position.z = offset;
    ticket.add(echo);
    return echo;
  });
  ticket.rotation.x = -0.72;
  ticket.scale.setScalar(1.38);
  ticket.visible = false;
  mesh.add(trail, aura, energy, shellFins, blastBand, chainOrbit, frostSpikes, ticket);
  mesh.visible = false;
  worldGroup.add(mesh);
  projectilePool.push({
    active: false,
    mesh,
    energy,
    aura,
    trail,
    shellFins,
    blastBand,
    chainOrbit,
    frostSpikes,
    ticket,
    ticketPaper: paper,
    ticketStamp,
    ticketEchoes,
    x: 0,
    y: 0,
    z: 0,
    target: null,
    damage: 0,
    lane: 0,
    spin: i * 0.17,
    visualPower: 1,
    variant: 'normal',
  });
}

const matrixDummy = new THREE.Object3D();
const outlineDummy = new THREE.Object3D();
const shadowDummy = new THREE.Object3D();
const enemyTint = new THREE.Color();
const impactWhite = new THREE.Color(0xffffff);
const muzzleWorldPosition = new THREE.Vector3();
const enemies = [];
const bonusTargets = [];
const choiceGates = [];
const BONUS_CONFIG = Object.freeze({
  damage: { color: 0xffc857, hp: 72, speed: 1.28, score: 320, scale: 1 },
  rate: { color: 0x4fffd2, hp: 68, speed: 1.34, score: 320, scale: 1 },
  crit: { color: 0xff6fbc, hp: 82, speed: 1.22, score: 420, scale: 1.04 },
  mystery: { color: 0xb37cff, hp: 145, speed: 1.05, score: 900, scale: 1.16 },
  barrier: { color: 0xff7a55, hp: 260, speed: 0.82, score: 1400, scale: 1.35 },
});
const fxItems = [];
const lightningItems = [];
const speechBubbles = [];

const state = {
  mode: 'menu',
  themeId: THEMES[localStorage.getItem('toy-toy-toy-theme')] ? localStorage.getItem('toy-toy-toy-theme') : 'zombie',
  level: 1,
  lastVictory: false,
  seed: 0,
  random: Math.random,
  elapsed: 0,
  score: 0,
  kills: 0,
  combo: 1,
  maxCombo: 1,
  comboUntil: 0,
  baseHp: 100,
  focusLane: 1,
  fireAcc: Array(MAX_CANNONS).fill(0),
  spawnAcc: 0,
  nextBonusAt: 5.5,
  nextBarrierAt: 14,
  nextMysteryAt: 23,
  nextGateAt: 6.5,
  gatePhase: 'none',
  gatePrepUntil: 0,
  gateChoiceUntil: 0,
  gateResumeAt: 0,
  gateRound: 0,
  lastGateEffect: '',
  nextSpeechAt: 2.8,
  nextUpgradeAt: Number.POSITIVE_INFINITY,
  upgradeDeadline: 0,
  currentUpgrades: [],
  speed: 1,
  frenzyUntil: 0,
  overdriveUntil: 0,
  turretUpgradeUntil: 0,
  lastTurretUpgrade: '',
  bailoutUsed: false,
  bossSpawned: false,
  bossAlive: false,
  bossDefeated: false,
  finishAt: 0,
  shake: 0,
  flash: 0,
  flashColor: '#ffffff',
  hitStopUntil: 0,
  lastHitStopAt: 0,
  lastTs: performance.now(),
  lastUiAt: 0,
  lastShotSoundAt: 0,
  lastImpactSoundAt: 0,
  lastKillSoundAt: 0,
  lastLaneSoundAt: 0,
  telemetry: {
    spawned: 0,
    shots: 0,
    speech: 0,
    frenzyUses: 0,
    overdriveUses: 0,
    bossUses: 0,
    upgrades: 0,
    gatesOffered: 0,
    gatesChosen: 0,
    impacts: 0,
    criticalHits: 0,
    specialImpacts: 0,
    hitStops: 0,
  },
  bonuses: {
    damage: 1,
    rate: 1,
    crit: 0,
    count: 0,
    shards: 0,
    barriers: 0,
  },
  levels: {
    damage: 1,
    rate: 1,
    blast: 0,
    chain: 0,
    frost: 0,
    multi: 0,
    crit: 0,
    cannon: 1,
  },
};

// Threejs-Awesome-Graphics-Agent-Skills 视觉合约：主体几何、身份配件、环境、对象池 VFX 与后处理各有唯一所有者。
const visualSystem = createToyVisualSystem({
  renderer,
  scene,
  camera,
  worldGroup,
  wall,
  core,
  grid,
  turretGroups,
  groundMaterial,
});

const upgrades = [
  {
    id: 'damage', icon: '▰', title: '口径膨胀', color: '#ffd84f', max: 7,
    describe: () => `所有子弹伤害提高 ${state.levels.damage < 4 ? 55 : 42}%`,
    apply: () => { state.levels.damage += 1; },
  },
  {
    id: 'rate', icon: '»', title: '射速失控', color: '#4fffd2', max: 7,
    describe: () => '当前战线的全部炮台射击间隔继续缩短',
    apply: () => { state.levels.rate += 1; },
  },
  {
    id: 'blast', icon: '✦', title: '尸爆协议', color: '#ff9f43', max: 5,
    describe: () => '子弹命中产生范围爆炸，等级越高波及范围越大',
    apply: () => { state.levels.blast += 1; },
  },
  {
    id: 'chain', icon: 'ϟ', title: '连锁闪电', color: '#b37cff', max: 5,
    describe: () => '命中有概率跳向附近敌人，形成可见的闪电链',
    apply: () => { state.levels.chain += 1; },
  },
  {
    id: 'frost', icon: '❄', title: '绝对零度', color: '#6edbff', max: 4,
    describe: () => '命中有概率冻结敌人两秒，减慢整片尸潮',
    apply: () => { state.levels.frost += 1; },
  },
  {
    id: 'multi', icon: '⑶', title: '同步齐射', color: '#8fff65', max: 3,
    describe: () => '每座炮台同时锁定更多目标，子弹数量肉眼可见地增加',
    apply: () => { state.levels.multi += 1; },
  },
  {
    id: 'crit', icon: '※', title: '暴击算法', color: '#ff6f91', max: 5,
    describe: () => '提高暴击概率与暴击倍率，伤害数字变得更不讲道理',
    apply: () => { state.levels.crit += 1; },
  },
  {
    id: 'cannon', icon: '▥', title: '炮台复制', color: '#ff7cf4', max: MAX_CANNONS,
    describe: () => '增加一座并排炮台，但所有炮台始终只攻击当前战线',
    apply: () => { state.levels.cannon = Math.min(MAX_CANNONS, state.levels.cannon + 1); },
  },
  {
    id: 'repair', icon: '✚', title: '防线焊死', color: '#76ff9d', max: 99,
    describe: () => '立即修复 28% 基地完整度，并获得短暂火力加成',
    apply: () => {
      state.baseHp = Math.min(100, state.baseHp + 28);
      state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 4);
    },
  },
];

const GATE_EFFECTS = Object.freeze([
  {
    id: 'team_double', icon: '×2', color: 0xff72e8, hits: 18,
    copy: {
      zombie: ['炮台复制矩阵', '当前炮台数量 ×2，最多 8 座'],
      deadline: ['团队原地扩编', '当前救火工位数量 ×2，最多 8 组'],
    },
    apply() {
      const before = state.levels.cannon;
      state.levels.cannon = Math.min(MAX_CANNONS, Math.max(2, before * 2));
      if (state.levels.cannon === before) state.bonuses.damage *= 1.22;
      return `${before} → ${state.levels.cannon}${state.levels.cannon === before ? '，已满编改为火力 ×1.22' : ''}`;
    },
  },
  {
    id: 'team_half', icon: '÷2', color: 0xff8a55, hits: 12,
    copy: {
      zombie: ['献祭半数炮台', '炮台 ÷2，但余下炮台火力 ×2.25、射速 ×1.18'],
      deadline: ['裁员提效', '救火组 ÷2，但留下的人修复 ×2.25、手速 ×1.18'],
    },
    apply() {
      const before = state.levels.cannon;
      state.levels.cannon = Math.max(1, Math.ceil(before / 2));
      state.bonuses.damage *= 2.25;
      state.bonuses.rate *= 1.18;
      return `${before} → ${state.levels.cannon}，单组输出暴涨`;
    },
  },
  {
    id: 'rapid_flow', icon: '»2', color: 0x42efd2, hits: 16,
    copy: {
      zombie: ['供弹流水线', '永久射速 ×1.55，但火力暂时打九折'],
      deadline: ['工单自动流转', '永久处理速度 ×1.55，但单张反馈力度 ×0.9'],
    },
    apply() {
      state.bonuses.rate *= 1.55;
      state.bonuses.damage = Math.max(1, state.bonuses.damage * 0.9);
      return '速度 ×1.55，火力 ×0.9';
    },
  },
  {
    id: 'heavy_packet', icon: '×1.7', color: 0xffcf55, hits: 22,
    copy: {
      zombie: ['超重弹头', '永久火力 ×1.7，并追加 6% 暴击'],
      deadline: ['高优先级反馈', '每张工单力度 ×1.7，并追加 6% 一次通过'],
    },
    apply() {
      state.bonuses.damage *= 1.7;
      state.bonuses.crit += 0.06;
      return '火力 ×1.7，暴击 +6%';
    },
  },
  {
    id: 'split_queue', icon: '⑶+', color: 0x8fff65, hits: 20,
    copy: {
      zombie: ['弹头分叉', '多目标等级 +1，射速额外 ×1.12'],
      deadline: ['反馈自动抄送', '并行目标 +1，工单流转速度 ×1.12'],
    },
    apply() {
      state.levels.multi = Math.min(3, state.levels.multi + 1);
      state.bonuses.rate *= 1.12;
      return `并行目标 ${1 + state.levels.multi}，射速 ×1.12`;
    },
  },
  {
    id: 'blast_formula', icon: '✦+1', color: 0xff9f43, hits: 17,
    copy: {
      zombie: ['尸爆算式', '尸爆等级 +1，并追加永久火力 ×1.08'],
      deadline: ['异常批量关闭', '异常扩散等级 +1，并追加修复力 ×1.08'],
    },
    apply() {
      state.levels.blast = Math.min(5, state.levels.blast + 1);
      state.bonuses.damage *= 1.08;
      return `范围特效 Lv.${state.levels.blast}，火力 ×1.08`;
    },
  },
  {
    id: 'frost_formula', icon: '❄+1', color: 0x69d8ff, hits: 15,
    copy: {
      zombie: ['冷冻方程', '冰冻等级 +1，并追加永久射速 ×1.1'],
      deadline: ['需求冻结令', '冻结等级 +1，并追加处理速度 ×1.1'],
    },
    apply() {
      state.levels.frost = Math.min(4, state.levels.frost + 1);
      state.bonuses.rate *= 1.1;
      return `冻结特效 Lv.${state.levels.frost}，射速 ×1.1`;
    },
  },
  {
    id: 'chain_formula', icon: 'ϟ+1', color: 0xb37cff, hits: 19,
    copy: {
      zombie: ['连锁导电阵', '连锁等级 +1，并追加 3% 暴击'],
      deadline: ['调用链追踪', '调用链等级 +1，并追加 3% 一次通过'],
    },
    apply() {
      state.levels.chain = Math.min(5, state.levels.chain + 1);
      state.bonuses.crit += 0.03;
      return `连锁特效 Lv.${state.levels.chain}，暴击 +3%`;
    },
  },
  {
    id: 'crit_formula', icon: '※+1', color: 0xff6f91, hits: 18,
    copy: {
      zombie: ['猎杀暴击式', '暴击等级 +1，并追加永久火力 ×1.12'],
      deadline: ['一次过编译', '一次通过等级 +1，并追加修复力 ×1.12'],
    },
    apply() {
      state.levels.crit = Math.min(5, state.levels.crit + 1);
      state.bonuses.damage *= 1.12;
      return `暴击等级 Lv.${state.levels.crit}，火力 ×1.12`;
    },
  },
  {
    id: 'swap_stats', icon: '⇄', color: 0x68b8ff, hits: 15,
    copy: {
      zombie: ['火力射速互换', '交换当前火力与射速倍率，并补 4% 暴击'],
      deadline: ['开发测试互换', '交换当前修复力与处理速度，并补 4% 一次通过'],
    },
    apply() {
      const damage = state.bonuses.damage;
      state.bonuses.damage = Math.max(1.05, state.bonuses.rate);
      state.bonuses.rate = Math.max(1.05, damage);
      state.bonuses.crit += 0.04;
      return `火力 ×${state.bonuses.damage.toFixed(2)}，射速 ×${state.bonuses.rate.toFixed(2)}`;
    },
  },
  {
    id: 'odd_even', icon: '奇偶', color: 0xb980ff, hits: 17,
    copy: {
      zombie: ['奇偶炮阵', '奇数炮台则 ×2；偶数炮台则 ÷2 并火力 ×1.9'],
      deadline: ['奇偶编制', '奇数组则扩编 ×2；偶数组则裁半并效率 ×1.9'],
    },
    apply() {
      const before = state.levels.cannon;
      if (before % 2 === 1) state.levels.cannon = Math.min(MAX_CANNONS, before * 2);
      else {
        state.levels.cannon = Math.max(1, before / 2);
        state.bonuses.damage *= 1.9;
      }
      return before % 2 === 1 ? `${before} 为奇数：扩编至 ${state.levels.cannon}` : `${before} 为偶数：减至 ${state.levels.cannon}，火力 ×1.9`;
    },
  },
  {
    id: 'compound_risk', icon: '+30%', color: 0xff5f7a, hits: 14,
    copy: {
      zombie: ['透支城墙', '基地 -12%，火力与射速同时 ×1.3'],
      deadline: ['带病上线', '服务器 -12%，修复力与处理速度同时 ×1.3'],
    },
    apply() {
      state.baseHp = Math.max(1, state.baseHp - 12);
      state.bonuses.damage *= 1.3;
      state.bonuses.rate *= 1.3;
      return '基地 -12%，双倍率 ×1.3';
    },
  },
  {
    id: 'recovery', icon: '+25', color: 0x72ffad, hits: 13,
    copy: {
      zombie: ['战地回收', '基地 +25%，碎片 +1，射速 +8%'],
      deadline: ['回滚成功', '服务器 +25%，团队碎片 +1，处理速度 +8%'],
    },
    apply() {
      state.baseHp = Math.min(100, state.baseHp + 25);
      addCannonShard(1);
      state.bonuses.rate *= 1.08;
      return '恢复 25%，碎片 +1，射速 ×1.08';
    },
  },
  {
    id: 'roulette', icon: '?', color: 0xffffff, hits: 10,
    copy: {
      zombie: ['未知变异门', '从其他算术效果里随机执行一个'],
      deadline: ['未经评审直接上线', '从其他团队策略里随机执行一个'],
    },
    apply() {
      const pool = GATE_EFFECTS.filter((effect) => effect.id !== 'roulette');
      const picked = pool[Math.floor(state.random() * pool.length)];
      const detail = picked.apply();
      const title = picked.copy[currentTheme().id]?.[0] || picked.id;
      return `随机命中「${title}」：${detail}`;
    },
  },
]);

// 挡板颜色是刻意设计的干扰项：每轮重新洗牌，与收益、风险和效果类型完全解耦。
const GATE_DISTRACTOR_COLORS = Object.freeze([
  0xff536d, 0xff9f43, 0xffd84f, 0x8fff65, 0x4fffd2,
  0x62a8ff, 0xb37cff, 0xff72e8, 0x7ef0ff,
]);

function currentTheme() {
  return THEMES[state.themeId] || THEMES.zombie;
}

function currentLevel() {
  const levels = CAMPAIGNS[state.themeId] || CAMPAIGNS.zombie;
  return levels[clamp(state.level - 1, 0, levels.length - 1)];
}

function currentRoleMap() {
  return ENEMY_ROLES[state.themeId] || ENEMY_ROLES.zombie;
}

function bossHpFactor(levelNumber = state.level) {
  return Math.pow(BOSS_HP_GROWTH, Math.max(0, levelNumber - 1)) * currentLevel().bossHp;
}

function formatCompactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(number));
}

function renderLevelPicker() {
  const levels = CAMPAIGNS[state.themeId] || CAMPAIGNS.zombie;
  const level = currentLevel();
  els.levelPicker.innerHTML = '';
  levels.forEach((entry, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `level-button${index === state.level - 1 ? ' active' : ''}${index >= 6 ? ' danger' : ''}${index === 9 ? ' final' : ''}`;
    button.textContent = String(index + 1).padStart(2, '0');
    button.title = `第 ${index + 1} 关 · ${entry.title}`;
    button.addEventListener('click', () => selectLevel(index + 1));
    els.levelPicker.appendChild(button);
  });
  const uniqueRoles = [...new Set(level.roles)].map((id) => currentRoleMap()[id]).filter(Boolean);
  els.levelTitle.textContent = `第 ${state.level} 关 · ${level.title}`;
  els.levelDescription.textContent = level.description;
  els.levelEnemyHint.textContent = `敌方角色 ${uniqueRoles.length} 种 · ${state.level >= 5 ? '高阶精英已加入' : '逐步解锁精英'}`;
  els.levelBossHint.textContent = `Boss 指数生命 ×${bossHpFactor().toFixed(state.level >= 7 ? 0 : 1)}`;
  els.enemyRoster.innerHTML = [...uniqueRoles.slice(0, 4), { name: level.boss, visual: 'boss' }].map((role) => {
    const frame = ENEMY_ATLAS_FRAMES[role.visual] || 0;
    return `
      <div class="enemy-roster-item">
        <i style="background-image:url('./assets/characters/${state.themeId}-atlas.svg?v=0.14.0');background-position:${frame * 25}% center"></i>
        <span>${role.name}</span>
      </div>
    `;
  }).join('');
  els.startButtonHint.textContent = `${level.duration} 秒构筑 · 最终 Boss ${level.boss}`;
  els.time.textContent = String(level.duration);
  els.level.textContent = `${String(state.level).padStart(2, '0')}/10`;
}

function selectLevel(levelNumber, { persist = true } = {}) {
  if (state.mode !== 'menu') return;
  state.level = clamp(Math.trunc(Number(levelNumber) || 1), 1, 10);
  if (persist) localStorage.setItem(`toy-toy-toy-level-${state.themeId}`, String(state.level));
  renderLevelPicker();
  updateHud(true);
}

function upgradePresentation(upgrade) {
  const copy = currentTheme().upgrades[upgrade.id];
  return {
    title: copy?.[0] || upgrade.title,
    description: copy?.[1] || upgrade.describe(),
  };
}

function applyTheme(themeId, { persist = true, refreshLeaderboard = true } = {}) {
  const theme = THEMES[themeId];
  if (!theme) return;
  state.themeId = themeId;
  if (persist) localStorage.setItem('toy-toy-toy-theme', themeId);
  els.shell.dataset.theme = theme.id;
  visualSystem.setTheme(theme.id);

  document.title = `广告爽游实验室 · ${theme.title}`;
  document.documentElement.style.setProperty('--mint', theme.palette.accent);
  document.documentElement.style.setProperty('--lime', theme.palette.secondary);
  document.documentElement.style.setProperty('--yellow', theme.palette.yellow);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', `#${theme.palette.bg.toString(16).padStart(6, '0')}`);

  els.brandKicker.textContent = theme.brandKicker;
  els.brandTitle.textContent = theme.title;
  els.startEyebrow.textContent = theme.eyebrow;
  els.startTitle.textContent = theme.title;
  els.startEnglish.textContent = theme.english;
  els.startDescription.textContent = theme.description;
  els.featureRow.innerHTML = theme.features.map((feature) => `<span>${feature}</span>`).join('');
  els.startButtonLabel.textContent = theme.startButton;
  els.startButtonHint.textContent = theme.startButtonHint;
  els.startHint.textContent = theme.startHint;
  els.leaderboardKicker.textContent = theme.leaderboardKicker;
  els.leaderboardTitle.textContent = theme.leaderboardTitle;
  els.baseStatusLabel.textContent = theme.baseLabel;
  els.cannonMetricLabel.textContent = theme.id === 'deadline' ? '救火组' : '炮台';
  els.shardMetricLabel.textContent = theme.id === 'deadline' ? '团队碎片' : '碎片';
  els.laneControlLabel.textContent = theme.laneControlLabel;
  theme.lanes.forEach((label, index) => { els.laneLabels[index].textContent = label; });
  els.laneHint.textContent = theme.laneHint;
  [els.damageChipLabel, els.rateChipLabel, els.blastChipLabel, els.chainChipLabel, els.frostChipLabel]
    .forEach((element, index) => { element.textContent = theme.weaponLabels[index]; });
  els.upgradeEyebrow.textContent = theme.upgradeEyebrow;
  els.upgradeTitle.textContent = theme.upgradeTitle;
  els.resumeButtonLabel.textContent = theme.resumeLabel;
  els.frenzyIcon.textContent = theme.director.frenzyIcon;
  els.frenzyLabel.textContent = theme.director.frenzyLabel;
  els.frenzyDescription.textContent = theme.director.frenzyDescription;
  els.overdriveIcon.textContent = theme.director.overdriveIcon;
  els.overdriveLabel.textContent = theme.director.overdriveLabel;
  els.overdriveDescription.textContent = theme.director.overdriveDescription;
  els.bossIcon.textContent = theme.director.bossIcon;
  els.bossButtonLabel.textContent = theme.director.bossLabel;
  els.bossButtonDescription.textContent = theme.director.bossDescription;
  els.themeButtons.forEach((button) => button.classList.toggle('active', button.dataset.theme === themeId));
  state.level = clamp(Number(localStorage.getItem(`toy-toy-toy-level-${themeId}`) || state.level || 1), 1, 10);
  renderLevelPicker();

  scene.background.setHex(theme.palette.bg);
  scene.fog.color.setHex(theme.palette.fog);
  groundMaterial.color.setHex(theme.palette.ground);
  wallMaterial.color.setHex(theme.palette.wall);
  wallMaterial.emissive.setHex(theme.palette.wallEmissive);
  coreMaterial.emissive.setHex(theme.palette.core);
  coreMaterial.color.setHex(theme.palette.wall);
  core.visible = theme.id === 'zombie';
  baseLight.color.setHex(theme.palette.core);
  projectileMaterial.color.setHex(theme.palette.projectile).multiplyScalar(1.9);
  projectileAuraMaterial.color.setHex(theme.palette.core).multiplyScalar(1.6);
  projectileTrailMaterial.color.setHex(theme.id === 'deadline' ? 0xff526a : 0xff9f43);
  focusLaneMaterial.color.setHex(theme.palette.core);
  focusRailMaterial.color.setHex(theme.palette.core);
  for (const visual of Object.values(enemyVisuals)) {
    visual.mesh.material = visual.materials[theme.id];
    visual.outlineMesh.material = visual.outlineMaterials[theme.id];
  }
  turretGroups.forEach(({ housingMaterial, barrelMaterial, coreMaterial, screenMaterial, cannonModel, workbenchModel, heroHaloMaterial }) => {
    housingMaterial.color.setHex(theme.palette.core);
    housingMaterial.emissive.setHex(theme.palette.core);
    barrelMaterial.emissive.setHex(theme.palette.core);
    coreMaterial.emissive.setHex(theme.palette.core);
    screenMaterial.emissive.setHex(theme.id === 'deadline' ? 0x2388d4 : theme.palette.core);
    heroHaloMaterial.color.setHex(theme.id === 'deadline' ? 0x62a8ff : theme.palette.core);
    cannonModel.visible = theme.id === 'zombie';
    workbenchModel.visible = theme.id === 'deadline';
  });
  projectilePool.forEach(({ energy, ticket }) => {
    energy.visible = theme.id === 'zombie';
    ticket.visible = theme.id === 'deadline';
  });

  if (refreshLeaderboard) loadLeaderboard();
}

function randomBetween(min, max) {
  return min + (max - min) * state.random();
}

function setOverlay(element, visible) {
  element.classList.toggle('visible', visible);
}

let toastTimer = 0;
function showToast(message, duration = 1900) {
  els.toast.textContent = message;
  els.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => els.toast.classList.remove('visible'), duration);
}

function showOverdriveBanner(text = 'FIREPOWER OVERDRIVE') {
  els.overdriveBanner.textContent = text;
  els.overdriveBanner.classList.remove('visible');
  void els.overdriveBanner.offsetWidth;
  els.overdriveBanner.classList.add('visible');
}

function resize() {
  const width = Math.max(1, els.stage.clientWidth);
  const height = Math.max(1, els.stage.clientHeight);
  const viewHeight = 31;
  const aspect = width / height;
  camera.left = -(viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
  visualSystem.resize(width, height);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  els.fxCanvas.width = Math.round(width * dpr);
  els.fxCanvas.height = Math.round(height * dpr);
  els.fxCanvas.style.width = `${width}px`;
  els.fxCanvas.style.height = `${height}px`;
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function clearWorldState() {
  enemies.length = 0;
  speechBubbles.length = 0;
  bonusTargets.splice(0).forEach(disposeBonusTarget);
  choiceGates.splice(0).forEach(disposeChoiceGate);
  Object.values(enemyVisuals).forEach((visual) => { visual.mesh.count = 0; });
  enemyShadowMesh.count = 0;
  projectilePool.forEach((projectile) => {
    projectile.active = false;
    projectile.mesh.visible = false;
  });
  fxItems.length = 0;
  lightningItems.length = 0;
  visualSystem.reset(state.seed);
}

function resetGame() {
  const theme = currentTheme();
  clearWorldState();
  state.seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  state.random = mulberry32(state.seed);
  visualSystem.reset(state.seed);
  state.elapsed = 0;
  state.score = 0;
  state.kills = 0;
  state.combo = 1;
  state.maxCombo = 1;
  state.comboUntil = 0;
  state.lastVictory = false;
  state.baseHp = 100;
  state.focusLane = 1;
  state.fireAcc = Array(MAX_CANNONS).fill(0);
  state.spawnAcc = 0;
  state.nextBonusAt = Number.POSITIVE_INFINITY;
  state.nextBarrierAt = Number.POSITIVE_INFINITY;
  state.nextMysteryAt = Number.POSITIVE_INFINITY;
  state.nextGateAt = 6.2 + randomBetween(0, 1.1);
  state.gatePhase = 'none';
  state.gatePrepUntil = 0;
  state.gateChoiceUntil = 0;
  state.gateResumeAt = 0;
  state.gateRound = 0;
  state.lastGateEffect = '';
  state.nextSpeechAt = 2.8 + randomBetween(0, 1.6);
  state.nextUpgradeAt = Number.POSITIVE_INFINITY;
  state.upgradeDeadline = 0;
  state.currentUpgrades = [];
  state.frenzyUntil = 0;
  state.overdriveUntil = 0;
  state.turretUpgradeUntil = 0;
  state.lastTurretUpgrade = '';
  state.bailoutUsed = false;
  state.bossSpawned = false;
  state.bossAlive = false;
  state.bossDefeated = false;
  state.finishAt = 0;
  state.shake = 0;
  state.flash = 0;
  state.flashColor = '#ffffff';
  state.hitStopUntil = 0;
  state.lastHitStopAt = 0;
  state.lastShotSoundAt = 0;
  state.lastImpactSoundAt = 0;
  state.lastKillSoundAt = 0;
  state.lastLaneSoundAt = 0;
  state.telemetry = {
    spawned: 0, shots: 0, speech: 0, frenzyUses: 0, overdriveUses: 0, bossUses: 0,
    upgrades: 0, gatesOffered: 0, gatesChosen: 0, impacts: 0, criticalHits: 0, specialImpacts: 0, hitStops: 0,
  };
  // 关卡敌人会增长，基础装备也必须有温和科技成长；否则高关开局的来袭 HP/s 已超过裸装 DPS，第一扇门前就数学无解。
  const campaignDamage = Math.pow(1.05, Math.max(0, state.level - 1));
  const campaignRate = Math.pow(1.04, Math.max(0, state.level - 1));
  state.bonuses = { damage: campaignDamage, rate: campaignRate, crit: 0, count: 0, shards: 0, barriers: 0 };
  state.levels = { damage: 1, rate: 1, blast: 0, chain: 0, frost: 0, multi: 0, crit: 0, cannon: 1 };
  wallMaterial.color.setHex(theme.palette.wall);
  wallMaterial.emissive.setHex(theme.palette.wallEmissive);
  coreMaterial.emissive.setHex(theme.palette.core);
  baseLight.color.setHex(theme.palette.core);
  baseLight.intensity = 11;
  focusLaneGlow.position.x = 0;
  focusRail.position.x = 0;
  turretGroups.forEach((turret, index) => {
    turret.group.visible = index === 0;
    turret.group.position.x = 0;
    turret.group.position.z = 10.2;
    turret.group.scale.setScalar(1);
    turret.pivot.position.z = 0;
    turret.keyboard.rotation.x = 0;
    turret.recoil = 0;
    turret.movementLean = 0;
    turret.lastX = 0;
    turret.evolutionStage = 0;
    turret.cannonEvolutionStages.forEach((stage) => { stage.visible = false; });
    turret.workbenchEvolutionStages.forEach((stage) => { stage.visible = false; });
  });
  els.bossHud.classList.add('hidden');
  selectLane(1);
  updateHud(true);
}

function startGame() {
  const theme = currentTheme();
  ensureAudio();
  resetGame();
  state.mode = 'playing';
  state.lastTs = performance.now();
  setOverlay(els.startOverlay, false);
  setOverlay(els.resultOverlay, false);
  setOverlay(els.pauseOverlay, false);
  setOverlay(els.upgradeOverlay, false);
  showToast(`第 ${state.level} 关「${currentLevel().title}」：${theme.openingToast}`, 2600);
  for (let i = 0; i < 10; i += 1) spawnEnemy(i < 2 ? 'runner' : 'normal');
}

function showMenu() {
  state.mode = 'menu';
  setOverlay(els.resultOverlay, false);
  setOverlay(els.pauseOverlay, false);
  setOverlay(els.upgradeOverlay, false);
  setOverlay(els.startOverlay, true);
  els.pauseBtn.innerHTML = '<span>Ⅱ</span> 游戏菜单';
  renderLevelPicker();
  loadLeaderboard();
}

function updatePauseMenu() {
  const theme = currentTheme();
  els.pauseRunLabel.textContent = `${theme.title} · 第 ${state.level} 关 · ${currentLevel().title}`;
  els.pauseScoreValue.textContent = formatScore(state.score);
  els.pauseKillsValue.textContent = formatScore(state.kills);
  els.pauseBaseValue.textContent = `${Math.max(0, Math.round(state.baseHp))}%`;
  els.pauseThemeHint.textContent = theme.id === 'zombie' ? '切换到程序员模式' : '切换到尸潮模式';
}

function togglePause(forceResume = false) {
  if (state.mode === 'playing' && !forceResume) {
    state.mode = 'paused';
    updatePauseMenu();
    setOverlay(els.pauseOverlay, true);
    els.pauseBtn.innerHTML = '<span>▶</span> 继续游戏';
    updateHud(true);
    return;
  }
  if (state.mode === 'paused') {
    state.mode = 'playing';
    state.lastTs = performance.now();
    setOverlay(els.pauseOverlay, false);
    els.pauseBtn.innerHTML = '<span>Ⅱ</span> 游戏菜单';
    updateHud(true);
  }
}

function switchThemeFromPause() {
  const nextTheme = state.themeId === 'zombie' ? 'deadline' : 'zombie';
  showMenu();
  applyTheme(nextTheme);
  showToast(`已切换到「${currentTheme().title}」，请选择关卡后开始`, 2200);
}

function pickEnemyRole(forceRole = null) {
  const roleMap = currentRoleMap();
  if (forceRole && roleMap[forceRole]) return { id: forceRole, ...roleMap[forceRole] };
  let roleIds = [...currentLevel().roles];
  if (forceRole && ['normal', 'runner', 'tank', 'elite'].includes(forceRole)) {
    const matching = roleIds.filter((id) => roleMap[id]?.visual === forceRole);
    if (matching.length) roleIds = matching;
  }
  const weighted = roleIds.map((id) => ({ id, ...roleMap[id] })).filter((role) => role.name);
  const total = weighted.reduce((sum, role) => sum + (role.weight || 1), 0);
  let roll = state.random() * Math.max(1, total);
  for (const role of weighted) {
    roll -= role.weight || 1;
    if (roll <= 0) return role;
  }
  return weighted[0] || { id: 'normal', name: '敌人', visual: 'normal', hp: 1, speed: 1, scale: 1, score: 11, damage: 5, tint: 0xffffff };
}

function spawnEnemy(forceRole = null, options = {}) {
  const theme = currentTheme();
  const level = currentLevel();
  if (enemies.filter((enemy) => enemy.active).length >= WORLD.maxEnemies) return null;
  const progress = clamp(state.elapsed / level.duration, 0, 1);
  const isBoss = forceRole === 'boss';
  const role = isBoss ? null : pickEnemyRole(forceRole);
  const type = isBoss ? 'boss' : role.visual;
  const lane = isBoss ? 1 : clamp(Number.isFinite(options.lane) ? options.lane : Math.floor(state.random() * 3), 0, 2);
  const regularBaseHp = (18 + state.level * 1.5 + progress * 31) * theme.hpMultiplier * level.hp;
  const hp = isBoss
    ? 9200 * bossHpFactor() * theme.bossHpMultiplier
    : regularBaseHp * role.hp;
  const enemy = {
    active: true,
    id: `${state.seed}-${state.elapsed}-${enemies.length}`,
    type,
    roleId: isBoss ? 'boss' : role.id,
    roleName: isBoss ? level.boss : role.name,
    lane,
    x: WORLD.lanes[lane] + (isBoss ? 0 : randomBetween(-1.15, 1.15)),
    y: 0.62,
    z: Number.isFinite(options.z) ? options.z : WORLD.spawnZ - randomBetween(0, 2.2),
    hp,
    maxHp: hp,
    speed: isBoss
      ? Math.max(0.12, 0.235 - (state.level - 1) * 0.011)
      : (1.18 + progress * 0.78) * theme.speedMultiplier * level.speed * role.speed,
    scale: isBoss ? level.bossScale : role.scale,
    score: isBoss ? Math.round(5000 * Math.pow(1.45, state.level - 1)) : Math.round(role.score * (1 + state.level * 0.12)),
    baseDamage: isBoss ? 100 : Math.max(1, Math.round(role.damage * (0.34 + (state.level - 1) * 0.007))),
    tint: isBoss ? level.bossTint : role.tint,
    slowUntil: 0,
    hitUntil: 0,
    impactPulse: 0,
    impactSide: 0,
    wobble: randomBetween(0, Math.PI * 2),
    speechCount: 0,
  };

  if (isBoss) {
    enemy.x = 0;
    enemy.z = WORLD.spawnZ - 1.5;
    state.bossSpawned = true;
    state.bossAlive = true;
    els.bossName.textContent = `${level.boss} · ${formatCompactNumber(enemy.maxHp)} HP`;
    els.bossHud.classList.remove('hidden');
  } else if (role.weight <= 5 && state.random() < 0.08) {
    addFxText(enemy.x, 1.15 * enemy.scale, enemy.z, role.name, cssHex(role.tint), 1.15, 11);
  }

  enemies.push(enemy);
  state.telemetry.spawned += 1;
  return enemy;
}

function summonBoss(manual = false) {
  const theme = currentTheme();
  if (state.mode !== 'playing' || state.gatePhase !== 'none' || state.bossSpawned || state.bossAlive || state.bossDefeated) return;
  const boss = spawnEnemy('boss');
  if (!boss) {
    showToast('战场单位已满，清出空间后才能召唤 Boss', 1800);
    return;
  }
  if (manual) state.telemetry.bossUses += 1;
  let cleared = 0;
  for (const enemy of enemies) {
    if (!enemy.active || enemy === boss || enemy.type === 'boss') continue;
    enemy.active = false;
    cleared += 1;
    state.score += Math.round(enemy.score * 0.2);
  }
  if (cleared) addFxText(0, 1.7, -2.8, `Boss 压场清算 ${cleared}`, theme.palette.secondary, 1.35, 15);
  state.shake = Math.max(state.shake, 0.85);
  state.hitStopUntil = Math.max(state.hitStopUntil, performance.now() + 120);
  visualSystem.pulseBloom(0.5);
  showToast(manual ? theme.director.manualBossToast : theme.director.bossToast, 2600);
  showOverdriveBanner(theme.director.bossBanner);
  sfx.boss();
  for (let i = 0; i < 18; i += 1) addFxParticle(boss.x, 1, boss.z, cssHex(theme.palette.enemies.boss), 1.1);
  const bossLines = theme.speech?.boss || [];
  if (bossLines.length) showEnemySpeech(boss, bossLines[Math.floor(state.random() * bossLines.length)], 3.6);
}

function triggerFrenzy() {
  const theme = currentTheme();
  if (state.mode !== 'playing' || state.gatePhase !== 'none') return;
  state.telemetry.frenzyUses += 1;
  state.frenzyUntil = Math.max(state.frenzyUntil, state.elapsed + 8);
  showToast(theme.director.frenzyToast);
  showOverdriveBanner(theme.director.frenzyBanner);
  state.shake = Math.max(state.shake, 0.42);
  sfx.warning();
  for (let i = 0; i < 30; i += 1) spawnEnemy(i % 4 === 0 ? 'runner' : 'normal');
}

function triggerOverdrive(auto = false) {
  const theme = currentTheme();
  if (state.mode !== 'playing') return;
  state.telemetry.overdriveUses += 1;
  state.overdriveUntil = Math.max(state.overdriveUntil, state.elapsed + 10);
  triggerTurretUpgradeEffect('overdrive', theme.id === 'deadline' ? '咖啡因全栈超频' : '反应堆火力超载');
  showToast(auto ? theme.director.bailoutToast : theme.director.overdriveToast);
  showOverdriveBanner(auto ? theme.director.bailoutBanner : theme.director.overdriveBanner);
  state.shake = Math.max(state.shake, 0.36);
  sfx.overdrive();
}

function showEnemySpeech(enemy, text, life = 2.8) {
  if (!enemy?.active || !text) return;
  enemy.speechCount += 1;
  speechBubbles.push({ enemy, text, life, maxLife: life });
  state.telemetry.speech += 1;
}

function scheduleCharacterSpeech() {
  if (state.elapsed < state.nextSpeechAt || speechBubbles.length >= 2) return;
  state.nextSpeechAt = state.elapsed + randomBetween(2.6, 5.2);
  // 大多数时间让战场保持干净，台词只作为偶尔冒出来的身份彩蛋。
  if (state.random() > 0.72) return;
  const activeSpeechLanes = new Set(speechBubbles.map((bubble) => bubble.enemy?.lane));
  const candidates = enemies.filter((enemy) => (
    enemy.active
    && enemy.type !== 'boss'
    && enemy.speechCount < 1
    && enemy.z > WORLD.spawnZ + 1.2
    && enemy.z < WORLD.baseZ - 3.5
    && !activeSpeechLanes.has(enemy.lane)
  ));
  if (!candidates.length) return;
  const enemy = candidates[Math.floor(state.random() * candidates.length)];
  const lines = currentRoleMap()[enemy.roleId]?.lines
    || currentTheme().speech?.[enemy.roleId]
    || currentTheme().speech?.[enemy.type]
    || currentTheme().speech?.normal
    || [];
  if (!lines.length) return;
  showEnemySpeech(enemy, lines[Math.floor(state.random() * lines.length)]);
}

function updateCharacterSpeech(dt) {
  scheduleCharacterSpeech();
  for (let index = speechBubbles.length - 1; index >= 0; index -= 1) {
    const bubble = speechBubbles[index];
    bubble.life -= dt;
    if (bubble.life <= 0 || !bubble.enemy?.active) speechBubbles.splice(index, 1);
  }
}

function bonusCanvasSprite(icon, title, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(3, 10, 18, 0.9)';
  ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 176, 28);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.font = '900 84px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, 84, 96);
  ctx.fillStyle = '#effaff';
  ctx.font = '900 31px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, 145, 78);
  ctx.fillStyle = '#94afbf';
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText('击破获取永久强化', 145, 119);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: true }));
  sprite.scale.set(3.15, 1.18, 1);
  sprite.position.y = 1.62;
  sprite.renderOrder = 12;
  return sprite;
}

function createBonusTarget(type, lane, z = WORLD.spawnZ + 4.2) {
  const theme = currentTheme();
  const config = BONUS_CONFIG[type];
  const copy = theme.bonus[type] || theme.bonus.mystery;
  const group = new THREE.Group();
  group.position.set(WORLD.lanes[lane], 0.04, z);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.84, 0.105, 10, 30), ringMaterial);
  ring.rotation.x = -0.72;
  ring.renderOrder = 10;
  group.add(ring);
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: type === 'barrier' ? 0.14 : 0.28,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const coreMesh = new THREE.Mesh(new THREE.CircleGeometry(0.69, 24), coreMaterial);
  coreMesh.rotation.x = -0.72;
  coreMesh.renderOrder = 9;
  group.add(coreMesh);
  const floorMaterial = new THREE.MeshBasicMaterial({
    color: config.color,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const floorHalo = new THREE.Mesh(new THREE.RingGeometry(0.76, 1.08, 28), floorMaterial);
  floorHalo.rotation.x = -Math.PI / 2;
  floorHalo.position.y = 0.02;
  group.add(floorHalo);
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.16, 3.2, 10),
    new THREE.MeshBasicMaterial({ color: config.color, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
  beam.position.y = 1.6;
  group.add(beam);
  if (type === 'barrier') {
    const barrierMaterial = new THREE.MeshBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const barrier = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 1.72), barrierMaterial);
    barrier.rotation.x = -0.72;
    barrier.position.y = 0.9;
    group.add(barrier);
    [-1.7, 1.7].forEach((x) => {
      const pylon = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 2.2, 0.22),
        new THREE.MeshBasicMaterial({ color: config.color, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending }),
      );
      pylon.position.set(x, 1.05, 0);
      group.add(pylon);
    });
  }
  group.add(bonusCanvasSprite(copy[0], copy[1], config.color));
  worldGroup.add(group);
  const target = {
    active: true,
    kind: 'bonus',
    rewardType: type,
    lane,
    x: WORLD.lanes[lane],
    y: 0.8,
    z,
    hp: config.hp * (1 + state.elapsed * 0.018),
    maxHp: config.hp * (1 + state.elapsed * 0.018),
    scale: config.scale,
    speed: config.speed,
    score: config.score,
    wobble: randomBetween(0, Math.PI * 2),
    hitUntil: 0,
    group,
    ring,
    ringMaterial,
    coreMaterial,
  };
  bonusTargets.push(target);
  return target;
}

function disposeBonusTarget(target) {
  if (!target?.group) return;
  worldGroup.remove(target.group);
  target.group.traverse((child) => {
    if (!child.isMesh && !child.isSprite) return;
    child.geometry?.dispose();
    const material = child.material;
    if (material?.map) material.map.dispose();
    material?.dispose();
  });
  target.active = false;
}

function gateOutcomePreview(effect) {
  const theme = currentTheme();
  const teamLabel = theme.id === 'deadline' ? '组' : '座';
  const team = state.levels.cannon;
  const damage = state.bonuses.damage;
  const rate = state.bonuses.rate;
  switch (effect.id) {
    case 'team_double': return { primary: `${team} → ${Math.min(MAX_CANNONS, Math.max(2, team * 2))} ${teamLabel}`, secondary: team >= MAX_CANNONS ? '已满编：改为火力 ×1.22' : '单位数量直接翻倍' };
    case 'team_half': return { primary: `${team} → ${Math.max(1, Math.ceil(team / 2))} ${teamLabel}`, secondary: '余下单位火力 ×2.25 · 射速 ×1.18' };
    case 'rapid_flow': return { primary: `射速 ×${rate.toFixed(2)} → ×${(rate * 1.55).toFixed(2)}`, secondary: `火力 ×${damage.toFixed(2)} → ×${Math.max(1, damage * 0.9).toFixed(2)}` };
    case 'heavy_packet': return { primary: `火力 ×${damage.toFixed(2)} → ×${(damage * 1.7).toFixed(2)}`, secondary: '暴击率额外 +6%' };
    case 'split_queue': return { primary: `并行 ${1 + state.levels.multi} → ${2 + Math.min(3, state.levels.multi)} 个`, secondary: '射速额外 ×1.12' };
    case 'blast_formula': return { primary: `范围特效 Lv.${state.levels.blast} → Lv.${Math.min(5, state.levels.blast + 1)}`, secondary: '火力额外 ×1.08' };
    case 'frost_formula': return { primary: `冻结 Lv.${state.levels.frost} → Lv.${Math.min(4, state.levels.frost + 1)}`, secondary: '射速额外 ×1.10' };
    case 'chain_formula': return { primary: `连锁 Lv.${state.levels.chain} → Lv.${Math.min(5, state.levels.chain + 1)}`, secondary: '暴击率额外 +3%' };
    case 'crit_formula': return { primary: `暴击 Lv.${state.levels.crit} → Lv.${Math.min(5, state.levels.crit + 1)}`, secondary: '火力额外 ×1.12' };
    case 'swap_stats': return { primary: `火力 ×${damage.toFixed(2)} ⇄ 射速 ×${rate.toFixed(2)}`, secondary: '交换后补暴击率 +4%' };
    case 'odd_even': return team % 2 === 1
      ? { primary: `${team} 是奇数 → ${Math.min(MAX_CANNONS, team * 2)} ${teamLabel}`, secondary: '奇数触发扩编 ×2' }
      : { primary: `${team} 是偶数 → ${Math.max(1, team / 2)} ${teamLabel}`, secondary: '裁半，但火力 ×1.90' };
    case 'compound_risk': return { primary: '火力 ×1.30 · 射速 ×1.30', secondary: `${theme.baseLabel}立即 -12%` };
    case 'recovery': return { primary: `${theme.baseLabel} +25%`, secondary: '碎片 +1 · 射速 ×1.08' };
    case 'roulette': return { primary: '随机执行另一项效果', secondary: '结果完全未知，颜色也不给提示' };
    default: return { primary: effect.icon, secondary: effect.copy[theme.id]?.[1] || '' };
  }
}

function gateBoardSprite(effect, hitsRemaining, requiredHits, color, lane) {
  const canvas = document.createElement('canvas');
  canvas.width = 760;
  canvas.height = 420;
  const ctx = canvas.getContext('2d');
  const preview = gateOutcomePreview(effect);
  const theme = currentTheme();
  const laneName = theme.lanes[lane] || `路线 ${lane + 1}`;
  const drawFitted = (text, x, y, maxWidth, startSize, minSize, weight = 900) => {
    let size = startSize;
    do {
      ctx.font = `${weight} ${size}px system-ui, sans-serif`;
      size -= 1;
    } while (ctx.measureText(text).width > maxWidth && size > minSize);
    ctx.fillText(text, x, y);
  };
  const redraw = (hits) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(3, 9, 18, 0.97)';
    ctx.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.roundRect(12, 12, 736, 396, 34);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#88a3b5';
    ctx.font = '900 22px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${laneName} · COLOR IS NOISE / 颜色不代表收益`, 34, 42);
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawFitted(effect.icon, 118, 158, 168, 112, 58, 1000);
    ctx.fillStyle = '#effaff';
    ctx.textAlign = 'left';
    drawFitted(effect.copy[theme.id]?.[0] || effect.id, 220, 92, 500, 39, 27, 1000);
    ctx.fillStyle = '#ffffff';
    drawFitted(preview.primary, 220, 156, 500, 49, 30, 1000);
    ctx.fillStyle = '#a9c1d0';
    drawFitted(preview.secondary, 220, 218, 500, 27, 19, 800);

    const ratio = clamp((requiredHits - hits) / Math.max(1, requiredHits), 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.roundRect(34, 275, 692, 30, 15);
    ctx.fill();
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    ctx.beginPath();
    ctx.roundRect(34, 275, Math.max(12, 692 * ratio), 30, 15);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '1000 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(
      hits > 0
        ? `${theme.id === 'deadline' ? '剩余反馈' : '剩余炮击'} ${hits} / ${requiredHits}`
        : '已击穿 · 正在锁定选择',
      380,
      352,
    );
  };
  redraw(hitsRemaining);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, fog: true }));
  sprite.scale.set(5.35, 2.96, 1);
  sprite.position.y = 2.12;
  sprite.renderOrder = 15;
  return { sprite, texture, redraw, preview };
}

function createChoiceGate(effect, lane, requiredHits, color) {
  const startZ = -8.4;
  const group = new THREE.Group();
  group.position.set(WORLD.lanes[lane], 0.04, startZ);
  const floor = new THREE.Mesh(
    new THREE.RingGeometry(1.35, 2.2, 36),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(4.8, 2.65),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  wall.rotation.x = -0.72;
  wall.position.y = 1.25;
  group.add(wall);
  [-2.15, 2.15].forEach((x) => {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.9, 0.25), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending }));
    pillar.position.set(x, 1.4, 0);
    group.add(pillar);
  });
  const board = gateBoardSprite(effect, requiredHits, requiredHits, color, lane);
  group.add(board.sprite);
  worldGroup.add(group);
  const gate = {
    active: true,
    kind: 'gate',
    effect,
    displayColor: color,
    lane,
    x: WORLD.lanes[lane],
    y: 1.2,
    z: startZ,
    speed: 0.58 + state.level * 0.012,
    hitsRemaining: requiredHits,
    requiredHits,
    scale: 1,
    wobble: randomBetween(0, Math.PI * 2),
    hitUntil: 0,
    group,
    board,
    floor,
  };
  choiceGates.push(gate);
  return gate;
}

function disposeChoiceGate(gate) {
  if (!gate?.group) return;
  worldGroup.remove(gate.group);
  gate.group.traverse((child) => {
    if (!child.isMesh && !child.isSprite) return;
    child.geometry?.dispose();
    const material = child.material;
    if (material?.map) material.map.dispose();
    material?.dispose();
  });
  gate.active = false;
}

function expireChoiceGate(gate, text = '挡板锁定') {
  if (!gate?.active) return;
  addFxText(gate.x, 1.35, gate.z, text, '#94afbf', 1.05, 12);
  disposeChoiceGate(gate);
  const index = choiceGates.indexOf(gate);
  if (index >= 0) choiceGates.splice(index, 1);
}

function expireBonusTarget(target, missed = false) {
  if (!target?.active) return;
  if (missed) addFxText(target.x, 1.05, target.z, 'BONUS 错过', '#8ba6b8', 0.8, 11);
  disposeBonusTarget(target);
  const index = bonusTargets.indexOf(target);
  if (index >= 0) bonusTargets.splice(index, 1);
}

function addCannonShard(amount) {
  state.bonuses.shards += amount;
  let gained = 0;
  while (state.bonuses.shards >= 2 && state.levels.cannon < MAX_CANNONS) {
    state.bonuses.shards -= 2;
    state.levels.cannon += 1;
    gained += 1;
  }
  return gained;
}

function grantBonus(target) {
  const theme = currentTheme();
  const copy = theme.bonus[target.rewardType] || theme.bonus.mystery;
  let message = copy[2];
  let banner = `${copy[0]} ${copy[1]}`;
  let cannonGained = 0;
  if (target.rewardType === 'damage') state.bonuses.damage += 0.18;
  else if (target.rewardType === 'rate') state.bonuses.rate += 0.14;
  else if (target.rewardType === 'crit') state.bonuses.crit += 0.05;
  else if (target.rewardType === 'barrier') {
    state.bonuses.barriers += 1;
    state.bonuses.damage += 0.12;
    state.bonuses.rate += 0.1;
    cannonGained = addCannonShard(1);
    state.baseHp = Math.min(100, state.baseHp + 8);
    message = `结界击破：火力 +12%，射速 +10%，炮台碎片 +1${cannonGained ? '，新炮台解锁' : ''}`;
    banner = `${copy[0]} 结界击破`;
  } else {
    const roll = state.random();
    if (roll < 0.34) {
      state.bonuses.damage += 0.28;
      state.bonuses.rate += 0.2;
      message = '隐藏大奖：火力 +28%，射速 +20%';
    } else if (roll < 0.68) {
      cannonGained = addCannonShard(2);
      state.bonuses.damage += 0.1;
      message = `隐藏大奖：火力 +10%，炮台碎片 +2${cannonGained ? '，新炮台解锁' : ''}`;
    } else {
      state.bonuses.crit += 0.12;
      state.bonuses.damage += 0.15;
      message = '隐藏大奖：暴击率 +12%，火力 +15%';
    }
    banner = `${copy[0]} 隐藏大奖`;
  }
  state.bonuses.count += 1;
  state.score += Math.round(target.score * (1 + state.bonuses.count * 0.08));
  addShockwave(target.x, target.z, cssHex(BONUS_CONFIG[target.rewardType].color), target.rewardType === 'barrier' ? 2.8 : 1.25);
  for (let i = 0; i < (target.rewardType === 'barrier' ? 22 : 10); i += 1) {
    addFxParticle(target.x, 1, target.z, cssHex(BONUS_CONFIG[target.rewardType].color), target.rewardType === 'barrier' ? 1.2 : 0.8);
  }
  showOverdriveBanner(banner);
  showToast(message, 2500);
  sfx.upgrade();
  updateHud(true);
}

function beginGatePrep() {
  if (state.gatePhase !== 'none' || state.bossAlive || state.bossDefeated) return;
  state.gatePhase = 'prep';
  state.gatePrepUntil = state.elapsed + 0.9;
  showOverdriveBanner(currentTheme().id === 'deadline' ? 'REVIEW CONVOY' : 'ARITHMETIC CONVOY');
  showToast(currentTheme().id === 'deadline'
    ? '评审方案混进需求队伍：准备调度工位，三选一击穿'
    : '算术挡板混进尸群：准备切路，只能轰开其中一门', 1900);
}

function spawnChoiceGates() {
  const shuffle = (items) => {
    const pool = [...items];
    for (let index = pool.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(state.random() * (index + 1));
      [pool[index], pool[swap]] = [pool[swap], pool[index]];
    }
    return pool;
  };
  const arithmeticIds = new Set(['team_double', 'team_half', 'rapid_flow', 'heavy_packet', 'swap_stats', 'odd_even', 'compound_risk']);
  const arithmetic = shuffle(GATE_EFFECTS.filter((effect) => arithmeticIds.has(effect.id) && effect.id !== state.lastGateEffect));
  const remainder = shuffle(GATE_EFFECTS.filter((effect) => !arithmetic.slice(0, 2).includes(effect) && effect.id !== state.lastGateEffect));
  const selected = [...arithmetic.slice(0, 2), remainder[0]].filter(Boolean);
  while (selected.length < 3) {
    const fallback = shuffle(GATE_EFFECTS.filter((effect) => !selected.includes(effect)))[0];
    if (!fallback) break;
    selected.push(fallback);
  }
  const distractorColors = shuffle(GATE_DISTRACTOR_COLORS).slice(0, 3);
  selected.forEach((effect, lane) => {
    const scaleByTeam = Math.max(0, state.levels.cannon - 1) * 0.8;
    const requiredHits = Math.round(effect.hits + state.gateRound * 0.55 + state.level * 0.35 + scaleByTeam + randomBetween(-1, 2));
    createChoiceGate(effect, lane, requiredHits, distractorColors[lane]);
  });
  for (let index = 0; index < 5 + Math.ceil(state.level / 3); index += 1) {
    const escort = spawnEnemy(null, { lane: index % 3, z: -10.8 + randomBetween(0, 5.6) });
    if (escort) {
      // 挡板已经强制玩家锁定一路，随车怪只承担视觉与清怪压力，不能再叠加一整波精英的致命撞线伤害。
      escort.isGateEscort = true;
      escort.hp *= 0.58;
      escort.maxHp = escort.hp;
      escort.baseDamage = Math.max(1, Math.round(escort.baseDamage * 0.55));
    }
  }
  state.gatePhase = 'active';
  state.gateChoiceUntil = state.elapsed + 13.5;
  state.gateRound += 1;
  state.telemetry.gatesOffered += 3;
  showToast(currentTheme().id === 'deadline'
    ? '评审开始：颜色是随机干扰项，只看公式和真实数值'
    : '三门选择开始：颜色是随机干扰项，只看公式和真实数值', 2500);
}

function finishGateWindow(delay = 1.25) {
  state.gatePhase = 'resume';
  state.gateResumeAt = state.elapsed + delay;
  state.nextGateAt = state.elapsed + 4.8 + randomBetween(0, 1.6);
}

function resolveChoiceGate(gate) {
  if (!gate?.active || state.gatePhase !== 'active') return;
  const copy = gate.effect.copy[currentTheme().id] || gate.effect.copy.zombie;
  const detail = gate.effect.apply();
  triggerTurretUpgradeEffect(gate.effect.id, copy[0]);
  state.lastGateEffect = gate.effect.id;
  state.telemetry.gatesChosen += 1;
  state.bonuses.count += 1;
  state.baseHp = Math.min(100, state.baseHp + 6);
  state.score += 1300 + state.gateRound * 260;
  let convoyCleared = 0;
  for (const enemy of enemies) {
    if (!enemy.active || !enemy.isGateEscort) continue;
    killEnemy(enemy);
    convoyCleared += 1;
  }
  const color = cssHex(gate.displayColor);
  addShockwave(gate.x, gate.z, color, 3.8);
  visualSystem.pulseBloom(0.4);
  if (convoyCleared) addFxText(gate.x, 2.2, gate.z + 0.8, `选择冲击波 ×${convoyCleared}`, color, 1.2, 16);
  for (let index = 0; index < 26; index += 1) addFxParticle(gate.x, 1.3, gate.z, color, 1.2);
  for (const other of [...choiceGates]) {
    if (other === gate) expireChoiceGate(other, 'CHOICE LOCKED');
    else expireChoiceGate(other, '另外两项已锁死');
  }
  showOverdriveBanner(`${gate.effect.icon} ${copy[0]}`);
  showToast(`${copy[0]}：${detail}`, 3100);
  sfx.gateBreak();
  sfx.upgrade();
  finishGateWindow();
  updateHud(true);
}

function updateChoiceGates(dt) {
  if (state.gatePhase === 'none') {
    if (state.elapsed >= state.nextGateAt && !state.bossSpawned) beginGatePrep();
    return;
  }
  if (state.gatePhase === 'prep') {
    if (state.elapsed >= state.gatePrepUntil) spawnChoiceGates();
    return;
  }
  if (state.gatePhase === 'active') {
    let convoyEscaped = false;
    for (const gate of choiceGates) {
      if (!gate.active) continue;
      gate.wobble += dt * 2.5;
      gate.z += gate.speed * dt;
      gate.group.position.z = gate.z;
      gate.group.position.y = 0.04 + Math.sin(gate.wobble) * 0.055;
      gate.floor.rotation.z += dt * 0.55;
      const pulse = state.elapsed < gate.hitUntil ? 1.08 : 1 + Math.sin(gate.wobble * 1.6) * 0.025;
      gate.group.scale.setScalar(pulse);
      if (gate.z >= WORLD.baseZ - 1.4) convoyEscaped = true;
    }
    if (convoyEscaped || state.elapsed >= state.gateChoiceUntil) {
      for (const gate of [...choiceGates]) expireChoiceGate(gate, '选择超时');
      showToast('算术车队已穿过防线：本轮没有获得构筑效果', 2200);
      finishGateWindow(0.35);
    }
    return;
  }
  if (state.gatePhase === 'resume' && state.elapsed >= state.gateResumeAt) state.gatePhase = 'none';
}

function updateBonusTargets(dt) {
  for (let index = bonusTargets.length - 1; index >= 0; index -= 1) {
    const target = bonusTargets[index];
    if (!target.active) {
      bonusTargets.splice(index, 1);
      continue;
    }
    target.z += target.speed * dt;
    target.wobble += dt * 3.5;
    target.group.position.set(target.x, 0.04 + Math.sin(target.wobble) * 0.05, target.z);
    const pulse = target.scale * (1 + Math.sin(target.wobble * 1.7) * 0.08);
    target.group.scale.setScalar(state.elapsed < target.hitUntil ? pulse * 1.12 : pulse);
    target.ring.rotation.z += dt * (target.rewardType === 'barrier' ? -1.8 : 2.6);
    target.ringMaterial.opacity = state.elapsed < target.hitUntil ? 1 : 0.72 + Math.sin(target.wobble) * 0.18;
    if (target.z >= WORLD.baseZ + 0.2) expireBonusTarget(target, true);
  }
}

function selectLane(lane) {
  const nextLane = clamp(Number(lane) || 0, 0, 2);
  const changed = nextLane !== state.focusLane;
  state.focusLane = nextLane;
  els.laneButtons.forEach((button) => button.classList.toggle('active', Number(button.dataset.lane) === state.focusLane));
  if (changed && state.mode === 'playing' && performance.now() - state.lastLaneSoundAt > 110) {
    state.lastLaneSoundAt = performance.now();
    state.shake = Math.max(state.shake, 0.09);
    state.flash = Math.max(state.flash, 0.08);
    state.flashColor = currentTheme().palette.accent;
    sfx.lane();
  }
}

function moveLane(direction) {
  selectLane(state.focusLane + direction);
}

function livingEnemies() {
  return enemies.filter((enemy) => enemy.active);
}

function updateSpawning(dt) {
  const theme = currentTheme();
  const level = currentLevel();
  if (state.bossAlive) return;
  const progress = clamp(state.elapsed / level.duration, 0, 1);
  const living = livingEnemies();
  const nearestZ = living.reduce((max, enemy) => Math.max(max, enemy.z), WORLD.spawnZ);
  let spawnRate = (1.35 + progress * 2.7) * theme.spawnMultiplier * level.spawn;
  if (state.gatePhase === 'prep') spawnRate *= 0.72;
  if (state.gatePhase === 'active') spawnRate *= 0.44;
  if (state.gatePhase === 'resume') spawnRate *= 0.8;
  if (state.elapsed < state.frenzyUntil) spawnRate *= 10;
  if (living.length < 18 && nearestZ < 4) spawnRate *= 1.3;
  if (living.length > 360) spawnRate *= 0.42;
  state.spawnAcc += spawnRate * dt;

  while (state.spawnAcc >= 1) {
    state.spawnAcc -= 1;
    const enemy = spawnEnemy();
    if (enemy && state.elapsed < state.frenzyUntil) {
      enemy.hp *= 0.76;
      enemy.maxHp = enemy.hp;
      enemy.score = Math.round(enemy.score * 1.2);
    }
  }

  if (!state.bossSpawned && state.elapsed >= level.bossAt && state.gatePhase === 'none') summonBoss(false);
}

function updateEnemies(dt) {
  const theme = currentTheme();
  for (const enemy of enemies) {
    if (!enemy.active) continue;
    const slowed = state.elapsed < enemy.slowUntil;
    enemy.impactPulse = Math.max(0, enemy.impactPulse - dt * 7.5);
    enemy.z += enemy.speed * (slowed ? 0.44 : 1) * dt;
    enemy.wobble += dt * (enemy.type === 'runner' ? 7 : 3.2);
    enemy.x += Math.sin(enemy.wobble) * dt * 0.08;

    if (enemy.z >= WORLD.baseZ) {
      enemy.active = false;
      state.baseHp = Math.max(0, state.baseHp - enemy.baseDamage);
      state.shake = Math.max(state.shake, enemy.type === 'boss' ? 1.8 : 0.28 + enemy.scale * 0.1);
      addFxText(enemy.x, 1.2, WORLD.baseZ, `${theme.baseLabel} -${enemy.baseDamage}%`, '#ff6b57', 1.15);
      addShockwave(enemy.x, WORLD.baseZ, '#ff5f57', enemy.type === 'boss' ? 3.4 : 1.2);
      for (let i = 0; i < 8; i += 1) addFxParticle(enemy.x, 0.7, WORLD.baseZ, '#ff6b57', 0.75);
      sfx.warning();
    }
  }

  if (state.baseHp < 30 && !state.bailoutUsed && state.mode === 'playing') {
    state.bailoutUsed = true;
    state.baseHp = Math.max(state.baseHp, 22);
    triggerOverdrive(true);
  }
  if (state.baseHp <= 0) endGame(false);
}

function findTargets(lane, count = 1) {
  const gates = choiceGates
    .filter((gate) => gate.active && gate.lane === lane)
    .sort((a, b) => b.z - a.z);
  if (gates.length) return [gates[0]];
  const rewards = bonusTargets
    .filter((target) => target.active && target.lane === lane)
    .sort((a, b) => b.z - a.z);
  if (rewards.length) return [rewards[0]];
  return enemies
    .filter((enemy) => enemy.active && enemy.lane === lane)
    .sort((a, b) => b.z - a.z)
    .slice(0, count);
}

function acquireProjectile() {
  return projectilePool.find((projectile) => !projectile.active) || null;
}

function chooseProjectileVariant() {
  const sequence = state.telemetry.shots + 1;
  if (state.levels.frost > 0 && sequence % Math.max(3, 8 - state.levels.frost) === 0) return 'frost';
  if (state.levels.chain > 0 && sequence % Math.max(3, 7 - state.levels.chain) === 0) return 'chain';
  if (state.levels.blast > 0 && sequence % Math.max(2, 5 - Math.min(3, state.levels.blast)) === 0) return 'blast';
  return 'normal';
}

function fireProjectile(turret, target, damage) {
  const projectile = acquireProjectile();
  if (!projectile || !target) return;
  projectile.active = true;
  projectile.mesh.visible = true;
  const muzzle = currentTheme().id === 'deadline' ? turret.deadlineMuzzle : turret.zombieMuzzle;
  muzzle.getWorldPosition(muzzleWorldPosition);
  projectile.x = muzzleWorldPosition.x + randomBetween(-0.05, 0.05);
  projectile.y = muzzleWorldPosition.y;
  projectile.z = muzzleWorldPosition.z;
  projectile.target = target;
  projectile.damage = damage;
  projectile.lane = state.focusLane;
  projectile.variant = chooseProjectileVariant();
  projectile.visualPower = clamp(Math.sqrt(Math.max(1, damage) / 22), 0.9, 3.2);
  projectile.mesh.position.set(projectile.x, projectile.y, projectile.z);
  projectile.energy.scale.setScalar(0.86 + projectile.visualPower * 0.16);
  projectile.aura.scale.setScalar(0.82 + projectile.visualPower * 0.22);
  projectile.trail.scale.set(0.85 + projectile.visualPower * 0.08, 0.85 + projectile.visualPower * 0.08, 1 + projectile.visualPower * 0.2);
  projectile.shellFins.visible = currentTheme().id === 'zombie' && (state.levels.blast > 0 || state.levels.multi > 0);
  projectile.blastBand.visible = currentTheme().id === 'zombie' && projectile.variant === 'blast';
  projectile.chainOrbit.visible = currentTheme().id === 'zombie' && projectile.variant === 'chain';
  projectile.frostSpikes.visible = currentTheme().id === 'zombie' && projectile.variant === 'frost';
  projectile.ticket.scale.setScalar(1.22 + Math.min(0.42, projectile.visualPower * 0.1));
  projectile.ticketPaper.material = ticketMaterials[projectile.variant] || ticketMaterials.normal;
  projectile.ticketStamp.scale.setScalar(1 + state.levels.crit * 0.12 + state.bonuses.crit * 0.7);
  projectile.ticketEchoes.forEach((echo, echoIndex) => {
    echo.visible = state.levels.multi > echoIndex || state.levels.chain > echoIndex;
  });
  projectile.ticket.rotation.z = randomBetween(-0.22, 0.22);
  turret.recoil = 1;
  turret.muzzleLife = 0.13;
  state.telemetry.shots += 1;
}

function currentCombatStats() {
  const overdrive = state.elapsed < state.overdriveUntil;
  return {
    overdrive,
    fireInterval: 0.24
      / (1 + (state.levels.rate - 1) * 0.22)
      / state.bonuses.rate
      / (overdrive ? 2.4 : 1),
    damage: 22
      * Math.pow(1.5, state.levels.damage - 1)
      * state.bonuses.damage
      * (overdrive ? 2.45 : 1),
  };
}

function triggerHitStop(milliseconds) {
  if (state.speed > 2.5) return;
  const now = performance.now();
  if (milliseconds < 80 && now - state.lastHitStopAt < 220) return;
  state.lastHitStopAt = now;
  state.hitStopUntil = Math.max(state.hitStopUntil, now + milliseconds);
  state.telemetry.hitStops += 1;
}

function triggerCombatFlash(amount, color) {
  state.flash = Math.max(state.flash, amount);
  state.flashColor = color || currentTheme().palette.accent;
}

function formationSlot(index, count) {
  const row = count > 4 ? Math.floor(index / 4) : 0;
  const rowStart = row * 4;
  const rowCount = Math.min(count > 4 ? 4 : count, count - rowStart);
  const column = index - rowStart;
  const spacing = rowCount >= 4 ? 1.12 : rowCount === 3 ? 1.32 : rowCount === 2 ? 1.18 : 0;
  return {
    x: (column - (rowCount - 1) / 2) * spacing,
    z: row * 0.88,
    scale: count > 4 ? 0.8 : count > 2 ? 0.91 : count > 1 ? 1.02 : 1.24,
  };
}

function updateTurretUpgradeVisuals(turret, dt) {
  const theme = currentTheme();
  const overdrive = state.elapsed < state.overdriveUntil;
  const upgradePulse = state.elapsed < state.turretUpgradeUntil ? 1 : 0;
  const damageTier = clamp(Math.max(state.levels.damage - 1, Math.floor(Math.log(Math.max(1, state.bonuses.damage)) / Math.log(1.55))), 0, 4);
  const rateTier = clamp(Math.max(state.levels.rate - 1, Math.floor(Math.log(Math.max(1, state.bonuses.rate)) / Math.log(1.42))), 0, 4);
  const evolutionScore = damageTier + rateTier
    + Math.min(3, state.levels.multi)
    + Math.min(3, state.levels.blast)
    + Math.min(2, state.levels.chain)
    + Math.min(2, state.levels.frost)
    + Math.min(2, state.levels.crit);
  const evolutionStage = evolutionScore >= 10 ? 3 : evolutionScore >= 6 ? 2 : evolutionScore >= 2 ? 1 : 0;
  turret.evolutionStage = evolutionStage;
  const time = state.elapsed + turret.phase;

  turret.cannonEvolutionStages.forEach((stage, stageIndex) => {
    stage.visible = stageIndex < evolutionStage;
    if (stage.visible) stage.rotation.y += dt * (stageIndex === 2 ? 0.72 : 0.12) * (stageIndex % 2 ? -1 : 1);
  });
  turret.workbenchEvolutionStages.forEach((stage, stageIndex) => {
    stage.visible = stageIndex < evolutionStage;
    if (stage.visible) stage.rotation.y += dt * (stageIndex === 2 ? 0.9 : 0.08) * (stageIndex % 2 ? -1 : 1);
  });
  const haloPulse = 1 + Math.sin(time * (overdrive ? 10 : 4.5)) * 0.09 + evolutionStage * 0.08 + upgradePulse * 0.22;
  turret.heroHalo.scale.setScalar(haloPulse);
  turret.heroHalo.rotation.z += dt * (1.1 + rateTier * 0.35) * (turret.phase % 1 > 0.5 ? -1 : 1);
  turret.heroHaloMaterial.opacity = 0.15 + evolutionStage * 0.055 + (overdrive ? 0.18 : 0) + upgradePulse * 0.17;

  turret.sideBarrels.forEach((mesh, barrelIndex) => {
    mesh.visible = state.levels.multi > barrelIndex || damageTier >= barrelIndex + 2;
    mesh.scale.z = 1 + damageTier * 0.08;
  });
  turret.blastPods.forEach((mesh, podIndex) => {
    mesh.visible = state.levels.blast > podIndex || state.levels.blast >= 3;
    mesh.rotation.y += dt * (1.2 + state.levels.blast * 0.35);
  });
  turret.chainCoils.forEach((mesh, coilIndex) => {
    mesh.visible = state.levels.chain > coilIndex || state.levels.chain >= 3;
    mesh.rotation.z += dt * (2.4 + state.levels.chain * 0.7) * (coilIndex ? -1 : 1);
    mesh.material.opacity = 0.56 + Math.sin(time * 7 + coilIndex) * 0.22;
  });
  turret.frostFins.forEach((mesh, finIndex) => {
    mesh.visible = state.levels.frost > finIndex || state.levels.frost >= 3;
    mesh.position.y = 0.54 + Math.sin(time * 3.4 + finIndex) * 0.04;
  });
  turret.critSight.visible = state.levels.crit > 0 || state.bonuses.crit >= 0.05;
  turret.critSight.rotation.z += dt * (1.4 + state.levels.crit * 0.5);
  turret.critSight.scale.setScalar(1 + Math.sin(time * 5) * 0.08);
  turret.rateRings.forEach((ring, ringIndex) => {
    ring.rotation.z += dt * (1.8 + rateTier * 1.1) * (ringIndex ? -1 : 1);
    ring.material.opacity = 0.3 + rateTier * 0.1 + (overdrive ? 0.28 : 0) + Math.sin(time * 5 + ringIndex) * 0.08;
  });
  turret.ammoDrums.forEach((drum, drumIndex) => {
    drum.rotation.x += dt * (2.4 + rateTier * 1.6) * (drumIndex ? -1 : 1);
  });
  const coreScale = 1 + damageTier * 0.055 + Math.sin(time * (overdrive ? 13 : 5)) * (overdrive ? 0.16 : 0.06) + upgradePulse * 0.18;
  turret.energyCore.scale.setScalar(coreScale);
  turret.coreMaterial.emissiveIntensity = 0.9 + damageTier * 0.25 + (overdrive ? 1.8 : 0) + upgradePulse * 1.1;
  turret.housingMaterial.emissiveIntensity = 0.34 + damageTier * 0.1 + (overdrive ? 0.75 : 0) + upgradePulse * 0.5;
  turret.barrelMaterial.emissiveIntensity = 0.14 + rateTier * 0.08 + (overdrive ? 0.58 : 0);

  turret.sideScreens.forEach((screen, screenIndex) => {
    screen.visible = state.levels.multi > screenIndex || damageTier >= screenIndex + 2;
    screen.rotation.z = Math.sin(time * 2.8 + screenIndex) * 0.025;
  });
  turret.coffeeTank.visible = rateTier > 0 || overdrive;
  turret.coffeeTank.scale.y = 1 + rateTier * 0.12 + (overdrive ? 0.24 : 0);
  turret.networkAntenna.visible = state.levels.chain > 0;
  turret.networkAntenna.rotation.y += dt * (1.1 + state.levels.chain * 0.45);
  turret.frostFan.visible = state.levels.frost > 0;
  turret.frostFan.rotation.z += dt * (4 + state.levels.frost * 2.2);
  turret.approvalLamp.visible = state.levels.crit > 0 || state.bonuses.crit >= 0.05;
  turret.approvalLamp.rotation.y += dt * 2.6;
  turret.approvalLamp.scale.setScalar(1 + Math.sin(time * 7) * 0.12);
  turret.screenMaterial.emissiveIntensity = 0.72 + damageTier * 0.14 + (overdrive ? 1.15 : 0) + upgradePulse * 0.55;
  turret.sirenMaterial.emissiveIntensity = 0.78 + (overdrive ? 2.1 : 0) + upgradePulse * 1.1;
  turret.sirenMaterial.opacity = 0.68 + Math.sin(time * (overdrive ? 16 : 5)) * 0.22;
  turret.siren.scale.setScalar(1 + Math.sin(time * 9) * (overdrive ? 0.22 : 0.08));

  turret.muzzleLife = Math.max(0, turret.muzzleLife - dt);
  const muzzleProgress = clamp(turret.muzzleLife / 0.13, 0, 1);
  turret.zombieMuzzle.visible = theme.id === 'zombie' && muzzleProgress > 0;
  turret.deadlineMuzzle.visible = theme.id === 'deadline' && muzzleProgress > 0;
  const muzzleScale = 0.42 + muzzleProgress * (1.15 + damageTier * 0.12);
  turret.zombieMuzzle.scale.setScalar(muzzleScale);
  turret.zombieMuzzle.rotation.z += dt * 16;
  turret.deadlineMuzzle.scale.setScalar(0.62 + muzzleProgress * (0.72 + rateTier * 0.08));
  turret.deadlineMuzzle.rotation.z = Math.sin(time * 23) * 0.1;
  turret.upgradePulse = Math.max(0, turret.upgradePulse - dt * 1.8);
  const modelScale = 1 + turret.upgradePulse * 0.16;
  turret.cannonModel.scale.setScalar((1.08 + evolutionStage * 0.035) * modelScale);
  turret.workbenchModel.scale.setScalar((1.5 + evolutionStage * 0.04) * modelScale);
}

function triggerTurretUpgradeEffect(effectId, label) {
  state.turretUpgradeUntil = Math.max(state.turretUpgradeUntil, state.elapsed + 1.45);
  state.lastTurretUpgrade = effectId;
  const theme = currentTheme();
  const color = effectId.includes('frost') ? '#69d8ff'
    : effectId.includes('chain') ? '#b37cff'
      : effectId.includes('blast') ? '#ff9f43'
        : effectId.includes('crit') ? '#ffd84f'
          : theme.palette.accent;
  const cannonCount = Math.min(MAX_CANNONS, state.levels.cannon);
  turretGroups.slice(0, cannonCount).forEach((turret, turretIndex) => {
    turret.upgradePulse = 1;
    const slot = formationSlot(turretIndex, cannonCount);
    const x = WORLD.lanes[state.focusLane] + slot.x;
    const z = 10.2 + slot.z;
    addShockwave(x, z, color, 2.1);
    visualSystem.spawnUpgrade({ x, z, color });
    for (let particleIndex = 0; particleIndex < 12; particleIndex += 1) {
      addFxParticle(x, 0.7, z, color, 0.8, particleIndex % 3 === 0 ? 'shard' : 'particle');
    }
  });
  addFxText(WORLD.lanes[state.focusLane], 4.35, 8.65, theme.id === 'deadline' ? `热修部署 · ${label}` : `炮台进化 · ${label}`, color, 1.15, 16);
  visualSystem.pulseBloom(0.32);
}

function updateTurrets(dt) {
  const cannonCount = Math.min(MAX_CANNONS, state.levels.cannon);
  const laneX = WORLD.lanes[state.focusLane];
  focusLaneGlow.position.x = lerp(focusLaneGlow.position.x, laneX, Math.min(1, dt * 10));
  focusRail.position.x = lerp(focusRail.position.x, laneX, Math.min(1, dt * 12));
  const combat = currentCombatStats();
  const baseInterval = combat.fireInterval;
  const baseDamage = combat.damage;
  const targetsPerCannon = 1 + Math.min(3, state.levels.multi);
  const targetCount = cannonCount * targetsPerCannon;
  const targets = findTargets(state.focusLane, targetCount);

  turretGroups.forEach((turret, index) => {
    const active = index < cannonCount;
    turret.group.visible = active;
    if (!active) {
      turret.recoil = 0;
      turret.pivot.position.z = 0;
      turret.keyboard.rotation.x = 0;
      turret.zombieMuzzle.visible = false;
      turret.deadlineMuzzle.visible = false;
      return;
    }
    updateTurretUpgradeVisuals(turret, dt);
    const slot = formationSlot(index, cannonCount);
    const targetX = laneX + slot.x;
    const targetZ = 10.2 + slot.z;
    const previousX = turret.group.position.x;
    turret.group.position.x = lerp(turret.group.position.x, targetX, Math.min(1, dt * 11));
    turret.group.position.z = lerp(turret.group.position.z, targetZ, Math.min(1, dt * 11));
    const movement = turret.group.position.x - previousX;
    turret.movementLean = lerp(turret.movementLean, clamp(-movement * 4.8, -0.18, 0.18), Math.min(1, dt * 15));
    turret.cannonModel.rotation.z = turret.movementLean;
    turret.workbenchModel.rotation.z = turret.movementLean * 1.35;
    if (Math.abs(movement) > 0.018 && state.random() < dt * 20) {
      addFxParticle(turret.group.position.x, 0.2, turret.group.position.z + 0.45, currentTheme().id === 'deadline' ? '#62a8ff' : '#4fffd2', 0.42, currentTheme().id === 'deadline' ? 'ticket' : 'particle');
    }
    const turretTargets = targets.length <= 1
      ? targets
      : Array.from({ length: targetsPerCannon }, (_, targetIndex) => targets[(index + targetIndex * cannonCount) % targets.length])
        .filter((target, targetIndex, list) => list.indexOf(target) === targetIndex);
    if (turretTargets[0]) {
      const dx = turretTargets[0].x - turret.group.position.x;
      const dz = turretTargets[0].z - turret.group.position.z;
      turret.targetRotation = -Math.atan2(dx, -dz);
    }
    turret.pivot.rotation.y = lerp(turret.pivot.rotation.y, turret.targetRotation, Math.min(1, dt * 9));
    turret.screenPivot.rotation.y = lerp(turret.screenPivot.rotation.y, turret.targetRotation * 0.28, Math.min(1, dt * 7));
    turret.recoil = Math.max(0, turret.recoil - dt * 11);
    turret.pivot.position.z = turret.recoil * 0.16;
    turret.keyboard.rotation.x = -turret.recoil * 0.72;
    turret.keyboard.position.y = 1.04 - turret.recoil * 0.07;
    const typingSpeed = 7 + Math.max(0, state.levels.rate - 1) * 2.2 + (state.elapsed < state.overdriveUntil ? 8 : 0);
    turret.leftArm.rotation.x = Math.sin(state.elapsed * typingSpeed + turret.phase) * 0.42 - turret.recoil * 0.34;
    turret.rightArm.rotation.x = Math.sin(state.elapsed * typingSpeed + turret.phase + Math.PI) * 0.42 - turret.recoil * 0.34;
    turret.coffee.rotation.z = Math.sin(state.elapsed * 7 + turret.phase) * 0.06 + turret.recoil * 0.22;
    turret.workbenchModel.position.y = 0.38 + Math.abs(Math.sin(state.elapsed * 5.8 + turret.phase)) * 0.055;
    const badgePulse = 1 + Math.sin(state.elapsed * 4.2 + turret.phase) * 0.045 + turret.recoil * 0.08;
    turret.badge.scale.set(1.42 * badgePulse, 0.5 * badgePulse, 1);
    const scale = slot.scale + (state.focusLane === 1 ? 0.02 : 0);
    turret.group.scale.lerp(new THREE.Vector3(scale, scale, scale), Math.min(1, dt * 8));
    state.fireAcc[index] += dt;
    const aligned = Math.abs(turret.group.position.x - targetX) < 0.28;
    let safety = 0;
    while (aligned && state.fireAcc[index] >= baseInterval && turretTargets.length && safety < 7) {
      state.fireAcc[index] -= baseInterval;
      turretTargets.forEach((target, targetIndex) => fireProjectile(turret, target, baseDamage * (targetIndex ? 0.78 : 1)));
      safety += 1;
      if (performance.now() - state.lastShotSoundAt > 48) {
        state.lastShotSoundAt = performance.now();
        sfx.shoot(clamp(Math.sqrt(baseDamage / 22), 0.8, 3));
      }
    }
  });
}

function retireProjectile(projectile) {
  projectile.active = false;
  projectile.target = null;
  projectile.mesh.visible = false;
}

function updateProjectiles(dt) {
  for (const projectile of projectilePool) {
    if (!projectile.active) continue;
    const target = projectile.target;
    if (!target?.active) {
      retireProjectile(projectile);
      continue;
    }
    const targetY = target.kind === 'gate' ? 1.35 : target.kind === 'bonus' ? 1.05 * target.scale : 0.68 * target.scale;
    const dx = target.x - projectile.x;
    const dy = targetY - projectile.y;
    const dz = target.z - projectile.z;
    const distance = Math.hypot(dx, dy, dz);
    const step = 25 * dt;
    if (distance <= step + target.scale * 0.25) {
      projectile.x = target.x;
      projectile.y = targetY;
      projectile.z = target.z;
      addProjectileImpact(projectile, target);
      applyDamage(target, projectile.damage, { primary: true, variant: projectile.variant });
      retireProjectile(projectile);
      continue;
    }
    projectile.x += (dx / distance) * step;
    projectile.y += (dy / distance) * step;
    projectile.z += (dz / distance) * step;
    projectile.mesh.position.set(projectile.x, projectile.y, projectile.z);
    projectile.mesh.lookAt(target.x, targetY, target.z);
    projectile.spin += dt * 8;
    projectile.energy.rotation.x += dt * 9;
    projectile.energy.rotation.z += dt * 12;
    projectile.aura.scale.setScalar((0.82 + projectile.visualPower * 0.22) * (1 + Math.sin(projectile.spin * 1.8) * 0.12));
    projectile.shellFins.rotation.z += dt * 11;
    projectile.blastBand.rotation.z += dt * 14;
    projectile.chainOrbit.rotation.x += dt * 17;
    projectile.chainOrbit.rotation.z -= dt * 10;
    projectile.frostSpikes.rotation.z += dt * 8;
    if (state.themeId === 'deadline') {
      projectile.ticket.rotation.z = Math.sin(projectile.spin) * 0.34;
      projectile.ticket.rotation.y += dt * 7.5;
      projectile.ticketStamp.rotation.z -= dt * 9;
      projectile.ticketEchoes.forEach((echo, echoIndex) => {
        echo.position.x = Math.sin(projectile.spin * 1.4 + echoIndex) * 0.08;
        echo.position.y = Math.cos(projectile.spin * 1.2 + echoIndex) * 0.06;
      });
    }
  }
}

function applyDamage(enemy, amount, options = {}) {
  if (!enemy?.active) return;
  if (enemy.kind === 'gate') {
    if (!options.primary) return;
    enemy.hitsRemaining = Math.max(0, enemy.hitsRemaining - 1);
    enemy.hitUntil = state.elapsed + 0.12;
    // 选择门混在敌群里时，专注打门不应等于完全放弃防守；主弹会穿透门，对同路最近护送怪造成部分伤害。
    const piercedTargets = enemies
      .filter((target) => target.active && target.type !== 'boss' && target.lane === enemy.lane)
      .sort((a, b) => Math.abs(a.z - enemy.z) - Math.abs(b.z - enemy.z))
      .slice(0, 1 + Math.min(2, state.levels.multi));
    piercedTargets.forEach((target) => applyDamage(target, amount * 0.52, { gatePierce: true }));
    enemy.board.redraw(enemy.hitsRemaining);
    enemy.board.texture.needsUpdate = true;
    addFxText(
      enemy.x,
      1.55,
      enemy.z,
      enemy.hitsRemaining > 0
        ? `还差 ${enemy.hitsRemaining} ${currentTheme().id === 'deadline' ? '份' : '发'}`
        : '方案击穿！',
      cssHex(enemy.displayColor),
      0.62,
      enemy.hitsRemaining > 0 ? 12 : 17,
    );
    state.shake = Math.max(state.shake, enemy.hitsRemaining > 0 ? 0.055 : 0.34);
    if (performance.now() - state.lastImpactSoundAt > 72) {
      state.lastImpactSoundAt = performance.now();
      sfx.impact({ gate: true, heavy: enemy.hitsRemaining <= 0 || enemy.hitsRemaining <= Math.ceil(enemy.requiredHits * 0.2) });
    }
    if (enemy.hitsRemaining <= 0) resolveChoiceGate(enemy);
    return;
  }
  if (enemy.kind === 'bonus') {
    let bonusDamage = amount;
    const bonusCriticalChance = 0.06 + state.levels.crit * 0.085 + state.bonuses.crit;
    const bonusCritical = options.primary && state.random() < bonusCriticalChance;
    if (bonusCritical) bonusDamage *= 1.8 + state.levels.crit * 0.18;
    enemy.hp -= bonusDamage;
    enemy.hitUntil = Math.max(enemy.hitUntil, state.elapsed + (bonusCritical ? 0.16 : 0.09));
    const ratio = clamp(enemy.hp / enemy.maxHp, 0, 1);
    addFxText(
      enemy.x,
      1.35 * enemy.scale,
      enemy.z,
      enemy.hp > 0 ? `${bonusCritical ? '暴击 ' : ''}${Math.ceil(ratio * 100)}%` : 'BREAK!',
      bonusCritical ? '#ffd84f' : cssHex(BONUS_CONFIG[enemy.rewardType].color),
      0.75,
      bonusCritical ? 16 : 12,
    );
    state.shake = Math.max(state.shake, bonusCritical ? 0.18 : 0.06);
    if (enemy.hp <= 0) {
      grantBonus(enemy);
      expireBonusTarget(enemy);
    }
    return;
  }
  let damage = amount;
  let critical = false;
  const variant = options.variant || 'normal';
  if (options.primary) {
    const criticalChance = 0.06 + state.levels.crit * 0.085 + state.bonuses.crit;
    if (state.random() < criticalChance) {
      critical = true;
      damage *= 1.8 + state.levels.crit * 0.18;
      addExplosionBurst(enemy.x, 0.9 * enemy.scale, enemy.z, '#ffd84f', 0.72 + state.levels.crit * 0.08, currentTheme().id === 'deadline' ? 'digital' : 'energy', { critical: true, heavy: true });
      for (let index = 0; index < 6; index += 1) addFxParticle(enemy.x, 0.9 * enemy.scale, enemy.z, '#fff1a3', 0.7, 'shard');
    }
  }

  enemy.hp -= damage;
  enemy.impactPulse = Math.max(enemy.impactPulse || 0, critical ? 1 : variant === 'blast' ? 0.9 : 0.62);
  enemy.impactSide = state.random() < 0.5 ? -1 : 1;
  enemy.hitUntil = Math.max(enemy.hitUntil, state.elapsed + (critical ? 0.15 : 0.085));
  addFxText(enemy.x, 0.8 * enemy.scale, enemy.z, `${critical ? '暴击 ' : ''}${Math.round(damage)}`, critical ? '#ffd84f' : '#e9fff9', critical ? 1.2 : 0.78, critical ? 17 : 12);
  for (let i = 0; i < (critical ? 5 : 2); i += 1) addFxParticle(enemy.x, 0.7, enemy.z, critical ? '#ffd84f' : '#4fffd2', critical ? 0.85 : 0.5);
  state.shake = Math.max(state.shake, critical ? 0.16 : 0.04);
  if (options.primary) {
    state.telemetry.impacts += 1;
    if (critical) state.telemetry.criticalHits += 1;
    if (variant !== 'normal') state.telemetry.specialImpacts += 1;
    const heavyImpact = critical || variant === 'blast' || enemy.type === 'boss' || damage >= enemy.maxHp * 0.22;
    if (critical) {
      triggerHitStop(enemy.type === 'boss' ? 52 : 34);
      triggerCombatFlash(0.2, '#ffd84f');
    } else if (variant === 'blast') {
      triggerCombatFlash(0.1, currentTheme().id === 'deadline' ? '#ff526a' : '#ff9f43');
    }
    if (performance.now() - state.lastImpactSoundAt > (heavyImpact ? 58 : 105)) {
      state.lastImpactSoundAt = performance.now();
      sfx.impact({ critical, heavy: heavyImpact, variant });
    }
    if (variant !== 'normal' && state.random() < 0.28) {
      const variantCopy = currentTheme().id === 'deadline'
        ? { blast: 'P0 批量关闭', chain: '@所有人 · 调用链', frost: '需求已冻结' }
        : { blast: '重炮尸爆', chain: '电弧贯穿', frost: '冰晶弹头' };
      addFxText(enemy.x, 1.18 * enemy.scale, enemy.z, variantCopy[variant] || '', variant === 'blast' ? '#ff9f43' : variant === 'chain' ? '#c8a7ff' : '#9beaff', 0.62, 11);
    }
  }

  if (options.primary && state.levels.frost > 0 && (variant === 'frost' || state.random() < 0.1 + state.levels.frost * 0.08)) {
    enemy.slowUntil = Math.max(enemy.slowUntil, state.elapsed + 2.2 + state.levels.frost * 0.2);
    addShockwave(enemy.x, enemy.z, '#69d8ff', 0.8 + state.levels.frost * 0.24);
    for (let index = 0; index < 4 + state.levels.frost; index += 1) addFxParticle(enemy.x, 0.8 * enemy.scale, enemy.z, '#bfefff', 0.62, 'shard');
  }

  if (options.primary && state.levels.blast > 0) {
    const radius = 0.65 + state.levels.blast * 0.58 + (variant === 'blast' ? 0.45 : 0);
    for (const other of enemies) {
      if (!other.active || other === enemy) continue;
      const distance = Math.hypot(other.x - enemy.x, other.z - enemy.z);
      if (distance <= radius) applyDamage(other, damage * (variant === 'blast' ? 0.46 : 0.34), { splash: true });
    }
  }

  if (options.primary && state.levels.chain > 0 && (variant === 'chain' || state.random() < 0.16 + state.levels.chain * 0.1)) {
    const candidates = enemies
      .filter((other) => other.active && other !== enemy && other.lane === enemy.lane && Math.hypot(other.x - enemy.x, other.z - enemy.z) < 5.4)
      .sort((a, b) => Math.hypot(a.x - enemy.x, a.z - enemy.z) - Math.hypot(b.x - enemy.x, b.z - enemy.z))
      .slice(0, state.levels.chain + 1);
    let source = enemy;
    for (const target of candidates) {
      lightningItems.push({
        ax: source.x, ay: 0.8 * source.scale, az: source.z,
        bx: target.x, by: 0.8 * target.scale, bz: target.z,
        life: 0.14, maxLife: 0.14,
      });
      addFxParticle(target.x, 0.82 * target.scale, target.z, '#d9c2ff', 0.52, 'shard');
      applyDamage(target, damage * 0.42, { chain: true });
      source = target;
    }
  }

  if (enemy.hp <= 0) killEnemy(enemy, critical);
}

function killEnemy(enemy, critical = false) {
  const theme = currentTheme();
  if (!enemy.active) return;
  enemy.active = false;
  state.kills += 1;
  state.combo = state.elapsed <= state.comboUntil ? Math.min(999, state.combo + 1) : 1;
  state.comboUntil = state.elapsed + 1.35;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  const comboBonus = 1 + Math.min(2.5, state.combo / 80);
  state.score += Math.round(enemy.score * comboBonus * (critical ? 1.18 : 1));
  state.shake = Math.max(state.shake, enemy.type === 'boss' ? 1.45 : 0.08 * enemy.scale);
  addDefeatEffect(enemy, critical);
  const elite = ['elite', 'tank'].includes(enemy.type);
  if (enemy.type === 'boss') {
    triggerHitStop(110);
    triggerCombatFlash(0.52, '#ffffff');
  } else if (elite || critical) {
    triggerHitStop(elite ? 48 : 34);
    triggerCombatFlash(elite ? 0.18 : 0.13, critical ? '#ffd84f' : currentTheme().palette.accent);
  }

  if (enemy.type === 'boss') {
    state.bossAlive = false;
    state.bossDefeated = true;
    state.finishAt = state.elapsed + 1.8;
    els.bossHud.classList.add('hidden');
    showOverdriveBanner(theme.victoryBanner);
    showToast(theme.victoryToast, 2600);
    visualSystem.pulseBloom(0.9);
    sfx.victory();
  } else if (performance.now() - state.lastKillSoundAt > (elite ? 82 : 128)) {
    state.lastKillSoundAt = performance.now();
    sfx.kill({ elite, critical, combo: state.combo });
  }
}

function addExplosionBurst(x, y, z, color, power = 1, style = 'energy', options = {}) {
  visualSystem.spawnImpact({ x, y, z, color, power, style, critical: options.critical, heavy: options.heavy });
  addShockwave(x, z, color, 0.9 + power * 0.9, options);
  if (power >= 1.15) addShockwave(x, z, '#ffffff', 0.45 + power * 0.45, { ...options, critical: true });
  const count = Math.min(28, 6 + Math.round(power * 8));
  for (let index = 0; index < count; index += 1) {
    const shape = style === 'digital'
      ? (index % 2 ? 'ticket' : 'shard')
      : index % 3 === 0 ? 'shard' : 'particle';
    addFxParticle(x, y, z, index % 4 === 0 ? '#ffffff' : color, 0.55 + power * 0.36, shape);
  }
}

function addProjectileImpact(projectile, target) {
  const theme = currentTheme();
  const style = theme.id === 'deadline' ? 'digital' : 'energy';
  const variantColor = projectile.variant === 'blast' ? '#ff9f43'
    : projectile.variant === 'chain' ? '#b37cff'
      : projectile.variant === 'frost' ? '#8de9ff'
        : null;
  const baseColor = variantColor || (theme.id === 'deadline' ? '#62a8ff' : theme.palette.accent);
  const power = clamp(0.36 + projectile.visualPower * 0.16, 0.45, 0.92);
  if (projectile.variant === 'blast') {
    addExplosionBurst(target.x, target.kind === 'gate' ? 1.35 : 0.72 * target.scale, target.z, theme.id === 'deadline' ? '#ff526a' : '#ff9f43', 0.92 + state.levels.blast * 0.18, style, { variant: projectile.variant, heavy: true });
  } else {
    addShockwave(target.x, target.z, baseColor, 0.42 + power * 0.34, { variant: projectile.variant, heavy: projectile.variant !== 'normal' });
    for (let index = 0; index < 3; index += 1) {
      addFxParticle(target.x, target.kind === 'gate' ? 1.35 : 0.72 * target.scale, target.z, index ? baseColor : '#ffffff', 0.42 + power * 0.2, theme.id === 'deadline' ? 'ticket' : 'shard');
    }
    if (projectile.visualPower >= 2.2 || (state.levels.blast > 0 && projectile.spin % 3 < 0.6)) addExplosionBurst(target.x, target.kind === 'gate' ? 1.35 : 0.72 * (target.scale || 1), target.z, baseColor, power * 0.64, style, { variant: projectile.variant, heavy: projectile.variant !== 'normal' });
  }
  if (projectile.variant === 'chain') {
    addShockwave(target.x, target.z, '#b37cff', 1.05 + state.levels.chain * 0.12, { variant: projectile.variant, heavy: true });
  }
  if (projectile.variant === 'frost' || state.levels.frost > 0) {
    for (let index = 0; index < 3 + state.levels.frost; index += 1) addFxParticle(target.x, 0.9, target.z, '#9beaff', 0.7, 'shard');
  }
}

function addDefeatEffect(enemy, critical = false) {
  const theme = currentTheme();
  const isBoss = enemy.type === 'boss';
  const isElite = ['elite', 'tank'].includes(enemy.type);
  const color = isBoss ? cssHex(theme.palette.enemies.boss) : theme.id === 'deadline' ? '#45f0d0' : theme.palette.secondary;
  visualSystem.spawnDefeat({
    x: enemy.x,
    y: 0.72 * enemy.scale,
    z: enemy.z,
    color,
    power: isBoss ? 2.8 : isElite ? 1.35 : 0.86,
    style: theme.id === 'deadline' ? 'digital' : 'energy',
    boss: isBoss,
    elite: isElite,
    critical,
    heavy: isBoss || isElite || critical,
  });
  const style = theme.id === 'deadline' ? 'digital' : 'energy';
  const power = isBoss ? 3.2 : isElite ? 1.35 + enemy.scale * 0.18 : 0.72 + enemy.scale * 0.15;
  addExplosionBurst(enemy.x, Math.max(0.65, enemy.scale * 0.68), enemy.z, color, power, style);

  if (theme.id === 'deadline') {
    const label = isBoss ? 'FINAL REJECTED' : isElite ? 'P0 RESOLVED' : 'BUG CLOSED';
    if (isBoss || isElite || critical || state.random() < 0.18) {
      addFxText(enemy.x, Math.max(1.15, enemy.scale * 1.25), enemy.z, critical ? `✓ ${label} · 一次通过` : `✓ ${label}`, critical ? '#ffd84f' : '#8fff65', isBoss ? 1.8 : 0.85, isBoss ? 24 : 12);
    }
    for (let index = 0; index < (isBoss ? 34 : 7); index += 1) {
      const powerScale = isBoss ? 1.4 : 0.65;
      addFxParticle(
        enemy.x,
        0.8 * enemy.scale,
        enemy.z,
        index % 3 ? '#f5fbff' : '#ff526a',
        powerScale,
        'ticket',
        { vx: randomBetween(-2.8, 2.8) * powerScale, vy: randomBetween(2.2, 5.4) * powerScale, vz: randomBetween(-3.4, 0.7) * powerScale },
      );
    }
  } else {
    const chunkColor = isBoss ? '#ff526a' : critical ? '#ffd84f' : '#8fff65';
    for (let index = 0; index < (isBoss ? 38 : 6 + Math.round(enemy.scale * 3)); index += 1) {
      const powerScale = isBoss ? 1.45 : 0.62 + enemy.scale * 0.12;
      addFxParticle(
        enemy.x,
        0.75 * enemy.scale,
        enemy.z,
        index % 4 === 0 ? '#ff6b57' : chunkColor,
        powerScale,
        'shard',
        { vx: randomBetween(-3.1, 3.1) * powerScale, vy: randomBetween(1.5, 4.8) * powerScale, vz: randomBetween(-4.6, 0.4) * powerScale },
      );
    }
    if (isElite || critical) addFxText(enemy.x, 1.2 * enemy.scale, enemy.z, isBoss ? '尸王核心崩解' : critical ? '核心粉碎' : '精英击破', chunkColor, isBoss ? 1.7 : 0.72, isBoss ? 24 : 12);
  }

  if (isBoss) {
    for (let burstIndex = 0; burstIndex < 6; burstIndex += 1) {
      const angle = burstIndex / 6 * Math.PI * 2;
      addExplosionBurst(
        enemy.x + Math.cos(angle) * enemy.scale * 0.72,
        0.8 + (burstIndex % 3) * enemy.scale * 0.42,
        enemy.z + Math.sin(angle) * enemy.scale * 0.46,
        burstIndex % 2 ? color : '#ffd84f',
        1.5 + burstIndex * 0.12,
        style,
      );
    }
  }
}

function addShockwave(x, z, color, maxScale = 1, options = {}) {
  visualSystem.spawnShockwave({ x, z, color, maxScale, ...options });
}

function addFxText(x, y, z, text, color = '#ffffff', life = 0.8, size = 12) {
  if (fxItems.length > 170) fxItems.splice(0, 20);
  fxItems.push({ kind: 'text', x, y, z, text, color, life, maxLife: life, size, vy: 1.25 });
}

function addFxParticle(x, y, z, color, power = 1, kind = 'particle', motion = null) {
  if (fxItems.length > 190) return;
  fxItems.push({
    kind, x, y, z, color,
    vx: motion?.vx ?? randomBetween(-2.4, 2.4) * power,
    vy: motion?.vy ?? randomBetween(1.2, 4.2) * power,
    vz: motion?.vz ?? randomBetween(-2.1, 2.1) * power,
    life: randomBetween(0.32, 0.72),
    maxLife: 0.72,
    size: randomBetween(2, 5) * power,
    angle: randomBetween(0, Math.PI * 2),
    spin: randomBetween(-8, 8),
  });
}

function updateFx(dt) {
  for (let index = fxItems.length - 1; index >= 0; index -= 1) {
    const item = fxItems[index];
    item.life -= dt;
    if (item.kind === 'text') {
      item.y += item.vy * dt;
      item.vy *= Math.pow(0.3, dt);
    } else {
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      item.z += item.vz * dt;
      item.vy -= 7.2 * dt;
      item.vx *= Math.pow(0.18, dt);
      item.vz *= Math.pow(0.18, dt);
      item.angle += item.spin * dt;
    }
    if (item.life <= 0) fxItems.splice(index, 1);
  }
  for (let index = lightningItems.length - 1; index >= 0; index -= 1) {
    lightningItems[index].life -= dt;
    if (lightningItems[index].life <= 0) lightningItems.splice(index, 1);
  }
}

function projectToScreen(x, y, z) {
  const vector = new THREE.Vector3(x, y, z).project(camera);
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;
  return {
    x: (vector.x * 0.5 + 0.5) * width,
    y: (-vector.y * 0.5 + 0.5) * height,
    visible: vector.z > -1 && vector.z < 1,
  };
}

function wrapSpeechText(text, maxWidth) {
  const lines = [];
  let line = '';
  for (const character of [...text]) {
    const candidate = `${line}${character}`;
    if (line && fxCtx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = character;
      if (lines.length === 2) break;
    } else {
      line = candidate;
    }
  }
  if (line && lines.length < 2) lines.push(line);
  if (lines.length === 2 && lines.join('').length < text.length) {
    while (lines[1].length > 1 && fxCtx.measureText(`${lines[1]}…`).width > maxWidth) lines[1] = lines[1].slice(0, -1);
    lines[1] = `${lines[1]}…`;
  }
  return lines;
}

function renderSpeechBubble(bubble, stageWidth, stageHeight) {
  const enemy = bubble.enemy;
  if (!enemy?.active) return;
  const point = projectToScreen(enemy.x, Math.max(1.75, enemy.scale * 1.75), enemy.z);
  if (!point.visible || point.x < -80 || point.x > stageWidth + 80 || point.y < 20 || point.y > stageHeight - 30) return;
  const progress = clamp(bubble.life / bubble.maxLife, 0, 1);
  const alpha = Math.min(1, (1 - progress) * 7, progress * 4.5);
  const fontSize = stageWidth < 620 ? 10 : 12;
  const maxTextWidth = stageWidth < 620 ? 126 : 176;
  fxCtx.save();
  fxCtx.font = `800 ${fontSize}px Inter, system-ui, sans-serif`;
  const lines = wrapSpeechText(bubble.text, maxTextWidth);
  const lineHeight = fontSize + 4;
  const widest = Math.max(...lines.map((line) => fxCtx.measureText(line).width), 60);
  const bubbleWidth = Math.min(maxTextWidth + 22, widest + 22);
  const bubbleHeight = lines.length * lineHeight + 16;
  const left = clamp(point.x - bubbleWidth / 2, 8, stageWidth - bubbleWidth - 8);
  const top = clamp(point.y - bubbleHeight - 18, 68, stageHeight - bubbleHeight - 22);
  const tailX = clamp(point.x, left + 16, left + bubbleWidth - 16);
  const accent = currentTheme().palette.accent;
  fxCtx.globalAlpha = alpha;
  fxCtx.fillStyle = 'rgba(4, 12, 21, 0.94)';
  fxCtx.strokeStyle = accent;
  fxCtx.lineWidth = 1.4;
  fxCtx.shadowColor = accent;
  fxCtx.shadowBlur = 10;
  fxCtx.beginPath();
  fxCtx.roundRect(left, top, bubbleWidth, bubbleHeight, 9);
  fxCtx.fill();
  fxCtx.stroke();
  fxCtx.shadowBlur = 0;
  fxCtx.beginPath();
  fxCtx.moveTo(tailX - 6, top + bubbleHeight - 1);
  fxCtx.lineTo(tailX, top + bubbleHeight + 8);
  fxCtx.lineTo(tailX + 7, top + bubbleHeight - 1);
  fxCtx.closePath();
  fxCtx.fill();
  fxCtx.stroke();
  fxCtx.fillStyle = '#f4fbff';
  fxCtx.textAlign = 'center';
  fxCtx.textBaseline = 'middle';
  lines.forEach((line, index) => {
    fxCtx.fillText(line, left + bubbleWidth / 2, top + 9 + lineHeight * (index + 0.5));
  });
  fxCtx.restore();
}

function renderFx() {
  const width = els.stage.clientWidth;
  const height = els.stage.clientHeight;
  fxCtx.clearRect(0, 0, width, height);

  for (const line of lightningItems) {
    const a = projectToScreen(line.ax, line.ay, line.az);
    const b = projectToScreen(line.bx, line.by, line.bz);
    if (!a.visible || !b.visible) continue;
    const alpha = clamp(line.life / line.maxLife, 0, 1);
    fxCtx.save();
    fxCtx.globalAlpha = alpha;
    fxCtx.strokeStyle = '#d9c2ff';
    fxCtx.lineWidth = 2.4;
    fxCtx.shadowColor = '#9b6cff';
    fxCtx.shadowBlur = 11;
    fxCtx.beginPath();
    fxCtx.moveTo(a.x, a.y);
    const midX = (a.x + b.x) / 2 + randomBetween(-10, 10);
    const midY = (a.y + b.y) / 2 + randomBetween(-10, 10);
    fxCtx.quadraticCurveTo(midX, midY, b.x, b.y);
    fxCtx.stroke();
    fxCtx.restore();
  }

  for (const item of fxItems) {
    const point = projectToScreen(item.x, item.y, item.z);
    if (!point.visible) continue;
    const alpha = clamp(item.life / item.maxLife, 0, 1);
    fxCtx.save();
    fxCtx.globalAlpha = alpha;
    if (item.kind === 'text') {
      fxCtx.fillStyle = item.color;
      fxCtx.font = `900 ${item.size}px Inter, system-ui, sans-serif`;
      fxCtx.textAlign = 'center';
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 8;
      fxCtx.fillText(item.text, point.x, point.y);
    } else if (item.kind === 'ticket') {
      fxCtx.translate(point.x, point.y);
      fxCtx.rotate(item.angle);
      fxCtx.fillStyle = '#f5fbff';
      fxCtx.strokeStyle = item.color;
      fxCtx.lineWidth = Math.max(1, item.size * 0.18);
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 7;
      fxCtx.fillRect(-item.size * 1.4, -item.size * 0.8, item.size * 2.8, item.size * 1.6);
      fxCtx.strokeRect(-item.size * 1.4, -item.size * 0.8, item.size * 2.8, item.size * 1.6);
    } else if (item.kind === 'shard') {
      fxCtx.translate(point.x, point.y);
      fxCtx.rotate(item.angle);
      fxCtx.fillStyle = item.color;
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 9;
      fxCtx.beginPath();
      fxCtx.moveTo(item.size * 1.8, 0);
      fxCtx.lineTo(-item.size * 0.75, item.size * 0.48);
      fxCtx.lineTo(-item.size * 0.35, -item.size * 0.48);
      fxCtx.closePath();
      fxCtx.fill();
    } else {
      fxCtx.fillStyle = item.color;
      fxCtx.shadowColor = item.color;
      fxCtx.shadowBlur = 8;
      fxCtx.beginPath();
      fxCtx.arc(point.x, point.y, item.size * alpha, 0, Math.PI * 2);
      fxCtx.fill();
    }
    fxCtx.restore();
  }

  for (const bubble of speechBubbles) renderSpeechBubble(bubble, width, height);
  if (state.flash > 0.005) {
    fxCtx.save();
    fxCtx.globalCompositeOperation = 'screen';
    fxCtx.globalAlpha = clamp(state.flash, 0, 0.62);
    fxCtx.fillStyle = state.flashColor || '#ffffff';
    fxCtx.fillRect(0, 0, width, height);
    fxCtx.restore();
  }
}

function showUpgrade() {
  if (state.mode !== 'playing') return;
  const available = upgrades.filter((upgrade) => {
    if (upgrade.id === 'repair') return state.baseHp < 78;
    return state.levels[upgrade.id] < upgrade.max;
  });
  for (let index = available.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(state.random() * (index + 1));
    [available[index], available[swap]] = [available[swap], available[index]];
  }
  state.currentUpgrades = available.slice(0, 3);
  while (state.currentUpgrades.length < 3) state.currentUpgrades.push(upgrades.find((upgrade) => upgrade.id === 'repair'));
  state.mode = 'upgrade';
  state.upgradeDeadline = performance.now() + 7000;
  els.upgradeOptions.innerHTML = '';
  state.currentUpgrades.forEach((upgrade, index) => {
    const presentation = upgradePresentation(upgrade);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upgrade-option';
    button.style.setProperty('--upgrade-color', upgrade.color);
    const currentLevel = upgrade.id === 'repair' ? '即时生效' : `当前 Lv.${state.levels[upgrade.id] || 0}`;
    button.innerHTML = `
      <span class="upgrade-index">${index + 1}</span>
      <span class="upgrade-icon">${upgrade.icon}</span>
      <b>${presentation.title}</b>
      <p>${presentation.description}</p>
      <small>${currentLevel}</small>
    `;
    button.addEventListener('click', () => selectUpgrade(index));
    els.upgradeOptions.appendChild(button);
  });
  setOverlay(els.upgradeOverlay, true);
  sfx.upgrade();
}

function selectUpgrade(index) {
  if (state.mode !== 'upgrade') return;
  const upgrade = state.currentUpgrades[index];
  if (!upgrade) return;
  const presentation = upgradePresentation(upgrade);
  upgrade.apply();
  triggerTurretUpgradeEffect(upgrade.id, presentation.title);
  state.telemetry.upgrades += 1;
  state.mode = 'playing';
  state.lastTs = performance.now();
  state.nextUpgradeAt += currentTheme().upgradeInterval;
  setOverlay(els.upgradeOverlay, false);
  showToast(`${upgrade.icon} ${presentation.title} 已安装：${presentation.description}`);
  updateHud(true);
}

function updateUpgradeCountdown(now) {
  if (state.mode !== 'upgrade') return;
  if (!els.autoPickInput.checked) {
    els.upgradeCountdown.textContent = '直播自动选择已关闭，等待你的决定';
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.upgradeDeadline - now) / 1000));
  els.upgradeCountdown.textContent = `自动选择倒计时 ${seconds} 秒`;
  if (seconds <= 0) selectUpgrade(0);
}

function updateGame(dt) {
  const level = currentLevel();
  state.elapsed += dt;
  if (state.elapsed > state.comboUntil) state.combo = 1;

  updateChoiceGates(dt);
  updateSpawning(dt);
  updateCharacterSpeech(dt);
  updateEnemies(dt);
  updateBonusTargets(dt);
  if (state.mode !== 'playing') return;
  updateTurrets(dt);
  updateProjectiles(dt);
  updateFx(dt);

  if (state.bossDefeated && state.finishAt && state.elapsed >= state.finishAt) endGame(true);
  if (state.elapsed >= level.duration && !state.bossSpawned && state.gatePhase === 'none') summonBoss(false);
}

function endGame(victory) {
  const theme = currentTheme();
  if (!['playing', 'upgrade'].includes(state.mode)) return;
  state.lastVictory = victory;
  state.mode = 'result';
  setOverlay(els.upgradeOverlay, false);
  els.resultEyebrow.textContent = victory ? `RUN COMPLETE / ${theme.english}` : `SIMULATION FAILED / ${theme.english}`;
  els.resultTitle.textContent = victory ? theme.victoryTitle : theme.defeatTitle;
  els.resultDescription.textContent = victory
    ? `第 ${state.level} 关「${currentLevel().title}」完成。${theme.victoryDescription}`
    : `第 ${state.level} 关「${currentLevel().title}」失败。${theme.defeatDescription}`;
  els.againButtonLabel.textContent = victory && state.level < 10 ? `进入第 ${state.level + 1} 关` : victory ? '重打最终关' : '重新挑战本关';
  els.finalScore.textContent = formatScore(state.score);
  els.finalKills.textContent = formatScore(state.kills);
  els.finalCombo.textContent = `×${state.maxCombo}`;
  els.finalRank.textContent = '提交中';
  els.newBestBadge.classList.add('hidden');
  setOverlay(els.resultOverlay, true);
  if (!victory) {
    // Defeat stinger: low descending thud with a long tail.
    sfx.defeat();
    triggerCombatFlash(0.4, '#ff3348');
  }
  submitRun(victory);
}

function startNextOrReplay() {
  if (state.lastVictory && state.level < 10) {
    state.level += 1;
    localStorage.setItem(`toy-toy-toy-level-${state.themeId}`, String(state.level));
  }
  startGame();
}

function renderEnemies() {
  const counts = { normal: 0, runner: 0, tank: 0, elite: 0, boss: 0 };
  let shadowCount = 0;
  let boss = null;
  for (const enemy of enemies) {
    if (!enemy.active) continue;
    const visual = enemyVisuals[enemy.type] || enemyVisuals.normal;
    const index = counts[enemy.type] || 0;
    if (index >= WORLD.maxEnemies) continue;
    const slowed = state.elapsed < enemy.slowUntil;
    const hit = state.elapsed < enemy.hitUntil;
    const impact = clamp(enemy.impactPulse || 0, 0, 1);
    const stride = Math.sin(enemy.wobble * 2.15);
    matrixDummy.position.set(
      enemy.x + (enemy.impactSide || 0) * impact * 0.16,
      0.025 + Math.abs(stride) * 0.045 + impact * 0.08,
      enemy.z - impact * (enemy.type === 'boss' ? 0.16 : 0.34),
    );
    const squash = 1 + stride * (enemy.type === 'runner' ? 0.085 : 0.045);
    const frozenScale = slowed ? 0.94 : 1;
    matrixDummy.scale.set(
      enemy.scale * squash * frozenScale * (1 + impact * 0.17),
      enemy.scale / squash * (1 - impact * 0.15),
      enemy.scale,
    );
    matrixDummy.rotation.set(-0.72, 0, stride * (enemy.type === 'runner' ? 0.105 : 0.055) + (enemy.impactSide || 0) * impact * 0.12);
    matrixDummy.updateMatrix();
    visual.mesh.setMatrixAt(index, matrixDummy.matrix);
    // The camera looks toward decreasing Z from the base, so the dark sticker
    // outline must sit slightly farther away (positive Z) to remain behind the
    // full-colour character atlas instead of occluding it.
    outlineDummy.position.set(enemy.x + (enemy.impactSide || 0) * impact * 0.14, matrixDummy.position.y, matrixDummy.position.z + 0.035);
    outlineDummy.rotation.copy(matrixDummy.rotation);
    outlineDummy.scale.set(
      matrixDummy.scale.x * 1.085,
      matrixDummy.scale.y * 1.085,
      matrixDummy.scale.z,
    );
    outlineDummy.updateMatrix();
    visual.outlineMesh.setMatrixAt(index, outlineDummy.matrix);
    enemyTint.setHex(hit ? 0xff6d78 : slowed ? 0x79d9ff : (enemy.tint || 0xffffff));
    if (impact > 0) enemyTint.lerp(impactWhite, impact * 0.78);
    visual.mesh.setColorAt(index, enemyTint);

    shadowDummy.position.set(enemy.x, -0.065, enemy.z + 0.34 * enemy.scale);
    shadowDummy.rotation.set(0, 0, 0);
    shadowDummy.scale.set(enemy.scale * visual.shadow * (hit ? 1.12 : 1), 1, enemy.scale * visual.shadow * 0.7);
    shadowDummy.updateMatrix();
    enemyShadowMesh.setMatrixAt(shadowCount, shadowDummy.matrix);
    shadowCount += 1;
    if (enemy.type === 'boss') boss = enemy;
    counts[enemy.type] = index + 1;
  }
  for (const [type, visual] of Object.entries(enemyVisuals)) {
    visual.mesh.count = counts[type] || 0;
    visual.mesh.instanceMatrix.needsUpdate = true;
    if (visual.mesh.instanceColor) visual.mesh.instanceColor.needsUpdate = true;
    visual.outlineMesh.count = counts[type] || 0;
    visual.outlineMesh.instanceMatrix.needsUpdate = true;
  }
  enemyShadowMesh.count = shadowCount;
  enemyShadowMesh.instanceMatrix.needsUpdate = true;

  if (boss?.active) {
    const ratio = clamp(boss.hp / boss.maxHp, 0, 1);
    els.bossHpFill.style.width = `${ratio * 100}%`;
    els.bossHpText.textContent = `${Math.ceil(ratio * 100)}% · ${formatCompactNumber(boss.hp)}`;
  }
}

function updateHud(force = false) {
  const theme = currentTheme();
  const now = performance.now();
  if (!force && now - state.lastUiAt < 90) return;
  state.lastUiAt = now;
  els.score.textContent = formatScore(state.score);
  els.kills.textContent = formatScore(state.kills);
  els.combo.textContent = `×${state.combo}`;
  els.level.textContent = `${String(state.level).padStart(2, '0')}/10`;
  const remaining = Math.max(0, Math.ceil(currentLevel().duration - state.elapsed));
  els.time.textContent = remaining > 0 ? String(remaining) : state.bossAlive ? 'BOSS' : '0';
  els.baseHpText.textContent = `${Math.ceil(state.baseHp)}%`;
  els.baseHpFill.style.width = `${clamp(state.baseHp, 0, 100)}%`;
  els.shell.classList.toggle('danger-state', state.baseHp < 30 && state.mode === 'playing');
  els.damageLevel.textContent = `Lv.${state.levels.damage}`;
  els.rateLevel.textContent = `Lv.${state.levels.rate}`;
  els.blastLevel.textContent = `Lv.${state.levels.blast}`;
  els.chainLevel.textContent = `Lv.${state.levels.chain}`;
  els.frostLevel.textContent = `Lv.${state.levels.frost}`;
  els.bonusDamageValue.textContent = `×${state.bonuses.damage.toFixed(2)}`;
  els.bonusRateValue.textContent = `×${state.bonuses.rate.toFixed(2)}`;
  els.cannonCountValue.textContent = `${state.levels.cannon} / ${MAX_CANNONS}`;
  els.cannonShardValue.textContent = state.levels.cannon >= MAX_CANNONS ? 'MAX' : `${state.bonuses.shards} / 2`;
  els.bonusCountValue.textContent = `选择 ×${state.telemetry.gatesChosen}`;
  const frenzyRemaining = Math.max(0, state.frenzyUntil - state.elapsed);
  const overdriveRemaining = Math.max(0, state.overdriveUntil - state.elapsed);
  const choosingGate = state.gatePhase === 'active';
  if (state.gatePhase === 'prep') els.bonusCountValue.textContent = '算术车队接近';
  else if (choosingGate) els.bonusCountValue.textContent = `随队选择 ${Math.max(0, state.gateChoiceUntil - state.elapsed).toFixed(1)}s`;
  else if (state.gatePhase === 'resume') els.bonusCountValue.textContent = '选择已锁定';
  els.frenzyBtn.classList.toggle('active', frenzyRemaining > 0);
  els.overdriveBtn.classList.toggle('active', overdriveRemaining > 0);
  els.bossBtn.classList.toggle('active', state.bossAlive);
  els.frenzyBtn.setAttribute('aria-pressed', frenzyRemaining > 0 ? 'true' : 'false');
  els.overdriveBtn.setAttribute('aria-pressed', overdriveRemaining > 0 ? 'true' : 'false');
  els.bossBtn.setAttribute('aria-pressed', state.bossAlive ? 'true' : 'false');
  els.frenzyDescription.textContent = state.gatePhase !== 'none'
    ? '算术车队中：普通敌潮仍以低密度推进'
    : frenzyRemaining > 0
    ? `生效中 ${frenzyRemaining.toFixed(1)} 秒 · 实际敌潮 ×10`
    : `${theme.director.frenzyDescription}${state.telemetry.frenzyUses ? ` · 已触发 ${state.telemetry.frenzyUses} 次` : ''}`;
  els.overdriveDescription.textContent = overdriveRemaining > 0
    ? `生效中 ${overdriveRemaining.toFixed(1)} 秒 · 伤害 ×2.45 / 射速 ×2.4`
    : `${theme.director.overdriveDescription}${state.telemetry.overdriveUses ? ` · 已触发 ${state.telemetry.overdriveUses} 次` : ''}`;
  els.bossButtonDescription.textContent = state.gatePhase !== 'none'
    ? '选择阶段锁定：完成挡板后可召唤'
    : state.bossAlive
    ? '已登场 · 固定中路 · 仅当前路可攻击'
    : state.bossSpawned
      ? '本局 Boss 已处理，不能重复召唤'
      : `${theme.director.bossDescription} · 本关生命约 ${formatCompactNumber(9200 * bossHpFactor() * theme.bossHpMultiplier)}`;
  els.laneHint.textContent = choosingGate
    ? (theme.id === 'deadline' ? '评审车队混在需求中：工单只打一条服务，击穿一项后其余锁死' : '算术门混在尸群中：炮弹只打一条路，击穿一门后其余锁死')
    : theme.laneHint;
  els.frenzyBtn.disabled = state.mode !== 'playing' || state.gatePhase !== 'none';
  els.overdriveBtn.disabled = state.mode !== 'playing';
  els.bossBtn.disabled = state.mode !== 'playing' || state.gatePhase !== 'none' || state.bossSpawned;
  baseLight.intensity = state.elapsed < state.overdriveUntil ? 34 : 18;
  baseLight.color.setHex(state.elapsed < state.overdriveUntil ? 0xffd84f : state.baseHp < 30 ? 0xff5f57 : theme.palette.core);
  wallMaterial.emissive.setHex(state.baseHp < 30 ? 0x66141a : state.elapsed < state.overdriveUntil ? 0x5c4810 : theme.palette.wallEmissive);
}

function renderScene(dt) {
  renderEnemies();
  state.shake = Math.max(0, state.shake - dt * 2.7);
  state.flash = Math.max(0, state.flash - dt * 4.8);
  const shakeAmount = state.shake * state.shake;
  camera.position.set(
    cameraHome.x + randomBetween(-shakeAmount, shakeAmount),
    cameraHome.y + randomBetween(-shakeAmount * 0.35, shakeAmount * 0.35),
    cameraHome.z + randomBetween(-shakeAmount, shakeAmount),
  );
  visualSystem.update({
    dt,
    elapsed: state.elapsed,
    enemies,
    baseHp: state.baseHp,
    levels: state.levels,
    overdriveUntil: state.overdriveUntil,
    seed: state.seed,
  });
  visualSystem.render();
  renderFx();
}

function frame(now) {
  const rawDt = clamp((now - state.lastTs) / 1000, 0, 0.05);
  state.lastTs = now;
  if (state.mode === 'playing') {
    const hitStopScale = now < state.hitStopUntil ? 0.06 : 1;
    updateGame(rawDt * state.speed * hitStopScale);
  }
  else if (state.mode === 'upgrade') updateUpgradeCountdown(now);
  syncMusic();
  updateHud();
  renderScene(rawDt);
  requestAnimationFrame(frame);
}

function renderLeaderboard(rows) {
  els.leaderboardList.innerHTML = '';
  if (!Array.isArray(rows) || !rows.length) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有战绩，你可以拿下第一名。';
    els.leaderboardList.appendChild(empty);
    return;
  }
  rows.slice(0, 8).forEach((row) => {
    const item = document.createElement('li');
    const name = document.createElement('b');
    const score = document.createElement('em');
    name.textContent = `${row.display_name || row.username || '匿名玩家'} · L${row.level || 1}`;
    score.textContent = formatScore(row.score || 0);
    item.append(name, score);
    els.leaderboardList.appendChild(item);
  });
}

async function loadIdentity() {
  try {
    const result = await extCall({ action: 'whoami' });
    if (result?.ok) els.identity.textContent = result.display_name || result.username || '玩家';
  } catch {
    els.identity.textContent = '本地玩家';
  }
}

async function loadLeaderboard() {
  const requestedTheme = state.themeId;
  try {
    const result = await extCall({ action: 'get_leaderboard', theme: requestedTheme });
    if (state.themeId !== requestedTheme) return;
    if (result?.ok) renderLeaderboard(result.leaderboard);
    else renderLeaderboard([]);
  } catch {
    if (state.themeId === requestedTheme) renderLeaderboard([]);
  }
}

async function submitRun(victory) {
  const localKey = `toy-toy-toy-high-score-${state.themeId}`;
  const previousLocal = Number(localStorage.getItem(localKey) || 0);
  const localBest = state.score > previousLocal;
  if (localBest) localStorage.setItem(localKey, String(Math.round(state.score)));
  try {
    const result = await extCall({
      action: 'submit_run',
      theme: state.themeId,
      score: Math.round(state.score),
      kills: state.kills,
      duration: Math.round(state.elapsed),
      level: state.level,
      victory,
      seed: state.seed,
    });
    if (!result?.ok) throw new Error(result?.error || 'submit failed');
    els.finalRank.textContent = result.rank ? `#${result.rank}` : '100+';
    els.newBestBadge.classList.toggle('hidden', !(result.is_best || localBest));
    renderLeaderboard(result.leaderboard);
  } catch {
    els.finalRank.textContent = '本地';
    els.newBestBadge.classList.toggle('hidden', !localBest);
  }
}

window.__TOY_TOY_TOY_DEBUG__ = Object.freeze({
  previewSound(name, options = {}) {
    ensureAudio();
    return audioSystem.previewSound(name, options);
  },
  setAudioMix({ master } = {}) {
    if (Number.isFinite(Number(master))) return audioSystem.setMasterVolume(Number(master));
    return audioSystem.snapshot().masterVolume;
  },
  setVisualMode(mode) {
    return visualSystem.setMode(mode);
  },
  setQualityTier(tier) {
    visualSystem.setQuality(tier);
    resize();
    return visualSystem.snapshot().qualityTier;
  },
  setCameraBookmark(name) {
    const bookmark = visualSystem.setCameraBookmark(name);
    cameraHome.copy(camera.position);
    return bookmark;
  },
  configureBuild(build = {}) {
    const levelKeys = ['damage', 'rate', 'blast', 'chain', 'frost', 'multi', 'crit', 'cannon'];
    levelKeys.forEach((key) => {
      if (!Number.isFinite(Number(build[key]))) return;
      const maximum = key === 'cannon' ? MAX_CANNONS : key === 'multi' ? 3 : key === 'frost' ? 4 : key === 'damage' || key === 'rate' ? 7 : 5;
      state.levels[key] = clamp(Math.round(Number(build[key])), key === 'damage' || key === 'rate' || key === 'cannon' ? 1 : 0, maximum);
    });
    if (Number.isFinite(Number(build.damageBonus))) state.bonuses.damage = clamp(Number(build.damageBonus), 1, 100);
    if (Number.isFinite(Number(build.rateBonus))) state.bonuses.rate = clamp(Number(build.rateBonus), 1, 100);
    if (Number.isFinite(Number(build.critBonus))) state.bonuses.crit = clamp(Number(build.critBonus), 0, 1);
    triggerTurretUpgradeEffect('debug-build', '全构筑视觉验收');
    updateHud(true);
    return true;
  },
  forceGate() {
    if (state.mode !== 'playing') return false;
    choiceGates.splice(0).forEach(disposeChoiceGate);
    state.gatePhase = 'prep';
    state.gatePrepUntil = state.elapsed;
    spawnChoiceGates();
    return true;
  },
  pullEnemies(z = -1.5, durability = 1) {
    let index = 0;
    enemies.forEach((enemy) => {
      if (!enemy.active || enemy.type === 'boss') return;
      enemy.lane = 1;
      enemy.x = WORLD.lanes[1] + ((index % 5) - 2) * 0.46;
      enemy.z = Number(z) - Math.floor(index / 5) * 0.48;
      if (Number(durability) > 1) {
        enemy.maxHp *= Number(durability);
        enemy.hp = enemy.maxHp;
      }
      index += 1;
    });
    return index;
  },
  snapshot() {
    const combat = currentCombatStats();
    const cinematicVisuals = visualSystem.snapshot();
    return {
      version: '0.14.0',
      mode: state.mode,
      lastVictory: state.lastVictory,
      theme: state.themeId,
      level: state.level,
      levelTitle: currentLevel().title,
      levelDuration: currentLevel().duration,
      levelBossAt: currentLevel().bossAt,
      bossHpFactor: bossHpFactor(),
      roleCatalog: currentLevel().roles.map((id) => currentRoleMap()[id]?.name).filter(Boolean),
      elapsed: state.elapsed,
      speed: state.speed,
      baseHp: state.baseHp,
      focusLane: state.focusLane,
      livingEnemies: livingEnemies().length,
      laneThreat: [0, 1, 2].map((lane) => {
        const laneEnemies = enemies.filter((enemy) => enemy.active && enemy.lane === lane);
        return {
          lane,
          count: laneEnemies.length,
          nearestZ: laneEnemies.reduce((nearest, enemy) => Math.max(nearest, enemy.z), WORLD.spawnZ),
          totalHp: laneEnemies.reduce((sum, enemy) => sum + enemy.hp, 0),
        };
      }),
      activeBonusTargets: bonusTargets.filter((target) => target.active).map((target) => target.rewardType),
      gate: {
        phase: state.gatePhase,
        round: state.gateRound,
        lastEffect: state.lastGateEffect,
        catalog: GATE_EFFECTS.map((effect) => effect.id),
        choices: choiceGates.filter((gate) => gate.active).map((gate) => ({
          id: gate.effect.id,
          lane: gate.lane,
          hitsRemaining: gate.hitsRemaining,
          requiredHits: gate.requiredHits,
          displayColor: cssHex(gate.displayColor),
          preview: gate.board.preview,
        })),
      },
      activeSpeech: speechBubbles.map((bubble) => ({ type: bubble.enemy?.type, text: bubble.text })),
      effects: {
        frenzyRemaining: Math.max(0, state.frenzyUntil - state.elapsed),
        overdriveRemaining: Math.max(0, state.overdriveUntil - state.elapsed),
        bossSpawned: state.bossSpawned,
        bossAlive: state.bossAlive,
        bossHp: enemies.find((enemy) => enemy.active && enemy.type === 'boss')?.hp || 0,
        bossMaxHp: enemies.find((enemy) => enemy.active && enemy.type === 'boss')?.maxHp || 0,
        bossSpeed: enemies.find((enemy) => enemy.active && enemy.type === 'boss')?.speed || 0,
      },
      combat: {
        damage: combat.damage,
        fireInterval: combat.fireInterval,
        cannonCount: state.levels.cannon,
        projectileStyle: state.themeId === 'deadline' ? 'ticket-feedback' : 'energy-shell',
        targetCount: Math.min(MAX_CANNONS, state.levels.cannon) * (1 + Math.min(3, state.levels.multi)),
      },
      visuals: {
        cinematic: cinematicVisuals,
        visibleCannons: turretGroups.filter((turret) => turret.group.visible && turret.cannonModel.visible).length,
        visibleWorkbenches: turretGroups.filter((turret) => turret.group.visible && turret.workbenchModel.visible).length,
        activeTickets: projectilePool.filter((projectile) => projectile.active && projectile.ticket.visible).length,
        activeShells: projectilePool.filter((projectile) => projectile.active && projectile.energy.visible).length,
        projectileVariants: ['normal', 'blast', 'chain', 'frost'].reduce((summary, variant) => ({
          ...summary,
          [variant]: projectilePool.filter((projectile) => projectile.active && projectile.variant === variant).length,
        }), {}),
        projectileTravel: (() => {
          const active = projectilePool.filter((projectile) => projectile.active);
          return active.length ? {
            minZ: Math.min(...active.map((projectile) => projectile.z)),
            maxZ: Math.max(...active.map((projectile) => projectile.z)),
          } : null;
        })(),
        muzzleFlashes: turretGroups.filter((turret) => turret.zombieMuzzle.visible || turret.deadlineMuzzle.visible).length,
        sideBarrels: turretGroups.reduce((sum, turret) => sum + turret.sideBarrels.filter((mesh) => mesh.visible).length, 0),
        sideScreens: turretGroups.reduce((sum, turret) => sum + turret.sideScreens.filter((mesh) => mesh.visible).length, 0),
        blastPods: turretGroups.reduce((sum, turret) => sum + turret.blastPods.filter((mesh) => mesh.visible).length, 0),
        chainAttachments: turretGroups.reduce((sum, turret) => sum + turret.chainCoils.filter((mesh) => mesh.visible).length, 0),
        frostAttachments: turretGroups.reduce((sum, turret) => sum + turret.frostFins.filter((mesh) => mesh.visible).length, 0),
        explosions: cinematicVisuals.vfx.activeBursts,
        shockwaves: cinematicVisuals.vfx.activeShockwaves,
        upgradeBursts: cinematicVisuals.vfx.activeBursts,
        evolutionStages: turretGroups.filter((turret) => turret.group.visible).map((turret) => turret.evolutionStage),
        hitStopActive: performance.now() < state.hitStopUntil,
      },
      bonuses: { ...state.bonuses },
      levels: { ...state.levels },
      telemetry: { ...state.telemetry },
      audio: audioSystem.snapshot(),
      controls: {
        autoPick: els.autoPickInput.checked,
        muted,
        frenzyDisabled: els.frenzyBtn.disabled,
        overdriveDisabled: els.overdriveBtn.disabled,
        bossDisabled: els.bossBtn.disabled,
        audioState: audioSystem.snapshot().contextState,
      },
    };
  },
});

els.startBtn.addEventListener('click', startGame);
// First pointer interaction anywhere unlocks the menu ambience.
window.addEventListener('pointerdown', () => { ensureAudio(); syncMusic(); }, { once: true });
els.themeButtons.forEach((button) => button.addEventListener('click', () => {
  if (state.mode !== 'menu') return;
  applyTheme(button.dataset.theme);
  updateHud(true);
}));
els.againBtn.addEventListener('click', startNextOrReplay);
els.menuBtn.addEventListener('click', showMenu);
els.pauseBtn.addEventListener('click', () => togglePause());
els.resumeBtn.addEventListener('click', () => togglePause(true));
els.restartBtn.addEventListener('click', startGame);
els.pauseLevelBtn.addEventListener('click', showMenu);
els.pauseThemeBtn.addEventListener('click', switchThemeFromPause);
els.pauseExitBtn.addEventListener('click', showMenu);
els.frenzyBtn.addEventListener('click', triggerFrenzy);
els.overdriveBtn.addEventListener('click', () => triggerOverdrive(false));
els.bossBtn.addEventListener('click', () => summonBoss(true));
els.directorToggle.addEventListener('click', () => {
  const collapsed = els.directorPanel.classList.toggle('collapsed');
  els.directorToggle.textContent = collapsed ? '+' : '−';
  els.directorToggle.setAttribute('aria-label', collapsed ? '展开导演台' : '收起导演台');
});
els.speedRange.addEventListener('input', () => {
  state.speed = Number(els.speedRange.value);
  els.speedLabel.textContent = `${state.speed}×`;
});
els.soundBtn.addEventListener('click', () => {
  muted = !muted;
  localStorage.setItem('toy-toy-toy-muted', muted ? '1' : '0');
  els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
  audioSystem.setMuted(muted);
  if (muted) {
    music.stop();
    musicMode = 'off';
  } else {
    ensureAudio();
    musicMode = 'off'; // force syncMusic to re-enter the right state
    syncMusic();
    sfx.soundOn();
  }
});
els.laneButtons.forEach((button) => button.addEventListener('click', () => selectLane(Number(button.dataset.lane))));

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (state.mode !== 'playing') return;
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  selectLane(x < 0.36 ? 0 : x > 0.64 ? 2 : 1);
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyP' || event.code === 'Escape') {
    if (state.mode === 'playing' || state.mode === 'paused') togglePause();
    return;
  }
  if (state.mode === 'upgrade' && ['Digit1', 'Digit2', 'Digit3'].includes(event.code)) {
    selectUpgrade(Number(event.code.slice(-1)) - 1);
    return;
  }
  if (state.mode !== 'playing') return;
  if (event.code === 'KeyA' || event.code === 'ArrowLeft') moveLane(-1);
  else if (event.code === 'KeyS' || event.code === 'ArrowDown') selectLane(1);
  else if (event.code === 'KeyD' || event.code === 'ArrowRight') moveLane(1);
  else if (event.code === 'Space') {
    event.preventDefault();
    triggerOverdrive(false);
  }
});

window.addEventListener('resize', resize);
window.addEventListener('pagehide', (event) => {
  music.dispose();
  if (!event.persisted) audioSystem.dispose();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state.mode === 'playing') togglePause();
});

els.soundBtn.textContent = muted ? '声音 OFF' : '声音 ON';
els.autoPickInput.checked = localStorage.getItem('toy-toy-toy-auto-pick') !== '0';
els.autoPickInput.addEventListener('change', () => {
  localStorage.setItem('toy-toy-toy-auto-pick', els.autoPickInput.checked ? '1' : '0');
});

if (window.matchMedia('(max-width: 760px)').matches) {
  els.directorPanel.classList.add('collapsed');
  els.directorToggle.textContent = '+';
  els.directorToggle.setAttribute('aria-label', '展开导演台');
}

resize();
applyTheme(state.themeId, { persist: false, refreshLeaderboard: false });
resetGame();
Promise.allSettled([loadIdentity(), loadLeaderboard()]);
requestAnimationFrame(frame);
