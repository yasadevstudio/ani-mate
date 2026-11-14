// YASA PRESENTS
// main.js - ANI-MATE Electron Main Process
// Starts the HTTP server, opens BrowserWindow

const { app, BrowserWindow, dialog, shell, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { fork } = require('child_process');

const DEFAULT_PORT = 7890;

/* ── ONE INSTANCE ──────────────────────────────────────────────────────────────────
 * A second launch used to start a second server on the next port, on the SAME two data
 * files, and open a page whose origin (and therefore its settings and its sync sign-in)
 * was a different one. The second launch now hands over to the first and exits. */
if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
}

function getServerPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'ani-mate-server.js');
    }
    return path.join(__dirname, 'server', 'ani-mate-server.js');
}

function getUIPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'ui');
    }
    return path.join(__dirname, 'ui');
}

/* Probe on loopback, which is the only address the server binds. This used to probe
 * with no host (every address), the same way the server used to listen. */
function portIsFree(port) {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(false));
        srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
}

/* ── THE PORT IS PART OF THE PAGE'S IDENTITY ───────────────────────────────────────
 * The page is http://localhost:PORT, and everything it keeps in localStorage (the
 * toggles, which changelog was seen, the sync sign-in and recovery key) belongs to that
 * exact origin. If 7890 is busy and the app quietly moves to 7891, all of that looks
 * empty, and "turn sync on" would create a second account.
 *
 * So the app has ONE home port: 7890, unless the user has said otherwise. When the home
 * port is busy the app still starts on another one, and SAYS SO, every time, with the
 * option to make that port the new home (for someone whose 7890 always belongs to
 * another program). The home is never changed silently: a port that was only busy for
 * one launch must not become where the app lives. */
function portFile() { return path.join(app.getPath('userData'), 'port.json'); }
function homePort() {
    try {
        const p = Number(JSON.parse(fs.readFileSync(portFile(), 'utf8')).port);
        return Number.isInteger(p) && p > 1023 && p < 65536 ? p : DEFAULT_PORT;
    } catch { return DEFAULT_PORT; }
}
async function choosePort() {
    const home = homePort();
    if (await portIsFree(home)) return { port: home, moved: false };
    for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 200; p++) {
        if (p !== home && await portIsFree(p)) return { port: p, moved: true };
    }
    throw new Error('No free port found');
}
function makeHome(port) {
    try { fs.writeFileSync(portFile(), JSON.stringify({ port })); } catch { /* asked again next time */ }
}

let serverProcess = null;
let mainWindow = null;
let serverPort = 0;
let quitting = false;
let restarts = [];

