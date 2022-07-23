
// Copyright (c) 2022 DBotThePony

// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without
// restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons
// to whom the Software is furnished to do so, subject to the
// following conditions:

// The above copyright notice and this permission notice shall be
// included in all copiesor substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
// THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
// OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
// OTHER DEALINGS IN THE SOFTWARE.

import http = require('http')
import https = require('https')
import urlModule = require('url')
import {unzip, brotliDecompress, inflate} from 'zlib'
import {promisify} from 'util'
import {RatelimitBucket} from './RatelimitBucket'

const punzip = promisify(unzip)
const pbrotliDecompress = promisify(brotliDecompress)
const pinflate = promisify(inflate)

export interface Headers {
	[key: string]: string
}

export interface BakedRequest {
	onStart?: (response: http.IncomingMessage) => void
	url: urlModule.URL
	body?: string | Buffer
	headers?: Headers
	method: 'POST' | 'GET'
	https: boolean
	followRedirects: boolean
	agent: http.Agent | https.Agent
	reject: (err?: any) => void
	resolve: (value: Buffer) => void
	traceback?: string
	requestFailures: number
}

export interface RequestConfig {
	headers?: Headers
	onStart?: (response: http.IncomingMessage) => void
	body?: string | Buffer
	followRedirects?: boolean
}

export interface HTTPCookieData {
	name: string
	value: string
	path: string | null
	domain: string | null
	expires: Date | null
	secure: boolean
}

export class HTTPCookie implements HTTPCookieData {
	public path: string | null = null
	public domain: string | null = null
	public expires: Date | null = null
	public secure: boolean = false

	constructor(
		public name: string,
		public value: string
	) {
	}

	public save(): HTTPCookieData {
		return {
			value: this.value,
			name: this.name,
			path: this.path,
			domain: this.domain,
			expires: this.expires,
			secure: this.secure,
		}
	}

	public load(value: HTTPCookieData) {
		this.value = value.value
		this.name = value.name
		this.path = value.path
		this.domain = value.domain
		this.expires = value.expires ? new Date(value.expires) : null
		this.secure = value.secure
	}
}

class HTTPError {
	constructor(
		public response: number | undefined,
		public body: string | Buffer | null,
		public message: string | null
	) {
	}

	public toString() {
		return `HTTPError[response: ${this.response}; body: ${this.body}; message: ${this.message}]`
	}
}

export class CookieJar {
	public cookies: HTTPCookie[] = []
	public onCookieAdded?: () => void

	constructor() {

	}

	public save() {
		const listing = []

		for (const cookie of this.cookies) {
			listing.push(cookie.save())
		}

		return listing
	}

	public load(values: HTTPCookieData[]) {
		this.cookies = []

		for (const cookie of values) {
			const construct = new HTTPCookie('', '')
			construct.load(cookie)
			this.cookies.push(construct)
		}
	}

	public static domainMatcher = /https?:\/\/(.*?)(\/|$)/i

	public get(url: urlModule.URL): HTTPCookie[] {
		const result: HTTPCookie[] = []

		const secure = url.protocol == 'https:'
		const path = url.pathname
		const domainName = url.host

		for (const cookie of this.cookies) {
			if (
				(!cookie.secure || secure) &&
				(cookie.path == null || path.startsWith(cookie.path)) &&
				(cookie.domain == null || domainName.endsWith(cookie.domain)) &&
				(cookie.expires == null || cookie.expires.getTime() >= Date.now())
			) {
				result.push(cookie)
			}
		}

		return result
	}

	public getSpecific(url: urlModule.URL, name: string) {
		for (const cookie of this.get(url)) {
			if (cookie.name == name) {
				return cookie
			}
		}

		return null
	}

	public build(url: urlModule.URL): string {
		const list = this.get(url)
		const result: string[] = []

		for (const cookie of list) {
			result.push(`${cookie.name}=${cookie.value}`)
		}

		return result.join('; ')
	}

	public removeSpecific(url: urlModule.URL, name: string) {
		for (const cookie of this.get(url)) {
			if (cookie.name == name) {
				const i = this.cookies.indexOf(cookie)

				if (i == -1) {
					throw new Error('HOW')
				}

				this.cookies.splice(i, 1)

				return cookie
			}
		}

		return null
	}

