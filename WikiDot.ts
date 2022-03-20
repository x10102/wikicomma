
import { encode } from "querystring"
import { HTTPClient } from './HTTPClient'
import { parse, HTMLElement } from 'node-html-parser'
import { promises } from 'fs'
import { promisify } from 'util'
import { unescape } from 'html-escaper'

const sleep = promisify(setTimeout)

interface RecentChange {
	name: string
	revision?: number
	author?: string
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
	page_id?: number
	rating?: number
	last_revision: number
	global_last_revision: number
	revisions: PageRevision[]
}

interface GenericPageData {
	page_id?: number
	rating?: number
}

interface FileMeta {
	file_id: number
	name: string
	url: string
	size: string
	size_bytes: number
	mime: string
	content: string
	author: string | null
	stamp: number
}

/**
 * All symbols are safe for storing on disk except these
 * (Windows NT kernel limitations)
 */
const reencoding_table = [
	[/\\/g, encodeURIComponent('\\')],
	[/:/g, encodeURIComponent(':')],
	[/\*/g, encodeURIComponent('*')],
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
}

class WikiDot {
	public static normalizeName(name: string): string {
		return name.replace(/:/g, '_')
	}

	private static usernameMatcher = /user:info\/(.*)/
	private static nbspMatch = /&nbsp;/g
	// spoon library
	private static urlMatcher = /(((http|ftp|https):\/{2})+(([0-9a-z_-]+\.)+(aero|asia|biz|cat|com|coop|edu|gov|info|int|jobs|mil|mobi|museum|name|net|org|pro|tel|travel|ac|ad|ae|af|ag|ai|al|am|an|ao|aq|ar|as|at|au|aw|ax|az|ba|bb|bd|be|bf|bg|bh|bi|bj|bm|bn|bo|br|bs|bt|bv|bw|by|bz|ca|cc|cd|cf|cg|ch|ci|ck|cl|cm|cn|co|cr|cu|cv|cx|cy|cz|cz|de|dj|dk|dm|do|dz|ec|ee|eg|er|es|et|eu|fi|fj|fk|fm|fo|fr|ga|gb|gd|ge|gf|gg|gh|gi|gl|gm|gn|gp|gq|gr|gs|gt|gu|gw|gy|hk|hm|hn|hr|ht|hu|id|ie|il|im|in|io|iq|ir|is|it|je|jm|jo|jp|ke|kg|kh|ki|km|kn|kp|kr|kw|ky|kz|la|lb|lc|li|lk|lr|ls|lt|lu|lv|ly|ma|mc|md|me|mg|mh|mk|ml|mn|mn|mo|mp|mr|ms|mt|mu|mv|mw|mx|my|mz|na|nc|ne|nf|ng|ni|nl|no|np|nr|nu|nz|nom|pa|pe|pf|pg|ph|pk|pl|pm|pn|pr|ps|pt|pw|py|qa|re|ra|rs|ru|rw|sa|sb|sc|sd|se|sg|sh|si|sj|sj|sk|sl|sm|sn|so|sr|st|su|sv|sy|sz|tc|td|tf|tg|th|tj|tk|tl|tm|tn|to|tp|tr|tt|tv|tw|tz|ua|ug|uk|us|uy|uz|va|vc|ve|vg|vi|vn|vu|wf|ws|ye|yt|yu|za|zm|zw|arpa)(:[0-9]+)?((\/([~0-9a-zA-Z\#\+\%@\.\/_-]+))?(\?[0-9a-zA-Z\+\%@\/&\[\];=_-]+)?)?))\b/ig
	public static defaultPagenation = 20

	private pendingFiles: DiskMeta<number[]> = new DiskMeta([], `./storage/${this.name}/meta/pending_files.json`)
	private pendingPages: DiskMeta<string[]> = new DiskMeta([], `./storage/${this.name}/meta/pending_pages.json`)

	private localMeta: DiskMeta<LocalWikiMeta> = new DiskMeta({
		last_page: 0,
		last_pagenation: WikiDot.defaultPagenation
	}, `./storage/${this.name}/meta/local.json`, v => {
		if (typeof v != 'object') {
			v = {}
		}

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
	}

	public stopMetaSyncTimer() {
		this.pendingFiles.stopTimer()
		this.pendingPages.stopTimer()
		this.localMeta.stopTimer()
	}

	public syncMeta() {
		return Promise.all([this.pendingFiles.sync(), this.pendingPages.sync(), this.localMeta.sync()])
	}

	private initialize() {
		return Promise.allSettled([this.pendingFiles.initialize(), this.pendingPages.initialize(), this.localMeta.initialize()])
	}

	public client = new HTTPClient()
	private ajaxURL: URL

	constructor(private name: string, private url: string = `https://${name}.wikidot.com`) {
		this.ajaxURL = new URL(`${this.url}/ajax-module-connector.php`)
		this.startMetaSyncTimer()
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

		this.fetchingToken = false
		await this.client.get(`${this.url}/system:recent-changes`)
	}

	private async fetch(options: any) {
		options["wikidot_token7"] = this.client.cookies.get(this.ajaxURL)[0]?.value

		return await this.client.post(this.ajaxURL.href, {
			body: encode(options),

			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			}
		})
	}

	private async fetchJson(options: any) {
		return JSON.parse((await this.fetch(options)).toString('utf-8'))
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

		if (json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

		const html = parse(json.body)

		for (const elem of html.querySelectorAll('.changes-list-item')) {
			const url = elem.querySelector('td.title')?.querySelector('a')?.attrs['href']
			const revision = elem.querySelector('td.revision-no')?.innerText?.match(/([0-9]+)/)
			const mod_by = elem.querySelector('td.mod-by')?.querySelector('a')?.attrs['href']?.match(WikiDot.usernameMatcher)

			if (url != undefined) {
				const obj: RecentChange = {name: url.startsWith('/') ? url.substring(1) : url}

				if (revision != undefined && revision != null) {
					obj.revision = parseInt(revision[1])
				}

				if (mod_by != undefined && mod_by != null) {
					obj.author = mod_by[1]
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

		if (json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

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

			if (data.length < WikiDot.defaultPagenation) {
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
				if (piece.revision < revision) {
					finish = true
					break
				}

				listing.push(piece)
			}

			if (data.length < WikiDot.defaultPagenation || finish) {
				break
			}
		}

		return listing
	}

	public async fetchGeneric(page: string) {
		const result = await this.client.get(`${this.url}/${page}`)
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

		return meta
	}

	public async fetchRevision(revision_id: number) {
		const json = await this.fetchJson({
			"revision_id": revision_id,
			"moduleName": "history/PageSourceModule",
		})

		if (json.status != 'ok') {
			throw Error(`Server returned ${json.status}, message: ${json.message}`)
		}

		const html = parse(json.body)
		const div = html.querySelector('div.page-source')

		return div != undefined ? unescape(div.innerText).replace(WikiDot.nbspMatch, ' ') : ''
	}

	// high-level api
	private downloadingFiles = new Map<string, boolean>()
	private static localFileMatch = /\/local--files\/(.+)/i

	public async fetchAndWriteFilesMeta(page_id: number) {
		for (const fileMeta of await this.fetchFileMetaList(page_id)) {
			await this.writeFileMeta(fileMeta.url.match(WikiDot.localFileMatch)![1], fileMeta)
		}
	}

	public async fetchFilesFor(page_id: number) {
		await this.initialize()

		for (const fileMeta of await this.fetchFileMetaList(page_id)) {
			const match = fileMeta.url.match(WikiDot.localFileMatch)!
			await this.writeFileMeta(match[1], fileMeta)

			if (match != null) {
				if (this.downloadingFiles.has(match[1])) {
					continue
				}

				this.downloadingFiles.set(match[1], true)

				const split = match[1].split('/')

				for (const key in split) {
					split[key] = reencodeComponent(split[key])
				}

				if (split.length == 1) {
					split.unshift('~')
				}

				const last = split.splice(split.length - 1)[0]

				try {
					await promises.stat(`./storage/${this.name}/files/${split.join('/')}/${last}`)
					break
				} catch(err) {

				}

				this.log(`Fetching file ${fileMeta.url}`)

				this.client.get(fileMeta.url).then(async buffer => {
					await promises.mkdir(`./storage/${this.name}/files/${split.join('/')}`, {recursive: true})
					await promises.writeFile(`./storage/${this.name}/files/${split.join('/')}/${last.replace(/\?/g, '@')}`, buffer)
					this.removePendingFiles(fileMeta.file_id)
				}).catch(err => {
					this.log(`Unable to fetch ${fileMeta.url} because ${err}`)
					this.pushPendingFiles(fileMeta.file_id)
				})
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
					await promises.stat(`./storage/${this.name}/files/${split.join('/')}/${last}`)
					break
				} catch(err) {

				}

				this.log(`Fetching file ${url}`)

				this.client.get(url).then(async buffer => {
					await promises.mkdir(`./storage/${this.name}/files/${split.join('/')}`, {recursive: true})
					await promises.writeFile(`./storage/${this.name}/files/${split.join('/')}/${last.replace(/\?/g, '@')}`, buffer)
				}).catch(err => {
					this.log(`Unable to fetch ${url} because ${err}`)
				})
			}
		}

		return true
	}

	private static fileSizeMatcher = /([0-9]+) bytes/i

	public async fetchFileMeta(file_id: number): Promise<FileMeta> {
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

		const matchAuthor = uploader.querySelector('a')?.attrs['href'].match(WikiDot.usernameMatcher)![1]!

		return {
			file_id: file_id,
			name: name.innerText.trim(),
			url: fullURL.querySelector('a')?.attrs['href']!,
			size: size.innerText.trim(),
			size_bytes: parseInt(size.innerText.match(WikiDot.fileSizeMatcher)![1]),
			mime: mime.innerText.trim(),
			content: contentType.innerText.trim(),
			author: matchAuthor ? matchAuthor : null,
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

	public async cachePageMetadata() {
		await this.initialize()

		let page = this.localMeta.data.last_page
		const seen = new Map<string, boolean>()

		while (true) {
			this.log(`Fetching latest changes on page ${page + 1}`)
			const changes = await this.fetchChanges(++page, this.localMeta.data.last_pagenation)

			for (const change of changes) {
				if (!seen.has(change.name) && !change.name.startsWith('nav:') && !change.name.startsWith('tech:')) {
					seen.set(change.name, true)

					if (change.revision != undefined) {
						let metadata = await this.loadPageMetadata(change.name)

						if (metadata == null || metadata.last_revision < change.revision) {
							this.log(`Need to renew ${change.name}`)

							const newMeta: PageMeta = {
								name: change.name,
								revisions: [],
								rating: metadata != null ? metadata.rating : undefined,
								page_id: metadata != null ? metadata.page_id : undefined,
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

								if (newMeta.rating != undefined)
									newMeta.rating = pageMeta.rating

								if (metadata == null) {
									let changes: PageRevision[]

									while (true) {
										try {
											changes = await this.fetchPageChangeListAll(pageMeta.page_id)
											break
										} catch(err) {
											this.log(`Encountered ${err}, sleeping for 60 seconds`)
											await sleep(60_000)
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
											this.log(`Encountered ${err}, sleeping for 60 seconds`)
											await sleep(60_000)
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

						let fetchFilesOnce = false

						for (const key in metadata.revisions) {
							const rev = metadata.revisions[key]

							if (!await this.revisionExists(change.name, rev.revision)) {
								if (!fetchFilesOnce && metadata.page_id != undefined) {
									fetchFilesOnce = true
									this.fetchFilesFor(metadata.page_id)
								}

								while (true) {
									try {
										this.log(`Fetching revision ${rev.revision} (${rev.global_revision}) of ${change.name}`)
										const body = await this.fetchRevision(rev.global_revision)
										await this.writeRevision(change.name, rev.revision, body)
										// this.fetchFilesFrom(body, metadata.page_id)
										break
									} catch(err) {
										this.log(`Encountered ${err}, sleeping for 60 seconds`)
										await sleep(60_000)
									}
								}
							}
						}

						this.removePendingPages(change.name)
					}
				}
			}

			this.localMeta.data.last_page = page
			this.localMeta.markDirty()

			if (changes.length < this.localMeta.data.last_pagenation) {
				break
			}
		}
	}

	// local I/O
	public async revisionExists(page: string, revision: number) {
		try {
			await promises.stat(`./storage/${this.name}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`)
			return true
		} catch(err) {
			return false
		}
	}

	public async writeRevision(page: string, revision: number, body: string) {
		await promises.mkdir(`./storage/${this.name}/pages/${WikiDot.normalizeName(page)}`, {recursive: true})
		await promises.writeFile(`./storage/${this.name}/pages/${WikiDot.normalizeName(page)}/${revision}.txt`, body)
	}

	public async loadPageMetadata(page: string) {
		try {
			const read = await promises.readFile(`./storage/${this.name}/meta/pages/${WikiDot.normalizeName(page)}.json`, {encoding: 'utf-8'})
			return JSON.parse(read) as PageMeta
		} catch(err) {
			return null
		}
	}

	public async writePageMetadata(page: string, meta: PageMeta) {
		await promises.mkdir(`./storage/${this.name}/meta/pages`, {recursive: true})
		await promises.writeFile(`./storage/${this.name}/meta/pages/${WikiDot.normalizeName(page)}.json`, JSON.stringify(meta, null, 4))
	}

	public async readFileMeta(path: string) {
		try {
			const read = await promises.readFile(`./storage/${this.name}/meta/files/${path}`, {encoding: 'utf-8'})
			return JSON.parse(read) as FileMeta
		} catch(err) {
			return null
		}
	}

	public async writeFileMeta(path: string, meta: FileMeta) {
		const split = path.split('/')

		for (const key in split) {
			split[key] = reencodeComponent(split[key])
		}

		if (split.length == 1) {
			split.unshift('~')
		}

		const last = split.splice(split.length - 1)[0]

		await promises.mkdir(`./storage/${this.name}/meta/files/${split.join('/')}`, {recursive: true})
		await promises.writeFile(`./storage/${this.name}/meta/files/${split.join('/')}/${last}.json`, JSON.stringify(meta, null, 4))
	}
}

export {WikiDot}
