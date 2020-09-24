var path = require('path');
var url = require('url');
var cookieParser = require('cookie-parser')
var express = require('express');
var session = require('express-session')
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');
const Rx = require('rxjs');
const op = require('rxjs/operators');
const k$ = require('./kurento-rxjs'); // kurento rxjs framework


var argv = minimist(process.argv.slice(2), {
  default: {
      as_uri: 'https://localhost:8443/',
      ws_uri: 'ws://localhost:8888/kurento'
  }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
* Management of sessions
*/
app.use(cookieParser());

var sessionHandler = session({
  secret : 'none',
  rolling : true,
  resave : true,
  saveUninitialized : true
});

app.use(sessionHandler);

/*
 * Definition of global variables.
 */
var sessions = {};
var candidatesQueue = {};

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
  console.log('Kurento Tutorial started');
  console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/helloworld'
});

const ws$ = k$.createKurento$(wss, argv.ws_uri, sessionHandler);

/*
 * Helper private functions
 */
const handleOnIceCandidate = (webRtcEndpoint, { ws }) => {
  webRtcEndpoint.on('OnIceCandidate', event => {
    var candidate = kurento.getComplexType('IceCandidate')(event.candidate);
    ws.send(JSON.stringify({
        id : 'iceCandidate',
        candidate : candidate
    }));
  });
};
const addPipelineToSessions = (webRtcEndpoint, { sid, pipeline }) => {
  sessions[sid] = {
    'pipeline': pipeline,
    'webRtcEndpoint': webRtcEndpoint
  }
};
const processCandidate = (webRtcEndpoint, { sid }) => {
  if (candidatesQueue[sid]) {
    while(candidatesQueue[sid].length) {
      var candidate = candidatesQueue[sid].shift();
      webRtcEndpoint.addIceCandidate(candidate);
    }
  }
}
const sendSdpAnswer = (_, { ws, sdpAnswer }) => {
  console.log('Sending sdp answer', sdpAnswer);
  ws.send(JSON.stringify({
    id : 'startResponse',
    sdpAnswer : sdpAnswer
  }))
}


/*
 * Core functionality
 */

// create start rxjs pipeline (not to be confused with kurento pipeline)
const start$ = ws$.pipe(
  k$.onMessage('start'), // filter by message.id === 'start'
  k$.createPipeline(),   // create Kurento media pipeline
  k$.createMediaElements(
    ['WebRtcEndpoint', 'endpoint']  // create one WebRtcEndpoint with id 'endpoint'
  ),
  k$.connect('endpoint').to('endpoint'), // create a loopback
  k$.withElement('endpoint').do(processCandidate), // process candidate
  k$.withElement('endpoint').do(handleOnIceCandidate), // handle onIceCandidate
  k$.withElement('endpoint').append(el => el.processOffer, ctx => ctx.message.sdpOffer, 'sdpAnswer'), // process SDP offer
  k$.withElement('endpoint').do(addPipelineToSessions), // add pipeline to the sessions array
  k$.withElement('endpoint').exec(el => el.gatherCandidates), // gather candidates
  k$.withElement('endpoint').do(sendSdpAnswer) // send SDP Answer
)

// create stop rxjs pipeline (not to be confused with kurento pipeline)
const stop$ = ws$.pipe(
  k$.onMessage('stop'),
  op.tap(({ sid }) => {
    if (sessions[sid]) {
      var pipeline = sessions[sid].pipeline;
      console.info('Releasing pipeline');
      pipeline.release();

      delete sessions[sid];
      delete candidatesQueue[sid];
    }
  })
)

// crete onIceCandidate rxjs pipeline (not to be confused with kurento pipeline)
const onIceCandidate$ = ws$.pipe(
  k$.onMessage('onIceCandidate'),
  op.tap(({ sid, message }) => {
    var candidate = kurento.getComplexType('IceCandidate')(message.candidate);

    if (sessions[sid]) {
        console.info('Sending candidate');
        var webRtcEndpoint = sessions[sid].webRtcEndpoint;
        webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sid]) {
            candidatesQueue[sid] = [];
        }
        candidatesQueue[sid].push(candidate);
    }
  })
)

// merge all rxjs pipelines and also add default pipeline to send out invalid massage
// and subscribe
Rx.merge(start$, stop$, onIceCandidate$).pipe(
  op.defaultIfEmpty(({ ws, message }) => {
    ws.send(JSON.stringify({
      id : 'error',
      message : 'Invalid message ' + message
    }));
  })
).subscribe();

app.use(express.static(path.join(__dirname, 'static')));