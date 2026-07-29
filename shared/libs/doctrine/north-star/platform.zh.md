---
title: "Ecoma Platform — North Star"
status: design-end-state
canonical-sha: ae07f5d19a86
---

# Ecoma Platform — North Star

本文档是四条机制原则与五条 invariant 的 canonical 出处。文档树中其他所有文档都引用它
们，没有一份重述它们。当两处文本发生分歧时，以本文档为准。

它描述的是一道天花板，而不是首个版本。一次交付切分可以收窄价值或策略；它不可以违反这
里写下的任何机制。

## 终态

**Ecoma 是一个 fair-code、可自托管的劳动操作系统：人、AI 与规则/代码是同一类劳动资源
（Role/Filler）；流程——无论确定性的还是推理型的——都由人与 AI 在引擎本身之上共同设计；
每一份产出都有一条通过检查点的路径，其置信度按每个租户自己的数据校准；而人的注意力是
一种被度量、被优化的资源。**

它以一个 monorepo、三个彼此分离的 domain 构建：**Platform**（劳动协调——本文档）、
**[RPA](rpa.md)**（在系统无法控制的环境中执行），以及 **[Hub](hub.md)**（静态内容分
发：registry、index、marketplace）。Platform 只通过两个运行时接口消费 RPA —— 一个
Filler 和一个 Session effect。Platform 与 RPA 都通过同一个客户端接口与 Hub 通话：
`resolve` / `pull` / `verify`。**Hub 永不触碰运行时**：把它拔掉，一切已安装的东西照样
永久运行。

## 问题所在，以及现有系统为何解不了

痛点不是自动化不够。痛点是**两支劳动力从未被统一**。AI 在放大产出的同一个动作里制造出
验证瓶颈——每一份产出都需要审核，而队列最终堆在人的注意力上。人与人之间，上下文留在某
个人的脑子里。步骤与步骤之间，没有任何 contract。而且没有任何系统允许一个人和一个 AI
换进同一个位置。

每一个现有系统都**从某一门手艺出发**，再把另一半当作附件焊上去：集成平台出自 iPaaS，
机器人自动化出自屏幕抓取，BPMN 引擎出自一份禁止未预先声明的分支、没有像样的补偿机制、
并把 escalation 当作异常的规范。BPMN 在它自己的立身承诺上失败了——业务画得出、机器跑
得动——尽管它大约五分之一的元素就已经覆盖了绝大多数真实流程。

Ecoma 改从原始假设重新出发：**一类劳动资源，一小组 primitive，绝对对称。**

**为什么增长不会逼出一次重写。** 单人经营者会立刻感受到协调之痛——产出翻三倍，瓶颈挪
到验证上——然而没有公司永远停在一个人，也没有客户会拒绝成长。答案是机制性的：**从一个
人到 N 个人，用的是同一组 primitive。** 在一个人时，Checkpoint 承担主要重量，优化当时
唯一那位审核者的注意力。当人数增长，Handoff 承担主要重量——contract、归属，以及活在任
何人脑子之外的上下文。新招来的人是一个 Filler，进入一个已经存在的 Role，并且可以以
shadow 方式运行、从记录中学会这份工作。增长是一个结果，而系统早已为它成形。

## 四条机制原则

**这是 canonical 文本。** 各份 spec 引用它，永不复制它。

1. **引擎在人、AI 与规则/代码之间绝对对称。** 不对称只允许存在于 policy 与 template
   层。
2. **任何需要积累学习的东西都是拥有稳定身份的一等实体——而这个身份带有 lineage。**
   calibration 带衰减地继承，因此让一个 filler 演进永远不会重置它的飞轮。
3. **引擎强制参数存在；template 强制参数的取值。**
4. **复杂度是用户的选择权**：机制是完整的，默认值是极简的（通过 tenant → template →
   process → role → task 的 cascade），一切进阶都是 opt-in。

## 五条 invariant

1. 人与 AI 填充同一类 Role。换 Filler 不改 flow。
2. 每一份产出都有一条通过 Checkpoint 的路径，没有任何动作是无痕的——包括 override，它
   是一个带签名的 Judgment，而不是一条绕过 Checkpoint 的路。
3. 人的注意力是被度量、被优化的资源：triage、抽样、风暴抑制、优先级队列。
4. 学习数据属于租户。**不存在跨租户学习。** 冷启动改由共享的 Criterion 与 Contract
   库、身份 lineage，以及 template 先验来回答。
5. 流程状态是 durable 的，独立于任何人的记忆而存活。不存在沉默的卡死——终端 escalation
   处理者是强制的——也永远不会因为超时或僵局而自动放行。

## 各 primitive，以及它们之上的 composition 层

