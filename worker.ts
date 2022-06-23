import { promisify } from 'util'

let delayMs: number = -1;
let maximumJobCount: number = -1;
const sleep = promisify(setTimeout)

export async function workerDelay() {
	await sleep(delayMs)
}

export function setWorkerConfig(ms?: number, jobs?: number) {
	delayMs = ms || 0;
	console.log(`[config]: Delay between jobs is ${delayMs}ms`);

	maximumJobCount = jobs || -1;
	if (jobs) {
		console.log(`[config]: Maximum job limit is ${jobs}`);
	} else {
		console.log('[config]: No maximum job limit');
	}
}

export function buildWorker(tasks: any[]) {
	return async function() {
		while (tasks.length != 0) {
			await tasks.pop()()
			await workerDelay()
		}
	};
}

export async function runWorkers(worker: any, count: number) {
	// Set job count
	if (maximumJobCount !== -1) {
		count = Math.min(count, maximumJobCount)
	}

	// Produce and run jobs
	const jobs = []

	for (let i = 0; i < count; i++) {
		jobs.push(worker())
	}

	await Promise.all(jobs)
}
