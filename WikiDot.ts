
import { encode } from "querystring"
import { HTTPClient } from './HTTPClient'
import { parse } from 'node-html-parser'

interface RecentChange {
	name: string
	revision?: number
	author?: string
}

class WikiDot {
	public client = new HTTPClient()

	constructor(private url: string) {

	}

	private fetchingToken = false

	async fetchToken() {
		if (this.fetchingToken) {
			return
		}

		this.fetchingToken = false
		await this.client.get(`${this.url}/system:recent-changes`)
	}

	async fetchChanges(page = 1, perPage = 20): Promise<RecentChange[]> {
		const listing: RecentChange[] = []
		const url = new URL(`${this.url}/ajax-module-connector.php`)

		const result = await this.client.post(url.href, {
			body: encode({
				"options": `{"all": true}`,
				"page": page,
				"perpage": perPage,
				"moduleName": "changes/SiteChangesListModule",
				"wikidot_token7": this.client.cookies.get(url)[0]?.value
			}),

			headers: {
				"Content-Type": "application/x-www-form-urlencoded"
			}
		})

		const html = parse(JSON.parse(result.toString()).body)

		for (const elem of html.querySelectorAll('.changes-list-item')) {
			const url = elem.querySelector('td.title')?.querySelector('a')?.attrs['href']
			const revision = elem.querySelector('td.revision-no')?.innerText?.match(/([0-9]+)/)
			const mod_by = elem.querySelector('td.mod-by')?.querySelector('a')?.attrs['href']?.match(/user:info\/(.*)/)

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

	async localMeta(page: string) {

	}
}

export {WikiDot}
