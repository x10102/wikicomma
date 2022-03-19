
import { WikiDot } from './WikiDot'

const scpwiki = new WikiDot('scpfoundation.net', 'http://scpfoundation.net');

(async function() {
	//await scpwiki.fetchToken()
	scpwiki.client.cookies.put('wikidot_token7=bb8b15dfc156d2d877e526866c29a6be', 'scpfoundation.net')
	await scpwiki.cachePageMetadata()
})()
