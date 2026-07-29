---
name: repo-care
subsystem: shared
lang: zh
description: 仓库表层自动化——借助免费 LLM，做 issue 分诊、PR 教义的建议性审查，以及讨论串翻译。
---

> 🌐 [English](./README.md) · [Tiếng Việt](./README.vi.md) · **中文**

# repo-care

<!-- readme:why -->

GitHub 上有三件事需要自然语言判断，而不是确定性（deterministic）检查能做到的：
给新 issue 分类 type/area，审查一个 PR 的 diff 中那些任何 lint 规则都看不见的
"判断层"教义违规——被削弱到能通过的测试、假装完成的桩代码、悄悄夹带的重构，
以及把一条用某种项目语言写成的讨论串映射到另外两种语言，好让没有人被挡在讨论之外。
`repo-care` 把这三件事都交给 LLM,但只用 opencode zen 的无密钥免费层
(`https://opencode.ai/zen/v1`)——不需要 API key,不需要配置任何 secret。免费模型
单独来看既弱又不稳定(限流或服务商故障会以 HTTP 200 附带 `error` body 的形式出现,
而不是一个干净的错误状态),所以这里的整体设计从不相信单个模型的一面之词:
`zen.mjs` 为每个问题最多收集 3 个经过 schema 校验的判定,只有当至少 2 个判定一致
时才生效(`tallyVerdicts`);可用判定不足 2 个就直接失败退出(fail loud),绝不
掷硬币式地行动。另一层结构性防护是枚举:模型只能从固定词表(`TYPES`、`AREAS`、
`LABEL_DEFS`、`CHECKS`)中选择,这把一次不稳定或被提示词注入的响应造成的影响,
限制在"从列表里选错了一个标签"。

翻译是唯一一处让自由文本从模型里流出来的地方,因此它也是唯一的例外——一个狭窄
且有意为之的例外。判断讨论串用哪种语言写成仍然是从枚举里选,所以仍然需要凑齐
多数。而译文本身无法计票,于是改为围堵而非表决:译文落在一条带
`TRANSLATE_MARKER` 的追加评论里,从不改写作者本人的标题或正文,并且
`sanitizeTranslation` 会让其中一切可能"做事"而非"被读"的内容失效。

<!-- readme:consumers -->

三个 GitHub Actions workflow 直接调用本工具,都使用环境自带的 `GITHUB_TOKEN`
(无需另配 secret):`.github/workflows/issue-triage.yml` 在 issue
`opened`/`reopened` 时运行 `main.mjs triage-issue`(另有手动
`workflow_dispatch`,用于回溯分诊旧 issue);
`.github/workflows/pr-doctrine-review.yml` 在非草稿 PR 的
`opened`/`reopened`/`synchronize`/`ready_for_review` 时运行
`main.mjs review-pr`;`.github/workflows/translate-issue.yml` 在 issue `opened`/`edited` 时运行
`main.mjs translate-issue`；`.github/workflows/translate-pr.yml` 在 PR
`opened`/`edited` 时运行 `main.mjs translate-pr`。没有任何 workflow 接入 required/branch-protection
检查——见 `readme:boundary`。

<!-- readme:ecosystem -->

`repo-care` 与 `dev-cli`、`eslint-local-rules` 同为 `shared/tools` 下的兄弟项目:
`dev-cli` 守护代码与仓库约定,`eslint-local-rules` 守护 AST,`repo-care` 则围绕
它们自动化仓库表层(issue、PR)的事务。它自己不编写任何词表——issue 分诊用的
`AREAS` 枚举,是在 import 时从每个 subsystem-root 的 `README.md` frontmatter 中派生
出来的(该约定由 `dev-cli check-subsystem-readmes` 在 CI 中守护);PR 审查用的
`CHECKS` 评审标准,则派生自 `doctrine-index.json` 的 `diffCards`/`pathCards`
(由 `dev-cli check-doctrine-index` 守护);翻译的目标语言则来自仓库根目录的
`languages.config.json`——正是 `dev-cli` 为多语 README 约定所读取的同一个文件,
因此两边不可能说出两套不同的语言。三者都在运行时读取同一处真相来源,
从不在本项目里重写或复制。

<!-- readme:boundary -->

`review-pr` 依设计只是建议性质,绝不是必需或阻塞性的 gate——决定 PR 能否合并
的唯一真相来源,始终是确定性检查(lint/test/typecheck/build)的结果。这里的模型
从不执行任何东西,也从不臆造标签:每个判定字段都必须来自固定枚举;review-pr
自身对仓库的读取都经过校验、有预算上限,且只读(本工具自身源码从可信的 base ref
读取,PR 的 diff/文件内容从 PR 的 head SHA 读取,并始终被当作不可信数据处理)。
翻译也秉持同样的"只做加法":它只会发布或编辑属于自己的 `TRANSLATE_MARKER`
评论——作者的标题与正文从不被改写,兄弟 job 的评论也够不着,因为这里每一次
查找都用 `startsWith` 把 marker 锚在开头。
`repo-care` 也没有 `package.json`,从不被 import——它运行在裸 `node` 上,使这些
GitHub Actions job 都无需 `pnpm install`。

<!-- readme:status -->

正在实际运行:三个 workflow 都会在每次匹配的 GitHub 事件上运行本工具,而不是
草稿或未接线的占位实现。机制细节——quorum/判定计票规则、各枚举词表、review-pr
的多轮调查流程、翻译的 quorum 例外,以及已知的坑——见
[`./CLAUDE.md`](./CLAUDE.md)。
