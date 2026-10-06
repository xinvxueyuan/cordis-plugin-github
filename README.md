# cordis-plugin-github

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-github)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-github)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-github)](https://github.com/xinvxueyuan/cordis-plugin-github)

> Cordis（DeepSeek Harness）插件：为 AI agent 注册规范化的 GitHub API 工具。

**默认经本机已登录的 gh CLI 执行（`gh api`，参数数组 spawn、不经 shell，杜绝引号/转义错误）；
gh 缺失或未登录时自动回退原生 HTTP（Node fetch + token）。**

覆盖 gh CLI 没有专门子命令的全部端点 —— 任意 REST 端点 + GraphQL 均可调用。

## 安全不变量与副作用披露

本插件是 GitHub API 的**透传层**，不隐藏任何破坏性能力。以下按真实实现逐条列出：

- **写操作会真实修改远端数据**：`github_api` 的 `POST` / `PATCH` / `PUT` / `DELETE` 直接作用于 GitHub 上的真实仓库与账号（包括更新引用、删分支、改 issue、上传 release asset 等），**没有 dry-run、没有二次确认、失败也不回滚**。调用前的确认责任在调用方。
- **`github_graphql` 同样是写通道**：它把 `query` 原样 POST 到 `/graphql`，因此里面写 GraphQL **mutation** 一样会真实改远端数据（并非只读查询工具）。
- **会 spawn 本机外部命令**：gh 后端会启动 `gh api`（参数以数组传递，不经过 shell）。`mode: auto` 下还会先执行 `gh --version` 与 `gh auth status` 各一次（各 5 秒超时）来判断 gh 是否可用。
- **会在系统临时目录落一个文件**：带 `body` 的 gh 调用会把 JSON 请求体写入 `<系统临时目录>/cordis-gh-*/body.json`，供 `gh api --input` 读取；调用结束（含抛错）即在 `finally` 中递归删除该临时目录。
- **需要凭据**：gh 后端依赖 `gh auth login` 的登录态；HTTP 回退按 `tokenEnv` → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` 的顺序解析 token，并以 `Authorization: Bearer` 请求头发送。token **只进环境变量与请求头，插件从不打印它**；两者都拿不到时抛 `status: 401` 的错误。
- **网络出口仅限目标 GitHub 主机**：HTTP 回退只请求 `https://<host>/<endpoint>`（默认 `api.github.com`，企业版用配置的 `host`），不经过任何第三方服务。
- **会把远端数据带回模型上下文**：工具返回值（含 `paginate` 合并后的数组、`raw: true` 的原始文本）会进入 agent 上下文；对大型仓库列表或原始文件调用一次就可能占用大量 token。
- **不自动重试**：限流（403/429）不会被自动重试或退避，错误对象里附 `rateLimitReset`（epoch 秒）供调用方自行等待。
- **不碰本地 git 状态**：插件不执行 clone / commit / push / checkout，也不读写当前仓库的工作区（临时目录除外）。

## 安装

在 profile 的 `cordis.patch.yml` 中插入（路径用绝对路径，loader 直接加载 TS 源码）：

```yaml
- insert:
    - id: github
      name: 'C:/dev/dsh/src/index.ts'
      config:
        mode: auto
```

重启后 agent 即可调用 `github_api` 与 `github_graphql`。

## 配置（Config）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `auto` | `auto`：gh 已安装且已登录则走 gh，否则 HTTP；`gh` / `http` 强制后端 |
| `ghPath` | `gh` | gh 可执行文件路径 |
| `host` | `api.github.com` | HTTP 回退的 API 主机（企业版填 `github.example.com`） |
| `tokenEnv` | `` | 持有 token 的环境变量名（如 `GH_TOKEN`）；HTTP 回退时按 tokenEnv → `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token` 顺序解析 |
| `timeoutMs` | `60000` | 单次调用超时（同时作为工具的 `timeoutMs` 预算） |
| `maxPages` | `50` | 分页页数上限（防失控），超出截断 |
| `perPage` | `100` | 分页每页条数 |

## 工具

### `github_api`（任意 REST 端点）
- `endpoint`（必填）：不带前导斜杠，如 `repos/owner/repo/issues`
- `method`：GET / POST / PATCH / PUT / DELETE / HEAD（默认 GET）
- `query`：查询参数对象
- `body`：JSON 请求体（写操作）
- `paginate`：自动翻页合并数组（默认 per_page=100，最多 maxPages 页）
- `raw`：以原始文本返回响应体（raw 文件内容、tarball 等非 JSON 端点）
- `host`：单次调用覆盖 API 主机

### `github_graphql`
- `query`（必填）：GraphQL 查询
- `variables`：查询变量对象（可选）
- `host`：覆盖 API 主机

## gh 无子命令的常用端点速查

| 领域 | 端点示例 |
| --- | --- |
| Actions | `repos/{o}/{r}/actions/runs`、`.../actions/runs/{id}/jobs`、`.../actions/artifacts`、`.../actions/workflows/{id}/dispatches`（POST） |
| Codespaces | `user/codespaces`、`user/codespaces/{name}/start`（POST） |
| Environments | `repos/{o}/{r}/environments`、`.../environments/{name}/secrets` |
| Org | `orgs/{org}/members`、`orgs/{org}/teams`、`orgs/{org}/audit-log`、`orgs/{org}/actions/runner-groups` |
| Repos | `repos/{o}/{r}/commits`、`.../compare/{base}...{head}`、`.../contents/{path}`（raw: true）、`.../releases`、`.../releases/{id}/assets`（POST 上传） |
| Issues/PR | `search/issues?q=...`、`repos/{o}/{r}/issues/{n}/timeline`、`.../labels`、`.../milestones` |
| 用户/杂项 | `user/gists`、`notifications`、`user/ssh_keys`、`rate_limit`、`meta` |

## 边界与已知限制

- **只是 API 透传，不是 gh 的高层封装**：不实现 `gh pr create` / `gh release create` 这类子命令语义，只表达 `gh api` 能表达的一次 HTTP 调用。
- **必须已认证**：`gh` 未登录且 `tokenEnv` / `GH_TOKEN` / `GITHUB_TOKEN` / `gh auth token` 全都拿不到 token 时，两条后端都不可用（抛 `status: 401`）。此时 `mode: gh` 不会静默回退 HTTP，而是直接报错。
- **`raw: true` 不是二进制通道**：raw 请求走 `Accept: application/vnd.github.raw+json` 并返回**文本**；gh 后端的 stdout 按 UTF-8 解码，因此 tarball 之类的二进制响应无法被无损取回。另外 `raw: true` 时 `paginate` 不生效（raw 不做翻页）。
- **分页有硬上限**：`paginate` 按 `page` / `per_page` 循环，最多 `maxPages` 页；触顶时返回值带 `truncated: true`，不会继续翻页。
- **超时是调用级预算**：`timeoutMs`（默认 60s）既是工具的调用预算，也是 HTTP 回退下每次 fetch 的超时；gh 后端自身不设子进程超时，只由工具层的取消信号终止。分页页数多时整体可能触及调用预算而中止。
- **非 JSON 端点必须显式 `raw: true`**：否则解析失败并抛错（错误信息会提示改用 raw）。
- **`host` 只影响 API 主机名**：HTTP 回退固定使用 `https://`，不支持自定义端口、自签证书或代理设置。
- **GraphQL 不做游标分页**：`github_graphql` 是单次查询直通，连接（connection）分页需要调用方自己在 `query` 里写 `after` 游标。
- **`gh` 的可用性是探测式判定**：`auto` 模式用 `gh --version` + `gh auth status` 判定，判定失败就静默回退 HTTP，不会区分"没装 gh"和"装了但坏了"。
- **企业版细节交给 gh**：`--hostname` 只透传给 gh，多主机凭据管理不在插件职责内；HTTP 回退使用单一 `host` 配置。

## 开发

```sh
npm install
npm run typecheck   # tsc 类型检查（erasable-syntax-only，兼容 Node 原生 type stripping）
npm test            # 单元 + 注册测试（无网络）
npm run test:integration  # 只读集成冒烟：gh/http/404/分页/GraphQL（需要 gh 或 token）
```

## 设计要点

- **不经 shell**：gh 与子进程参数均以数组传递（`spawn`），请求体写临时文件经 `--input`，无任何引号/转义注入面。
- **错误契约**：失败抛 `GithubApiError`（`status` + 消息；403/429 附 `rateLimitReset`）；404 与空列表区分；非 JSON 响应需 `raw: true`。
- **分页统一**：两条后端都按 `page`/`per_page` 循环，遵守 `maxPages` 上限。
- **取消**：工具执行尊重 `exec.signal`（spawn 挂 signal；fetch 用 `AbortSignal.any` 合并超时）。
- **安全**：token 只进环境变量/请求头，永不打印。

## npm 发布（@xinvxueyuan/cordis-plugin-github）

- **仓库**: https://github.com/xinvxueyuan/cordis-plugin-github
- **npm**: `npm install @xinvxueyuan/cordis-plugin-github`
- **许可**: MIT OR Apache-2.0（见 LICENSE-MIT / LICENSE-APACHE）

通过 npm 包接入 Harness 时，先安装到 profile：

```sh
dsh plugin add @xinvxueyuan/cordis-plugin-github
```

再在 `cordis.patch.yml` 中引用包名（替代 file URL）：

```yaml
- insert:
    - id: github
      name: '@xinvxueyuan/cordis-plugin-github'
      config:
        mode: auto
```

### 发布流程（维护者）— staged publishing

> 采用 npm **staged publishing**：CI 用 `npm stage publish`（OIDC 可信发布，无需 token / 2FA）
> 把版本放入 registry 的 **stage 队列**，维护者用 **2FA** 批准后版本才真正上线（proof-of-presence）。

```sh
# 1) 构建 + 本地核对
npm run build
npm pack --dry-run

# 2) 打标签推送 → GitHub Actions 自动跑测试 + npm stage publish（进入 stage 队列）
git tag v0.1.x && git push origin main --tags

# 3) 人工 2FA 批准上线
npm stage list @xinvxueyuan/cordis-plugin-github   # 取 <stage-id>
npm stage approve <stage-id>                       # 需要 2FA
```

（旧版 `npm publish` 直发流程已被 CI 的 staged 流程取代。）

`publish.yml` 在两个发布 job 前都有幂等守卫：先用 `npm view "<包名>@<package.json 的 version>" version`
判断该版本是否已存在于目标 registry，已存在就跳过发布（并在 Step Summary 写明"该版本已存在，跳过发布"），
因此对已发布版本重推 tag 不会产生必然失败的公开红叉。其它检查错误（网络、鉴权、registry 故障）仍会让 job 失败。

### GitHub Release 与签名

> **现状（务必如实理解）**：以下机制描述的是**已经写进本仓库、但尚未实际执行过**的流程。
> 截至写下这段文字，本仓库**还没有产生过任何 GitHub Release**，所以下面没有任何"已发布"的既成事实。

| 环节 | 将采用的机制 |
| --- | --- |
| tag | **annotated 且 GPG 签名**的 tag（`git tag -s`），GitHub 上会显示 **Verified** 徽标。tag 由维护者在本机用私钥创建并推送，**私钥永不进入 CI**。 |
| Release 附件 | `.github/workflows/release.yml` 在 tag 推送（或手动 `workflow_dispatch` 指定 tag）时执行 `npm pack`，把产出的 `*.tgz` 与 `SHA256SUMS` 上传为 Release 附件。Release 标题即 tag，正文由 `gh release create --generate-notes` 依据 commit 列表自动生成。 |
| 校验和 | `SHA256SUMS` 记录该 tgz 的 sha256（工作流内以 `sha256sum -c` 自校验）。 |
| 校验和的分离签名 | 维护者在本机用**私钥**对 `SHA256SUMS` 生成分离签名 `SHA256SUMS.asc`（`gpg --armor --detach-sign SHA256SUMS`），再手工把 `.asc` 附到 Release 上。**这一步目前没有自动化**，私钥也不进 CI；校验方用 `gpg --verify` 验签。 |
| 构建来源证明 | `release.yml` 调用 `actions/attest-build-provenance`（pin 到 commit SHA），为 **tgz 与 SHA256SUMS 两者**生成 Sigstore 签名的 SLSA 构建来源证明，可用 `gh attestation verify` 校验。 |
| npm 侧 | `release.yml` **完全不执行任何 npm publish**；npm 发布只由上面的 `publish.yml` staged publishing 负责。 |

维护者操作顺序（**尚未执行过**）：

```sh
# 1) 本机确认工作区干净、package.json 的 version 已就位（版本号由发布者手工提升）
git status --porcelain

# 2) 创建 annotated + GPG 签名 tag（私钥仅在本机使用；本机需能完成 GPG 签名）
git tag -s v0.1.3 -m "v0.1.3"

# 3) 只推 tag —— release.yml 会构建产物、生成来源证明并创建 Release
git push origin v0.1.3
```

校验方式：

```sh
# 校验附件未被篡改
sha256sum -c SHA256SUMS

# 校验分离签名（需要维护者的公钥）
gpg --verify SHA256SUMS.asc SHA256SUMS

# 校验构建来源证明（需要 gh CLI）
gh attestation verify xinvxueyuan-cordis-plugin-github-0.1.3.tgz --repo xinvxueyuan/cordis-plugin-github
gh attestation verify SHA256SUMS --repo xinvxueyuan/cordis-plugin-github
```

补充说明：

- `release.yml` 使用 `gh release create --verify-tag`，**要求 tag 已存在、不会自行创建 tag**；重复运行会转为"覆盖上传附件"。
- 所有 workflow 的 `uses:` 都 pin 到完整 40 位 commit SHA（当前：`actions/checkout` v4.4.0、`actions/setup-node` v4.4.0、`actions/attest-build-provenance` v4.2.2），由 `.github/dependabot.yml` 的 `github-actions` 生态负责推进。

## 许可

本仓库采用 **MIT OR Apache-2.0** 双许可（与 `package.json` 的 `license` 字段一致），
许可证原文见 [LICENSE-MIT](LICENSE-MIT) 与 [LICENSE-APACHE](LICENSE-APACHE)。
