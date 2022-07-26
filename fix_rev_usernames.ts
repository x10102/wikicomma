
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

import { loadConfig } from "./DaemonConfig"
import { WikiDot } from "./WikiDot"
import { parallel } from "./worker"

(async function() {
	const config = await loadConfig()
	const userList = config.makeUserList()

	for (const {name, url} of config.wikis) {
		const wiki = new WikiDot(
			name,
			url,
			`${config.base_directory}/${name}`,
			null,
			null,
			userList
		)

		const sitemap = await wiki.loadSiteMap()

		if (sitemap !== null) {
			process.stdout.write(`Scanning ${name}...\n`)

			let i = 0
			const iterator = sitemap.keys()

			async function worker() {
				let pagename = iterator.next()

				while (!pagename.done) {
					const meta = await wiki.loadPageMetadata(pagename.value)

					if (meta !== null) {
						let changes = false

						for (const rev of meta.revisions) {
							if (typeof rev.author == 'string') {
								try {
									const data = await userList.fetchByUsername(rev.author)
									rev.author = data.user_id
									changes = true
								} catch(err) {
									process.stderr.write(`[${name}] Failed to fetch user ${rev.author}! for ${pagename.value}\n`)
								}
							}
						}

						if (changes) {
							await wiki.writePageMetadata(pagename.value, meta)
							process.stdout.write(`[${name}] Updated ${pagename.value}\n`)
						}
					}

					if (++i % 100 == 0) {
						process.stdout.write(`[${name}] ${i}/${sitemap!.size}\n`)
					}

					pagename = iterator.next()
				}
			}

			await parallel(worker, 32)
			process.stdout.write(`[${name}] ${sitemap.size}/${sitemap.size}\n`)
		}
	}

	userList?.client.ratelimit?.stopTimer()
})()
