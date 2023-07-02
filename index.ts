
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
import { blockingQueue, parallel, PromiseQueue } from './worker'
import { loadConfig } from './DaemonConfig'

import http = require('http')
import https = require('https')

(async function() {
	const config = await loadConfig()

	const httpsagent: https.Agent = new https.Agent({
		keepAlive: true,
		keepAliveMsecs: 5000,
		maxSockets: 8
	})

	const httpagent: http.Agent = new http.Agent({
		keepAlive: true,
		keepAliveMsecs: 5000,
		maxSockets: 8
	})

	const tasks: any[] = []
	const lock = new Lock()
	const userList = config.makeUserList(8, httpsagent, httpagent)

	await userList.initialize()

	for (const {name, url} of config.wikis) {
		tasks.push(async function() {
			try {
				const client = config.makeClient(8, httpsagent, httpagent)

				try {
					const wiki = new WikiDot(
						name,
						url,
						`${config.base_directory}/${name}`,
						client,
						config.makeQueue(),
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

	console.log('Shutting down in 10 seconds.')

	setTimeout(() => {
		process.exit(0)
	}, 10_000)
})()
