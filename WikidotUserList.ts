
// Copyright (c) 2022 DBotThePony

import { HTTPClient } from "./HTTPClient"

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
import parse from "node-html-parser"

export enum UserActivity {
	NONE,
	LOW,
	MEDIUM,
	HIGH,
	VERY_HIGH,
	GURU,
	UNKNOWN
}

export interface User {
	full_name: string
	username: string

	real_name: string
	gender?: boolean // true = male, false - female
	birthday?: number
	from?: string
	website?: string

	wikidot_user_since: number
	bio?: string

	// who even buy this
	account_type: string
	activity: UserActivity

	fetched_at: number
}

interface WaitingRoom {
	resolve: ((value: User | null) => void)[]
	reject: ((error: any) => void)[]
}

function indexOf(list: [number, string][], value: number): number {
	for (const i in list) {
		if (list[i][0] == value) {
			return Number(i)
		}
	}

	return -1
}

export class WikidotUserList {
	constructor(
		public workFolder: string,
		public client: HTTPClient
	) {
	}

	private fetchedOnce = false

	private usersToFetch: [number, string][] = []

	private static gender_1 = /^male/i

	private static real_name = /Real name/i
	private static gender = /Gender/i
	private static birthday = /Birthday/i
	private static from = /From/i
	private static website = /Website/i
	private static wikidot_user_since = /Wikidot User since:/i
	private static bio = /About/i
	private static account_type = /Account type/i
	private static activity = /Karma level/i

	private static matchers = {
		real_name: WikidotUserList.real_name,
		gender: WikidotUserList.gender,
		birthday: WikidotUserList.birthday,
		from: WikidotUserList.from,
		website: WikidotUserList.website,
		wikidot_user_since: WikidotUserList.wikidot_user_since,
		bio: WikidotUserList.bio,
		account_type: WikidotUserList.account_type,
		activity: WikidotUserList.activity,
	}

	private static activity_levels = {
		NONE: /none/i,
		LOW: /low/i,
		MEDIUM: /medium/i,
		HIGH: /high/i,
		VERY_HIGH: /very high/i,
		GURU: /guru/i,
	}

	private fetched = new Map<string, boolean>()
	private processing = new Map<string, WaitingRoom>()

	public async fetch(id: number, username: string): Promise<User> {
		const fetched = await this.fetchOptional(id, username)

		if (fetched !== null) {
			return fetched
		}

		return (await this.read(id))!
	}

	private async write(id: number, data: User) {
		let list = await this.readBucket(id)

		if (list === null) {
			list = {}
		}

		return await this.writePrefetch(id, data, list)
	}

	private async writePrefetch(id: number, data: User, list: {[key: string]: User}) {
		list[id] = data
		const bucket = id >> 10
		await promises.writeFile(`${this.workFolder}/${bucket}.json`, JSON.stringify(list, null, 4))
	}

	public async read(id: number): Promise<User | null> {
		const read = await this.readBucket(id)

		if (read === null) {
			return null
		}

		const user = read[id]

		if (user === undefined) {
			return null
		}

		return user
	}

	public async readBucket(id: number): Promise<{[key: string]: User} | null> {
		const bucket = id >> 10

		try {
			return JSON.parse(await promises.readFile(`${this.workFolder}/${bucket}.json`, {encoding: 'utf-8'}))
		} catch(err) {
			return null
		}
	}

	private wantToWritePrending = false
	private writingPending = false

	private async wantsToWritePending() {
		this.wantToWritePrending = true

		if (this.writingPending) {
			return
		}

		this.writingPending = true

		try {
			while (this.wantToWritePrending) {
				this.wantToWritePrending = false
				await promises.writeFile(`${this.workFolder}/pending.json`, JSON.stringify(this.usersToFetch, null, 4))
			}
		} finally {
			this.writingPending = false
		}
	}

