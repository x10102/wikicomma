
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
import { WikiDot } from "./WikiDot"
import {promises} from 'fs'

(async function() {
	const config = await loadConfig()
	const filenameMatcher = /^(\S+)\.json$/

	for (const {name, url} of config.wikis) {
		const wiki = new WikiDot(
			name,
			url,
			`${config.base_directory}/${name}`,
			null,
			null,
			null
		)

		const sitemap = await wiki.readSiteMap()

		if (sitemap !== null) {
			process.stdout.write(`Scanning ${name}...\n`)
			const fileList = await promises.readdir(`${config.base_directory}/${name}/meta/pages`)

			const collected = new Array(sitemap.size)
			let i = 0

			for (const pagename of sitemap.keys()) {
				collected[i++] = WikiDot.normalizeName(pagename)
			}

			for (const filename of fileList) {
				const matched = filename.match(filenameMatcher)

				if (matched !== null) {
					if (!collected.includes(matched[1])) {
						process.stdout.write(`[${name}] Deleting ${matched[1]}\n`)
						await wiki.markPageRemoved(matched[1])
					}
				}
			}
		}
	}

	process.exit(0)
})()
