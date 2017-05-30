require('babel-polyfill');

// chrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=127.0.0.1:8081

const WebSocket = require('ws');
const fs = require('fs');
const { sep } = require('path');
const spawn = require('child_process').spawn;
const GDB = require('gdb-js').GDB;

const wss = new WebSocket.Server({ port: 8081 });

wss.on('connection', function connection(ws) {
  let child = spawn('gdb', [
    '-i=mi',
    '--args',
    '/usr/local/google/home/kozyatinskiy/v8/v8/out.gn/x64.debug/inspector-test',
    '/usr/local/google/home/kozyatinskiy/v8/v8/test/inspector/protocol-test.js',
    '/usr/local/google/home/kozyatinskiy/v8/v8/test/inspector/debugger/evaluate-on-call-frame-in-module.js'
  ]);
  let gdb = new GDB(child);

  let chanel = new FrontendChanelImpl(ws);
  let Runtime = new RuntimeImpl(chanel, gdb);
  let Debugger = new DebuggerImpl(chanel, gdb, Runtime);
  let Profiler = new ProfilerImpl(chanel);

  ws.on('message', function incoming(message) {
    try {
      let msg = JSON.parse(message);
      eval(`${msg.method}(${JSON.stringify(msg.params)})
              .then(sendResponse)
              .catch(sendError)`);

      function sendResponse(result) {
        result = result || {};
        chanel.sendRawMessage({id: msg.id, result});
      }

      function sendError(error) {
        if (error) error = error.stack;
        error = error || 'unknown';
        chanel.sendRawMessage({id: msg.id, error});
      }
    } catch (e) {
      console.log(e.stack);
    }
  });
});

class FrontendChanelImpl {
  constructor(ws) {
    this._ws = ws;
  }

  sendRawMessage(message) {
    this._ws.send(JSON.stringify(message));
  }

  sendNotification(method, params) {
    this._ws.send(JSON.stringify({method, params}))
  }
}

class DebuggerImpl {
  constructor(chanel, gdb, runtime) {
    this._enabled = false;
    this._chanel = chanel;
    this._gdb = gdb;
    this._runtime = runtime;

    this._sources = new Sources(['/usr/local/google/home/kozyatinskiy/v8/v8/src', '/usr/local/google/home/kozyatinskiy/v8/v8/test/inspector']);
    this._sourcesMap = new Map();
    this._revSourcesMap = new Map();
    this._lastSourceId = 0;

    this._breakpoints = new Map();

    this._gdb.on('stopped', (data) => this._stopped(data));
    this._gdb.on('running', (data) => this._running(data));
  }

  async enable(params) {
    this._enabled = true;
    let allFiles = await this._sources.initialize();
    for (let file of allFiles) {
      let id = '' + (++this._lastSourceId);
      this._sourcesMap.set(id, file.name);
      this._revSourcesMap.set(file.name, id);
      this._chanel.sendNotification('Debugger.scriptParsed', {
        scriptId: id,
        url: file.name,
        startLine: 0,
        startColumn: 0,
        endLine: file.endLine,
        endColumn: file.endColumn,
        executionContextId: 1,
        hash: '<nohash>'
      });
    }
  }

  async disable(params) {
    this._enabled = false;
  }

  async setBlackboxPatterns(params) {
  }

  async setAsyncCallStackDepth(params) {
  }

  async setPauseOnExceptions(params) {
  }

  async stepOver(params) {
    await this._gdb.next();
  }

  async stepOut(params) {
    await this._gdb.stepOut();
  }

  async stepInto(params) {
    await this._gdb.stepIn();
  }

  async resume(params) {
    await this._gdb.proceed();
  }

  async getScriptSource(params) {
    let scriptId = params.scriptId;
    let name = this._sourcesMap.get(params.scriptId);
    if (!name) throw new Error('No file with this name');
    let content = (await this._sources.readFile(name)).data;
    return {scriptSource: content};
  }

  async getPossibleBreakpoints(params) {
    throw new Error('unsupported');
  }

  async setBreakpointByUrl(params) {
    let breakpoint = await this._gdb.addBreak(params.url, params.lineNumber + 1);
    this._breakpoints.set(breakpoint.id, breakpoint);
    return { breakpointId: breakpoint.id + '', locations: [{
      scriptId: this._revSourcesMap.get(breakpoint.file),
      lineNumber: breakpoint.line - 1,
      columnNumber: breakpoint.columnNumber
    }]};
  }

  async removeBreakpoint(params) {
    let breakpoint = this._breakpoints.get(params.breakpointId * 1);
    if (breakpoint) {
      this._gdb.removeBreak(breakpoint);
      this._breakpoints.delete(params.breakpointId * 1);
    }
  }

  async evaluateOnCallFrame(params) {
    // let variable = await this._gdb.execMI(`-var-create - * ${params.expression}`);
    // console.log(variable);
    let r = await this._gdb.evaluate(params.expression);
    console.log(r);
    return { result: {type: "string", value: r }};
  }

  async _currentThreadId() {
    let result = await this._gdb.execMI('-thread-info');
    console.log(result);
    return result['current-thread-id'];
  }

