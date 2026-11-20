'use strict';

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readAsarFile } = require('./asar');
const { ensureUserDataDir, pruneTranslatedFromUntranslated } = require('./dictionary');
const { MAIN_START_MARKER, applyPatch, isAntigravityRunning } = require('./patcher');
const {
  PACKAGE_ROOT,
  getBundledDictionaryPaths,
  getUserDataFiles,
  resolveAntigravityPaths,
} = require('./paths');
const { PRELOAD_START_MARKER } = require('./runtime/preloadBuilder');

let cachedDesktopDir = null;

/**
 * Encodes a PowerShell script as UTF-16LE Base64 for -EncodedCommand.
 * Prevents Windows codepage mojibake with Japanese text.
 * @param {string} script
 */
function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function escapePsSingleQuoted(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function runPowerShellEncoded(script, options = {}) {
  const encoded = encodePowerShellCommand(script);
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout || 15000,
    }
  );
}

/**
 * Quickly verifies whether app.asar already contains both main/preload hooks and jaI18nMain.js.
 * @param {string} asarPath
 */
function isAppPatchedFast(asarPath) {
  try {
    if (!asarPath || !fs.existsSync(asarPath)) {
      return false;
    }
    const mainBuf = readAsarFile(asarPath, 'dist/main.js');
    const preloadBuf = readAsarFile(asarPath, 'dist/preload.js');
    const jaMainBuf = readAsarFile(asarPath, 'dist/jaI18nMain.js');
    if (!mainBuf || !preloadBuf || !jaMainBuf) {
      return false;
    }
    return (
      mainBuf.toString('utf8').includes(MAIN_START_MARKER) &&
      preloadBuf.toString('utf8').includes(PRELOAD_START_MARKER)
    );
  } catch {
    return false;
  }
}

/**
 * Syncs bundled ja-base.json into userDataDir/dictionary.json only when missing or outdated.
 * @param {string} [userDataDir]
 */
