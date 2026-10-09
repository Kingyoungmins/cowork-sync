# cowork-sync

网站(英文):[kingyoungmins.github.io/cowork-sync](https://kingyoungmins.github.io/cowork-sync/)

cowork-sync 是一个 Claude Code 插件,可以让多个克隆之间实时同步同一个 git
分支的工作树。每位队友在自己的电脑上、自己的克隆里,使用自己的 Claude Code
会话工作。有人保存文件后,这个改动会出现在其他所有人的工作树里。唯一的传输
通道就是项目自己的 git 远程仓库,没有任何服务器。

cowork-sync 是个人的源码可见(source-available)项目,与任何公司或雇主无关,
也没有得到任何公司或雇主的赞助或认可。它采用 FSL-1.1-ALv2 许可证
(见 [LICENSE.md](LICENSE.md)),贡献者需要签署
[CONTRIBUTING.md](CONTRIBUTING.md) 中说明的 CLA。

## 状态:v0.1.0-preview

这是早期预览版,不是成品。目前可用的是同步引擎:每个克隆运行一个后台进程
(守护进程),它会获取你保存的改动并发布到远程仓库,同时把队友的改动写入你
的工作树。我们在真实的 GitHub 仓库上用两个克隆做过测试:修改不同的文件、
修改同一文件中相隔十行的位置、修改同一行,最终两个克隆都得到相同的状态,
并且位于同一条快进(fast-forward)历史上。只读查看器的核心部分(在浏览器中
展示团队活动)也已包含在内。尚未包含的有:冲突保留(hold)的交互体验(被替
换下来的版本会被保存,但还没有查看或恢复它的命令)、函数级认领、Claude Code
会话钩子以及 Claude 之间的协作(在本预览版中,Claude 并不知道同步的存在,它
的编辑和其他已保存的文件一样被同步)、完整的命令行(save、doctor、启动检查
如私有远程检查、暂停和恢复),以及查看器 2(六种语言、录制、精彩回放)。
请只在测试仓库上使用本预览版。[docs/STATUS.md](docs/STATUS.md) 列出了已完成
和接下来要做的内容。

## 环境要求

- Claude Code 2.1.270 或更新版本。
- `PATH` 中有 Node.js 20 或更新版本(从源码构建需要 20.6 或更新版本)。
- git 2.43 或更新版本。启动时会拒绝更旧的 git。
- Windows、macOS 或 Linux。
- 一个**私有**的 git 远程仓库,需要接受自定义引用(`refs/cowork/*`)并强制
  执行 `--force-with-lease`。GitHub 两者都支持。启动时会探测远程主机,不满足
  条件就会拒绝。
- 来自 git 凭据助手(credential helper)的凭据。cowork-sync 会关闭 git 的交
  互提示,因此缺少凭据时会给出明确的拒绝信息,而不是卡住不动。

## 安装

每台参与的电脑都要安装插件,并且拥有自己的仓库克隆。

在 Claude Code 会话中:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

或者在 shell 中:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

运行 `/reload-plugins`(或重启 Claude Code)来加载插件。这个插件市场不会自动
更新。更新时,先运行 `/plugin marketplace update cowork-sync`,再运行
`claude plugin update cowork-sync@cowork-sync`。要移除插件,运行
`claude plugin uninstall cowork-sync@cowork-sync`。

## 使用

在你的克隆中打开 Claude Code,输入下面的命令。Claude Code 把插件的命令命名
为 `/cowork-sync:cowork`,请完整输入这个名称。同样的子命令也可以在终端中运
行,形式为 `node "<plugin folder>/dist/cli.js" <verb>`;
`/cowork-sync:cowork view` 会打印这个路径。

| 命令 | 作用 |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | 为当前仓库在当前分支上启动同步。第一台电脑会在远程仓库上创建共享看板(board),之后的电脑则加入这个看板。守护进程在后台持续运行。 |
| `/cowork-sync:cowork status` | 打印简短的摘要:状态(`ok`、`degraded`、`offline`、`frozen`、`down` 等)、分支,以及还在等待发布或应用的内容。 |
| `/cowork-sync:cowork view` | 打印打开只读查看器的命令。查看器只能从终端打开:在终端里运行该命令,它就会在浏览器中打开。如果你的构建还没有查看器进程,它会以 `RF_VIZ_START_FAILED` 拒绝(见 [CHANGELOG.md](CHANGELOG.md))。 |
| `/cowork-sync:cowork stop` | 干净地停止守护进程。你的文件保持原样。 |
| `/cowork-sync:cowork help` | 列出所有命令。 |

当命令被拒绝时,它会打印带代码的原因,以及一行 `next:`,给出应该运行的命令。
如果守护进程自己拒绝启动,它自己的输出会跟在
`the daemon did not start; it said:` 之后。

`start` 会检查:

- 必须在主克隆中运行。链接的工作树(linked worktree)或子模块会被拒绝。
- 分支已检出、在远程仓库上存在,并且既不领先也不落后于远程。请先 push 或
  pull。不能有正在进行的合并(merge)或变基(rebase)。
- 远程仓库的 fetch URL 等于其 push URL,并且没有适用的 `insteadOf` 改写。
- 每个克隆只运行一个守护进程。
- 如果首次启动时有未提交的改动,它会停下来,请你选择:与团队共享这些改动,
  或者只保留在这台电脑上。

同步运行期间:

- 像平常一样保存文件。你保存的改动会被发布,队友的改动会被写入你的文件。
- 不要在已同步的克隆中运行会移动 `HEAD` 的 git 命令(commit、switch、
  checkout、pull、merge、rebase、stash)。同步会冻结,直到 `HEAD` 回到原来的
  位置。请先停止同步。
- 目前还没有能把共享成果变成分支上提交的 `save` 步骤,它会随完整命令行一起
  提供。请把本预览版当作在测试分支上试用实时同步的方式。

每个克隆会把自己的文件放在 `.git/cowork/` 下:`status.json`(当前状态)和
`log/daemon-0.jsonl`(守护进程日志)。

## 工作原理

1. 每个克隆运行一个守护进程。它通过自己专用的私有 git 索引读取你保存的文件,
   从不碰你自己的索引。
2. 共享状态保存在你的远程仓库上的两个自定义引用中:
   `refs/cowork/<branch>/board`,一条只能快进的看板提交链,它是权威来源;
   以及 `refs/cowork/<branch>/code`,最新共享树的镜像。这些引用中的分支名
   经过百分号编码。
3. 每次推送都是由租约(lease,`--force-with-lease`)保护的快进,所以没有哪台
   电脑能覆盖另一台的更新。输掉的一方会重新获取后再试。全队共用的配额(每分
   钟 12 次推送,被限流后的半小时内为 6 次)可以降低对托管主机的负载。
4. 传入的改动使用 `git merge-tree` 并指定明确的合并基(merge base)进行合并。
5. 只有当文件仍然是守护进程上次读取的内容时,才会写入该文件,所以你刚保存的
   编辑绝不会被覆盖。一组文件要么全部写入,要么全部不写。
6. 当两个人修改同一行时,一个版本胜出,另一个作为保留(hold)记录保存在你的
   克隆中,绝不会被丢弃。
7. 设置、钩子和 CI 文件(`.claude/`、`.github/workflows/`、`.gitattributes`
   等)从不实时同步。如果看板的历史被改写,所有电脑都会冻结,直到恢复为止。
8. 预览版从不向你的分支(`refs/heads/<branch>`)推送。普通的 `git fetch` 不会
   下载这些自定义引用,所以你正常的 git 历史保持干净。

## 安全说明

- cowork-sync 会写入你的工作树,队友的编辑也会写入。请先在测试仓库上试用,
  并备份你在意的内容。
- 只使用**私有**远程仓库。你在已同步的克隆中保存的所有内容都会被推送到
  `refs/cowork/*`,任何能读取该仓库的人都可以获取。预览版目前还不会检查远程
  仓库是否为私有。
- 名称看起来像密钥的新文件(`.env`、`*.pem`、`*.key`、`id_rsa*`、
  `*credentials*` 等)不会被共享。目前不会扫描文件内容中的密钥,所以请不要把
  密钥放进被同步的文件。
- 新建时超过 1 MiB 的文件不会被共享,50 MiB 或更大的文件永远不会实时同步。
- 停止同步或卸载插件后,自定义引用仍会留在远程仓库上。所有电脑都停止之后,
  你可以手动删除它们,例如
  `git push origin --delete refs/cowork/main/board refs/cowork/main/code`。

## 许可证

cowork-sync 以 Functional Source License 1.1 发布,并以 Apache License 2.0 作
为其未来许可证(FSL-1.1-ALv2,[LICENSE.md](LICENSE.md))。简而言之:你可以出
于任何目的使用、复制、修改和分享它,但竞争性用途除外,即把它或实质上功能相
同的东西作为商业产品或服务提供给他人。内部使用、教育、研究,以及为被许可方
提供的专业服务都是允许的。每个版本在发布两年后,可按 Apache License 2.0 使
用。

贡献需要签署 [CLA.md](CLA.md) 中的贡献者许可协议。如何签署以及如何参与开发
代码,请见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 联系方式

问题请联系:minzbusiness0204@gmail.com。安全问题请通过仓库的私有漏洞报告渠道
提交,不要通过电子邮件发送。见 [SECURITY.md](SECURITY.md)。
