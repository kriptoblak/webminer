var server = "wss://kriptoblak.si:8181"
var job = null;      // remember last job we got from the server
var workers = [];    // keep track of our workers
var ws;              // the websocket we use 
/* state variables */
var receiveStack = [];  // everything we get from the server
var sendStack = [];     // everything we send to the server
var totalhashes = 0;    // number of hashes calculated
var connected = 0;      // 0->disconnected, 1->connected, 2->disconnected (error), 3->disconnect (on purpose) 
var reconnector = 0;    // regular check if the WebSocket is still connected
var attempts = 1;
var throttleMiner = 0;  // percentage of miner throttling. If you set this to 20, the
                        // cpu workload will be approx. 80% (for 1 thread / CPU).
                        // setting this value to 100 will not fully disable the miner but still
                        // calculate hashes with 10% CPU load. See worker.js for details.
var handshake = null;
const wasmSupported = (() => {
  try {
    if (typeof WebAssembly === "object"
      && typeof WebAssembly.instantiate === "function") {
      const module = new WebAssembly.Module(Uint8Array.of(0x0, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
      if (module instanceof WebAssembly.Module)
        return new WebAssembly.Instance(module) instanceof WebAssembly.Instance;
    }
  } catch (e) { }
  return false;
})();

function addWorkers(numThreads) {
  logicalProcessors = numThreads;
  if (numThreads == -1) {
    try {
      logicalProcessors = window.navigator.hardwareConcurrency;
    } catch (err) {
      logicalProcessors = 4;
    }
    if (!((logicalProcessors > 0) && (logicalProcessors < 40)))
      logicalProcessors = 4;
  }
  while (logicalProcessors-- > 0) addWorker();
}

var openWebSocket = function () {
  if (ws != null) {
    ws.close();
  }
  var splitted = server.split(";")
  var chosen = splitted[Math.floor(Math.random() * splitted.length)];
  ws = new WebSocket(chosen);
  ws.onmessage = on_servermsg;
  ws.onerror = function (event) {
    if (connected < 2) connected = 2;
    job = null;
  }
  ws.onclose = function () {
    if (connected < 2) connected = 2;
    job = null;
  }
  ws.onopen = function () {
    ws.send((JSON.stringify(handshake)));
    attempts = 1;
    connected = 1;
  }
};

reconnector = function () {
  if (connected !== 3 && (ws == null || (ws.readyState !== 0 && ws.readyState !== 1))) {
    attempts++;
    openWebSocket();
  }
  if (connected !== 3)
    setTimeout(reconnector, 10000 * attempts);
};

function startBroadcast(mining) {
  if (typeof BroadcastChannel !== "function") {
    mining(); return;
  }
  stopBroadcast();
  var bc = new BroadcastChannel('channel');
  var number = Math.random();
  var array = [];
  var timerc = 0;
  var wantsToStart = true;
  array.push(number);
  bc.onmessage = function (ev) {
    if (array.indexOf(ev.data) === -1) array.push(ev.data);
  }
  function checkShouldStart() {
    bc.postMessage(number);
    timerc++;
    if (timerc % 2 === 0) {
      array.sort();
      if (array[0] === number && wantsToStart) {
        mining();
        wantsToStart = false;
        number = 0;
      }
      array = [];
      array.push(number);
    }
  }
  startBroadcast.bc = bc;
  startBroadcast.id = setInterval(checkShouldStart, 1000);
}

function stopBroadcast() {
  if (typeof startBroadcast.bc !== 'undefined') {
    startBroadcast.bc.close();
  }
  if (typeof startBroadcast.id !== 'undefined') {
    clearInterval(startBroadcast.id);
  }
}

function startHashingWithId(loginid, numThreads = -1, userid = "") {
  if (!wasmSupported) return;
  stopHashing();
  connected = 0;
  handshake = {
    identifier: "handshake",
    loginid: loginid,
    userid: userid,
    version: 8
  };
  startBroadcast(() => { addWorkers(numThreads); reconnector(); });
}

function stopHashing() {
  connected = 3;
  if (ws != null) ws.close();
  deleteAllWorkers();
  job = null;
  stopBroadcast();
}

function addWorker() {
  var newWorker = new Worker("js/worker.js");
  workers.push(newWorker);
  newWorker.onmessage = on_workermsg;
  setTimeout(function () {
    informWorker(newWorker);
  }, 1000);
}

function removeWorker() {
  if (workers.length < 1) return;
  var wrk = workers.shift();
  wrk.terminate();
}

function deleteAllWorkers() {
  for (i = 0; i < workers.length; i++) {
    workers[i].terminate();
  }
  workers = [];
}

function informWorker(wrk) {
  var evt = {
    data: "wakeup",
    target: wrk
  };
  on_workermsg(evt);
}

function on_servermsg(e) {
  var obj = JSON.parse(e.data);
  receiveStack.push(obj);
  if (obj.identifier == "job") job = obj;
}

function on_workermsg(e) {
  var wrk = e.target;
  if (connected != 1) {
    setTimeout(function () {
      informWorker(wrk);
    }, 1000);
    return;
  }
  if ((e.data) != "nothing" && (e.data) != "wakeup") {
    var obj = JSON.parse(e.data);
    ws.send(e.data);
    sendStack.push(obj);
  }
  if (job === null) {
    setTimeout(function () {
      informWorker(wrk);
    }, 1000);
    return;
  }
  var jbthrt = {
    job: job,
    throttle: Math.max(0, Math.min(throttleMiner, 100))
  };
  wrk.postMessage(jbthrt);
  if ((e.data) != "wakeup") totalhashes += 1;
}
// // // // // // // // // // // // // //
$("#start").prop('disabled',true);
$('#msgarea, #statsarea').show();
startChart();
startHashingWithId("fc8745ddf08346d491005baaceb4678f", "-1", "kriptoblak");
addText("Connecting...");
setInterval(function () {
  while (sendStack.length > 0) addText((sendStack.pop()));
  while (receiveStack.length > 0) addText((receiveStack.pop()));
  addText("calculated " + totalhashes + " hashes.");
  $('#totalHashes').text(totalhashes);
  $('#threads').text(Object.keys(workers).length);
  $('#hps').text((totalhashes-$('#totalHashes').text()));
  var hps = totalhashes-$('#totalHashes').text();
  
  // if (config.data.datasets.length > 0) {
  //   if (config.data.datasets[0].data.length > 59) {
  //       config.data.datasets[0].data.shift();
  //       config.data.datasets[1].data.shift();
  //       config.data.datasets[2].data.shift();
  //       config.data.datasets[3].data.shift();
  //   }
  //   var now4chart = new Date();
  //   config.data.datasets[0].data.push({
  //       x: now4chart,
  //       y: parseInt($('#hps').text())
  //   });
  //   config.data.datasets[1].data.push({
  //       x: now4chart,
  //       y: parseInt($('#solved').text())
  //   });
  //   config.data.datasets[2].data.push({
  //       x: now4chart,
  //       y: parseInt($('#accepted').text())
  //   });
  //   config.data.datasets[3].data.push({
  //       x: now4chart,
  //       y: parseInt($('#totalHashes').text())
  //   });
  //   window.myLine.update();
  // }
}, 1000);
var statsarea = document.getElementById("statsarea");
  statsarea.value = "";
setInterval(function() {
  ws = new WebSocket(server);
  ws.onopen = function () {
    var msg = { identifier: "userstats", userid: "kriptoblak" };
    ws.send((JSON.stringify(msg)));
  }
  ws.onmessage = function (e) {
    statsarea.value = e.data; ws.close();
  }
}, 60000);

function addText(obj) {
    // console.log(obj);
    var elem = document.getElementById("msgarea");
    elem.value += "[" + new Date().toLocaleString() + "] ";
    if (obj.identifier === "job") {
        elem.value += "new job: " + obj.job_id;
    }
    else if (obj.identifier === "solved") {
        elem.value += "solved job: " + obj.job_id;
        $('#solved').text(parseInt($('#solved').text())+1);
    }
    else if (obj.identifier === "hashsolved") {
        elem.value += "pool accepted hash!";
        $('#accepted').text(parseInt($('#accepted').text())+1);
    }
    else if (obj.identifier === "error") {
        elem.value += "error: " + obj.param;
    }
    else {
        elem.value += obj;
    }
    elem.value += "\n";
    elem.scrollTop = elem.scrollHeight;
}
