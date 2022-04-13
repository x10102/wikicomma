
import { WikiDot } from './WikiDot'
import { promises } from 'fs'

interface DaemonConfig {
	base_directory: string
	wikis: {name: string, url: string}[]
}

(async function() {
	let config: DaemonConfig

	try {
		config = JSON.parse(await promises.readFile('./config.json', {encoding: 'utf-8'}))
	} catch(err) {
		process.stderr.write('config.json is missing or invalid from working directory.')
		process.exit(1)
	}

	for (let {name, url} of config.wikis) {
		(async function() {
			try {
				if (url.endsWith('/')) { // Some of wikidot parts don't like double slash
					url = url.substring(0, url.length - 1)
				}

				const wiki = new WikiDot(name, url, `${config.base_directory}/${name}`)
				await wiki.fetchToken()
				await wiki.workLoop()
			} catch(err) {
				console.error(`Fetching wiki ${name} failed`)
				console.error(err)
			}
		})()
	}
})()
