 # GatedObject

A module for creating a transparent RPC interface for non-thread safe objects to be used in a multi-threaded environment
  
Supports blocking synchronous, asynchronous and non-blocking polling 
  
**Only compatible with Node.js worker_threads at the moment**

## Introduction

I created this module to be able to use advanced data structures that can not be easily rendered multi-threading-capable. Keep in mind that this works through RPC so it is an order of magnitude slow than [SharedMap](https://github.com/mmomtchev/SharedMap) which was built from the ground-up for multi-threading. Its advantage is that it is completely transparent and supports (almost) all existing JS libraries.

It supports three modes of operation
* synchronous, which is the most natural to use but it is slow and wasteful
* asynchronous, which is much faster and returns Promises which are natural to use in JS
* polling, which is unusual to use in JS, but can be very versatile and does not require async

Run npm test to see how much ops/s you will get with each method in your case. Typical values on a recent Core i7 for an RPC containing a simple object with a few primitives types are about 40Kops/s for synchronous mode and more than 1Mops/s for asynchronous and polling mode.

The module supports gating primitive types as Date and String, but if this is what you need [objectbuffer](https://github.com/Bnaya/objectbuffer) which uses shared memory is a much better choice.

Keep in mind that the current version of test.js (as well as the examples), make use of *transferList* in the *Worker* constructor which requires an up-to-date Node.js LTS [#32250](https://github.com/nodejs/node/issues/32250). The module itself should work on older versions.


## Installation

(the 0.0.1 version is not yet published, clone from here if you want it)

```bash
npm install --save gatedobject
```

## Usage

These examples use [@mourner's](https://github.com/mourner) excellent [RBush](https://github.com/mourner/rbush) for which this module was initially created

### Synchronous mode
```js
const { IGNORE_RETURN, GatedObjectAsync, GatedObjectSync, GatedObjectPolling } = require('./index');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    /**
     * Create a new GatedObject in sync mode with the CJS module name and the class name
     * class name should be null when the module itself is the class/constructor
     */
    const myRBush = new GatedObjectSync('rbush', null, 16);

    /** 
     * Create a clone for a subthread 
     * Every thread requires a separate clone
     */
    const cloneRBush = myRBush.clone();

    /* Create a subthread and pass the clone */
    new Worker(__filename, {
        workerData: { myRBush: cloneRBush },
        /* Ask the JS designers why this must be explicit */
        transferList: [cloneRBush.port]
    });

    /* Use like nothing happened */
    myRBush.insert({ minX: 1, minY: 1, maxX: 10, maxY: 10, data: 'data1' });

    /** 
     * All methods gain an additional optional first argument IGNORE_RETURN
     * which allows you to avoid copying large return results when you ignore them
     * RBush.insert() is an excellent example as it will return this (the whole data structure)
     * so that operations can be chained like this RBush.insert().insert().insert()...
     */
    myRBush.insert(IGNORE_RETURN, { minX: 2, minY: 2, maxX: 5, maxY: 5, data: 'data2' });
} else {
    /**
     * Import the clone
     * You are allowed to import a sync object as an async or polling
     * or every other possible combination
     * You are even allowed to clone an object twice and to import
     * it twice with different strategies
     */
    const myRBush = new GatedObjectSync(workerData.myRBush);

    /* Use like nothing happened, all the data is here */
    myRBush.insert({ minX: 4, minY: 4, maxX: 6, maxY: 6, data: 'data3' });
    console.log(myRBush.all().length);
}

```

### Asynchronous mode
```js
const { IGNORE_RETURN, GatedObjectAsync, GatedObjectSync, GatedObjectPolling } = require('./index');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    /**
     * Create a new GatedObject in sync mode with the CJS module name and the class name
     * class name should be null when the module itself is the class/constructor
     */
    const myRBush = new GatedObjectAsync('rbush', null, 16);

    /** 
     * Create a clone for a subthread 
     * Every thread requires a separate clone
     */
    const cloneRBush = myRBush.clone();

    /* Create a subthread and pass the clone */
    new Worker(__filename, {
        workerData: { myRBush: cloneRBush },
        /* Ask the JS designers why this must be explicit */
        transferList: [cloneRBush.port]
    });

    /* All methods return a promise now */
    myRBush.insert({ minX: 1, minY: 1, maxX: 10, maxY: 10, data: 'data1' })
        .then(() => myRBush.insert(IGNORE_RETURN, { minX: 2, minY: 2, maxX: 5, maxY: 5, data: 'data2' }))
        .catch((e) => console.error(e));
} else {
    /**
     * Import the clone
     * You are allowed to import a sync object as an async or polling one
     * or every other possible combination
     * You are even allowed to clone an object twice and to import
     * it twice with different strategies
     */
    const myRBush = new GatedObjectSync(workerData.myRBush);

    /* Here nothing has changed, we are still in sync mode */
    myRBush.insert({ minX: 4, minY: 4, maxX: 6, maxY: 6, data: 'data3' });
    console.log(myRBush.all().length);
}

```


### Polling mode
```js
const { IGNORE_RETURN, GatedObjectAsync, GatedObjectSync, GatedObjectPolling } = require('./index');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (isMainThread) {
    /**
     * Create a new GatedObject in sync mode with the CJS module name and the class name
     * class name should be null when the module itself is the class/constructor
     */
    const myRBush = new GatedObjectPolling('rbush', null, 16);

    /** 
     * Create a clone for a subthread 
     * Every thread requires a separate clone
     */
    const cloneRBush = myRBush.clone();

    /* Create a subthread and pass the clone */
    new Worker(__filename, {
        workerData: { myRBush: cloneRBush },
        /* Ask the JS designers why this must be explicit */
        transferList: [cloneRBush.port]
    });

    /**
     * Now you must poll for a return value
     * Everything is serialized, you must poll
     * the same number of times you called the method
     **/
    myRBush.insert({ minX: 1, minY: 1, maxX: 10, maxY: 10, data: 'data1' });
    /* continue your work */
    r = myRBush.poll();
    if (r === undefined)
    /* continue your work */
     {}
    /* ok, now you need it, block waiting */
    r = myRBush.poll(true)
} else {
    /**
     * Import the clone
     * You are allowed to import a sync object as an async or polling
     * or every other possible combination
     * You are even allowed to clone an object twice and to import
     * it twice with different strategies
     */
    const myRBush = new GatedObjectAsync(workerData.myRBush);

    /* Use with Promises */
    myRBush.insert({ minX: 4, minY: 4, maxX: 6, maxY: 6, data: 'data3' })
        .then(() => console.log(myRBush.all().length));
        .catch((e) => console.error(e));
}

```