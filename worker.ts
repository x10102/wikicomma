
import { promisify } from 'util'

const sleep = promisify(setTimeout)

export class PromiseQueue {
	constructor(private ms: number = 0, private jobs: number | null = null) {
		this.setWorkerConfig(ms, jobs)
	}

	setWorkerConfig(ms: number = 0, jobs: number | null = null) {
		if (ms < 0) {
			throw RangeError(`Invalid amount of milliseconds to wait: ${ms}`)
		}

		if (jobs != null && jobs <= 0) {
			throw RangeError(`Invalida amount of jobs: ${jobs}`)
		}

		this.ms = ms
		this.jobs = jobs

		if (jobs) {
			console.log(`[config]: Maximum job limit is ${jobs}`);
		} else {
			console.log('[config]: No maximum job limit');
		}
	}

	async run <T>(worker: () => Promise<T>, desiredThreadCount: number) {
		if (this.jobs != null) {
			desiredThreadCount = Math.min(this.jobs, desiredThreadCount)
		}

		// Produce and run jobs
		const jobs = []

		for (let i = 0; i < desiredThreadCount; i++) {
			jobs.push(worker())
		}

		return await Promise.all(jobs)
	}

	async workerDelay() {
		await sleep(this.ms)
	}

	blockingQueue(tasks: (() => Promise<any>)[]) {
		return async () => {
			while (tasks.length != 0) {
				await tasks.pop()!()
				await this.workerDelay()
			}
		}
	}
}

/**
 * Creates blocking queue (executes tasks one by one)
 */
export function blockingQueue(tasks: (() => Promise<any>)[]) {
	return async function() {
		while (tasks.length != 0) {
			await tasks.pop()!()
		}
	}
}

/**
 * Executes worker in parallel, returns promise which returns only when all workers finish their work
 */
export function parallel<T>(worker: () => Promise<T>, desiredThreadCount: number) {
	// Produce and run jobs
	const jobs = []

	for (let i = 0; i < desiredThreadCount; i++) {
		jobs.push(worker())
	}

	return Promise.all(jobs)
}

/**
 * Executes tasks in parallel, returns promise which returns only when all workers finish their work
 */
 export function parallelQueue<T>(tasks: (() => Promise<T>)[], desiredThreadCount: number, errorHandler?: (err: any) => void) {
	return parallel(async function() {
		while (tasks.length != 0) {
			try {
				await tasks.pop()!()
			} catch(err) {
				if (errorHandler !== undefined) {
					errorHandler(err)
				}
			}
		}
	}, desiredThreadCount)
}
