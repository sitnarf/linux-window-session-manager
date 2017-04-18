const exec = require('child_process').exec;
const spawn = require('child_process').spawn;
const Store = require('jfs');
const fs = require('fs');

let db;
let CFG;

module.exports = {
  savePositions,
  restoreSession,
};

init();

function init() {
  const mkdirSync = (dirPath) => {
    try {
      fs.mkdirSync(dirPath);
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
    }
  };

  const copySync = (src, dest) => {
    if (!fs.existsSync(src)) {
      return false;
    }
    const data = fs.readFileSync(src, 'utf-8');
    fs.writeFileSync(dest, data);
  };

  const dataDir = getUserHome() + '/.lwsm';
  const sessionDataDir = dataDir + '/sessionData';

  try {
    // if config is already in place
    CFG = JSON.parse(fs.readFileSync(dataDir + '/config.json', 'utf8'));
  } catch (e) {
    // if there is no config yet load default cfg and create files and dirs
    CFG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
    mkdirSync(dataDir);
    mkdirSync(sessionDataDir);

    // copy files
    copySync(__dirname + '/config.json', dataDir + '/config.json');
  }

  // create data store
  db = new Store(sessionDataDir);
}

function getUserHome() {
  return process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];
}

function savePositions(sessionName) {
  const sessionToHandle = sessionName || 'DEFAULT';

  getActiveWindowList((windowList) => {
    readWindowStates(windowList, () => {
      readDesktopFilePaths(windowList, () => {
        getConnectedDisplaysId((connectedDisplaysId) => {

          // check if entry exists and update
          db.get(sessionToHandle, (err, sessionData) => {
            if (sessionData) {
              console.log(sessionData);
              sessionData[connectedDisplaysId] = windowList;
              db.save(sessionToHandle, sessionData);
            } else {
              const newSession = {};
              newSession[connectedDisplaysId] = windowList;
              db.save(sessionToHandle, newSession);
            }
          });
        });
      });
    });
  });
}

function restoreSession(sessionName) {
  const sessionToHandle = sessionName || 'DEFAULT';

  db.get(sessionToHandle || 'DEFAULT', (err, sessionData) => {
    getConnectedDisplaysId((connectedDisplaysId) => {
      const savedWindowList = sessionData[connectedDisplaysId];

      if (!savedWindowList) {
        console.error(`no data for current display id ${connectedDisplaysId} saved yet`);
        return;
      }

      getActiveWindowList((currentWindowList) => {
        startSessionPrograms(savedWindowList, currentWindowList);
        waitForAllAppsToStart(savedWindowList, (updatedCurrentWindowList) => {
          updateWindowIds(savedWindowList, updatedCurrentWindowList);
          restoreWindowPositions(savedWindowList, () => {
            console.log('RESTORED SESSION');
          });
        });
      });
    });
  });
}

function getConnectedDisplaysId(cb) {
  const cmd = `xrandr --query | grep '\\bconnected\\b'`;
  exec(cmd, (error, stdout, stderr) => {
    if (error || stderr) {
      console.error(error, stderr);
    } else {
      const connectedDisplaysId = createConnectedDisplaysId(stdout);
      cb(connectedDisplaysId);
    }
  });
}

function createConnectedDisplaysId(stdout) {
  let idString = '';
  const RESOLUTION_REG_EX = /[0-9]{3,5}x[0-9]{3,5}/;
  const lines = stdout.split('\n');
  lines.forEach((line) => {
    if (line !== '') {
      const resolution = RESOLUTION_REG_EX.exec(line);
      // only do this if we have a resolution as that means that the display is active
      if (resolution) {
        idString += resolution + ';';
      }
    }
  });

  if (idString.length) {
    // cut off last semicolon
    return idString.substring(0, idString.length - 1);
  }
}

