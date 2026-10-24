# GitHub 发布指南 / Release guide

本目录就是仓库根目录，可直接推送到 GitHub。当前准备版本 `0.1.0`，按正式 Release 发布。仅整理本地材料，不代表已创建远程仓库或上传附件。

## 1. 首次上传源码

先在 GitHub 创建一个空仓库，建议名称 `dsh-browser-flock`，不要让 GitHub 自动初始化 README 或 LICENSE。在本目录执行以下命令，并把占位地址替换为自己的仓库：

```powershell
git init
git add .
git status --short
# 检查暂存文件后再提交
git commit -m "Release Browser Flock v0.1.0"
git branch -M main
git remote add origin https://github.com/YOUR_ACCOUNT/dsh-browser-flock.git
git push -u origin main
```

`.gitignore` 排除依赖、发布附件、环境变量、日志及测试结果。不要提交浏览器 profile、扩展库、真实录制或 Cookie。当前没有设置虚构的作者账号和 repository URL；创建仓库后可在 package 元数据中补充真实链接。LICENSE 使用项目贡献者名义。

## 2. 构建与打包

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm pack --pack-destination releases
Get-FileHash releases\local-dsh-browser-flock-0.1.0.tgz -Algorithm SHA256
```

`prepack` 依次构建 Client、检查 manifest/JavaScript、执行全部自动化测试。首次整理的发布附件位于本目录 `releases/`，它不进入 Git 提交。以后代码修改后应重新生成安装包、源码 ZIP 和 SHA256SUMS.txt；不得沿用旧校验值。

安装包不含 node_modules；源码 ZIP 包含构建脚本与测试。GitHub 自动生成的 Source code ZIP 来自 tag，可替代手动源码 ZIP。

## 3. GitHub Releases 页面填写

- **Tag:** `v0.1.0`
- **Target:** 包含本次发布材料的提交
- **Release title:** `Browser Flock v0.1.0 — 浏览器群 / Browser Flock`
- **Description:** 复制 [中英文发布正文](docs/releases/v0.1.0.md)，无需把本指南一起粘贴
- **Set as a pre-release:** 不勾选
- **Set as the latest release:** 勾选

上传附件：

1. `local-dsh-browser-flock-0.1.0.tgz` — Harness 本地安装包。
2. `browser-flock-0.1.0-source.zip` — 干净源码与开发文档；也可使用 GitHub 自动生成的源码包。
3. `SHA256SUMS.txt` — 上述两个文件的校验值。

发布前可先保存为 Draft。GUI 已由用户确认恢复正常，并已加入三张实机效果图。Brave 关闭超时等独立限制见发布正文。

## 4. 后续版本

更新 package 版本、双语 README 和 Release 文案；保持 Host、Client loader、bundle patch 的插件标识一致。公开后不要用不同内容覆盖同一个版本。升级前停止录制，数据格式变更前先备份。

当前包 `private: true`，支持本地打包但禁止误发布 npm。若将来发布 npm，需要自有 scope、真实仓库链接及一次完整身份迁移验证；不要只改包名就承诺旧用户可无缝升级。

## English quick guide

This directory is the repository root. Create an empty GitHub repository, replace `YOUR_ACCOUNT` above, review staged files and push the source. No remote repository has been created by this preparation step.

Build with `pnpm install --frozen-lockfile --ignore-scripts` and `pnpm pack --pack-destination releases`. The prepack hook builds, checks and tests the project. Generated attachments stay outside Git. Rebuild the source ZIP and checksums whenever release content changes.

Create tag `v0.1.0` at the release commit. Use the title above, paste the [bilingual release body](docs/releases/v0.1.0.md), attach the tarball/source ZIP/checksums and publish a regular release: leave **Set as a pre-release** unchecked and select **Set as the latest release**. Save a draft first if desired. The user has confirmed that the GUI works and supplied three screenshots. Independent limitations, including Brave close timeouts, remain documented.

Retain the license notice. Use real repository/account metadata when available. Keep `private: true` for GitHub/local-tarball distribution; npm publication requires an owned scope and careful plugin-identity migration.
