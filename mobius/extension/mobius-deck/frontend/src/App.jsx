import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bell,
  Brain,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Code2,
  Cpu,
  Database,
  Expand,
  FileText,
  GitBranch,
  Globe2,
  Grid3X3,
  HardDrive,
  Laptop,
  Lock,
  Monitor,
  Network,
  Package,
  Pause,
  Play,
  RotateCcw,
  Server,
  ShieldCheck,
  Smartphone,
  Target,
  Terminal,
  Users,
  Zap,
} from 'lucide-react';

const AUTOPLAY_MS = 6200;

const slides = [
  {
    id: 'reach',
    label: '总览',
    eyebrow: '01 / Mobius Reach',
    title: 'Mobius 触手，\n无处不可达',
    summary: '通过 SSH/SFTP、AIMUX、代理与代理池、内网算力，把云存储、云服务器、工作站、嵌入式设备、员工 PC 与复杂因特网接入同一触手层。',
    component: ReachSlide,
  },
  {
    id: 'security',
    label: '安全',
    eyebrow: '02 / Data Control',
    title: '数据安全可靠',
    summary: '核心数据留在本地安全域，外部访问走可控代理和审计边界。',
    component: SecuritySlide,
  },
  {
    id: 'assistant',
    label: '汇报',
    eyebrow: '03 / Manager Assistant',
    title: '小莫项目\n进展汇报',
    summary: '小莫以管理员权限查询动态，汇总项目、员工、任务进度，并把修改代码、自动进化、智能监测、远程协同串起来。',
    component: AssistantSlide,
  },
  {
    id: 'manager',
    label: '管理',
    eyebrow: '04 / AI Management',
    title: '成为 AI 时代的\n团队管理者',
    summary: '用 token、产出和熟练度数据识别团队变化，指导培训和分工。',
    component: ManagerSlide,
  },
  {
    id: 'architecture',
    label: '架构',
    eyebrow: '05 / System Layers',
    title: 'Mobius\n系统架构',
    summary: '任务执行层、普通任务层、研发任务层、项目用户层与超级管理员共同构成 Mobius 系统架构。',
    component: ArchitectureSlide,
  },
  {
    id: 'loop',
    label: '闭环',
    eyebrow: '06 / Productivity Loop',
    title: 'Mobius\n生产力闭环',
    summary: '插件市场、迭代环境、托管项目和多端生产力环境持续互相强化。',
    component: LoopSlide,
  },
];

function wrapIndex(value) {
  if (value < 0) return slides.length - 1;
  if (value >= slides.length) return 0;
  return value;
}

function getInitialSlideIndex() {
  if (typeof window === 'undefined') return 0;

  const slideParam = new URLSearchParams(window.location.search).get('slide');
  const parsed = Number(slideParam);
  if (!Number.isInteger(parsed)) return 0;
  return Math.min(Math.max(parsed - 1, 0), slides.length - 1);
}

