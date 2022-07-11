
# WikiComma

A WikiDot farm wiki archiving tool

# Requirements

- Node.JS >= 16
- Linux (recommended) or Windows host

# Archivable content

This piece of software allows you to do incremental backups of next data from your wikidot wiki:

- Page metadata
	- Global ID
	- Name
	- Revision list
	- Votes and voters
	- Forum thread ID (if present)
	- Last updated
	- Children files (IDs)
	- Is page locked
- File metadata
	- Global ID
	- Name
	- Original URL
	- Size (as-is)
	- Size in bytes (parsed)
	- MIME type reported as-is
	- Author (as numeric ID if user was deleted)
- Page revisions
	- Global ID
	- Per-page ID (counter)
	- When
	- Author (as numeric ID if user was deleted)
	- Change flags
	- Commentary
	- *Revision contents as txt file containing original wiki text*
- Forum
	- Categories / Subforums
		- Title
		- Description
		- Global ID
		- When last post was made (as reported by wikidot)
		- Total amount of posts
		- Total amount of threads
		- Last poster (as numeric ID if user was deleted, as reported by wikidot)
	- Forum thread
		- Global ID
		- Title
		- Description
		- Last poser (as numeric ID if user was deleted, as reported by wikidot)
		- When was this thread created
		- Created by whom (as numeric ID if user was deleted)
		- Amount of posts (as reported by wikidot)
		- Is sticky
		- Posts
	- Forum post
		- Global ID
		- Title (if present)
		- Author (as numeric ID if user was deleted)
		- Last edit at (if present)
		- Last edit by (if present)
		- Revision list
			- Each revision content as HTML file
		- *Subposts (replies, recusrive tree structure)*
- Users
	- Display name
	- User slug
	- Account creation date
	- Account type (e.g. Pro Plus)
	- Karma (activity), scale of 0-5
	- *Users are in buckets depending on their ID, right-shifted 13. For instance, user ID `4598089` is in bucket `4598089 >> 13 = 561`.*

Everything is archived incrementally, meaning once backup is made, future backups will be much faster.

On Linux, you might want to use [BTRFS Snapshots](https://btrfs.wiki.kernel.org/index.php/SysadminGuide#Snapshots) to create instant, space efficient incremental states of your backup, since WikiComma does not provide any way to store history of something, that does not have history on WikiDot itself (e.g. file revisions).

# Config

Config is stored in working directory (the same directory where node.js is launched), with name `config.json`.

Example config:

```json
{
	"base_directory": "/home/wikidot/storage",
	"wikis": [
		{
			"name": "scpfoundation.net",
			"url": "http://scp-ru.wikidot.com"
		},
		{
			"name": "scp-wiki",
			"url": "https://scp-wiki.wikidot.com"
		}
	],
	"ratelimit": {
		"bucket_size": 60,
		"refill_seconds": 45,
	},
	"delay_ms": 250,
	"user_list_cache_freshness": 86400,
	"maximum_jobs": null,
	"http_proxy": {
		"address": "192.168.50.1",
		"port": 4055
	},
	"socks_proxy": {
		"address": "192.168.50.1",
		"port": 4056
	}
}
```

- `base_directory`: where to put all the files
- `wikis[].name`: name of subdirectory inside `base_directory` to put files for this instance onto
- `wikis[].url`: root path of wiki
- `ratelimit`: limiting the rate at which requests are made, optional
- `ratelimit.bucket_size`: how many requests can be made per period
- `ratelimit.refill_seconds`: how many seconds it takes for a ratelimit bucket to be entirely refilled
- `delay_ms`: milliseconds to wait in between jobs, optional
- `maximum_jobs`: the maximum number of jobs to run simultaneously, optional
- `http_proxy`: http proxy for http requests, optional
- `socks_proxy`: socks proxy for https requests, optional
- `user_list_cache_freshness`: how long is wikidot user info considered fresh, in seconds. optional

# Example usage

Install dependencies, compile and run the tool:

```
npm install
npm run build
npm run start
```

If typescript is installed globally (`npm install -g typescript @types/node`) you can instead run `tsc` instead of `npm run build`.