	public put(cookie: string, domain: string): boolean {
		const split = cookie.split(';')

		let secure = false
		let firstPair = true
		let key: string | undefined
		let value: string | undefined
		let expires: Date | null = null
		let path: string | null = null

		for (const token of split) {
			const trim = token.trim()
			const lower = trim.toLowerCase()

			if (lower == 'secure') {
				secure = true
			} else if (lower == 'httponly') {
				// no meaningful input
			} else if (lower.indexOf('=') != -1) {
				const [_key, _value] = trim.split('=')

				if (firstPair) {
					firstPair = false
					key = _key
					value = _value
				} else {
					const lowerKey = _key.toLowerCase()

					if (lowerKey == 'expires') {
						expires = new Date(_value)
					} else if (lowerKey == 'domain') {
						domain = _value
					} else if (lowerKey == 'path') {
						path = _value
					} else if (lowerKey == 'max-age') {
						const digit = parseInt(_value)

						if (digit == 0) {
							expires = new Date(0)
						} else {
							expires = new Date(Date.now() + digit)
						}
					}
				}
			}
		}

		if (key == undefined || value == undefined) {
			return false
		}

		const cookieConstruct = new HTTPCookie(key, value)
		cookieConstruct.expires = expires
		cookieConstruct.domain = domain
		cookieConstruct.path = path
		cookieConstruct.secure = secure

		for (const i in this.cookies) {
			if (
				this.cookies[i].domain == cookieConstruct.domain &&
				this.cookies[i].name == cookieConstruct.name &&
				this.cookies[i].path == cookieConstruct.path
			) {
				this.cookies.splice(parseInt(i), 1)
			}
		}

		this.cookies.push(cookieConstruct)

		if (this.onCookieAdded != undefined) {
			this.onCookieAdded()
		}

		return true
	}
}

import { SocksProxyAgent } from 'socks-proxy-agent';

export class HTTPClient {
	public cookies = new CookieJar()

	private httpsagent: https.Agent = new https.Agent({
		keepAlive: true,
		keepAliveMsecs: 10000,
		maxSockets: this.connections
	})

	private httpagent: http.Agent = new http.Agent({
		keepAlive: true,
		keepAliveMsecs: 10000,
		maxSockets: this.connections
	})

	private socksagent?: http.Agent

	public ratelimit?: RatelimitBucket

	constructor(
		private connections = 8,
		private proxyAddress?: string,
		private proxyPort?: number,
		proxySocksAddress?: string,
		proxyPortSocks?: number
	) {
		if (proxySocksAddress != undefined && proxyPortSocks != undefined) {
			const agent = new SocksProxyAgent({
				hostname: proxySocksAddress,
				port: proxyPortSocks,
			})

			agent.maxSockets = this.connections
			agent.options.maxSockets = this.connections
			agent.options.maxFreeSockets = this.connections
			agent.options.maxTotalSockets = this.connections
			agent.options.keepAlive = true
			agent.options.keepAliveMsecs = 10000

			this.socksagent = agent
		}
	}

	private waiters: any[] = []
	private freeAlloc = this.connections

	private alloc(): Promise<void> {
		return new Promise((resolve) => {
			if (this.freeAlloc > 0) {
				this.freeAlloc--
				resolve()
			} else {
				this.waiters.push(resolve)
			}
		})
	}

	private free() {
		this.freeAlloc = Math.min(this.freeAlloc + 1, this.connections)

		if (this.waiters.length != 0) {
			this.waiters.splice(0, 1)[0]()
			this.freeAlloc--
		}
	}

	private regenerateAt = Date.now()

