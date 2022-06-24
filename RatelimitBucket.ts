
export class RatelimitBucket {
	private enabled: boolean
	private tokens: number
	private capacity: number

	constructor(
		config?: { bucket_size: number, refill_seconds: number },
	) {
		if (!config) {
			this.enabled = false
			this.tokens = 0
			this.capacity = 0
			return
		}

		this.enabled = true
		this.capacity = config.bucket_size
		this.tokens = this.capacity

		const fillDelayMs = 1000 * config.refill_seconds / config.bucket_size
		setInterval(() => this.addToken(), fillDelayMs)
	}

	private addToken() {
		this.tokens = Math.min(this.tokens + 1, this.capacity)
	}

	/* Consume a ratelimit token, if present */
	take(): boolean {
		if (!this.enabled) {
			return true
		}

		if (this.tokens > 0) {
			this.tokens--
			return true
		}

		return false
	}

	/* Wait until a token can be consumed */
	async wait() {
		const poll = (resolve: any) => {
			if (this.take()) {
				resolve()
			} else {
				setTimeout(_ => poll(resolve), 200)
			}
		};

		return new Promise(poll)
	}
}
