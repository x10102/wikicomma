
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
import { HTTPClient, RequestConfig } from './HTTPClient'
import { parse, HTMLElement, TextNode } from 'node-html-parser'
import { promises, read } from 'fs'
import { promisify } from 'util'
import { unescape } from 'html-escaper'
import Seven, { list } from 'node-7z'
import { addZipFiles, listZipFiles } from "./7z-helper"
import { OutgoingHttpHeaders } from "http2"

const sleep = promisify(setTimeout)

type User = number | string | null

interface RecentChange {
	name: string
	revision?: number
	author: User
}

interface PageRevision {
	revision: number
	global_revision: number
	author: User
	stamp?: number
	flags?: string
	commentary?: string
}

function findMostRevision(list: PageRevision[]) {
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

interface PageMeta {
	name: string
	page_id: number
	rating?: number
	version?: number
	forum_thread?: number
	revisions: PageRevision[]
	tags?: string[]
	title?: string
	votings?: [User, boolean][]
	sitemap_update?: number
	files: FileMeta[]
}

interface GenericPageData {
	page_id?: number
	page_name?: string
	rating?: number
	forum_thread?: number
	tags?: string[]
}

interface FileMeta {
	file_id: number
	name: string
	url: string
	size: string
	size_bytes: number
	mime: string
	content: string
	author: User
	stamp: number
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
]

function reencodeComponent(str: string) {
	str = decodeURIComponent(str)

	for (const [a, b] of reencoding_table) {
		str = str.replace(a, b as string)
	}

	return str
}

export {reencodeComponent}

function pushToSet<T>(set: T[], value: T) {
	if (!set.includes(value)) {
		set.push(value)
		return true
	}

	return false
}

function removeFromSet<T>(set: T[], value: T) {
	const indexOf = set.indexOf(value)

	if (indexOf != -1) {
		set.splice(indexOf, 1)
	}

	return indexOf != -1
}

function flipArray<T>(input: T[]): T[] {
	let i = 0
	let j = input.length - 1

	while (i < j) {
		const value = input[j]
		input[j] = input[i]
		input[i] = value
		i++
		j--
	}

	return input
}

interface ForumCategory {
	title: string
	description: string
	id: number
	last?: number
	posts: number
	threads: number
	lastUser: User
}

interface LocalForumCategory extends ForumCategory {
	full_scan: boolean
	last_page: number
}

interface ForumRevisionBody {
	title: string
	content: string
}

interface HeadlessForumPost {
	id: number
	poster: User
	stamp: number
	lastEdit?: number
	lastEditBy?: User
}

interface ForumPost extends ForumRevisionBody, HeadlessForumPost {
	children: ForumPost[]
}

interface LocalForumPost extends HeadlessForumPost {
	revisions: LocalPostRevision[]
	children: LocalForumPost[]
}

interface PostRevision {
	author: User
	stamp: number
	id: number
}

interface LocalPostRevision extends PostRevision {
	title: string
}

interface ForumThread {
	title: string
	id: number
	description: string
	last?: number
	lastUser?: User
	started: number
	startedUser: User
	postsNum: number
	sticky: boolean
}

interface LocalForumThread extends ForumThread {
	posts: LocalForumPost[]
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

export class WikiDot {
	public static normalizeName(name: string): string {
		return name.replace(/:/g, '_')
	}

	private static usernameMatcher = /user:info\/(.*)/

	private static extractUser(elem: HTMLElement | null): User {
		if (elem == null) {
			return null
		}

		const regMatch = elem.querySelector('a')?.attributes['href'].match(WikiDot.usernameMatcher)
		let user: string | number | undefined = regMatch ? regMatch[1] : undefined

		if (user === undefined) {
			user = elem.querySelector('span.deleted')?.attributes['data-id']

			if (user) {
				user = parseInt(user)
			}
		}

		// in case we got passed the root element of user span
		if (user === undefined) {
			user = elem.attributes['data-id']

			if (user) {
				user = parseInt(user)
			}
		}

		if (user === undefined) {
			return null
		}

		return user
	}

	// spoon library
	private static urlMatcher = /(((http|ftp|https):\/{2})+(([0-9a-z_-]+\.)+(aero|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|tel|travel|ac|ad|ae|af|ag|ai|al|am|an|ao|aq|ar|as|at|au|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cx|cy|cz|cz|de|dj|dk|dm|do|dz|ec|ee|eg|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mn|mn|mo|mp|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|nom|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ra|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sj|sk|sl|sm|sn|so|sr|st|su|sv|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tp|tr|tt|tv|tw|tz|ua|ug|uk|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|yu|za|zm|zw|arpa)(:[0-9]+)?((\/([~0-9a-zA-Z\#\+\%@\.\/_-]+))?(\?[0-9a-zA-Z\+\%@\/&\[\];=_-]+)?)?))\b/ig
	public static defaultPagenation = 100

	private pendingFiles: DiskMeta<number[]> = new DiskMeta([], `${this.workingDirectory}/meta/pending_files.json`)
	private pendingPages: DiskMeta<string[]> = new DiskMeta([], `${this.workingDirectory}/meta/pending_pages.json`)
	private fileMap: DiskMeta<FileMap> = new DiskMeta({}, `${this.workingDirectory}/meta/file_map.json`)
	private pageIdMap: DiskMeta<PageIdMap> = new DiskMeta({}, `${this.workingDirectory}/meta/page_id_map.json`)
	private pendingRevisions: DiskMeta<PendingRevisions> = new DiskMeta({}, `${this.workingDirectory}/meta/pending_revisions.json`)

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
		try {
			const read = await promises.readFile(`${this.workingDirectory}/http_cookies.json`, {encoding: 'utf-8'})
			const json = JSON.parse(read)
			this.client.cookies.load(json)
		} catch(err) {

		}
	}

	private async saveCookies() {
		await promises.mkdir(this.workingDirectory, {recursive: true})
		const json = this.client.cookies.save()
		await promises.writeFile(`${this.workingDirectory}/http_cookies.json`, JSON.stringify(json, null, 4))
	}

	private initialize() {
		return Promise.allSettled([
			this.loadCookies(),
			this.pendingFiles.initialize(),
			this.pendingPages.initialize(),
			this.fileMap.initialize(),
			this.pendingRevisions.initialize(),
			this.pageIdMap.initialize(),
		])
	}

	private ajaxURL: URL

	constructor(
		private name: string,
		private url: string = `https://${name}.wikidot.com`,
		private workingDirectory: string = `./storage/${name}`,
		public client = new HTTPClient(),
		handleCookies = true
	) {
		this.ajaxURL = new URL(`${this.url}/ajax-module-connector.php`)
		this.startMetaSyncTimer()

		if (handleCookies) {
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

	private fetchingToken = false

	private log(str: string) {
		process.stdout.write(`[${this.name}]: ${str}\n`)
	}

	private error(str: string) {
		process.stderr.write(`[${this.name}]: ${str}\n`)
	}

	public async fetchToken() {
		if (this.fetchingToken) {
			return
		}

		await this.initialize()

		this.fetchingToken = true

		if (this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value != undefined) {
			return
		}

		await this.client.get(`${this.url}/system:recent-changes`, {followRedirects: false})
		await this.saveCookies()
	}

	private async fetch(options: any, headers?: OutgoingHttpHeaders) {
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

	private async fetchJson(options: any, custom = false, headers?: OutgoingHttpHeaders) {
		const json = JSON.parse((await this.fetch(options, headers)).toString('utf-8'))

		if (!custom && json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

		return json
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
			const revisionText = elem.querySelector('td.revision-no')?.innerText
			const revision = revisionText?.match(/([0-9]+)/)
			const mod_by = WikiDot.extractUser(elem.querySelector('td.mod-by'))

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

	private static dateMatcher = /time_([0-9]+)/

	public async fetchPageChangeListForce(page_id: number, page = 1, perPage = WikiDot.defaultPagenation) {
		while (true) {
			try {
				return await this.fetchPageChangeList(page_id, page, perPage)
			} catch(err) {
				this.error(`Encountered ${err} when fetching changes of ${page_id} offset ${page}, sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
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

			const revision = values[0].innerText.match(/([0-9]+)/)

			if (revision == null) {
				continue
			}

			// 1 - buttons
			const flags = values[2].innerText.trim()
			const global_revision = values[3].querySelector('a')?.attrs['onclick']?.match(/([0-9]+)/)

			if (global_revision == null) {
				continue
			}

			const author = WikiDot.extractUser(values[4] as HTMLElement)
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

	public async fetchPageChangeListAllForce(page_id: number) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)
			const data = await this.fetchPageChangeListForce(page_id, ++page)
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

	public async fetchPageChangeListAllUntilForce(page_id: number, revision: number) {
		const listing: PageRevision[] = []
		let page = 0

		while (true) {
			this.log(`Fetching changeset offset ${page} of ${page_id}`)
			const data = await this.fetchPageChangeListForce(page_id, ++page)
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
			const matchAgainstPage = elem.innerText.match(/WIKIREQUEST\.info\.pageId\s*=\s*([0-9]+);/i)

			if (matchAgainstPage != null) {
				meta.page_id = parseInt(matchAgainstPage[1])
			}
		}

		const ratingElem = html.querySelector('span.rate-points')?.querySelector('span.number')?.innerText

		if (ratingElem != undefined) {
			meta.rating = parseInt(ratingElem)
		}

		const discussElem = html.querySelector('div#discuss-button')?.attributes['href']

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

		return meta
	}

	public async fetchPageVoters(page_id: number) {
		const json = await this.fetchJson({
			"pageId": page_id,
			"moduleName": "pagerate/WhoRatedPageModule",
		})

		const html = parse(json.body)

		let lastUser: User | undefined = undefined
		let lastRating: boolean | undefined = undefined
		let row = 0
		const listing: [User, boolean][] = []

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
						lastUser = WikiDot.extractUser(elem)
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

	public async fetchRevision(revision_id: number) {
		const json = await this.fetchJson({
			"revision_id": revision_id,
			"moduleName": "history/PageSourceModule",
		})

		const html = parse(json.body)
		const div = html.querySelector('div.page-source')

		return div != undefined ? div.textContent : ''
	}

	private static categoryRegExp = /forum\/c-([0-9]+)/

	public async fetchForumCategories() {
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

				const threadsNum = parseInt(threads.innerText.trim())
				const postsNum = parseInt(posts.innerText.trim())

				const lastDateElemMatch = last.querySelector('span.odate')?.attributes['class'].match(WikiDot.dateMatcher)
				const lastDate = lastDateElemMatch != undefined && lastDateElemMatch != null ? parseInt(lastDateElemMatch[1]) : undefined
				const lastUser = WikiDot.extractUser(last)

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

	private static threadRegExp = /forum\/t-([0-9]+)/

	public async fetchThreads(category: number, page = 1) {
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
			const sticky = (title.firstChild instanceof TextNode) ? title.firstChild.innerText.trim() != '' : false

			const description = name.querySelector('div.description')!.textContent.trim()
			const postsNum = parseInt(posts.innerText.trim())
			const lastDate = last.childNodes.length > 1 ? parseInt(last.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1]) : undefined
			const lastUser = last.childNodes.length > 1 ? WikiDot.extractUser(last) : undefined
			const startedDate = parseInt(started.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
			const startedUser = WikiDot.extractUser(started)

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

	private static postRegExp = /post-([0-9]+)/

	private static parsePost(postContainer: HTMLElement): ForumPost {
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
				poster: 'ERROR',
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
				poster: 'ERROR',
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
				poster: 'ERROR',
				content: 'ERROR',
				stamp: -1,
				children: []
			}
		}

		const poster = WikiDot.extractUser(info)
		const stamp = parseInt(info.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])

		const contentHtml = content.innerHTML

		const obj: ForumPost = {
			id: postId,
			title: title.innerText.trim(),
			poster: poster,
			content: contentHtml,
			stamp: stamp,
			children: []
		}

		const changes = post.querySelector('div.changes')

		if (changes != null) {
			const stamp = parseInt(changes.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
			const poster = WikiDot.extractUser(changes)

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
			listing.push(WikiDot.parsePost(container))
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
			const author = WikiDot.extractUser(columns[0])
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
	}

	// high-level api
	private downloadingFiles = new Map<string, boolean>()
	private static localFileMatch = /\/local--files\/(.+)/i

	private static splitFilePath(path: string): [string[], string, string] {
		const split = path.split('/')

		for (const key in split) {
			split[key] = reencodeComponent(split[key])
		}

		if (split.length == 1) {
			split.unshift('~')
		}

		const last = split.splice(split.length - 1)[0]

		return [split, last, `${split.join('/')}/${last}`]
	}

	private static splitFilePathRaw(url: string): [string, string[], string, string] | null {
		const match = url.match(this.localFileMatch)

		if (match == null) {
			return null
		}

		const [split, last, recombined] = this.splitFilePath(match[1])
		return [match[1], split, last, recombined]
	}

	private writeToFileMap(fileMeta: FileMeta, split: string[], last: string) {
		this.fileMap.data[fileMeta.file_id] = {
			url: fileMeta.url,
			path: `${split.join('/')}/${last}`
		}

		this.fileMap.markDirty()
	}

	public async fileExists(recombined: string) {
		try {
			await promises.stat(`${this.workingDirectory}/files/${recombined}`)
			return true
		} catch(err) {

		}

		return false
	}

	private async fetchFileInner(fileMeta: {url: string, file_id: number}, split: string[], recombined: string, config?: RequestConfig) {
		this.log(`Fetching file ${fileMeta.url}`)

		await this.client.get(fileMeta.url, config).then(async buffer => {
			await promises.mkdir(`${this.workingDirectory}/files/${split.join('/')}`, {recursive: true})
			await promises.writeFile(`${this.workingDirectory}/files/${recombined}`, buffer)
			this.removePendingFiles(fileMeta.file_id)
		}).catch(err => {
			this.log(`Unable to fetch ${fileMeta.url} because ${err}`)
			this.pushPendingFiles(fileMeta.file_id)
		})
	}

	public async fetchFilesFor(page_id: number) {
		await this.initialize()
		const metadata = []

		for (const fileMeta of await this.fetchFileMetaListForce(page_id)) {
			const match = WikiDot.splitFilePathRaw(fileMeta.url)

			if (match != null) {
				const [matched, split, last, recombined] = match
				metadata.push(fileMeta)

				if (this.downloadingFiles.has(matched)) {
					continue
				}

				this.downloadingFiles.set(matched, true)
				this.writeToFileMap(fileMeta, split, last)

				if (await this.fileExists(recombined)) {
					continue
				}

				this.fetchFileInner(fileMeta, split, recombined, {
					headers: {
						'Referer': this.url
					}
				})
			}
		}

		return metadata
	}

	public async fetchFilesFrom(body: string, page_id?: number) {
		const urls = body.match(WikiDot.urlMatcher)

		if (urls == null) {
			return false
		}

		for (const url of urls) {
			const match = url.match(WikiDot.localFileMatch)

			if (match != null) {
				if (this.downloadingFiles.has(match[1])) {
					continue
				}

				this.downloadingFiles.set(match[1], true)

				const split = match[1].split('/')
				const last = split.splice(split.length - 1)[0]

				try {
					await promises.stat(`${this.workingDirectory}/files/${split.join('/')}/${last}`)
					break
				} catch(err) {

				}

				this.log(`Fetching file ${url}`)

				this.client.get(url).then(async buffer => {
					await promises.mkdir(`${this.workingDirectory}/files/${split.join('/')}`, {recursive: true})
					await promises.writeFile(`${this.workingDirectory}/files/${split.join('/')}/${last.replace(/\?/g, '@')}`, buffer)
				}).catch(err => {
					this.log(`Unable to fetch ${url} because ${err}`)
				})
			}
		}

		return true
	}

	private static fileSizeMatcher = /([0-9]+) bytes/i

	public async fetchFileMeta(file_id: number) {
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

		const name = rows[0].querySelectorAll('td')[1]
		const fullURL = rows[1].querySelectorAll('td')[1]
		const size = rows[2].querySelectorAll('td')[1]
		const mime = rows[3].querySelectorAll('td')[1]
		const contentType = rows[4].querySelectorAll('td')[1]
		const uploader = rows[5].querySelectorAll('td')[1]
		const date = rows[6].querySelectorAll('td')[1]

		const matchAuthor = WikiDot.extractUser(uploader)

		return {
			file_id: file_id,
			name: name.innerText.trim(),
			url: fullURL.querySelector('a')?.attrs['href']!,
			size: size.innerText.trim(),
			size_bytes: parseInt(size.innerText.match(WikiDot.fileSizeMatcher)![1]),
			mime: mime.innerText.trim(),
			content: contentType.innerText.trim(),
			author: matchAuthor,
			stamp: parseInt(date.querySelector('span.odate')?.attrs['class'].match(WikiDot.dateMatcher)![1]!)
		}
	}

	public async fetchFileMetaForce(file_id: number) {
		while (true) {
			try {
				return await this.fetchFileMeta(file_id)
			} catch(err) {
				this.error(`Encountered ${err} when fetching file meta, sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
	}

	private static fileIdMatcher = /file-row-([0-9]+)/i

	public async fetchFileList(page_id: number) {
		const json = await this.fetchJson({
			"page_id": page_id,
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
		while (true) {
			try {
				return await this.fetchFileList(page_id)
			} catch(err) {
				this.error(`Encountered ${err} when fetching file list, sleeping for 5 seconds`)
				await sleep(5_000)
			}
		}
	}

	public async fetchFileMetaList(page_id: number) {
		const list = []

		for (const file_id of await this.fetchFileList(page_id)) {
			list.push(this.fetchFileMeta(file_id))
		}

		return await Promise.all(list)
	}

	public async fetchFileMetaListForce(page_id: number) {
		const list = []

		for (const file_id of await this.fetchFileListForce(page_id)) {
			list.push(this.fetchFileMetaForce(file_id))
		}

		return await Promise.all(list)
	}

	public async workLoop() {
		await this.initialize()

		{
			let mapNeedsRebuild = true

			try {
				mapNeedsRebuild = (await promises.stat(`${this.workingDirectory}/meta/pages`)).isDirectory()
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

				for (const name of await promises.readdir(`${this.workingDirectory}/meta/pages/`)) {
					if (name.endsWith('.json')) {
						tasks.push(async () => {
							const metadata: PageMeta = JSON.parse(await promises.readFile(`${this.workingDirectory}/meta/pages/${name}`, {encoding: 'utf-8'}))

							if (metadata != null) {
								this.pageIdMap.data[metadata.page_id] = metadata.name
								this.pageIdMap.markDirty()
							} else {
								this.error(`${this.workingDirectory}/meta/pages/${name} is malformed!`)
							}
						})
					}
				}

				const worker = async () => {
					while (tasks.length != 0) {
						await tasks.pop()()
					}
				}

				await Promise.all([
					worker(),
					worker(),
					worker(),
				])
			}
		}

		this.log(`Fetching sitemap`)
		const sitemapPages: [string, Date | null][] = []

		const fetchSiteMap = async (url: string) => {
			const sitemap = (await this.client.get(url)).toString('utf-8')
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
						loc = 'main'
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

		await fetchSiteMap(`${this.url}/sitemap.xml`)

		this.log(`Counting total ${sitemapPages.length} pages`)

		const oldMap = await this.loadSiteMap()

		if (oldMap == null) {
			this.log(`No previous sitemap was found, doing full scan`)
		} else {
			this.log(`Previous sitemap contains ${oldMap.size} pages`)
		}

		const tasks: any[] = []

		for (const [pageName, pageUpdate] of sitemapPages) {
			tasks.push(async () => {
				if (oldMap != null) {
					const oldStamp = oldMap.get(pageName)

					if (oldStamp === pageUpdate || pageUpdate != null && oldStamp === pageUpdate.getTime()) {
						if (await this.pageMetadataExists(pageName)) {
							// consider it fetched, since sitemap is written to disk only when everything got saved
							return
						}
					}
				}

				let metadata = await this.loadPageMetadata(pageName)

				if (
					metadata == null ||
					pageUpdate == null || // always check
					metadata.sitemap_update != pageUpdate.getTime() ||
					metadata.page_id == undefined ||
					metadata.version == undefined ||
					metadata.version < 9
				) {
					//this.log(`Need to renew ${pageName} (updated ${pageUpdate == null ? 'always invalid' : pageUpdate} vs ${metadata == null || metadata.sitemap_update == undefined ? 'never' : new Date(metadata.sitemap_update)})`)
					this.log(`Need to renew ${pageName}`)

					let pageMeta: GenericPageData

					try {
						pageMeta = await this.fetchGeneric(pageName)
					} catch(err) {
						this.log(`Encountered ${err}, postproning page ${pageName} for late fetch`)
						this.pushPendingPages(pageName)
						return
					}

					if (pageMeta.page_id != undefined) {
						let newMeta: PageMeta

						if (metadata == null || metadata.page_id != -1 && metadata.page_id != pageMeta.page_id) {
							newMeta = {
								name: pageName,
								version: 9,
								revisions: [],
								files: [],
								page_id: pageMeta.page_id,
							}

							if (metadata != null) {
								this.log(`Page ${pageName} got replaced`)
								await this.markPageReplaced(pageName)
								delete this.pageIdMap.data[metadata.page_id]
								this.pageIdMap.markDirty()
							}
						} else {
							newMeta = {
								name: pageName,
								version: 9,
								revisions: metadata.revisions,
								files: metadata.files != undefined ? metadata.files : [],
								page_id: metadata.page_id,
								votings: metadata.votings,
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
								this.error(`Encoutnered error fetching ${pageName} voters: ${err}`)
							}
						}

						for (let i0 = 0; i0 < 3; i0++) {
							try {
								newMeta.files = await this.fetchFilesFor(pageMeta.page_id)
								break
							} catch(err) {
								this.error(`Encoutnered error fetching ${pageName} voters: ${err}`)
							}
						}

						const lastRevision = findMostRevision(newMeta.revisions)
						const changes = lastRevision == null ? await this.fetchPageChangeListAllForce(pageMeta.page_id) : await this.fetchPageChangeListAllUntilForce(pageMeta.page_id, lastRevision)

						for (const localChange of changes) {
							newMeta.revisions.push(localChange)
						}

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

				const changes = revisionsToFetch.length != 0
				flipArray(revisionsToFetch)

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

								if (rev.global_revision in this.pendingRevisions.data) {
									delete this.pendingRevisions.data[rev.global_revision]
									this.pendingRevisions.markDirty()
								}

								break
							} catch(err) {
								this.error(`Encountered ${err}, postproning revision ${rev.global_revision} of ${pageName} for later fetch`)
								this.pendingRevisions.data[rev.global_revision] = metadata!.page_id
								this.pendingRevisions.markDirty()
							}
						}
					}
				}

				await Promise.allSettled([
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
				])

				this.removePendingPages(pageName)
				await this.writePageMetadata(pageName, metadata)

				if (changes) {
					await this.compressRevisions(WikiDot.normalizeName(pageName))
				}
			})
		}

		const worker = async () => {
			while (tasks.length != 0) {
				try {
					await tasks.pop()()
				} catch(err) {
					this.error(`Task failed: ${err}`)
				}
			}
		}

		await Promise.allSettled([
			worker(),
			worker(),
			worker(),
			worker(),
			worker(),
			worker(),
			worker(),
			worker(),
		])

		await this.writeSiteMap(sitemapPages)

		this.log(`Fetching forums list`)
		const forums = await this.fetchForumCategories()

		for (const forum of forums) {
			const localForum = await this.loadForumCategory(forum.id)

			if (localForum != null && localForum.last == forum.last && localForum.full_scan) {
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
						const localThread = await this.loadForumThread(forum.id, thread.id)

						let shouldFetch = localThread == null || localThread.last != thread.last

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
								this.error(`Post amount mismatch of ${thread.id} (expected ${thread.postsNum}, got ${count})`)
							}
						}

						// TODO: IF we have meta, and it says that we fetched entire thread
						// and it hasn't changed... is this really the case?
						// about post edits, are they reflected anywhere???
						if (shouldFetch) {
							// thread metadata is outdated
							updated = true
							this.log(`Fetching thread meta of ${thread.title} (${thread.id})`)

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
								//posts: localThread != null ? localThread.posts : []
								posts: []
							}

							const posts = await this.fetchAllThreadPosts(thread.id)
							let fetchOnce = false

							const workWithPost = async (post: ForumPost) => {
								fetchOnce = true
								await this.writePostRevision(forum.id, thread.id, post.id, 'latest', post.content)

								const localPost: LocalForumPost = {
									id: post.id,
									poster: post.poster,
									stamp: post.stamp,
									lastEdit: post.lastEdit,
									lastEditBy: post.lastEditBy,
									revisions: [],
									children: []
								}

								if (post.lastEdit != undefined) {
									this.log(`Fetching revision list of post ${post.id}`)
									const revisionList = await this.fetchPostRevisionList(post.id)

									const revWorker = []

									for (const revision of revisionList) {
										revWorker.push((async () => {
											this.log(`Fetching revision ${revision.id} of post ${post.id}`)
											const revContent = await this.fetchPostRevision(revision.id)
											await this.writePostRevision(forum.id, thread.id, post.id, revision.id, revContent.content)

											localPost.revisions.push({
												title: revContent.title,
												author: revision.author,
												id: revision.id,
												stamp: revision.stamp
											})
										})())
									}

									await Promise.all(revWorker)
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
								this.error(`Encountered ${err}, sleeping for 5 seconds`)
								await sleep(5_000)
							}
						}
					}
				}

				await Promise.all([doWork(), doWork(), doWork()])

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
						last_page: 0
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
						last_page: page
					})
				}
			}
		}

		this.log(`Fetched all forums!`)

		// if we didn't finish full scan then we would have to do relatively full scan of all forum categories
		// but if we managed to reach the end, then we gonna have fast index!
		//await this.writeForumMeta(forums)

		if (this.pendingFiles.data.length != 0) {
			this.log(`Fetching pending files`)

			for (let i = this.pendingFiles.data.length - 1; i >= 0; i--) {
				const id = this.pendingFiles.data[i]
				let mapped = this.fileMap.data[id]

				if (mapped == undefined) {
					this.log(`Re-fetching file meta of ${id}`)
					const fetchedMeta = await this.fetchFileMeta(id)
					const match = WikiDot.splitFilePathRaw(fetchedMeta.url)

					if (match != null) {
						const [matched, split, last] = match
						this.writeToFileMap(fetchedMeta, split, last)
						mapped = this.fileMap.data[id]
					}
				}

				if (mapped == undefined) {
					this.log(`Failed to map file meta ${id}`)
					continue
				}

				const match = WikiDot.splitFilePathRaw(mapped.url)

				if (match != null) {
					const [matched, split, last, recombined] = match

					if (await this.fileExists(recombined)) {
						continue
					}

					this.fetchFileInner({url: mapped.url, file_id: id}, split, recombined, {
						headers: {
							'Cache-Control': 'no-cache',
							'Referer': this.url,
							'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:100.0) Gecko/20100101 Firefox/100.0'
						}
					})
				}
			}
		}

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
							const metadata = await this.loadPageMetadata(page_name)

							if (metadata != null) {
								if (metadata.page_id != num) {
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
						this.error(`Unable to find page metadata for ${page_id}!!!`)
					}
				}

				const tasks: any[] = []

				for (const [global_revision, page_id] of copy) {
					tasks.push(async () => {
						const pageMeta = mapping.get(page_id)

						if (pageMeta == undefined) {
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
							this.error(`Unknown revision with id ${global_revision} inside ${pageMeta.name} (${[pageMeta.page_id]}) when resolving pending revision! Considering revision unresolvable.`)
							delete this.pendingRevisions.data[global_revision]
							this.pendingRevisions.markDirty()
							return
						}

						try {
							this.log(`Fetching revision ${rev.revision} (${rev.global_revision}) of ${pageMeta.name}`)
							const body = await this.fetchRevision(rev.global_revision)
							await this.writeRevision(pageMeta.name, rev.revision, body)
							delete this.pendingRevisions.data[rev.global_revision]
							this.pendingRevisions.markDirty()
						} catch(err) {
							this.error(`Encountered ${err}, postproning revision ${rev.global_revision} of ${pageMeta.name} for later fetch (AGAIN)`)
						}
					})
				}

				const worker = async () => {
					while (tasks.length != 0) {
						await tasks.pop()()
					}
				}

				await Promise.all([
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
					worker(),
				])

				this.log(`Fetched all pending revisions!`)
			}
		}

		this.log(`Compressing page revisions`)

		for (const name of await promises.readdir(`${this.workingDirectory}/pages/`)) {
			// hidden/system files start with dot
			if (!name.startsWith('.') && (await promises.stat(`${this.workingDirectory}/pages/${name}`)).isDirectory()) {
				await this.compressRevisions(name)
			}
		}

		if (forums.length != 0) {
			this.log(`Compressing forum threads`)

			for (const category of await promises.readdir(`${this.workingDirectory}/forum/`)) {
				if (!category.startsWith('.') && (await promises.stat(`${this.workingDirectory}/forum/${category}`)).isDirectory()) {
					for (const thread of await promises.readdir(`${this.workingDirectory}/forum/${category}`)) {
						if (!thread.startsWith('.') && !thread.endsWith('.7z') && (await promises.stat(`${this.workingDirectory}/forum/${category}/${thread}`)).isDirectory()) {
							await this.compressForumThread(category, thread)
						}
					}
				}
			}
		}
	}

	// local I/O
	public async loadForumCategory(category: number) {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/forum/category/${category}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumCategory
		} catch(err) {
			return null
		}
	}

	public async writeForumCategory(value: LocalForumCategory) {
		await promises.mkdir(`${this.workingDirectory}/meta/forum/category`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/meta/forum/category/${value.id}.json`, JSON.stringify(value, null, 4))
	}

	public async loadForumThread(category: number, thread: number) {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/forum/${category}/${thread}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumThread
		} catch(err) {
			return null
		}
	}

	public async writeForumThread(category: number, thread: number, value: LocalForumThread) {
		await promises.mkdir(`${this.workingDirectory}/meta/forum/${category}`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/meta/forum/${category}/${thread}.json`, JSON.stringify(value, null, 4))
	}

	public async loadForumPost(post: number) {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/forum/post/${post}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as LocalForumPost
		} catch(err) {
			return null
		}
	}

	public async writeForumPost(post: number, value: LocalForumPost) {
		await promises.mkdir(`${this.workingDirectory}/meta/forum/post`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/meta/forum/post/${post}.json`, JSON.stringify(value, null, 4))
	}

	public async writePostRevision(category: number, thread: number, post: number, revision: 'latest' | number, value: string) {
		await promises.mkdir(`${this.workingDirectory}/forum/${category}/${thread}/${post}/`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/forum/${category}/${thread}/${post}/${revision}.html`, value)
	}

	private async _revisionList7z(page: string) {
		try {
			const list = await listZipFiles(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}.7z`)
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
			return await promises.readdir(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}/`)
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

	public async revisionExists(page: string, revision: number) {
		try {
			await promises.stat(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`)
			return true
		} catch(err) {
			return false
		}
	}

	private async compressRevisions(normalizedName: string) {
		const listing = await promises.readdir(`${this.workingDirectory}/pages/${normalizedName}/`)
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

			const path = `${this.workingDirectory}/pages/${normalizedName}/${name}`
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

			await addZipFiles(
				`${this.workingDirectory}/pages/${normalizedName}.7z`,
				// txts,
				// TODO: ENAMETOOLONG, if it is really needed (due to conditions above)
				// if there are many txt files.
				`${this.workingDirectory}/pages/${normalizedName}/*.txt`
			)

			for (const txt of txts) {
				await promises.unlink(txt)
			}
		}

		if (shouldBeEmpty) {
			await promises.rm(`${this.workingDirectory}/pages/${normalizedName}/`, {recursive: true, force: false})
		} else {
			this.log(`${this.workingDirectory}/pages/${normalizedName}/ is not empty, not removing it.`)
		}
	}

	private async compressForumThread(category: number | string, thread: number | string) {
		const listing = await promises.readdir(`${this.workingDirectory}/forum/${category}/${thread}`)

		for (const subdir of listing) {
			const path = `${this.workingDirectory}/forum/${category}/${thread}/${subdir}`
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

		await addZipFiles(
			`${this.workingDirectory}/forum/${category}/${thread}.7z`,
			`${this.workingDirectory}/forum/${category}/${thread}/*.*`,

			{
				recursive: true
			}
		)

		await promises.rm(`${this.workingDirectory}/forum/${category}/${thread}`, {recursive: true, force: false})
	}

	public async writeRevision(page: string, revision: number, body: string) {
		await promises.mkdir(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`, body)
	}

	public async loadPageMetadata(page: string) {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as PageMeta
		} catch(err) {
			return null
		}
	}

	public async pageMetadataExists(page: string) {
		try {
			return (await promises.stat(`${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`)).isFile()
		} catch(err) {
			return false
		}
	}

	public async markPageReplaced(page: string) {
		try {
			// await promises.rename(`${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`, `${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.${Date.now()}.json`)
			await promises.unlink(`${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`)
		} catch(err) {
			this.error(String(err))
		}

		try {
			// await promises.rename(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}.7z`, `${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}.${Date.now()}.7z`)
			await promises.unlink(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}.7z`)
		} catch(err) {
			this.error(String(err))
		}

		try {
			// await promises.rename(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}`, `${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}.${Date.now()}`)
			await promises.rm(`${this.workingDirectory}/pages/${WikiDot.normalizeName(page)}`, {recursive: true})
		} catch(err) {
			// this.error(String(err))
		}
	}

	public async writePageMetadata(page: string, meta: PageMeta) {
		await promises.mkdir(`${this.workingDirectory}/meta/pages`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/meta/pages/${WikiDot.normalizeName(page)}.json`, JSON.stringify(meta, null, 4))
	}

	public async loadFileMeta(path: string) {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/files/${path}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as FileMeta
		} catch(err) {
			return null
		}
	}

	public async writeSiteMap(map: [string, Date | null][]) {
		await promises.mkdir(`${this.workingDirectory}/meta`, {recursive: true})

		const rebuild: any = {}

		for (const [a, b] of map) {
			if (b == null) {
				rebuild[a] = b
			} else {
				rebuild[a] = b.getTime()
			}
		}

		await promises.writeFile(`${this.workingDirectory}/meta/sitemap.json`, JSON.stringify(rebuild, null, 4))
	}

	public async loadSiteMap() {
		try {
			const read = await promises.readFile(`${this.workingDirectory}/meta/sitemap.json`, {encoding: 'utf-8'})
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
