// Optimisation de la mémoire dans un thread à part : parcourir et vider
// des centaines de processus ne fige plus le processus principal.
const { parentPort, workerData } = require('worker_threads');
const memory = require('./memory');

parentPort.postMessage(memory.optimize(workerData || {}));
