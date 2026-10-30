# Browser Flock · 浏览器群

**让 DeepSeek Harness 管理多个独立的本机浏览器实例。**

中文 | [English](README.en.md)

为不同账号创建独立的浏览器数据目录，通过 AI 批量启动实例、配置代理、加载相同扩展，并录制浏览器操作及 HTTP 请求。持久实例保留各自的登录状态，临时实例在确认退出后删除数据。

> Windows · `0.1.2` · DeepSeek Harness `0.2.1-rc.5` · MIT
>
> 主要适配 **Windows + Chrome**。Edge、Brave、Firefox 做过有限实机验证，仍有已知问题；macOS / Linux 当前不支持。

## 解决什么问题

在同一台电脑上操作多个账号时，共用浏览器数据容易造成登录状态混淆。Browser Flock 为每个实例分配独立 profile，让 DeepSeek Harness 能够创建、管理和连接这些实例。

每个实例分别保存 Cookie、网站数据、账号登录状态和扩展存储。可以为不同实例设置不同代理，也可以让多个实例使用同一份扩展代码。**这是浏览器数据隔离，不提供虚拟机、系统级安全隔离或浏览器指纹伪装。**

## 功能

| 功能 | 说明 |
| --- | --- |
| 本机浏览器识别 | 发现 Chrome、Edge、Brave、Firefox，核对程序身份，支持手动登记 |
| AI 批量管理 | AI 连续调用工具创建、重开、关闭、重命名或删除多个实例 |
| 独立账号环境 | 持久与临时 profile，不接管日常浏览器的数据目录 |
| 按实例配置代理 | 系统代理、直连、HTTP / SOCKS5 预设；创建多个实例时分别应用 |
| 扩展中心 | 从受管理实例收录扩展代码，在多个 Chromium 实例加载，数据彼此独立 |
| CDP 连接 | 提供经核验的本机连接地址，供 AI 编写的脚本或 Playwright 等客户端使用 |
| 浏览器操作录制 | 采集点击、输入、导航、HTTP 请求/响应，支持同一 Harness profile 的其他对话读取 |
| 中英文管理页 | 管理实例、浏览器、代理、扩展和录制 |

批量操作通过 AI 编排多次工具调用完成，目前没有独立的“一键批处理”工具。代理配置在创建时复制到实例，修改预设不会更改已有实例；运行中的实例不支持直接切换代理。

## 适配范围

| 环境 | 当前状态 |
| --- | --- |
| Windows + Chrome | 主要开发与测试环境 |
| Windows + Edge / Brave | 有限实机测试通过 CDP、录制、扩展数据隔离及重开恢复；Brave 普通关闭存在超时 |
| Windows + Firefox | 验证过发现、持久实例生命周期及 HTTP 代理；不支持本插件的 CDP、录制和扩展中心 |
| macOS / Linux | 当前 Host 会拒绝加载，欢迎后续开发适配 |

v0.1.2 已在 Harness `0.2.1-rc.5` 依赖下通过构建、语法检查和 **141/141 项自动化测试**，恢复并内嵌四种浏览器的品牌图标。rc.5 适配阶段已验证本机安装、AI 查询工具、Client 插槽注册与原有数据读取；图标修复后的页面视觉效果尚未重新核验。此前 rc.3 的 Windows 实机测试中，四浏览器 HTTP 代理通过，三种 Chromium 的录制和扩展集成断言通过。完整范围与未通过项见 [测试说明](docs/TESTING.md)。这些结果不代表所有浏览器版本、扩展或网站都兼容。

## 安装

