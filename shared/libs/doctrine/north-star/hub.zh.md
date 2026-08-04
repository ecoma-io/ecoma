---
title: "Ecoma Hub — North Star"
status: design-end-state
canonical-sha: 10c9ed4db890
---

# Ecoma Hub — North Star

## 终态

**Ecoma Hub 是本系统一切实体的打包、分发与共享基础设施，形式是 Block：一套 registry
协议（内容寻址、带签名、带透明日志）、一个不可变的公共实例、任意多个私有镜像，以及一
个 index 与 marketplace——社区在这里延长流程知识的长尾，而发布者靠维护它活得下去。Hub
缺席时，每一个已安装的运行时照常运行，永久。**

它所特化的机制原则的 canonical 出处在 [Platform North Star](platform.md)，此处不再重
述。

## 问题所在

"Template"是 default cascade 赖以站立的概念，而它需要一套真实的分发机制，而不只是一个
名字。应用画像需要一份目录。连接器与流程的长尾不可能由一家公司写完。

更具决定性的是：**流程知识是一类会老化的内容。** 应用会改界面，法规会变。没有维护经济
的共享，只会产出一片曾经正确过的 template 墓地。因此 Hub 把分发机制与经济引擎耦合在一
起，因为二者之中只有一个能让内容活着。

## 机制原则

1. **Hub 永不触碰运行时**：运行期不校验 entitlement，不 phone-home，引擎里没有 license
   key。商业化止步于分发层——pull 与 update。
2. **digest 是真相；语义化版本是给人的界面。** 机器在 lockfile 里 pin digest；人说名字
   加一个版本范围。公共实例是不可变的：已发布的东西永不删除，只从解析中撤下，因此一个
   既有的 pin 可以永远工作下去——**"永远"是指在安装它的那条 engine train 上**。跨越一
   个 engine major 是一个独立的、带 gate 的动作：upgrade 会拿新 train 重新读取 lockfile
   里的每一个 pin，并在 cutover _之前_ 浮现任何会被已移除路径破坏的 pin（Release &
   Compatibility §3），这样"永久运行"与"deprecated 路径在 major 处被移除"就不会悄无声息
   地相撞。
3. **不信任发布者。** 租户在安装时重跑静态分析，而一份声明少于分析所发现内容的 manifest
   会被拒绝，而不是被警告。签名与透明日志抵御跨镜像的篡改。
4. **内容信任复用已经存在的机制。** block 内部的 filler 从较低信任层级起步，因为它在这
   个租户里还没有 calibration；含有不可逆 effect 的 block 被强制加上一道 gate 下限。不
   存在独立的运行时审核体系，因为第二套体系需要它自己的证据与自己的申诉路径。
5. **Hub 对租户数据是盲的。** 它永远看不到 calibration，且在没有 opt-in 时不接收任何遥
   测。发布者看到安装量与收入，别的什么都看不到。

## 三层

| 层              | 它持有什么                                                                  | 备注                                                             |
| --------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Registry**    | 遵循标准容器约定的 artifact 存储：digest、发布者签名、attestation、透明日志 | 私有的那份就是任何现成 registry；气隙镜像使用标准命令            |
| **Index**       | 目录：搜索、发布者与名称的命名空间、block 页面、verified 徽章、版本历史     | 命名空间通过发布者身份拥有，因此抢注由身份来回答，而不是靠盯名字 |
| **Marketplace** | 上架、定价、entitlement、支付、收入分成结算                                 | index 之上的一层薄商业层，而不是一个独立系统                     |

index 与 marketplace 的前端是属于本 domain 的一个应用，由运营方挂载在公共边缘。它**以
静态优先**渲染，由 registry 事件驱动重新验证——这是内容不可变性的直接结果：某一个 block
版本的页面可以永久缓存，只有指针需要重新验证。

存在一条并行的开发通道：block 在 git 中开发，fork 与评审天然带来 lineage 与 review，而
打包、签名与推送才是发布这一动作。逃生口——直接从某个 git 修订加入一个 block——会被标记
为 `unverified`，只用于开发与内部使用。

## 一个客户端接口，仅此一个

Platform 与 RPA——包括独立运行的 RPA——通过恰好三个动词与 Hub 通话：**`resolve` /
`pull` / `verify`**。Hub 不知道一个 block 如何运行；运行时不知道一个 block 如何存储或
售卖。接口与 manifest schema 采用宽松授权，因此第三方无需征求任何人同意即可搭建兼容的
registry。

## Marketplace 机制

- **entitlement 只在一个地方校验：分发。** 让订阅过期，一切已安装的东西照样永久运行，
  由 digest 钉住；失去的是更新流。这就是原则 1，从买方一侧看过去的样子。
