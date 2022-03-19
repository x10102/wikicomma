
import { encode } from "querystring"
import { HTTPClient } from './HTTPClient'
import { parse, HTMLElement } from 'node-html-parser'
import { promises } from 'fs'
import { promisify } from 'util'

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
	last_revision: number
	global_last_revision: number
	revisions: PageRevision[]
	fetched_revisions: number[]
}

interface GenericPageData {
	page_id?: number
}

class WikiDot {
	public static normalizeName(name: string): string {
		return name.replace(/:/g, '_')
	}

	private static usernameMatcher = /user:info\/(.*)/

	public client = new HTTPClient()
	private ajaxURL: URL

	constructor(private name: string, private url: string = `https://${name}.wikidot.com`) {
		this.ajaxURL = new URL(`${this.url}/ajax-module-connector.php`)
	}

	private fetchingToken = false

	private log(str: string) {
		process.stdout.write(`[${this.name}]: ${str}\n`)
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
	public async fetchChanges(page = 1, perPage = 20) {
		const listing: RecentChange[] = []

		const json = await this.fetchJson({
			"options": `{"all": true}`,
			"page": page,
			"perpage": perPage,
			"moduleName": "changes/SiteChangesListModule",
		})

		if (json.status != 'ok') {
			throw Error("Server returned: " + JSON.stringify(json))
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

	public async fetchPageChangeList(page_id: number, page = 1, perPage = 20) {
		const listing: PageRevision[] = []

		const json = await this.fetchJson({
			"options": `{"all": true}`,
			"page": page,
			"perpage": perPage,
			"page_id": page_id,
			"moduleName": "history/PageRevisionListModule",
		})

		if (json.status != 'ok') {
			throw Error("Server returned: " + JSON.stringify(json))
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
			const time = values[5].querySelector('span')?.attrs['class']?.match(/time_([0-9]+)/)
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
				flags: flags,
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

			if (data.length < 20) {
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

			if (data.length < 20 || finish) {
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

		return meta
	}

	// high-level api
	public async cachePageMetadata() {
		let page = 0
		const seen = new Map<string, boolean>()

		while (true) {
			this.log(`Fetching latest changes on page ${page + 1}`)
			const changes = await this.fetchChanges(++page)

			for (const change of changes) {
				if (!seen.has(change.name)) {
					seen.set(change.name, true)

					if (change.revision != undefined) {
						const metadata = await this.locadPageMetadata(change.name)

						if (metadata == null || metadata.last_revision < change.revision) {
							this.log(`Need to renew ${change.name}`)

							const newMeta: PageMeta = {
								name: change.name,
								revisions: [],
								last_revision: change.revision,
								fetched_revisions: metadata != null ? metadata.fetched_revisions : [],
								global_last_revision: metadata != null ? metadata.global_last_revision : 0
							}

							let pageMeta: GenericPageData

							while (true) {
								try {
									pageMeta = await this.fetchGeneric(change.name)
									break
								} catch(err) {
									this.log(`Encountered ${err}, sleeping for 10 seconds`)
									await sleep(10_000)
								}
							}

							if (pageMeta.page_id != undefined) {
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
						}
					}
				}
			}

			if (changes.length < 20) {
				break
			}
		}
	}

	public async locadPageMetadata(page: string) {
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
}

export {WikiDot}
