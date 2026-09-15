# 论文模式 preset · 分发包

DSH（DeepSeek Harness）的 agent preset：**学术文献与论文写作协作**。
自带文献检索、引用核验、`.bib` 审计工具，以及三个按需加载的技能。

- preset id：`paper`　显示名：论文模式
- 零依赖：只用 Node 内置 `fetch` 直连公开学术 API，不装 npm / pip 包
- 不预定义产出、不强制流程：它添加能力，不规定你的工作方式

---

## 一、给客户：怎么装 / 怎么更新

```bash
git clone <你的仓库地址> paper-preset
cd paper-preset
./sync.sh --dry-run     # 先看一遍要做什么，不写任何东西
./sync.sh               # 真正安装
```

更新就是同一个命令：

```bash
cd paper-preset && git pull && ./sync.sh
```

出问题回滚：

```bash
./sync.sh --rollback
```

`DSH_HOME` 默认 `~/.dsh`，装在别的路径就 `DSH_HOME=/opt/dsh ./sync.sh`。

### 生效方式（重要）

**新开一个会话就生效，不需要重启 DSH。** 已经打开的会话继续用旧版本，不会被中断。

---

## 二、给维护者：改完这么发布

```bash
# 1. 改 preset/ 下的文件
# 2. 重新生成校验和（必须，否则 sync.sh 会拒绝安装）
cd preset && find . -type f -print0 | sort -z | xargs -0 sha256sum > ../checksums.txt && cd ..
# 3. 更新版本号
echo "0.2.0" > VERSION
# 4. 提交并打 tag
git add -A && git commit -m "paper preset 0.2.0" && git tag paper-v0.2.0 && git push --follow-tags
```

> `checksums.txt` 里的路径是相对 `preset/` 的，生成时必须在 `preset/` 目录里执行上一条命令。

### 商用前必改的三处

| 位置 | 现状 | 要改成 |
|---|---|---|
| `preset/paper-refs.mjs` 的 `CONTACT_EMAIL` | `noreply@example.com` | **你真实的、有人看的邮箱**。OpenAlex / Crossref / DataCite 免费，但会按这个地址联系你；填错等于等着被静默限流 |
| `preset/paper-refs.mjs` 的 `CONCURRENCY` | `4` | 客户量大时下调；一批 `.bib` 每条最多 2 个请求 |
| `preset/preset.yml` 的 `name` / `description` | 论文模式 | 按你的产品命名 |

---

## 三、两个必须知道的技术事实

这两条是读 DSH `dsh-agent-presets` 源码确认的，不是猜的。

### 1. DSH 靠「composition 文件的 mtime + size」判断 preset 是否过期

```js
async function compositionStamp(path) {
  const { mtimeMs, size } = await stat(path)   // path = agent.cordis.yml
  return { mtimeMs, size }
}
```

也就是说：

- **只换 `.mjs` 或 `skills/` 里的文件，DSH 不会察觉**，新会话仍然跑旧代码，更新静默失效。
- 换完必须 **`touch agent.cordis.yml`**，`sync.sh` 已经替你做了，**别删那一步**。
- 新会话拿到新版本；**已挂载的旧会话保持旧版本**，进程内不会被回收（所以更新不会打断在用的客户）。

### 2. `.mjs` 在 DSH host 进程里执行

preset 里的 `.mjs` 是**真实代码**，跑在 DSH 主进程里，权限等同于启动 DSH 的那个用户。

**所以「让客户在对话里叫 agent 从网上拉最新版并自动安装」这个流程，本质上是把远程代码执行权交给了一个仓库。** 谁能往那个仓库提交（或者谁拿到你的 GitHub 账号、或者中间人），谁就能在所有客户机器上执行任意代码。

建议：

- **用 `sync.sh`，不要让 LLM 决定装什么。** agent 最多帮你跑这个脚本并汇报输出。
- 仓库保持私有，或者发布用只读 token。
- 发布打 **signed tag**，客户锁 tag 而不是跟 `main`。
- `checksums.txt` 提供的是完整性（传输没坏、没被换），**不是真实性**（是不是你发的）——真实性靠签名 tag 或私有仓库。
- 客户侧如果开着沙箱/审批，写入 `~/.dsh` 在会话工作目录之外，本来就需要授权；让运维跑脚本比让 agent 越权干净。

---

## 四、依赖与合规

- **外部 API**：OpenAlex（主检索）、Crossref（DOI）、DataCite（arXiv 的 `10.48550/*` DOI 只在 DataCite）。三者免费、无 key。**无 SLA**——上游挂了或改了，这个功能就会降级；工具会明确报 `service_error` 而不是假装通过。
- **中文文献**：知网没有开放 API，核验不了。工具会把这类条目标成查不到，需要人工判断，**这是限制不是 bug**。
- **许可证**：本分发的内容为原创实现。设计思路上参考了公开发表的写作与科研诚信文献（Gopen & Swan、Widom、Ernst、Lu et al. 等），属思想与事实引用，不受版权限制。
  ⚠️ **若你日后要把 `academic-research-skills` 的内容并进来**：那是 **CC BY-NC 4.0**，禁止商用；`research-agora`、`thesis-writer` 是 MIT，可商用但需保留版权声明。

---

## 五、目录

```
.
├── VERSION            版本号
├── checksums.txt      preset/ 下每个文件的 sha256
├── sync.sh            安装 / 更新 / 回滚
├── README.md
└── preset/            整个 preset（原样复制到 ~/.dsh/.agent-presets/paper/）
    ├── agent.cordis.yml
    ├── preset.yml
    ├── paper-policy.mjs
    ├── paper-refs.mjs
    ├── paper-commands.mjs
    └── skills/
        ├── citation-integrity/SKILL.md
        ├── paper-writing-craft/SKILL.md
        └── chinese-academic/SKILL.md
```
