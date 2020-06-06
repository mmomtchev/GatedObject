/**
 * GatedObject
 * 
 * A library for creating a transparent RPC interface
 * for non-thread safe objects to be used in a
 * multi-threaded environment
 * 
 * Supports blocking synchronous, asynchronous and
 * non-blocking polling 
 * 
 * Compatible only with Node.js worker_threads at the moment
 * 
 * @author Momtchil Momtchev <momtchil@momtchev.com>
 * @see http://github.com/mmomtchev/GatedObject
 */

const {
    Worker, MessageChannel, isMainThread, parentPort, workerData, receiveMessageOnPort
} = require('worker_threads');

const IGNORE_RETURN = 'GatedObjectIgnoreReturn';

/**
 * Abstract base class, do not use
 * @private
 */
class GatedObject {
    constructor(objClass, subClass) {
        /* We are acquiring an existing GatedObject in a subthread */
        if (typeof objClass === 'object' && objClass.magic === 'GatedObjectMagic') {
            this.port = objClass.port;
            this.methods = objClass.methods;
            this.file = objClass.file;
        } else {
            /* We are creating a new GatedObject */
            let _class;
            if (globalThis[objClass])
                _class = globalThis[objClass];
            else {
                _class = require(objClass);
                if (subClass)
                    _class = _class[subClass];
                this.file = objClass;
            }
            this.thread = new Worker(__filename, {
                workerData: {
                    magic: 'GatedObjectMagic',
                    objClass: objClass,
                    subClass: subClass,
                    arguments: Object.keys(arguments).map(x => arguments[x]).slice(2)
                }
            });
            this.port = this.__GatedObject_createChannel();
            this.methods = Object.getOwnPropertyNames(_class.prototype);
        }

        for (let m of this.methods)
            if (!this.m)
                this[m] = this.__GatedObject_do.bind({ o: this, m });
    }

    __GatedObject_createChannel() {
        const { port1, port2 } = new MessageChannel();
        this.thread.postMessage({ newPort: port1 }, [port1]);
        return port2;
    }

    clone() {
        return {
            magic: 'GatedObjectMagic',
            port: this.__GatedObject_createChannel(),
            file: this.file,
            methods: this.methods
        };
    }

    __GatedObject_do() {
        this.o.port.postMessage({
            m: this.m,
            a: Object.keys(arguments).map(x => arguments[x])
        });
    }
}

/**
 * Synchronous GatedObject
 * Represents an object that can be transparently
 * shared with subthreads through RPC. RPC are
 * synchronous.
 */
class GatedObjectSync extends GatedObject {
    /**
     * Creates new GatedObject
     * @param {string} objClass CJS filename containting the class to be instantiated or built-in type
     * @param {string} subClass Class/constructor name or null if the CJS module is the constructor
     * @param {...*} args Arguments to be passed to the constructor
     * The created object will have the same methods as objClass
     * All methods will have an optional first argument, IGNORE_RETURN, allowing
     * to avoid transfering large return values when they are not used
     * Typical example is Map.set() which returns this so it can be chained as Map.set().set()
     * Exceptions will be rethrown through the RPC but will lose their custom types should they have them
     */
    constructor(...args) {
        super(...args);
    }

    __GatedObject_do(...args) {
        super.__GatedObject_do(...args);
        let msg;
        while ((msg = receiveMessageOnPort(this.o.port)) === undefined);
        if (msg.message.e)
            throw msg.message.e;
        return msg.message.r;
    }
}

/**
 * Asynchronous GatedObject
 * Represents an object that can be transparently
 * shared with subthreads through RPC. RPC are
 * asynchronous and every method returns a Promise
 */
class GatedObjectAsync extends GatedObject {
    /**
     * Creates new GatedObject
     * @param {string} objClass CJS filename containting the class to be instantiated or built-in type
     * @param {string} subClass Class/constructor name or null if the CJS module is the constructor
     * @param {...*} args Arguments to be passed to the constructor
     * The created object will have the same methods as objClass except
     * that they will always return a Promise that will resolve with the return value
     * Exceptions will be transformed to rejected Promises
     * All methods will have an optional first argument, IGNORE_RETURN, allowing
     * to avoid transfering large return values when they are not used
     * Typical example is Map.set() which returns this so it can be chained as Map.set().set()
     */
    constructor(...args) {
        super(...args);
        this.port.on('message', this.__GatedObject_processResponse.bind(this));
        this.locks = [];
    }

    __GatedObject_processResponse(message) {
        const lock = this.locks.shift();
        if (message.e !== undefined)
            lock.rej(message.e);
        else
            lock.res(message.r);
    }

    __GatedObject_do(...args) {
        super.__GatedObject_do(...args);
        return new Promise((res, rej) => {
            this.o.locks.push({ res, rej });
        });
    }
}

/**
 * Polling GatedObject
 * Represents an object that can be transparently
 * shared with subthreads through RPC. RPC are
 * synchronous, but non-blocking with polling
 */
class GatedObjectPolling extends GatedObject {
    /**
     * Creates new GatedObject
     * @param {string} objClass CJS filename containting the class to be instantiated or built-in type
     * @param {string} subClass Class/constructor name or null if the CJS module is the constructor
     * @param {...*} args Arguments to be passed to the constructor
     */
    constructor(...args) {
        super(...args);
    }

    /**
     * Polls the interface for a return value
     * @param {boolean} block will block if called with block=true
     * @returns {*|undefined} undefined if the RPC is not finished, the return value otherwise
     */
    poll(block) {
        let msg;
        while ((msg = receiveMessageOnPort(this.port)) === undefined && !block);
        if (!msg)
            return undefined;
        if (msg.message.e)
            throw msg.message.e;
        return msg.message.r;
    }

    __GatedObject_do(...args) {
        super.__GatedObject_do(...args);
    }
}

let o;

function processRequest(message) {
    try {
        let r;
        if (message.a[0] === IGNORE_RETURN) {
            message.a.shift();
            o[message.m].apply(o, message.a);
        } else
            r = o[message.m].apply(o, message.a);
        this.postMessage({ r });
    } catch (e) {
        this.postMessage({ e });
    }
}

if (!isMainThread && workerData !== undefined && workerData.magic === 'GatedObjectMagic') {
    let _class;
    if (globalThis[workerData.objClass])
        _class = globalThis[workerData.objClass];
    else {
        _class = require(workerData.objClass);
        if (workerData.subClass)
            _class = _class[workerData.subClass];
    }
    workerData.arguments.unshift(null);
    o = new (Function.prototype.bind.apply(_class, workerData.arguments))();

    parentPort.on('message', (message) => {
        if (message.newPort) {
            message.newPort.on('message', processRequest.bind(message.newPort));
        }
    });
}

module.exports = {
    IGNORE_RETURN,
    GatedObjectSync,
    GatedObjectAsync,
    GatedObjectPolling
};