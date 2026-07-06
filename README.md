<p align="right">
  <a href="./README.md"><strong>English</strong></a>
  ·
  <a href="./README.zh.md"><strong>简体中文</strong></a>
</p>

<div align="center">

# <img src="./assets/mobius-logo.svg" alt="" height="42" valign="middle" /> Mobius

<h3>
Open-source self-evolving productivity system<br />
One system to connect your team, AI agents, devices, and compute power
</h3>

<p align="center">
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="TypeScript 54.8%" src="https://img.shields.io/badge/TypeScript-54.8%25-3178c6?logo=typescript&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="JavaScript 24.5%" src="https://img.shields.io/badge/JavaScript-24.5%25-f7df1e?logo=javascript&amp;logoColor=111111" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="CSS 10.9%" src="https://img.shields.io/badge/CSS-10.9%25-663399?logo=css&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="HTML 7.9%" src="https://img.shields.io/badge/HTML-7.9%25-e34f26?logo=html5&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="Python 1.6%" src="https://img.shields.io/badge/Python-1.6%25-3776ab?logo=python&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="Shell 0.4%" src="https://img.shields.io/badge/Shell-0.4%25-4eaa25?logo=gnubash&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="Dockerfile 0.05%" src="https://img.shields.io/badge/Dockerfile-0.05%25-2496ed?logo=docker&amp;logoColor=white" /></a>
  <a href="https://github.com/nutshellai-tech/mobius/blob/main/LICENSE"><img alt="Custom source-available non-commercial license" src="https://img.shields.io/badge/license-source--available%20%2F%20non--commercial-orange" /></a>
  <a href="https://github.com/nutshellai-tech/mobius/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/nutshellai-tech/mobius.svg" /></a>
  <a href="https://github.com/nutshellai-tech/mobius/forks"><img alt="Forks" src="https://img.shields.io/github/forks/nutshellai-tech/mobius.svg" /></a>
  <a href="https://github.com/nutshellai-tech/mobius"><img alt="Status" src="https://img.shields.io/badge/status-evolving-orange.svg" /></a>
</p>

<p align="center">
  <a href="https://mobius.nutshellai.cn/"><strong>Website</strong></a>
  ·
  <a href="https://nutshellai-tech.github.io/mobius/"><strong>Docs</strong></a>
</p>

</div>

<p align="center">
  <img src="./assets/github-cover-v1.png" alt="Mobius GitHub cover" width="100%" />
</p>

---

> **Trying to build a once-and-for-all perfect AI system is like trying to find the end of a Möbius strip — ultimately futile.**
>
> Mobius is the world's first **self-evolving** open-source Agent OS. Not a fixed toolbox — a growing productivity system you build your own Agent OS on, connecting projects, teams, models, devices, compute, and apps into one traceable workspace.

---

## Self-Evolving — The Ship of Theseus

Give Mobius a **change request**, a **screenshot**, or a **reference link** — it turns them into real code, UI, plugins, or workflow updates without disrupting your work. Every interaction replaces a plank on this Ship of Theseus, quietly in the background.

<video controls src="https://mobius.nutshellai.cn/assets/v1/self-evolution.mp4" title="Self-evolution demo"></video>

