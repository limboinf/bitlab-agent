# Code signing and notarization

Bitlab 在没有任何签名凭据的情况下也能正常发布：macOS 走 ad-hoc 签名，Windows 安装包不签名。
这条路是被正式支持的，但代价由用户承担——首次启动会看到 Gatekeeper 或 SmartScreen 警告，
并且 macOS 的自动更新会被关闭。本文说明如何从这个默认状态升级到可信安装包。

签名按平台独立判定，且每个平台是「要么全配、要么不配」。`release-policy` job 会在某一组凭据
只配了一半时直接失败，避免一个拼写错误把本该可信的构建悄悄降级。这套判定如何贯穿整个工作流，
见 [releases.md](./releases.md)。

| 平台 | Secrets 组 | 配置后的效果 |
| --- | --- | --- |
| macOS | `CSC_LINK`、`CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | Developer ID 签名 + 公证，Hardened Runtime 开启，自动更新启用 |
| Windows | `WIN_CSC_LINK`、`WIN_CSC_KEY_PASSWORD` | Authenticode 签名 |
| Linux | 无 | AppImage 从不签名，完整性由 `SHA256SUMS` 保证 |

## macOS

### 前置条件

- 付费的 **Apple Developer Program** 会员（个人或组织均可）。免费 Apple ID 无法签发
  Developer ID 证书。
- 一台装有 Xcode 或 Xcode Command Line Tools 的 Mac。

证书类型必须是 **Developer ID Application**。同一个账号下的 `Apple Development` 和
`Mac App Distribution` 看起来很像，但它们都无法让 App Store 之外分发的应用通过 Gatekeeper，
公证也会被拒。

### 1. 创建 Developer ID Application 证书

Xcode 路径更短，私钥会自动生成：

1. Xcode → **Settings** → **Accounts** → 选中你的 Apple ID → **Manage Certificates…**
2. 点 **+** → **Developer ID Application**。
3. 证书和私钥会落进 login 钥匙串。

如果你更习惯网页控制台，或者 Xcode 因为账号证书数量达到上限而拒绝创建：

1. 打开 **钥匙串访问** → 菜单 **证书助理** → **从证书颁发机构请求证书…**
2. 填入邮箱和名称，选择 **存储到磁盘**，保存 `CertificateSigningRequest.certSigningRequest`。
3. 打开 [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates) → **+** → **Developer ID Application** → 上传 CSR。
4. 下载得到的 `.cer`，双击导入 login 钥匙串。

确认身份已存在，并记下括号里那十位 Team ID：

```bash
security find-identity -v -p codesigning
```

你要找的是形如 `Developer ID Application: Your Name (ABCDE12345)` 的一行。

### 2. 导出为 .p12

1. **钥匙串访问** → **login** 钥匙串 → **我的证书**。
2. 找到 `Developer ID Application: …` 并展开——下面必须挂着一个私钥。没有私钥的导出没有任何用处。
3. 右键证书 → **导出 "Developer ID Application: …"** → 格式选 **个人信息交换 (.p12)**。
4. 设一个强密码，它就是 `CSC_KEY_PASSWORD`。

### 3. 为 GitHub 编码 .p12

`CSC_LINK` 接受 base64 字符串形式的证书：

```bash
base64 -i ~/Desktop/bitlab-developer-id.p12 | pbcopy
```

把剪贴板内容粘进 secret。完事后把磁盘上的 `.p12` 删掉，或者收进密码管理器——那就是你的签名身份。

### 4. 为公证创建 App-Specific Password

真实的 Apple ID 密码在这里不管用，开启了双重认证的账号必须走这一步：

1. 登录 [appleid.apple.com](https://appleid.apple.com)。
2. **登录与安全** → **App 专用密码** → **+**。
3. 起个名字比如 `bitlab-notarization`，复制生成的 `xxxx-xxxx-xxxx-xxxx`。它只显示一次。

这个值就是 `APPLE_APP_SPECIFIC_PASSWORD`；`APPLE_ID` 是持有它的账号邮箱。

### 5. 找到 Team ID

要么从 `security find-identity` 输出的括号里读，要么打开
[developer.apple.com/account](https://developer.apple.com/account) →
**Membership details** → **Team ID**。它就是 `APPLE_TEAM_ID`。

组织账号要注意：用于公证的 Apple ID 必须属于持有该证书的团队。用一个带独立团队的个人 Apple ID
去公证，会因为 Team ID 对不上而失败。

### 6. 存入这五个 secret

在仓库里：**Settings** → **Environments** → `release` → **Add secret**。
发布 job 是从 `release` 这个 environment 读取凭据的，只把它们加在仓库级 secrets 里不会生效。

| Secret | 值 |
| --- | --- |
| `CSC_LINK` | `.p12` 的 base64 |
| `CSC_KEY_PASSWORD` | `.p12` 的导出密码 |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | 那串 `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | 十位 Team ID |

