var kurento = require('kurento-client');
const Rx = require('rxjs');
const op = require('rxjs/operators');

/*
 * Helper methods
 */
const exec = fn => op.flatMap(v => fn(v).pipe(op.mapTo(v)));
const append = (observableFn, key) => op.flatMap(args => observableFn(args).pipe(op.map(x => ({ ...args, [key]: x }))));
const createMediaElement = pipeline => Rx.bindNodeCallback(pipeline.create);
const mediaElementConnect = (source, sink) => Rx.bindNodeCallback(source.connect.bind(source))(sink);

/*
 * Create Kurento stream
 */
const createKurento$ = (wss, kurentoServerUrl, sessionHandler) => {
  let kurentoClient = null;
  const ws$ = new Rx.Subject()
    .pipe(
      append(ctx => Rx.iif(() => !kurentoClient, Rx.bindNodeCallback(kurento).call(ctx, kurentoServerUrl), Rx.of(kurentoClient)), 'client')
    );
  wss.on('connection', ws => {
    console.log('connecion');
    var sid = null;
    var request = ws.upgradeReq;
    var response = {
        writeHead : {}
    };

    sessionHandler(request, response, err => sid = request.session.id);

    ws.on('message', _message => ws$.next({ ws, sid, message: JSON.parse(_message) }));
    ws.on('error', e => ws$.error(e));
    ws.on('close', _ => ws$.complete());
  });
  return ws$;
};

/*
 * Filter stream by message.id
 */
const onMessage = m => op.filter(({ message }) => message.id === m);

/*
 * Create Kurento media pipeline
 */
const createPipeline = () => Rx.pipe(
  append(ctx => Rx.bindNodeCallback(ctx.client.create).call(ctx, 'MediaPipeline'), 'pipeline'),
  op.catchError(_ => ctx.pipeline.release())
);

/*
 * Create media elements
 */
const createMediaElements = (...elements) => Rx.pipe(
  append(ctx => 
    Rx.forkJoin(...elements.map(el => createMediaElement(ctx.pipeline)(el[0]))).pipe(
      op.map(v => v.reduce((acc, el, i) => ({ ...acc, [elements[i][1]]: el }), {} ))
    )
  , 'elements')
)

/*
 * Connect media elements
 */
const connect = source => ({ to: sink =>exec(v => mediaElementConnect(v.elements[source], v.elements[sink]))});

/*
 * Select created media element and provide additional APIs
 */
const withElement = element => ({ 
  do: fn => op.tap(ctx => fn(ctx.elements[element], ctx)),
  append: (methodFn, argsFn, key) => append(ctx => {
    const m = Rx.bindNodeCallback(methodFn(ctx.elements[element]).bind(ctx.elements[element]));
    return argsFn ? m(argsFn(ctx)) : m();
  }, key),
  exec: (methodFn, argsFn) => exec(ctx => {
    const m = Rx.bindNodeCallback(methodFn(ctx.elements[element]).bind(ctx.elements[element]));
    return argsFn ? m(argsFn(ctx)) : m();
  })
});

module.exports = { createKurento$, onMessage, createPipeline, createMediaElements, connect, withElement }