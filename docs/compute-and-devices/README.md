# From GPU Clusters to NX Dev Boards, the Neural Center’s Tentacles Reach Everywhere

Mobius not only schedules browsers and terminals, it can also bring GPU clusters, NX dev boards, NAS / OSS, cloud servers, and employee workstations into the same task network. Through SSH / SFTP, AIMUX, and controllable proxies, XiaoMo can remotely configure environments, dispatch experiments, and collect logs and artifacts, turning compute, devices, and data into tentacles that Agents can invoke. Whether the task happens in a cloud datacenter or on an edge dev board, it can be uniformly perceived, orchestrated, and reviewed.

```mermaid
flowchart TD
  M["Mobius<br/>(XiaoMo)"]

  subgraph P["Reach Protocols and Channels"]
    SSH["SSH / SFTP"]
    AIMUX["AIMUX"]
    PROXY["Controllable Proxy"]
  end

  subgraph R["Remote and Local Resources"]
    GPU["GPU Compute Cluster<br/>Training / Inference / Experiments"]
    NX["NX and Other Embedded Boards<br/>Edge Deployment / Device Debugging"]
    NAS["NAS / OSS / Cloud Storage<br/>Data and Artifact Archive"]
    CLOUD["Cloud Servers<br/>Task Execution / Service Deployment"]
    PC["Employee Workstations<br/>Mac / Windows / Linux"]
    NET["Complex Internet<br/>Open Literature / Open Code / Open Research Reports"]
  end

  M --> SSH
  M --> AIMUX
  M --> PROXY

  SSH --> GPU
  SSH --> NAS
  SSH --> CLOUD
  AIMUX --> NX
  AIMUX --> PC
  PROXY --> NET
```

Inside project memory, detect and manage compute resources:

- Connect ordinary SSH resources, including cloud servers, lightweight application servers, NAS, and GPU clusters
- One-click connect your personal PC, without conditional network restrictions, as long as it can run Python, whether Windows or macOS
- One-click connect embedded dev boards, such as drones and unmanned vehicles equipped with NX and other embedded devices

<p align="center">
  <img src="https://github.com/user-attachments/assets/47de5fcd-426a-43e5-b9ec-df83e28cf7aa" width="700" alt="Mobius compute resource management" />
</p>

[Back to README](../../README.md)
