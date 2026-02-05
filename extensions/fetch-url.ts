/**
 * Fetch URL Extension
 *
 * Adds a `fetch_url` tool that downloads web pages and extracts readable content
 * using Mozilla's Readability (same engine as Firefox Reader View).
 *
 * Features:
 * - Extracts article text from HTML pages
 * - Falls back to basic HTML-to-text if Readability can't parse
 * - Supports raw mode for non-HTML content (JSON, plain text, etc.)
 * - Proper output truncation for large pages
 * - Custom TUI rendering
 *
 * Usage: place in ~/.pi/agent/extensions/fetch-url/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const FetchParams = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	raw: Type.Optional(
		Type.Boolean({
			description: "If true, return raw content without Readability extraction. Useful for JSON APIs, plain text, etc. Default: false",
		})
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional HTTP headers to send with the request, e.g. { \"Authorization\": \"Bearer ...\" }",
		})
	),
});

interface FetchDetails {
	url: string;
	title?: string;
	byline?: string;
	siteName?: string;
	contentLength: number;
	truncated: boolean;
	error?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description: `Fetch a web page and extract its readable content (article text, stripping navigation/ads/scripts). Uses Mozilla Readability (Firefox Reader View engine). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. Use raw=true for JSON APIs or plain text endpoints.`,
		parameters: FetchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { url, raw, headers } = params;

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}...` }],
			});

			// Fetch the URL
			let response: Response;
			try {
				const fetchHeaders: Record<string, string> = {
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
					"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					...headers,
				};

				response = await fetch(url, {
					headers: fetchHeaders,
					signal: signal ?? undefined,
					redirect: "follow",
				});
			} catch (err: any) {
				const errorMsg = err.name === "AbortError" ? "Request cancelled" : `Fetch failed: ${err.message}`;
				return {
					content: [{ type: "text", text: errorMsg }],
					details: { url, contentLength: 0, truncated: false, error: errorMsg } as FetchDetails,
					isError: true,
				};
			}

			if (!response.ok) {
				const errorMsg = `HTTP ${response.status} ${response.statusText}`;
				return {
					content: [{ type: "text", text: errorMsg }],
					details: { url, contentLength: 0, truncated: false, error: errorMsg } as FetchDetails,
					isError: true,
				};
			}

			const contentType = response.headers.get("content-type") || "";
			const body = await response.text();

			let text: string;
			let title: string | undefined;
			let byline: string | undefined;
			let siteName: string | undefined;

			if (raw || !contentType.includes("html")) {
				// Raw mode or non-HTML content — return as-is
				text = body;
			} else {
				// Parse HTML and extract readable content
				try {
					const { document } = parseHTML(body);
					const reader = new Readability(document as any);
					const article = reader.parse();

					if (article && article.textContent && article.textContent.trim().length > 100) {
						title = article.title || undefined;
						byline = article.byline || undefined;
						siteName = article.siteName || undefined;

						// Build output with metadata
						const parts: string[] = [];
						if (title) parts.push(`# ${title}`);
						if (byline) parts.push(`By: ${byline}`);
						if (siteName) parts.push(`Source: ${siteName}`);
						if (parts.length > 0) parts.push("---");
						parts.push(article.textContent.trim());
						text = parts.join("\n");
					} else {
						// Readability couldn't extract — fallback to basic text extraction
						text = fallbackTextExtract(body);
					}
				} catch {
					// Parse error — fallback
					text = fallbackTextExtract(body);
				}
			}

			// Truncate output
			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let resultText = truncation.content;
			if (truncation.truncated) {
				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Use raw=true or ask user to paste relevant parts.]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details: {
					url,
					title,
					byline,
					siteName,
					contentLength: text.length,
					truncated: truncation.truncated,
				} as FetchDetails,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("fetch_url "));
			text += theme.fg("accent", args.url);
			if (args.raw) text += theme.fg("dim", " (raw)");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as FetchDetails | undefined;

			if (result.isError || details?.error) {
				return new Text(theme.fg("error", `✗ ${details?.error || "Fetch failed"}`), 0, 0);
			}

			let text = theme.fg("success", "✓ ");
			if (details?.title) {
				text += theme.fg("accent", details.title);
			} else {
				text += theme.fg("dim", details?.url || "fetched");
			}

			if (details?.contentLength) {
				text += theme.fg("muted", ` (${formatSize(details.contentLength)})`);
			}
			if (details?.truncated) {
				text += theme.fg("warning", " [truncated]");
			}

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 30);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (content.text.split("\n").length > 30) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},
	});
}

/**
 * Basic fallback: strip HTML tags and normalize whitespace.
 * Used when Readability can't extract content.
 */
function fallbackTextExtract(html: string): string {
	return html
		// Remove script/style/noscript blocks
		.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
		// Remove HTML comments
		.replace(/<!--[\s\S]*?-->/g, "")
		// Convert <br>, <p>, <div>, <li>, <tr> to newlines
		.replace(/<(br|p|div|li|tr|h[1-6])[^>]*>/gi, "\n")
		// Strip remaining tags
		.replace(/<[^>]+>/g, "")
		// Decode common HTML entities
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		// Normalize whitespace
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
