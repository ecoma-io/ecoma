---
title: "Ecoma — 设计终态"
status: design-end-state
canonical-sha: 49526f6e6437
---

# Ecoma — 设计终态

本文档树描述的是 Ecoma **被设计成为**的系统，而不是今天已经存在的系统。它是一道
**天花板**：每一次交付切分都可以收窄价值或策略，但没有一次可以违反这里写下的机制。
当路线图与本树对某个事物**是什么**产生分歧时，以本树为准；当二者对它**何时到来**
产生分歧时，以路线图为准。

这里没有任何内容是实现进度报告。这些文档中的一条陈述，是关于系统建成之后将如何运行
的承诺——正因如此，它可以在任何一行代码依赖它之前被反驳。

## 这个系统是什么

**Ecoma 是一个 fair-code、可自托管的劳动操作系统：人、AI 与规则/代码是同一类劳动资
源（Role/Filler）；流程——无论确定性的还是推理型的——都由人与 AI 在引擎本身之上共同设
计；每一份产出都有一条通过检查点的路径，其置信度按每个租户自己的数据校准；而人的注意
力是一种被度量、被优化的资源。**

## 文档树如何组织

三个纵向 domain，各有一份 North Star 拥有自己的词汇：

| Domain                                | 拥有什么                                            |
| ------------------------------------- | --------------------------------------------------- |
| [Platform](../north-star/platform.md) | 劳动协调——各 primitive、composition，以及共享子系统 |
| [RPA](../north-star/rpa.md)           | 在系统无法控制的环境中执行                          |
| [Hub](../north-star/hub.md)           | 静态内容分发：registry、index、marketplace          |

两个横向层横切这三者，而不是与它们并列。**Enterprise** 是一个 license 层：插入引擎所
声明的 extension point 的模块，永远不是一个 fork。**Cloud** 是一种运营形态：同一份构
建以大于一的 tenant cardinality 运行，外加一个不随产品发布的运营方控制平面。

三者之间的边界是刻意收窄的，而这份"窄"正是关键：

- Platform 只通过两个运行时接口触达 RPA —— 一个 Filler 和一个 Session effect。任何
  别的通路都会把 selector、vision 和 driver 的关切塞进协调引擎内部，那样换一个浏览器
  就等于换一条 workflow。
- 所有各方都通过同一个客户端接口触达 Hub：`resolve` / `pull` / `verify`。**Hub 永不
  触碰运行时。** 把它拔掉，一切已安装的东西照样永久运行——这正是一个分发渠道值得被依
  赖的原因。

## 阅读顺序

本树不按字母排序，按文件顺序读也读不通。以下顺序保证每份文档的前提都已具备：

1. **[Platform North Star](../north-star/platform.md)** —— 四条机制原则与五条
   invariant 的 canonical 出处。其他所有文档都引用它们，没有一份重述它们。
2. **[Composition](../spec/composition.md)** —— 各 primitive 如何装配成一个
   Process，以及 Platform/RPA 的边界落在哪里。
3. **各 primitive**，按依赖顺序：[Role](../spec/role.md) →
   [Task](../spec/task.md) → [Checkpoint](../spec/checkpoint.md) →
   [Handoff](../spec/handoff.md) → [Escalation](../spec/escalation.md)。
4. **入口与出口**：[Trigger & Channel](../spec/trigger-channel.md)。
5. **其他一切机制赖以站立的一层子系统**：[Event Log](../spec/event-log.md)、
   [Artifact Store](../spec/artifact-store.md)、[Vault & Key](../spec/vault-key.md)、
   [Tenant & Identity](../spec/tenant-identity.md)。
6. **可选模块与 projection**：[Knowledge](../spec/knowledge.md)、
   [Memory](../spec/memory.md)、[Working Data](../spec/working-data.md)、
   [Calibration](../spec/calibration.md)、[Human Surface](../spec/human-surface.md)。
7. **横切机制**：[Release & Compatibility](../spec/release-compat.md)、
   [Test Harness](../spec/test-harness.md)。
8. **[RPA North Star](../north-star/rpa.md)**，然后是它的各份 spec：
   [Action](../spec/rpa-action.md) → [Session](../spec/rpa-session.md) →
   [Driver & Perception](../spec/rpa-driver-perception.md) →
   [Self-healing](../spec/rpa-self-healing.md) →
   [Sandbox & Credential](../spec/rpa-sandbox-credential.md)。
9. **[Hub North Star](../north-star/hub.md)**，然后是 [Block](../spec/block.md)。

在天花板之外，且是刻意如此的：[路线图](../method/roadmap.md)（建造顺序——唯一被允许
点名各 phase 的文档）、[评审 rubric](../method/review-rubric.md) 与
[场景目录](../method/scenario-catalog.md)（用来评审本树本身的工具）、
[ADR 账本](../method/adr-ledger.md)（实现决策），以及
[部署章程](../charter/deploy.md)（运营方如何运行它）。

## 术语表——一个概念，一个名字

一个概念多出第二个名字，就多出第二个定义，而这两个定义会在有人只改其中一边的那一刻起
开始漂移。以下就是这些名字。

**劳动。** _Role_ —— 一个劳动位置，由能力定义，而不由谁来填充定义。_Filler_ ——
正在填充某个 Role 的人、agent、规则或流程。_Task_ —— 工作的一个实例；_Attempt_ ——
一次尝试，作为一等公民存在，使得重试必然携带引发它的反馈。

**判定。** _Checkpoint_ 拆成刻意不合并的三样东西：一个 _Gate_（阻断点）、一个
_Judgment_（带签名的裁决，append-only），以及一个 _Criterion_（归租户所有的库实体）。

