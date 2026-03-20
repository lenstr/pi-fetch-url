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
 * - Proper output truncation for large pages, with full output saved to a temp file
 * - Configurable timeout (default 30s, max 120s)
 * - Cloudflare bot-detection bypass (retries with honest UA)
 * - Custom TUI rendering
 *
 * Usage: place in ~/.pi/agent/extensions/fetch-url/
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, TruncationResult } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;

const FetchParamsSchema = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	raw: Type.Optional(
		Type.Boolean({
			description: "If true, return raw content without Readability extraction. Useful for JSON APIs, plain text, etc. Default: false",
		})
	),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: 'Optional HTTP headers to send with the request, e.g. { "Authorization": "Bearer ..." }',
		})
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (default: 30, max: 120)",
		})
	),
});

type FetchRenderResult = AgentToolResult<FetchDetails> & {
	isError?: boolean;
};

interface FetchDetails {
	url: string;
	title?: string;
	byline?: string;
	siteName?: string;
	contentLength: number;
	truncated: boolean;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	error?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof FetchParamsSchema, FetchDetails>({
		name: "fetch_url",
		label: "Fetch URL",
		description: `Fetch a web page and extract its readable content (article text, stripping navigation/ads/scripts). Uses Mozilla Readability (Firefox Reader View engine). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}. If truncated, the full output is saved to a temp file. Use raw=true for JSON APIs or plain text endpoints. Supports optional timeout in seconds (default 30, max 120).`,
		promptSnippet:
			"fetch_url: Fetch a URL and return readable article text or raw endpoint output, with truncation and temp-file fallback for large responses.",
		promptGuidelines: [
			"Use fetch_url when the user asks to read, inspect, summarize, or extract information from a URL instead of asking them to open it manually.",
			"Use raw=true for JSON APIs, plain text endpoints, or whenever exact source output matters more than readability extraction.",
		],
		parameters: FetchParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate) {
			const { url, raw, headers } = params;

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${url}...` }],
				details: { url, contentLength: 0, truncated: false },
			});

			const requestedTimeoutSeconds = params.timeout ?? DEFAULT_TIMEOUT / 1000;
			if (!Number.isFinite(requestedTimeoutSeconds) || requestedTimeoutSeconds <= 0) {
				throw new Error("timeout must be a positive number of seconds");
			}

			const timeout = Math.min(requestedTimeoutSeconds * 1000, MAX_TIMEOUT);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			signal?.addEventListener("abort", () => controller.abort(), { once: true });

			let response: Response;
			try {
				const fetchHeaders: Record<string, string> = {
					"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					...headers,
				};

				const initial = await fetch(url, {
					headers: fetchHeaders,
					signal: controller.signal,
					redirect: "follow",
				});

				if (initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge") {
					response = await fetch(url, {
						headers: { ...fetchHeaders, "User-Agent": "pi-fetch-url" },
						signal: controller.signal,
						redirect: "follow",
					});
				} else {
					response = initial;
				}
			} catch (err: unknown) {
				throw createFetchError(err, signal, controller.signal, timeout);
			} finally {
				clearTimeout(timer);
			}

			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`);
			}

			const contentType = response.headers.get("content-type") || "";
			const body = await response.text();

			let text: string;
			let title: string | undefined;
			let byline: string | undefined;
			let siteName: string | undefined;

			if (raw || !contentType.includes("html")) {
				text = body;
			} else {
				try {
					const { document } = parseHTML(body);
					const reader = new Readability(document);
					const article = reader.parse();

					if (article && article.textContent && article.textContent.trim().length > 100) {
						title = article.title || undefined;
						byline = article.byline || undefined;
						siteName = article.siteName || undefined;

						const parts: string[] = [];
						if (title) parts.push(`# ${title}`);
						if (byline) parts.push(`By: ${byline}`);
						if (siteName) parts.push(`Source: ${siteName}`);
						if (parts.length > 0) parts.push("---");
						parts.push(article.textContent.trim());
						text = parts.join("\n");
					} else {
						text = fallbackTextExtract(body);
					}
				} catch {
					text = fallbackTextExtract(body);
				}
			}

			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			const details: FetchDetails = {
				url,
				title,
				byline,
				siteName,
				contentLength: text.length,
				truncated: truncation.truncated,
			};

			let resultText = truncation.content;
			if (truncation.truncated) {
				const tempDir = await mkdtemp(join(tmpdir(), "pi-fetch-url-"));
				const fileName = contentType.includes("json") ? "output.json" : "output.txt";
				const tempFile = join(tempDir, fileName);

				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, text, "utf8");
				});

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("fetch_url "));
			text += theme.fg("accent", args.url);
			if (args.raw) text += theme.fg("dim", " (raw)");
			return new Text(text, 0, 0);
		},

		renderResult(result: FetchRenderResult, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Fetching..."), 0, 0);
			}

			const details = result.details as FetchDetails | undefined;

			if (result.isError || details?.error) {
				const errorText =
					result.content.find((content) => content.type === "text")?.text || details?.error || "Fetch failed";
				return new Text(theme.fg("error", `✗ ${errorText}`), 0, 0);
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
				if (details?.fullOutputPath) {
					text += `\n${theme.fg("muted", `Full output: ${details.fullOutputPath}`)}`;
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
function createFetchError(
	err: unknown,
	externalSignal: AbortSignal | undefined,
	requestSignal: AbortSignal,
	timeoutMs: number
): Error {
	const aborted = requestSignal.aborted || isAbortError(err);
	if (!aborted) {
		return new Error(`Fetch failed: ${getErrorMessage(err)}`);
	}
	return new Error(externalSignal?.aborted ? "Request cancelled" : `Request timed out after ${timeoutMs / 1000}s`);
}

function getErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

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
