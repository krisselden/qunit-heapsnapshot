const fs = require('fs');
const url = require('url');
const Heapsnapshot = require('heapsnapshot');
const index = require('chrome-debugging-client');
const protocol = require('chrome-debugging-client/dist/protocol/tot');

if (process.argv.length < 3) {
  console.error(`${process.argv[1]} [url]`);
}

runQUnitTestsWithSnapshots(process.argv[2]).catch((err) => {
  console.error(err);
});

function runQUnitTestsWithSnapshots(url) {
  return index.createSession(async (session) => {
    const browser = await session.spawnBrowser('canary', {
    });

    const apiClient = session.createAPIClient('localhost', browser.remoteDebuggingPort);

    const [ tab ] = await apiClient.listTabs();
    const client = await session.openDebuggingProtocol(tab.webSocketDebuggerUrl);

    const page = new protocol.Page(client);
    const runtime = new protocol.Runtime(client);
    const heapProfiler = new protocol.HeapProfiler(client);
    const debug = new protocol.Debugger(client);
    const cons = new protocol.Console(client);

    cons.messageAdded = (evt) => {
      console.log(evt.message.level, evt.message.text);
    };

    const scriptMap = new Map();

    debug.scriptParsed = (evt) => {
      scriptMap.set(evt.scriptId, evt);
    };

    debug.scriptFailedToParse = (evt) => {
      scriptMap.set(evt.scriptId, evt);
    }

    await Promise.all([page.enable(), debug.enable(), runtime.enable(), heapProfiler.enable(), cons.enable()]);

    const contextCreated = eventPromise(runtime, 'executionContextCreated').then((evt) => {
      const contextId = evt.context.id;
      return runtime.evaluate({
        contextId,
        expression: `window.QUnit = { config: { autostart: false } };`,
        returnByValue: true
      }).then(() => contextId);
    });

    const pageLoad = eventPromise(page, 'loadEventFired');

    await page.navigate({ url });

    const contextId = await contextCreated;

    await pageLoad;

    const scriptId = await compileScript(runtime, `
let __testStarted = false;
let __testDone = undefined;

QUnit.on("runStart", function () {
  __testStarted = true;
  console.debug('>>>>  RUN START');
});

QUnit.on("testEnd", function () {
  console.debug('>>>>  TEST END');
  QUnit.config.blocking = true;
  __testDone(false);
});

QUnit.on("runEnd", function () {
  console.debug('>>>>  RUN END');
  __testDone(true);
});

function __resumeTest() {
  if (!__testStarted) {
    console.debug('>>>>  QUnit.start');
    QUnit.start();
  } else {
    QUnit.config.blocking = false;
  }

  return new Promise(function(resolve) {
    __testDone = resolve;
  });
}
`, 'http://localhost:7357/__pageload.js', contextId);
    let loadResult = await runtime.runScript({
      scriptId: scriptId
    });

    while (true) {
      let result = await runtime.evaluate({
        contextId,
        expression: `__resumeTest()`,
        awaitPromise: true
      });

      let isDone = toBoolean(result);
      if (isDone) break;

      snapshot = await takeHeapSnapshot(heapProfiler);
      snapshot.buildSync();

      for (const node of snapshot) {
        if (node.type === 'object' && node.name === 'Container') {
          const path = Heapsnapshot.pathToRoot(node);
          throw new Error(`leaked Container via ${path.join(' -> ')}`)
        }
      }
    }
  });
}

async function takeHeapSnapshot(heapProfiler) {
  await heapProfiler.collectGarbage();

  let buffer = '';

  heapProfiler.addHeapSnapshotChunk = (params) => {
    buffer += params.chunk;
  };

  heapProfiler.reportHeapSnapshotProgress = (params) => {
    console.log(params.done / params.total + "");
  };

  await heapProfiler.takeHeapSnapshot({ reportProgress: true });

  return new Heapsnapshot(JSON.parse(buffer));
}

function toBoolean(evalReturn) {
  if (evalReturn.exceptionDetails) {
    throw new Error(JSON.stringify(evalReturn.exceptionDetails));
  }
  const result = evalReturn.result;
  if (result.type !== 'boolean') {
    throw new Error(`expected result to be boolean but was ${JSON.stringify(result)}`);
  }
  return result.value;
}

function eventPromise(domain, eventName) {
  return new Promise(resolve => {
    domain[eventName] = (evt) => {
      domain[eventName] = null;
      resolve(evt);
    }
  });
}

async function compileScript(runtime, expression, sourceURL, executionContextId) {
  const result = await runtime.compileScript({
    expression,
    sourceURL,
    persistScript: true,
    executionContextId
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.scriptId;
}
