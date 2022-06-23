
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
import { HTTPClient } from './HTTPClient'
import { buildWorker, runWorkers, setWorkerConfig } from './worker'

interface DaemonConfig {
	base_directory: string
	wikis: {name: string, url: string}[]

	delay_ms?: number
	maximum_jobs?: number
	http_proxy?: {address: string, port: number}
	socks_proxy?: {address: string, port: number}
}

(async function() {
	let config: DaemonConfig

	try {
		config = JSON.parse(await promises.readFile('./config.json', {encoding: 'utf-8'}))
		setWorkerConfig(config.delay_ms, config.maximum_jobs)
	} catch(err) {
		process.stderr.write('config.json is missing or invalid from working directory.')
		process.exit(1)
	}

	const tasks: any[] = []
	const lock = new Lock()

	for (let {name, url} of config.wikis) {
		tasks.push(async function() {
			try {
				if (url.endsWith('/')) { // Some of wikidot parts don't like double slash
					url = url.substring(0, url.length - 1)
				}

				const wiki = new WikiDot(
					name,
					url,
					`${config.base_directory}/${name}`,
					new HTTPClient(
						8,
						config.http_proxy?.address,
						config.http_proxy?.port,
						config.socks_proxy?.address,
						config.socks_proxy?.port,
					),
				)
				await wiki.fetchToken()
				await wiki.workLoop(lock)
			} catch(err) {
				console.error(`Fetching wiki ${name} failed`)
				console.error(err)
			}
		})
	}

	const worker = buildWorker(tasks)
	await runWorkers(worker, 3)
})()
