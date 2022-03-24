
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

import Seven from 'node-7z'
import { Data, SevenZipOptions } from './node-7z-fix'

export function listZipFiles(path: string, config?: SevenZipOptions): Promise<Data[]> {
	return new Promise((resolve, reject) => {
		let finished = false
		const stream = Seven.list(path, config)
		const chunks: Data[] = []

		stream.on('data', (data) => {
			if (finished) {
				return
			}

			chunks.push(data)
		})

		stream.on('end', () => {
			if (finished) {
				return
			}

			finished = true
			resolve(chunks)
		})

		stream.on('error', (err) => {
			if (finished) {
				return
			}

			finished = true
			reject(err)
		})
	})
}

export function addZipFiles(path: string, files: string | string[], config?: SevenZipOptions): Promise<void> {
	return new Promise((resolve, reject) => {
		let finished = false
		const stream = Seven.add(path, files, config)

		stream.on('end', () => {
			if (finished) {
				return
			}

			finished = true
			resolve()
		})

		stream.on('error', (err) => {
			if (finished) {
				return
			}

			finished = true
			reject(err)
		})
	})
}
