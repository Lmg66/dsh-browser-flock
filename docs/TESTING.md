# Testing / 测试说明

## Browser icon distribution fix (v0.1.2)

The release restores Chrome, Edge, Brave and Firefox brand artwork and embeds all four images directly into the generated Client. Decoded data URI bytes were compared with each source asset. Build, manifest/JavaScript checks and all 141 automated tests passed. Runtime dependencies were repaired after a Windows EPERM during local tarball replacement; the source-linked bundle was then re-enabled with `application: applied`. The connected Client did not yet show a fresh registration after replacement, so visual display is pending a page refresh and is not claimed as verified. Existing profile and recording directory counts remained 15 and 12. No browser lifecycle integration run was added for this visual change.

## Harness rc.5 compatibility update (v0.1.1)

- Updated the exact DSH engine requirement and all three direct DSH dependencies from `0.2.1-rc.3` to `0.2.1-rc.5`; regenerated the dependency lockfile. Version 0.1.0 remains the rc.3 release.
- Checked the installed rc.5 implementations and live contracts for tool execution, sandbox policy, approval, Typert invocation codecs and Client slots. No Host/Client API rewrite or data-schema migration was needed.
- Client build, JavaScript/manifest checks and all 141 automated tests passed with rc.5 dependencies (0 failed, 0 skipped).
- The existing incompatible local development bundle was removed through plugin management and replaced with v0.1.1. Installation returned `application: applied` with no warnings. Both the sidebar entry and main panel registered as active in the connected Harness Client.
- Live AI tools successfully queried browser installations, saved instances, proxy presets, extension library and recordings. Existing browser-profile and recording directory counts were unchanged, and the ownership ledger hash was unchanged. No browser was opened or closed for this compatibility check.
- Visual layout and a fresh full browser lifecycle/recording/extension integration matrix were not rerun for this dependency-only update. The matrix below remains historical rc.3 evidence.

## Evidence and scope (v0.1.0)

The browser integration results below were collected on Windows with DSH `0.2.1-rc.3` before release packaging. Version `0.1.0` adds public documentation, MIT metadata and original letter icons, and rebuilds the client without changing Host lifecycle logic. The user subsequently confirmed that the GUI works and provided screenshots of instances, local browsers and recording details. The earlier missing-Client-registration observation is superseded by this confirmation.

Release-source verification: client build and JavaScript/manifest checks passed; 141/141 tests passed, 0 failed, 0 skipped. Frozen-lockfile dependency installation also succeeded with registry.npmjs.org configured, reusing 24 cached packages; this does not prove an uncached registry download. Real-browser results below are pre-packaging evidence; automated checks and user-provided GUI evidence are reported separately.

## Real-browser matrix

| Check | Chrome 155.0.8059.85 | Edge 156.0.4314.42 | Brave 156.1.98.60 | Firefox 158.0.1 |
| --- | --- | --- | --- | --- |
| Discovery / executable identity | Pass | Pass | Pass | Pass |
| Persistent launch / reopen | Pass | Pass | Pass | Pass |
| Final ordinary close | Pass | Pass in latest run | Timeout in extension and recording runs | Pass |
| HTTP proxy / ephemeral cleanup | Pass | Pass | Pass | Pass |
| CDP navigation and evaluation | Pass | Pass | Pass | Unsupported |
| Recording input / click / navigation / HTTP | Pass | Pass | Pass | Unsupported |
| Raw headers / bodies / persistence | Pass | Pass | Pass | Unsupported |
| Extension capture / install / isolated storage / reopen | Pass | Pass | Pass | Unsupported |

Chrome and Edge recordings each contained 18 events / 5 requests; Brave contained 22 / 6. Tests used a local fixture, fictional passwords and bearer tokens. Saved content was read again after reopening the recording manager. Extension tests verified source value A, destination value B and retention after reopening. Deleting a shared extension library without affecting instance copies is covered by automated regression; it was not repeated as a new live deletion scenario in this run.

Brave functional assertions passed before ordinary-close failures during cleanup. Dedicated QA instances were explicitly force-closed and deleted. An initial Edge proxy run failed because the test proxy did not handle socket ECONNRESET; the harness was corrected and the rerun passed. Neither failure is concealed by the functional-pass rows.

## Outstanding issues

- Brave ordinary close can return CLOSE_TIMEOUT. Latest tests did not independently establish the exact modal/window cause. There is no automatic force escalation.
- External HTTPS CONNECT, SOCKS5, long-running recording, multi-monitor behavior and taskbar appearance were not fully verified.
- Windows only. No macOS/Linux support is claimed.

## Reproducing checks

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run check
pnpm test
```

The following optional Windows integration scripts launch dedicated real browsers. Review them before running; they create temporary repositories and may retain data if cleanup fails. They assume standard Windows executable locations. Do not run against personal profiles.

```powershell
node scripts/discover.mjs
node scripts/verify-proxy.mjs chrome
node scripts/verify-proxy.mjs edge
node scripts/verify-proxy.mjs brave
node scripts/verify-proxy.mjs firefox
node scripts/verify-recordings.mjs chrome
node scripts/verify-recordings.mjs edge
node scripts/verify-recordings.mjs brave
node scripts/verify-extension-center.mjs
```

Extension verification covers Chrome, Edge and Brave. Inspect output and cleanup status, not only successful assertions. Recording scripts retain their fixture recording repository under the OS temporary directory; clean only the explicitly reported test directory after confirming all associated browser processes have exited. No general-purpose force-clean helper is shipped.

## 中文摘要

v0.1.0 发布源码通过构建、语法检查及 141/141 项自动化测试。发布整理前的实机测试中，四浏览器 HTTP 代理、三种 Chromium 录制和扩展隔离/重开断言通过；Brave 普通关闭存在超时。用户已确认 GUI 正常，并提供实例列表、本机浏览器和录制详情三张截图，原先的 Client 注册异常不再列为当前问题。截图确认与自动化测试分别记录，不扩大为所有交互场景的覆盖结论。

自动化测试使用虚构凭据；真实录制会保留原始敏感数据。实机脚本只使用专用测试实例，若清理失败需核实进程退出后再处理输出所指的临时目录，勿操作个人浏览器数据。