function syncBaseDictIfStale(userDataDir) {
  try {
    const bundled = getBundledDictionaryPaths();
    const userFiles = getUserDataFiles(userDataDir);
    if (!fs.existsSync(bundled.baseDictPath)) {
      return false;
    }
    let needsRefresh = !fs.existsSync(userFiles.baseDictPath);
    if (!needsRefresh) {
      const srcStat = fs.statSync(bundled.baseDictPath);
      const dstStat = fs.statSync(userFiles.baseDictPath);
      if (srcStat.size !== dstStat.size || Math.floor(srcStat.mtimeMs) > Math.floor(dstStat.mtimeMs)) {
        needsRefresh = true;
      }
    }
    if (!needsRefresh) {
      return false;
    }
    ensureUserDataDir(userDataDir, { refreshBaseDict: true });
    pruneTranslatedFromUntranslated(userDataDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds an installed Chromium-based browser on Windows for standalone --app window mode.
 */
function findAppBrowserExecutable() {
  if (process.platform !== 'win32') {
    return null;
  }
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);

  for (const exe of candidates) {
    try {
      if (fs.existsSync(exe)) {
        return exe;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Opens the control center URL as a standalone desktop app window (URL bar hidden) when available.
 * @param {string} url
 */
function openAppWindow(url) {
  try {
    if (process.platform === 'win32') {
      const browser = findAppBrowserExecutable();
      if (browser) {
        spawn(browser, [`--app=${url}`, '--new-window'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        return { mode: 'app-window', executable: browser };
      }
      spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
      return { mode: 'browser', executable: null };
    }
    if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      return { mode: 'browser', executable: null };
    }
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    return { mode: 'browser', executable: null };
  } catch {
    return { mode: 'none', executable: null };
  }
}

/**
 * Opens a folder in the OS file explorer.
 * @param {string} dirPath
 */
function openDirectoryInExplorer(dirPath) {
  const resolved = path.resolve(dirPath);
  fs.mkdirSync(resolved, { recursive: true });
  if (process.platform === 'win32') {
    spawn('explorer.exe', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [resolved], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Displays a borderless dark Windows splash screen ("日本語化中...") asynchronously.
 * @param {{ title?: string, subtitle?: string }} [options]
 */
function spawnSplashWindow(options = {}) {
  if (process.platform !== 'win32') {
    return { close() {} };
  }
  const heading = options.title || '日本語化中';
  const subtitle = options.subtitle || 'Antigravity アップデート後の日本語パッチを適用しています...';

  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { [System.Windows.Forms.Application]::EnableVisualStyles() } catch {}

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.ClientSize = New-Object System.Drawing.Size(360, 126)
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 22, 28)

$form.Add_Paint({
  param($sender, $e)
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(59, 130, 246), 1)
  try {
    $e.Graphics.DrawRectangle($pen, 0, 0, $sender.ClientSize.Width - 1, $sender.ClientSize.Height - 1)
  } finally {
    $pen.Dispose()
  }
})

$lblBrand = New-Object System.Windows.Forms.Label
$lblBrand.Text = 'ANTIGRAVITY JAPANESE UI'
$lblBrand.ForeColor = [System.Drawing.Color]::FromArgb(148, 163, 184)
$lblBrand.Font = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
$lblBrand.Location = New-Object System.Drawing.Point(22, 16)
$lblBrand.Size = New-Object System.Drawing.Size(316, 18)

$baseHeading = '${escapePsSingleQuoted(heading)}'
$lblMain = New-Object System.Windows.Forms.Label
$lblMain.Text = "$baseHeading..."
$lblMain.ForeColor = [System.Drawing.Color]::FromArgb(243, 244, 246)
$lblMain.Font = New-Object System.Drawing.Font('Yu Gothic UI', 15, [System.Drawing.FontStyle]::Bold)
$lblMain.Location = New-Object System.Drawing.Point(20, 38)
$lblMain.Size = New-Object System.Drawing.Size(320, 32)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = '${escapePsSingleQuoted(subtitle)}'
$lblSub.ForeColor = [System.Drawing.Color]::FromArgb(156, 163, 175)
$lblSub.Font = New-Object System.Drawing.Font('Yu Gothic UI', 9)
$lblSub.Location = New-Object System.Drawing.Point(22, 74)
$lblSub.Size = New-Object System.Drawing.Size(316, 20)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
$bar.MarqueeAnimationSpeed = 28
$bar.Location = New-Object System.Drawing.Point(22, 102)
$bar.Size = New-Object System.Drawing.Size(316, 8)

$form.Controls.AddRange(@($lblBrand, $lblMain, $lblSub, $bar))

$dots = 0
$animTimer = New-Object System.Windows.Forms.Timer
$animTimer.Interval = 320
$animTimer.Add_Tick({
  $script:dots = ($script:dots + 1) % 4
  $suffix = if ($script:dots -eq 0) { '...' } elseif ($script:dots -eq 1) { '.' } elseif ($script:dots -eq 2) { '..' } else { '...' }
  $lblMain.Text = "$baseHeading$suffix"
})
$animTimer.Start()

$safetyTimer = New-Object System.Windows.Forms.Timer
$safetyTimer.Interval = 60000
$safetyTimer.Add_Tick({
  $safetyTimer.Stop()
  $animTimer.Stop()
  $form.Close()
})
$safetyTimer.Start()

[System.Windows.Forms.Application]::Run($form)
`;

  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePowerShellCommand(psScript)],
      {
        stdio: 'ignore',
        windowsHide: true,
        detached: false,
      }
    );
    return {
      close() {
        try {
          if (child && !child.killed) {
            child.kill();
          }
        } catch {
          // ignore
        }
      },
    };
  } catch {
    return { close() {} };
  }
}

/**
 * Displays a native Windows MessageBox dialog and returns 'OK' | 'Retry' | 'Cancel' | 'Yes' | 'No'.
 * @param {{ title?: string, message: string, buttons?: 'OK'|'RetryCancel'|'YesNo', icon?: 'Information'|'Warning'|'Error'|'Question' }} opts
 */
function showNativeDialog(opts) {
  if (process.platform !== 'win32') {
    return 'Cancel';
  }
  const title = escapePsSingleQuoted(opts.title || 'Antigravity 日本語UI');
  const message = escapePsSingleQuoted(opts.message || '');
  const buttons = opts.buttons || 'OK';
  const icon = opts.icon || 'Information';

  const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$res = [System.Windows.Forms.MessageBox]::Show(
  '${message}',
  '${title}',
  [System.Windows.Forms.MessageBoxButtons]::${buttons},
  [System.Windows.Forms.MessageBoxIcon]::${icon}
)
Write-Output $res.ToString()
`;
  try {
    const out = runPowerShellEncoded(psScript, { timeout: 60000 });
    return String(out || '').trim() || 'Cancel';
  } catch {
    return 'Cancel';
  }
}

/**
 * Returns the user's Desktop directory (resolving redirected Desktop on Windows once and caching).
 * @param {string} [overrideDir]
 */
function getDesktopDir(overrideDir) {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  if (cachedDesktopDir) {
    return cachedDesktopDir;
  }
  if (process.platform === 'win32') {
    try {
      const out = runPowerShellEncoded(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nWrite-Output ([Environment]::GetFolderPath('Desktop'))",
        { timeout: 4000 }
      ).trim();
      if (out) {
        cachedDesktopDir = out;
        return cachedDesktopDir;
      }
    } catch {
      // fallback below
    }
  }
  cachedDesktopDir = path.join(os.homedir(), 'Desktop');
  return cachedDesktopDir;
}

/**
 * Returns standard desktop shortcut paths.
 * @param {string} [overrideDir]
 */
function getShortcutPaths(overrideDir) {
  const dir = getDesktopDir(overrideDir);
  return {
    desktopDir: dir,
    launchShortcut: path.join(dir, 'Antigravity (日本語).lnk'),
    managerShortcut: path.join(dir, 'Antigravity 日本語化マネージャー.lnk'),
  };
}

/**
 * Creates Desktop shortcuts with Antigravity's official icon.
 * @param {{ targetDir?: string, installDir?: string, includeManager?: boolean }} [options]
 */
function createDesktopShortcuts(options = {}) {
  if (process.platform !== 'win32') {
    throw new Error('デスクトップショートカット作成は Windows 専用です。');
  }

  const paths = resolveAntigravityPaths(options.installDir);
  const shortcutTargets = getShortcutPaths(options.targetDir);
  fs.mkdirSync(shortcutTargets.desktopDir, { recursive: true });

  const wscriptPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const launchVbs = path.join(PACKAGE_ROOT, 'bin', 'launch-silent.vbs');
  const appVbs = path.join(PACKAGE_ROOT, 'bin', 'app-silent.vbs');
  const iconLoc = paths.exePath && fs.existsSync(paths.exePath) ? `${paths.exePath},0` : '';
  const includeManager = Boolean(options.includeManager);

  const entries = [
    {
      lnkPath: shortcutTargets.launchShortcut,
      args: `//B //Nologo "${launchVbs}"`,
      description: 'Antigravity App を自動日本語化チェック付きで起動します',
    },
  ];
  if (includeManager) {
    entries.push({
      lnkPath: shortcutTargets.managerShortcut,
      args: `//B //Nologo "${appVbs}"`,
      description: 'Antigravity 日本語化マネージャー（設定・辞書エディタ）を開きます',
    });
  }

  const lines = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$ws = New-Object -ComObject WScript.Shell',
  ];
  for (const item of entries) {
    lines.push(`$s = $ws.CreateShortcut('${escapePsSingleQuoted(item.lnkPath)}')`);
    lines.push(`$s.TargetPath = '${escapePsSingleQuoted(wscriptPath)}'`);
    lines.push(`$s.Arguments = '${escapePsSingleQuoted(item.args)}'`);
    lines.push(`$s.WorkingDirectory = '${escapePsSingleQuoted(PACKAGE_ROOT)}'`);
    lines.push(`$s.Description = '${escapePsSingleQuoted(item.description)}'`);
    if (iconLoc) {
      lines.push(`$s.IconLocation = '${escapePsSingleQuoted(iconLoc)}'`);
    }
    lines.push('$s.Save()');
    lines.push(`Write-Output '${escapePsSingleQuoted(item.lnkPath)}'`);
  }

  const output = runPowerShellEncoded(lines.join('\n'), { timeout: 15000 });
  const created = output
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    desktopDir: shortcutTargets.desktopDir,
    created,
  };
}

function defaultSpawnExe(exePath, args) {
  spawn(exePath, args || [], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

/**
 * Ensures Antigravity is patched with Japanese UI (showing a "日本語化中..." splash if updating)
 * and launches Antigravity.exe.
 * @param {{
 *   installDir?: string,
 *   userDataDir?: string,
 *   gui?: boolean,
 *   passThroughArgs?: string[],
 *   skipRunningCheck?: boolean,
 *   _spawnExe?: Function,
 *   _spawnSplash?: Function,
 *   _showDialog?: Function,
 *   _isRunning?: Function,
 *   _applyPatch?: Function,
 *   _isPatched?: Function,
 *   _syncStale?: Function
 * }} [options]
 */
function launchAntigravity(options = {}) {
  const paths = resolveAntigravityPaths(options.installDir);
  const gui = Boolean(options.gui);
  const passThroughArgs = Array.isArray(options.passThroughArgs) ? options.passThroughArgs : [];

  const spawnExeFn = options._spawnExe || defaultSpawnExe;
  const spawnSplashFn = options._spawnSplash || spawnSplashWindow;
  const showDialogFn = options._showDialog || showNativeDialog;
  const isRunningFn = options._isRunning || isAntigravityRunning;
  const applyPatchFn = options._applyPatch || applyPatch;
  const isPatchedFn = options._isPatched || isAppPatchedFast;
  const syncStaleFn = options._syncStale || syncBaseDictIfStale;

  if (!fs.existsSync(paths.asarPath) || !fs.existsSync(paths.exePath)) {
    const msg = `Antigravity 本体が ${paths.installDir} に見つかりません。`;
    if (gui) {
      showDialogFn({ title: 'Antigravity 日本語UI', message: msg, buttons: 'OK', icon: 'Error' });
      return { launched: false, patchedNow: false, error: msg };
    }
    throw new Error(msg);
  }

  if (isPatchedFn(paths.asarPath)) {
    syncStaleFn(options.userDataDir);
    spawnExeFn(paths.exePath, passThroughArgs);
    return { launched: true, patchedNow: false };
  }

  while (true) {
    if (!options.skipRunningCheck && isRunningFn()) {
      if (!gui) {
        throw new Error(
          'Antigravity が起動中のため日本語化を適用できません。タスクトレイ右クリック → Quit で終了してから再実行してください。'
        );
      }
      const choice = showDialogFn({
        title: 'Antigravity 日本語UI — 終了待ち',
        message:
          'Antigravity が更新されたため、日本語UIを再適用する必要があります。\n\n画面右下のタスクトレイアイコン（右クリック → Quit）を含めて Antigravity を完全に終了してから「再試行」を押してください。',
        buttons: 'RetryCancel',
        icon: 'Information',
      });
      if (choice === 'Retry') {
        continue;
      }
      return { launched: false, patchedNow: false, cancelled: true };
    }

    const splash = gui ? spawnSplashFn({ title: '日本語化中' }) : { close() {} };
    if (!gui) {
      console.log('日本語化中...');
    }
    try {
      applyPatchFn({
        installDir: options.installDir,
        userDataDir: options.userDataDir,
        skipRunningCheck: Boolean(options.skipRunningCheck),
      });
      splash.close();
      spawnExeFn(paths.exePath, passThroughArgs);
      return { launched: true, patchedNow: true };
    } catch (err) {
      splash.close();
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM') && gui) {
        const retryChoice = showDialogFn({
          title: 'Antigravity 日本語UI — ファイル使用中',
          message:
            'Antigravity のプロセスがまだ終了していないためファイルにアクセスできません。\n\n完全に終了してから「再試行」を押してください。',
          buttons: 'RetryCancel',
          icon: 'Warning',
        });
        if (retryChoice === 'Retry') {
          continue;
        }
        return { launched: false, patchedNow: false, cancelled: true };
      }
      if (gui) {
        const fallbackChoice = showDialogFn({
          title: 'Antigravity 日本語UI — エラー',
          message: `日本語化パッチの適用中にエラーが発生しました:\n${err.message}\n\n英語のまま Antigravity を起動しますか？`,
          buttons: 'YesNo',
          icon: 'Warning',
        });
        if (fallbackChoice === 'Yes') {
          spawnExeFn(paths.exePath, passThroughArgs);
          return { launched: true, patchedNow: false, error: err.message };
        }
        return { launched: false, patchedNow: false, error: err.message };
      }
      throw err;
    }
  }
}

module.exports = {
  encodePowerShellCommand,
  isAppPatchedFast,
  syncBaseDictIfStale,
  findAppBrowserExecutable,
  openAppWindow,
  openDirectoryInExplorer,
  spawnSplashWindow,
  showNativeDialog,
  getDesktopDir,
  getShortcutPaths,
  createDesktopShortcuts,
  launchAntigravity,
};
