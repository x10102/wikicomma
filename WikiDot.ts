
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
import { promises } from 'fs'
import { promisify } from 'util'
import { unescape } from 'html-escaper'
import Seven from 'node-7z'
import { addZipFiles, listZipFiles } from "./7z-helper"

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
	author?: string
	stamp?: number
	flags?: string
	commentary?: string
}

interface PageMeta {
	name: string
	page_id: number
	rating?: number
	version?: number
	forum_thread?: number
	last_revision: number
	global_last_revision: number
	revisions: PageRevision[]
}

interface GenericPageData {
	page_id?: number
	rating?: number
	forum_thread?: number
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
	last: number
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

interface LocalWikiMeta {
	last_page: number
	last_pagenation: number
	full_scan: boolean
}

interface FileMap {
	[key: string]: {url: string, path: string}
}

interface PendingRevisions {
	// revision -> page
	[key: string]: number
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

		if (!user) {
			user = elem.querySelector('span.deleted')?.attributes['data-id']

			if (user) {
				user = parseInt(user)
			}
		}

		if (user == undefined) {
			return null
		}

		return user
	}

	private static nbspMatch = /&nbsp;/g
	// spoon library
	private static urlMatcher = /(((http|ftp|https):\/{2})+(([0-9a-z_-]+\.)+(aero|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|tel|travel|ac|ad|ae|af|ag|ai|al|am|an|ao|aq|ar|as|at|au|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cx|cy|cz|cz|de|dj|dk|dm|do|dz|ec|ee|eg|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mn|mn|mo|mp|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|nom|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ra|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sj|sk|sl|sm|sn|so|sr|st|su|sv|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tp|tr|tt|tv|tw|tz|ua|ug|uk|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|yu|za|zm|zw|arpa)(:[0-9]+)?((\/([~0-9a-zA-Z\#\+\%@\.\/_-]+))?(\?[0-9a-zA-Z\+\%@\/&\[\];=_-]+)?)?))\b/ig
	public static defaultPagenation = 100

	private pendingFiles: DiskMeta<number[]> = new DiskMeta([], `${this.workingDirectory}/meta/pending_files.json`)
	private pendingPages: DiskMeta<string[]> = new DiskMeta([], `${this.workingDirectory}/meta/pending_pages.json`)
	private fileMap: DiskMeta<FileMap> = new DiskMeta({}, `${this.workingDirectory}/meta/file_map.json`)
	private pendingRevisions: DiskMeta<PendingRevisions> = new DiskMeta({}, `${this.workingDirectory}/meta/pending_revisions.json`)

	private localMeta: DiskMeta<LocalWikiMeta> = new DiskMeta({
		last_page: 0,
		full_scan: false,
		last_pagenation: WikiDot.defaultPagenation
	}, `${this.workingDirectory}/meta/local.json`, v => {
		if (typeof v != 'object') {
			v = {}
		}

		v.full_scan = v.full_scan != undefined ? v.full_scan : false
		v.last_page = v.last_page != undefined ? v.last_page : 0
		v.last_pagenation = v.last_pagenation != undefined ? v.last_pagenation : WikiDot.defaultPagenation

		return v
	})

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
		this.localMeta.startTimer(timeout)
		this.fileMap.startTimer(timeout)
		this.pendingRevisions.startTimer(timeout)
	}

	public stopMetaSyncTimer() {
		this.pendingFiles.stopTimer()
		this.pendingPages.stopTimer()
		this.localMeta.stopTimer()
		this.fileMap.stopTimer()
		this.pendingRevisions.stopTimer()
	}

	public syncMeta() {
		return Promise.all([
			this.pendingFiles.sync(),
			this.pendingPages.sync(),
			this.localMeta.sync(),
			this.fileMap.sync(),
			this.pendingRevisions.sync(),
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
			this.localMeta.initialize(),
			this.fileMap.initialize(),
			this.pendingRevisions.initialize(),
		])
	}

	public client = new HTTPClient()
	private ajaxURL: URL

	constructor(
		private name: string,
		private url: string = `https://${name}.wikidot.com`,
		private workingDirectory: string = `./storage/${name}`
	) {
		this.ajaxURL = new URL(`${this.url}/ajax-module-connector.php`)
		this.startMetaSyncTimer()

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

	private async fetch(options: any) {
		let cookie = this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value

		if (cookie == undefined) {
			this.fetchingToken = false
			await this.fetchToken()
			cookie = this.client.cookies.getSpecific(this.ajaxURL, 'wikidot_token7')?.value
		}

		options["wikidot_token7"] = cookie

		return await this.client.post(this.ajaxURL.href, {
			body: encode(options),

			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			},

			followRedirects: false
		})
	}

	private async fetchJson(options: any, custom = false) {
		const json = JSON.parse((await this.fetch(options)).toString('utf-8'))

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
		})

		const html = parse(json.body)

		for (const elem of html.querySelectorAll('.changes-list-item')) {
			const url = elem.querySelector('td.title')?.querySelector('a')?.attrs['href']
			const revision = elem.querySelector('td.revision-no')?.innerText?.match(/([0-9]+)/)
			const mod_by = WikiDot.extractUser(elem.querySelector('td.mod-by'))

			if (url != undefined) {
				const obj: RecentChange = {
					name: url.startsWith('/') ? url.substring(1) : url,
					author: mod_by
				}

				if (revision != undefined && revision != null) {
					obj.revision = parseInt(revision[1])
				}

				listing.push(obj)
			}
		}

		return listing
	}

	private static dateMatcher = /time_([0-9]+)/

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

			const author = (values[4] as HTMLElement)?.querySelector('a')?.attrs['href']?.match(WikiDot.usernameMatcher)
			const time = values[5].querySelector('span')?.attrs['class']?.match(WikiDot.dateMatcher)
			const commentary = values[6].innerHTML.trim()

			const parseRev = parseInt(revision[1])
			const parseGlobalRev = parseInt(global_revision[1])

			if (isNaN(parseRev) || isNaN(parseGlobalRev)) {
				continue
			}

			const parseTime = time != null ? parseInt(time[1]) : null

			const obj: PageRevision = {
				revision: parseRev,
				global_revision: parseGlobalRev,
				author: author != null ? author[1] : undefined,
				stamp: parseTime != null && !isNaN(parseTime) ? parseTime : undefined,
				flags: flags.replace(/\s+/g, ' '),
				commentary: unescape(commentary)
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

	public async fetchGeneric(page: string) {
		const result = await this.client.get(`${this.url}/${page}`, {followRedirects: false})
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

		return meta
	}

	public async fetchRevision(revision_id: number) {
		const json = await this.fetchJson({
			"revision_id": revision_id,
			"moduleName": "history/PageSourceModule",
		})

		const html = parse(json.body)
		const div = html.querySelector('div.page-source')

		return div != undefined ? unescape(div.innerText).replace(WikiDot.nbspMatch, ' ') : ''
	}

	private static categoryRegExp = /forum\/c-([0-9]+)/

	public async fetchForumCategories() {
		const listing: ForumCategory[] = []

		const body = await this.client.get(`${this.url}/forum/start/hidden/show`)
		const html = parse(body.toString('utf-8'))

		const forum = html.querySelector('div.forum-start-box')!

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
				const titleText = unescape(titleElem.innerText.trim())
				const categoryID = parseInt(titleElem.attributes['href'].match(WikiDot.categoryRegExp)![1])
				const description = unescape(name.querySelector('div.description')!.innerText.trim())

				const threadsNum = parseInt(threads.innerText.trim())
				const postsNum = parseInt(posts.innerText.trim())

				const lastDate = parseInt(last.querySelector('span.odate')!.attributes['class'].match(WikiDot.dateMatcher)![1])
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
			const titleText = unescape(titleElem.innerText.trim())
			const threadID = parseInt(titleElem.attributes['href'].match(WikiDot.threadRegExp)![1])

			// fairly weak check
			const sticky = (title.firstChild instanceof TextNode) ? title.firstChild.innerText.trim() != '' : false

			const description = unescape(name.querySelector('div.description')!.innerText.trim())
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

	public async fetchAndWriteFilesMeta(page_id: number) {
		for (const fileMeta of await this.fetchFileMetaList(page_id)) {
			await this.writeFileMeta(fileMeta.url.match(WikiDot.localFileMatch)![1], fileMeta)
		}
	}

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

	private async fetchFileInner(fileMeta: FileMeta, split: string[], recombined: string, config?: RequestConfig) {
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

		for (const fileMeta of await this.fetchFileMetaList(page_id)) {
			const match = WikiDot.splitFilePathRaw(fileMeta.url)

			if (match != null) {
				const [matched, split, last, recombined] = match
				await this.writeFileMeta(matched, fileMeta)

				if (this.downloadingFiles.has(matched)) {
					continue
				}

				this.downloadingFiles.set(matched, true)
				this.writeToFileMap(fileMeta, split, last)

				if (await this.fileExists(recombined)) {
					continue
				}

				this.fetchFileInner(fileMeta, split, recombined)
			}
		}
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

	public async fetchFileMetaList(page_id: number) {
		const list = []

		for (const file_id of await this.fetchFileList(page_id)) {
			list.push(await this.fetchFileMeta(file_id))
		}

		return list
	}

	public async workLoop() {
		await this.initialize()

		let page = this.localMeta.data.last_page
		const seen = new Map<string, boolean>()

		while (true) {
			this.log(`Fetching latest changes on page ${page + 1}`)
			const changes = await this.fetchChanges(++page, this.localMeta.data.last_pagenation)

			let onceUnseen = false
			let onceFetch = false

			for (const change of changes) {
				if (!seen.has(change.name)) {
					onceUnseen = true

					if (change.name.startsWith('nav:') || change.name.startsWith('tech:')) {
						continue
					}

					seen.set(change.name, true)

					if (change.revision != undefined) {
						let metadata = await this.loadPageMetadata(change.name)

						if (metadata == null || metadata.last_revision < change.revision || metadata.page_id == undefined || metadata.version == undefined || metadata.version < 2) {
							onceFetch = true
							this.log(`Need to renew ${change.name}`)

							const newMeta: PageMeta = {
								name: change.name,
								version: 2,
								revisions: [],
								rating: metadata != null ? metadata.rating : undefined,
								page_id: metadata != null ? metadata.page_id : -1,
								last_revision: change.revision,
								global_last_revision: metadata != null ? metadata.global_last_revision : 0
							}

							let pageMeta: GenericPageData

							try {
								pageMeta = await this.fetchGeneric(change.name)
							} catch(err) {
								//this.log(`Encountered ${err}, sleeping for 60 seconds`)
								this.log(`Encountered ${err}, postproning page ${change.name} for late fetch`)
								//await sleep(60_000)
								this.pushPendingPages(change.name)
								continue
							}

							if (pageMeta.page_id != undefined) {
								newMeta.page_id = pageMeta.page_id

								if (pageMeta.rating != undefined)
									newMeta.rating = pageMeta.rating

								if (pageMeta.forum_thread != undefined)
									newMeta.forum_thread = pageMeta.forum_thread

								if (metadata == null) {
									let changes: PageRevision[]

									while (true) {
										try {
											changes = await this.fetchPageChangeListAll(pageMeta.page_id)
											break
										} catch(err) {
											this.log(`Encountered ${err}, sleeping for 10 seconds`)
											await sleep(10_000)
										}
									}

									for (const localChange of changes) {
										if (localChange.global_revision > newMeta.global_last_revision) {
											newMeta.global_last_revision = localChange.global_revision
										}

										newMeta.revisions.push(localChange)
									}

									await this.writePageMetadata(change.name, newMeta)
								} else {
									newMeta.revisions = metadata.revisions

									let changes: PageRevision[]

									while (true) {
										try {
											changes = await this.fetchPageChangeListAllUntil(pageMeta.page_id, metadata.last_revision)
											break
										} catch(err) {
											this.log(`Encountered ${err}, sleeping for 10 seconds`)
											await sleep(10_000)
										}
									}

									for (const localChange of changes) {
										if (localChange.global_revision > newMeta.global_last_revision) {
											newMeta.global_last_revision = localChange.global_revision
										}

										newMeta.revisions.push(localChange)
									}

									await this.writePageMetadata(change.name, newMeta)
								}
							}

							metadata = newMeta
						}

						if (metadata.page_id == undefined) {
							this.pushPendingPages(change.name)
							continue
						}

						let fetchFilesOnce = false
						const revisionsToFetch: PageRevision[] = []
						const localRevs = await this.revisionList(change.name)

						for (const key in metadata.revisions) {
							const rev = metadata.revisions[key]

							//if (!await this.revisionExists(change.name, rev.revision)) {
							if (!localRevs.includes(rev.revision)) {
								if (!fetchFilesOnce && metadata.page_id != undefined) {
									fetchFilesOnce = true
									this.fetchFilesFor(metadata.page_id)
								}

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

								try {
									this.log(`Fetching revision ${rev.revision} (${rev.global_revision}) of ${change.name}`)
									const body = await this.fetchRevision(rev.global_revision)
									await this.writeRevision(change.name, rev.revision, body)
								} catch(err) {
									this.log(`Encountered ${err}, postproning revision ${rev.global_revision} of ${change.name} for later fetch`)
									this.pendingRevisions.data[rev.global_revision] = metadata!.page_id
									this.pendingRevisions.markDirty()
								}
							}
						}

						await Promise.allSettled([
							worker(),
							worker(),
							worker(),
							worker(),
							worker(),
						])

						this.removePendingPages(change.name)

						if (changes) {
							await this.compressRevisions(WikiDot.normalizeName(change.name))
						}
					}
				}
			}

			if (onceUnseen && !onceFetch && this.localMeta.data.full_scan) {
				this.log(`Finished renewing all changed pages`)
				this.localMeta.data.last_page = 0
				this.localMeta.markDirty()
				break
			//} else if (changes.length < this.localMeta.data.last_pagenation) {
			} else if (changes.length == 0) {
				this.log(`Reached end of entire wiki history`)
				this.localMeta.data.full_scan = true
				this.localMeta.data.last_page = 0
				this.localMeta.markDirty()
				break
			} else {
				this.localMeta.data.last_page = page
				this.localMeta.markDirty()
			}
		}

		this.log(`Fetching forums list`)
		const forums = await this.fetchForumCategories()

		for (const forum of forums) {
			const localForum = await this.loadForumCategory(forum.id)

			if (localForum != null && localForum.last == forum.last) {
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

						// TODO: IF we have meta, and it says that we fetched entire thread
						// and it hasn't changed... is this really the case?
						// about post edits, are they reflected anywhere???
						if (localThread == null || localThread.last != thread.last) {
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

							const workWithPost = async (post: ForumPost) => {
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

									for (const revision of revisionList) {
										this.log(`Fetching revision ${revision.id} of post ${post.id}`)
										const revContent = await this.fetchPostRevision(revision.id)
										await this.writePostRevision(forum.id, thread.id, post.id, revision.id, revContent.content)

										localPost.revisions.push({
											title: revContent.title,
											author: revision.author,
											id: revision.id,
											stamp: revision.stamp
										})
									}
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
						}
					})
				}

				const doWork = async () => {
					while (true) {
						const task = workers.pop()

						if (task == undefined) {
							return
						}

						await task()
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
						await this.writeFileMeta(matched, fetchedMeta)
						mapped = this.fileMap.data[id]
					}
				}

				if (mapped == undefined) {
					this.log(`Failed to map file meta ${id}`)
					continue
				}

				const readMeta = await this.loadFileMeta(mapped.path)

				if (readMeta == null) {
					this.log(`Unexpected missing metadata of file ${id}`)
					continue
				}

				const match = WikiDot.splitFilePathRaw(readMeta.url)

				if (match != null) {
					const [matched, split, last, recombined] = match

					if (await this.fileExists(recombined)) {
						continue
					}

					this.fetchFileInner(readMeta, split, recombined, {
						headers: {
							'Cache-Control': 'no-cache'
						}
					})
				}
			}
		}

		this.log(`Compressing page revisions`)

		for (const name of await promises.readdir(`${this.workingDirectory}/pages/`)) {
			// hidden/system files start with dot
			if (!name.startsWith('.') && (await promises.stat(`${this.workingDirectory}/pages/${name}`)).isDirectory()) {
				await this.compressRevisions(name)
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

	public async writeFileMeta(path: string, meta: FileMeta) {
		const [split, last, recombined] = WikiDot.splitFilePath(path)
		await promises.mkdir(`${this.workingDirectory}/meta/files/${split.join('/')}`, {recursive: true})
		await promises.writeFile(`${this.workingDirectory}/meta/files/${recombined}.json`, JSON.stringify(meta, null, 4))
	}
}