	private async handleRequest(value: BakedRequest) {
		if (this.ratelimit != undefined) {
			await this.ratelimit.wait()
		}

		let regenerateAmount = Math.floor((Date.now() - this.regenerateAt) / 10_000)

		if (regenerateAmount > 0) {
			// hack around weird bug when free never gets called
			// and maybe also promise on request never returns????
			this.regenerateAt += regenerateAmount * 10_000

			while (this.freeAlloc < this.connections && regenerateAmount > 0) {
				this.free()
				regenerateAmount--
			}
		}

		await this.alloc()

		const buildCookie = this.cookies.build(value.url)

		const params: http.RequestOptions = {
			hostname: value.url.host,
			port: value.url.port,
			path: value.url.pathname + value.url.search,
			agent: value.agent,
			method: value.method,
			headers: {
				'User-Agent': 'Mozilla/5.0 (Compatible; ArchiveBot) WikiComma/universal',
				'Connection': 'keep-alive',
				'Accept': '*/*',
				'Accept-Encoding': 'br, gzip, deflate'
			}
		}

		if (!value.https && this.proxyAddress != undefined && this.proxyPort != undefined) {
			params.hostname = this.proxyAddress
			params.port = this.proxyPort
			params.path = value.url.href
			params.agent = this.httpagent
			params.headers!['Host'] = value.url.hostname
		} else if (value.https && this.socksagent != undefined) {
			params.agent = this.socksagent
		}

		if (buildCookie != '') {
			params.headers!['Cookie'] = buildCookie
		}

		if (value.headers != undefined) {
			for (const key in value.headers) {
				params.headers![key] = value.headers[key]
			}
		}

		if (value.body != undefined) {
			params.headers!['content-length'] = value.body.length
		}

		let finished = false
		let lastActivity = Date.now()
		let stream: http.IncomingMessage | undefined = undefined

		const timeoutID = setInterval(() => {
			if (finished) {
				clearInterval(timeoutID)
				return
			}

			if (lastActivity + 20_000 < Date.now()) {
				// damn SLOW
				// better to reject

				clearInterval(timeoutID)
				finished = true
				value.reject('Too slow download stream')
				stream?.destroy()

				if (stream === undefined)
					this.free()
			}
		}, 1000)

		const callback = (response: http.IncomingMessage) => {
			stream = response
			lastActivity = Date.now()

			if (response.headers['set-cookie']) {
				for (const cookie of response.headers['set-cookie']) {
					this.cookies.put(cookie, value.url.host)
				}
			}

			if (response.statusCode == 301 || response.statusCode == 302) {
				if (response.headers.location && value.followRedirects) {
					// redirect, it might also switch protocols
					value.onStart = () => {}

					try {
						if (response.headers.location.startsWith('//')) {
							// same protocol, different hostname and path
							value.url = new urlModule.URL(value.url.protocol + response.headers.location)
						} else if (response.headers.location.startsWith('/')) {
							// same protocol and hostname, different path
							value.url = new urlModule.URL(value.url.protocol + '//' + value.url.hostname + response.headers.location)
						} else {
							value.url = new urlModule.URL(response.headers.location)
						}
					} catch(err) {
						value.reject(new HTTPError(response.statusCode, String(err), 'Location URL is invalid: ' + response.headers.location))
						this.free()
						return
					}

					value.https = value.url.protocol == 'https:'
					value.agent = value.url.protocol == 'https:' ? this.httpsagent : this.httpagent
					this.handleRequest(value)
					finished = true
					clearInterval(timeoutID)
					response.destroy()
				} else {
					value.reject(new HTTPError(response.statusCode, null, 'Server returned ' + response.statusCode))
					clearInterval(timeoutID)
					finished = true
					response.destroy()
				}

				this.free()
				return
			}

			if (value.onStart) {
				value.onStart(response)
			}

			let memcache: Buffer[] = []

			response.on('data', (chunk: Buffer) => {
				lastActivity = Date.now()
				memcache.push(chunk)
			})

			response.on('error', (err) => {
				if (finished) {
					return
				}

				console.error(`Throw INNER ${err} on ${value.traceback}`)
				this.free()
				value.reject(err)
				clearInterval(timeoutID)
			})

			response.on('end', async () => {
				clearInterval(timeoutID)
				this.free()

				let size = 0

				for (const buff of memcache) {
					size += buff.length
				}

				let newbuff = Buffer.allocUnsafe(size)
				let offset = 0

				for (const buff of memcache) {
					for (let i = 0; i < buff.length; i++) {
						newbuff[offset + i] = buff[i]
					}

					offset += buff.length
				}

				// mark buffers as dead for gc
				memcache = []

				switch (response.headers['content-encoding']) {
					case 'br':
						newbuff = await pbrotliDecompress(newbuff)
						break
					case 'gzip':
						newbuff = await punzip(newbuff)
						break
					case 'deflate':
						newbuff = await pinflate(newbuff)
						break
				}

				finished = true

				if (response.statusCode == 200 || response.statusCode == 206) {
					value.resolve(newbuff)
				} else {
					value.reject(new HTTPError(response.statusCode, newbuff, 'Server returned ' + response.statusCode))
				}
			})
		}

		const request = value.https ? https.request(params, callback) : http.request(params, callback)

		if (value.body != undefined) {
			request.write(value.body)
		}

		request.once('error', (err) => {
			if (finished) {
				return
			}

			finished = true
			clearInterval(timeoutID)

			this.free()

			// accept two failures
			if (value.requestFailures < 2) {
				value.requestFailures++
				this.handleRequest(value)
			} else {
				value.reject(err)
			}
		})

		request.end()
	}

	public get(url: string, config: RequestConfig = {}): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const urlobj = new urlModule.URL(url)

			if (urlobj.protocol != 'https:' && urlobj.protocol != 'http:') {
				throw new TypeError('Protocol is not supported: ' + urlobj.protocol)
			} else {
				this.handleRequest({
					url: urlobj,
					method: 'GET',
					https: urlobj.protocol == 'https:',
					headers: config.headers,
					onStart: config.onStart,
					reject: reject,
					resolve: resolve,
					body: config.body,
					followRedirects: config.followRedirects != undefined ? config.followRedirects : true,
					agent: urlobj.protocol == 'https:' ? this.httpsagent : this.httpagent,
					traceback: new Error().stack,
					requestFailures: 0
				})
			}
		})
	}

	public post(url: string, config: RequestConfig = {}): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const urlobj = new urlModule.URL(url)

			if (urlobj.protocol != 'https:' && urlobj.protocol != 'http:') {
				throw new TypeError('Protocol is not supported: ' + urlobj.protocol)
			} else {
				this.handleRequest({
					url: urlobj,
					method: 'POST',
					https: urlobj.protocol == 'https:',
					headers: config.headers,
					onStart: config.onStart,
					followRedirects: config.followRedirects != undefined ? config.followRedirects : true,
					reject: reject,
					resolve: resolve,
					body: config.body,
					agent: urlobj.protocol == 'https:' ? this.httpsagent : this.httpagent,
					traceback: new Error().stack,
					requestFailures: 0
				})
			}
		})
	}
}