function waitForAllAppsToStart(savedWindowList, cb) {
  setTimeout(() => {
    getActiveWindowList((currentWindowList) => {
      if (!isAllAppsStarted(savedWindowList, currentWindowList)) {
        waitForAllAppsToStart(savedWindowList, cb);
      } else {
        cb(currentWindowList);
      }
    });
  }, CFG.POLL_ALL_APPS_STARTED_TIMEOUT);
}

function isAllAppsStarted(savedWindowList, currentWindowList) {
  let isAllStarted = true;
  savedWindowList.forEach((win) => {
    if (!getMatchingWindowId(win, currentWindowList)) {
      isAllStarted = false;
    }
  });
  return isAllStarted;
}

function readWindowStates(windowList, cb) {
  const promises = [];
  windowList.forEach((win) => {
    promises.push(readWindowState(win));
  });

  Promise.all(promises).then((results) => {
    cb(results);
  });
}

function readWindowState(win) {
  return new Promise(function (fulfill, reject) {
    exec(`xprop -id ${win.windowId} | grep "_NET_WM_STATE(ATOM)"`, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const stringStates = stdout.replace('_NET_WM_STATE(ATOM) = ', '')
          .replace('\n', '');
        const states = stringStates.split(' = ');
        win.states = [];
        states.forEach((state) => {
          if (state !== '' && CFG.STATES_MAP[state]) {
            win.states.push(CFG.STATES_MAP[state]);
          }
        });
        fulfill(win.states);
      }
    });
  });
}

function readDesktopFilePaths(windowList, cb) {
  const promises = [];
  windowList.forEach((win) => {
    if (isDesktopFile(win.executableFile)) {
      promises.push(readFilePath(win));
    }
  });

  Promise.all(promises).then((results) => {
    cb(results);
  });
}

function readFilePath(win) {
  return new Promise(function (fulfill, reject) {
    exec('locate ' + win.executableFile, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const lines = stdout.split('\n');
        // just default to first for now
        win.desktopFilePath = lines[0];
        fulfill(win.desktopFilePath);
      }
    });
  });
}

// TODO check for how many instances there should be running of a program
function startSessionPrograms(windowList, currentWindowList) {
  windowList.forEach((win) => {
    const numberOfInstancesOfWin = getNumberOfInstancesToRun(win, windowList);
    if (!isProgramAlreadyRunning(win.executableFile, currentWindowList, numberOfInstancesOfWin, win.instancesStarted)) {
      startProgram(win.executableFile, win.desktopFilePath);
      win.instancesStarted += 1;
    }
  });
}

function getNumberOfInstancesToRun(windowToMatch, windowList) {
  return windowList.filter((win) => {
    return win.executableFile === windowToMatch.executableFile;
  }).length;
}

function isProgramAlreadyRunning(executableFile, currentWindowList, numberOfInstancesToRun = 1, instancesStarted = 0) {
  let instancesRunning = 0;
  currentWindowList.forEach((win) => {
    if (win.executableFile === executableFile) {
      instancesRunning++;
    }
  });
  console.log(executableFile + ' is running: ', instancesRunning + instancesStarted >= numberOfInstancesToRun, numberOfInstancesToRun, instancesStarted);
  return instancesRunning + instancesStarted >= numberOfInstancesToRun;
}

function getActiveWindowList(cb) {
  const cmd = 'wmctrl -p -G -l -x';

  exec(cmd, function (error, stdout, stderr) {
    const data = transformWmctrlList(stdout);
    if (error || stderr) {
      console.error(error, stderr);
    } else {
      cb(data);
    }
  });
}

function isDesktopFile(executableFile) {
  return executableFile.match(/desktop$/);
}

function isExcluded(executableFile) {
  return CFG.EXECUTABLE_FILE_EXCLUSIONS.indexOf(executableFile) > -1;
}

