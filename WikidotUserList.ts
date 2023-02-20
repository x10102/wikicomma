
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
import parse, { HTMLElement } from "node-html-parser"

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

	real_name?: string
	gender?: boolean
	birthday?: number
	from?: string
	website?: string

	wikidot_user_since: number
	bio?: string

	// who even buy this
	account_type?: string
	activity?: UserActivity

	fetched_at: number

	user_id: number
}

interface WaitingRoom {
	resolve: ((value: User | null) => void)[]
	reject: ((error: any) => void)[]
}

type UserFetchList = [number | null, string][]

function indexOf(list: UserFetchList, value: number): number {
	for (const i in list) {
		if (list[i][0] == value) {
			return Number(i)
		}
	}

	return -1
}

function indexOf2(list: UserFetchList, value: string): number {
	for (const i in list) {
		if (list[i][1] == value) {
			return Number(i)
		}
	}

	return -1
}

class UserNotFoundError extends Error {

}

export class WikiDotUserList {
	constructor(
		public workFolder: string,
		public client: HTTPClient,
		public cacheValidFor: number = 86400000
	) {
	}

	public static GENDER_MALE = true
	public static GENDER_FEMALE = true

	private static bucketSize = 13

	private fetchedOnce = false

	private usersToFetch: UserFetchList = []

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
		real_name: WikiDotUserList.real_name,
		gender: WikiDotUserList.gender,
		birthday: WikiDotUserList.birthday,
		from: WikiDotUserList.from,
		website: WikiDotUserList.website,
		wikidot_user_since: WikiDotUserList.wikidot_user_since,
		bio: WikiDotUserList.bio,
		account_type: WikiDotUserList.account_type,
		activity: WikiDotUserList.activity,
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

	public async fetch(id: number, username: string, refresh = true): Promise<User> {
		const fetched = await this.fetchOptional(id, username, refresh)

		if (fetched !== null) {
			return fetched
		}

		return (await this.read(id))!
	}

	public async fetchByUsername(username: string, refresh = true): Promise<User> {
		const fetched = await this.fetchOptional(null, username, refresh)

		if (fetched !== null) {
			return fetched
		}

		const [mapping] = await this.loadMapping()
		return mapping.get(username)!
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
		const bucket = id >> WikiDotUserList.bucketSize
		await promises.writeFile(`${this.workFolder}/${bucket}.json`, JSON.stringify(list, null, 4))

		if (this.storedInMemory) {
			this.mapping.set(data.username, data)
			this.invMapping.set(id, data)
		}
	}

	public async read(id: number): Promise<User | null> {
		if (this.loadingMapping) {
			await new Promise((resolve) => this.loadingWaiters.push(resolve))
		}

		if (this.storedInMemory) {
			const read = this.invMapping.get(id)
			return read ?? null
		}

		const read = await this.readBucket(id)

		if (read === null) {
			return null
		}

		const user = read[id]

		if (user === undefined || user.user_id === undefined) {
			return null
		}

		return user
	}

	public async readBucket(id: number): Promise<{[key: string]: User} | null> {
		const bucket = id >> WikiDotUserList.bucketSize

		try {
			return JSON.parse(await promises.readFile(`${this.workFolder}/${bucket}.json`, {encoding: 'utf-8'}))
		} catch(err) {
			return null
		}
	}

	private storedInMemory = false
	private loadingMapping = false
	private loadingWaiters: any[] = []
	private mapping = new Map<string, User>()
	private invMapping = new Map<number, User>()

	public async loadMapping(): Promise<[Map<string, User>, Map<number, User>]> {
		if (this.storedInMemory) {
			return [this.mapping, this.invMapping]
		}

		if (this.loadingMapping) {
			await new Promise((resolve) => this.loadingWaiters.push(resolve))
			return [this.mapping, this.invMapping]
		} else {
			this.loadingMapping = true
		}

		for (const name of (await promises.readdir(this.workFolder))) {
			if (name.match(/^[0-9]+\.json$/)) {
				try {
					const list: {[key: string]: User} = JSON.parse(await promises.readFile(`${this.workFolder}/${name}`, {encoding: 'utf-8'}))
					let changes = false

					for (const id in list) {
						this.mapping.set(list[id].username, list[id])
						this.invMapping.set(parseInt(id), list[id])

						if (list[id].user_id === undefined) {
							list[id].user_id = parseInt(id)
							changes = true
						}
					}

					if (changes) {
						process.stderr.write(`[WikiDot Userlist] Fixing up ${this.workFolder}/${name}\n`)
						await promises.writeFile(`${this.workFolder}/${name}`, JSON.stringify(list, null, 4))
					}
				} catch(err) {
					process.stderr.write(`Error reading ${this.workFolder}/${name}!\n`)
					throw err
				}
			}
		}

		this.loadingMapping = false
		this.storedInMemory = true

		for (const waiter of this.loadingWaiters) {
			waiter()
		}

		this.loadingWaiters = []

		return [this.mapping, this.invMapping]
	}

