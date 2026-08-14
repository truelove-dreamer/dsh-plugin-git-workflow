# dsh-plugin-git-workflow

DeepSeek Harness 插件:给模型提供**一等公民的 Git 工作流工具** —— 仓库状态、diff、规范 commit、历史、分支,不再需要裸 `bash`/`pwsh` 手搓 git。

## 背景

DSH 内置没有任何 git 工具。模型只能通过 `bash`/`pwsh` 调用 `git`,输出原始、易错、难解析,还容易把用户输入拼进 shell 命令(注入风险)。这个插件把 Git 变成**结构化、安全、可解析**的工具集。

## 工具

| 工具 | 作用 |
|---|---|
| `git_status` | 分支、upstream、ahead/behind、staged / unstaged / untracked / conflicts 清单(porcelain 解析) |
| `git_diff` | 工作区 diff 或 staged diff(`--cached`),支持 `--stat` 摘要、路径过滤、行数截断 |
| `git_log` | 最近提交(hash/日期/subject),可选 `files` 列出每个提交改动的文件 |
| `git_commit` | 校验 message 后 `git add`(可选路径)+ `git commit -m`;清晰报出 "nothing to commit" |
| `git_branch` | 本地分支列表,标记当前分支 |

## 安装

```bash
dsh plugin --profile web add dsh-plugin-git-workflow
```

挂载(profile `cordis.patch.yml` 或 agent preset):

```yaml
- insert:
    - id: git-workflow
      name: dsh-plugin-git-workflow
```

## 使用

```text
git_status                        # 看当前仓库状态
git_diff                          # 看未暂存改动
git_diff staged: true             # 看已暂存改动
git_commit message: "fix: ..."    # 提交(全部已暂存内容)
git_commit message: "feat: ..." paths: ["src/a.js"]   # 先 add 再提交
git_log count: 20 files: true     # 最近 20 条 + 改动文件
git_branch                        # 分支列表
```

所有工具都接受 `workdir`(默认会话工作目录,相对路径按会话目录解析)。

## 设计说明

- **零 shell**:所有 git 调用走 `child_process.execFile("git", argsArray)`,参数数组传递,用户输入永远不可能被解释为 shell 语法。
- **输入校验**:commit message 非空、≤2000 字符、无 NUL;路径拒绝绝对路径与 `..` 穿越(反斜杠归一化后检查),保证不越出仓库。
- **纯逻辑可单测**:解析(porcelain / diff-stat / log / branch)与校验全部在 `lib/git.js` 纯函数里,`npm test` 零依赖。
- **结构化输出**:每个工具返回带 schema 的 JSON,render 输出可读文本;失败返回 `{ ok:false, exitCode, message }` 而非裸报错。

## 诚实边界

- 工具直接以 host 进程身份运行 `git`,**不经过 fs-sandbox 围栏**;路径校验是词法级的,符号链接/工作树外路径依赖 git 自身约束。需要更强隔离时,请勿在 untrusted 会话挂载此插件。
- commit 需要仓库已配置 `user.name`/`user.email`(git 自身报错会透传)。
- `git_log` 的 `files` 解析假设 `--name-status` 输出格式;非常规编码的路径可能显示不完整。
- 不含 push / pull / rebase 等网络操作(后续版本可加,需审批语义配合)。

## 本地开发

```bash
cd plugins/dsh-plugin-git-workflow
npm test          # node --test,零依赖
```

接线集成测试(需 harness checkout 的 Cordis):见仓库根 `test-wiring.mjs`。