下一次打 tag 发布时会自动生效：`forceCodeSigning` 打开，Hardened Runtime 保持启用，
electron-builder 通过 `notarytool` 完成公证并装订（staple）票据，macOS 的
`BITLAB_AUTO_UPDATE_ENABLED` 变为 true。

### 7. 别拿一次正式发布去试签名

签名和公证可以先在本机彩排：

```bash
bun run electron:dist:mac
codesign --verify --deep --strict --verbose=2 "apps/electron/release/mac-arm64/Bitlab.app"
spctl --assess --type execute --verbose "apps/electron/release/mac-arm64/Bitlab.app"
xcrun stapler validate "apps/electron/release/Bitlab-0.1.0-arm64.dmg"
```

`spctl` 应当输出 `accepted` 且 `source=Notarized Developer ID`。出现 `rejected` 或
`source=Unnotarized Developer ID` 说明票据没有装订成功。

本机跑公证需要在 shell 里导出同样的凭据：

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
```

公证要往 Apple 服务器跑一个来回，每个产物通常耗时 2–15 分钟。一次发布会产出四个 macOS 产物
（两个 DMG、两个 ZIP），排期时要对着工作流 120 分钟的 job 超时留出余量。

### 常见失败

| 现象 | 原因 |
| --- | --- |
| CI 报 `No identity found` | `CSC_LINK` 不是合法 base64，或导出 `.p12` 时没带上私钥 |
| `The specified item could not be found in the keychain` | `CSC_KEY_PASSWORD` 错了 |
| 公证返回 `Invalid`，提示 `The signature does not include a secure timestamp` | Hardened Runtime 或时间戳被关掉了；签名构建不要再传 `-c.mac.hardenedRuntime=false` |
| 公证返回 `Invalid`，提示 `Team is not yet configured for notarization` | 该 Apple ID 不属于持有证书的团队 |
| 签名后应用仍提示「已损坏，无法打开」 | 票据没装订；用 `xcrun stapler validate` 复核 |

## Windows

Windows 现在比 macOS 更麻烦，而且不是工作流的锅。自 2023 年 6 月起，CA/Browser Forum 要求
代码签名私钥必须存放在 FIPS-140-2 硬件里——USB 令牌或云 HSM。也就是说，新签发的 OV / EV
证书不会再给你一个可导出的 `.pfx`，而 `WIN_CSC_LINK` 恰恰需要它。这两个 Windows secret
只在你手里已经有一张旧的可导出证书时才用得上。

现实的选项：

- **不签名直接发。** SmartScreen 会弹警告，用户通过 **更多信息** → **仍要运行** 绕过。
  随着下载量积累声誉，该二进制的警告最终会消失。这是目前的默认方式。
- **[Azure Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/)** —— 微软的
  托管签名服务，约每月 10 美元，不需要硬件令牌。需要通过法律主体验证，组织账号还要求三年以上
  经营历史。它的接入方式和 `WIN_CSC_LINK` 不同，需要写成 electron-builder 的自定义 `sign` 钩子。
- **[SignPath Foundation](https://signpath.org/)** —— 面向符合条件的开源项目，免费提供证书和
  签名基础设施。

如果你确实持有可导出的 `.pfx`，编码方式和 macOS 一样：

```bash
base64 -i certificate.pfx | pbcopy
```

把它存为 `WIN_CSC_LINK`，密码存为 `WIN_CSC_KEY_PASSWORD`，同样放在 `release` environment 下。
之后工作流会加上 `forceCodeSigning`，并用 `Get-AuthenticodeSignature` 校验每一个产出的 `.exe`。

## 用户拿到未签名产物怎么办

只要还在发未签名构建，这些说明就应该一直留在 release notes 里。

macOS 会以「Bitlab 已损坏，无法打开」拒绝 ad-hoc 签名的应用。问题出在 quarantine 属性，不是应用本身：

```bash
xattr -dr com.apple.quarantine /Applications/Bitlab.app
```

Windows SmartScreen：**更多信息** → **仍要运行**。

这两种情况都值得配合每次发布附带的 `SHA256SUMS` 一起给出，让谨慎的用户可以校验下载内容，
而不是盲目信任警告框：

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```
