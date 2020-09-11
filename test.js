const { IGNORE_RETURN, GatedObjectAsync, GatedObjectSync, GatedObjectPolling } = require('./index');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const NWORKERS = require('os').cpus().length;
const CALLS = 10000;

if (isMainThread) {
    const myRBush = new GatedObjectSync('return new(require("rbush"))', null, 16);
    let finished = 0,
        tsync = 0,
        tasync = 0,
        tpolling = 0;
    for (let i = 0; i < NWORKERS; i++) {
        const cloneRBush1 = myRBush.clone();
        const cloneRBush2 = myRBush.clone();
        const cloneRBush3 = myRBush.clone();
        new Worker(__filename, {
            workerData: {
                myRBush1: cloneRBush1,
                myRBush2: cloneRBush2,
                myRBush3: cloneRBush3
            },
            transferList: [cloneRBush1.port, cloneRBush2.port, cloneRBush3.port]
        }).on('exit', () => {
            finished++;
            const ops = CALLS * 3 * NWORKERS;
            if (finished == NWORKERS) {
                if (myRBush.all().length !== ops)
                    throw new Error('Coherence error ' + myRBush.all().length);
                console.log(`sync    mode: ${tsync}ms  ${Math.round(ops * 1000 / tsync)} ops/s`);
                console.log(`polling mode: ${tpolling}ms  ${Math.round(ops * 1000 / tpolling)} ops/s`);
                console.log(`async   mode: ${tasync}ms  ${Math.round(ops * 1000 / tasync)} ops/s`);
                myRBush.thread.terminate();
            }
        }).on('message', (msg) => {
            tsync += msg.tsync;
            tasync += msg.tasync;
            tpolling += msg.tpolling;
        });
    }
} else {
    const myRBush1 = new GatedObjectSync(workerData.myRBush1);
    const myRBush2 = new GatedObjectPolling(workerData.myRBush2);
    const myRBush3 = new GatedObjectAsync(workerData.myRBush3);

    let t0 = Date.now();
    for (let i = 0; i < CALLS; i++)
        myRBush1.insert({ minX: i, minY: i, maxX: i + 10, maxY: i + 10, data: 'data ' + i });
    let tsync = Date.now() - t0;

    t0 = Date.now();
    for (let i = 0; i < CALLS - 1; i++)
        myRBush2.insert(IGNORE_RETURN, { minX: i, minY: i, maxX: i + 10, maxY: i + 10, data: 'data ' + i });
    myRBush2.insert({ minX: 5, minY: 5, maxX: 15, maxY: 15, data: 'data ' + 55 });
    myRBush2.poll(true);
    let tpolling = Date.now() - t0;

    let p;
    t0 = Date.now();
    for (let i = 0; i < CALLS; i++)
        p = myRBush3.insert({ minX: i, minY: i, maxX: i + 10, maxY: i + 10, data: 'data ' + i });
    let tasync = Date.now() - t0;
    parentPort.postMessage({ tsync, tasync, tpolling });
    p.then(() => {
        process.exit(0);
    });
}