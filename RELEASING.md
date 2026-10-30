# GitHub 发布指南 / Release guide

当前源码版本为 `0.1.2`，适配 DeepSeek Harness `0.2.1-rc.5`。公开仓库为 https://github.com/Lmg66/dsh-browser-flock 。v0.1.0 是已发布的 rc.3 版本；本次本地适配与安装不表示 v0.1.2 已在 GitHub 发布。

## 构建与打包

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm pack --pack-destination releases
Get-FileHash releases\local-dsh-browser-flock-0.1.2.tgz -Algorithm SHA256
```

`prepack` 依次构建 Client、检查 manifest/JavaScript、执行全部自动化测试。安装包不含 node_modules。`releases/` 不进入 Git 提交；若生成源码 ZIP，应包含当前构建脚本、测试、锁文件与文档，排除依赖、环境变量、日志、浏览器 profile、扩展库和真实录制。

## 发布新版本

1. 检查 Git diff，确认版本、双语 README、依赖许可说明和测试范围一致。
2. 提交源码后在该提交创建 `v0.1.2` tag；不要移动 v0.1.0 或覆盖旧附件。
3. 在 GitHub Releases 创建正式版本，标题为 `Browser Flock v0.1.2 — 浏览器图标与 Harness rc.5 适配`，正文使用 [中英文发布说明](docs/releases/v0.1.2.md)。
4. 上传 `local-dsh-browser-flock-0.1.2.tgz`、可选源码 ZIP 和按实际文件重新生成的 SHA-256 校验值。
5. 正式发布时不要勾选 pre-release；是否标为 latest 按本次发布目标决定。

## 安装验证

通过 Harness 的 `plugin_manager` 安装。若返回 `already-installed`，先移除同名 bundle 的安装登记，再安装新包；保留 profile 下的 `data/browser-flock`。检查安装返回的 `application`、`warnings`、`nextStep`，再查询 Client 插槽和已保存数据。若返回需要重启或刷新，按实际结果处理。升级前停止正在进行的录制。

插件身份保持 `@local/dsh-browser-flock`，包继续设置 `private: true`，用于 GitHub 与本地 tarball 分发。npm 发布需要自有 scope 和经过验证的身份迁移。

## English

Version 0.1.2 targets Harness 0.2.1-rc.5. Version 0.1.0 remains the published rc.3 release. A local compatibility update does not publish a new GitHub release.

Install dependencies with the frozen lockfile, then run `pnpm pack --pack-destination releases`. The prepack hook builds, checks and tests the project. Review and commit changes before tagging v0.1.2; keep existing tags and assets intact. Use the [bilingual release notes](docs/releases/v0.1.2.md), upload the new tarball and checksums, and publish a regular release when authorized.

To replace an installed version, use plugin management and follow its result. If installation returns `already-installed`, remove the existing bundle entry first, preserving the browser data directory, then install the new package. Verify live slots and saved-data reads. Retain the package identity, license notice and `private: true`.
