
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

import { encode } from "querystring"
import { HTTPClient, HTTPError, RequestConfig } from './HTTPClient'
import { parse, HTMLElement, TextNode } from 'node-html-parser'
import { promises, read } from 'fs'
import { promisify } from 'util'
import { addZipFiles, listZipFiles } from "./7z-helper"
import { OutgoingHttpHeaders } from "http2"
import { blockingQueue, parallel, PromiseQueue } from "./worker"
import { WikiDotUserList } from "./WikidotUserList"
import { MessageType, Status, ZmqSender, ErrorKind, MessageData } from "./ZmqSender"

const sleep = promisify(setTimeout)

type UserID = number | null

export interface RecentChange {
	name: string
	revision?: number
	author: UserID
}

export interface PageRevision {
	revision: number
	global_revision: number
	author: UserID
	stamp?: number
	flags?: string
	commentary?: string
}

export function findMostRevision(list: PageRevision[]) {
	if (list.length == 0) {
		return null
	}

	let max = list[0].revision

	for (const rev of list) {
		if (rev.revision > max) {
			max = rev.revision
		}
	}

	return max
}

export interface PageMeta {
	name: string
	page_id: number
	rating?: number
	version?: number
	forum_thread?: number
	revisions: PageRevision[]
	tags?: string[]
	title?: string
	votings?: [UserID, boolean][]
	sitemap_update?: number
	files: FileMeta[]
	parent?: string
	is_locked?: boolean
}

export interface GenericPageData {
	page_id?: number
	page_name?: string
	rating?: number
	forum_thread?: number
	tags?: string[]
	parent?: string
}

export interface FileMeta {
	file_id: number
	name: string
	url: string
	size: string
	size_bytes: number
	mime: string
	content: string
	author: UserID
	stamp: number

	internal_version?: number
}

/**
 * All symbols are safe for storing on disk except these
 * (Windows NT kernel limitations)
 */
