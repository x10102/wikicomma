
import {promises} from 'fs'
import { reencodeComponent } from './WikiDot';

(async function() {
	const wikis = await promises.readdir('./storage/')

	for (const wiki of wikis) {
		try {
			const pages = await promises.readdir(`./storage/${wiki}/files/`)

			for (const page of pages) {
				const fileList = await promises.readdir(`./storage/${wiki}/files/${page}`)

				for (const file of fileList) {
					const reencoded = reencodeComponent(file)

					if (reencoded != file) {
						console.log(`Renamed ${file} to ${reencoded}`)
						await promises.rename(`./storage/${wiki}/files/${page}/${file}`, `./storage/${wiki}/files/${page}/${reencoded}`)
					}
				}
			}
		} catch(err) {
			console.error(err)
		}
	}
})();

(async function() {
	const wikis = await promises.readdir('./storage/')

	for (const wiki of wikis) {
		try {
			const pages = await promises.readdir(`./storage/${wiki}/meta/files/`)

			for (const page of pages) {
				const fileList = await promises.readdir(`./storage/${wiki}/meta/files/${page}`)

				for (const file of fileList) {
					const reencoded = reencodeComponent(file)

					if (reencoded != file) {
						console.log(`Renamed ${file} to ${reencoded}`)
						await promises.rename(`./storage/${wiki}/meta/files/${page}/${file}`, `./storage/${wiki}/meta/files/${page}/${reencoded}`)
					}
				}
			}
		} catch(err) {
			console.error(err)
		}
	}
})();
