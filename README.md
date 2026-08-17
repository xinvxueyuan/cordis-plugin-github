# cordis-plugin-github

[![npm version](https://img.shields.io/npm/v/@xinvxueyuan/cordis-plugin-github)](https://www.npmjs.com/package/@xinvxueyuan/cordis-plugin-github)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)](LICENSE-MIT)
[![GitHub](https://img.shields.io/github/stars/xinvxueyuan/cordis-plugin-github)](https://github.com/xinvxueyuan/cordis-plugin-github)

Cordis（DeepSeek Harness）插件：为 AI agent 注册规范化的 GitHub API 工具。
**默认经本机已登录的 gh CLI 执行（`gh api`，参数数组 spawn、不经 shell，杜绝引号/转义错误）；
gh 缺失或未登录时自动回退原生 HTTP（Node fetch + token）。**

覆盖 gh CLI 没有专门子命令的全部端点 —— 任意 REST 端点 + GraphQL 均可调用。

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