
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
import { findMostRevision, ForumPost, LocalForumPost, WikiDot } from "./WikiDot"
import { parallel, parallelQueue } from "./worker"
import {promises} from 'fs'

(async function() {
	const config = await loadConfig()
	const userList = config.makeUserList()
	// old username -> user id
	const remapped = new Map<string, number>()
	const failureSays: string[] = []

	await userList.loadMapping()

	for (const {name, url} of config.wikis) {
		const wiki = new WikiDot(
			name,
			url,
			`${config.base_directory}/${name}`,
			config.makeClient(8),
			config.makeQueue(),
			userList
		)

		const categories = await wiki.readForumCategories()

		for (const id in categories) {
			const cat = categories[id]
			process.stdout.write(`[${name}] Looking at ${cat.title}<${cat.id}>\n`)

			if (typeof cat.lastUser == 'string') {
				try {
					const getRemapped = remapped.get(cat.lastUser)

					if (getRemapped !== undefined) {
						cat.lastUser = getRemapped
					} else {
						const data = await userList.fetchByUsername(cat.lastUser)
						cat.lastUser = data.user_id
					}

					await wiki.writeForumCategory(cat)
				} catch(err) {
					if (!failureSays.includes(cat.lastUser as unknown as string)) {
						process.stderr.write(`[${name}] Failed to fetch user ${cat.lastUser}! for ${cat.title}\n`)
						failureSays.push(cat.lastUser as unknown as string)
					}
				}
			}

			const threadlist = await wiki.readForumThreadList(cat.id)
			let i = 0

			const threadtasks: (() => Promise<void>)[] = []

			for (const threadid of threadlist) {
				threadtasks.push(async () => {
					const thread = await wiki.readForumThread(cat.id, threadid)

					if (thread !== null) {
						const tasks: (() => Promise<void>)[] = []
						let changes = false
						let brokenNames = false

						if (typeof thread.lastUser == 'string') {
							try {
								const getRemapped = remapped.get(thread.lastUser as never)

								if (getRemapped !== undefined) {
									thread.lastUser = getRemapped
								} else {
									const data = await userList.fetchByUsername(thread.lastUser as never)
									thread.lastUser = data.user_id
								}

								await wiki.writeForumCategory(cat)
							} catch(err) {
								if (!failureSays.includes(thread.lastUser as never)) {
									process.stderr.write(`[${name}] Failed to fetch user ${thread.lastUser}! for ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
									failureSays.push(thread.lastUser as never)
								}

								brokenNames = true
							}

							changes = true
						}

						function processPosts(posts: LocalForumPost[]) {
							for (const post of posts) {
								if (typeof post.poster == 'string') {
									tasks.push(async () => {
										try {
											const getRemapped = remapped.get(post.poster as never)

											if (getRemapped !== undefined) {
												post.poster = getRemapped
											} else {
												const data = await userList.fetchByUsername(post.poster as never)
												post.poster = data.user_id
											}

											await wiki.writeForumCategory(cat)
										} catch(err) {
											if (!failureSays.includes(post.poster as never)) {
												process.stderr.write(`[${name}] Failed to fetch user ${post.poster}! for ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
												failureSays.push(post.poster as never)
											}

											brokenNames = true
										}

										changes = true
									})
								}

								if (typeof post.lastEditBy == 'string') {
									tasks.push(async () => {
										try {
											const getRemapped = remapped.get(post.lastEditBy as never)

											if (getRemapped !== undefined) {
												post.lastEditBy = getRemapped
											} else {
												const data = await userList.fetchByUsername(post.lastEditBy as never)
												post.lastEditBy = data.user_id
											}

											await wiki.writeForumCategory(cat)
										} catch(err) {
											if (!failureSays.includes(post.lastEditBy as never)) {
												process.stderr.write(`[${name}] Failed to fetch user ${post.lastEditBy}! for ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
												failureSays.push(post.lastEditBy as never)
											}

											brokenNames = true
										}

										changes = true
									})
								}

								processPosts(post.children)
							}
						}

						processPosts(thread.posts)

						// await Promise.allSettled(tasks)
						await parallelQueue(tasks, 8)

						if (brokenNames) {
							process.stdout.write(`[${name}] Fetching ALL posts for ${thread.title}<${thread.id}> in ${cat.title}<${cat.id}>\n`)

							const posts = await wiki.fetchAllThreadPosts(thread.id)
							const flattened: ForumPost[] = []

							function flatten(list: ForumPost[]) {
								for (const post of list) {
									flattened.push(post)
									flatten(post.children)
								}
							}

							flatten(posts)

							function matchPosts(list: LocalForumPost[]) {
								for (const post of list) {
									for (const fpost of flattened) {
										if (post.id == fpost.id) {
											if (typeof post.poster == 'string' && typeof fpost.poster == 'number') {
												remapped.set(post.poster, fpost.poster)
											}

											if (typeof post.lastEditBy == 'string' && typeof fpost.lastEditBy == 'number') {
												remapped.set(post.lastEditBy, fpost.lastEditBy)
											}

											post.poster = fpost.poster
											post.lastEdit = fpost.lastEdit
											post.lastEditBy = fpost.lastEditBy
											break
										}
									}
								}
							}

							matchPosts(thread.posts)

							if (typeof thread.lastUser == 'string') {
								let lastPost: ForumPost = flattened[0]

								for (const post of flattened) {
									if (post.stamp > lastPost.stamp) {
										lastPost = post
									}
								}

								if (lastPost) {
									thread.last = lastPost.stamp
									thread.lastUser = lastPost.poster
								}
							}
						}

						if (changes) {
							process.stderr.write(`[${name}] Updated ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
							await wiki.writeForumThread(cat.id, thread)
						}
					}

					if (++i % 100 == 0) {
						process.stdout.write(`[${name}] ${cat.title}<${cat.id}>: ${i}/${threadlist.length}\n`)
					}
				})
			}

			await parallelQueue(threadtasks, 4)

			process.stdout.write(`[${name}] ${cat.title}<${cat.id}>: ${threadlist.length}/${threadlist.length}\n`)
		}
	}

	userList?.client.ratelimit?.stopTimer()
})()
