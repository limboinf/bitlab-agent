# 发布、更新与遥测

开源仓库中的 Release 候选会构建 macOS DMG/ZIP、Windows NSIS、Linux AppImage 与各平台 headless server；对应的 annotated tag 只负责晋升这批精确且已验证的产物。源码与可下载产物统一放在 [limboinf/bitlab-agent](https://github.com/limboinf/bitlab-agent/releases/latest)。签名凭证是可选的：零 secret 候选会生成 ad-hoc 签名的 macOS 包和未签名 Windows 安装包；某个平台的完整凭证会自动启用 Apple Developer ID 签名与公证或 Windows Authenticode。

## 发布流水线

```text
  main ──▶ release:prepare ──▶ 审核版本提交
                                      │
                                      ▼
                           手动运行 Release 候选构建
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
                校验与测试                      四平台构建 + 签名/公证
                   └──────────────────┬──────────────────┘
                                      ▼
                       与 commit SHA 绑定并带 checksum 的候选包
                                      │
                                      ▼
                           在同一提交创建带注释的 v* tag
                                      │
                                      ▼
                        校验 provenance 后直接发布，不再重建
```

安装包、manifest（如 `latest-mac.yml`、`latest.yml`、`latest-linux.yml`）、blockmap、checksum 和版本说明统一放在主仓库的 GitHub Releases 中，不提交进 Git；不再使用单独的 release-only 仓库。

Pull Request 和推送到 `main` 的提交会运行未签名打包矩阵，覆盖 macOS arm64、Windows x64 和 Linux x64。对应的验证安装包与 headless server 压缩包会作为 GitHub Actions artifacts 保留 7 天。手动运行 Release workflow 会按当前签名策略只构建一次完整发布候选，并保留 30 天。只有位于候选精确提交上的 `v*` tag 才能把这批产物长期发布到 GitHub Release；tag workflow 会验证 provenance 与 checksum，不会重新构建四个平台。

## 版本与 Changelog 规范

Bitlab 使用语义化版本和 `v<major>.<minor>.<patch>` tag。[`CHANGELOG.md`](../../CHANGELOG.md) 是累计变更记录的唯一来源。Tag workflow 会提取对应版本段作为公开 GitHub Release 的说明。

只从干净的 `main` 分支准备版本：

```bash
# 先把 CHANGELOG.md 中 Unreleased 的占位文字替换为真实变更。
bun run release:prepare 0.2.0
bun run release:check v0.2.0
git diff --check
git add CHANGELOG.md package.json bun.lock apps/*/package.json packages/*/package.json
git commit -m "chore(release): prepare v0.2.0"
git push origin main
```

`release:prepare` 会同步所有 workspace package 版本、刷新 `bun.lock`，并把 Unreleased 内容移入带日期的版本段。推送审核后的提交后，在 **Actions** → **Release** → **Run workflow** 中填写 `v0.2.0`。候选构建全绿后，再给同一个提交打 tag：

```bash
git tag -a v0.2.0 -m "Bitlab v0.2.0"
git push origin v0.2.0
```

Tag workflow 会拒绝版本元数据不一致、候选来自其他提交或 workflow run、Artifact 已过期，以及任何 checksum 不匹配的情况。

### 首次发布

`release:prepare` 要求新版本必须严格大于 `package.json` 中的当前版本。所有 manifest 已经是 `0.1.0`，所以用它去 prepare `0.1.0` 会被设计性地拒绝——没有东西可以 bump。首发时先校验并推送现有版本提交，构建候选，再给同一个提交打 tag：

```bash
# CHANGELOG.md 里已经有带日期的 [0.1.0] 段。
bun run release:check v0.1.0
git push origin main
# 在 Actions → Release 中填写 v0.1.0，等待候选构建成功。
git tag -a v0.1.0 -m "Bitlab v0.1.0"
git push origin v0.1.0
```

从下一个版本起，一律走 `release:prepare`。

### 构建并晋升发布候选

耗时的工作只在打 tag 前执行一次。通过 **Actions** → **Release** → **Run workflow** 填入准备发布的稳定版本 tag。workflow 先做轻量版本检查，再并行执行完整校验与四平台构建矩阵。签名凭证完整时自动启用对应平台签名；macOS 签名与公证仍属于候选构建的一部分。

候选包含安装包、headless server bundle、manifest、签名状态、`SHA256SUMS` 与 `BUILD_PROVENANCE.json`。Artifact 名称同时包含目标 tag 和完整 commit SHA，保留 30 天；此时不会创建公开 Release。

审核候选成功结果后再推送 annotated tag。Tag workflow 会按 tag 与 SHA 查找精确候选，验证它来自这条 Release workflow 的成功手动运行，重新检查 provenance 和全部 checksum，然后将同一批产物发布为 Latest，不做重建。若没有精确且未过期的候选，tag job 会明确失败并提示先构建候选，绝不会偷偷选另一次运行的包。

## 安装包矩阵

| 平台                    | 构建                     | 命名                               | 签名                               | 备注                                                                                  |
| ----------------------- | ------------------------ | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| macOS arm64             | DMG + ZIP                | `Bitlab-0.1.0-arm64.{dmg,zip}`    | ad-hoc 或 Developer ID + 公证      | 无证书构建关闭 Hardened Runtime，并且需要手动更新                                      |
| macOS x64               | DMG + ZIP                | `Bitlab-0.1.0-x64.{dmg,zip}`      | 同上                               | 给 Intel Mac 用                                                                       |
| Windows x64             | NSIS                     | `Bitlab-0.1.0-x64.exe`            | 未签名或 Authenticode              | 未签名构建可能触发 SmartScreen；每用户安装到 `%LOCALAPPDATA%\Programs\`              |
| Linux x64               | AppImage                 | `Bitlab-0.1.0-x86_64.AppImage`    | 无                                 | AppImage 的 `x64` 会被 electron-builder 渲染成 `x86_64`;desktop 类别:Utility          |
| Headless server(每架构) | `bun build --compile`    | `bitlab-server-<platform>-<arch>` | 无                                 | 给 WebUI 与外部 RPC 客户端消费                                                        |

`bun run electron:dist:dev:mac` 会生成本地 ad-hoc 签名构建并关闭自动更新。Release job 在缺少 Apple 凭证时也会显式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`、`mac.identity=-` 与 `hardenedRuntime=false`。ad-hoc 签名满足 Apple Silicon 的代码完整性要求，但不代表受信任开发者身份，因此仍会出现 Gatekeeper 警告。

## 更新

Electron 通过 `electron-updater` 命中 `limboinf/bitlab-agent` 上的 GitHub Releases API。公开仓库及其更新 manifest 不需要客户端携带 GitHub token。

| 字段         | 设置位置                                                     |
| ------------ | ------------------------------------------------------------ |
| `appId`      | `apps/electron/electron-builder.yml` → `app.bitlab.desktop` |
| Provider     | `github`                                                     |
| Owner / repo | `limboinf` / `bitlab-agent`                                     |
| Manifest     | 由 electron-builder 在 release 时自动生成                    |

降级需要手动装老版本;自动更新只会往前走。

macOS 自动更新要求应用具有 Developer ID 签名。因此，ad-hoc macOS 构建会跳过启动更新检查，并在用户手动检查时引导其前往最新 GitHub Release；这类用户需要手动下载下一个 DMG。Windows 与 Linux 继续使用各自的正常 updater target。

## 跨 builder 可复现性

`electron-builder.yml` 的 `files` / `extraResources` 块是 Lite 边界的一等产物,它们决定了 Bitlab 更小的安装包体积;具体数字见 [`comparison-with-craft.md`](./comparison-with-craft.md)。发布前对其中任一块的改动都必须同时更新该文档,以及同文件顶部的 `appId` / `productName` / `copyright`。

## GitHub 发布环境

workflow 在没有签名 secret 时也能工作。若要启用受信任的平台构建，请创建受保护的 Actions environment `release`，并完整配置需要的平台凭证组：

| Secret                                                     | 用途                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `CSC_LINK`、`CSC_KEY_PASSWORD`                             | Developer ID 证书及密码；必须与全部 Apple 字段一起配置                                   |
| `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | Apple 公证；五个 Apple secret 全部存在时启用 macOS 签名与公证                            |
| `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD`                     | 两个 secret 都存在时启用 Windows Authenticode                                            |

[code-signing.md](./code-signing.md) 完整讲了如何创建 Developer ID Application 证书、导出并编码成上面这些 secret，以及在代码签名私钥必须存放于硬件的今天，Windows 这边该怎么办。

凭证组完全缺失时进入无证书模式：macOS 使用 ad-hoc 签名，Windows 生成未签名安装包。只配置一部分会在构建开始前失败，避免 secret 拼写错误导致原本计划可信签名的版本静默降级。每个 Release 都会在正文和 `SIGNING_STATUS.txt` 中记录最终的平台信任模式，该文件也纳入 `SHA256SUMS`。候选 workflow 只使用仓库只读权限，签名仅在受保护的 `release` environment 中完成。Tag 晋升 job 才获得 `actions: read` 与 `contents: write`，创建 draft Release、上传精确候选，并在全部成功后发布为 Latest。晋升失败后可重跑并更新 draft，但不会覆盖已经发布的版本。

## 发布前 checklist

```bash
git status --short                # 工作区干净
git log -n 5 --oneline            # 检查版本 bump 与其 commit
bun run release:check v0.2.0
bun run audit:brand
bun run validate:ci
bun run typecheck:all
bun run test
bun run electron:build
bun run webui:build
bun run server:build:subprocess
```

Checklist 通过后，在这个精确提交上运行 Release 候选 workflow。构建候选前，应当把需要的平台签名凭证组配置完整；如果有意发布未签名版本，则保持该组全部为空。候选成功后再创建 tag。
