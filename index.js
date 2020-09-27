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
const THIS_RETURN = 'GatedObjectThisReturn';

/**
 * Abstract base class, do not use
 * @private
 */
class GatedObject {
    constructor(arg) {
        /* We are acquiring an existing GatedObject in a subthread */
        if (typeof arg === 'object' && arg.magic === 'GatedObjectMagic') {
            this.port = arg.port;
            this.methods = arg.methods;
            this.shared = arg.shared;
            this.msgCounter = new Int32Array(this.shared);
        } else {
            /* We are creating a new GatedObject
             *
             * This JS at its finest
             * Next time when someone asks you why
             * it is impossible to create a JS compiler,
             * show him this absolutely horrible but
             * otherwise perfectly valid JS code
             */
            const ownerThread = `
                const { parentPort, workerData } = require('worker_threads');
                const IGNORE_RETURN = '${IGNORE_RETURN}';
                const THIS_RETURN = '${THIS_RETURN}';
                function processRequest(message) {
                    try {
                        let r;
                        if (message.a[0] === IGNORE_RETURN) {
                            message.a.shift();
                            o[message.m].apply(o, message.a);
                            r = {};
                        } else 
                            r = o[message.m].apply(o, message.a);
                        if (r === o)
                            r = THIS_RETURN;
                        this.port.postMessage({ r });
                    } catch (e) {
                        this.port.postMessage({ e });
                    } finally {
                        Atomics.add(this.msgCounter, 0, 1);
                        Atomics.notify(this.msgCounter, 0);
                    }
                }
                let o = (() => {${arg}})();
                parentPort.on('message', (message) => {
                    if (message.port) {
                        message.msgCounter = new Int32Array(message.shared);
                        message.port.on('message', processRequest.bind(message));
                    }
                });`;

            const prototype = Function('require', arg)(require);
            this.shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
            this.msgCounter = new Int32Array(this.shared);

            /* Every GatedObject has a thread that owns the object */
            Atomics.store(this.msgCounter, 0, 0);
            this.thread = new Worker(ownerThread, {
                eval: true
            });
            this.port = this.__GatedObject_createChannel(this.shared);
            /* I wonder if prototype is referenced after this operation or it can be garbage-collected?
             * Normally the prototype property should be a reference to the class itself
             */
            this.methods = Object.getOwnPropertyNames(Object.getPrototypeOf(prototype));
        }

        for (let m of this.methods)
            if (!this.m)
                this[m] = this.__GatedObject_do.bind({ o: this, m });
    }

    __GatedObject_createChannel(shared) {
        const { port1, port2 } = new MessageChannel();
        this.thread.postMessage({ port: port1, shared }, [port1]);
        return port2;
    }

    clone() {
        const newShared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
        return {
            magic: 'GatedObjectMagic',
            port: this.__GatedObject_createChannel(newShared),
            shared: newShared,
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
     * @param {string} arg JS code that calls the constructor for the proxied object
     * The created object will have the same methods as the original one
     * All methods will have an optional first argument, IGNORE_RETURN, allowing
     * to avoid transfering large return values when they are not used
     * Typical example is Map.set() which returns this so it can be chained as Map.set().set()
     * Exceptions will be rethrown through the RPC but will lose their custom types should they have them
     */
    constructor(...args) {
        super(...args);
    }

    __GatedObject_do(a, ...args) {
        super.__GatedObject_do(a, ...args);
        let msg;
        while ((msg = receiveMessageOnPort(this.o.port)) === undefined)
            while (Atomics.wait(this.o.msgCounter, 0, 0) == 'ok');
        Atomics.sub(this.o.msgCounter, 0, 1);
        if (msg.message.e)
            throw msg.message.e;
        if (msg.message.r === THIS_RETURN)
            return this;
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
     * @param {string} arg JS code that calls the constructor for the proxied object
     * The created object will have the same methods as the original one except
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
        const msgCounter = this.locks.shift();
        Atomics.sub(this.msgCounter, 0, 1);
        if (message.e !== undefined)
            msgCounter.rej(message.e);
        else if (message.r === THIS_RETURN)
            msgCounter.res(this);
        else
            msgCounter.res(message.r);
    }

    __GatedObject_do(a, ...args) {
        super.__GatedObject_do(a, ...args);
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
     * @param {string} arg JS code that calls the constructor for the proxied object
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
        while ((msg = receiveMessageOnPort(this.port)) === undefined && block)
            Atomics.wait(this.msgCounter, 0, 0);
        Atomics.sub(this.msgCounter, 0, 1);
        if (!msg)
            return undefined;
        if (msg.message.e)
            throw msg.message.e;
        if (msg.message.r === THIS_RETURN)
            return this;
        return msg.message.r;
    }

    __GatedObject_do(...args) {
        super.__GatedObject_do(...args);
    }
}

module.exports = {
    IGNORE_RETURN,
    GatedObjectSync,
    GatedObjectAsync,
    GatedObjectPolling
};