	public async fetchOptional(id: number, username: string): Promise<User | null> {
		if (!this.fetchedOnce) {
			await promises.mkdir(this.workFolder, {recursive: true})
			this.fetchedOnce = true

			try {
				this.usersToFetch = JSON.parse(await promises.readFile(`${this.workFolder}/pending.json`, {encoding: 'utf-8'}))

				for (const [a, b] of this.usersToFetch) {
					if (a != id) {
						this.fetchOptional(a, b)
					}
				}
			} catch(err) {
				console.error(err)
			}
		}

		if (this.fetched.has(username)) {
			return null
		}

		let waiting_room = this.processing.get(username)

		if (waiting_room !== undefined) {
			return await new Promise((a, b) => {
				waiting_room!.resolve.push(a)
				waiting_room!.reject.push(b)
			})
		}

		waiting_room = {resolve: [], reject: []}

		this.processing.set(username, waiting_room)

		try {
			const fetchExisting = await this.read(id)

			if (fetchExisting !== null && fetchExisting.fetched_at + 6 * 60 * 60 * 1000 >= Date.now()) {
				this.fetched.set(username, true)

				for (const fn of waiting_room.resolve) {
					try {
						fn(fetchExisting)
					} catch(err) {
						// big gulp
					}
				}

				return fetchExisting
			}

			const path = `https://www.wikidot.com/user:info/${username}`

			waiting_room.resolve.push((_) => {
				const index = indexOf(this.usersToFetch, id)

				if (index >= 0) {
					this.usersToFetch.splice(index, 1)
					this.wantsToWritePending()
				}
			})

			if (indexOf(this.usersToFetch, id) == -1) {
				this.usersToFetch.push([id, username])
				this.wantsToWritePending()
			}

			const body = (await this.client.get(path, {headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
			}})).toString('utf-8')

			const html = parse(body)
			const div1 = html.querySelector('div.col-md-9')

			if (div1 == null) {
				throw new Error('div.col-md-9 is missing')
			}

			const title = div1.querySelector('h1.profile-title')
			const info = div1.querySelector('dl.dl-horizontal')

			if (title == null) {
				throw new Error('div.profile-title is missing')
			}

			if (info == null) {
				throw new Error('dl.dl-horizontal is missing')
			}

			const dt = info.querySelectorAll('dt')
			const dd = info.querySelectorAll('dd')

			if (dt.length != dd.length) {
				throw new Error(`dt and dd arrays length do not match: ${dt.length} != ${dd.length}`)
			}

			const matched_against: {[key: string]: string} = {}

			for (let i = 0; i < dt.length; i++) {
				const key = dt[i].textContent
				const value = dd[i].textContent

				for (const name in WikidotUserList.matchers) {
					const matcher = (WikidotUserList.matchers as {[key: string]: RegExp})[name]

					if (key.match(matcher) !== null) {
						matched_against[name] = value.trim()
					}
				}
			}

			let gender: boolean | undefined = undefined

			if (matched_against.gender !== undefined) {
				gender = matched_against.gender.match(WikidotUserList.gender_1) !== null
			}

			let birthday: number | undefined = undefined

			if (matched_against.birthday !== undefined) {
				birthday = new Date(matched_against.birthday).getTime()
			}

			if (matched_against.wikidot_user_since === undefined) {
				throw new Error('matched_against.wikidot_user_since is missing')
			}

			let activity = UserActivity.UNKNOWN

			if (matched_against.activity !== undefined) {
				for (const key in WikidotUserList.activity_levels) {
					if (matched_against.activity.match((WikidotUserList.activity_levels as {[key: string]: RegExp})[key]) !== null) {
						activity = UserActivity[key]
						break
					}
				}
			}

			const data: User = {
				full_name: title.textContent.trim(),
				username: username,
				real_name: matched_against.real_name,
				gender: gender,
				birthday: birthday,
				from: matched_against.from,
				website: matched_against.website,
				wikidot_user_since: new Date(matched_against.wikidot_user_since).getTime() / 1000,
				bio: matched_against.bio,
				account_type: matched_against.account_type,
				activity: activity,
				fetched_at: Date.now(),
			}

			await this.write(id, data)

			for (const fn of waiting_room.resolve) {
				try {
					fn(data)
				} catch(err) {
					// big gulp
				}
			}

			this.fetched.set(username, true)

			return data
		} catch(err) {
			for (const fn of waiting_room.reject) {
				fn(err)
			}

			throw err
		} finally {
			this.processing.delete(username)
		}
	}
}