| Spec                                                 | 它拥有的机制                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Role](../spec/role.md)                              | 一个与填充者分离的能力槽位。calibration 以 role、filler、task type 与 criterion 为键。双向 shadow 模式。信任层级双向自动升降                            |
| [Task](../spec/task.md)                              | 工作的一个实例，Attempt 是一等公民，可 durable 数周。**Dynamic spawning** 是确定性图与推理图相遇之处：一个 agent 可以创建一个指派给人的 task            |
| [Checkpoint](../spec/checkpoint.md)                  | 一个阻断的 Gate，与一个 append-only 的 Judgment 分离。Criterion 是租户的库实体。三层置信度，按租户校准                                                  |
| [Handoff](../spec/handoff.md)                        | 三层 contract —— schema、语义、上下文。一个自我累积的 Envelope，以 projection 形式交付。带三种 reversibility 分级的 Effect。补偿是某个 Role 的一个 Task |
| [Escalation](../spec/escalation.md)                  | 一等公民：一次 escalation 就是一个 Task，且链条会级联。求助在 calibration 中是**被奖励**的，而不是被惩罚                                                |
| [Composition](../spec/composition.md)                | 一个 Process 是遵守某个 contract 的 Artifact，带显式 pin 与 migration。静态分析。结对设计本身就是一条 Ecoma workflow                                    |
| [Trigger & Channel](../spec/trigger-channel.md)      | 入口与出口：边界处强制认证，payload 是一个受 contract 约束的 Handoff，会话关联。终端用户是某个 Role 的 `external` Filler                                |
| [Knowledge](../spec/knowledge.md)                    | 知识作为业务资产：带 Curator Role 的 Collection、按 Role 授权、一个 classification lattice 加两层出口闸                                                 |
| [Artifact Store](../spec/artifact-store.md)          | "哈希永久，字节按策略"——永久真相在日志里，blob 有生命周期，按引用回收，去重只在租户内部                                                                 |
| [Event Log](../spec/event-log.md)                    | 唯一真相来源，按租户 append-only。计量、审计、检索、通知与 calibration 输入全都是可重建的 **projection**。加密粉碎把 append-only 与被遗忘权调和到一起   |
| [Working Data](../spec/working-data.md)              | "用 SQL 提问，用 event 写入"——DataTable 是可写的 projection；**Lease 是唯一的加锁 primitive**，TTL 强制                                                 |
| [Memory](../spec/memory.md)                          | 记忆属于**组织，以 subject 为键**——永不属于某个 filler，因此换模型或换人不会丢失任何东西。provenance 强制，用以对抗编造                                 |
| [Tenant & Identity](../spec/tenant-identity.md)      | 一套授权系统，而不是两套：管理员与流程负责人都是有人填充的 Role。租户是硬边界，workspace 是软隔断。假名 actor id 配可粉碎的个人数据——审计存活，人被遗忘 |
| [Calibration](../spec/calibration.md)                | 置信度背后的数据模型：一个多维键、带时间衰减的 lineage，以及一个显式的 estimator identity                                                               |
| [Human Surface](../spec/human-surface.md)            | Work Surface：一个由 Work Item 与 Action Item 构成的对象模型，两个视图。"收件箱"是一个视图，不是模型                                                    |
| [Vault & Key](../spec/vault-key.md)                  | 三层密钥树、rotate ≠ shred、灾难恢复义务，以及规定哪些副本类别可以持有密钥材料的规则                                                                    |
| [Release & Compatibility](../spec/release-compat.md) | 三条版本轴、协商、升级与回滚、生命周期终止窗口                                                                                                          |
| [Test Harness](../spec/test-harness.md)              | 引擎的一种模式，而不是立在它旁边的一件工具：test run scope、fixture、mock、断言，以及各套 conformance suite                                             |

有一条性质贯穿全部：每一项系统操作——coerce、merge、distill、arbitrate、adapt、
compensate、migrate、design——都是**某个 Role 的一个 Task**。没有魔法节点。所有劳动都
经过同一个机制，而这正是所有劳动都能经由同一个机制被观察到的原因。

## 四道试金石

它们定义了"已统一"是什么意思，而且它们是可度量的，不是修辞：

1. 一个步骤能否**在不改动 flow 的前提下**从人换成 AI？
2. 它能否以 shadow 模式运行，并自动生成一张对照表？
3. 是否存在**一把覆盖人与 AI 的信任标尺**？
4. 能否**按 Role** 看到成本与质量，无论由谁填充？

## Non-goals

