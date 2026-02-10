// YASA PRESENTS
// main.js - ANI-MATE Electron Main Process
// Starts the HTTP server, opens BrowserWindow

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');

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

function findFreePort(startPort) {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(startPort, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', () => {
            if (startPort < 65535) {
                resolve(findFreePort(startPort + 1));
            } else {
                reject(new Error('No free port found'));
            }
        });
    });
}

let serverProcess = null;
let mainWindow = null;

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
            ANI_MATE_PACKAGED: '1'
        };

        serverProcess = fork(serverPath, [], {
            env,
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });

        let resolved = false;

        serverProcess.stdout.on('data', (data) => {
            if (!resolved && data.toString().includes('Server online')) {
                resolved = true;
                resolve();
            }
        });

        serverProcess.stderr.on('data', (data) => {
            console.error(`[Server] ${data}`);
        });

        serverProcess.on('error', (err) => {
            if (!resolved) { resolved = true; reject(err); }
        });

        serverProcess.on('exit', (code) => {
            if (!resolved && code !== 0 && code !== null) {
                resolved = true;
                reject(new Error(`Server exited with code ${code}`));
            }
        });

        setTimeout(() => {
            if (!resolved) { resolved = true; reject(new Error('Server start timeout (10s)')); }
        }, 10000);
    });
}

function createWindow(port) {
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

    mainWindow.loadURL(`http://localhost:${port}`);
    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(async () => {
    try {
        const port = await findFreePort(7890);
        await startServer(port);
        createWindow(port);
    } catch (err) {
        dialog.showErrorBox('ANI-MATE Startup Error', err.message);
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
    app.quit();
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
});
