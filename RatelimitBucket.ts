
export class RatelimitBucket {
	private observers: (() => void)[] = []
	private tokens = this.capacity
	private timer?: NodeJS.Timer

	constructor(
		private capacity: number,
		private refill_seconds: number
	) {
		if (capacity <= 0) {
			throw new RangeError(`Invalid capacity: ${capacity}`)
		}

		if (refill_seconds <= 0) {
			throw new RangeError(`Invalid refill seconds: ${refill_seconds}`)
		}
	}

	public starTimer() {
		if (this.timer != undefined) {
			throw Error(`Timer already started!`)
		}

		const fillDelayMs = 1000 * this.refill_seconds / this.capacity
		this.timer = setInterval(() => this.addToken(), fillDelayMs)
	}

	public stopTimer() {
		if (this.timer == undefined) {
			throw Error(`No timer present!`)
		}

		clearInterval(this.timer)
	}

	private addToken() {
		this.tokens = Math.min(this.tokens + 1, this.capacity)

		if (this.tokens > 0) {
			const observer = this.observers.splice(0, 1)

			if (observer.length != 0 && this.allocate()) {
				observer[0]()
			}
		}
	}

	/* Consume a ratelimit token, if present */
	public allocate(): boolean {
		if (this.tokens > 0) {
			this.tokens--
			return true
		}

		return false
	}

	/* Wait until a token can be consumed */
	public wait(): Promise<void> {
		return new Promise((resolve) => {
			if (this.allocate()) {
				resolve()
				return
			}

			this.observers.push(resolve)
		})
	}
}