- **不追求 BPMN 2.0 合规。** 这里的 primitive 集是取代它，而不是实现它。
- **Platform 不包含任何机器人自动化技术**——没有 selector、没有 vision、没有 driver。
  那是 RPA 的 domain，经由 Filler 与 Session effect 接口触达。否则换一个浏览器就等于
  换一条 workflow。
- **引擎永远不自行编辑 artifact、自行合并或自行迁移。** 每一次介入都是某个 Role 的一
  个 Task，并留下痕迹。
- **步骤之间没有共享可变状态。** 一切都经由 Handoff 移动。
- **Ecoma 不是一个聊天助手**——但用户在 Ecoma 上搭建聊天机器人是一等用例。产品是
  **self-serve 优先**的：无需实施团队即可使用。Enterprise 是一个部署与授权层级，不是
  一条有权决定设计的销售渠道。
- **运行时永不校验 entitlement。** 没有 license key，没有 phone-home。内容的商业化止
  步于分发层。
- **不自建通用数仓，也不自建 vector 引擎。** 劳动分析是一个 projection 加一条归你所有
  的导出通道；向量经由 adapter 到来。护城河是劳动数据集，不是一个 SQL 引擎。
- **不做跨租户学习**，在 Judgment 与 Escalation 飞轮拿到数据之前**也不做"ML 给出优化
  建议"**。等它们有了数据，来源早已点名：Judgment、escalation 日志、冲突，以及结果回
  传。

## 产品架构与分发模型

**各层，按建造顺序。** 每一层站在前一层之上，而这正是这个顺序是一种依赖关系而非一种偏
好的原因：

| 层  | 是什么       | 内容                                                                         |
| --- | ------------ | ---------------------------------------------------------------------------- |
| 1   | 核心引擎     | 各 primitive、composition、event log、artifact store、durable 执行、静态分析 |
| 2   | Agent 运行时 | 运行内部 agent filler；RPA 与外部运行时经由标准接口接入                      |
| 3   | 人类界面     | Work Surface：triage、批量审核、diff、移动端                                 |
| 4   | 结对设计     | 在引擎自身之上运行的设计 workflow，加一块画布                                |
| 5   | Intelligence | 从 Judgment、escalation、冲突与结果中按租户学习                              |

### Fair-code，以及标签为何要紧

Ecoma 是 **fair-code / source-available**。它刻意不被称作 open source，而这三个词并不
可以互换：

|                    | 得到什么                                                                 | 失去什么                                                                                 |
| ------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Open source（OSI） | 下面一行的全部，外加那个标签                                             | Freedom zero 要求允许**任何用途**，包括把 Ecoma 转卖成一项竞争性服务。没有任何条款能禁止 |
| Fair-code（Ecoma） | 代码公开、可读、可自由自托管、可自由修改——每一条对租户的机制承诺都看得见 | 禁止把 Ecoma 转卖成一项服务                                                              |

把它叫作"closed"，会失去那些愿意读代码的人；把它叫作"open source"，则是放弃禁止转卖的
权利。在标签上讲究精确不是咬文嚼字——那是让两项性质同时存活的唯一办法。

### 授权是一条分类规则，不是一份清单

一个问题决定每一个单元：**第三方需要这个东西是为了_接入_系统，还是为了_运行_系统？**

| 回答                                                       | 授权                                  |
| ---------------------------------------------------------- | ------------------------------------- |
| **接入**——interface、schema、protocol、client、SDK、词汇表 | Apache 2.0                            |
| **运行**——产品 area 中任何 server、node 或 service 的实现  | fair-code 源码授权                    |
| 接入某个已声明 extension point 的模块                      | Enterprise，位于 `<area>/enterprise/` |
| 运营方的控制平面                                           | Proprietary，不公开                   |

这条规则之所以存在，是因为清单会漂移而规则不会。此前的一次尝试在五份 spec 里分别声明
了宽松授权，而一张按 area 划分的表格却声明每个 area 都用 fair-code 授权——那张表根本无
法表达比 area 更细粒度的授权。**授权按单元切分，永不按 area 切分。**

### 仓库拓扑，以及各条边界为何重合

顶层目录就是 area。每个 area 分为 `apps/`、`libs/` 与 `packages/`，而这三层的差别决定
了谁可以依赖它们：

| 层          | `private` | 是否带版本    | 谁来消费                                  |
| ----------- | --------- | ------------- | ----------------------------------------- |
| `apps/`     | ——        | 按 train 打戳 | 一个可部署的 artifact                     |
| `libs/`     | `true`    | 不带版本      | **只在 workspace 内部**                   |
| `packages/` | `false`   | train 的版本  | **第三方**——SDK、protocol、schema、client |

