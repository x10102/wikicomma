
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

import { WikiDot, Lock } from './WikiDot'
import { promises } from 'fs'
import { RatelimitBucket } from './RatelimitBucket'
import { HTTPClient } from './HTTPClient'
import { blockingQueue, parallel, PromiseQueue } from './worker'
import { WikidotUserList } from './WikidotUserList'

interface DaemonConfig {
	base_directory: string
	wikis: {name: string, url: string}[]

	ratelimit?: { bucket_size: number, refill_seconds: number }
	delay_ms?: number
	maximum_jobs?: number
	http_proxy?: {address: string, port: number}
	socks_proxy?: {address: string, port: number}
}

(async function() {
	let config: DaemonConfig

	const argv = process.argv[3]

	try {
		const configPath = argv !== undefined ? argv : (process.env.WIKICOMMA_CONFIG !== undefined ? process.env.WIKICOMMA_CONFIG : 'config.json')
		const configData = await promises.readFile(configPath, {encoding: 'utf-8'})
		config = JSON.parse(configData)
	} catch(err) {
		process.stderr.write('config.json is missing or invalid from working directory.')
		process.stderr.write('Or set a different file using the WIKICOMMA_CONFIG environment variable.')
		process.exit(1)
	}

	function makeClient() {
		const client = new HTTPClient(
			3,
			config.http_proxy?.address,
			config.http_proxy?.port,
			config.socks_proxy?.address,
			config.socks_proxy?.port,
		)

		if (config.ratelimit != undefined) {
			client.ratelimit = new RatelimitBucket(config.ratelimit.bucket_size, config.ratelimit.refill_seconds)
			client.ratelimit.starTimer()
		}

		return client
	}

	const tasks: any[] = []
	const lock = new Lock()
	const userList = new WikidotUserList(config.base_directory + '/_users', makeClient())

	for (let {name, url} of config.wikis) {
		tasks.push(async function() {
			try {
				if (url.endsWith('/')) { // Some of wikidot parts don't like double slash
					url = url.substring(0, url.length - 1)
				}

				const client = makeClient()

				try {
					const wiki = new WikiDot(
						name,
						url,
						`${config.base_directory}/${name}`,
						client,
						new PromiseQueue(config.delay_ms, config.maximum_jobs),
						userList
					)

					await wiki.fetchToken()
					await wiki.workLoop(lock)
				} finally {
					client.ratelimit?.stopTimer()
				}
			} catch(err) {
				console.error(`Fetching wiki ${name} failed`)
				console.error(err)
			}
		})
	}

	try {
		await parallel(blockingQueue(tasks), 3)
	} finally {
		userList.client.ratelimit?.stopTimer()
	}
})()
