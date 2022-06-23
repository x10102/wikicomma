import { promisify } from 'util'

let delayMs: number = -1;
const sleep = promisify(setTimeout)

export function workerDelay() {
	return sleep(delayMs)
}

export function setDelayMs(ms?: number) {
	delayMs = ms || 0;
	console.log(`[config]: Delay between jobs is ${delayMs}ms`);
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
	const jobs = []

	for (let i = 0; i < count; i++) {
		jobs.push(worker())
	}

	await Promise.all(jobs)
}
