/* global QUnit */


QUnit.config.blocking = true;

const __state = (function() {
  let _value = undefined;
  let _waiter = undefined;

  function set(value) {
    if (typeof _waiter === 'undefined') {
      console.debug('>>>>  QUnit started too early. Waiting for the script to catch up.');
      _value = value;
    } else {
      // if somebody is already waiting for the state value, let's give it to them.
      _waiter(value);
    }
  }

  function ready() {
    return typeof _value !== 'undefined';
  }

  function wait() {
    return new Promise(resolve => {
      if (ready()) {
        // QUnit started early and the first test is already done!
        const tmpValue = _value;
        _value = undefined;
        resolve(tmpValue);
      } else {
        // Wait for the next time `set()` is called.
        console.debug('>>>>  Waiting for the next test to run...');
        _waiter = resolve;
      }
    });
  }

  return { set, wait, ready };
})();

QUnit.on("runStart", function () {
  console.debug('>>>>  RUN START');
});

QUnit.on("testEnd", function () {
  console.debug('>>>>  TEST END');
  // We need to set blocking to `true` here, in case QUnit started before we called __resumeTest.
  QUnit.config.blocking = true;
  __state.set(false);
});

QUnit.on("runEnd", function (data) {
  console.log('Passed: ' + data.testCounts.passed );
  console.log('Failed: ' + data.testCounts.failed );
  console.log('Skipped: ' + data.testCounts.skipped );
  console.log('Todo: ' + data.testCounts.todo );
  console.log('Total: ' + data.testCounts.total );
  console.debug('>>>>  RUN END');
  __state.set(true);
});

// eslint-disable-next-line no-unused-vars
function __resumeTest() {
  console.debug('>>>  RESUME TEST');
  if (!__state.ready()) {
    // TODO: This doesn't work currently. We need a way to instruct QUnit to `advance`.
    console.debug('>>>>  Unblocking qunit');
    QUnit.config.blocking = false;
  }
  return __state.wait();
}
