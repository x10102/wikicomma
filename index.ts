
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
import { RatelimitBucket } from './RatelimitBucket'
import { HTTPClient } from './HTTPClient'
import { blockingQueue, parallel, PromiseQueue } from './worker'
import { WikiDotUserList } from './WikidotUserList'
import { loadConfig } from './DaemonConfig'

(async function() {
	const config = await loadConfig()

	const tasks: any[] = []
	const lock = new Lock()
	const userList = new WikiDotUserList(config.base_directory + '/_users', config.makeClient(3), config.user_list_cache_freshness !== undefined ? config.user_list_cache_freshness * 1000 : undefined)

	await userList.initialize()

	for (let {name, url} of config.wikis) {
		tasks.push(async function() {
			try {
				if (url.endsWith('/')) { // Some of wikidot parts don't like double slash
					url = url.substring(0, url.length - 1)
				}

				const client = config.makeClient(8)

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