function startProgram(executableFile, desktopFilePath) {
  let cmd;
  let args = [];
  if (desktopFilePath) {
    cmd = `awk`;
    args.push('/^Exec=/ {sub("^Exec=", ""); gsub(" ?%[cDdFfikmNnUuv]", ""); exit system($0)}');
    args.push(desktopFilePath);
  } else {
    cmd = executableFile;
    // TODO split args if necessary
  }
  spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
  }, (error, stdout, stderr) => {
    if (error || stderr) {
      console.error(error, stderr);
    }
  }).unref();
}

function transformWmctrlList(stdout) {
  const LINE_REG_EX = /([^\s]+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+(-*\d+)\s+([^\s]+)/;
  const data = [];
  const lines = stdout.split('\n');
  lines.forEach((line) => {
    const fields = LINE_REG_EX.exec(line);
    if (fields && !isExcluded(fields[8])) {
      data.push({
        windowId: fields[1],
        windowIdDec: parseInt(fields[1], 16),
        gravity: parseInt(fields[2], 10),
        x: parseInt(fields[4], 10),
        y: parseInt(fields[5], 10),
        width: parseInt(fields[6], 10),
        height: parseInt(fields[7], 10),
        wmClassName: fields[8],
        executableFile: handleDesktopFiles(fields[8]),
      });
    }
  });
  return data;
}

function handleDesktopFiles(executableFileString) {
  if (CFG.EXECUTABLE_FILE_MAP[executableFileString]) {
    return CFG.EXECUTABLE_FILE_MAP[executableFileString];
  } else {
    const splitValues = executableFileString.split('.');
    return splitValues[0] + '.desktop';
  }
}

function updateWindowIds(savedWindowList, currentWindowList) {
  const executableFilesMap = {};
  savedWindowList.forEach((win) => {
    if (!executableFilesMap[win.executableFile]) {
      executableFilesMap[win.executableFile] = getMatchingWindows(win, currentWindowList);
    }
    win.windowId = executableFilesMap[win.executableFile][0].windowId;
    win.windowIdDec = parseInt(win.windowId, 16);
    executableFilesMap[win.executableFile].shift();
  });
}

function getMatchingWindowId(win, currentWindowList) {
  const currentWindow = currentWindowList.find((winFromCurrent) => win.executableFile === winFromCurrent.executableFile);
  return currentWindow && currentWindow.windowId;
}

function getMatchingWindows(win, currentWindowList) {
  return currentWindowList.filter((winFromCurrent) => win.executableFile === winFromCurrent.executableFile);
}

function restoreWindowPositions(savedWindowList, cb) {
  const promises = [];
  savedWindowList.forEach((win) => {
    if (win.windowId) {
      promises.push(restoreWindowPosition(win));
    }
  });

  Promise.all(promises).then((results) => {
    cb(results);
  });
}

function restoreWindowPosition(win) {
  const newPositionStr = `${win.gravity},${win.x},${win.y},${win.width},${win.height}`;
  const removeStatesStr = 'remove,maximized_vert,maximized_horz,fullscreen,above,below,hidden,sticky,modal,shaded,demands_attention';
  const baseCmd = `wmctrl -i -r ${win.windowId}`;

  // add remove states command
  let cmd = `${baseCmd} -b  ${removeStatesStr}`;

  // add restore positions command
  if (CFG.IS_USE_XDOTOOL) {
    const decId = win.windowIdDec;
    // this is what the implementation with xdotool would look like
    cmd = `${cmd} && xdotool windowsize ${decId} ${win.width} ${win.height} windowmove ${decId} ${win.x} ${win.y}`
  } else {
    cmd = `${cmd} && ${baseCmd} -e ${newPositionStr}`;
  }

  // add add states command
  if (win.states && win.states.length > 0) {
    cmd = `${cmd} &&  ${baseCmd} -b add,${win.states.join(',')}`;
  }

  return new Promise(function (fulfill, reject) {
    exec(cmd, (error, stdout, stderr) => {
      if (error || stderr) {
        console.error(error, stderr);
        reject(error || stderr);
      } else {
        const lines = stdout.split('\n');
        win.desktopFilePath = lines[0];
        fulfill(stdout);
      }
    });
  });
}

