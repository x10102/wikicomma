
import { WikiDot } from './WikiDot'

const scpwiki = new WikiDot('scpfoundation.net', 'http://scpfoundation.net', 'K:/storage/scpfoundation.net');

(async function() {
	await scpwiki.fetchToken()
	await scpwiki.workLoop()
})()