const reencoding_table = [
	[/\\/g, encodeURIComponent('\\')],
	[/:/g, encodeURIComponent(':')],
	[/\*/g, '%2A'],
	[/\?/g, encodeURIComponent('?')],
	[/"/g, encodeURIComponent('"')],
	[/</g, encodeURIComponent('<')],
	[/>/g, encodeURIComponent('>')],
	[/\|/g, encodeURIComponent('|')],
	[/\//g, '%2F'],
]

export function reencodeComponent(str: string) {
	str = decodeURIComponent(str)

	for (const [a, b] of reencoding_table) {
		str = str.replace(a, b as string)
	}

	return str
}

export function pushToSet<T>(set: T[], value: T) {
	if (!set.includes(value)) {
		set.push(value)
		return true
	}

	return false
}

export function removeFromSet<T>(set: T[], value: T) {
	const indexOf = set.indexOf(value)

	if (indexOf != -1) {
		set.splice(indexOf, 1)
	}

	return indexOf != -1
}

export interface ForumCategory {
	title: string
	description: string
	id: number
	last?: number
	posts: number
	threads: number
	lastUser: UserID
}

export interface LocalForumCategory extends ForumCategory {
	full_scan: boolean
	last_page: number
	version?: number
}

export interface ForumRevisionBody {
	title: string
	content: string
}

export interface HeadlessForumPost {
	id: number
	poster: UserID
	stamp: number
	lastEdit?: number
	lastEditBy?: UserID
	title: string
}

export interface ForumPost extends ForumRevisionBody, HeadlessForumPost {
	children: ForumPost[]
}

export interface LocalForumPost extends HeadlessForumPost {
	revisions: LocalPostRevision[]
	children: LocalForumPost[]
}

export interface PostRevision {
	author: UserID
	stamp: number
	id: number
}

export interface LocalPostRevision extends PostRevision {
	title: string
}

export function findPostRevision(list: LocalPostRevision[], id: number): LocalPostRevision | null {
	for (const rev of list) {
		if (rev.id == id) {
			return rev
		}
	}

	return null
}

export function findPost(list: LocalForumPost[], id: number): LocalForumPost | null {
	for (const rev of list) {
		if (rev.id == id) {
			return rev
		}

		const findRecursive = findPost(rev.children, id)

		if (findRecursive != null) {
			return findRecursive
		}
	}

	return null
}

export interface ForumThread {
	title: string
	id: number
	description: string
	last?: number
	lastUser?: UserID
	started: number
	startedUser: UserID
	postsNum: number
	sticky: boolean
}

export interface LocalForumThread extends ForumThread {
	posts: LocalForumPost[]
	isLocked: boolean
	version?: number
}

class DiskMeta<T> {
	constructor(
		public data: T,
		private path: string,
		private dataFixer?: (v: any) => T
	) {

	}

	private initialized = false
	private initializing = false
	private initializeCallbacks: any[] = []
	private initializeRejects: any[] = []
	private metaIsDirty = false
	private metaIsSyncing = false
	private metaSyncCallbacks: any[] = []
	private metaSyncRejects: any[] = []
	private writeOnce = false

	public markDirty() {
		this.metaIsDirty = true
	}

	private metaSyncTimer: NodeJS.Timeout | null = null

	public startTimer(timeout = 2000) {
		if (this.metaSyncTimer != null) {
			return
		}

		this.metaSyncTimer = setInterval(() => this.sync(), timeout)
	}

	public stopTimer() {
		if (this.metaSyncTimer == null) {
			return
		}

		clearInterval(this.metaSyncTimer)
		this.metaSyncTimer = null
	}

	public sync(): Promise<void> {
		return new Promise(async (resolve, reject) => {
			if (!this.metaIsDirty || !this.initialized) {
				resolve()
				return
			}

			if (this.metaIsSyncing) {
				this.metaSyncCallbacks.push(resolve)
				this.metaSyncRejects.push(reject)
				return
			}

			try {
				if (!this.writeOnce) {
					const split = this.path.split('/')
					split.pop()
					await promises.mkdir(split.join('/'), {recursive: true})
					this.writeOnce = true
				}

				const json = JSON.stringify(this.data, null, 4)

				await promises.writeFile(this.path, json)
				this.metaIsDirty = false

				resolve()

				for (const callback of this.metaSyncCallbacks) {
					callback()
				}
			} catch(err) {
				reject(err)

				for (const callback of this.metaSyncRejects) {
					callback(err)
				}
			}

			this.metaSyncCallbacks = []
			this.metaSyncRejects = []
			this.metaIsSyncing = false
		})
	}

	public initialize(): Promise<void> {
		return new Promise(async (resolve, reject) => {
			if (this.initialized) {
				resolve()
				return
			}

			if (this.initializing) {
				this.initializeCallbacks.push(resolve)
				this.initializeRejects.push(reject)
				return
			}

			try {
				const read = await promises.readFile(this.path, {encoding: 'utf-8'})
				const json = JSON.parse(read)

				if (this.dataFixer == undefined) {
					this.data = json
				} else {
					this.data = this.dataFixer(json)
				}
			} catch(err) {
				this.initialized = true
				this.initializing = false

				reject(err)

				for (const callback of this.initializeRejects) {
					callback(err)
				}

				this.initializeCallbacks = []
				return
			}

			this.initialized = true
			this.initializing = false

			resolve()

			for (const callback of this.initializeCallbacks) {
				callback()
			}

			this.initializeCallbacks = []
			this.initializeRejects = []
		})
	}
}

interface FileMap {
	[key: string]: {url: string, path: string}
}

interface PendingRevisions {
	// revision -> page
	[key: string]: number
}

interface PageIdMap {
	// id -> name
	[key: string]: string
}

export class Lock {
	private locks: any[] = []
	private _isLocked = false

	public get isLocked() {
		return this._isLocked
	}

	public async lock() {
		return new Promise<void>((resolve, reject) => {
			if (this._isLocked) {
				this.locks.push(resolve)
				return
			}

			this._isLocked = true
			resolve()
		})
	}

	public async release() {
		if (!this._isLocked) {
			throw new Error('Not locked!')
		}

		this._isLocked = false

		if (this.locks.length != 0) {
			this._isLocked = true
			this.locks.splice(0, 1)[0]()
		}
	}
}

export class WikiDot {
	private static readonly usernameMatcher = /user:info\/(.*)/
	private static readonly useridMatcher = /WIKIDOT.page.listeners.userInfo\((\d+)\);/

	// spoon library
	private static readonly urlMatcher = /(((http|ftp|https):\/{2})+(([0-9a-z_-]+\.)+(aero|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|tel|travel|ac|ad|ae|af|ag|ai|al|am|an|ao|aq|ar|as|at|au|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cx|cy|cz|cz|de|dj|dk|dm|do|dz|ec|ee|eg|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mn|mn|mo|mp|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|nom|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ra|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sj|sk|sl|sm|sn|so|sr|st|su|sv|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tp|tr|tt|tv|tw|tz|ua|ug|uk|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|yu|za|zm|zw|arpa)(:[0-9]+)?((\/([~0-9a-zA-Z\#\+\%@\.\/_-]+))?(\?[0-9a-zA-Z\+\%@\/&\[\];=_-]+)?)?))\b/ig
	public static readonly defaultPagenation = 100

	private readonly pendingFiles: DiskMeta<number[]> = new DiskMeta([], `${this._workingDirectory}/meta/pending_files.json`)
	private readonly pendingPages: DiskMeta<string[]> = new DiskMeta([], `${this._workingDirectory}/meta/pending_pages.json`)
	private readonly fileMap: DiskMeta<FileMap> = new DiskMeta({}, `${this._workingDirectory}/meta/file_map.json`)
	private readonly pageIdMap: DiskMeta<PageIdMap> = new DiskMeta({}, `${this._workingDirectory}/meta/page_id_map.json`)
	private readonly pendingRevisions: DiskMeta<PendingRevisions> = new DiskMeta({}, `${this._workingDirectory}/meta/pending_revisions.json`)

	private ajaxURL: URL

	private fetchingToken = false

	private tokenInvalidated = false
	private tokenWaiters: any[] = []

	private readonly downloadingFiles: number[] = []

	private static readonly fileSizeMatcher = /([0-9]+) bytes/i
	private static readonly FILE_METADATA_VERSION = 1

	private static readonly dateMatcher = /time_([0-9]+)/

	private static readonly localFileMatch = /\/local--files\/(.+)/i

	private static readonly categoryRegExp = /forum\/c-([0-9]+)/
	private static readonly threadRegExp = /forum\/t-([0-9]+)/
	private static readonly postRegExp = /post-([0-9]+)/
	private static readonly fileIdMatcher = /file-row-([0-9]+)/i
	private static readonly PAGE_METADATA_VERSION = 18

	private static readonly FORUM_THREAD_METADATA_VERSION = 1
	// usually needs to be incremented each time FORUM_THREAD_METADATA_VERSION is updated
	private static readonly FORUM_CATEGORY_METADATA_VERSION = 1

	public static normalizeName(name: string): string {
		return name.replace(/:/g, '_')
	}

	private static extractUser(elem: HTMLElement | null): [UserID, string | null] {
		if (elem == null) {
			return [null, null]
		}

		const regMatch = elem.querySelector('a')?.attributes['onclick']?.match(WikiDot.useridMatcher)
		const regMatchUsername = elem.querySelector('a')?.attributes['href']?.match(WikiDot.usernameMatcher)
		let user: number | undefined = regMatch ? parseInt(regMatch[1]) : undefined
		const username = regMatchUsername ? regMatchUsername[1] : null

		if (user === undefined) {
			const user2 = elem.querySelector('span.deleted')?.attributes['data-id']

			if (user2 != undefined) {
				user = parseInt(user2)
			}
		}

		// in case we got passed the root element of user span
		if (user === undefined) {
			const user2 = elem.attributes['data-id']

			if (user2 != undefined) {
				user = parseInt(user2)
			}
		}

		if (user === undefined) {
			return [null, null]
		}

		return [user, username]
	}

	private matchAndFetchUser(elem: HTMLElement | null): UserID {
		const [a, b] = WikiDot.extractUser(elem)

		if (a !== null && b !== null) {
			this.userList?.fetchOptional(a, b).catch((err) => {
				this.error(`Caught an error while trying to fetch user ${b}<${a}>`)
				this.error(err)
			})
		}

		return a
	}

	private pushPendingFiles(...files: number[]) {
		for (const value of files) {
			if (pushToSet(this.pendingFiles.data, value)) {
				this.pendingFiles.markDirty()
			}
		}
	}

	private pushPendingPages(...pages: string[]) {
		for (const value of pages) {
			if (pushToSet(this.pendingPages.data, value)) {
				this.pendingPages.markDirty()
			}
		}
	}

	private removePendingFiles(...files: number[]) {
		for (const value of files) {
			if (removeFromSet(this.pendingFiles.data, value)) {
				this.pendingFiles.markDirty()
			}
		}
	}

	private removePendingPages(...pages: string[]) {
		for (const value of pages) {
			if (removeFromSet(this.pendingPages.data, value)) {
				this.pendingPages.markDirty()
			}
		}
	}

	public startMetaSyncTimer(timeout = 2000) {
		this.pendingFiles.startTimer(timeout)
		this.pendingPages.startTimer(timeout)
		this.fileMap.startTimer(timeout)
		this.pendingRevisions.startTimer(timeout)
		this.pageIdMap.startTimer(timeout)
	}

	public stopMetaSyncTimer() {
		this.pendingFiles.stopTimer()
		this.pendingPages.stopTimer()
		this.fileMap.stopTimer()
		this.pendingRevisions.stopTimer()
		this.pageIdMap.stopTimer()
	}

	public syncMeta() {
		return Promise.all([
			this.pendingFiles.sync(),
			this.pendingPages.sync(),
			this.fileMap.sync(),
			this.pendingRevisions.sync(),
			this.pageIdMap.sync(),
		])
	}

	private async loadCookies() {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		try {
			const read = await promises.readFile(`${this._workingDirectory}/http_cookies.json`, {encoding: 'utf-8'})
			const json = JSON.parse(read)
			this.client.cookies.load(json)
		} catch(err) {

		}
	}

	private async saveCookies() {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		await promises.mkdir(this._workingDirectory, {recursive: true})
		const json = this.client.cookies.save()
		await promises.writeFile(`${this._workingDirectory}/http_cookies.json`, JSON.stringify(json, null, 4))
	}

	private initialize() {
		const tasks = [
			this.pendingFiles.initialize(),
			this.pendingPages.initialize(),
			this.fileMap.initialize(),
			this.pendingRevisions.initialize(),
			this.pageIdMap.initialize(),
		]

		if (this.client !== null) {
			tasks.push(this.loadCookies())
		}

		return Promise.allSettled(tasks)
	}

	public get workingDirectory(): string {
		return this._workingDirectory
	}

	constructor(
		private name: string,
		private url: string = `https://${name}.wikidot.com`,
		private _workingDirectory: string = `./storage/${name}`,
		public client: HTTPClient | null,
		public queue: PromiseQueue | null,
		public userList: WikiDotUserList | null,
		handleCookies = true,
		private blacklist: string[] = [],
		private zmqSender: ZmqSender | null = null
	) {
		this.ajaxURL = new URL(`${this.url}/ajax-module-connector.php`)
		this.startMetaSyncTimer()

		if (client !== null && queue === null) {
			throw new Error(`HTTPClient is specified, but not queue`)
		} else if (client === null && queue !== null) {
			throw new Error(`HTTPClient is not specified, but queue is`)
		}

		if (handleCookies && this.client !== null) {
			let savingCookies = false
			let timeoutPlaced = false

			this.client.cookies.onCookieAdded = async () => {
				if (savingCookies) {
					if (timeoutPlaced) {
						return
					}

					timeoutPlaced = true

					setTimeout(() => {
						timeoutPlaced = false
						savingCookies = true
						this.saveCookies()
						savingCookies = false
					}, 1000)

					return
				}

				savingCookies = true
				this.saveCookies()
				savingCookies = false
			}
		}
	}

	private log(str: string) {
		process.stdout.write(`[${this.name}]: ${str}\n`)
	}

	private error(str: string) {
		process.stderr.write(`[${this.name}]: ${str}\n`)
	}

	public async fetchToken(force = false) {
		if (this.fetchingToken) {
			return
		}

		if (this.client === null) {
			return
		}

		await this.initialize()

		this.fetchingToken = true

		if (!force && this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value != undefined) {
			return
		}

		await this.client.get(`${this.url}/system:recent-changes`, {followRedirects: false})
		await this.saveCookies()
	}

	private async fetch(options: any, headers?: OutgoingHttpHeaders) {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		await this.initialize()

		let cookie = this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value

		if (cookie == undefined) {
			this.fetchingToken = false
			await this.fetchToken()
			cookie = this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value
		}

		options["wikidot_token7"] = cookie

		const assemble = {
			body: encode(options),

			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"Referer": this.url
			},

			followRedirects: false
		}

		if (headers != undefined) {
			for (const key in headers) {
				(assemble.headers as OutgoingHttpHeaders)[key] = headers[key]
			}
		}

		return await this.client.post(this.ajaxURL.href, assemble)
	}

	private async fetchJson(options: any, custom = false, headers?: OutgoingHttpHeaders): Promise<any> {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		if (this.tokenInvalidated) {
			await new Promise((resolve) => this.tokenWaiters.push(resolve))
		}

		const json = JSON.parse((await this.fetch(options, headers)).toString('utf-8'))

		if (json.status != 'ok') {
			if (json.status === 'wrong_token7') {
				const locked = this.tokenInvalidated

				if (!locked) {
					this.tokenInvalidated = true
					this.error(`!!! Wikidot invalidated our token, waiting 30 seconds....`)
					this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorTokenInvalidated})
					await sleep(30_000)

					this.client.cookies.removeSpecific(this.ajaxURL, 'wikidot_token7')
					this.fetchingToken = false
					await this.fetchToken(true)
					this.tokenInvalidated = false

					for (const waiter of this.tokenWaiters) {
						waiter()
					}

					this.tokenWaiters = []
				} else {
					await new Promise((resolve) => this.tokenWaiters.push(resolve))
				}

				return await this.fetchJson(options, custom, headers)
			} else if (!custom) {
				throw Error(`Server returned ${json.status}, message: ${json.message}`)
			}
		}

		return json
	}

	private async fetchJsonForce(options: any, custom = false, headers?: OutgoingHttpHeaders) {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		return JSON.parse((await this.fetch(options, headers)).toString('utf-8'))
	}

	// low-level api
	public async fetchChanges(page = 1, perPage = WikiDot.defaultPagenation) {
		const listing: RecentChange[] = []

		const json = await this.fetchJson({
			"options": `{"all": true}`,
			"page": page,
			"perpage": perPage,
			"moduleName": "changes/SiteChangesListModule",
		}, false, {
			"Referer": `${this.url}/system:recent-changes`
		})

		const html = parse(json.body)

		for (const elem of html.querySelectorAll('.changes-list-item')) {
			const url = elem.querySelector('td.title')?.querySelector('a')?.attrs['href']
			const revisionText = elem.querySelector('td.revision-no')?.textContent
			const revision = revisionText?.match(/([0-9]+)/)
			const mod_by = this.matchAndFetchUser(elem.querySelector('td.mod-by'))

			if (url != undefined) {
				const obj: RecentChange = {
					name: url.startsWith('/') ? url.substring(1) : url,
					author: mod_by
				}

				if (revision != null) {
					obj.revision = parseInt(revision[1])
				} else if (revisionText != undefined) {
					// new page
					obj.revision = 0
				}

				listing.push(obj)
			}
		}

		return listing
	}

	public async fetchChangesForce(page = 1, perPage = WikiDot.defaultPagenation) {
		while (true) {
			try {
				return await this.fetchChanges(page, perPage)
			} catch(err) {
				this.error(`Encountered ${err} when fetching changes offset ${page}, sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
	}

	public async fetchChangesDynamic(page = 1, perPage = WikiDot.defaultPagenation, onFailureChange = -100, limit = 200): Promise<[RecentChange[], number]> {
		let failures = 0

		while (true) {
			try {
				return [await this.fetchChanges(page, perPage), perPage]
			} catch(err) {
				failures++

				if (perPage > limit && failures > 3) {
					failures = 0
					const old = perPage
					perPage += onFailureChange
					this.error(`Encountered ${err} when fetching changes offset ${page}, reducing per-page entries from ${old} to ${perPage}, sleeping for 5 seconds`)
				} else {
					this.error(`Encountered ${err} when fetching changes offset ${page}, sleeping for 5 seconds`)
				}

				await sleep(5_000)
			}
		}
	}

	public async fetchPageChangeListForce(page_id: number, page = 1, perPage = WikiDot.defaultPagenation, attempts = -1) {
		let iteration = 0

		while (attempts < 0 || ++iteration <= attempts) {
			try {
				return await this.fetchPageChangeList(page_id, page, perPage)
			} catch(err) {
				if (attempts >= 0) {
					this.error(`Encountered ${err} when fetching changes of ${page_id} offset ${page}, sleeping for 5 seconds (attempt ${iteration}/${attempts})`)
				} else {
					this.error(`Encountered ${err} when fetching changes of ${page_id} offset ${page}, sleeping for 5 seconds`)
				}

				await sleep(5_000)
			}
		}

		return null
	}

	public async fetchPageChangeList(page_id: number, page = 1, perPage = WikiDot.defaultPagenation) {
		const listing: PageRevision[] = []

		const json = await this.fetchJson({
			"options": `{"all": true}`,
			"page": page,
			"perpage": perPage,
			"page_id": page_id,
			"moduleName": "history/PageRevisionListModule",
		})

		const html = parse(json.body)

		let skip = true

		for (const row of html.querySelectorAll('tr')) {
			if (skip) {
				// header
				skip = false
				continue
			}

			const values = row.querySelectorAll('td')

			const revision = values[0].textContent.match(/([0-9]+)/)

			if (revision == null) {
				continue
			}

			// 1 - buttons
			const flags = values[2].textContent.trim()
			const global_revision = values[3].querySelector('a')?.attrs['onclick']?.match(/([0-9]+)/)

			if (global_revision == null) {
				continue
			}

			const author = this.matchAndFetchUser(values[4] as HTMLElement)
			const time = values[5].querySelector('span')?.attrs['class']?.match(WikiDot.dateMatcher)
			const commentary = values[6].textContent.trim()

			const parseRev = parseInt(revision[1])
			const parseGlobalRev = parseInt(global_revision[1])

			if (isNaN(parseRev) || isNaN(parseGlobalRev)) {
				continue
			}

			const parseTime = time != null ? parseInt(time[1]) : null

			const obj: PageRevision = {
				revision: parseRev,
				global_revision: parseGlobalRev,
				author: author,
				stamp: parseTime != null && !isNaN(parseTime) ? parseTime : undefined,
				flags: flags.replace(/\s+/g, ' '),
				commentary: commentary
			}

			listing.push(obj)
		}

		return listing
	}

	public async fetchPageChangeListAll(page_id: number) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)
			const data = await this.fetchPageChangeList(page_id, ++page)
			listing.push(...data)

			//if (data.length < WikiDot.defaultPagenation) {
			if (data.length == 0) {
				break
			}
		}

		return listing
	}

	public async fetchPageChangeListAllForce(page_id: number, attempts = -1) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)

			const data = await this.fetchPageChangeListForce(page_id, ++page, WikiDot.defaultPagenation, attempts)

			if (data === null) {
				return null
			}

			listing.push(...data)

			//if (data.length < WikiDot.defaultPagenation) {
			if (data.length == 0) {
				break
			}
		}

		return listing
	}

	public async fetchPageChangeListAllUntil(page_id: number, revision: number) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)
			const data = await this.fetchPageChangeList(page_id, ++page)
			let finish = false

			for (const piece of data) {
				if (piece.revision <= revision) {
					finish = true
					break
				}

				listing.push(piece)
			}

			//if (data.length < WikiDot.defaultPagenation || finish) {
			if (data.length == 0 || finish) {
				break
			}
		}

		return listing
	}

	public async fetchPageChangeListAllUntilForce(page_id: number, revision: number, attempts = -1) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)
			const data = await this.fetchPageChangeListForce(page_id, ++page, WikiDot.defaultPagenation, attempts)

			if (data === null) {
				return null
			}

			let finish = false

			for (const piece of data) {
				if (piece.revision <= revision) {
					finish = true
					break
				}

				listing.push(piece)
			}

			//if (data.length < WikiDot.defaultPagenation || finish) {
			if (data.length == 0 || finish) {
				break
			}
		}

		return listing
	}

	private static tagMatchRegExpA = /\/tag\/(\S+)#pages$/i
	private static tagMatchRegExpB = /\/tag\/(\S+)$/i

	public async fetchGeneric(page: string) {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		await this.initialize()

		const result = await this.client.get(`${this.url}/${page}/noredirect/true?_ts=${Date.now()}`, {
			followRedirects: false,
			headers: {
				'Referer': this.url,
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
			}
		})

		const html = parse(result.toString('utf-8'))
		const meta: GenericPageData = {}

		for (const elem of html.querySelectorAll('head script')) {
			const matchAgainstPage = elem.textContent.match(/WIKIREQUEST\.info\.pageId\s*=\s*([0-9]+);/i)

			if (matchAgainstPage != null) {
				meta.page_id = parseInt(matchAgainstPage[1])
			}
		}

		const ratingElem = html.querySelector('span.rate-points')?.querySelector('span.number')?.textContent

		if (ratingElem != undefined) {
			meta.rating = parseInt(ratingElem)
		}

		const discussElem = html.querySelector('#discuss-button')?.attributes['href']

		if (discussElem != undefined) {
			const match = discussElem.match(WikiDot.threadRegExp)

			if (match != null) {
				meta.forum_thread = parseInt(match[1])
			}
		}

		const pageTagsElem = html.querySelector('div.page-tags')?.querySelector('span')?.querySelectorAll('a')

		if (pageTagsElem != undefined) {
			for (const elem of pageTagsElem) {
				const matchedA = elem.attributes['href']?.match(WikiDot.tagMatchRegExpA)
				const matchedB = elem.attributes['href']?.match(WikiDot.tagMatchRegExpB)
				const matched = matchedA != null ? matchedA : matchedB

				if (matched != null) {
					meta.tags = meta.tags != undefined ? meta.tags : []
					meta.tags.push(decodeURIComponent(matched[1]))
				}
			}
		}

		const pageName = html.querySelector('div#page-title')?.textContent

		if (pageName != undefined) {
			meta.page_name = pageName.trim()
		}

		meta.parent = html.querySelector('div#main-content div#breadcrumbs')?.querySelectorAll('a').pop()?.attributes.href?.substring(1)
		return meta
	}

	public async fetchPageVoters(page_id: number) {
		const json = await this.fetchJson({
			"pageId": page_id,
			"moduleName": "pagerate/WhoRatedPageModule",
		})

		const html = parse(json.body)

		let lastUser: UserID | undefined = undefined
		let lastRating: boolean | undefined = undefined
		let row = 0
		const listing: [UserID, boolean][] = []

		let findDiv: HTMLElement | undefined = undefined

		for (const elem of html.childNodes) {
			if (elem instanceof HTMLElement && elem.tagName.toLowerCase() == 'div') {
				findDiv = elem
				break
			}
		}

		if (findDiv === undefined) {
			return
		}

		for (const elem of findDiv.childNodes) {
			if (elem instanceof HTMLElement) {
				if (elem.tagName.toLowerCase() == 'br') {
					if (lastUser === undefined || lastRating === undefined) {
						// malformed!
						throw new TypeError(`Malformed voting list near row ${row}`)
					}

					listing.push([lastUser, lastRating])
					lastUser = undefined
					lastRating = undefined
				} else if (elem.tagName.toLowerCase() == 'span') {
					if (lastUser === undefined) {
						// must be an user
						lastUser = this.matchAndFetchUser(elem)
					} else if (lastRating === undefined) {
						// must be a vote
						const decoded = elem.textContent.trim()

						if (decoded == '+') {
							lastRating = true
						} else if (decoded == '-') {
							lastRating = false
						} else {
							throw new TypeError(`Garbage in voting list near row ${row} (voting element was ${decoded}, expected + or -)`)
						}
					} else {
						// garbage
						throw new TypeError(`Garbage in voting list near row ${row}`)
					}
				}
			}
		}

		return listing
	}

	public async fetchIsPageLocked(page_id: number) {
		const json = await this.fetchJsonForce({
			"page_id": page_id,
			"moduleName": "edit/PageEditModule",
		})

		const html = parse(json.message)
		return html.querySelector('a') == null
	}

	public async fetchRevision(revision_id: number) {
		const json = await this.fetchJson({
			"revision_id": revision_id,
			"moduleName": "history/PageSourceModule",
		})

		const html = parse(json.body)
		const div = html.querySelector('div.page-source')

		return div != undefined ? div.textContent : ''
	}

	public async fetchForumCategories() {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		const listing: ForumCategory[] = []

		const body = await this.client.get(`${this.url}/forum/start/hidden/show`)
		const html = parse(body.toString('utf-8'))

		const forum = html.querySelector('div.forum-start-box')

		if (forum == null) {
			return listing
		}

		for (const table of forum.querySelectorAll('table')) {
			const rows = table.querySelectorAll('tr')

			if (rows[0]?.attrs?.class == 'head') {
				rows.splice(0, 1)
			}

			for (const row of rows) {
				const name = row.querySelector('td.name')
				const threads = row.querySelector('td.threads')
				const posts = row.querySelector('td.posts')
				const last = row.querySelector('td.last')

				if (name == null || threads == null || posts == null || last == null) {
					continue
				}

				const title = name.querySelector('div.title')!
				const titleElem = title.querySelector('a')!
				const titleText = titleElem.textContent.trim()
				const categoryID = parseInt(titleElem.attributes['href'].match(WikiDot.categoryRegExp)![1])
				const description = name.querySelector('div.description')!.textContent.trim()

				const threadsNum = parseInt(threads.textContent.trim())
				const postsNum = parseInt(posts.textContent.trim())

				const lastDateElemMatch = last.querySelector('span.odate')?.attributes['class'].match(WikiDot.dateMatcher)
				const lastDate = lastDateElemMatch != undefined && lastDateElemMatch != null ? parseInt(lastDateElemMatch[1]) : undefined
				const lastUser = this.matchAndFetchUser(last)

				listing.push({
					title: titleText,
					description: description,
					id: categoryID,
					threads: threadsNum,
					posts: postsNum,
					last: lastDate,
					lastUser: lastUser
				})
			}
		}

		return listing
	}

	public async fetchThreads(category: number, page = 1) {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		const listing: ForumThread[] = []

		const body = await this.client.get(`${this.url}/forum/c-${category}/p/${page}`)
		const html = parse(body.toString('utf-8'))

		const rows = html.querySelector('div#page-content')!.querySelector('table.table')!.querySelectorAll('tr')

		if (rows[0]?.attributes['class'] == 'head') {
			rows.splice(0, 1)
		}

		for (const row of rows) {
			const name = row.querySelector('td.name')
			const started = row.querySelector('td.started')
			const posts = row.querySelector('td.posts')
			const last = row.querySelector('td.last')

			if (name == null || started == null || posts == null || last == null) {
				continue
			}

			const title = name.querySelector('div.title')!
			const titleElem = title.querySelector('a')!
			const titleText = titleElem.textContent.trim()
			const threadID = parseInt(titleElem.attributes['href'].match(WikiDot.threadRegExp)![1])

			// fairly weak check
			const sticky = (title.firstChild instanceof TextNode) ? title.firstChild.textContent.trim() != '' : false

			const description = name.querySelector('div.description')!.textContent.trim()
			const postsNum = parseInt(posts.textContent.trim())
			const lastDate = last.childNodes.length > 1 ? parseInt(last.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1]) : undefined
			const lastUser = last.childNodes.length > 1 ? this.matchAndFetchUser(last) : undefined
			const startedDate = parseInt(started.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
			const startedUser = this.matchAndFetchUser(started)

			listing.push({
				title: titleText,
				id: threadID,
				description: description,
				postsNum: postsNum,
				sticky: sticky,
				last: lastDate,
				lastUser: lastUser,
				started: startedDate,
				startedUser: startedUser
			})
		}

		return listing
	}

	public async fetchIsThreadLocked(threadId: number): Promise<boolean> {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		const json = await this.fetchJson({
			'moduleName': 'forum/sub/ForumNewPostFormModule',
			'threadId': threadId,
			'postId': ''
		}, true)

		if (json.status === 'ok') return false

		const html = parse(json.message)
		return html.querySelector('a') == null
	}

	public async fetchIsThreadLockedForce(threadId: number): Promise<boolean> {
		while (true) {
			try {
				return await this.fetchIsThreadLocked(threadId)
			} catch(err) {
				this.error(`Encountered ${err} while fetching lock status of thread ${threadId}, sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
	}

	public async fetchAllThreads(category: number) {
		const listing: ForumThread[] = []
		let page = 0

		while (true) {
			const fetch = await this.fetchThreads(category, ++page)
			listing.push(...fetch)

			if (fetch.length == 0) {
				break
			}
		}

		return listing
	}

	public async fetchThreadsUntil(category: number, thread: number) {
		const listing: ForumThread[] = []
		let page = 0

		while (true) {
			const fetch = await this.fetchThreads(category, ++page)
			let finish = false

			for (const fthread of fetch) {
				if (fthread.id <= thread) {
					finish = true
					break
				}

				listing.push(fthread)
			}

			if (fetch.length == 0 || finish) {
				break
			}
		}

		return listing
	}

	private parsePost(postContainer: HTMLElement): ForumPost {
		let post: HTMLElement | null = null
		const childrenCointainers: HTMLElement[] = []

		for (const elem of postContainer.childNodes) {
			if (elem instanceof HTMLElement) {
				if (elem.attributes['class'] == 'post') {
					post = elem
				} else if (elem.attributes['class'] == 'post-container') {
					childrenCointainers.push(elem)
				}
			}
		}

		if (post == null) {
			return {
				id: -1,
				title: 'ERROR',
				poster: null,
				content: 'ERROR',
				stamp: -1,
				children: []
			}
		}

		const postId = parseInt(post.attributes['id'].match(WikiDot.postRegExp)![1])
		const head = post.querySelector('div.head')
		const content = post.querySelector('div.content')
		const title = post.querySelector('div.title')

		if (head == null || content == null || title == null) {
			return {
				id: -1,
				title: 'ERROR',
				poster: null,
				content: 'ERROR',
				stamp: -1,
				children: []
			}
		}

		const info = head.querySelector('div.info')

		if (info == null) {
			return {
				id: -1,
				title: 'ERROR',
				poster: null,
				content: 'ERROR',
				stamp: -1,
				children: []
			}
		}

		const poster = this.matchAndFetchUser(info)
		const stamp = parseInt(info.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])

		const contentHtml = content.innerHTML

		const obj: ForumPost = {
			id: postId,
			title: title.textContent.trim(),
			poster: poster,
			content: contentHtml,
			stamp: stamp,
			children: []
		}

		const changes = post.querySelector('div.changes')

		if (changes != null) {
			const stamp = parseInt(changes.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
			const poster = this.matchAndFetchUser(changes)

			obj.lastEdit = stamp
			obj.lastEditBy = poster
		}

		for (const child of childrenCointainers) {
			obj.children.push(this.parsePost(child))
		}

		return obj
	}

	public async fetchThreadPosts(thread: number, page = 1) {
		const json = await this.fetchJson({
			"t": thread,
			"pageNo": page,
			"order": "",
			"moduleName": "forum/ForumViewThreadPostsModule",
		})

		const html = parse(json.body)
		const containers: HTMLElement[] = []

		for (const child of html.childNodes) {
			if (child instanceof HTMLElement) {
				if (child.attributes['class'] == 'post-container') {
					containers.push(child)
				}
			}
		}

		const listing: ForumPost[] = []

		for (const container of containers) {
			listing.push(this.parsePost(container))
		}

		return listing
	}

	public async fetchAllThreadPosts(thread: number) {
		const listing: ForumPost[] = []
		let page = 0

		while (true) {
			this.log(`Fetching posts of ${thread} offset ${page + 1}`)
			const fetch = await this.fetchThreadPosts(thread, ++page)
			listing.push(...fetch)

			if (fetch.length == 0) {
				break
			}
		}

		return listing
	}

	public async fetchPostRevisionList(post: number) {
		const json = await this.fetchJson({
			"postId": post,
			"moduleName": "forum/sub/ForumPostRevisionsModule",
		})

		const html = parse(json.body)
		const listing: PostRevision[] = []

		const table = html.querySelector('table.table')!

		for (const row of table.querySelectorAll('tr')) {
			const columns = row.querySelectorAll('td')
			const author = this.matchAndFetchUser(columns[0])
			const stamp = parseInt(columns[1].querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
			const id = parseInt(columns[2].querySelector('a')!.attributes['onclick'].match(/([0-9]+)/)![1])

			listing.push({
				author: author,
				stamp: stamp,
				id: id
			})
		}

		return listing
	}

	public async fetchPostRevision(revision: number): Promise<ForumRevisionBody> {
		let lastError

		for (let i = 0; i < 3; i++) {
			try {
				const json = await this.fetchJson({
					"revisionId": revision,
					"moduleName": "forum/sub/ForumPostRevisionModule",
				}, true)

				if (json.body != 'ok') {
					throw Error(`Server returned ${json.body} (${JSON.stringify(json)})`)
				}

				return {
					content: json.content,
					title: json.title
				}
			} catch(err) {
				lastError = err
			}
		}

		throw lastError
	}

	private static splitFilePath(path: string): [string, string, string] {
		const firstIndex = path.indexOf('/')
		let pageName: string
		let fileName: string

		if (firstIndex == -1) {
			// what.
			pageName = '~'
			fileName = reencodeComponent(path)
		} else {
			pageName = path.substring(0, firstIndex)
			pageName = pageName != '' ? reencodeComponent(pageName) : '~'
			fileName = reencodeComponent(path.substring(firstIndex + 1))
		}

		if (fileName == '.' || fileName == '..') {
			fileName = 'why_did_you_name_me_this_way'
		}

		if (pageName == '.' || pageName == '..') {
			pageName = 'why_did_you_name_me_this_way'
		}

		return [pageName, fileName, `${pageName}/${fileName}`]
	}

	private static splitFilePathRaw(url: string): [string, string, string] | null {
		const match = url.match(this.localFileMatch)

		if (match == null) {
			return null
		}

		const [pageName, fileName, recombined] = this.splitFilePath(match[1])
		return [pageName, fileName, recombined]
	}

	private writeToFileMap(fileMeta: FileMeta, pageName: string, fileName: string) {
		this.fileMap.data[fileMeta.file_id] = {
			url: fileMeta.url,
			path: `${pageName}/${fileName}`
		}

		this.fileMap.markDirty()
	}

	public async fileExists(page_id: string, file_id: number, size?: number) {
		try {
			const stats = await promises.stat(`${this._workingDirectory}/files/${page_id}/${file_id}`)

			if (size !== undefined && stats.size != size) {
				return false
			}

			return true
		} catch(err) {

		}

		return false
	}

	private async fetchFileInner(fileMeta: {url: string, file_id: number}, pageName: string, config?: RequestConfig) {
		if (this.client === null) {
			throw new Error(`This object is in offline mode`)
		}

		this.log(`Fetching file ${fileMeta.url}`)

		this.pushPendingFiles(fileMeta.file_id)

		await this.client.get(fileMeta.url, config).then(async buffer => {
			await promises.mkdir(`${this._workingDirectory}/files/${pageName}`, {recursive: true})
			await promises.writeFile(`${this._workingDirectory}/files/${pageName}/${fileMeta.file_id}`, buffer)
			this.removePendingFiles(fileMeta.file_id)
		}).catch(err => {
			this.log(`Unable to fetch ${fileMeta.url} because ${err}`)
		})
	}

	public async fetchFilesFor(page_id: number, existing: FileMeta[] = []) {
		await this.initialize()
		const metadata = []

		for (const fileMeta of await this.fetchFileMetaListForce(page_id, existing)) {
			const match = WikiDot.splitFilePathRaw(fileMeta.url)

			if (match != null) {
				const [pageName, fileName, recombined] = match
				metadata.push(fileMeta)

				if (this.downloadingFiles.includes(fileMeta.file_id)) {
					continue
				}

				this.downloadingFiles.push(fileMeta.file_id)
				this.writeToFileMap(fileMeta, pageName, fileName)

				if (await this.fileExists(pageName, fileMeta.file_id, fileMeta.size_bytes)) {
					continue
				}

				this.fetchFileInner(fileMeta, pageName, {
					headers: {
						'Referer': this.url
					}
				})
			}
		}

		return metadata
	}

	public async fetchFileMeta(file_id: number): Promise<FileMeta | null> {
		this.log(`Fetching file meta of ${file_id}`)

		const json = await this.fetchJson({
			"file_id": file_id,
			"moduleName": "files/FileInformationWinModule",
		})

		if (json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

		const html = parse(json.body)
		const rows = html.querySelectorAll('tr')

		const name = rows[0]?.querySelectorAll('td')[1]
		const fullURL = rows[1]?.querySelectorAll('td')[1]
		const size = rows[2]?.querySelectorAll('td')[1]
		const mime = rows[3]?.querySelectorAll('td')[1]
		const contentType = rows[4]?.querySelectorAll('td')[1]
		const uploader = rows[5]?.querySelectorAll('td')[1]
		const date = rows[6]?.querySelectorAll('td')[1]

		if (name === undefined || name === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (fullURL === undefined || fullURL === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (size === undefined || size === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (mime === undefined || mime === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (contentType === undefined || contentType === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (uploader === undefined || uploader === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}

		if (date === undefined || date === null) {
			this.error(`Encountered invalid HTML layout while fetching file meta of ${file_id}, HTML was: ${json.body}`)
			return null
		}


		const matchAuthor = this.matchAndFetchUser(uploader)
		const matchFileSize = size.textContent.match(WikiDot.fileSizeMatcher)
		const matchDate = date.querySelector('span.odate')?.attrs['class']?.match(WikiDot.dateMatcher)

		return {
			file_id: file_id,
			name: name.textContent.trim(),
			url: fullURL.querySelector('a')?.attrs['href']!,
			size: size.textContent.trim(),
			size_bytes: parseInt(matchFileSize !== null ? matchFileSize[1] : 'NaN'),
			mime: mime.textContent.trim(),
			content: contentType.textContent.trim(),
			author: matchAuthor,
			stamp: parseInt(matchDate !== null && matchDate !== undefined ? matchDate[1] : 'NaN'),
			internal_version: WikiDot.FILE_METADATA_VERSION
		}
	}

	public async fetchFileMetaForce(file_id: number) {
		while (true) {
			try {
				return await this.fetchFileMeta(file_id)
			} catch(err) {
				this.error(`Encountered ${err} when fetching file meta (ID ${file_id}), sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
	}

	public async fetchFileList(page_id: number, page: number = 1) {
		const json = await this.fetchJson({
			"page_id": page_id,
			"page": page,
			"moduleName": "files/PageFilesModule",
		})

		if (json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

		const html = parse(json.body)

		const list = []

		for (const elem of html.querySelectorAll('tr')) {
			const id = elem.attrs['id']?.match(WikiDot.fileIdMatcher)

			if (id != null) {
				list.push(parseInt(id[1]))
			}
		}

		return list
	}

	public async fetchFileListForce(page_id: number) {
		const listing = []

		for (let page = 0;; page++) {
			let hit = false

			while (true) {
				try {
					const getlist = await this.fetchFileList(page_id, page)

					if (getlist.length < 100) {
						hit = true
					}

					listing.push(...getlist)
					break
				} catch(err) {
					this.error(`Encountered ${err} when fetching file list, sleeping for 5 seconds`)
					await sleep(5_000)
				}
			}

			if (hit) {
				break
			}
		}

		return listing
	}

	public async fetchFileMetaListForce(page_id: number, existing: FileMeta[] = []) {
		const list = []
		const list2 = []

		for (const file_id of await this.fetchFileListForce(page_id)) {
			let hit = false

			for (const emeta of existing) {
				if (emeta.file_id == file_id && emeta.internal_version != undefined && emeta.internal_version >= WikiDot.FILE_METADATA_VERSION) {
					hit = true
					list2.push(emeta)
					break
				}
			}

			if (!hit) {
				list.push(this.fetchFileMetaForce(file_id))
			}
		}

		// list2.push(...existing)
		for (const meta of (await Promise.all(list))) {
			if (meta !== null) {
				list2.push(meta)
			}
		}

		return list2
	}

	private zmqNotify(type: MessageType, data?: MessageData) {
		if(this.zmqSender) {
			this.zmqSender.sendMessage(type, data)
		}
	}

	public async workLoop(lock: Lock) {
		if(this.zmqSender) {
			this.zmqSender.init()
		}

		if (this.client === null || this.queue === null) {
			this.zmqNotify(MessageType.ErrorFatal, {errorKind: ErrorKind.ErrorClientOffline})
			throw new Error(`This object is in offline mode`)
		}

		await this.initialize()
		this.zmqNotify(MessageType.Progress, {status: Status.BuildingSitemap})

		{
			let mapNeedsRebuild = true

			try {
				mapNeedsRebuild = (await promises.stat(`${this._workingDirectory}/meta/pages`)).isDirectory()
			} catch(err) {
				mapNeedsRebuild = false
			}

			if (mapNeedsRebuild) {
				for (const _ in this.pageIdMap.data) {
					mapNeedsRebuild = false
					break
				}
			}

			if (mapNeedsRebuild) {
				this.log(`Page id map is empty, gotta populate it...`)

				const tasks: any[] = []

				for (const name of await promises.readdir(`${this._workingDirectory}/meta/pages/`)) {
					if (name.endsWith('.json')) {
						tasks.push(async () => {
							const metadata: PageMeta = JSON.parse(await promises.readFile(`${this._workingDirectory}/meta/pages/${name}`, {encoding: 'utf-8'}))

							if (metadata != null) {
								this.pageIdMap.data[metadata.page_id] = metadata.name
								this.pageIdMap.markDirty()
							} else {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind:ErrorKind.ErrorMalformedSitemap})
								this.error(`${this._workingDirectory}/meta/pages/${name} is malformed!`)
							}
						})
					}
				}

				const worker = blockingQueue(tasks)
				await parallel(worker, 4)
			}
		}

		await lock.lock()
		this.log(`Fetching sitemap`)
		const sitemapPages: [string, Date | null][] = []

		const fetchSiteMap = async (url: string) => {
			const sitemap = (await this.client!.get(url)).toString('utf-8')
			const xml = parse(sitemap)

			for (const submap of xml.querySelectorAll('sitemap')) {
				for (const loc of submap.querySelectorAll('loc')) {
					const pageMatch = loc.textContent.match(/_page_([0-9]+)\.xml$/)

					if (pageMatch != null) {
						await fetchSiteMap(loc.textContent)
					}
				}
			}

			for (const urlset of xml.querySelectorAll('urlset')) {
				for (const elem of urlset.querySelectorAll('url')) {
					let loc = elem.querySelector('loc')?.textContent
					const lastmodElem = elem.querySelector('lastmod')
					const lastmod = lastmodElem != null ? new Date(lastmodElem.textContent) : null

					if (loc == undefined) {
						continue
					}

					if(this.blacklist.includes(loc)) {
						this.log(`Removing blacklisted page ${loc} from sitemap...`)
						continue
					}

					if (loc.startsWith(this.url)) {
						// domain match
						loc = loc.substring(this.url.length)
					} else if (loc.startsWith('http')) {
						// domain does not match, assume we have custom domain
						// e.g. scpfoundation.net redirects us to scp-ru.wikidot.com
						const parsedURL = new URL(loc)
						loc = parsedURL.pathname.substring(1)
					}

					if (loc == '' || loc == '/') {
						// loc = 'main'
						continue
					}

					if (loc.startsWith('/forum/') || loc.startsWith('forum/')) {
						continue
					}

					if (loc.startsWith('/')) {
						loc = loc.substring(1)
					}

					sitemapPages.push([loc, lastmod])
				}
			}
		}

		try {
			await fetchSiteMap(`${this.url}/sitemap.xml`)
		} finally {
			lock.release()
		}

		this.log(`Counting total ${sitemapPages.length} pages`)
		this.zmqNotify(MessageType.Preflight, {total: sitemapPages.length})

		const oldMap = await this.readSiteMap()

		if (oldMap == null) {
			this.log(`No previous sitemap was found, doing full scan`)
		} else {
			this.log(`Previous sitemap contains ${oldMap.size} pages`)
			this.log(`Searching for deleted pages...`)

			for (const name of oldMap.keys()) {
				let hit = false

				for (const [pageName, _] of sitemapPages) {
					if (name == pageName) {
						hit = true
						break
					}
				}

				if (!hit) {
					this.log(`Page ${name} was removed`)

					const metadata = await this.readPageMetadata(name)

					await this.markPageRemoved(name)

					if (metadata != null) {
						delete this.pageIdMap.data[metadata.page_id]
						this.pageIdMap.markDirty()
					}
				}
			}
		}


		this.zmqNotify(MessageType.Progress, {status: Status.PagesMain})
		const tasks: any[] = []
		
		let done = 0
		let postponed = 0

		for (const [pageName, pageUpdate] of sitemapPages) {
			tasks.push(async () => {

				// Check if we already finished the file during a previous run
				if (oldMap != null) {
					const oldStamp = oldMap.get(pageName)

					if (oldStamp === pageUpdate || pageUpdate != null && oldStamp === pageUpdate.getTime()) {
						if (await this.pageMetadataExists(pageName)) {
							if(this.zmqSender) {
								done++
							}
							// consider it fetched, since sitemap is written to disk only when everything got saved
							return
						}
					}
				}

				let metadata = await this.readPageMetadata(pageName)

				if (
					metadata == null ||
					pageUpdate == null || // always check
					metadata.sitemap_update != pageUpdate.getTime() ||
					metadata.page_id == undefined ||
					metadata.version == undefined ||
					metadata.version < WikiDot.PAGE_METADATA_VERSION
				) {
					//this.log(`Need to renew ${pageName} (updated ${pageUpdate == null ? 'always invalid' : pageUpdate} vs ${metadata == null || metadata.sitemap_update == undefined ? 'never' : new Date(metadata.sitemap_update)})`)
					this.log(`Need to renew ${pageName}`)

					let pageMeta: GenericPageData

					try {
						pageMeta = await this.fetchGeneric(pageName)
					} catch(err) {
						postponed++
						this.log(`Encountered ${err}, postponing page ${pageName} for late fetch`)
						this.pushPendingPages(pageName)
						return
					}

					if (pageMeta.page_id != undefined) {
						let newMeta: PageMeta

						if (metadata == null || metadata.page_id != -1 && metadata.page_id != pageMeta.page_id) {
							newMeta = {
								name: pageName,
								version: WikiDot.PAGE_METADATA_VERSION,
								revisions: [],
								files: [],
								page_id: pageMeta.page_id,
								parent: pageMeta.parent,
							}

							if (metadata != null) {
								this.log(`Page ${pageName} got replaced`)
								await this.markPageRemoved(pageName)
								delete this.pageIdMap.data[metadata.page_id]
								this.pageIdMap.markDirty()
							}
						} else {
							newMeta = {
								name: pageName,
								version: WikiDot.PAGE_METADATA_VERSION,
								revisions: metadata.revisions,
								files: metadata.files != undefined ? metadata.files : [],
								page_id: metadata.page_id,
								votings: metadata.votings,
								parent: pageMeta.parent,
							}
						}

						if (this.pageIdMap.data[newMeta.page_id] !== newMeta.name) {
							this.pageIdMap.data[newMeta.page_id] = newMeta.name
							this.pageIdMap.markDirty()
						}

						newMeta.rating = pageMeta.rating
						newMeta.forum_thread = pageMeta.forum_thread
						newMeta.tags = pageMeta.tags
						newMeta.title = pageMeta.page_name

						if (pageUpdate != null) {
							newMeta.sitemap_update = pageUpdate.getTime()
						}

						for (let i0 = 0; i0 < 3; i0++) {
							try {
								newMeta.votings = await this.fetchPageVoters(pageMeta.page_id)
								break
							} catch(err) {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorVoteFetch, name: pageName})
								this.error(`Encountered error fetching ${pageName} voters: ${err}`)
							}
						}

						for (let i0 = 0; i0 < 3; i0++) {
							try {
								const oldfiles = newMeta.files
								newMeta.files = await this.fetchFilesFor(pageMeta.page_id, newMeta.files)

								// search for removed files
								for (const emeta of oldfiles) {
									let hit = false

									for (const nmeta of newMeta.files) {
										if (nmeta.file_id == emeta.file_id) {
											hit = true
											break
										}
									}

									if (!hit) {
										try {
											this.log(`File ${emeta.file_id} <${emeta.url}> inside ${pageName} <${pageMeta.page_id}> got removed`)
											await promises.unlink(`${this._workingDirectory}/files/${pageName}/${emeta.file_id}`)
										} catch(err) {
											this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorFileUnlink, name: pageName})
											this.error(String(err))
										}
									}
								}

								break
							} catch(err) {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorFileFetch, name: pageName})
								this.error(`Encountered error fetching ${pageName} files: ${err}`)
							}
						}

						for (let i0 = 0; i0 < 3; i0++) {
							try {
								newMeta.is_locked = await this.fetchIsPageLocked(pageMeta.page_id)
								break
							} catch(err) {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorLockStatusFetch, name: pageName})
								this.error(`Encountered error fetching ${pageName} "is locked" status: ${err}`)
							}
						}

						const lastRevision = findMostRevision(newMeta.revisions)
						const changes = lastRevision == null ? await this.fetchPageChangeListAllForce(pageMeta.page_id) : await this.fetchPageChangeListAllUntilForce(pageMeta.page_id, lastRevision)
						newMeta.revisions.unshift(...changes!)
						await this.writePageMetadata(pageName, newMeta)
						metadata = newMeta
					}
				}

				if (metadata == null || metadata.page_id == undefined) {
					this.pushPendingPages(pageName)
					return
				}

				const revisionsToFetch: PageRevision[] = []
				const localRevs = await this.revisionList(pageName)

				for (const key in metadata.revisions) {
					const rev = metadata.revisions[key]

					if (!localRevs.includes(rev.revision)) {
						revisionsToFetch.push(rev)
					}
				}

				let changes = false
				revisionsToFetch.reverse()

				const worker = async () => {
					while (true) {
						const rev = revisionsToFetch.pop()

						if (rev == undefined) {
							break
						}

						for (let i0 = 0; i0 < 2; i0++) {
							try {
								this.log(`Fetching revision ${rev.revision} (${rev.global_revision}) of ${pageName}`)
								const body = await this.fetchRevision(rev.global_revision)
								await this.writeRevision(pageName, rev.revision, body)
								changes = true
								await this.queue!.workerDelay()

								if (rev.global_revision in this.pendingRevisions.data) {
									delete this.pendingRevisions.data[rev.global_revision]
									this.pendingRevisions.markDirty()
								}

								break
							} catch(err) {
								this.zmqNotify(MessageType.PagePostponed, {name: pageName})
								this.error(`Encountered ${err}, postponing revision ${rev.global_revision} of ${pageName} for later fetch`)
								this.pendingRevisions.data[rev.global_revision] = metadata!.page_id
								this.pendingRevisions.markDirty()
							}
						}
					}
				}

				await this.queue!.run(worker, 8)

				this.removePendingPages(pageName)
				await this.writePageMetadata(pageName, metadata)

				if (changes) {
					await this.compressRevisions(WikiDot.normalizeName(pageName))
				}
				//this.zmqNotify(MessageType.PageDone, {name: pageName})
				done++
			})
		}

		const worker = this.queue.blockingQueue(tasks)

		const interval_id = setInterval(() => {
			console.log(`[${this.name}] - ${tasks.length} remaining`)
			this.zmqNotify(MessageType.Progress, {status: Status.PagesMain, done: done, postponed: postponed})
		}, 2000 + Math.random() * 100);

		await this.queue.run(worker, 8)

		await this.writeSiteMap(sitemapPages)

		clearInterval(interval_id); // Stop reporting on page progress

		this.zmqNotify(MessageType.Progress, {status: Status.ForumsMain})

		this.log(`Fetching forums list`)

		let forums: ForumCategory[]

		try {
			forums = await this.fetchForumCategories()
		} catch(err) {
			this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorForumListFetch})
			this.error(`Error while fetching forum list: ${err}, will not try again`)
			forums = []
		}

		for (const forum of forums) {
			const localForum = await this.readForumCategory(forum.id)

			if (localForum != null && localForum.last == forum.last && localForum.full_scan && localForum.version === WikiDot.FORUM_CATEGORY_METADATA_VERSION) {
				continue
			}

			const full_scan = localForum != null ? localForum.full_scan : false
			let page = localForum != null ? localForum.last_page : 0

			while (true) {
				let updated = false
				this.log(`Fetching threads of ${forum.id} offset ${page + 1}`)
				const threads = await this.fetchThreads(forum.id, ++page)
				const workers: any[] = []

				for (const thread of threads) {
					workers.push(async () => {
						const localThread = await this.readForumThread(forum.id, thread.id)

						let shouldFetch = localThread == null || localThread.last != thread.last
						let localPostsAndRevisions: [number[], Map<number, string[]>] | null = null

						if (!shouldFetch && localThread != null) {
							let count = 0

							const dive = (f: LocalForumPost) => {
								count++

								for (const child of f.children) {
									dive(child)
								}
							}

							for (const post of localThread.posts) {
								dive(post)
							}

							shouldFetch = count != thread.postsNum

							if (shouldFetch) {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorForumCountMismatch})
								this.error(`Post amount mismatch of ${thread.id} (expected ${thread.postsNum}, got ${count})`)
							}

							if (!shouldFetch) {
								localPostsAndRevisions = await this.readPostsAndRevisionsOfThread(forum.id, thread.id)

								if (localPostsAndRevisions[0].length != count) {
									this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorForumCountMismatch})
									this.error(`Fetched post count mismatch of ${thread.id} (expected ${count}, got ${localPostsAndRevisions[0].length})`)
									shouldFetch = true
								}
							}

							if (!shouldFetch) {
								shouldFetch = localThread.version === undefined || localThread.version < WikiDot.FORUM_THREAD_METADATA_VERSION
							}
						}

						// TODO: IF we have meta, and it says that we fetched entire thread
						// and it hasn't changed... is this really the case?
						// about post edits, are they reflected anywhere???
						if (shouldFetch) {
							// thread metadata is outdated
							updated = true
							this.log(`Fetching thread meta of ${thread.title} (${thread.id})`)

							const oldPosts = localThread != null ? localThread.posts : []

							const newMeta: LocalForumThread = {
								title: thread.title,
								id: thread.id,
								description: thread.description,
								last: thread.last,
								lastUser: thread.lastUser,
								started: thread.started,
								startedUser: thread.startedUser,
								postsNum: thread.postsNum,
								sticky: thread.sticky,
								isLocked: await this.fetchIsThreadLockedForce(thread.id),
								version: WikiDot.FORUM_THREAD_METADATA_VERSION,
								//posts: localThread != null ? localThread.posts : []
								posts: []
							}

							if (localPostsAndRevisions === null) {
								localPostsAndRevisions = await this.readPostsAndRevisionsOfThread(forum.id, thread.id)
							}

							const [_, knownPostsRevs] = localPostsAndRevisions

							const posts = await this.fetchAllThreadPosts(thread.id)
							let fetchOnce = false

							const workWithPost = async (post: ForumPost) => {
								const oldPost = findPost(oldPosts, post.id)

								const localPost: LocalForumPost = {
									id: post.id,
									title: post.title,
									poster: post.poster,
									stamp: post.stamp,
									lastEdit: post.lastEdit,
									lastEditBy: post.lastEditBy,
									revisions: oldPost != null ? oldPost.revisions : [],
									children: []
								}

								const existingRevisions = knownPostsRevs.get(post.id) ?? []

								if (post.lastEdit != undefined) {
									this.log(`Fetching revision list of post ${post.id}`)
									const revisionList = await this.fetchPostRevisionList(post.id)

									const revWorker = []

									for (const revision of revisionList) {
										if (existingRevisions.includes(revision.id.toString()) && findPostRevision(localPost.revisions, revision.id)) {
											// this.log(`Reusing existing post ${post.id} revision ${revision.id}`)
											continue
										}

										revWorker.push((async () => {
											try {
												this.log(`Fetching revision ${revision.id} of post ${post.id}`)
												const revContent = await this.fetchPostRevision(revision.id)
												await this.writePostRevision(forum.id, thread.id, post.id, revision.id, revContent.content)
												fetchOnce = true

												const find = findPostRevision(localPost.revisions, revision.id)

												if (find != null) {
													const index = localPost.revisions.indexOf(find)
													localPost.revisions.splice(index, 1)
												}

												localPost.revisions.push({
													title: revContent.title,
													author: revision.author,
													id: revision.id,
													stamp: revision.stamp
												})
											} catch(err) {
												if (err instanceof HTTPError && err.response === 500) {
													// slurp it, wikidot is hopeless
													this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorWikidotInternal})
												} else {
													this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorForumPostFetch})
													throw new Error(`Fetching revision ${revision.id} of post ${post.id}: ${err}`)
												}
											}
										})())
									}

									if (revWorker.length != 0 || !existingRevisions.includes('latest')) {
										await this.writePostRevision(forum.id, thread.id, post.id, 'latest', post.content)
										fetchOnce = true
									}

									if (revWorker.length != 0) {
										await Promise.all(revWorker)
									}
								} else if (!existingRevisions.includes('latest')) {
									await this.writePostRevision(forum.id, thread.id, post.id, 'latest', post.content)
									fetchOnce = true
								}

								const workers = []

								for (const child of post.children) {
									workers.push((async () => {
										localPost.children.push(await workWithPost(child))
									})())
								}

								await Promise.all(workers)
								return localPost
							}

							const workers = []

							for (const post of posts) {
								workers.push((async () => {
									while (true) {
										try {
											const localPost = await workWithPost(post)
											newMeta.posts.push(localPost)
											// await this.writeForumPost(post.id, localPost)
											break
										} catch(err) {
											this.error(`Encountered ${err}, sleeping for 5 seconds`)
											await sleep(5_000)
										}
									}
								})())
							}

							await Promise.all(workers)
							await this.writeForumThread(forum.id, thread.id, newMeta)

							if (fetchOnce) {
								await this.compressForumThread(forum.id, thread.id)
							}
						}
					})
				}

				const doWork = async () => {
					while (true) {
						const task = workers.pop()

						if (task == undefined) {
							return
						}

						while (true) {
							try {
								await task()
								break
							} catch(err) {
								if (err instanceof Error) {
									this.error(`Encountered ${err.message}\n${err.stack}, sleeping for 5 seconds`)
								} else {
									this.error(`Encountered ${err}, sleeping for 5 seconds`)
								}

								await sleep(5_000)
							}
						}
					}
				}

				await this.queue.run(doWork, 3)

				if (threads.length == 0 || !updated && full_scan) {
					await this.writeForumCategory({
						title: forum.title,
						description: forum.description,
						id: forum.id,
						last: forum.last,
						posts: forum.posts,
						threads: forum.threads,
						lastUser: forum.lastUser,
						full_scan: true,
						last_page: 0,
						version: WikiDot.FORUM_CATEGORY_METADATA_VERSION
					})

					break
				} else {
					await this.writeForumCategory({
						title: forum.title,
						description: forum.description,
						id: forum.id,
						last: forum.last,
						posts: forum.posts,
						threads: forum.threads,
						lastUser: forum.lastUser,
						full_scan: full_scan,
						last_page: page,
						version: WikiDot.FORUM_CATEGORY_METADATA_VERSION
					})
				}
			}
		}

		this.log(`Fetched all forums!`)

		// if we didn't finish full scan then we would have to do relatively full scan of all forum categories
		// but if we managed to reach the end, then we gonna have fast index!
		//await this.writeForumMeta(forums)

		this.zmqNotify(MessageType.Progress, {status: Status.FilesPending})

		if (this.pendingFiles.data.length != 0) {
			this.log(`Fetching pending files`)

			for (let i = this.pendingFiles.data.length - 1; i >= 0; i--) {
				const id = this.pendingFiles.data[i]
				let mapped = this.fileMap.data[id]

				if (mapped == undefined) {
					this.log(`Re-fetching file meta of ${id}`)
					const fetchedMeta = await this.fetchFileMeta(id)

					if (fetchedMeta != null) {
						const match = WikiDot.splitFilePathRaw(fetchedMeta.url)

						if (match != null) {
							const [matched, split, last] = match
							this.writeToFileMap(fetchedMeta, split, last)
							mapped = this.fileMap.data[id]
						}
					}
				}

				if (mapped == undefined) {
					this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorFileMetaFetch})
					this.log(`Failed to map file meta ${id}`)
					continue
				}

				const match = WikiDot.splitFilePathRaw(mapped.url)

				if (match != null) {
					const [pageName, fileName, recombined] = match

					if (await this.fileExists(pageName, id)) {
						continue
					}

					this.fetchFileInner({url: mapped.url, file_id: id}, pageName, {
						headers: {
							'Cache-Control': 'no-cache',
							'Referer': this.url,
							'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
						}
					})
				}
			}
		}

		this.zmqNotify(MessageType.Progress, {status: Status.PagesPending})

		{
			const copy: [number, number][] = []

			for (const global_revision in this.pendingRevisions.data) {
				const page_id = this.pendingRevisions.data[global_revision]
				copy.push([parseInt(global_revision), page_id])
			}

			if (copy.length != 0) {
				this.log(`Fetching pending revisions`)

				const mapping = new Map<number, PageMeta>()

				for (const page_id in this.pageIdMap.data) {
					const num = parseInt(page_id)
					let hit = true

					for (const [_, page_id] of copy) {
						if (num == page_id) {
							hit = false
							const page_name = this.pageIdMap.data[page_id]
							const metadata = await this.readPageMetadata(page_name)

							if (metadata != null) {
								if (metadata.page_id != num) {
									this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorWhatTheFuck})
									this.error(`yo dude what the fuck`)
									this.error(`Page map match ID ${num} against ${page_name}, but ${page_name} in pages/ has ID of ${metadata.page_id}`)
									this.pageIdMap.data[metadata.page_id] = metadata.name
									this.pageIdMap.markDirty()
									break
								}

								mapping.set(metadata.page_id, metadata)
								hit = true
							}

							break
						}
					}

					if (!hit) {
						this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorMetaMissing})
						this.error(`Unable to find page metadata for ${page_id}!!!`)
					}
				}

				const tasks: any[] = []

				for (const [global_revision, page_id] of copy) {
					tasks.push(async () => {
						const pageMeta = mapping.get(page_id)

						if (pageMeta == undefined) {
							this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorGivingUp})
							this.error(`Unknown page with id ${page_id} when resolving pending revision! Considering revision ${global_revision} unresolvable.`)
							delete this.pendingRevisions.data[global_revision]
							this.pendingRevisions.markDirty()
							return
						}

						let rev: PageRevision | undefined = undefined

						for (const prev of pageMeta.revisions) {
							if (prev.global_revision == global_revision) {
								rev = prev
								break
							}
						}

						if (rev == undefined) {
							this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorGivingUp})
							this.error(`Unknown revision with id ${global_revision} inside ${pageMeta.name} (${[pageMeta.page_id]}) when resolving pending revision! Considering revision unresolvable.`)
							delete this.pendingRevisions.data[global_revision]
							this.pendingRevisions.markDirty()
							return
						}

						try {
							this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorGivingUp})
							this.log(`Fetching revision ${rev.revision} (${rev.global_revision}) of ${pageMeta.name}`)
							const body = await this.fetchRevision(rev.global_revision)
							await this.writeRevision(pageMeta.name, rev.revision, body)
							delete this.pendingRevisions.data[rev.global_revision]
							this.pendingRevisions.markDirty()
						} catch(err) {
							if (pageMeta.name.startsWith('nav:') || pageMeta.name.startsWith('tech:')) {
								this.zmqNotify(MessageType.ErrorNonfatal, {errorKind: ErrorKind.ErrorGivingUp})
								this.error(`Encountered ${err}, giving up on ${rev.global_revision} of ${pageMeta.name}`)
								delete this.pendingRevisions.data[rev.global_revision]
								this.pendingRevisions.markDirty()
							} else {
								this.error(`Encountered ${err}, postponing revision ${rev.global_revision} of ${pageMeta.name} for later fetch (AGAIN)`)
							}
						}
					})
				}

				const worker = blockingQueue(tasks)
				await this.queue.run(worker, 6)

				this.log(`Fetched all pending revisions!`)
			}
		}

		this.zmqNotify(MessageType.Progress, {status: Status.Compressing})

		this.log(`Compressing page revisions`)

		for (const name of await promises.readdir(`${this._workingDirectory}/pages/`)) {
			// hidden/system files start with dot
			// shortcut with .7z check to avoid excessive filesystem load
			if (!name.startsWith('.') && !name.endsWith('.7z') && (await promises.stat(`${this._workingDirectory}/pages/${name}`)).isDirectory()) {
				await this.compressRevisions(name)
			}
		}

		if (forums.length != 0) {
			this.log(`Compressing forum threads`)

			let isdir = false

			try {
				isdir = (await promises.stat(`${this._workingDirectory}/forum/`)).isDirectory()
			} catch(err) {

			}

			if (isdir) {
				for (const category of await promises.readdir(`${this._workingDirectory}/forum/`)) {
					if (!category.startsWith('.') && (await promises.stat(`${this._workingDirectory}/forum/${category}`)).isDirectory()) {
						for (const thread of await promises.readdir(`${this._workingDirectory}/forum/${category}`)) {
							if (!thread.startsWith('.') && !thread.endsWith('.7z') && (await promises.stat(`${this._workingDirectory}/forum/${category}/${thread}`)).isDirectory()) {
								await this.compressForumThread(category, thread)
							}
						}
					}
				}
			}
		}

		if(this.zmqSender) {
			this.zmqSender.sendMessage(MessageType.FinishSuccess)
		}
	}

	// local I/O
	public async readForumCategory(category: number) {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/forum/category/${category}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumCategory
		} catch(err) {
			return null
		}
	}

	public async readForumCategories() {
		try {
			const list = await promises.readdir(`${this._workingDirectory}/meta/forum/category/`)
			const build: {[key: string]: LocalForumCategory} = {}

			for (const filename of list) {
				if (filename.match(/^[0-9]+\.json$/)) {
					const read = await promises.readFile(`${this._workingDirectory}/meta/forum/category/${filename}`, {encoding: 'utf-8'})
					const cat = JSON.parse(read) as LocalForumCategory
					build[cat.id] = cat
				}
			}

			return build
		} catch(err) {
			return {}
		}
	}

	public async readForumThreadList(id: number) {
		try {
			const list = await promises.readdir(`${this._workingDirectory}/meta/forum/${id}/`)
			const build = []

			for (const filename of list) {
				if (filename.match(/^[0-9]+\.json$/)) {
					build.push(parseInt(filename.substring(0, filename.length - 5)))
				}
			}

			return build
		} catch(err) {
			return []
		}
	}

	public async writeForumCategory(value: LocalForumCategory) {
		await promises.mkdir(`${this._workingDirectory}/meta/forum/category`, {recursive: true})
		await promises.writeFile(`${this._workingDirectory}/meta/forum/category/${value.id}.json`, JSON.stringify(value, null, 4))
	}

	public async readForumThread(category: number, thread: number) {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/forum/${category}/${thread}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumThread
		} catch(err) {
			return null
		}
	}

	public async writeForumThread(category: number, thread: number | LocalForumThread, value?: LocalForumThread) {
		if (value === undefined && typeof thread == 'number') {
			throw new TypeError('No thread provided')
		}

		await promises.mkdir(`${this._workingDirectory}/meta/forum/${category}`, {recursive: true})

		if (typeof thread == 'number') {
			await promises.writeFile(`${this._workingDirectory}/meta/forum/${category}/${thread}.json`, JSON.stringify(value, null, 4))
		} else {
			await promises.writeFile(`${this._workingDirectory}/meta/forum/${category}/${thread.id}.json`, JSON.stringify(thread, null, 4))
		}
	}

	public async readForumPost(post: number) {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/forum/post/${post}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumPost
		} catch(err) {
			return null
		}
	}

	public async writeForumPost(post: number, value: LocalForumPost) {
		await promises.mkdir(`${this._workingDirectory}/meta/forum/post`, {recursive: true})
		await promises.writeFile(`${this._workingDirectory}/meta/forum/post/${post}.json`, JSON.stringify(value, null, 4))
	}

	public async writePostRevision(category: number, thread: number, post: number, revision: 'latest' | number, value: string) {
		await promises.mkdir(`${this._workingDirectory}/forum/${category}/${thread}/${post}/`, {recursive: true})
		await promises.writeFile(`${this._workingDirectory}/forum/${category}/${thread}/${post}/${revision}.html`, value)
	}

	private async _postRevisionListFiles(category: number, thread: number, post: number) {
		try {
			return await promises.readdir(`${this._workingDirectory}/forum/${category}/${thread}/${post}/`)
		} catch(err) {
			return []
		}
	}

	private async _postRevisionList7z(category: number, thread: number, post: number) {
		try {
			const list = await listZipFiles(`${this._workingDirectory}/forum/${category}/${thread}.7z`, {recursive: true})
			const build = []
			const predicate = `${post}/`

			for (const piece of list) {
				if (piece.file != undefined && piece.file.startsWith(predicate)) { // ???
					build.push(piece.file.substring(predicate.length))
				}
			}

			return build
		} catch(err) {
			return []
		}
	}

	private async _readPostsAndRevsLists(category: number, thread: number): Promise<[string[], Map<string, string[]>]> {
		try {
			const posts = await promises.readdir(`${this._workingDirectory}/forum/${category}/${thread}/`)
			const revs = new Map<string, string[]>()

			for (const post of posts) {
				const parsedNames = []

				for (const filename of await promises.readdir(`${this._workingDirectory}/forum/${category}/${thread}/${post}/`)) {
					if (filename.endsWith('.html')) {
						parsedNames.push(filename.substring(0, filename.length - 5))
					}
				}

				revs.set(post, parsedNames)
			}

			return [posts, revs]
		} catch(err) {
			return [[], new Map()]
		}
	}

	private async _threadListFetchedReplies(category: number, thread: number) {
		try {
			return await promises.readdir(`${this._workingDirectory}/forum/${category}/${thread}/`)
		} catch(err) {
			return []
		}
	}

	private async _threadListFetchedReplies7z(category: number, thread: number) {
		try {
			const list = await listZipFiles(`${this._workingDirectory}/forum/${category}/${thread}.7z`, {recursive: true})
			const build = []

			for (const piece of list) {
				if (piece.file != undefined) { // ???
					const indexOf = piece.file.indexOf('/')

					if (indexOf != -1 && piece.file.endsWith('.html')) {
						build.push(piece.file.substring(0, indexOf))
					}
				}
			}

			return build
		} catch(err) {
			return []
		}
	}

	private async _readPostsAndRevsLists7z(category: number, thread: number): Promise<[string[], Map<string, string[]>]> {
		try {
			const list = await listZipFiles(`${this._workingDirectory}/forum/${category}/${thread}.7z`, {recursive: true})
			const posts: string[] = []
			const revs = new Map<string, string[]>()
			const matcher = /^(\d+)\/(.+?)\.html$/

			for (const piece of list) {
				if (piece.file != undefined) { // ???
					const match = piece.file.match(matcher)

					if (match != null) {
						const [_, postId, revision] = match

						if (!posts.includes(postId)) {
							posts.push(postId)
						}

						let getList = revs.get(postId)

						if (getList === undefined) {
							getList = []
							revs.set(postId, getList)
						}

						getList.push(revision)
					}
				}
			}

			return [posts, new Map()]
		} catch(err) {
			return [[], new Map()]
		}
	}

	private async _revisionList7z(page: string) {
		try {
			const list = await listZipFiles(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}.7z`)
			const build = []

			for (const piece of list) {
				if (piece.file != undefined) { // ???
					build.push(piece.file)
				}
			}

			return build
		} catch(err) {
			return []
		}
	}

	private async _revisionListFiles(page: string) {
		try {
			return await promises.readdir(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}/`)
		} catch(err) {
			return []
		}
	}

	public revisionList(page: string): Promise<number[]> {
		return new Promise((resolve, reject) => {
			Promise.allSettled([this._revisionList7z(page), this._revisionListFiles(page)]).then(data => {
				const list = []

				for (const piece of data) {
					if (piece.status == 'fulfilled') {
						for (const name of piece.value) {
							list.push(parseInt(name.substring(0, name.length - 4)))
						}
					}
				}

				resolve(list)
			})
		})
	}

	public revisionListForumPost(category: number, thread: number, post: number): Promise<(string | number)[]> {
		return new Promise((resolve, reject) => {
			Promise.allSettled([this._postRevisionList7z(category, thread, post), this._postRevisionListFiles(category, thread, post)]).then(data => {
				const list = []

				for (const piece of data) {
					if (piece.status == 'fulfilled') {
						for (const name of piece.value) {
							const rname = name.substring(0, name.length - 5)

							if (rname != 'latest') {
								list.push(parseInt(rname))
							} else {
								list.push(rname)
							}
						}
					}
				}

				resolve(list)
			})
		})
	}

	public readPostsAndRevisionsOfThread(category: number, thread: number): Promise<[number[], Map<number, string[]>]> {
		return new Promise((resolve, reject) => {
			Promise.allSettled([this._readPostsAndRevsLists(category, thread), this._readPostsAndRevsLists7z(category, thread)]).then(data => {
				const posts: number[] = []
				const postsRevs = new Map<number, string[]>()

				for (const piece of data) {
					if (piece.status == 'fulfilled') {
						for (const postId of piece.value[0]) {
							const id = parseInt(postId)

							if (!isNaN(id) && !posts.includes(id)) {
								posts.push(id)
							}
						}

						for (const [key, value] of piece.value[1]) {
							const id = parseInt(key)

							if (!isNaN(id)) {
								if (postsRevs.has(id)) {
									postsRevs.get(id)!.push(...value)
								} else {
									postsRevs.set(id, value)
								}
							}
						}
					}
				}

				resolve([posts, postsRevs])
			})
		})
	}

	public forumFetchedThreadsList(category: number, thread: number): Promise<number[]> {
		return new Promise((resolve, reject) => {
			Promise.allSettled([this._threadListFetchedReplies(category, thread), this._threadListFetchedReplies7z(category, thread)]).then(data => {
				const list: number[] = []

				for (const piece of data) {
					if (piece.status == 'fulfilled') {
						for (const name of piece.value) {
							const parsed = parseInt(name)

							if (!isNaN(parsed) && !list.includes(parsed)) {
								list.push(parsed)
							}
						}
					}
				}

				resolve(list)
			})
		})
	}

	public async revisionExists(page: string, revision: number) {
		try {
			await promises.stat(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`)
			return true
		} catch(err) {
			return false
		}
	}

	private async compressRevisions(normalizedName: string) {
		const listing = await promises.readdir(`${this._workingDirectory}/pages/${normalizedName}/`)
		const txts = []
		let shouldBeEmpty = true

		for (const name of listing) {
			if (!name.endsWith('.txt')) {
				shouldBeEmpty = false
				continue
			}

			const num = parseInt(name.substring(0, name.length - 4))

			// not a number
			if (num != num) {
				shouldBeEmpty = false
				continue
			}

			const path = `${this._workingDirectory}/pages/${normalizedName}/${name}`
			const stat = await promises.stat(path)

			if (!stat.isFile()) {
				this.error(`${path} is not a file?`)
				shouldBeEmpty = false
				continue
			}

			txts.push(path)
		}

		if (txts.length != 0) {
			this.log(`Compressing revisions of ${normalizedName}`)

			let rethrow = false
			const zipPath = `${this._workingDirectory}/pages/${normalizedName}.7z`

			try {
				const stats = await promises.stat(zipPath)

				if (!stats.isFile()) {
					rethrow = true
					throw new Error(`${zipPath} is not a file!!!`)
				}

				if (stats.size == 0) {
					this.error(`${zipPath} is zero length!`)
					await promises.unlink(zipPath)
				}
			} catch(err) {
				if (rethrow) {
					throw err
				}
			}

			await addZipFiles(
				zipPath,
				// txts,
				// TODO: ENAMETOOLONG, if it is really needed (due to conditions above)
				// if there are many txt files.
				`${this._workingDirectory}/pages/${normalizedName}/*.txt`
			)

			for (const txt of txts) {
				await promises.unlink(txt)
			}
		}

		if (shouldBeEmpty) {
			await promises.rm(`${this._workingDirectory}/pages/${normalizedName}/`, {recursive: true, force: false})
		} else {
			this.log(`${this._workingDirectory}/pages/${normalizedName}/ is not empty, not removing it.`)
		}
	}

	private async compressForumThread(category: number | string, thread: number | string) {
		const listing = await promises.readdir(`${this._workingDirectory}/forum/${category}/${thread}`)

		for (const subdir of listing) {
			const path = `${this._workingDirectory}/forum/${category}/${thread}/${subdir}`
			const num = parseInt(subdir)

			if (num != num) {
				this.error(`${path} is not a number (does not appear to be forum post), not compressing thread ${thread}`)
				return
			}

			const stat = await promises.stat(path)

			if (!stat.isDirectory()) {
				this.error(`${path} is not a directory, not compressing thread ${thread}`)
				return
			}

			for (const subpath of await promises.readdir(path)) {
				const npath = `${path}/${subpath}`

				if (!subpath.endsWith('.html')) {
					this.error(`${npath} does not end with .html, not compressing thread ${thread}`)
					return
				}

				const naming = subpath.substring(0, subpath.length - 5)

				if (naming != 'latest') {
					const num = parseInt(subdir)

					if (num != num) {
						this.error(`${npath} is not a number (does not appear to be forum post revision), not compressing thread ${thread}`)
						return
					}
				}

				const stat = await promises.stat(npath)

				if (!stat.isFile()) {
					this.error(`${npath} is not a file, not compressing thread ${thread}`)
					return
				}
			}
		}

		this.log(`Compressing forum thread ${thread} in category ${category}`)

		let rethrow = false
		const zipPath = `${this._workingDirectory}/forum/${category}/${thread}.7z`

		try {
			const stats = await promises.stat(zipPath)

			if (!stats.isFile()) {
				rethrow = true
				throw new Error(`${zipPath} is not a file!!!`)
			}

			if (stats.size == 0) {
				this.error(`${zipPath} is zero length!`)
				await promises.unlink(zipPath)
			}
		} catch(err) {
			if (rethrow) {
				throw err
			}
		}

		await addZipFiles(
			zipPath,
			`${this._workingDirectory}/forum/${category}/${thread}/*.*`,

			{
				recursive: true
			}
		)

		await promises.rm(`${this._workingDirectory}/forum/${category}/${thread}`, {recursive: true, force: false})
	}

	public async writeRevision(page: string, revision: number, body: string) {
		await promises.mkdir(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}`, {recursive: true})
		await promises.writeFile(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`, body)
	}

	public async readPageMetadata(page: string) {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as PageMeta
		} catch(err) {
			return null
		}
	}

	public async pageMetadataExists(page: string) {
		try {
			return (await promises.stat(`${this._workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`)).isFile()
		} catch(err) {
			return false
		}
	}

	public async markPageRemoved(page: string) {
		try {
			await promises.unlink(`${this._workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`)
		} catch(err) {
			this.error(String(err))
		}

		try {
			await promises.unlink(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}.7z`)
		} catch(err) {
			this.error(String(err))
		}

		try {
			await promises.rm(`${this._workingDirectory}/pages/${WikiDot.normalizeName(page)}`, {recursive: true})
		} catch(err) {
			this.error(String(err))
		}

		try {
			await promises.rm(`${this._workingDirectory}/files/${WikiDot.normalizeName(page)}`, {recursive: true})
		} catch(err) {
			this.error(String(err))
		}
	}

	public async writePageMetadata(page: string, meta: PageMeta) {
		await promises.mkdir(`${this._workingDirectory}/meta/pages`, {recursive: true})
		await promises.writeFile(`${this._workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`, JSON.stringify(meta, null, 4))
	}

	public async loadFileMeta(path: string) {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/files/${path}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as FileMeta
		} catch(err) {
			return null
		}
	}

	public async writeSiteMap(map: [string, Date | null][]) {
		await promises.mkdir(`${this._workingDirectory}/meta`, {recursive: true})

		const rebuild: any = {}

		for (const [a, b] of map) {
			if (b == null) {
				rebuild[a] = b
			} else {
				rebuild[a] = b.getTime()
			}
		}

		await promises.writeFile(`${this._workingDirectory}/meta/sitemap.json`, JSON.stringify(rebuild, null, 4))
	}

	public async readSiteMap() {
		try {
			const read = await promises.readFile(`${this._workingDirectory}/meta/sitemap.json`, {encoding: 'utf-8'})
			const json: any = JSON.parse(read)

			const remapped = new Map<string, number | null>()

			for (const a in json) {
				remapped.set(a, json[a])
			}

			return remapped
		} catch(err) {
			return null
		}
	}
}