**步骤之间的移动。** _Handoff_ —— 交接本身。_Contract_ —— 对接收步骤的承诺。
_Artifact_ —— 不可变、内容寻址。_Envelope_ —— 已累积的上下文，以 projection 形式交
付。_Effect_ —— reversible、compensable 或 irreversible，并携带一个 serialization
key。_Escalation_ —— 一个开放的分类体系，强制要求终端处理者，使得没有任何路径以沉默
收场。

**分发。** _Block_ —— 打包与分发的单位。_Template_ —— 为某个垂直领域策展过的 Block。

**Knowledge 与 Memory，二者并非同一件事。** _Collection_ / _Chunk_ / _Curator_ 属于
Knowledge。_Memory entry_ / _Subject_ / _Party_ 属于 Memory。_Calibration_ 讲的是
**从事劳动的一方**；_Memory_ 讲的是**被服务的一方**。把二者合并，会让一次换模型抹掉
组织对某位客户的全部记忆。

**数据。** _DataTable_ —— 可写的 projection。_Lease_ —— 唯一的加锁 primitive，TTL 强
制。_Projection_ —— 由 Event Log 派生的任何视图，始终可重建。_Classification
lattice_ 与 _leakage gate_ 管辖什么被允许流出。

**身份。** _Principal_ —— user、agent、rule、node 或 external。_Tenant_ —— 一道硬边
界。_Workspace_ —— 用于管理与展示的软隔断，**不是**安全边界：同一个租户密钥、同一个
日志命名空间、允许去重。_Party_ —— memory 的一个主体，可经由 Gate 合并。

**Calibration。** _CalKey_ 与 _Cell_ —— 一个 calibration projection 的键与格。
_Estimator identity_ —— 估算方法自身的 `method@version`，使得换一次估算器是看得见
的，而不是悄无声息的。

**RPA。** _Node_ —— 一台 RPA 宿主机。_Session_ —— 针对某个环境的一次运行。_Scene_
—— 该环境的三层、内容寻址、已脱敏的快照。_Evidence_ —— 某个 Action 前后 Scene 的哈
希。_Commit point_ —— 已经执行的第一个不可逆动作，也就是任何回退的边界。_Macro_ ——
一串具名且带版本的 Action。_App Profile_ —— 按应用划分的知识：reversibility 分级与稳
定的 locator。_Sub-actor_ —— 某个 Filler _内部_ 的执行者（脚本、agent、人、工具调
用）；不是一个 Task。

**测试。** _Test run scope_ —— 在真实租户内部、带 `run_kind: test` 标签的一次运行，
靠 projection 过滤而不是靠一个独立租户来隔离。_`environment: production | test`_ ——
Filler identity 的一个维度，不是第五个信任层级。_Mock filler_ —— 一个真实的 Filler，
`mock:<name>@version`，经由正规的 Filler 接口调用。_Fixture_ —— 带 id、version 与
lineage 的种子数据。_Assertion artifact_ —— 一条声明式、带版本、在日志上度量的断言。
_Conformance suite_ —— 同一套 harness 机制，只是主体换成某个接口的一份
_implementation_。_`supports_dry_run`_ —— adapter 的一项能力；不支持的 adapter 会把
`dry_run` contract 解析为 `forbidden`，而不是假装支持。

**密钥。** _Rotate ≠ Shred_ —— 轮换密钥不做重加密；销毁一把密钥是永久抹除。_Vault_
分成两个不得合并的含义：_credential vault_（运维密钥）与 _PII vault backend_（数据主
体密钥，一个 Enterprise extension point）。_只向前的副本_ —— 密钥材料唯一合法的副本
类别，因为一条 `destroy` 必须能复制到它；密钥材料的时间点快照被禁止。

**发布。** _Release train `X.Y.Z`_ —— **workspace** 的版本轴，而不是某个 app 的。
_Protocol version_ —— 每个 protocol 各自独立的单调整数。_回滚窗口_ —— 越出它，该操作
就不再是回滚，而是恢复加重放。_Support window_ —— 当前 major 加它之前的一个 major；
备份保留期不得超过它。

**存储。** _Reference backend ≠ 安装默认值_ —— Postgres 是 contract suite 据以验证的
那一个；某次具体安装实际运行什么，取决于它的部署形态（见
[ADR-0002](../method/adr-ledger.md)）。_Small-stack_ —— SQLite、DuckDB 与
sqlite-vec，用于单二进制与单容器形态。

**界面与授权。** _Work Item_ / _Action Item_ —— Human Surface 的对象模型。
_`run_kind: production | test`_ —— 日志条目上的一个标签；每个 projection 都必须声明
自己在这个标签上的立场。_`<area>/enterprise/`_ —— Enterprise License 目录，标签为
`license:ee`；`ee` 可以 import `sul`，而 `sul` 永远不可以 import `ee`。
_Single-tenant self-host_ —— 由一道**产品边界**限定（创建租户的 workflow 只随运营方
控制平面发布），永远不靠 license 校验。

## 冲突如何裁决

两条规则，都是因为一套没有裁决规则的文档，最终会按"谁最后改的"来解决冲突：

- **陈述冲突时的优先级**：invariant，其次是 canonical 原则，再次是 domain 原则，最后
  是 template。各 invariant 与各 canonical 原则住在
  [Platform North Star](../north-star/platform.md)；其他所有文档只引用而不重述，因此
  只有一处文本需要修改。
- **一个新概念必须说明它是_什么_的概念**：哪个机制的 entity、policy 还是 template。
  答不上来的概念，是一个正在寻找机制的名字，而后来它会被随手安上一个。