function App() {
  const [activeIndex, setActiveIndex] = useState(getInitialSlideIndex);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const deckRef = useRef(null);
  const stageRef = useRef(null);
  const activeSlide = slides[activeIndex];
  const ActiveSlide = activeSlide.component;

  const progress = useMemo(
    () => `${((activeIndex + 1) / slides.length) * 100}%`,
    [activeIndex]
  );

  const goTo = (index) => {
    const nextIndex = wrapIndex(index);
    setActiveIndex(nextIndex);
    setShowOverview(false);

    const url = new URL(window.location.href);
    url.searchParams.set('slide', String(nextIndex + 1));
    window.history.replaceState(null, '', url);
  };

  const goNext = () => goTo(activeIndex + 1);
  const goPrev = () => goTo(activeIndex - 1);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await deckRef.current?.requestFullscreen?.();
      return;
    }

    await document.exitFullscreen?.();
  };

  useEffect(() => {
    if (!isPlaying) return undefined;

    const timer = window.setInterval(() => {
      setActiveIndex((current) => wrapIndex(current + 1));
    }, AUTOPLAY_MS);

    return () => window.clearInterval(timer);
  }, [isPlaying]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'ArrowRight') goTo(activeIndex + 1);
      if (event.key === 'ArrowLeft') goTo(activeIndex - 1);
      if (event.key === ' ') {
        event.preventDefault();
        setIsPlaying((current) => !current);
      }
      if (event.key.toLowerCase() === 'f') toggleFullscreen();
      if (event.key === 'Escape') setShowOverview(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex]);

  // 固定设计画布(1440x760) + 等比缩放适配视口, 保证任何分辨率下内容完整不裁切
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const DESIGN_W = 1440;
    const DESIGN_H = 760;
    const update = () => {
      const rect = stage.getBoundingClientRect();
      const scale = Math.min(rect.width / DESIGN_W, rect.height / DESIGN_H);
      stage.style.setProperty(
        '--deck-scale',
        Number.isFinite(scale) && scale > 0 ? String(scale) : '1'
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(stage);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="deck" ref={deckRef} aria-label="Mobius 代码化方案演示">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">M</span>
            <div>
              <p>Mobius Presentation</p>
              <h1>从手绘草图到产品化方案</h1>
            </div>
          </div>

          <div className="toolbar" aria-label="演示控制">
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowOverview((current) => !current)}
              aria-label="切换总览"
              title="切换总览"
            >
              <Grid3X3 size={20} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => setIsPlaying((current) => !current)}
              aria-label={isPlaying ? '暂停播放' : '开始播放'}
              title={isPlaying ? '暂停播放' : '开始播放'}
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => goTo(0)}
              aria-label="回到第一页"
              title="回到第一页"
            >
              <RotateCcw size={20} />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={toggleFullscreen}
              aria-label="全屏演示"
              title="全屏演示"
            >
              <Expand size={20} />
            </button>
          </div>
        </header>

        <div className="progress-track" aria-hidden="true">
          <span style={{ width: progress }} />
        </div>

        <section className="stage-wrap" ref={stageRef}>
          <button
            type="button"
            className="nav-button nav-button-left"
            onClick={goPrev}
            aria-label="上一页"
            title="上一页"
          >
            <ChevronLeft size={28} />
          </button>

          <article className={`slide slide-${activeSlide.id}`}>
            <section className="slide-copy">
              <p className="eyebrow">{activeSlide.eyebrow}</p>
              <h2>{activeSlide.title}</h2>
              <p>{activeSlide.summary}</p>
            </section>

            <section className="slide-canvas" aria-label={activeSlide.title}>
              <ActiveSlide />
            </section>
          </article>

          <button
            type="button"
            className="nav-button nav-button-right"
            onClick={goNext}
            aria-label="下一页"
            title="下一页"
          >
            <ChevronRight size={28} />
          </button>
        </section>

        <footer className="filmstrip" aria-label="幻灯片导航">
          {slides.map((slide, index) => (
            <button
              type="button"
              key={slide.id}
              className={index === activeIndex ? 'thumb active' : 'thumb'}
              onClick={() => goTo(index)}
              aria-label={`打开第 ${index + 1} 页：${slide.title}`}
              title={slide.title}
            >
              <span className="thumb-index">{String(index + 1).padStart(2, '0')}</span>
              <span className="thumb-label">{slide.label}</span>
            </button>
          ))}
        </footer>

        <div className={showOverview ? 'overview visible' : 'overview'} aria-hidden={!showOverview}>
          <div className="overview-grid">
            {slides.map((slide, index) => (
              <button
                type="button"
                key={slide.id}
                className={index === activeIndex ? 'overview-card active' : 'overview-card'}
                onClick={() => goTo(index)}
              >
                <span className="overview-number">{String(index + 1).padStart(2, '0')}</span>
                <strong>{slide.title}</strong>
                <span>{slide.summary}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}

function IconNode({ icon: Icon, title, meta, tone = 'green', className = '' }) {
  return (
    <div className={`icon-node tone-${tone} ${className}`}>
      <span className="node-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <span>
        <strong>{title}</strong>
        {meta && <small>{meta}</small>}
      </span>
    </div>
  );
}

function Chip({ children, tone = 'neutral' }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

function FragmentPanel({ title = '原图信息碎片', items, className = '' }) {
  return (
    <aside className={`fragment-panel ${className}`}>
      <strong>{title}</strong>
      <div>
        {items.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
    </aside>
  );
}

function DetailList({ items }) {
  return (
    <div className="detail-list">
      {items.map(([title, detail]) => (
        <div className="detail-item" key={title}>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
      ))}
    </div>
  );
}

function ConnectorSvg({ children }) {
  return (
    <svg className="connector-svg" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

function ReachSlide() {
  return (
    <div className="reach-layout">
      <div className="reach-map">
        <ConnectorSvg>
          <path d="M500 280 C360 260 290 180 205 125" />
          <path d="M500 280 C385 280 290 260 170 260" />
          <path d="M500 280 C365 345 300 420 215 470" />
          <path d="M500 280 C500 370 500 430 500 495" />
          <path d="M500 280 C630 340 710 420 810 470" />
          <path d="M500 280 C625 260 710 215 825 175" />
          <path d="M500 280 C610 185 670 105 780 70" />
          <path d="M825 175 C885 210 900 250 892 305" className="soft" />
        </ConnectorSvg>

        <div className="hub">
          <span className="hub-glow" />
          <strong>Mobius</strong>
          <span>触手，无处不可达</span>
          <div className="hub-capabilities">
            <Chip tone="neutral">深度学习</Chip>
            <Chip tone="neutral">强化学习</Chip>
            <Chip tone="neutral">自动科研</Chip>
          </div>
        </div>

        <IconNode icon={HardDrive} title="云存储 / NAS / OSS" meta="SSH · SFTP" tone="blue" className="reach-nas" />
        <IconNode icon={Cloud} title="云服务器" meta="SSH" tone="cyan" className="reach-cloud" />
        <IconNode icon={Monitor} title="工作站" meta="烧录 ESP32 / 树莓派" tone="yellow" className="reach-station" />
        <IconNode icon={Cpu} title="嵌入式 Linux 设备" meta="AIMUX" tone="purple" className="reach-edge" />
        <IconNode icon={Laptop} title="员工 PC" meta="Mac / Windows / Linux" tone="green" className="reach-pc" />
        <IconNode icon={Server} title="内网 GPU 算力集群" meta="深度学习 · 强化学习" tone="red" className="reach-gpu" />
        <IconNode icon={Network} title="代理 & 代理池" meta="可选" tone="orange" className="reach-proxy" />
        <IconNode icon={Globe2} title="复杂因特网" meta="开放文献 · 开放代码 · 开放研报" tone="cyan" className="reach-web" />
      </div>

      <FragmentPanel
        className="reach-fragments"
        items={[
          '轻量云服务器',
          '云存储 NAS / OSS',
          'SSH / SFTP',
          'AIMUX',
          '工作站烧录',
          'ESP32 / 树莓派等',
          '嵌入式 Linux 设备',
          '员工 PC',
          '协助配置环境，排查问题',
          '复杂因特网',
          '开放文献',
          '开放代码',
          '开放研报',
        ]}
      />
    </div>
  );
}

function SecuritySlide() {
  return (
    <div className="security-layout">
      <div className="security-domain">
        <div className="domain-top">
          <IconNode icon={Globe2} title="外网" meta="开放访问" tone="cyan" />
          <div className="gateway">
            <Lock size={19} />
            可控代理
          </div>
        </div>

        <div className="local-boundary">
          <span className="boundary-label">内网安全域</span>
          <IconNode icon={ShieldCheck} title="Mobius 系统" meta="统一入口 · 权限审计" tone="green" />
          <IconNode icon={GitBranch} title="本地 Git & 文件" meta="版本可追踪" tone="blue" />
          <IconNode icon={Brain} title="本地大模型" meta="知识资产留存" tone="purple" />
          <IconNode icon={Terminal} title="本地运行环境" meta="无中转直连" tone="yellow" />
          <IconNode icon={Cpu} title="本地算力" meta="推理 · 训练 · 自动化" tone="red" />
        </div>

        <div className="device-row">
          <Chip tone="blue">终端</Chip>
          <Chip tone="yellow">工业设备</Chip>
          <Chip tone="green">门禁</Chip>
          <Chip tone="cyan">私有云</Chip>
          <Chip tone="purple">大模型 API</Chip>
        </div>
      </div>

      <div className="security-promises">
        {[
          ['数据不出域', '源代码、文件、模型输入输出保留在企业边界内'],
          ['安全可把控', '外部访问通过代理、权限和审计统一治理'],
          ['国产最优先', '关键组件可替换，降低供应链不确定性'],
          ['数据可回收', '任务过程、经验、结果沉淀为可复用资产'],
        ].map(([title, detail]) => (
          <div className="promise" key={title}>
            <ShieldCheck size={22} />
            <div>
              <strong>{title}</strong>
              <span>{detail}</span>
            </div>
          </div>
        ))}
        <FragmentPanel
          title="手稿保留词"
          items={[
            '外网',
            '可控代理',
            '内网',
            '本地 Git & 文件',
            '本地大模型',
            '本地算力',
            '本地运行环境',
            '无中转直连',
            '微信',
            '火山引擎',
            '阿里云',
          ]}
        />
      </div>
    </div>
  );
}

function AssistantSlide() {
  const spokes = [
    ['项目管理', Code2],
    ['修改代码', GitBranch],
    ['图形迭代', Zap],
    ['智能任务监测', Activity],
    ['长程规划', Target],
    ['语音输入输出', FileText],
    ['终端支持 Web/iOS/Android', Terminal],
    ['远程协同', Users],
  ];

  return (
    <div className="assistant-layout">
      <section className="report-side">
        <div className="query-bubble">
          <Bell size={22} />
          <strong>小莫小莫，上午的 2 个项目和 19 个任务进展汇报！</strong>
        </div>

        <div className="report-panel">
          <div className="report-head">
            <span>管理员权限</span>
            <strong>查询动态</strong>
          </div>
          <div className="report-line">
            <span>项目 Alpha</span>
            <strong>7 个任务</strong>
            <em>员工 Alice、Charlie 共计提交 7 个任务，1 项进行中，6 项已完成。</em>
          </div>
          <div className="report-line">
            <span>项目 Beta</span>
            <strong>15 个任务</strong>
            <em>员工 Bob、Finka 已提交 15 个任务，2 项自动研究；其中 13/15 已完成。</em>
          </div>
          <div className="report-alert">
            <Bell size={18} />
            <span>2 项任务涉及发布对外，正等待人工确认，是否提醒员工？</span>
          </div>
        </div>
      </section>

      <section className="assistant-hub">
        <div className="assistant-center">
          <Brain size={34} />
          <strong>小莫</strong>
          <span>管理智能体</span>
        </div>
        {spokes.map(([label, Icon], index) => (
          <div className={`spoke spoke-${index + 1}`} key={label}>
            <Icon size={18} />
            {label}
          </div>
        ))}
      </section>
      <FragmentPanel
        className="assistant-fragments"
        title="小莫能力边界"
        items={[
          '以管理员权限查询动态',
          '项目管理',
          '修改代码',
          '图形迭代',
          '智能任务监测',
          '终端支持 Web/iOS/Android',
          '长程规划',
          '语音输入输出',
          '远程协同',
        ]}
      />
    </div>
  );
}

function ManagerSlide() {
  return (
    <div className="manager-layout">
      <div className="manager-transition">
        <div className="manager-target">成为一人之军</div>
        <div className="manager-target">
          <span>作为管理者</span>
          <strong>成为 AI 时代的团队管理者</strong>
          <p>高效协同团队与 Agent 团队，最大化员工与自动化系统的产出效率。</p>
        </div>
      </div>

      <div className="chart-grid">
        <div className="chart-panel">
          <div className="chart-title">
            <strong>Token 消耗趋势</strong>
            <span>识别员工是否在偷懒或低效使用模型</span>
          </div>
          <svg className="line-chart" viewBox="0 0 520 250" aria-label="Token 消耗趋势图">
            <path className="axis" d="M55 25 V205 H488" />
            <path className="curve curve-a" d="M75 175 C150 80 240 85 300 120 C360 150 415 78 470 45" />
            <path className="curve curve-b" d="M75 190 C140 185 205 120 270 132 C330 146 400 118 470 98" />
            <circle cx="300" cy="120" r="5" />
            <circle cx="270" cy="132" r="5" />
            <text x="78" y="48">员工 A</text>
            <text x="96" y="222">第1周</text>
            <text x="235" y="222">第2周</text>
            <text x="375" y="222">第3周</text>
            <text x="12" y="42">Token</text>
          </svg>
        </div>

        <div className="chart-panel">
          <div className="chart-title">
            <strong>AI 熟练度评估</strong>
            <span>用数据指导培训、分工与晋升</span>
          </div>
          <div className="bar-chart" aria-label="员工 AI 熟练度柱状图">
            {[
              ['Bob', 88],
              ['Neo', 62],
              ['Alice', 28],
              ['Bernard', 74],
              ['Fairy', 96],
            ].map(([name, value]) => (
              <div className="bar-item" key={name}>
                <span style={{ height: `${value}%` }} />
                <strong>{name}</strong>
              </div>
            ))}
          </div>
        </div>
      </div>
      <DetailList
        items={[
          ['管理命题', '公司是 AI 时代的伪命题，但管理者要学会管理员工团队和 Agent 团队。'],
          ['判断标准', '通过多维数据评价员工驾驭 AI 的熟练程度，方便管理者针对性展开培训。'],
        ]}
      />
    </div>
  );
}

function ArchitectureSlide() {
  const execution = ['Codex GPT', 'Claude Code CLI', 'Claude Code Opus', 'Agent 编排网络'];
  const research = [
    '普通开发 01',
    '前后端联调 02',
    '拓展插件开发 03',
    '论文复现研究',
    '股市调查 02',
    'GPU 长程训练任务',
  ];
  const subsystems = [
    '任务分发子系统',
    '智能唤醒',
    'Goal 自驱',
    '进度回溯',
    '垃圾回收子系统',
    '版本子系统',
    '群智协作子系统',
    '自进化容错子系统',
    '拓展插件子系统',
    '假设沉淀 & 复用子系统',
  ];

  return (
    <div className="architecture-layout">
      <section className="layer layer-exec">
        <div className="layer-label">任务执行层</div>
        <div className="layer-content exec-grid">
          {execution.map((item) => (
            <Chip tone="cyan" key={item}>{item}</Chip>
          ))}
          <div className="agent-net">
            <Users size={24} />
            <span>多 Agent 协同</span>
          </div>
          <Chip tone="yellow">智能提醒</Chip>
          <Chip tone="green">Goal 自驱</Chip>
          <Chip tone="blue">进度回溯</Chip>
          <Chip tone="purple">智能体策略系统</Chip>
          <Chip tone="orange">垃圾回收子系统</Chip>
        </div>
      </section>

      <section className="layer layer-research">
        <div className="layer-label">普通任务 & 研发任务层</div>
        <div className="task-board">
          {research.map((item) => (
            <div className="task-row" key={item}>
              <span />
              {item}
            </div>
          ))}
        </div>
        <div className="subsystem-cloud">
          {subsystems.map((item) => (
            <Chip tone="neutral" key={item}>{item}</Chip>
          ))}
        </div>
      </section>

      <section className="layer layer-user">
        <div className="layer-label">项目 & 用户层</div>
        <div className="project-stack">
          {['前端网页', '后端服务台', '算法实验', '办公写作', 'Mobius 固化', '嵌入式研发'].map((item) => (
            <IconNode icon={Package} title={item} tone="blue" key={item} />
          ))}
        </div>
        <div className="mobius-stack">
          <strong>Mobius 固化能力</strong>
          <span>嵌入式研发 · 基础库研发 · 论文复现 · 远程仓库本地部署 · 项目 Skill · Memory</span>
        </div>
        <div className="admin-stack">
          <IconNode icon={Users} title="超级管理员" meta="小莫 · 超级秘书" tone="green" />
          <IconNode icon={Brain} title="员工资产" meta="Skill · Memory · 模型 · 超级秘书" tone="purple" />
        </div>
      </section>
    </div>
  );
}

function LoopSlide() {
  const environments = [
    ['用户工作 PC', Monitor],
    ['用户移动终端（安卓 / iOS）', Smartphone],
    ['高性能 GPU 算力集群', Cpu],
    ['代码版本控制系统', GitBranch],
    ['嵌入式硬件（如 NX / 树莓派）', Terminal],
    ['智能网络硬件（如 NAS）', HardDrive],
    ['云端分布式服务器（如 ECS）', Cloud],
    ['轻量调用器', Server],
  ];

  return (
    <div className="loop-layout">
      <section className="loop-market">
        <div className="orbit">
          <div className="orbit-center">
            <Package size={34} />
            <strong>Mobius 插件市场</strong>
          </div>
          {['下载', '新建', '优化前端', '优化后端', '自动进化系统', '反馈意见'].map((item, index) => (
            <span className={`orbit-node orbit-${index + 1}`} key={item}>{item}</span>
          ))}
        </div>
        <div className="learning-strip">
          <Brain size={21} />
          Mobius 自我学习进化：论文、用户反馈、项目经验持续回流
        </div>
      </section>

      <section className="production-side">
        <div className="iteration-loop">
          <Chip tone="green">开发者迭代环</Chip>
          <Chip tone="yellow">用户迭代环</Chip>
          <Chip tone="blue">莫比乌斯环</Chip>
        </div>

        <div className="prod-core">
          <IconNode icon={Zap} title="Mobius 生产力环境" meta="发布 · 部署 · 普通用户" tone="green" />
        </div>

        <div className="environment-grid">
          {environments.map(([label, Icon]) => (
            <IconNode icon={Icon} title={label} tone="neutral" key={label} />
          ))}
        </div>

        <div className="project-row">
          <Chip tone="cyan">托管项目</Chip>
          <Chip tone="green">Agent 集群开发子系统</Chip>
          <Chip tone="yellow">自动研发课题子系统</Chip>
          <Chip tone="purple">Command & Target</Chip>
          <Chip tone="blue">交互式规划</Chip>
          <Chip tone="orange">高可控经验复用</Chip>
        </div>
      </section>
      <FragmentPanel
        className="loop-fragments"
        title="生产力环境覆盖"
        items={[
          '开发者迭代环',
          '用户迭代环',
          '莫比乌斯环',
          '发布 & 部署',
          '普通用户',
          '用户工作 PC',
          '用户移动终端',
          '高性能 GPU 算力集群',
          '代码版本控制系统 Git',
          '嵌入式硬件',
          '智能网络硬件 NAS',
          '云端分布式服务器 ECS',
          '提醒服务',
          '远集体协作',
          '强任务分工',
          '长周期，精细反馈',
        ]}
      />
    </div>
  );
}

export default App;
