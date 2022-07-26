
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
import { findMostRevision, WikiDot } from "./WikiDot"
import { parallel } from "./worker"

(async function() {
	const config = await loadConfig()
	const userList = config.makeUserList()
	// old username -> user id
	const remapped = new Map<string, number>()
	const failureSays: string[] = []

	for (const {name, url} of config.wikis) {
		const wiki = new WikiDot(
			name,
			url,
			`${config.base_directory}/${name}`,
			config.makeClient(8),
			config.makeQueue(),
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
					const metadata = await wiki.loadPageMetadata(pagename.value)

					if (metadata !== null) {
						let changes = false
						let brokenNames = false

						for (const rev of metadata.revisions) {
							if (typeof rev.author == 'string') {
								try {
									const getRemapped = remapped.get(rev.author)

									if (getRemapped !== undefined) {
										rev.author = getRemapped
									} else {
										const data = await userList.fetchByUsername(rev.author)
										rev.author = data.user_id
									}
								} catch(err) {
									if (!failureSays.includes(rev.author as unknown as string)) {
										process.stderr.write(`[${name}] Failed to fetch user ${rev.author}! for ${pagename.value}\n`)
										failureSays.push(rev.author as unknown as string)
									}

									brokenNames = true
								}

								changes = true
							}
						}

						if (brokenNames) {
							let lastRevision = findMostRevision(metadata.revisions)!
							const last = lastRevision

							for (const revision of metadata.revisions) {
								if (typeof revision.author == 'string') {
									lastRevision = Math.min(lastRevision, revision.revision - 1)
								}
							}

							if (lastRevision != last) {
								const newRevs = await wiki.fetchPageChangeListAllUntilForce(metadata.page_id, lastRevision, 4)

								if (newRevs !== null) {
									for (let i = 0; i < metadata.revisions.length; i++) {
										for (let i2 = 0; i2 < newRevs.length; i2++) {
											if (newRevs[i2].revision == metadata.revisions[i].revision) {
												if (typeof metadata.revisions[i].author == 'string' && newRevs[i2].author !== null) {
													const newUser = await userList.read(newRevs[i2].author!)

													if (newUser !== null) {
														process.stdout.write(`Remapping ${metadata.revisions[i].author} to ${newUser.user_id}`)
														remapped.set(metadata.revisions[i].author as unknown as string, newUser.user_id)
													}
												}

												metadata.revisions.splice(i, 1)
												i--

												break
											}
										}
									}

									metadata.revisions.unshift(...newRevs)
								} else {
									process.stderr.write(`[${name}] !!! Giving up at re-fetching revisions of ${pagename.value}...\n`)
								}
							}

							await wiki.writePageMetadata(pagename.value, metadata)
						}

						if (changes) {
							await wiki.writePageMetadata(pagename.value, metadata)
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
