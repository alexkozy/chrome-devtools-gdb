require('babel-polyfill');

console.log('To start debugging, open the following URL in Chrome:\nchrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=127.0.0.1:8081');

const WebSocket = require('ws');
const fs = require('fs');
const { sep } = require('path');
const spawn = require('child_process').spawn;
const GDB = require('gdb-js').GDB;

const commandLineArgs = require('command-line-args');
const optionDefinitions = [
  { name: 'gdbargs', type: String, multiple: true },
  { name: 'src', type: String, multiple: true }
];
const options = commandLineArgs(optionDefinitions);
const wss = new WebSocket.Server({ port: 8081 });

wss.on('connection', function connection(ws) {
  let child = spawn('gdb', [
    '-i=mi',
    '--args' ].concat(options.gdbargs));
  let gdb = new GDB(child);

  let chanel = new FrontendChanelImpl(ws);
  let Runtime = new RuntimeImpl(chanel, gdb);
  let Debugger = new DebuggerImpl(chanel, gdb, Runtime, options.src);
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

class RemoteObject {
  constructor(gdb, gdbValue) {
    this._gdb = gdb;
    this._name = gdbValue.name;
    this._numchild = gdbValue.numchild;
    this._value = gdbValue.value;
    this._type = gdbValue.type;
    this._thread_id = gdbValue.thread_id;
  }

  id() {
    return this._name;
  }

  static async create(gdb, expression) {
    try {
      expression = expression.replace(/\s/g,'');
      let obj = await gdb.execMI(`-var-create - * ${expression}`);
      let m = !obj.type.startsWith('char') && !obj.type.startsWith('const char') ? obj.type.match(/([*]+)/) : obj.type.match(/[*]([*]+)/);
      if (m && m.length > 1 && m[1].length) {
        gdb.execMI('-var-delete ' + obj._name);
        obj = await gdb.execMI(`-var-create - * ${m[1]}(${expression})`);
      }
      return new RemoteObject(gdb, obj);
    } catch (e) {
      // return errors as exceptions
      console.log(e.stack);
      return new RemoteObject();
    }
  }

  toProtocolValue() {
    let type = this._type || '';
    type = type.replace(/^(const\s+)+/, '');
    if (type === 'int') return {type: 'number', value: this._value};
    if (type === 'long') return {type: 'number', value: this._value};
    if (type === 'size_t') return {type: 'number', value: this._value};
    if (type === 'double') return {type: 'number', value: this._value};
    if (type === 'float') return {type: 'number', value: this._value};
    if (type === 'bool') return {type: 'number', value: this._value === 'true'};
    if (type === 'char *') {
      let value = this._value;
      let firstSpace = value.indexOf(' ');
      return {type: 'string', value: this._value.substr(firstSpace + 1).slice(1, -1)};
    }
    if (type === 'char') return {type: 'string', value: this._value.split(' ', 2)[1].slice(1, -1)};
    return {type: 'object', className: this._type, description: (this._type || '') + (this._value || ''), objectId: this._name};
  }

  async getProperties(runtimeAgent) {
    if (!this._numchild) return [];
    try {
      let {children} = await this._gdb.execMI('-var-list-children --all-values ' + this._name);
      let wrappedChildren = children.map(child => new RemoteObject(this._gdb, child.value));
      wrappedChildren.forEach(child => runtimeAgent.register(child));
      let props = [];
      for (let i = 0; i < children.length; ++i) {
        props.push({name: children[i].value.exp, value: wrappedChildren[i].toProtocolValue()});
      }
      return props;
    } catch (e) {
      console.log(e.stack);
    }
    return [];
  }

  dispose() {
    if (this._name) {
      this._gdb.execMI('-var-delete ' + this._name);
    }
  }
};

class CurrentScopeObject {
  constructor(gdb, locals) {
    this._gdb = gdb;
    this._name = 'currentScope';
    this._numchild = locals.length;
    this._locals = locals;
  }

  id() {
    return this._name;
  }

  static async create(gdb) {
    try {
      let {locals} = await gdb.execMI('-stack-list-locals --all-values');
      return new CurrentScopeObject(gdb, locals);
    } catch (e) {
      console.log(e.stack);
      return new RemoteObject();
    }
  }

  toProtocolValue() {
    return {type: 'object', objectId: this._name};
  }

  async getProperties(runtimeAgent) {
    try {
      let props = [];
      for (let local of this._locals) {
        let wrapped = await RemoteObject.create(this._gdb, local.name);
        runtimeAgent.register(wrapped);
        props.push({name: local.name, value: wrapped.toProtocolValue()});
      }
      return props;
    } catch (e) {
      console.log(e.stack);
    }
    return [];
  }

  dispose() {
  }
};

class DebuggerImpl {
  constructor(chanel, gdb, runtime, src) {
    this._enabled = false;
    this._chanel = chanel;
    this._gdb = gdb;
    this._runtime = runtime;

    this._sources = new Sources(src);
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
    let obj = await RemoteObject.create(this._gdb, params.expression);
    let value = obj.toProtocolValue();
    this._runtime.register(obj, params.groupName || '');
    if (!value) throw new Error("Error during evaluation.");
    return {result: value};
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
    let scopes = await CurrentScopeObject.create(this._gdb);
    this._runtime.register(scopes);
    let wrapperLocals = [{
      type: 'local',
      object: scopes.toProtocolValue(),
    }];
    let id = 0;
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
    this._debugObjects = new Map();

    this._chanel.sendNotification('Runtime.executionContextCreated', {
      context: {
        id: 1,
        origin: 'default',
        name: 'default'
      }
    });

    this._objectGroupSymbol = Symbol('objectGroup');
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
    let objectId = params.objectId;
    if (!this._debugObjects.has(objectId)) throw new Error('Object not found');
    return {result: await this._debugObjects.get(objectId).getProperties(this)};
  }

  async releaseObjectGroup(params) {
    let data = new Map();
    for (var pair of this._debugObjects) {
      if (pair[1][this._objectGroupSymbol] !== params.objectGroup) {
        data.set(pair[0], pair[1]);
      }
    }
    this._debugObjects = data;
  }

  async releaseObject(params) {
    this._debugObjects.delete(params.objectId);
  }

  register(value, groupName) {
    this._debugObjects.set(value.id(), value);
    if (groupName) {
      value[this._objectGroupSymbol] = groupName;
    }
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
