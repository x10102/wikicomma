
// Copyright (c) 2022 DBotThePony

import { HTTPClient } from "./HTTPClient"
import { RatelimitBucket } from "./RatelimitBucket"
import { WikiDotUserList } from "./WikidotUserList"

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

import {promises} from 'fs'
import { PromiseQueue } from "./worker"

export interface IDaemonConfig {
	base_directory: string
	wikis: {name: string, url: string}[]

	user_list_cache_freshness?: number

	ratelimit?: { bucket_size: number, refill_seconds: number }
	delay_ms?: number
	maximum_jobs?: number
	http_proxy?: {address: string, port: number}
	socks_proxy?: {address: string, port: number}
}

export class DaemonConfig implements IDaemonConfig {
	public base_directory: string
	public wikis: {name: string, url: string}[]

	public user_list_cache_freshness?: number

	public ratelimit?: { bucket_size: number, refill_seconds: number }
	public delay_ms?: number
	public maximum_jobs?: number
	public http_proxy?: {address: string, port: number}
	public socks_proxy?: {address: string, port: number}

	constructor(loader: IDaemonConfig) {
		this.base_directory = loader.base_directory
		this.wikis = loader.wikis
		this.user_list_cache_freshness = loader.user_list_cache_freshness
		this.ratelimit = loader.ratelimit
		this.delay_ms = loader.delay_ms
		this.maximum_jobs = loader.maximum_jobs
		this.http_proxy = loader.http_proxy
		this.socks_proxy = loader.socks_proxy

		for (const i in this.wikis) {
			let url = this.wikis[i].url

			if (url.endsWith('/')) { // Some of wikidot parts don't like double slash
				this.wikis[i].url = url.substring(0, url.length - 1)
			}
		}
	}

	public makeClient(connectionLimit: number) {
		const client = new HTTPClient(
			connectionLimit,
			this.http_proxy?.address,
			this.http_proxy?.port,
			this.socks_proxy?.address,
			this.socks_proxy?.port,
		)

		if (this.ratelimit != undefined) {
			client.ratelimit = new RatelimitBucket(this.ratelimit.bucket_size, this.ratelimit.refill_seconds)
			client.ratelimit.starTimer()
		}

		return client
	}

	public makeUserList(connectionLimit = 8) {
		return new WikiDotUserList(this.base_directory + '/_users', this.makeClient(connectionLimit), this.user_list_cache_freshness !== undefined ? this.user_list_cache_freshness * 1000 : undefined)
	}

	public makeQueue() {
		return new PromiseQueue(this.delay_ms, this.maximum_jobs)
	}
}

export async function loadConfig(exit = true) {
	let config: DaemonConfig

	const argv = process.argv[3]

	try {
		const configPath = argv !== undefined ? argv : (process.env.WIKICOMMA_CONFIG !== undefined ? process.env.WIKICOMMA_CONFIG : 'config.json')
		const configData = await promises.readFile(configPath, {encoding: 'utf-8'})
		config = new DaemonConfig(JSON.parse(configData))
	} catch(err) {
		if (exit) {
			process.stderr.write('config.json is missing or invalid from working directory.\n')
			process.stderr.write('Or set a different file using the WIKICOMMA_CONFIG environment variable.\n')
			process.exit(1)
		} else {
			throw err
		}
	}

	return config
}