结果才是关键：**授权边界、发布边界与目录边界是同一条边界。** 上面那条分类规则说"接入
→ Apache 2.0"，而接入的那些单元恰好就是 `packages/` 里的那些。一个决定，三处按构造自
动吻合，而不是靠手工同步。

刻意**没有 `connectors/` 这个 area**。第一方 driver 与 channel adapter 住在各自
domain 的 `libs/` 中，带 adapter 标签，因为它们实现的是属于那个 domain 的一个 port，而
不是构成第七个 domain。把它们拆出去会切断每个 adapter 与它所服务的 port 之间的联系，换
来的只是观感上的整齐。**第三方**编写 adapter 所需的接口依旧公开于 `packages/`，而那才
是真正值得防守的边界。

**一条六边形 layer 轴，由 lint 强制。** 每个 library 最多携带一个 layer —— util、
domain、port、adapter、view、app —— 依赖方向由机器强制。其中两条规则物有所值：

| 规则                                                          | 它保护什么                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| app 层可以用 port、domain 与 util —— **永不直接触碰 adapter** | 这是把 storage-port 决策变成可执行的形式。触达引擎必须经由 port，因此引擎始终可替换。没有这条规则，"port"就只是一个目录，而不是一条边界 |
| view 层永不触碰桌面宿主运行时                                 | view 发出 intent、shell 负责接线，因此 attended UI 层不是第二条写入路径                                                                 |

天花板只裁定这条轴存在、且上述两条规则成立。完整配置属于仓库，不在此处重述。

### 自托管即单租户，理由是 invariant 4

> **多租户从不为用户增加任何一项能力。它只节省运营成本。**

因为 invariant 4 禁止跨租户学习，一套安装上的两个租户**在一切属于产品的层面上都等价于
两套独立安装**：不共享 calibration，不共享 memory，不共享 knowledge。唯一的差别是一套
基础设施集群而不是两套——而"规模化的运营节省"恰恰就是服务商所出售的东西。反过来，把多
租户放进 enterprise 层，意味着把现存最高风险的代码——创建租户与密钥树的根——发布给最广
的受众，换回的却是零项新能力。

随之而来两条机制性后果，二者都不是可选项：

| 后果                           | 规则                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **引擎始终是 tenant-aware 的** | 密钥树、按租户的日志、带 scope 的授权、限定在租户内的去重、按租户的计量。**即使 cardinality 为一，租户层也在物理上存在**——为了"简洁"去掉它，会让日后每一次转向多租户都变成一次全量密钥迁移 |
| **一租户的上限是一条产品边界** | 自托管安装没有第二个租户，是因为创建租户的 workflow 只随运营方控制平面发布——而不是因为运行时校验了某个 entitlement。上面的 non-goals 直接禁止后者                                          |

invariant 4 同样约束运营方。运营方可以**跨租户聚合计量**；运营方**永远不可以**跨租户
路由 knowledge、memory 或 calibration。这条边界必须公开声明并带有一道试金石，正因为强
制它的代码位于外部人无法审计之处。

### 版本与发布

- **所有 artifact 共用一条 release train `X.Y.Z`**——服务端、node 二进制、chart、SDK
  ——因此兼容性坍缩为单一一条轴。
- **每个接口各有一条 protocol version**，在握手时协商。
- **偏斜**：服务端向后支持一个 minor 版本。超出该窗口，node 拒绝领取工作并 escalate
  ——这比跑错要安全。
- **破坏性变更只在 major 发生**，且此前至少有一个 minor 的弃用期。
- **升级时日志永不被重写**——读取方容忍较旧的 schema 版本，而 projection 因为是派生物
  所以重建。**每一步迁移都是日志中的一条 entry**，因此一次升级带有 provenance。major
  按顺序执行，不得跳跃。
- **回滚是一次显式的逆向迁移。** 每一次 major 迁移都要声明一条 down-migration，或者声
  明自身不可逆；两者都不声明则视为没有退路，引擎会在执行前要求一道 gate 和一份副本。
  把版本 pin 回旧的那一个，只有在数据尚未改变形状时才算回滚。一旦形状已变，回滚就是一
  次完整迁移：某个 Role 的一个 Task，带 gate、带日志 entry，而不是一个按钮。

### 部署与存储

部署经由容器与编排。存储位于**五个 port 之后，其默认值随部署形态而定**
（[ADR-0002](../method/adr-ledger.md)）：单二进制或单容器取 small-stack；生产集群取一
个数据库，同时承载 event log、可写 projection、向量与指标。**conformance suite 的
reference backend 是 Postgres**，这与某次安装的默认值并不是同一句话。**默认值不是耦合**
——每个后端都是 port 背后的一个 adapter。升级一个后端是一次日志重放，永远不是一次自动
转换。