[More self-evolution examples](https://nutshellai-tech.github.io/mobius/self-evo-demo/)

---

## Auto Research with Multi-Agent Pipeline

Mobius orchestrates multiple agents into an autonomous research network — reading papers, extracting methods, reproducing experiments, and summarizing results. A research goal becomes a multi-agent pipeline, not just a Q&A.

<p align="center">
  <img src="https://github.com/user-attachments/assets/33490ea7-c559-4d9c-a4fc-aff18a645066" width="700" alt="Multi-agent research network" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/a767ba7c-43f7-49c7-9e83-83f8708c05d1" width="700" alt="Research progress tracking" />
</p>

<p align="center">
  <video controls src="https://github.com/user-attachments/assets/0580bbc1-3998-4a85-8fa1-189b46637289" width="700" title="Auto Research demo"></video>
</p>

---

## XiaoMo — AI Hub You Can Just Talk To

XiaoMo turns a complex agent system into a natural-language **interface**. Just talk to it: create projects, split tasks, launch agents, track progress. Anything clickable XiaoMo can do; things the frontend can't do, XiaoMo handles too. Voice input, multi-device (Web/PC/Mobile), configurable reminders.

<p align="center">
  <img src="https://github.com/user-attachments/assets/acff28ef-c117-487a-a904-baf79392ad3a" width="700" alt="XiaoMo interface" />
</p>

<p align="center">
  <video controls src="https://github.com/user-attachments/assets/f7a45ceb-b208-4d22-a77b-ff11c05ef497" width="700" title="XiaoMo demo"></video>
</p>

↑ This demo video was itself produced by XiaoMo — zero human participation in the recording.

---

## Any Model, Any Agent

Mobius is not locked into any single model. GPT, Claude, **GLM-5.2**, Codex — all can serve as execution engines inside the same project. Choose by task type, cost, and performance.

<p align="center">
  <img src="https://github.com/user-attachments/assets/38f615b4-58bd-42b1-9b32-b6deadb6436e" width="700" alt="Model selection" />
</p>

---

## Connect Everything: GPU Clusters to Embedded Devices

Mobius schedules browsers and terminals — and beyond. GPU clusters, embedded boards, cloud servers, workstations all join the same task network through SSH, AIMUX, and controllable proxies.

```mermaid
flowchart TD
  M["Mobius (XiaoMo)"]

  subgraph P["Reach Protocols"]
    SSH["SSH / SFTP"]
    AIMUX["AIMUX"]
    PROXY["Controllable Proxy"]
  end

  subgraph R["Remote & Local Resources"]
    GPU["GPU Compute Cluster"]
    NX["Embedded Boards (NX, etc.)"]
    NAS["NAS / OSS / Cloud Storage"]
    CLOUD["Cloud Servers"]
    PC["Workstations (Mac/Win/Linux)"]
    NET["Web / Open Literature"]
  end

  M --> SSH & AIMUX & PROXY
  SSH --> GPU & NAS & CLOUD
  AIMUX --> NX & PC
  PROXY --> NET
```

<p align="center">
  <img src="https://github.com/user-attachments/assets/47de5fcd-426a-43e5-b9ec-df83e28cf7aa" width="700" alt="Compute resource management" />
</p>

---

## Team Collaboration

Human members, AI agents, tasks, and deliverables in one view. Leads see who does what, where agents stand, what needs confirmation, where risks exist — no more fragmented communication.

<p align="center">
  <img src="https://github.com/user-attachments/assets/1a615cce-8c31-4f4f-8f04-da19c7f9b50e" width="700" alt="Team collaboration" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/d96260b3-fd79-4ac7-b005-ee39ec021fcd" width="700" alt="Project management" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/6c90b3a0-6c73-4065-a87e-a12a546aa327" width="700" alt="Task tracking" />
</p>

---

## Self-Incubating Extensions

Mobius ships with built-in extensions and can incubate new ones from your needs — financial news walls, PPT generators, research workbenches, World Cup portals. All generated with frontend, backend, data directory, and invocation entry, ready to keep evolving.

<table>
  <tr>
    <td width="50%">
      <strong>Immersive Web Experiences</strong><br />
      <sub>Turn visual ideas into runnable extension apps.</sub><br />
      <img src="./assets/extension-matrix-rounded.png" alt="Matrix-style extension screenshot" />
    </td>
    <td width="50%">
      <strong>Financial News Wall</strong><br />
      <sub>Track live market narratives and source-driven updates.</sub><br />
      <img src="./assets/extension-finance-news-wall-rounded.png" alt="Financial news wall extension screenshot" />
    </td>
  </tr>
  <tr>
    <td width="50%">
      <strong>World Cup Portal</strong><br />
      <sub>Build data-rich sports portals with schedules, news, players, and venues.</sub><br />
      <img src="./assets/extension-world-cup-rounded.png" alt="World Cup extension screenshot" />
    </td>
    <td width="50%">
      <strong>PPT Maker</strong><br />
      <sub>Generate structured presentation assets from topics and materials.</sub><br />
      <img src="./assets/extension-ppt-maker-rounded.png" alt="PPT maker extension screenshot" />
    </td>
  </tr>
</table>

---

## Quick Start

Full deployment instructions at <a href="https://nutshellai-tech.github.io/mobius/">Docs</a>.

### Option 1: Containers (recommended)

```bash
git clone https://github.com/nutshellai-tech/mobius.git && cd mobius
python3 conf_prepare.py --docker && python3 conf_check.py --docker
docker build -t mobius-system-base:latest -f deploy/Dockerfile .
docker build -t mobius-system-exe:latest .
docker compose up
```

### Option 2: Direct (Linux / macOS)

```bash
sudo apt install tmux python3 git curl proxychains openssh-server build-essential
npm install -g @anthropic-ai/claude-code @openai/codex
git clone https://github.com/nutshellai-tech/mobius.git && cd mobius
python3 conf_prepare.py && python3 conf_check.py
cd ./mobius && npm install && cd ./frontend && npm install && cd ../..
python3 start.py
```

---

## Roadmap

- **v0.1** — Agent OS foundation: projects, issues, sessions, model integrations, agent execution, task management
- **v0.2** — Team collaboration: multi-user projects, permissions, task status, agent tracking, usage analytics
- **v0.3** — Self-evolution & extensions: plugin incubation, knowledge accumulation, feedback-driven iteration
- **v0.4** — XiaoMo & multi-agent: natural-language interface, task decomposition, sub-agent collaboration, progress summaries
- **v0.5** — Unify users, AI, devices, compute: remote compute, device access, robot/terminal integration, research pipelines

### Contribution

Issues, plugins, docs, bugs, use cases — all welcome. If you believe AI systems should evolve instead of being preset tools, join us.

<p align="center">
  <a href="https://github.com/nutshellai-tech/mobius">GitHub</a>
  ·
  <a href="https://mobius.nutshellai.cn/">Website</a>
  ·
  <a href="https://nutshellai-tech.github.io/mobius/">Docs</a>
</p>
