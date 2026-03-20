# pi-fetch-url

A [pi](https://github.com/badlogic/pi-mono) extension that adds a `fetch_url` tool for reading web pages and extracting article content.

Uses [Mozilla Readability](https://github.com/mozilla/readability) (the same engine behind Firefox Reader View) to strip navigation, ads, and scripts — leaving just the readable content.

## Features

- 📄 Extracts readable article text from HTML pages
- 📰 Metadata: title, author, site name
- 🔧 Raw mode (`raw=true`) for JSON APIs and plain text endpoints
- 📎 Custom HTTP headers support
- ⏱️ Configurable timeout (`timeout`, default 30s, max 120s)
- ✂️ Automatic output truncation to stay within LLM context limits, with full output saved to a temp file
- 🎨 Custom TUI rendering

## Install

```bash
pi install git:github.com/lenstr/pi-fetch-url
```

## Usage

Once installed, the `fetch_url` tool is available to the LLM. Just ask pi to read a URL:

```
Read this article: https://example.com/some-article
```

Or for APIs:

```
Fetch https://api.example.com/data.json in raw mode
```

## Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | URL to fetch (required) |
| `raw` | boolean | Skip Readability extraction, return raw content (default: false) |
| `headers` | object | Custom HTTP headers, e.g. `{ "Authorization": "Bearer ..." }` |
| `timeout` | number | Timeout in seconds (default: 30, max: 120) |

## License

MIT