  async _stopped(data) {
    this._currentThreadId = await this._currentThreadId();
    console.log(this._currentThreadId);
    let frame = data.thread.frame;
    let scriptId = this._revSourcesMap.get(frame.file);
    if (!scriptId) {
      this._gdb.stepIn();
      return;
    }
    let frames = await this._gdb.callstack();
    let id = 0;
    let {locals} = await this._gdb.execMI('-stack-list-locals --all-values');
    let hm = {};
    for (var local of locals) {
      let variable = await this._gdb.execMI(`-var-create - * ${local.name}`);
      console.log(variable);
      let name = variable.name;
      console.log(await this._gdb.execMI(`-var-list-children ${name}`));
      let coolName = (await this._gdb.execMI(`-var-info-expression ${name}`)).exp;
      if (variable.numchild * 1 === 0) {
        // highlight based on types
        if (variable.type === 'int')
          hm[coolName] = variable.value;
        else
          hm[coolName] = variable.value;
      } else {
        hm[coolName] = variable.value;
      }
    }
    let wrapperLocals = [{
      type: 'local',
      object: this._runtime.wrapValue(hm),
    }];
    let callFrames = frames.filter(frame => this._revSourcesMap.has(frame.file)).map(frame => ({
      callFrameId: ++id + '',
      functionName: frame.functionName,
      location: {scriptId: this._revSourcesMap.get(frame.file), lineNumber: frame.line - 1, columnNumber: 0},
      scopeChain: wrapperLocals,
      this: {unserializableValue: 'NaN'}      
    }));
    this._chanel.sendNotification('Debugger.paused', {
      callFrames,
      reason: 'other'
    });
  }

  async _running(data) {
    delete this._currentThreadId;
    this._chanel.sendNotification('Debugger.resumed', {});
  }

  async _breakpointResolved(data) {
  }
};

function toStringDescription(obj) {
    if (typeof obj === "number" && obj === 0 && 1 / obj < 0)
        return "-0"; // Negative zero.
    return obj + '';
}

class RuntimeImpl {
  constructor(chanel, gdb) {
    this._enabled = false;
    this._chanel = chanel;
    this._gdb = gdb;

    this._lastObjectId = 0;
    this._wrappedObjects = new Map();

    this._chanel.sendNotification('Runtime.executionContextCreated', {
      context: {
        id: 1,
        origin: 'default',
        name: 'default'
      }
    });
  }

  async enable(params) {
    this._enabled = true;
  }

  async disable(params) {
    this._enabled = false;
  }

  async runIfWaitingForDebugger(params) {
    await this._gdb.execMI('-exec-run --start');
  }

  async compileScript(params) {
    if (params.persistScript) {
      return {};
    }
    throw new Error('unsupported');
  }

  async getProperties(params) {
    if (!this._wrappedObjects.has(params.objectId * 1)) throw new Error('Object not found');
    let obj = this._wrappedObjects.get(params.objectId * 1);
    let props = [];
    for (let v in obj) {
      props.push({name: v, value: this.wrapValue(obj[v])});
    }
    return {result: props};
  }

  wrapValue(value) {
    let res = {};
    res.type = typeof value;
    if (res.type === 'undefined' || res.type === 'boolean' || res.type === 'number' || res.type === 'string') {
      if (res.type !== 'undefined') {
        res.value = value;
      }
      if (value === null) res.substype = 'null';
      if (res.type === "number") {
          res.description = toStringDescription(res);
          switch (res.description) {
          case "NaN":
          case "Infinity":
          case "-Infinity":
          case "-0":
              delete res.value;
              res.unserializableValue = res.description;
              break;
          }
      }
      return res;
    }
    let id = ++this._lastObjectId;
    this._wrappedObjects.set(id, value);
    res.objectId = id + '';
    return res;
  }
};

class ProfilerImpl {
  constructor(chanel) {
    this._enabled = false;
    this._chanel = chanel;
  }

  async enable(params) {
    this._enabled = true;
  }

  async disable(params) {
    this._enabled = false;
  }
};

// update on fs.watch
class Sources {
  constructor(paths) {
    this._paths = paths;
  }

  async initialize() {
    let fullNames = this._paths;
    let allFiles = [];
    while (fullNames.length) {
      let name = fullNames.shift();
      if (await this._isDir(name)) {
        let pathNames = (await this._readdir(name)).files;
        for (let pathName of pathNames) {
          fullNames.push(name + sep + pathName);
        }
      } else {
        let content = (await this.readFile(name)).data;
        let lines = content.split(/\r\n|\r|\n/);
        allFiles.push({name, endLine: lines.length, endColumn: lines[lines.length - 1].length});
      }
    }
    return allFiles;
  }

  async _readdir(path) {
    return new Promise(resolve => fs.readdir(path, (err, files) => resolve({err, files})));
  }

  async _isDir(fullName) {
    let res = await (new Promise(resolve => fs.stat(fullName, (err, stats) => resolve({err, stats}))));
    return res.stats && res.stats.isDirectory();
  }

  async readFile(fullName) {
    return new Promise(resolve => fs.readFile(fullName, 'utf8', (err, data) => resolve({err, data})));
  }
};