1. 安装 **DeepSeek Harness `0.2.1-rc.5`**，并自行安装 Chrome 等浏览器。开发及独立脚本需要 Node.js 22+。旧版插件 v0.1.0 对应 Harness rc.3。
2. 从 [GitHub Releases v0.1.2](https://github.com/Lmg66/dsh-browser-flock/releases/tag/v0.1.2) 下载 `local-dsh-browser-flock-0.1.2.tgz`，保存到本机；可用随附 SHA-256 校验值核对。也可从源码执行 `pnpm install --frozen-lockfile --ignore-scripts`、`pnpm pack --pack-destination releases` 生成。
3. 在 Harness 对话中发送，替换为文件实际路径：

```text
请用 plugin_manager 的 install_bundle 安装这个浏览器群插件：
C:\Downloads\local-dsh-browser-flock-0.1.2.tgz
请检查安装结果中的 application、warnings 和 nextStep。
若返回 already-installed，先用 remove_bundle 移除 @local/dsh-browser-flock 的安装登记，再安装新包；保留原有浏览器数据目录。
```

安装应用成功后刷新 Harness 页面，在侧栏寻找 **浏览器群 / Browser Flock**。

本仓库保留 `@local/dsh-browser-flock` 插件标识和 `private: true`，通过 GitHub 与本地 `.tgz` 分发，不要求发布到 npm。安装时仍需解析所声明的 DSH 依赖。升级前先停止正在进行的录制；不要为了升级直接删除浏览器数据。

## 使用方法

### 1. 创建独立账号环境

打开“实例”，选择本机浏览器，创建持久实例，在新窗口中自行登录。下次重开同一个实例可继续使用它保存的登录状态。

也可以直接让 AI 操作：

```text
请先列出本机浏览器，再创建 3 个持久 Chrome 实例，
分别命名为工作账号 A、工作账号 B、测试账号。返回各实例 ID。
```

### 2. 批量配置代理

在“代理预设”保存主机与端口，新建实例时选择预设。或让 AI 创建预设并在多次创建调用中复用它：

```text
请保存一个 HTTP 代理预设，名称为本地代理，主机 127.0.0.1，端口 7890。
用这个预设新建 3 个持久 Chrome 实例。
```

示例端口仅供演示，需对应实际运行的代理。支持 HTTP / SOCKS5；暂不支持代理账号密码、PAC。不会修改 Windows 全局代理或安装根证书；回环地址可能按浏览器默认规则绕过代理。

### 3. 给多个实例加载相同扩展

先在一个受管理的 Chromium 实例安装所需扩展，再到“扩展中心”扫描、收录并加载到目标实例。AI 也可查询扩展库 ID，在创建每个实例时传入相同的 `extension_library_ids`。

只复制扩展代码，不复制账号、Cookie 或扩展存储。实例各自保存代码副本，删除扩展库中的条目不会影响已安装实例、待启动加载或重开。扩展版本不会自动随商店更新；依赖固定 ID、原生通信或商店身份的扩展可能不兼容。

### 4. 控制页面与录制操作

AI 可通过 `get_browser_instance_cdp` 获取 Chromium 实例当前连接地址，再使用兼容的 CDP 客户端控制页面。地址仅监听本机，重开后端口可能变化，不要缓存。

在实例详情开始录制，操作浏览器后停止；到“录制”页查看事件和 HTTP 详情。也可以让另一段同 profile 的 AI 对话列出并读取已有录制。

**录制会原样保存输入值（包括密码）、Cookie、Authorization 请求头及请求/响应正文。** 录制保存在本机，同 profile 的 AI 可通过工具读取。分享录制前自行检查其中的敏感数据，不要提交到公开仓库。

录制不是完整网络抓包或自动回放：存在正文大小与事件数量限制，缺失/截断会标记；暂不采集 WebSocket 帧和控制台日志，部分 Worker 流量或新目标接入前的活动可能缺失。

### 数据保存与删除

浏览器数据位于当前 Harness profile 的 `data/browser-flock`，跨对话保留。卸载插件不会主动关闭实例或删除数据。持久实例需显式删除；临时实例确认退出后清理。录制独立存储，删除浏览器实例不会删除录制。

## 项目结构

```text
.
├── src/
│   ├── host/            # 生命周期、代理、扩展、录制、服务和 AI 工具
│   │   └── platform/    # Windows 进程核验、窗口标识
│   ├── client/          # 管理界面、原创浏览器字母图标
│   └── shared/          # 参数校验、RPC、错误定义
├── locale/              # 中英文插件元数据
├── test/                # 回归测试（两处均保留）
├── tests/
├── scripts/             # 构建、检查、实机验证
├── docs/                # 测试说明、截图、发布文案
├── client.js            # 自动生成的客户端产物
├── cordis.patch.yml     # DSH bundle 注册入口
├── package.json
└── LICENSE
```

## 开发与二次开发

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run check
pnpm test
pnpm pack --pack-destination releases
```

打包前自动运行构建、语法检查和全部测试。请修改 `src/client/` 源文件后重新构建，勿直接维护生成的 `client.js`。两处测试目录均由 `node --test` 自动发现。实机验证脚本会启动专用浏览器实例，需要 Windows；详见 [测试说明](docs/TESTING.md)。

欢迎使用 AI 辅助后续开发，尤其是新平台、新浏览器版本、关闭行为和界面体验。提交修改时请说明 DSH/浏览器版本、复现步骤及测试结果。发布流程见 [发布指南](RELEASING.md)。

## 效果截图

以下为用户提供的真实管理界面截图，展示实例管理、本机浏览器发现和录制事件详情。v0.1.2 已恢复浏览器品牌图标，并将图片嵌入分发包，离线安装也能显示。

### 实例管理

![多浏览器独立实例管理](docs/screenshots/instances.png)

### 本机浏览器

![本机浏览器自动发现与登记](docs/screenshots/browsers.png)

### 录制记录

![录制时间线与 HTTP 事件详情](docs/screenshots/recordings.png)

图片来源与补充验证截图见[截图说明](docs/screenshots/README.md)。

## 已知问题

- Brave 某些持久实例普通关闭会超时；不会自动升级为强制关闭。显式强制关闭可能丢失未保存内容。
- SOCKS5、外部 HTTPS CONNECT、长时间录制、多显示器和任务栏视觉表现尚未完整实测。
- 无法核验进程归属或确认退出时会保留数据，避免删除仍被使用的 profile。
- CDP 可以访问实例页面及登录状态，本机其他进程也可能连接；它不构成安全隔离边界。

## 开源许可

采用 [MIT License](LICENSE)：允许使用、复制、修改、分发、二次开发与商业使用，分发时需保留版权声明和许可文本。软件按“现状”提供，不提供担保。

本发布版使用原创字母图标。浏览器名称及第三方依赖的权利属于其各自权利人，依赖遵循各自许可证；见 [第三方说明](THIRD_PARTY_NOTICES.md)。本项目是独立社区项目。
