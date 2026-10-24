import path from 'node:path';
import { proxyArguments } from './proxy.js';
import { invariant } from '../shared/errors.js';

export const brands = Object.freeze(['chrome', 'edge', 'brave', 'firefox']);
export function launchArguments(runtime, profilePath, initialUrl, {cdp=false,proxy}={}) {
  invariant(brands.includes(runtime.browser), 'UNSUPPORTED_RUNTIME', 'Browser has no supported adapter.');
  invariant(path.isAbsolute(profilePath), 'INVALID_ARGUMENT', 'Profile directory must be absolute.');
  const target = initialUrl ?? 'about:blank';
  invariant(!cdp || runtime.browser !== 'firefox', 'CDP_UNSUPPORTED', 'Firefox does not support the Chromium CDP endpoint.');
  if (runtime.browser === 'firefox') return ['-no-remote', '-new-instance', '-profile', profilePath, target];
  // Edge can silently attach the Windows account even with a separate user data dir.
  // Keep these switches local to the managed process; never change machine policies.
  const isolation = runtime.browser === 'edge' ? ['--disable-sync','--disable-features=msImplicitSignin,msSSO'] : [];
  return [`--user-data-dir=${profilePath}`, ...isolation, ...proxyArguments(proxy), '--no-first-run', '--no-default-browser-check', '--new-window', ...(cdp ? ['--remote-debugging-address=127.0.0.1','--remote-debugging-port=0'] : []), target];
}

export function defaultCandidates(platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [...new Set([env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean))];
    const installs = { chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'], edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'], brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'], firefox: ['Mozilla Firefox', 'firefox.exe'] };
    return roots.flatMap(root => Object.entries(installs).map(([browser, parts]) => ({ browser, path: path.win32.join(root, ...parts), source: 'standard-directory' })));
  }
  if (platform === 'darwin') {
    const roots = ['/Applications', ...(env.HOME ? [path.posix.join(env.HOME, 'Applications')] : [])];
    const installs = { chrome: ['Google Chrome.app', 'Google Chrome'], edge: ['Microsoft Edge.app', 'Microsoft Edge'], brave: ['Brave Browser.app', 'Brave Browser'], firefox: ['Firefox.app', 'firefox'] };
    return roots.flatMap(root => Object.entries(installs).map(([browser, [app, exe]]) => ({ browser, path: path.posix.join(root, app, 'Contents', 'MacOS', exe), source: 'application-directory' })));
  }
  if (platform === 'linux') {
    const roots = [...new Set((env.PATH ?? '/usr/bin:/usr/local/bin').split(':').filter(root => root.startsWith('/')))];
    const installs = { chrome: ['google-chrome', 'google-chrome-stable'], edge: ['microsoft-edge', 'microsoft-edge-stable'], brave: ['brave-browser', 'brave'], firefox: ['firefox'] };
    return roots.flatMap(root => Object.entries(installs).flatMap(([browser, names]) => names.map(name => ({ browser, path: path.posix.join(root, name), source: 'path' }))));
  }
  return [];
}