	public async getByUsername(username: string) {
		const [mapping] = await this.loadMapping()
		return mapping.get(username) ?? null
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

	public async initialize(skipid?: number | string) {
		if (!this.fetchedOnce) {
			await promises.mkdir(this.workFolder, {recursive: true})
			this.fetchedOnce = true

			try {
				this.usersToFetch = JSON.parse(await promises.readFile(`${this.workFolder}/pending.json`, {encoding: 'utf-8'}))

				for (const [a, b] of this.usersToFetch) {
					if (a !== skipid && b !== skipid) {
						this.fetchOptional(a, b).catch((err) => {
							if (!(err instanceof UserNotFoundError)) {
								process.stderr.write(`[WikiDot Userlist] Error while late fecthing user ${b} <${a}>: ${err}\nWill try to fetch later\n`)
							} else {
								process.stderr.write(`[WikiDot Userlist] User ${b} <${a}> does not exist.\n`)
							}
						})
					}
				}
			} catch(err) {
				console.error(err)
			}
		}
	}

	private static matchAgainstUserIDA = /^WIKIDOT\.modules\.UserInfoModule\.listeners\.addContact\(event,([0-9]+)\)$/i
	private static matchAgainstUserIDB = /^WIKIDOT\.modules\.UserInfoModule\.listeners\.flagUser\(event,([0-9]+)\)$/i

	private parseBody(html: HTMLElement, username: string) {
		const div1 = html.querySelector('div.col-md-9')

		if (div1 == null) {
			const error_block = html.querySelector('div.error-block')

			if (error_block?.textContent.toLowerCase() == 'user does not exist.') {
				throw new UserNotFoundError(`User ${username} does not exist`)
			}

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

			for (const name in WikiDotUserList.matchers) {
				const matcher = (WikiDotUserList.matchers as {[key: string]: RegExp})[name]

				if (key.match(matcher) !== null) {
					matched_against[name] = value.trim()
				}
			}
		}

		let gender: boolean | undefined = undefined

		if (matched_against.gender !== undefined) {
			gender = matched_against.gender.match(WikiDotUserList.gender_1) !== null ? WikiDotUserList.GENDER_MALE : WikiDotUserList.GENDER_FEMALE
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
			for (const key in WikiDotUserList.activity_levels) {
				if (matched_against.activity.match((WikiDotUserList.activity_levels as {[key: string]: RegExp})[key]) !== null) {
					// @ts-ignore implicit-any
					activity = UserActivity[key]
					break
				}
			}
		}

		let userID: number | undefined = undefined

		for (const elem of div1.querySelectorAll('a')) {
			if (elem.attrs.onclick) {
				const matchedAgainst = elem.attrs.onclick.match(WikiDotUserList.matchAgainstUserIDA) ?? elem.attrs.onclick.match(WikiDotUserList.matchAgainstUserIDB)

				if (matchedAgainst !== null) {
					userID = parseInt(matchedAgainst[1])
					break
				}
			}
		}

		if (userID === undefined) {
			throw new Error(`Can't determine user id for ${username}`)
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
			user_id: userID
		}

		return data
	}

	public pushPending(id: number | null, username: string) {
		if (id === null) {
			if (indexOf2(this.usersToFetch, username) == -1) {
				this.usersToFetch.push([null, username])
				this.wantsToWritePending()
				return true
			}
		} else {
			if (indexOf(this.usersToFetch, id) == -1) {
				this.usersToFetch.push([id, username])
				this.wantsToWritePending()
				return true
			}
		}

		return false
	}

	private failures = new Map<string, any>()

	public async fetchOptional(id: number | null, username: string, refresh = true): Promise<User | null> {
		await this.initialize(id ?? username)

		if (this.fetched.has(username)) {
			return null
		}

		if (this.loadingMapping) {
			await new Promise((resolve) => this.loadingWaiters.push(resolve))
		}

		if (this.storedInMemory) {
			const fetchExisting = await this.getByUsername(username)

			if (fetchExisting !== null && (!refresh || fetchExisting.fetched_at + this.cacheValidFor >= Date.now())) {
				return fetchExisting
			}
		}

		if (this.failures.has(username)) {
			throw this.failures.get(username)!
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
			if (id !== null) {
				const fetchExisting = await this.read(id)

				if (fetchExisting !== null && (!refresh || fetchExisting.fetched_at + this.cacheValidFor >= Date.now())) {
					this.fetched.set(username, true)

					for (const fn of waiting_room.resolve) {
						try {
							fn(fetchExisting)
						} catch(err) {
							// big gulp
						}
					}

					const index = indexOf(this.usersToFetch, id)

					if (index >= 0) {
						this.usersToFetch.splice(index, 1)
						this.wantsToWritePending()
					}

					return fetchExisting
				}
			}

			const path = `https://www.wikidot.com/user:info/${username}`

			waiting_room.resolve.push((_) => {
				const index = id !== null ? indexOf(this.usersToFetch, id) : indexOf2(this.usersToFetch, username)

				if (index >= 0) {
					this.usersToFetch.splice(index, 1)
					this.wantsToWritePending()
				}
			})

			if ((id !== null ? indexOf(this.usersToFetch, id) : indexOf2(this.usersToFetch, username)) == -1) {
				this.usersToFetch.push([id, username])
				this.wantsToWritePending()
			}

			process.stdout.write(`[WikiDot Userlist] Trying to fetch wikidot user ${username}<${id ?? '???'}>\n`)

			const body = (await this.client.get(path, {headers: {
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
			}})).toString('utf-8')

			const data = this.parseBody(parse(body), username)
			await this.write(id ?? data.user_id, data)

			process.stdout.write(`[WikiDot Userlist] Fetched wikidot user ${username}<${id ?? data.user_id}>\n`)

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

			this.failures.set(username, err)

			if (err instanceof UserNotFoundError) {
				const index = id !== null ? indexOf(this.usersToFetch, id) : indexOf2(this.usersToFetch, username)

				if (index >= 0) {
					this.usersToFetch.splice(index, 1)
					this.wantsToWritePending()
				}
			}

			throw err
		} finally {
			this.processing.delete(username)
		}
	}
}