- **定价形态**：免费、一次性（某个 major 之内的永久 entitlement）、订阅（拉取更新流的
  权利），以及站点授权。
- **不做 DRM。** 一份 definition 是文本，可以被复制。所售卖的是更新流、其背后的维护
  ——一份能跟上界面变化的应用画像——以及一个已 verified 发布者所带来的信任。订阅一份应用
  画像，正是"界面变了以后谁来维护这条自动化"这个问题的经济学答案，而这个问题杀死了大多
  数自动化项目。
- 两级内容授权：免费目录采用宽松条款，付费 block 采用发布者自己的条款，在发布时显式声
  明。

## 信任与供应链

- **发布**是：打包（包含打包时的完整静态分析）、签名、推送、编入索引。block 内部的知识
  Collection 只能以公开分级进入公共实例，因此解密闸站在每一次发布之前。
- **verified 徽章**由一次评审授予，而这次评审本身就是一条 Ecoma workflow —— Hub 作为
  Platform 的一个租户来运行自己的策展流程。结果是一份附在 artifact 上的带签名
  attestation。
- **自我批准在结构上不可能**，而这一点之所以要紧，是因为这是 `code` 类 artifact 唯一的
  门。reviewer Role 声明它的 filler 必须与发布者不同，且由运营方填充：发布者永远不会填
  充评审自己 block 的那个 Role。每一个结果都是带签名的 Judgment，而 reviewer 自己的
  calibration 会像任何其他 Role 一样承受结果回传。
- **撤销是一个 event。** 已签名的 digest 永不改变——它是不可变的——但徽章脱落，该发布者
  的 `code` 类 artifact 回到默认被拒的状态，且 index 按已撤下处理：既有的 pin 存活，新
  的解析看不到它。
- **发布者提供的 conformance suite 有硬性限制。** 一个 block 可以自带套件来证明它能正
  确运行。三条限制不可谈判：套件是**佐证，永不是充分条件**——徽章来自 reviewer 的
  Judgment；套件在运营方的 test run scope 中运行，contract 全面禁止、零 credential
  handle，并对时间、资源与模型成本设上限；而对于 `code` 信任类别，评审路径依赖于运行时
  沙箱的存在。没有它就会出现一个循环：想拿到 verified 就必须运行代码，而运行代码又要求
  已经 verified。verified 这道门是 `code` 唯一的门，因此它本身绝不能成为一条执行未评审
  代码的路径。
- **`code` 类 artifact**——driver、自定义 rule filler——属于独立的信任类别：除非发布者
  已 verified，否则默认被拒，且只有在管理员显式 opt-in 时才可安装，因为代码无法像
  definition 那样被完整地静态分析。
- **租户侧的安装**：校验签名与日志、重新分析、在安装前**披露 scope**（它是否触及不可逆
  effect？是否用到凭据？涉及哪些域？是否会 spawn？）、带 provenance 地物化、经由信任层
  级隔离，并记入 lockfile。

## 试金石

1. 拔掉 Hub——每一个已安装的租户是否照常完整运行，永久？
2. 同一个 block 从公共实例、私有镜像与气隙副本安装，结果是否完全一致——同一个 digest、
   同一份可校验的签名？
3. 一个 manifest 少声明了能力的 block，在安装时是否被**拒绝**，而不是被警告？
4. 如果发布者消失了，买方是否保有一切已安装的东西？
5. 携带两个不同 contract 版本的两个 block，能否并存安装而不冲突？
6. 是否存在任何路径让发布者自行批准自己的 block 以获得 verified 徽章？徽章能否被撤销，
   且该发布者的 `code` 类 artifact 是否在此后立即失去默认可安装性？

## Non-goals

- **不触碰运行时**；引擎里没有 license key，也没有 phone-home。
- **默认不收遥测**、不做跨租户学习，且 index 自身的排序与搜索永不触碰租户的
  calibration。
- **不是 CI 系统，也不是 git 宿主。** 开发发生在 git；Hub 接收的是已经打包好的
  artifact。
- **机制文档里不写商业政策**——退款之类属于运营，把它们写进这里会让一份机制文档因为一
  个商业决定而改动。

## 分发

- 本 domain 住在自己的 area 中。授权遵循 [Platform North Star](platform.md) 中的
  canonical 分类规则——`resolve` / `pull` / `verify` 协议、manifest schema 与客户端库是
  第三方要接入的东西；hub 服务是拿来运行的东西。本文档不重述那条规则，因此它不存在第二
  个来源。
- Hub 承载本系统的第四条收入线：**marketplace 收入分成。**
