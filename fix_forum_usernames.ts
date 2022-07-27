
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
						let brokenRevNames = false

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

								for (const rev of post.revisions) {
									if (typeof rev.author == 'string') {
										tasks.push(async () => {
											try {
												const getRemapped = remapped.get(rev.author as never)

												if (getRemapped !== undefined) {
													rev.author = getRemapped
												} else {
													const data = await userList.fetchByUsername(rev.author as never)
													rev.author = data.user_id
												}

												await wiki.writeForumCategory(cat)
											} catch(err) {
												if (!failureSays.includes(rev.author as never)) {
													process.stderr.write(`[${name}] Failed to fetch user ${rev.author}! for ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
													failureSays.push(rev.author as never)
												}

												brokenRevNames = true
											}

											changes = true
										})
									}
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
									matchPosts(post.children)

									if (typeof post.poster != 'string' && typeof post.lastEditBy != 'string') {
										continue
									}

									let hit = false

									for (const fpost of flattened) {
										if (post.id == fpost.id) {
											if (typeof post.poster == 'string' && typeof fpost.poster == 'number') {
												remapped.set(post.poster, fpost.poster)
												process.stdout.write(`Remapping ${post.poster} to User ID ${fpost.poster}\n`)
											}

											if (typeof post.lastEditBy == 'string' && typeof fpost.lastEditBy == 'number') {
												remapped.set(post.lastEditBy, fpost.lastEditBy)
												process.stdout.write(`Remapping ${post.lastEditBy} to User ID ${fpost.lastEditBy}\n`)
											}

											post.poster = fpost.poster
											post.lastEdit = fpost.lastEdit
											post.lastEditBy = fpost.lastEditBy

											hit = true
											break
										}
									}

									if (!hit) {
										process.stderr.write(`[${name}] !!! Failed to match post ${post.id} in ${thread!.title}<${thread!.id}> against newly fetched ones\n`)
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

						if (brokenRevNames) {
							async function matchPosts(list: LocalForumPost[]) {
								for (const post of list) {
									await matchPosts(post.children)

									let once = false

									for (const rev of post.revisions) {
										if (typeof rev.author != 'string') {
											continue
										}

										const getRemapped = remapped.get(rev.author)

										if (getRemapped !== undefined) {
											rev.author = getRemapped
										} else {
											once = true
										}
									}

									if (!once) {
										continue
									}

									process.stdout.write(`[${name}] Fetching ALL revisions of post ${post.id} in ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
									const fetched = await wiki.fetchPostRevisionList(post.id)

									for (const rev of post.revisions) {
										if (typeof rev.author != 'string') {
											continue
										}

										const getRemapped = remapped.get(rev.author)

										if (getRemapped !== undefined) {
											rev.author = getRemapped
											continue
										}

										let hit = false

										for (const frev of fetched) {
											if (rev.id == frev.id) {
												if (frev.author != null) {
													remapped.set(rev.author, frev.author)
													process.stdout.write(`Remapping ${rev.author} to User ID ${frev.author}\n`)
												}

												rev.author = frev.author
												break
											}
										}

										if (!hit) {
											process.stderr.write(`[${name}] !!! Failed to match revision ${rev.id} against fetched newly fetched revisions in post ${post.id} in ${thread!.title}<${thread!.id}> against newly fetched ones\n`)
										}
									}
								}
							}

							await matchPosts(thread.posts)
						}

						if (typeof thread.startedUser == 'string') {
							try {
								const getRemapped = remapped.get(thread.startedUser as never)

								if (getRemapped !== undefined) {
									thread.startedUser = getRemapped
								} else {
									const data = await userList.fetchByUsername(thread.startedUser as never)
									thread.startedUser = data.user_id
								}

								await wiki.writeForumCategory(cat)
							} catch(err) {
								if (!failureSays.includes(thread.startedUser as never)) {
									process.stderr.write(`[${name}] Failed to fetch user ${thread.startedUser}! for ${thread!.title}<${thread!.id}> in ${cat.title}<${cat.id}>\n`)
									failureSays.push(thread.startedUser as never)
								}

								let bottomMost = thread.posts[0]

								for (const post of thread.posts) {
									if (post.id < bottomMost.id) {
										bottomMost = post
									}
								}

								if (bottomMost) {
									thread.startedUser = bottomMost.poster
								}
							}

							changes = true
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

	process.stdout.write(`Exiting process in 10 seconds.\n`)

	setTimeout(() => {
		process.exit(0)
	}, 10000)
})()