function startServer(port) {
    return new Promise((resolve, reject) => {
        const serverPath = getServerPath();

        const dataDir = path.join(app.getPath('userData'), 'data');
        const videosPath = app.getPath('videos') || path.join(app.getPath('home'), 'Videos');
        const downloadDir = path.join(videosPath, 'ANI-MATE');

        const env = {
            ...process.env,
            ANI_MATE_PORT: String(port),
            ANI_MATE_UI_DIR: getUIPath(),
            ANI_MATE_DATA_DIR: dataDir,
            ANI_MATE_DOWNLOAD_DIR: downloadDir,
            ANI_MATE_PACKAGED: '1',
            /* The server cannot read package.json from where a packaged build unpacks
             * it, and reported 0.4.0 for every release. Tell it. */
            ANI_MATE_VERSION: app.getVersion()
        };
        /* The server has switches that exist only for its own test suite (a stub host
         * the proxy will accept, a canned answer for the stream chain). They are read
         * from the environment, and this process hands its whole environment on, so
         * they are taken out here: the app never starts its server with one set. */
        for (const k of Object.keys(env)) {
            if (/^ANI_MATE_(TEST_|PROXY_TEST_)/.test(k)) delete env[k];
        }

        const child = fork(serverPath, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        serverProcess = child;

        // Route source-API calls through Chromium's network stack instead of the forked
        // child's bare Node HTTP. The child has no cookie jar and no browser fingerprint,
        // which is why every request came back 403 behind a browser check. See
        // electron-net-bridge.js for the full reasoning.
        try {
            require('./electron-net-bridge').attach(child);
            console.log('[main] net bridge attached');
        } catch (e) {
            console.error('[main] net bridge FAILED to attach:', e);
        }

        let resolved = false;

        child.stdout.on('data', (data) => {
            if (!resolved && data.toString().includes('Server online')) {
                resolved = true;
                resolve();
            }
        });

        child.stderr.on('data', (data) => {
            console.error(`[Server] ${data}`);
        });

        child.on('error', (err) => {
            if (!resolved) { resolved = true; reject(err); }
        });

        child.on('exit', (code) => {
            if (serverProcess === child) serverProcess = null;
            if (!resolved) {
                resolved = true;
                reject(new Error(`Server exited with code ${code}`));
                return;
            }
            /* ⛔ THE SERVER USED TO DIE QUIETLY. After startup nothing watched it, so if
             * it exited the window stayed open over a dead backend and every action
             * failed with no explanation. Bring it back on the same port; give up, and
             * say so, only if it keeps falling over. */
            if (quitting) return;
            const now = Date.now();
            restarts = restarts.filter((t) => now - t < 5 * 60 * 1000);
            if (restarts.length >= 5) {
                dialog.showErrorBox('ANI-MATE',
                    'The ANI-MATE background service stopped and could not be restarted. Close and reopen ANI-MATE.');
                return;
            }
            restarts.push(now);
            console.error(`[main] server exited (code ${code}); restarting`);
            setTimeout(() => {
                if (quitting) return;
                startServer(serverPort).catch((e) => {
                    /* A replacement that never came up ends the retries (its own exit
                     * is reported to this promise, not to the handler above), so this
                     * is the last chance to say anything. */
                    console.error('[main] restart failed:', e && e.message);
                    if (!quitting) {
                        dialog.showErrorBox('ANI-MATE',
                            'The ANI-MATE background service stopped and could not be restarted. Close and reopen ANI-MATE.');
                    }
                });
            }, 500 * restarts.length);
        });

        setTimeout(() => {
            if (!resolved) { resolved = true; reject(new Error('Server start timeout (10s)')); }
        }, 10000);
    });
}

function createWindow(port) {
    const origin = `http://localhost:${port}`;
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        backgroundColor: '#000000',
        title: 'ANI-MATE',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        },
        autoHideMenuBar: true,
        show: false
    });

    /* ── THE WINDOW SHOWS THE APP AND NOTHING ELSE ─────────────────────────────────
     * A link with target="_blank" used to open a second, bare Electron window with a
     * web site in it, inside the app's own session. Links to the web go to the user's
     * browser; nothing opens a new app window; and the main window cannot be navigated
     * away from the app. */
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url) && !url.startsWith(origin)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url === origin || url.startsWith(origin + '/')) return;
        event.preventDefault();
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    });

    mainWindow.loadURL(origin);
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.focus();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

// Auto-updater setup
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `ANI-MATE v${info.version} is available. Download now?`,
        buttons: ['Download', 'Later'],
        defaultId: 0
    }).then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
    });
});

autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'Update downloaded. Restart now to install?',
        buttons: ['Restart', 'Later'],
        defaultId: 0
    }).then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
    });
});

autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater]', err.message || err);
});

app.whenReady().then(async () => {
    try {
        /* Electron grants every permission a page asks for unless told otherwise, and
         * this app loads other people's pages in a hidden window to get past their
         * browser checks. The app's own page may go fullscreen and write the clipboard
         * (COPY KEY). Nothing else is granted to anything. */
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
            const own = !!mainWindow && wc === mainWindow.webContents;
            callback(own && (permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
        });

        const { port, moved } = await choosePort();
        serverPort = port;
        await startServer(port);
        createWindow(port);

        if (moved) {
            dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'ANI-MATE',
                message: 'Another program is using the port ANI-MATE normally runs on.',
                detail: 'Your favorites and watch history are safe. Your settings and your sync sign-in ' +
                        'are kept per port, so they will look empty this time. They are still there: ' +
                        'close the other program and start ANI-MATE again to get them back. ' +
                        'Do not create a new sync account from this window.\n\n' +
                        'If that other program always uses the port, choose "Always use this port" ' +
                        'and ANI-MATE will live on port ' + port + ' from now on.',
                buttons: ['OK', 'Always use this port'],
                defaultId: 0,
                cancelId: 0
            }).then(({ response }) => {
                if (response === 1) makeHome(port);
            });
        }

        // Check for updates after window is ready (non-blocking)
        if (app.isPackaged) {
            // CATCH THE RETURNED PROMISE, NOT JUST THE 'error' EVENT. checkForUpdates()
            // both EMITS 'error' and REJECTS, and only the event was handled, so every launch
            // that could not reach a feed printed a full UnhandledPromiseRejectionWarning
            // stack to stderr. It is harmless and it buries real errors in the log, which is
            // how the net-bridge failure went unread for a whole release.
            setTimeout(() => {
                autoUpdater.checkForUpdates().catch((err) => {
                    console.error('[AutoUpdater] check failed:', err && err.message || err);
                });
            }, 3000);
        }
    } catch (err) {
        dialog.showErrorBox('ANI-MATE Startup Error', err.message);
        app.quit();
    }
});

function stopServer() {
    quitting = true;
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
}

app.on('window-all-closed', () => {
    stopServer();
    app.quit();
});

app.on('before-quit', () => {
    stopServer();
});
