const fs = require('fs');
const { promisify } = require('util');
const Heapsnapshot = require('heapsnapshot');
const index = require('chrome-debugging-client');
const protocol = require('chrome-debugging-client/dist/protocol/tot');

if (process.argv.length < 3) {
  console.error(`${process.argv[1]} [url]`);
}

const additionalArguments = [
  '--ignore-certificate-errors',
];

const readAsync = promisify(fs.readFile);

runQUnitTestsWithSnapshots(process.argv[2]).catch((err) => {
  console.error(err);
});

function runQUnitTestsWithSnapshots(url) {
  return index.createSession(async (session) => {
    const codeToInject = await readAsync('./qunit-injection-code.js', 'utf8');
    const browser = await session.spawnBrowser('canary', { additionalArguments });

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

    if (!await isQUnitAvailable(runtime, contextId)) {
      throw new Error('QUnit is not available on this page!');
    }

    const scriptId = await compileScript(runtime, codeToInject, 'http://localhost:7357/__pageload.js', contextId);
    await runtime.runScript({
      scriptId: scriptId,
    });

    while (true) {
      let result = await runtime.evaluate({
        contextId,
        expression: `__resumeTest()`,
        awaitPromise: true
      });

      let isDone = toBoolean(result);
      if (isDone) break;

      const snapshot = await takeHeapSnapshot(heapProfiler);

      for (const Container of findObjectsInSnapshot(snapshot, 'Container')) {
        console.log('leaked Container via:');
        try {
          const path = Heapsnapshot.pathToRoot(Container);
          path.forEach((node) => console.log(node.name, node.in));
        } catch(err) {
          if (/has no path to root/.test(err.message)) {
            console.log("Couldn't find path to root!");
          } else {
            throw err;
          }
        }
      }
    }
  });
}

async function isQUnitAvailable(runtime, contextId) {
  const hasQUnit = await runtime.evaluate({
    contextId,
    expression: `!!window.QUnit.start`,
    awaitPromise: true
  });
  return toBoolean(hasQUnit);
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

function *findObjectsInSnapshot(snapshot, name) {
  for (const node of snapshot) {
    if (node.type === 'object' && node.name === name) {
      yield node;
    }
  }
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
