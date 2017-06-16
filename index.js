const fs = require('fs');
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
      additionalArguments: ['--headless'],
    });

    const apiClient = session.createAPIClient('localhost', browser.remoteDebuggingPort);

    const [ tab ] = await apiClient.listTabs();
    const client = await session.openDebuggingProtocol(tab.webSocketDebuggerUrl);

    const page = new protocol.Page(client);
    const runtime = new protocol.Runtime(client);
    const heapProfiler = new protocol.HeapProfiler(client);
    const debug = new protocol.Debugger(client);

    const scriptMap = new Map();

    debug.scriptParsed = (evt) => {
      scriptMap.set(evt.scriptId, evt);
    };

    debug.scriptFailedToParse = (evt) => {
      scriptMap.set(evt.scriptId, evt);
    }

    await Promise.all([page.enable(), debug.enable(), runtime.enable(), heapProfiler.enable()]);

    await page.addScriptToEvaluateOnLoad({
      scriptSource: `
        QUnit.testDone(() => {
          QUnit.stop();
          __testDone(false);
        });
        QUnit.done(() => {
          __testDone(true);
        });
        function resumeTest() {
          QUnit.start();
          return new Promise(resolve => window.__testDone = resolve);
        }
      `
    });

    let contextId;

    const contextCreated = eventPromise(runtime, 'executionContextCreated').then((evt) => {
      contextId = evt.id;
      return runtime.evaluate({
        contextId,
        expression: `window.QUnit = { config: { autostart: false } };`,
        returnByValue: true
      });
    });

    const pageLoad = eventPromise(page, 'loadEventFired');

    await page.navigate({ url });

    await Promise.all([ pageLoad, contextCreated ]);

    while (true) {
      let result = await runtime.evaluate({
        contextId,
        expression: `resumeTest()`,
        awaitPromise: true
      });
      if (result.exceptionDetails) {
        throw new Error(JSON.stringify(result.exceptionDetails));
      }

      let isDone = toBoolean(result);
      if (isDone) break;

      snapshot = await takeHeapSnapshot();
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
